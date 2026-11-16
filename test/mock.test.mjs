import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleMock, resetMock } from '../lib/mock.mjs';

const H = { 'Simphony-OrgShortName': 'demo', 'Simphony-LocRef': '1001', 'Simphony-RvcRef': '1' };
const Q = { orgShortName: 'demo', locRef: '1001', rvcRef: '1' };
const header = (extra = {}) => ({ orgShortName: 'demo', locRef: '1001', rvcRef: 1, idempotencyId: 'a'.repeat(32), checkEmployeeRef: 1001, orderTypeRef: 1, isTrainingCheck: true, ...extra });
const burger = { menuItemId: 101, definitionSequence: 1, quantity: 1, condiments: [{ condimentId: 502 }, { condimentId: 511, prefixes: [{ prefixId: 2 }] }] };
const meal = { comboMealId: 1, comboItem: { menuItemId: 401, quantity: 1 }, mainItem: { menuItemId: 101, condiments: [{ condimentId: 501 }] }, sideItems: [{ menuItemId: 201 }, { menuItemId: 301 }] };
const post = (body, headers = H) => handleMock({ method: 'POST', path: '/api/v1/checks', headers: { ...headers, 'Simphony-Features': 'detect-duplicate-request,enable-condiment-prefix' }, body });

beforeEach(() => resetMock());

test('collections need context query parameters', async () => {
  const r = await handleMock({ method: 'GET', path: '/api/v1/tenders/collection', query: {} });
  assert.equal(r.status, 400);
  assert.match(r.body.detail, /orgShortName/);
  const ok = await handleMock({ method: 'GET', path: '/api/v1/tenders/collection', query: Q });
  assert.equal(ok.body.items.length, 3);
});

test('calculator prices an item with condiments and a combo', async () => {
  const r = await handleMock({ method: 'POST', path: '/api/v1/checks/calculator', headers: H, body: { header: header(), menuItems: [burger], comboMeals: [meal] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // burger 9.50 + cheese 1.00 = 10.50; meal 9.50 + 2.00 + 1.50 = 13.00
  assert.equal(r.body.totals.subtotal, 23.5);
  assert.equal(r.body.totals.taxTotal, 2.35);
  assert.equal(r.body.totals.totalDue, 25.85);
});

test('condiment minimum is enforced', async () => {
  const r = await handleMock({ method: 'POST', path: '/api/v1/checks/calculator', headers: H, body: { header: header(), menuItems: [{ menuItemId: 101 }] } });
  assert.equal(r.status, 400);
  assert.equal(r.body.posDetails[0].code, 'condiment_minimum_not_met');
});

test('unavailable item returns menu_item_not_available', async () => {
  const r = await handleMock({ method: 'POST', path: '/api/v1/checks/calculator', headers: H, body: { header: header(), menuItems: [{ menuItemId: 202 }] } });
  assert.equal(r.body.posDetails[0].code, 'menu_item_not_available');
});

test('"No" prefix zeroes the price and does not count toward the maximum', async () => {
  const conds = [511, 512, 513, 514].map((id) => ({ condimentId: id, prefixes: id === 512 ? [{ prefixId: 1 }] : undefined }));
  const r = await handleMock({ method: 'POST', path: '/api/v1/checks/calculator', headers: H, body: { header: header(), menuItems: [{ menuItemId: 102, condiments: conds }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.totals.subtotal, 9.95); // 8.95 + cheese 1.00, bacon removed
});

test('post, duplicate detection, pay in full, closed', async () => {
  const body = { header: header(), menuItems: [burger] };
  const first = await post(body);
  assert.equal(first.status, 201);
  const ref = first.body.header.checkRef;
  const dup = await post(body);
  assert.equal(dup.body.header.checkRef, ref);
  assert.equal(dup.body.header.isCachedResponse, true);

  const card = await handleMock({ method: 'POST', path: `/api/v1/checks/${ref}/round`, headers: H, body: { tenders: [{ tenderId: 2, total: 100 }] } });
  assert.equal(card.body.posDetails[0].code, 'over_tender_not_allowed');

  const paid = await handleMock({ method: 'POST', path: `/api/v1/checks/${ref}/round`, headers: H, body: { tenders: [{ tenderId: 2, total: 0 }] } });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.totals.totalDue, 0);
  assert.equal(paid.body.header.status, 'closed');

  const again = await handleMock({ method: 'POST', path: `/api/v1/checks/${ref}/round`, headers: H, body: { tenders: [{ tenderId: 1 }] } });
  assert.equal(again.body.posDetails[0].code, 'check_closed');
});

test('header context must match Simphony-* headers', async () => {
  const r = await post({ header: header({ rvcRef: 2 }), menuItems: [burger] });
  assert.equal(r.status, 400);
  assert.match(r.body.detail, /do not match/);
});
