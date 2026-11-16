// Mock STS Gen2 server. Hand-written fixtures plus a small pricing engine, so the
// harness can be exercised end to end without credentials. Behaviour is a plausible
// imitation, not Oracle's: see README "Mock behaviour".
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

const fx = JSON.parse(readFileSync(new URL('../fixtures/demo.json', import.meta.url), 'utf8'));
const menu = fx.menu;

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const sum = (xs) => r2(xs.reduce((a, b) => a + b, 0));
export const tx = (v) => (v && typeof v === 'object' ? Object.values(v)[0] : v) ?? '';
const priceOf = (prices, seq) => (prices?.find((p) => p.priceSequence === (seq ?? 1)) ?? prices?.[0])?.price ?? 0;

const itemById = (id) => menu.menuItems.find((m) => m.menuItemId === id);
const condById = (id) => menu.condimentItems.find((c) => c.condimentId === id);
const groupById = (id) => menu.condimentGroups.find((g) => g.condimentGroupId === id);
const prefixById = (id) => menu.condimentPrefixes.find((p) => p.prefixId === id);

class PosError extends Error {
  constructor(code, message, status = 400, title = 'POS Error') {
    super(message);
    Object.assign(this, { code, status, title });
  }
}
const posErr = (code, msg) => new PosError(code, msg);

function problem(status, title, detail, posDetails) {
  const body = { title, status, detail, instance: status === 400 ? 'error:pos-error' : `error:http-${status}` };
  if (posDetails) body.posDetails = posDetails;
  return { status, headers: { 'content-type': 'application/problem+json' }, body };
}
const ok = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body });

// ---------- pricing ----------

function priceItem(line, where, { unitPrice, prefixEnabled } = {}) {
  if (!line || typeof line.menuItemId !== 'number') throw posErr('invalid_request', `${where}: menuItemId is required`);
  const item = itemById(line.menuItemId);
  if (!item) throw posErr('menu_item_not_found', `${where}: menu item ${line.menuItemId} not found`);
  if (item.mockUnavailable) throw posErr('menu_item_not_available', `${where}: ${tx(item.name)} is not available`);
  const def = item.definitions.find((d) => d.number === (line.definitionSequence ?? 1));
  if (!def) throw posErr('definition_not_found', `${where}: ${tx(item.name)} has no definition ${line.definitionSequence}`);
  const qty = line.quantity ?? 1;
  if (!Number.isInteger(qty) || qty < 1) throw posErr('invalid_quantity', `${where}: quantity must be a whole number of at least 1`);
  const unit = unitPrice ?? priceOf(def.prices, line.priceSequence);

  const rules = def.condimentGroupRules ?? [];
  const counts = new Map();
  const condiments = (line.condiments ?? []).map((c, k) => {
    const cw = `${where}.condiments[${k}]`;
    const ci = condById(c.condimentId);
    if (!ci) throw posErr('condiment_not_found', `${cw}: condiment ${c.condimentId} not found`);
    const group = rules.map((r) => groupById(r.condimentGroupRef)).find((g) => g?.condimentItemRefs.includes(c.condimentId));
    if (!group) throw posErr('condiment_not_allowed', `${cw}: ${tx(ci.name)} is not allowed on ${tx(item.name)}`);
    const cdef = ci.definitions.find((d) => d.number === (c.definitionSequence ?? 1)) ?? ci.definitions[0];
    const prefixes = prefixEnabled ? (c.prefixes ?? []) : [];
    for (const p of prefixes) {
      if (!prefixById(p.prefixId)) throw posErr('prefix_not_found', `${cw}: prefix ${p.prefixId} not found`);
      if (!cdef.options?.includes('allowCondimentPrefix')) throw posErr('prefix_not_allowed', `${cw}: ${tx(ci.name)} does not take prefixes`);
    }
    const isNo = prefixes.some((p) => prefixById(p.prefixId).prefixType === 'no');
    const cq = c.quantity ?? 1;
    if (!isNo) counts.set(group.condimentGroupId, (counts.get(group.condimentGroupId) ?? 0) + cq);
    const cu = isNo ? 0 : priceOf(cdef.prices, c.priceSequence);
    const out = { condimentId: c.condimentId, definitionSequence: cdef.number, name: tx(ci.name), quantity: cq, unitPrice: cu, total: r2(cu * cq * qty) };
    if (prefixes.length) out.prefixes = prefixes.map((p) => ({ prefixId: p.prefixId, name: tx(prefixById(p.prefixId).name) }));
    return out;
  });
  for (const r of rules) {
    const n = counts.get(r.condimentGroupRef) ?? 0;
    const gName = tx(groupById(r.condimentGroupRef)?.name);
    if (r.minimumCount && n < r.minimumCount) throw posErr('condiment_minimum_not_met', `${where}: ${tx(item.name)} needs at least ${r.minimumCount} from ${gName}`);
    if (r.maximumCount && n > r.maximumCount) throw posErr('condiment_maximum_exceeded', `${where}: ${tx(item.name)} allows at most ${r.maximumCount} from ${gName}`);
  }

  const out = {
    menuItemId: item.menuItemId, definitionSequence: def.number, name: tx(def.name ?? item.name),
    quantity: qty, unitPrice: unit, total: r2(unit * qty + sum(condiments.map((c) => c.total))),
  };
  if (line.seat != null) out.seat = line.seat;
  if (line.referenceText) out.referenceText = line.referenceText;
  if (condiments.length) out.condiments = condiments;
  return out;
}

function priceCombo(cm, i, prefixEnabled) {
  const where = `comboMeals[${i}]`;
  const combo = menu.comboMeals.find((c) => c.menuItemRef === cm?.comboItem?.menuItemId);
  if (!combo) throw posErr('combo_not_found', `${where}: no combo meal for comboItem.menuItemId ${cm?.comboItem?.menuItemId}`);
  const qty = cm.comboItem.quantity ?? 1;
  const main = combo.comboGroups.find((g) => g.isMainGroup);
  const sides = combo.comboGroups.filter((g) => !g.isMainGroup);
  const mainEntry = main.menuItems.find((m) => m.menuItemRef === cm.mainItem?.menuItemId);
  if (!mainEntry) throw posErr('combo_main_invalid', `${where}.mainItem: item ${cm.mainItem?.menuItemId} is not in the ${tx(main.name)} group`);
  const mainItem = priceItem({ ...cm.mainItem, quantity: qty }, `${where}.mainItem`, { unitPrice: priceOf(mainEntry.prices), prefixEnabled });

  const remaining = new Map(sides.map((g) => [g.comboGroupId, g.count ?? 1]));
  const sideItems = (cm.sideItems ?? []).map((s, j) => {
    const g = sides.find((g) => remaining.get(g.comboGroupId) > 0 && g.menuItems.some((m) => m.menuItemRef === s.menuItemId));
    if (!g) throw posErr('combo_side_invalid', `${where}.sideItems[${j}]: item ${s.menuItemId} does not fit any open side group`);
    remaining.set(g.comboGroupId, remaining.get(g.comboGroupId) - 1);
    const entry = g.menuItems.find((m) => m.menuItemRef === s.menuItemId);
    return priceItem({ ...s, quantity: qty }, `${where}.sideItems[${j}]`, { unitPrice: priceOf(entry.prices), prefixEnabled });
  });
  for (const g of sides) {
    const left = remaining.get(g.comboGroupId);
    if (left > 0) throw posErr('combo_incomplete', `${where}: choose ${left} more from ${tx(g.name)}`);
  }
  const total = r2(mainItem.total + sum(sideItems.map((s) => s.total)));
  const out = { comboMealId: combo.comboMealId, comboItem: { menuItemId: combo.menuItemRef, name: tx(combo.name), quantity: qty, total }, mainItem, sideItems };
  if (cm.seat != null) out.seat = cm.seat;
  return out;
}

function applyTender(t, due, where) {
  const cat = fx.tenders.find((x) => x.tenderId === t.tenderId);
  if (!cat) throw posErr('tender_not_found', `${where}: tender ${t.tenderId} not found`);
  if (due <= 0) throw posErr('nothing_due', `${where}: the check has nothing left to pay`);
  const asked = !t.total ? due : r2(t.total);
  if (asked < 0) throw posErr('invalid_amount', `${where}: total cannot be negative`);
  if (asked > due && !cat.allowOverTender) throw posErr('over_tender_not_allowed', `${where}: ${cat.name} cannot exceed the amount due (${due.toFixed(2)})`);
  const out = { tenderId: cat.tenderId, name: cat.name, total: Math.min(asked, due) };
  if (asked > due) out.changeDue = r2(asked - due);
  if (t.referenceText) out.referenceText = t.referenceText;
  return out;
}

// inputs: raw request arrays. paidTenders: tenders already resolved on a posted check.
function computeCheck(inputs, { prefixEnabled, newTenders = [], paidTenders = [] }) {
  const menuItems = (inputs.menuItems ?? []).map((m, i) => priceItem(m, `menuItems[${i}]`, { prefixEnabled }));
  const comboMeals = (inputs.comboMeals ?? []).map((c, i) => priceCombo(c, i, prefixEnabled));
  if (!menuItems.length && !comboMeals.length) throw posErr('empty_check', 'A check needs at least one menu item or combo meal');
  const subtotal = sum([...menuItems.map((m) => m.total), ...comboMeals.map((c) => c.comboItem.total)]);

  let remainingBase = subtotal;
  const discounts = (inputs.discounts ?? []).map((d, i) => {
    const cat = fx.discounts.find((x) => x.discountId === d.discountId);
    if (!cat) throw posErr('discount_not_found', `discounts[${i}]: discount ${d.discountId} not found`);
    let amount = cat.mockType === 'presetRate' ? r2(subtotal * cat.rate) : r2(d.total ?? 0);
    if (cat.mockType === 'openAmount' && !(amount > 0)) throw posErr('discount_amount_required', `discounts[${i}]: ${cat.name} is an open discount and needs a total`);
    amount = Math.min(amount, remainingBase);
    remainingBase = r2(remainingBase - amount);
    return { discountId: cat.discountId, name: cat.name, total: amount };
  });
  const subtotalDiscountTotal = sum(discounts.map((d) => d.total));
  const net = r2(subtotal - subtotalDiscountTotal);

  const serviceCharges = (inputs.serviceCharges ?? []).map((s, i) => {
    const cat = fx.serviceCharges.find((x) => x.serviceChargeId === s.serviceChargeId);
    if (!cat) throw posErr('service_charge_not_found', `serviceCharges[${i}]: service charge ${s.serviceChargeId} not found`);
    return { serviceChargeId: cat.serviceChargeId, name: cat.name, total: r2(net * cat.rate) };
  });
  const serviceChargeTotal = sum(serviceCharges.map((s) => s.total));
  const taxTotal = r2(net * fx.tax.rate);
  const taxes = [{ taxRateId: fx.tax.taxRateId, name: fx.tax.name, total: taxTotal }];

  const gross = r2(net + serviceChargeTotal + taxTotal);
  const tenders = [...paidTenders];
  let paid = sum(tenders.map((t) => t.total));
  newTenders.forEach((t, i) => {
    const applied = applyTender(t, r2(gross - paid), `tenders[${i}]`);
    tenders.push(applied);
    paid = r2(paid + applied.total);
  });

  return {
    menuItems, comboMeals, discounts, serviceCharges, taxes, tenders,
    totals: {
      subtotal, subtotalDiscountTotal, autoServiceChargeTotal: 0, serviceChargeTotal,
      taxTotal, paymentTotal: paid, totalDue: r2(gross - paid),
    },
  };
}

function printedLines(check) {
  const lines = [`CHECK ${check.header.checkNumber}${check.header.isTrainingCheck ? '  ** TRAINING **' : ''}`];
  for (const m of check.menuItems) {
    lines.push(`${m.quantity} ${m.name}  ${m.total.toFixed(2)}`);
    for (const c of m.condiments ?? []) lines.push(`   ${(c.prefixes ?? []).map((p) => p.name + ' ').join('')}${c.name}`);
  }
  for (const c of check.comboMeals) {
    lines.push(`${c.comboItem.quantity} ${c.comboItem.name}  ${c.comboItem.total.toFixed(2)}`);
    for (const s of [c.mainItem, ...c.sideItems]) lines.push(`   ${s.name}`);
  }
  lines.push(`TOTAL DUE  ${check.totals.totalDue.toFixed(2)}`);
  return { lines };
}

// ---------- state ----------

const checks = new Map();       // checkRef -> check
const idempotent = new Map();   // idempotencyId -> checkRef
let nextCheckNumber = 1001;

const HEADER_REQUIRED = ['orgShortName', 'locRef', 'rvcRef', 'idempotencyId', 'checkEmployeeRef', 'orderTypeRef'];

function requireContextHeaders(h) {
  const missing = ['simphony-orgshortname', 'simphony-locref', 'simphony-rvcref'].filter((k) => !h[k]);
  if (missing.length) throw new PosError('missing_headers', `Missing required headers: ${missing.join(', ')}`, 400, 'Bad Request');
  checkContext(h['simphony-orgshortname'], h['simphony-locref'], h['simphony-rvcref']);
}
function requireContextQuery(q) {
  const missing = ['orgShortName', 'locRef', 'rvcRef'].filter((k) => !q[k]);
  if (missing.length) throw new PosError('missing_query', `Missing required query parameters: ${missing.join(', ')}`, 400, 'Bad Request');
  checkContext(q.orgShortName, q.locRef, q.rvcRef);
}
function checkContext(org, locRef, rvcRef) {
  if (org.toLowerCase() !== fx.org) throw new PosError('org_not_found', `Organisation '${org}' not found (mock org is '${fx.org}')`, 404, 'Not Found');
  const rvcs = fx.revenueCenters[locRef];
  if (!rvcs) throw new PosError('location_not_found', `Location '${locRef}' not found`, 404, 'Not Found');
  if (rvcRef != null && !rvcs.some((r) => String(r.rvcRef) === String(rvcRef))) throw new PosError('rvc_not_found', `Revenue centre '${rvcRef}' not found at ${locRef}`, 404, 'Not Found');
}
function validateCheckHeader(header, h) {
  if (!header || typeof header !== 'object') throw new PosError('invalid_request', 'header is required', 400, 'Bad Request');
  const missing = HEADER_REQUIRED.filter((k) => header[k] == null || header[k] === '');
  if (missing.length) throw new PosError('invalid_request', `header is missing: ${missing.join(', ')}`, 400, 'Bad Request');
  if (!/^[0-9a-f]{32}$/.test(header.idempotencyId)) throw new PosError('invalid_request', 'header.idempotencyId must be 32 lowercase hex characters', 400, 'Bad Request');
  if (String(header.locRef) !== String(h['simphony-locref']) || String(header.rvcRef) !== String(h['simphony-rvcref'])) {
    throw new PosError('context_mismatch', 'header.locRef/rvcRef do not match the Simphony-LocRef/Simphony-RvcRef request headers', 400, 'Bad Request');
  }
}
const features = (h) => (h['simphony-features'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// ---------- routes ----------

const routes = [
  ['GET', /^\/api\/v1\/organizations\/([^/]+)\/locations$/, ({ m }) => {
    if (decodeURIComponent(m[1]).toLowerCase() !== fx.org) throw new PosError('org_not_found', `Organisation '${m[1]}' not found (mock org is '${fx.org}')`, 404, 'Not Found');
    return ok({ items: fx.locations.map((l) => ({ orgShortName: fx.org, ...l })) });
  }],
  ['GET', /^\/api\/v1\/organizations\/([^/]+)\/locations\/([^/]+)\/revenueCenters$/, ({ m }) => {
    checkContext(decodeURIComponent(m[1]), decodeURIComponent(m[2]), null);
    return ok({ items: fx.revenueCenters[decodeURIComponent(m[2])].map((r) => ({ orgShortName: fx.org, locRef: m[2], ...r })) });
  }],
  ['GET', /^\/api\/v1\/menus\/summary$/, ({ q }) => { requireContextQuery(q); return ok({ items: fx.menuSummaries }); }],
  ['GET', /^\/api\/v[12]\/menus\/([^/]+)$/, ({ m, h }) => {
    requireContextHeaders(h);
    if (m[1] !== menu.menuId) throw new PosError('menu_not_found', `Menu '${m[1]}' not found`, 404, 'Not Found');
    return ok(menu);
  }],
  ['GET', /^\/api\/v1\/(tenders|discounts|serviceCharges)\/collection$/, ({ m, q }) => { requireContextQuery(q); return ok({ items: fx[m[1]] }); }],
  ['HEAD', /^\/api\/v1\/checks\/connectionStatus$/, ({ h }) => { requireContextHeaders(h); return { status: 200, headers: {}, body: null }; }],
  ['POST', /^\/api\/v1\/checks\/calculator$/, ({ h, body }) => {
    requireContextHeaders(h);
    validateCheckHeader(body?.header, h);
    const priced = computeCheck(body, { prefixEnabled: true }); // tenders ignored, per docs
    return ok({ header: { ...body.header }, ...priced, tenders: [] });
  }],
  ['POST', /^\/api\/v1\/checks$/, ({ h, body }) => {
    requireContextHeaders(h);
    validateCheckHeader(body?.header, h);
    const feats = features(h);
    const prior = idempotent.get(body.header.idempotencyId);
    if (prior && feats.includes('detect-duplicate-request')) {
      const cached = structuredClone(checks.get(prior));
      cached.header.isCachedResponse = true;
      return ok(cached);
    }
    const priced = computeCheck(body, { prefixEnabled: feats.includes('enable-condiment-prefix'), newTenders: body.tenders ?? [] });
    const header = {
      ...body.header,
      checkRef: crypto.randomBytes(8).toString('hex'),
      checkNumber: nextCheckNumber++,
      openTime: new Date().toISOString(),
      isTrainingCheck: body.header.isTrainingCheck ?? false,
      status: priced.totals.totalDue <= 0 ? 'closed' : 'open',
      preparationStatus: 'Submitted',
    };
    const check = { header, ...priced };
    check.printedLines = printedLines(check);
    check._inputs = { menuItems: body.menuItems ?? [], comboMeals: body.comboMeals ?? [], discounts: body.discounts ?? [], serviceCharges: body.serviceCharges ?? [], prefixEnabled: feats.includes('enable-condiment-prefix') };
    checks.set(header.checkRef, check);
    idempotent.set(header.idempotencyId, header.checkRef);
    return ok(strip(check), 201);
  }],
  ['GET', /^\/api\/v1\/checks\/([^/]+)$/, ({ m, h }) => {
    requireContextHeaders(h);
    const check = checks.get(m[1]);
    if (!check) throw new PosError('check_not_found', `Check '${m[1]}' not found`, 404, 'Not Found');
    return ok(strip(check));
  }],
  ['POST', /^\/api\/v1\/checks\/([^/]+)\/round$/, ({ m, h, body }) => {
    requireContextHeaders(h);
    const check = checks.get(m[1]);
    if (!check) throw new PosError('check_not_found', `Check '${m[1]}' not found`, 404, 'Not Found');
    if (check.header.status === 'closed') throw posErr('check_closed', `Check ${check.header.checkNumber} is closed`);
    const inputs = check._inputs;
    const next = {
      menuItems: [...inputs.menuItems, ...(body?.menuItems ?? [])],
      comboMeals: [...inputs.comboMeals, ...(body?.comboMeals ?? [])],
      discounts: [...inputs.discounts, ...(body?.discounts ?? [])],
      serviceCharges: [...inputs.serviceCharges, ...(body?.serviceCharges ?? [])],
    };
    const priced = computeCheck(next, { prefixEnabled: inputs.prefixEnabled, paidTenders: check.tenders, newTenders: body?.tenders ?? [] });
    Object.assign(check, priced, { _inputs: { ...next, prefixEnabled: inputs.prefixEnabled } });
    check.header.status = priced.totals.totalDue <= 0 ? 'closed' : 'open';
    check.printedLines = printedLines(check);
    return ok(strip(check));
  }],
];

function strip(check) {
  const { _inputs, ...rest } = check;
  return structuredClone(rest);
}

export async function handleMock({ method, path, query = {}, headers = {}, body }) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  await new Promise((r) => setTimeout(r, 80 + Math.random() * 220)); // visible latency
  for (const [verb, re, fn] of routes) {
    const m = path.match(re);
    if (!m) continue;
    if (verb !== method && !(verb === 'HEAD' && method === 'GET')) continue;
    try {
      return fn({ m, q: query, h, body });
    } catch (err) {
      if (err instanceof PosError) {
        return err.status === 400 && err.title === 'POS Error'
          ? problem(400, 'POS Error', err.message, [{ code: err.code, message: err.message }])
          : problem(err.status, err.title, err.message, [{ code: err.code, message: err.message }]);
      }
      return problem(500, 'Internal Server Error', `Mock failure: ${err.message}`);
    }
  }
  const pathKnown = routes.some(([, re]) => re.test(path));
  return pathKnown ? problem(405, 'Method Not Allowed', `${method} is not supported on ${path}`) : problem(404, 'Not Found', `No mock route for ${method} ${path}`);
}

export function resetMock() {
  checks.clear();
  idempotent.clear();
  nextCheckNumber = 1001;
}
