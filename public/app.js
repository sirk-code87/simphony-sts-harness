// STS Gen2 harness UI. Plain JS, no build step. Tokens never reach this page.

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') e[k] = !!v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) e.append(kid instanceof Node ? kid : String(kid));
  return e;
}
const tx = (v) => (v && typeof v === 'object' ? Object.values(v)[0] ?? '' : v ?? '');
const listOf = (j, ...keys) => (Array.isArray(j) ? j : [...keys, 'items'].map((k) => j?.[k]).find(Array.isArray) ?? []);
const money = (n) => (typeof n === 'number' ? n.toFixed(2) : '-');
const hex32 = () => crypto.randomUUID().replaceAll('-', '');
const num = (x) => (x === '' || x == null || isNaN(Number(x)) ? x : Number(x));
const enc = encodeURIComponent;
const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return undefined; } };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const priceOf = (prices, seq) => (prices?.find((p) => p.priceSequence === (seq ?? 1)) ?? prices?.[0])?.price;

// Menu accessors, tolerant of field-name differences between the docs and a live tenant.
const M = {
  menu: () => S.data.menu,
  items: () => M.menu()?.menuItems ?? [],
  item: (id) => M.items().find((i) => i.menuItemId === id),
  defs: (item) => item?.definitions ?? [],
  defNo: (d) => d?.number ?? d?.definitionSequence ?? d?.sequence ?? 1,
  def: (item, no) => M.defs(item).find((d) => M.defNo(d) === (no ?? 1)) ?? M.defs(item)[0],
  rules: (d) => d?.condimentGroupRules ?? d?.condimentGroups ?? [],
  group: (id) => (M.menu()?.condimentGroups ?? []).find((g) => g.condimentGroupId === id),
  cond: (id) => (M.menu()?.condimentItems ?? []).find((c) => c.condimentId === id),
  prefixes: () => M.menu()?.condimentPrefixes ?? M.menu()?.prefixes ?? [],
  prefix: (id) => M.prefixes().find((p) => p.prefixId === id),
  combos: () => M.menu()?.comboMeals ?? [],
  comboFor: (menuItemId) => M.combos().find((c) => c.menuItemRef === menuItemId),
  families: () => M.menu()?.familyGroups ?? [],
  name: (id) => tx(M.item(id)?.name) || `#${id}`,
  condAllowsPrefix: (c) => (c?.definitions?.[0]?.options ?? []).includes('allowCondimentPrefix'),
};

// ---------- state ----------
const S = {
  mode: 'mock', config: null, auth: {},
  ctx: {}, data: {},
  basket: null, headerEdits: {}, checkName: '', training: true, features: { dup: true, prefix: true },
  idempotencyId: hex32(), lastPostedId: null,
  check: null, lookupRef: '', round: { tenders: [{ tenderId: null, total: 0 }], includeBasket: false },
  step: 'auth', curCall: {}, done: new Set(),
  rawInvalid: {}, hdrEdits: {}, last: {}, prev: {},
  reqTab: 'builder', resTab: 'body', viewing: null, sending: null, pendingReplay: null,
  history: store.get('sts.history', []), cfg: null, family: null, search: '', forceLogin: false, notice: '',
};

function resetWorkspace() {
  const d = S.config?.defaults?.[S.mode] ?? {};
  S.ctx = { org: d.org ?? '', locRef: d.locRef ?? '', rvcRef: d.rvcRef ?? '', employeeRef: d.employeeRef ?? '', orderTypeRef: d.orderTypeRef ?? '', menuId: '' };
  S.data = { locations: [], rvcs: [], menus: [], menu: null, tenders: [], discounts: [], serviceCharges: [] };
  clearBasket();
  S.check = null; S.lookupRef = ''; S.done = new Set(); S.last = {}; S.prev = {}; S.cfg = null; S.calc = null;
  S.rawInvalid = {}; S.hdrEdits = {};
}
function clearBasket() {
  S.basket = { menuItems: [], comboMeals: [], discounts: [], serviceCharges: [] };
  S.headerEdits = {};
}
function invalidateAfterContext() {
  S.data.menus = []; S.data.menu = null; S.data.tenders = []; S.data.discounts = []; S.data.serviceCharges = [];
  S.ctx.menuId = ''; clearBasket(); S.check = null; S.cfg = null; S.calc = null;
  for (const k of ['summary', 'menu', 'tenders', 'discounts', 'serviceCharges', 'calc', 'post', 'round', 'get']) S.done.delete(k);
  S.notice = 'Context changed: menu, basket and check cleared.';
}

// ---------- API calls ----------
const ctxHeaders = () => ({ 'Simphony-OrgShortName': S.ctx.org, 'Simphony-LocRef': S.ctx.locRef, 'Simphony-RvcRef': String(S.ctx.rvcRef) });
const ctxQuery = () => ({ orgShortName: S.ctx.org, locRef: S.ctx.locRef, rvcRef: S.ctx.rvcRef });
const checkRef = () => S.check?.header?.checkRef ?? '';
const basketCount = () => S.basket.menuItems.length + S.basket.comboMeals.length;

function genHeader() {
  const hd = {
    orgShortName: S.ctx.org, locRef: S.ctx.locRef, rvcRef: num(S.ctx.rvcRef), idempotencyId: S.idempotencyId,
    checkEmployeeRef: num(S.ctx.employeeRef), orderTypeRef: num(S.ctx.orderTypeRef),
  };
  if (S.checkName) hd.checkName = S.checkName;
  hd.isTrainingCheck = S.training;
  return hd;
}
function checkBody() {
  const b = { header: { ...genHeader(), ...S.headerEdits } };
  for (const k of ['menuItems', 'comboMeals', 'discounts', 'serviceCharges']) if (S.basket[k].length) b[k] = S.basket[k];
  return b;
}
function applyCheckBody(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Body must be a JSON object');
  const hd = { ...(p.header ?? {}) };
  if ('idempotencyId' in hd) { S.idempotencyId = String(hd.idempotencyId); delete hd.idempotencyId; }
  if ('isTrainingCheck' in hd) { S.training = hd.isTrainingCheck !== false; delete hd.isTrainingCheck; }
  if ('checkName' in hd) { S.checkName = hd.checkName ?? ''; delete hd.checkName; }
  if ('checkEmployeeRef' in hd) { S.ctx.employeeRef = String(hd.checkEmployeeRef ?? ''); delete hd.checkEmployeeRef; }
  if ('orderTypeRef' in hd) { S.ctx.orderTypeRef = String(hd.orderTypeRef ?? ''); delete hd.orderTypeRef; }
  const gen = genHeader();
  S.headerEdits = Object.fromEntries(Object.entries(hd).filter(([k, v]) => JSON.stringify(gen[k]) !== JSON.stringify(v)));
  for (const k of ['menuItems', 'comboMeals', 'discounts', 'serviceCharges']) S.basket[k] = Array.isArray(p[k]) ? p[k] : [];
}
function roundBody() {
  const b = { tenders: S.round.tenders.filter((t) => t.tenderId != null).map((t) => ({ tenderId: t.tenderId, total: Number(t.total) || 0 })) };
  if (S.round.includeBasket) {
    if (S.basket.menuItems.length) b.menuItems = S.basket.menuItems;
    if (S.basket.comboMeals.length) b.comboMeals = S.basket.comboMeals;
  }
  if (!b.tenders.length) delete b.tenders;
  return b;
}
function applyRoundBody(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Body must be a JSON object');
  S.round.tenders = Array.isArray(p.tenders) ? p.tenders.map((t) => ({ tenderId: t.tenderId, total: t.total ?? 0 })) : [];
  S.round.includeBasket = !!(p.menuItems || p.comboMeals);
  if (S.round.includeBasket) { S.basket.menuItems = p.menuItems ?? []; S.basket.comboMeals = p.comboMeals ?? []; }
}

const CALLS = {
  login: { label: 'Log in', method: 'POST', special: 'auth', path: () => '/oidc-provider/v1/oauth2/{authorize,signin,token}  (run by harness server)' },
  locations: {
    label: 'Locations', method: 'GET', path: () => `/api/v1/organizations/${enc(S.ctx.org)}/locations`,
    onOk: (j) => { S.data.locations = listOf(j, 'locations'); },
    next: [{ label: 'Load revenue centres', go: () => goCall('context', 'rvcs') }],
  },
  rvcs: {
    label: 'Revenue centres', method: 'GET', path: () => `/api/v1/organizations/${enc(S.ctx.org)}/locations/${enc(S.ctx.locRef)}/revenueCenters`,
    onOk: (j) => { S.data.rvcs = listOf(j, 'revenueCenters'); },
    next: [{ label: 'Check connection', go: () => goCall('context', 'connection') }, { label: 'Go to Menu', go: () => goStep('menu') }],
  },
  connection: {
    label: 'Connection status', method: 'HEAD', path: () => '/api/v1/checks/connectionStatus', headers: ctxHeaders,
    next: [{ label: 'Go to Menu', go: () => goStep('menu') }],
  },
  summary: {
    label: 'Menu summary', method: 'GET', path: () => '/api/v1/menus/summary', query: ctxQuery,
    onOk: (j) => { S.data.menus = listOf(j, 'menus', 'menuSummaries'); if (!S.ctx.menuId && S.data.menus[0]) S.ctx.menuId = String(menuIdOf(S.data.menus[0])); },
    next: [{ label: 'Load menu', go: () => goCall('menu', 'menu') }],
  },
  menu: {
    label: 'Menu', method: 'GET', path: () => `/api/v1/menus/${enc(S.ctx.menuId)}`, headers: ctxHeaders,
    onOk: (j) => { S.data.menu = j; S.family = null; },
    next: [{ label: 'Load tenders', go: () => goCall('menu', 'tenders') }],
  },
  tenders: {
    label: 'Tenders', method: 'GET', path: () => '/api/v1/tenders/collection', query: ctxQuery,
    onOk: (j) => { S.data.tenders = listOf(j, 'tenders'); },
    next: [{ label: 'Load discounts', go: () => goCall('menu', 'discounts') }],
  },
  discounts: {
    label: 'Discounts', method: 'GET', path: () => '/api/v1/discounts/collection', query: ctxQuery,
    onOk: (j) => { S.data.discounts = listOf(j, 'discounts'); },
    next: [{ label: 'Load service charges', go: () => goCall('menu', 'serviceCharges') }],
  },
  serviceCharges: {
    label: 'Service charges', method: 'GET', path: () => '/api/v1/serviceCharges/collection', query: ctxQuery,
    onOk: (j) => { S.data.serviceCharges = listOf(j, 'serviceCharges'); },
    next: [{ label: 'Build a check', go: () => goStep('build') }],
  },
  preview: { label: 'Check body', method: '-', noSend: true, path: () => 'No request. Build the basket, then Calculate.', body: checkBody, setBody: applyCheckBody },
  calc: {
    label: 'Calculate', method: 'POST', path: () => '/api/v1/checks/calculator', headers: ctxHeaders, body: checkBody, setBody: applyCheckBody,
    onOk: (j) => { S.calc = j; },
    next: [{ label: 'Post this check', go: () => goStep('post') }],
  },
  post: {
    label: 'Post check', method: 'POST', path: () => '/api/v1/checks', risky: true, body: checkBody, setBody: applyCheckBody,
    headers: () => {
      const f = [S.features.dup && 'detect-duplicate-request', S.features.prefix && 'enable-condiment-prefix'].filter(Boolean);
      return { ...ctxHeaders(), ...(f.length ? { 'Simphony-Features': f.join(',') } : {}) };
    },
    onOk: (j, spec) => { S.check = j; S.lookupRef = j?.header?.checkRef ?? ''; S.lastPostedId = spec.body?.header?.idempotencyId; S.round = { tenders: [{ tenderId: S.data.tenders[0]?.tenderId ?? null, total: 0 }], includeBasket: false }; },
    next: [{ label: 'Pay this check', go: () => goStep('round') }, { label: 'Inspect', go: () => goStep('inspect') }],
  },
  round: {
    label: 'Round (pay / add)', method: 'POST', path: () => `/api/v1/checks/${enc(checkRef())}/round`, risky: true, headers: ctxHeaders, body: roundBody, setBody: applyRoundBody,
    onOk: (j) => { S.check = j; },
    next: [{ label: 'Inspect check', go: () => goStep('inspect') }],
  },
  get: {
    label: 'Get check', method: 'GET', path: () => `/api/v1/checks/${enc(S.lookupRef || checkRef())}`, headers: ctxHeaders,
    onOk: (j) => { if (j?.header?.checkRef) S.check = j; },
    next: [{ label: 'Start a new check', go: () => { clearBasket(); S.idempotencyId = hex32(); S.calc = null; S.done.delete('calc'); goStep('build'); } }],
  },
};
const menuIdOf = (m) => m?.menuId ?? m?.MenuSummaryProperties?.menuId ?? m?.id;
const menuNameOf = (m) => tx(m?.name ?? m?.MenuSummaryProperties?.name) || menuIdOf(m);
const ctxReady = () => !!(S.ctx.org && S.ctx.locRef && S.ctx.rvcRef !== '');
const checkReady = () => basketCount() > 0 && ctxReady() && S.ctx.employeeRef !== '' && S.ctx.orderTypeRef !== '';

const STEPS = [
  { id: 'auth', label: 'Auth', calls: ['login'], unlocked: () => true, done: () => !!S.auth.authenticated },
  { id: 'context', label: 'Context', calls: ['locations', 'rvcs', 'connection'], unlocked: () => !!S.auth.authenticated, done: () => ctxReady() && S.done.has('rvcs') },
  { id: 'menu', label: 'Menu', calls: ['summary', 'menu', 'tenders', 'discounts', 'serviceCharges'], unlocked: () => !!S.auth.authenticated && ctxReady(), done: () => !!S.data.menu },
  { id: 'build', label: 'Build', calls: ['preview'], unlocked: () => !!S.data.menu, done: () => basketCount() > 0 },
  { id: 'calc', label: 'Calculate', calls: ['calc'], unlocked: checkReady, done: () => S.done.has('calc') },
  { id: 'post', label: 'Post', calls: ['post'], unlocked: checkReady, done: () => !!S.check },
  { id: 'round', label: 'Pay / add', calls: ['round'], unlocked: () => !!S.check, done: () => S.check?.header?.status === 'closed' },
  { id: 'inspect', label: 'Inspect', calls: ['get'], unlocked: () => !!S.check || !!S.auth.authenticated && ctxReady(), done: () => S.done.has('get') },
];
const stepOf = (id) => STEPS.find((s) => s.id === id);
const curKey = () => S.curCall[S.step] ?? stepOf(S.step).calls[0];

function goStep(id) {
  const st = stepOf(id);
  if (!st.unlocked()) return toast(`${st.label} is locked until the earlier steps succeed.`);
  S.step = id; S.viewing = null;
  if (!S.curCall[id]) S.curCall[id] = st.calls.find((c) => !S.done.has(c)) ?? st.calls[0];
  render();
}
function goCall(stepId, key) { S.curCall[stepId] = key; goStep(stepId); }

function currentSpec(key = curKey()) {
  const c = CALLS[key];
  const headers = S.hdrEdits[key] != null ? parseHeaderText(S.hdrEdits[key]) : (c.headers?.() ?? {});
  const spec = { key, method: c.method, path: c.path(), query: c.query?.() ?? {}, headers };
  if (c.body) spec.body = c.body();
  return spec;
}
function parseHeaderText(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const headerText = (o) => Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n');
function fullPath(spec) {
  const qs = new URLSearchParams(Object.entries(spec.query ?? {}).filter(([, v]) => v !== '' && v != null)).toString();
  return spec.path + (qs ? `?${qs}` : '');
}

// ---------- sending ----------
async function sendSpec(spec) {
  const c = CALLS[spec.key];
  if (c.special === 'auth') return login();
  if (c.noSend) return;
  if (S.rawInvalid[spec.key]) return toast('Raw JSON does not parse. Fix it before sending.');
  if (S.mode === 'live' && c.risky) {
    const loc = S.data.locations.find((l) => String(l.locRef) === String(S.ctx.locRef));
    const training = spec.body?.header ? spec.body.header.isTrainingCheck !== false : true;
    const ok = await confirmModal(`${c.label} on LIVE`,
      `${spec.method} ${spec.path} to ${loc ? tx(loc.name) + ' ' : ''}(location ${S.ctx.locRef}, revenue centre ${S.ctx.rvcRef}).` +
      (training ? '' : ' This is NOT a training check.'));
    if (!ok) return;
  }
  const ac = new AbortController();
  S.sending = { key: spec.key, started: performance.now(), ac };
  const tick = setInterval(renderSendButton, 100);
  render();
  let res;
  try {
    const r = await fetch('/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: S.mode, method: spec.method, path: spec.path, query: spec.query, headers: spec.headers, body: spec.body }), signal: ac.signal });
    res = await r.json();
  } catch (err) {
    res = err.name === 'AbortError' ? { ok: false, cancelled: true } : { ok: false, harnessError: 'Harness server not reachable. Is "npm start" still running?' };
  } finally {
    clearInterval(tick);
    S.sending = null;
  }
  if (res.cancelled) { toast('Request cancelled.'); return render(); }
  record(spec, res);
  if (res.ok && res.status >= 200 && res.status < 300) {
    S.done.add(spec.key);
    try { c.onOk?.(parse(res.body), spec); } catch (e) { toast(`Response handled with an error: ${e.message}`); }
  }
  if (res.status === 401 || res.authRequired) { S.pendingReplay = spec; await refreshAuth(); }
  render();
}

function record(spec, res) {
  const entry = { id: hex32(), t: Date.now(), mode: S.mode, step: S.step, req: spec, res };
  S.prev[spec.key] = S.last[spec.key];
  S.last[spec.key] = entry;
  S.history.unshift(entry);
  S.history = S.history.slice(0, 50);
  store.set('sts.history', S.history);
}

async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
async function refreshAuth() {
  try { S.auth = await api(`/auth/status?mode=${S.mode}`); } catch { S.auth = {}; }
  renderCtxBar(); renderSteps();
}
async function login(action = 'login') {
  const started = performance.now();
  let j;
  try { j = await api(`/auth/${action}`, { mode: S.mode, force: S.forceLogin }); } catch { j = { ok: false, detail: 'Harness server not reachable' }; }
  const ms = Math.round(performance.now() - started);
  const text = JSON.stringify(j, null, 2);
  record({ key: 'login', method: 'POST', path: `/auth/${action} (harness, ${S.mode})`, query: {}, headers: {}, body: { mode: S.mode } },
    { ok: true, status: j.ok ? 200 : 401, statusText: j.ok ? 'OK' : 'Auth failed', headers: {}, body: text, ms, size: text.length, mode: S.mode });
  if (j.ok) { S.forceLogin = false; toast(action === 'login' ? 'Logged in.' : 'Token refreshed.'); }
  await refreshAuth();
  render();
}

// ---------- rendering: context bar, steps ----------
function renderCtxBar() {
  document.body.classList.toggle('live', S.mode === 'live');
  $('#mode-mock').setAttribute('aria-pressed', S.mode === 'mock');
  $('#mode-live').setAttribute('aria-pressed', S.mode === 'live');
  $('#live-flag').hidden = S.mode !== 'live';
  const loc = S.data.locations.find((l) => String(l.locRef) === String(S.ctx.locRef));
  const rvc = S.data.rvcs.find((r) => String(r.rvcRef) === String(S.ctx.rvcRef));
  const menu = S.data.menus.find((m) => String(menuIdOf(m)) === String(S.ctx.menuId));
  const parts = [['Org', S.ctx.org], ['Loc', loc ? `${S.ctx.locRef} ${tx(loc.name)}` : S.ctx.locRef], ['RVC', rvc ? `${S.ctx.rvcRef} ${tx(rvc.name)}` : S.ctx.rvcRef], ['Menu', menu ? menuNameOf(menu) : S.ctx.menuId]];
  $('#crumbs').replaceChildren(...parts.flatMap(([k, v], i) => [i ? h('span', {}, '>') : null, h('span', {}, `${k} `, h('b', {}, v || '-'))]));
  const tok = $('#token');
  if (S.auth.authenticated) {
    const left = S.auth.expiresAt - Date.now();
    const d = Math.floor(left / 864e5), hr = Math.floor((left % 864e5) / 36e5), mi = Math.floor((left % 36e5) / 6e4);
    tok.textContent = `Token ${d ? `${d}d ${hr}h` : hr ? `${hr}h ${mi}m` : `${mi}m`}`;
    tok.className = 'token ok';
  } else {
    tok.textContent = S.auth.expiresAt ? 'Token expired' : 'Not logged in';
    tok.className = S.auth.expiresAt ? 'token bad' : 'token';
  }
}

function renderSteps() {
  $('#steps').replaceChildren(...STEPS.map((st, i) => {
    const unlocked = st.unlocked();
    return h('li', {}, h('button', { disabled: !unlocked, 'aria-current': S.step === st.id ? 'step' : false, onclick: () => goStep(st.id), title: unlocked ? '' : 'Complete the earlier steps first' },
      h('span', { class: 'n' }, i + 1), st.label, st.done() ? h('span', { class: 'mark done', 'aria-label': 'done' }, '✓') : null));
  }));
}

// ---------- rendering: request pane ----------
function renderRequest() {
  const key = curKey();
  const c = CALLS[key];
  const st = stepOf(S.step);
  const viewing = S.viewing;
  const spec = viewing ? viewing.req : currentSpec(key);
  $('#req-method').textContent = spec.method;
  $('#req-path').textContent = c.special || c.noSend ? spec.path : fullPath(spec);
  $('#send').classList.toggle('risky', !!c.risky);
  renderSendButton();

  $('#calls').replaceChildren(...(st.calls.length > 1 ? st.calls.map((k) => h('button', { class: 'chip', 'aria-pressed': k === key, onclick: () => { S.curCall[S.step] = k; S.viewing = null; render(); } },
    CALLS[k].label, S.done.has(k) ? h('span', { class: 'ok' }, ' ✓') : null)) : []));

  const vb = $('#viewing');
  vb.hidden = !viewing;
  if (viewing) {
    vb.replaceChildren(`Viewing ${new Date(viewing.t).toLocaleTimeString()} from history (read-only).`,
      h('button', { class: 'btn small', onclick: () => { if (viewing.mode !== S.mode) return toast(`That request was made in ${viewing.mode} mode. Switch modes to re-send it.`); const spec = viewing.req; S.viewing = null; sendSpec(spec); } }, 'Re-send'),
      h('button', { class: 'btn small', onclick: () => { S.viewing = null; render(); } }, 'Back to current'));
  }

  for (const t of $$('.req .tab')) t.setAttribute('aria-selected', t.dataset.tab === S.reqTab);
  for (const p of $$('.req .tabpanel')) p.hidden = p.dataset.panel !== S.reqTab;

  if (S.reqTab === 'builder') {
    const b = $('#builder');
    const notices = [];
    if (S.notice) { notices.push(h('div', { class: 'banner warn' }, S.notice, h('button', { class: 'btn small', onclick: () => { S.notice = ''; render(); } }, 'Dismiss'))); }
    if (S.rawInvalid[key]) notices.push(h('div', { class: 'banner err' }, 'Raw JSON has been edited and does not parse, so it is not applied. Fix it on the Raw JSON tab.'));
    if (viewing) b.replaceChildren(...notices, h('pre', { class: 'code out' }, JSON.stringify(viewing.req, null, 2)));
    else b.replaceChildren(...notices, ...BUILDERS[S.step]());
  }
  if (S.reqTab === 'raw') {
    const ta = $('#raw');
    if (document.activeElement !== ta) {
      if (viewing) ta.value = viewing.req.body ? JSON.stringify(viewing.req.body, null, 2) : '';
      else if (!S.rawInvalid[key]) ta.value = c.body ? JSON.stringify(c.body(), null, 2) : '';
    }
    ta.readOnly = !!viewing || !c.setBody;
    $('#raw-status').textContent = S.rawInvalid[key] ? `Invalid JSON: ${S.rawInvalid[key].message}` : c.setBody ? 'Edits apply to the builder as you type. Builder changes rewrite this text.' : 'This request has no body.';
    $('#raw-status').className = S.rawInvalid[key] ? 'hint err' : 'hint';
  }
  if (S.reqTab === 'headers') {
    const ta = $('#hdrs');
    if (document.activeElement !== ta) ta.value = viewing ? headerText(viewing.req.headers ?? {}) : S.hdrEdits[key] ?? headerText(c.headers?.() ?? {});
    ta.readOnly = !!viewing || !!c.special || !!c.noSend;
  }
}

function renderSendButton() {
  const btn = $('#send');
  const c = CALLS[curKey()];
  if (S.sending) {
    btn.textContent = `Sending… ${((performance.now() - S.sending.started) / 1000).toFixed(1)} s  (Cancel)`;
    btn.disabled = false;
    return;
  }
  btn.textContent = c.special ? 'Log in' : c.risky && S.mode === 'live' ? 'Send to LIVE' : 'Send';
  btn.disabled = !!c.noSend || !!S.viewing || !!S.rawInvalid[curKey()];
}

// ---------- rendering: response pane ----------
function statusClass(s) { return s ? `s${String(s)[0]}` : 's0'; }
function renderResponse() {
  const key = curKey();
  const entry = S.viewing ?? S.last[key];
  const prev = S.viewing ? null : S.prev[key];
  const badges = $('#res-badges'), bodyEl = $('#res-body'), banner = $('#res-banner'), summary = $('#summary');
  banner.replaceChildren();
  summary.hidden = true;
  bodyEl.classList.toggle('dim', !!S.sending && S.sending.key === key);

  for (const t of $$('.res .tab')) t.setAttribute('aria-selected', t.dataset.rtab === S.resTab);
  for (const p of $$('[data-rpanel]')) p.hidden = p.dataset.rpanel !== S.resTab;

  if (!entry) {
    badges.replaceChildren(h('span', { class: 'muted' }, 'No response yet'));
    bodyEl.textContent = EMPTY[key] ?? 'Send the request to see the response here.';
    $('#res-headers').textContent = '';
    $('#res-diff').textContent = '';
    $('#next').replaceChildren();
    return;
  }
  const r = entry.res;
  const modeBadge = entry.mode === 'mock' ? h('span', { class: 'badge mock' }, 'MOCK') : h('span', { class: 'badge liveb' }, 'LIVE');
  if (!r.ok) {
    badges.replaceChildren(h('span', { class: 'badge s0' }, r.networkError ? 'No response' : 'Harness'), modeBadge, r.ms != null ? h('span', { class: 'badge' }, `${r.ms} ms`) : null);
    banner.replaceChildren(h('div', { class: 'banner err' }, r.networkError ?? r.harnessError,
      r.authRequired ? h('button', { class: 'btn small', onclick: () => { S.step = 'auth'; render(); } }, 'Go to Auth') : null));
    bodyEl.textContent = r.networkError ? 'The harness sent the request but the server did not answer.' : 'The harness did not send this request.';
    $('#res-headers').textContent = '';
    $('#res-diff').textContent = '';
    $('#next').replaceChildren();
    return;
  }

  badges.replaceChildren(h('span', { class: `badge ${statusClass(r.status)}` }, `${r.status} ${r.statusText ?? ''}`.trim()), modeBadge,
    h('span', { class: 'badge' }, `${r.ms} ms`), h('span', { class: 'badge' }, r.size > 1024 ? `${(r.size / 1024).toFixed(1)} KB` : `${r.size} B`));
  const json = parse(r.body);
  const pretty = json !== undefined && json !== null ? JSON.stringify(json, null, 2) : r.body || '(empty body)';
  bodyEl.textContent = pretty;
  $('#res-headers').textContent = headerText(r.headers ?? {});
  renderDiff(prev, pretty);

  if (S.pendingReplay && S.auth.authenticated && S.pendingReplay.key === key && !S.viewing) {
    banner.replaceChildren(h('div', { class: 'banner info' }, 'Logged in again. Replay the request that failed?',
      h('button', { class: 'btn small primary', onclick: () => { const sp = S.pendingReplay; S.pendingReplay = null; sendSpec(sp); } }, 'Replay'),
      h('button', { class: 'btn small', onclick: () => { S.pendingReplay = null; render(); } }, 'No')));
  } else if (r.status === 401) {
    banner.replaceChildren(h('div', { class: 'banner err' }, 'Token expired or invalid.',
      h('button', { class: 'btn small', onclick: reauthAndOffer }, 'Re-auth')));
  } else if (json && r.status >= 400) {
    banner.replaceChildren(h('div', { class: 'banner err problem' },
      h('div', {}, h('strong', {}, json.title ?? 'Error'), json.detail ? `: ${json.detail}` : ''),
      Array.isArray(json.posDetails) && json.posDetails.length ? h('ul', {}, json.posDetails.map((p) => h('li', {}, `${p.code}: ${p.message}`))) : null));
  }

  if (json && r.status < 300) renderSummary(json);
  const c = CALLS[entry.req.key];
  const showNext = !S.viewing && r.status >= 200 && r.status < 300 && c?.next;
  $('#next').replaceChildren(...(showNext ? [h('span', { class: 'muted' }, 'Next: '), ...c.next.map((n) => h('button', { class: 'btn small primary', onclick: n.go }, `${n.label} →`))] : []));
}
const EMPTY = {
  login: 'Log in to see the token status here. Tokens stay on the harness server.',
  locations: 'Load locations to pick one.',
  summary: 'Load the menu summary to choose a menu.',
  preview: 'Build the basket on the left. The body is on the Raw JSON tab.',
  calc: 'Send a calculate to see totals.',
  post: 'Post the check to get a check number.',
  round: 'Send a round to pay or add items.',
  get: 'Fetch the check to see its current state.',
};

async function reauthAndOffer() {
  if (!S.pendingReplay) S.pendingReplay = S.last[curKey()]?.req ?? null;
  await login('login');
}

function renderSummary(j) {
  const cells = [];
  const hd = j.header;
  if (hd?.checkNumber != null) cells.push(['Check', `#${hd.checkNumber}`]);
  if (hd?.checkRef) cells.push(['Ref', hd.checkRef]);
  if (hd?.status) cells.push(['Status', hd.status]);
  if (hd?.isTrainingCheck) cells.push(['Mode', 'Training']);
  if (hd?.isCachedResponse) cells.push(['Cached', 'yes (duplicate)']);
  const t = j.totals;
  if (t) {
    cells.push(['Subtotal', money(t.subtotal)]);
    if (t.subtotalDiscountTotal) cells.push(['Discounts', money(t.subtotalDiscountTotal)]);
    if (t.serviceChargeTotal) cells.push(['Service', money(t.serviceChargeTotal)]);
    cells.push(['Tax', money(t.taxTotal)]);
    if (t.paymentTotal) cells.push(['Paid', money(t.paymentTotal)]);
    cells.push(['Total due', money(t.totalDue)]);
  }
  if (j.authenticated != null) cells.push(['Authenticated', j.authenticated ? 'yes' : 'no'], ['Expires', j.expiresAt ? new Date(j.expiresAt).toLocaleString() : '-']);
  const list = Array.isArray(j) ? j : j.items;
  if (!cells.length && Array.isArray(list)) cells.push(['Items', list.length]);
  if (!cells.length && j.menuItems) cells.push(['Menu items', j.menuItems.length], ['Combos', (j.comboMeals ?? []).length], ['Condiments', (j.condimentItems ?? []).length]);
  if (!cells.length) return;
  const el = $('#summary');
  el.hidden = false;
  el.replaceChildren(...cells.map(([k, v]) => h('div', {}, h('span', {}, k), h('b', {}, v))));
}

function renderDiff(prevEntry, pretty) {
  const el = $('#res-diff');
  if (!prevEntry?.res?.body) { el.textContent = 'No earlier response for this request to compare with.'; return; }
  const pj = parse(prevEntry.res.body);
  const a = (pj != null ? JSON.stringify(pj, null, 2) : prevEntry.res.body).split('\n');
  const b = pretty.split('\n');
  if (a.length * b.length > 4e6) { el.textContent = 'Responses too large to diff here.'; return; }
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0, changes = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push(h('span', {}, `  ${a[i]}\n`)); i++; j++; }
    else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) { out.push(h('span', { class: 'diff-add' }, `+ ${b[j]}\n`)); j++; changes++; }
    else { out.push(h('span', { class: 'diff-del' }, `- ${a[i]}\n`)); i++; changes++; }
  }
  el.replaceChildren(h('span', { class: 'muted' }, changes ? `${changes} changed lines vs ${new Date(prevEntry.t).toLocaleTimeString()}\n\n` : `Identical to ${new Date(prevEntry.t).toLocaleTimeString()}\n\n`), ...out);
}

// ---------- rendering: history ----------
function renderHistory() {
  $('#hist-count').textContent = S.history.length ? `${S.history.length} (kept in this browser)` : '';
  $('#history').replaceChildren(...S.history.map((e) => h('li', {}, h('button', { onclick: () => viewHistory(e) },
    h('span', {}, new Date(e.t).toLocaleTimeString()), h('span', {}, e.mode.toUpperCase()),
    h('span', {}, e.req.method), h('span', { style: 'flex:1' }, e.req.key === 'login' ? e.req.path : fullPath(e.req)),
    h('span', { class: `st${e.res.ok ? String(e.res.status)[0] : 0}` }, e.res.ok ? e.res.status : 'ERR'),
    h('span', { class: 'muted' }, e.res.ms != null ? `${e.res.ms} ms` : '')))));
}
function viewHistory(e) {
  const st = STEPS.find((s) => s.calls.includes(e.req.key));
  if (st) { S.step = st.id; S.curCall[st.id] = e.req.key; }
  S.viewing = e;
  render();
}

// ---------- builders (one per step) ----------
const field = (label, value, oninput, attrs = {}) => h('label', {}, label, h('input', { value: value ?? '', oninput: (e) => oninput(e.target.value), ...attrs }));
const callBtn = (key, text) => h('button', { class: 'btn small', onclick: () => { S.curCall[S.step] = key; sendSpec(currentSpec(key)); } }, text);

const BUILDERS = {
  auth() {
    const live = S.mode === 'live';
    const cfg = S.config?.live ?? {};
    const out = [];
    if (live) {
      out.push(h('p', {}, 'Live login runs the PKCE flow on the harness server with the credentials in ', h('code', {}, '.env'), '. Tokens are held in server memory and never sent to this page.'));
      if (!cfg.configured) out.push(h('div', { class: 'banner err' }, `Live is not configured. Missing in .env: ${cfg.missing?.join(', ')}. Restart "npm start" after editing .env.`));
      else out.push(h('p', { class: 'hint' }, `API host: ${cfg.apiHost}`));
      out.push(h('div', { class: 'banner warn' }, 'Two failed sign-ins in a row trigger a guard here; Oracle locks the account for 30 minutes after repeated failures.'));
      if (S.auth.consecutiveFailures >= 2) out.push(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.forceLogin, onchange: (e) => { S.forceLogin = e.target.checked; } }), 'I have fixed .env; try again anyway'));
    } else {
      out.push(h('p', {}, 'Mock login accepts no credentials and issues a simulated 14-day token. Use it to walk the whole flow offline.'));
    }
    out.push(h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: () => login('refresh') }, 'Refresh token'),
      h('button', { class: 'btn small', onclick: async () => { await api('/auth/logout', { mode: S.mode }); await refreshAuth(); render(); } }, 'Log out'),
      !live ? h('button', { class: 'btn small', onclick: async () => { await api('/auth/expire', { mode: 'mock' }); await refreshAuth(); toast('Mock token expired. The next call returns 401.'); render(); } }, 'Simulate expiry') : null,
      !live ? h('button', { class: 'btn small', onclick: async () => { await api('/mock/reset', { mode: 'mock' }); toast('Mock checks cleared.'); } }, 'Reset mock checks') : null));
    if (S.auth.authenticated) out.push(h('p', { class: 'hint' }, `Logged in. Token expires ${new Date(S.auth.expiresAt).toLocaleString()}.`));
    return out;
  },

  context() {
    const locs = S.data.locations, rvcs = S.data.rvcs;
    const setCtx = (k, v, invalidates) => { if (S.ctx[k] === v) return; S.ctx[k] = v; if (invalidates) invalidateAfterContext(); };
    return [
      h('div', { class: 'row' },
        field('Org short name', S.ctx.org, (v) => { setCtx('org', v.trim(), true); S.data.locations = []; S.data.rvcs = []; renderLight(); }),
        h('div', {}, callBtn('locations', 'Load locations'))),
      h('div', { class: 'row' },
        locs.length
          ? h('label', {}, 'Location', h('select', { onchange: (e) => { setCtx('locRef', e.target.value, true); S.data.rvcs = []; S.done.delete('rvcs'); render(); } },
            h('option', { value: '' }, 'Choose…'), locs.map((l) => h('option', { value: l.locRef, selected: String(l.locRef) === String(S.ctx.locRef) }, `${tx(l.name)} (${l.locRef})`))))
          : field('Location ref', S.ctx.locRef, (v) => { setCtx('locRef', v.trim(), true); renderLight(); }),
        h('div', {}, callBtn('rvcs', 'Load revenue centres'))),
      h('div', { class: 'row' },
        rvcs.length
          ? h('label', {}, 'Revenue centre', h('select', { onchange: (e) => { setCtx('rvcRef', e.target.value, true); render(); } },
            h('option', { value: '' }, 'Choose…'), rvcs.map((r) => h('option', { value: r.rvcRef, selected: String(r.rvcRef) === String(S.ctx.rvcRef) }, `${tx(r.name)} (${r.rvcRef})`))))
          : field('Revenue centre ref', S.ctx.rvcRef, (v) => { setCtx('rvcRef', v.trim(), true); renderLight(); })),
      h('div', { class: 'row' },
        field('Check employee ref', S.ctx.employeeRef, (v) => { S.ctx.employeeRef = v.trim(); renderLight(); }),
        field('Order type ref', S.ctx.orderTypeRef, (v) => { S.ctx.orderTypeRef = v.trim(); renderLight(); })),
      h('p', { class: 'hint' }, 'Employee and order type refs come from the venue configuration; posting a check needs both. Changing org, location or revenue centre clears the menu, basket and check.'),
    ];
  },

  menu() {
    const d = S.data;
    const status = (label, ok, extra) => h('li', {}, ok ? '✓ ' : '· ', label, extra ? h('span', { class: 'muted' }, ` ${extra}`) : null);
    return [
      h('div', { class: 'row' },
        d.menus.length
          ? h('label', {}, 'Menu', h('select', { onchange: (e) => { S.ctx.menuId = e.target.value; S.data.menu = null; S.done.delete('menu'); render(); } },
            d.menus.map((m) => h('option', { value: menuIdOf(m), selected: String(menuIdOf(m)) === String(S.ctx.menuId) }, `${menuNameOf(m)} (${menuIdOf(m)})`))))
          : field('Menu ID', S.ctx.menuId, (v) => { S.ctx.menuId = v.trim(); renderLight(); }),
        h('div', { class: 'row' }, callBtn('summary', 'Load summary'), callBtn('menu', 'Load menu'))),
      h('ul', {},
        status('Menu', !!d.menu, d.menu ? `${M.items().length} items, ${M.combos().length} combos, ${(d.menu.condimentItems ?? []).length} condiments, ${M.prefixes().length} prefixes` : ''),
        status('Tenders', S.done.has('tenders'), d.tenders.length ? `${d.tenders.length}` : ''),
        status('Discounts', S.done.has('discounts'), d.discounts.length ? `${d.discounts.length}` : ''),
        status('Service charges', S.done.has('serviceCharges'), d.serviceCharges.length ? `${d.serviceCharges.length}` : '')),
      h('p', { class: 'hint' }, 'Collections take org, location and RVC as query parameters; the menu and checks endpoints take them as Simphony-* headers. The harness places them per endpoint.'),
    ];
  },

  build() {
    return [h('div', { class: 'build' }, h('div', {}, picker(), S.cfg ? configurator() : null), h('div', {}, basketView()))];
  },

  calc() {
    return [
      h('p', {}, 'Prices the basket without saving it. Tenders are ignored by this endpoint.'),
      basketSummaryLine(),
      S.calc ? totalsTable(S.calc.totals) : null,
    ];
  },

  post() {
    const reused = S.lastPostedId && S.lastPostedId === S.idempotencyId;
    return [
      basketSummaryLine(),
      h('div', { class: 'row' },
        field('Check name (max 20)', S.checkName, (v) => { S.checkName = v.slice(0, 20); renderLight(); }, { maxlength: 20 }),
        h('label', {}, 'Idempotency ID', h('div', { class: 'row' }, h('code', {}, S.idempotencyId), h('button', { class: 'btn small', onclick: () => { S.idempotencyId = hex32(); render(); } }, 'New ID')))),
      reused ? h('div', { class: 'banner warn' }, 'This idempotency ID was used for the last posted check. With duplicate detection on, sending again returns that check (isCachedResponse). Press New ID for a fresh check.') : null,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.training, onchange: (e) => { S.training = e.target.checked; render(); } }), 'Training check (isTrainingCheck)'),
      !S.training ? h('div', { class: 'banner err' }, 'Training is off: this posts a real check on the target enterprise.') : null,
      h('fieldset', {}, h('legend', {}, 'Simphony-Features header'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.features.dup, onchange: (e) => { S.features.dup = e.target.checked; renderLight(); } }), 'detect-duplicate-request'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.features.prefix, onchange: (e) => { S.features.prefix = e.target.checked; renderLight(); } }), 'enable-condiment-prefix (without it, prefixes are dropped)')),
    ];
  },

  round() {
    const t = S.check?.totals;
    return [
      h('p', {}, `Check #${S.check?.header?.checkNumber ?? '?'} (${checkRef()}), status ${S.check?.header?.status ?? '?'}, total due `, h('b', {}, money(t?.totalDue))),
      h('fieldset', {}, h('legend', {}, 'Tenders (total 0 pays the full amount due)'),
        S.round.tenders.map((tn, i) => h('div', { class: 'row' },
          h('label', {}, 'Tender', h('select', { onchange: (e) => { tn.tenderId = num(e.target.value); renderLight(); } },
            h('option', { value: '' }, 'Choose…'), S.data.tenders.map((x) => h('option', { value: x.tenderId, selected: x.tenderId === tn.tenderId }, `${tx(x.name)} (${x.tenderId})`)))),
          field('Amount', tn.total, (v) => { tn.total = v; renderLight(); }, { type: 'number', step: '0.01', min: '0' }),
          h('button', { class: 'btn small', onclick: () => { S.round.tenders.splice(i, 1); render(); } }, 'Remove'))),
        h('button', { class: 'btn small', onclick: () => { S.round.tenders.push({ tenderId: null, total: 0 }); render(); } }, 'Add tender')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.round.includeBasket, onchange: (e) => { S.round.includeBasket = e.target.checked; renderLight(); } }),
        `Also add the current basket as a new round (${basketCount()} lines)`),
    ];
  },

  inspect() {
    return [
      field('Check ref', S.lookupRef || checkRef(), (v) => { S.lookupRef = v.trim(); renderLight(); }),
      S.check?.printedLines?.lines ? h('pre', { class: 'code out' }, S.check.printedLines.lines.join('\n')) : null,
    ];
  },
};

function basketSummaryLine() {
  const n = basketCount();
  return h('p', { class: 'hint' }, n ? `${n} basket lines, ${S.basket.discounts.length} discounts, ${S.basket.serviceCharges.length} service charges. ` : 'The basket is empty. ',
    h('button', { class: 'btn small', onclick: () => goStep('build') }, 'Edit basket'));
}
function totalsTable(t) {
  if (!t) return null;
  return h('table', {}, Object.entries(t).map(([k, v]) => h('tr', {}, h('td', { class: 'muted' }, k), h('td', {}, h('code', {}, money(v))))));
}

// ---------- build step: picker, configurator, basket ----------
function picker() {
  const fams = M.families();
  if (S.family == null && fams[0]) S.family = fams[0].familyGroupItemId;
  const list = h('ul', { class: 'items' });
  const fill = () => {
    const q = S.search.toLowerCase();
    const items = M.items().filter((i) => (q ? tx(i.name).toLowerCase().includes(q) : !fams.length || i.familyGroupRef === S.family));
    list.replaceChildren(...items.map((i) => {
      const combo = M.comboFor(i.menuItemId);
      const price = combo ? 'meal' : money(priceOf(M.defs(i)[0]?.prices));
      return h('li', {}, h('button', { onclick: () => openConfig(i.menuItemId) },
        h('span', {}, tx(i.name), i.mockUnavailable ? h('span', { class: 'muted' }, ' (unavailable in mock)') : null), h('span', { class: 'price' }, price)));
    }));
    if (!items.length) list.replaceChildren(h('li', { class: 'muted' }, 'No items.'));
  };
  fill();
  return h('div', {},
    h('h3', {}, 'Menu'),
    h('input', { type: 'search', placeholder: 'Search all items…', value: S.search, 'aria-label': 'Search menu items', oninput: (e) => { S.search = e.target.value; fill(); } }),
    fams.length ? h('div', { class: 'picker-tabs', style: 'margin-top:6px' }, fams.map((f) => h('button', { class: 'chip', 'aria-pressed': f.familyGroupItemId === S.family && !S.search, onclick: () => { S.family = f.familyGroupItemId; S.search = ''; render(); } }, tx(f.name)))) : null,
    list);
}

function newLine(menuItemId) {
  const item = M.item(menuItemId);
  return { menuItemId, definitionSequence: M.defNo(M.defs(item)[0]), quantity: 1, condiments: [] };
}
function openConfig(menuItemId) {
  const combo = M.comboFor(menuItemId);
  if (combo) {
    const main = combo.comboGroups.find((g) => g.isMainGroup) ?? combo.comboGroups[0];
    S.cfg = { kind: 'combo', combo, quantity: 1, main: null, mainGroupId: main.comboGroupId, sides: {} };
    for (const g of combo.comboGroups) if (g !== main) S.cfg.sides[g.comboGroupId] = Array.from({ length: g.count ?? 1 }, () => null);
  } else {
    S.cfg = { kind: 'item', line: newLine(menuItemId) };
  }
  render();
}

// Problems that stop a line being added (condiment min/max).
function lineProblems(line) {
  const def = M.def(M.item(line.menuItemId), line.definitionSequence);
  const out = [];
  for (const r of M.rules(def)) {
    const g = M.group(r.condimentGroupRef);
    const n = line.condiments.filter((c) => g?.condimentItemRefs?.includes(c.condimentId) && !(c.prefixes ?? []).some((p) => M.prefix(p.prefixId)?.prefixType === 'no')).reduce((a, c) => a + (c.quantity ?? 1), 0);
    if (r.minimumCount && n < r.minimumCount) out.push(`${tx(g?.name)}: choose at least ${r.minimumCount}`);
    if (r.maximumCount && n > r.maximumCount) out.push(`${tx(g?.name)}: at most ${r.maximumCount}`);
  }
  return out;
}

function lineEditor(line, { showQty = true, onChange = render } = {}) {
  const item = M.item(line.menuItemId);
  const defs = M.defs(item);
  const def = M.def(item, line.definitionSequence);
  const parts = [];
  const top = h('div', { class: 'row' });
  if (defs.length > 1) {
    top.append(h('label', {}, 'Size / definition', h('select', { onchange: (e) => { line.definitionSequence = Number(e.target.value); line.condiments = []; onChange(); } },
      defs.map((d) => h('option', { value: M.defNo(d), selected: M.defNo(d) === line.definitionSequence }, `${tx(d.name) || `Definition ${M.defNo(d)}`}  ${money(priceOf(d.prices))}`)))));
  }
  if (showQty) top.append(field('Quantity', line.quantity, (v) => { line.quantity = Math.max(1, parseInt(v, 10) || 1); }, { type: 'number', min: 1, step: 1, style: 'width:80px' }));
  if (top.childNodes.length) parts.push(top);

  for (const r of M.rules(def)) {
    const g = M.group(r.condimentGroupRef);
    if (!g) continue;
    const single = r.maximumCount === 1;
    const sel = (cid) => line.condiments.find((c) => c.condimentId === cid);
    const rule = r.minimumCount && r.minimumCount === r.maximumCount ? `choose ${r.minimumCount}` : r.maximumCount ? `${r.minimumCount ? `${r.minimumCount} to ` : 'up to '}${r.maximumCount}` : r.minimumCount ? `at least ${r.minimumCount}` : 'optional';
    const bad = lineProblems(line).some((p) => p.startsWith(`${tx(g.name)}:`));
    const name = `g${line.menuItemId}-${g.condimentGroupId}-${Math.random().toString(36).slice(2, 8)}`;
    parts.push(h('fieldset', {}, h('legend', {}, `${tx(g.name)} (${rule})`, bad ? h('span', { class: 'bad' }, '  needs attention') : null),
      h('div', { class: 'conds' }, (g.condimentItemRefs ?? []).map((cid) => {
        const ci = M.cond(cid);
        if (!ci) return null;
        const chosen = sel(cid);
        return h('div', { class: 'cond' },
          h('label', { class: 'check' },
            h('input', {
              type: single ? 'radio' : 'checkbox', name, checked: !!chosen,
              onchange: (e) => {
                if (single) line.condiments = line.condiments.filter((c) => !g.condimentItemRefs.includes(c.condimentId));
                if (e.target.checked) line.condiments.push({ condimentId: cid, definitionSequence: M.defNo(ci.definitions?.[0]), quantity: 1 });
                else line.condiments = line.condiments.filter((c) => c.condimentId !== cid);
                onChange();
              },
            }),
            tx(ci.name ?? ci.definitions?.[0]?.name2), h('span', { class: 'price' }, priceOf(ci.definitions?.[0]?.prices) ? ` +${money(priceOf(ci.definitions[0].prices))}` : '')),
          chosen && M.condAllowsPrefix(ci) && M.prefixes().length
            ? h('select', { 'aria-label': `Prefix for ${tx(ci.name)}`, onchange: (e) => { if (e.target.value) chosen.prefixes = [{ prefixId: Number(e.target.value) }]; else delete chosen.prefixes; onChange(); } },
              h('option', { value: '' }, 'no prefix'), M.prefixes().map((p) => h('option', { value: p.prefixId, selected: chosen.prefixes?.[0]?.prefixId === p.prefixId }, tx(p.name))))
            : null);
      }))));
  }
  return parts;
}

function configurator() {
  const cfg = S.cfg;
  const close = h('button', { class: 'btn small', onclick: () => { S.cfg = null; render(); } }, 'Cancel');
  if (cfg.kind === 'item') {
    const problems = lineProblems(cfg.line);
    return h('div', { class: 'config' }, h('h3', {}, M.name(cfg.line.menuItemId)), lineEditor(cfg.line),
      problems.length ? h('div', { class: 'hint err' }, problems.join('. ')) : null,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', disabled: problems.length > 0, onclick: () => { S.basket.menuItems.push(clean(cfg.line)); S.cfg = null; render(); } }, 'Add to basket'), close));
  }
  const { combo } = cfg;
  const groups = combo.comboGroups;
  const blocks = [];
  const problems = [];
  for (const g of groups) {
    const isMain = g.comboGroupId === cfg.mainGroupId;
    const slots = isMain ? [cfg.main] : cfg.sides[g.comboGroupId];
    slots.forEach((line, k) => {
      const setLine = (id) => {
        const nl = id ? newLine(Number(id)) : null;
        if (isMain) cfg.main = nl; else cfg.sides[g.comboGroupId][k] = nl;
        render();
      };
      blocks.push(h('fieldset', {}, h('legend', {}, `${tx(g.name)}${isMain ? ' (main)' : ''}${slots.length > 1 ? ` ${k + 1}` : ''}`),
        h('select', { onchange: (e) => setLine(e.target.value) }, h('option', { value: '' }, 'Choose…'),
          (g.menuItems ?? []).map((mi) => h('option', { value: mi.menuItemRef, selected: line?.menuItemId === mi.menuItemRef }, `${M.name(mi.menuItemRef)}  ${money(priceOf(mi.prices))}`))),
        line ? lineEditor(line, { showQty: false }) : null));
      if (!line) problems.push(`Choose ${tx(g.name)}`);
      else problems.push(...lineProblems(line).map((p) => `${M.name(line.menuItemId)}: ${p}`));
    });
  }
  const add = () => {
    S.basket.comboMeals.push({
      comboMealId: combo.comboMealId,
      comboItem: { menuItemId: combo.menuItemRef, quantity: cfg.quantity },
      mainItem: clean(cfg.main, true),
      sideItems: Object.values(cfg.sides).flat().map((l) => clean(l, true)),
    });
    S.cfg = null; render();
  };
  return h('div', { class: 'config' }, h('h3', {}, tx(combo.name)),
    field('Quantity', cfg.quantity, (v) => { cfg.quantity = Math.max(1, parseInt(v, 10) || 1); }, { type: 'number', min: 1, step: 1, style: 'width:80px' }),
    blocks,
    problems.length ? h('div', { class: 'hint err' }, problems.join('. ')) : null,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', disabled: problems.length > 0, onclick: add }, 'Add meal to basket'), close));
}

// API-shaped copy of a line: drop empty arrays, and quantity for combo components.
function clean(line, component = false) {
  const out = { menuItemId: line.menuItemId, definitionSequence: line.definitionSequence };
  if (!component) out.quantity = line.quantity ?? 1;
  if (line.condiments?.length) out.condiments = line.condiments.map((c) => ({ ...c }));
  return out;
}

function describeLine(l) {
  const def = M.def(M.item(l.menuItemId), l.definitionSequence);
  const name = tx(def?.name) || M.name(l.menuItemId);
  const conds = (l.condiments ?? []).map((c) => `${(c.prefixes ?? []).map((p) => tx(M.prefix(p.prefixId)?.name) + ' ').join('')}${tx(M.cond(c.condimentId)?.name) || c.condimentId}`);
  return conds.length ? `${name} (${conds.join(', ')})` : name;
}

function basketView() {
  const b = S.basket;
  const qtyCtl = (get, set, remove) => h('span', { class: 'qty' },
    h('button', { class: 'btn small', 'aria-label': 'Decrease', onclick: () => { get() > 1 ? set(get() - 1) : remove(); render(); } }, '-'),
    h('span', {}, get()),
    h('button', { class: 'btn small', 'aria-label': 'Increase', onclick: () => { set(get() + 1); render(); } }, '+'),
    h('button', { class: 'btn small', 'aria-label': 'Remove', onclick: () => { remove(); render(); } }, 'x'));
  const lines = [
    ...b.menuItems.map((l, i) => h('li', {}, h('div', { class: 'desc' }, describeLine(l)),
      qtyCtl(() => l.quantity ?? 1, (q) => { l.quantity = q; }, () => b.menuItems.splice(i, 1)))),
    ...b.comboMeals.map((c, i) => h('li', {}, h('div', { class: 'desc' }, M.name(c.comboItem.menuItemId),
      h('div', { class: 'sub' }, [c.mainItem, ...(c.sideItems ?? [])].map(describeLine).join(' + '))),
      qtyCtl(() => c.comboItem.quantity ?? 1, (q) => { c.comboItem.quantity = q; }, () => b.comboMeals.splice(i, 1)))),
  ];
  const d = S.data;
  let openAmount = '';
  return h('div', {},
    h('h3', {}, 'Basket'),
    lines.length ? h('ul', { class: 'basket' }, lines) : h('p', { class: 'muted' }, 'Empty. Pick items from the menu.'),
    d.discounts.length ? h('fieldset', { style: 'margin-top:8px' }, h('legend', {}, 'Discounts'),
      b.discounts.map((x, i) => h('div', { class: 'cond' }, `${tx(d.discounts.find((y) => y.discountId === x.discountId)?.name) || x.discountId}${x.total ? ` ${money(x.total)}` : ''}`,
        h('button', { class: 'btn small', onclick: () => { b.discounts.splice(i, 1); render(); } }, 'x'))),
      h('div', { class: 'row' },
        h('select', { id: 'disc-pick', 'aria-label': 'Discount' }, d.discounts.map((x) => h('option', { value: x.discountId }, tx(x.name)))),
        h('input', { type: 'number', step: '0.01', min: 0, placeholder: 'Amount (open only)', style: 'width:150px', oninput: (e) => { openAmount = e.target.value; } }),
        h('button', { class: 'btn small', onclick: () => { const id = num($('#disc-pick').value); b.discounts.push(openAmount ? { discountId: id, total: Number(openAmount) } : { discountId: id }); render(); } }, 'Add'))) : null,
    d.serviceCharges.length ? h('fieldset', { style: 'margin-top:8px' }, h('legend', {}, 'Service charges'),
      d.serviceCharges.map((s) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: b.serviceCharges.some((x) => x.serviceChargeId === s.serviceChargeId),
        onchange: (e) => { b.serviceCharges = e.target.checked ? [...b.serviceCharges, { serviceChargeId: s.serviceChargeId }] : b.serviceCharges.filter((x) => x.serviceChargeId !== s.serviceChargeId); renderLight(); } }), tx(s.name)))) : null,
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'btn primary', disabled: !checkReady(), onclick: () => goStep('calc') }, 'Calculate →'),
      h('button', { class: 'btn small', disabled: !lines.length, onclick: () => { clearBasket(); render(); } }, 'Clear basket')),
    !checkReady() && lines.length ? h('p', { class: 'hint err' }, 'Set the employee and order type refs on the Context step before calculating.') : null);
}

// ---------- modal, toast, curl ----------
function confirmModal(title, body) {
  return new Promise((resolve) => {
    $('#modal-title').textContent = title;
    $('#modal-body').textContent = body;
    $('#modal').hidden = false;
    $('#modal-ok').focus();
    const done = (v) => { $('#modal').hidden = true; $('#modal-ok').onclick = $('#modal-cancel').onclick = null; resolve(v); };
    $('#modal-ok').onclick = () => done(true);
    $('#modal-cancel').onclick = () => done(false);
  });
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}
function curl(spec) {
  const base = S.mode === 'mock' ? `${location.origin}/mock` : S.config?.live?.apiHost ?? '$STS_API_HOST';
  const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
  const parts = [`curl -i ${spec.method === 'HEAD' ? '-I' : `-X ${spec.method}`} ${q(base + fullPath(spec))}`,
    `-H ${q(`Authorization: Bearer ${S.mode === 'mock' ? 'mock-token' : '$STS_ID_TOKEN'}`)}`.replace(/'\$STS_ID_TOKEN'/, '"$STS_ID_TOKEN"'),
    ...Object.entries(spec.headers ?? {}).map(([k, v]) => `-H ${q(`${k}: ${v}`)}`)];
  if (spec.body != null) parts.push(`-H 'Content-Type: application/json'`, `--data-raw ${q(JSON.stringify(spec.body))}`);
  return parts.join(' \\\n  ');
}
async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied.`); } catch { toast('Clipboard unavailable in this browser.'); }
}

// ---------- top-level render ----------
function render() { renderCtxBar(); renderSteps(); renderRequest(); renderResponse(); renderHistory(); }
function renderLight() { renderCtxBar(); renderSteps(); const k = curKey(); $('#req-path').textContent = CALLS[k].special || CALLS[k].noSend ? CALLS[k].path() : fullPath(currentSpec(k)); renderSendButton(); }

// ---------- wiring ----------
function wire() {
  $('#mode-mock').onclick = () => switchMode('mock');
  $('#mode-live').onclick = () => switchMode('live');
  $('#reauth').onclick = () => reauthAndOffer();
  $('#theme').onclick = () => {
    const cur = document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next; store.set('sts.theme', next);
  };
  $('#send').onclick = () => { if (S.sending) S.sending.ac.abort(); else sendSpec(currentSpec()); };
  for (const t of $$('.req .tab')) t.onclick = () => { S.reqTab = t.dataset.tab; renderRequest(); };
  for (const t of $$('.res .tab')) t.onclick = () => { S.resTab = t.dataset.rtab; renderResponse(); };
  $('#raw').oninput = (e) => {
    const key = curKey(); const c = CALLS[key];
    if (!c.setBody) return;
    try { c.setBody(JSON.parse(e.target.value)); delete S.rawInvalid[key]; } catch (err) { S.rawInvalid[key] = err; }
    $('#raw-status').textContent = S.rawInvalid[key] ? `Invalid JSON: ${S.rawInvalid[key].message}` : 'Applied to the builder.';
    $('#raw-status').className = S.rawInvalid[key] ? 'hint err' : 'hint';
    renderLight();
  };
  $('#hdrs').oninput = (e) => { S.hdrEdits[curKey()] = e.target.value; renderLight(); };
  $('#curl').onclick = () => copy(curl(S.viewing ? S.viewing.req : currentSpec()), 'curl command');
  $('#copy-res').onclick = () => copy($('#res-body').textContent, 'Response');
  $('#reset').onclick = () => { const k = curKey(); delete S.hdrEdits[k]; delete S.rawInvalid[k]; S.viewing = null; render(); toast('Header and raw edits for this step cleared.'); };
  $('#hist-clear').onclick = () => { S.history = []; store.set('sts.history', []); renderHistory(); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').hidden) $('#modal-cancel').click();
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') $('#send').click();
  });
  setInterval(refreshAuth, 30_000);
}

async function switchMode(mode) {
  if (mode === S.mode) return;
  S.mode = mode;
  resetWorkspace();
  S.step = 'auth'; S.curCall = {}; S.viewing = null;
  S.notice = mode === 'live' ? 'Switched to LIVE. Requests go to the configured test/UAT enterprise.' : '';
  await refreshAuth();
  render();
}

async function init() {
  const theme = store.get('sts.theme', null);
  if (theme) document.documentElement.dataset.theme = theme;
  try { S.config = await api('/config'); } catch { S.config = { live: { configured: false, missing: ['(server unreachable)'] }, defaults: {} }; }
  resetWorkspace();
  wire();
  await refreshAuth();
  render();
}
init();
