import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayConfig, validatePolling, matchLights, planZones, AREA_LIGHTS_TEMPLATE } from '../lib/gateway-config.js';
import { createGatewayReader } from '../lib/gateway-read.js';
import { createFakeGateway } from './helpers/fake-gateway.js';

const DEVICES = [
  { id: 1, name: 'Kitchen ceiling', type: 'dimmable', line: 0, address: 0, available: true, groups: [], daliTypes: [6], status: {}, features: {} },
  { id: 2, name: 'Line 0 DALI 01', type: 'dimmable', line: 0, address: 1, available: true, groups: [], daliTypes: [6], status: {}, features: {} },
  { id: 3, name: 'Hall', type: 'dimmable', line: 0, address: 2, available: true, groups: [], daliTypes: [6], status: {}, features: {} },
  { id: 4, name: 'Hall', type: 'dimmable', line: 0, address: 3, available: true, groups: [], daliTypes: [6], status: {}, features: {} },
];

async function setup({ areaLights = [], haConfig = { time_zone: 'Europe/Prague', latitude: 50.08751, longitude: 14.42134 }, deviceMap = {} } = {}) {
  const gw = createFakeGateway();
  const port = await gw.listen();
  gw.setDevices(structuredClone(DEVICES));
  const logs = [];
  const changed = [];
  const host = `127.0.0.1:${port}`;
  const reader = createGatewayReader({ host, cacheMs: 0 });
  const ha = {
    getConfig: async () => haConfig,
    renderTemplate: async () => ({ ok: true, text: JSON.stringify(areaLights) }),
  };
  const config = createGatewayConfig({ host, reader, ha, deviceMap: () => deviceMap, log: (e) => logs.push(e), onChanged: (a) => changed.push(a) });
  const writes = () => gw.adminRequests.filter((r) => r.method !== 'GET').map((r) => [r.method, r.path, r.body]);
  return { gw, config, logs, changed, writes, close: () => gw.close() };
}

// ── Polling ─────────────────────────────────────────────────────────────────

test('polling settings are validated in words before anything is sent', () => {
  assert.equal(validatePolling({ delayBetweenQueries: 30, queryStatus: true, queryActualLevel: false }).ok, true);
  assert.deepEqual(validatePolling({ delayBetweenQueries: '12.34', queryStatus: true, queryActualLevel: true }).value.delayBetweenQueries, 12.3);
  assert.match(validatePolling({ delayBetweenQueries: 0.2, queryStatus: true, queryActualLevel: true }).problems[0], /0\.5 and 3600/);
  assert.match(validatePolling({ delayBetweenQueries: 10, queryStatus: 'yes', queryActualLevel: true }).problems[0], /status/);
  assert.match(validatePolling({ delayBetweenQueries: 10, queryStatus: true, queryActualLevel: true, line: 2 }).problems[0], /line/);
});

test('an existing line is updated with PUT, a new one created with POST', async (t) => {
  const h = await setup();
  t.after(h.close);
  assert.equal((await h.config.setPolling(0, { delayBetweenQueries: 60, queryStatus: true, queryActualLevel: false })).ok, true);
  assert.equal((await h.config.setPolling(1, { delayBetweenQueries: 30, queryStatus: true, queryActualLevel: true })).ok, true);
  assert.deepEqual(h.writes(), [
    ['PUT', '/automations/statusQueries/0', { delayBetweenQueries: 60, queryStatus: true, queryActualLevel: false }],
    ['POST', '/automations/statusQueries/1', { delayBetweenQueries: 30, queryStatus: true, queryActualLevel: true }],
  ]);
  const logged = h.logs.filter((e) => e.kind === 'gateway_write');
  assert.equal(logged.length, 2);
  assert.equal(logged[0].effect, 'config');
  assert.deepEqual(h.changed, ['status_polling', 'status_polling']);
});

// ── Clock and location ──────────────────────────────────────────────────────

test('the clock is set in the zone and format the gateway itself uses, with network time off', async (t) => {
  const h = await setup();
  t.after(h.close);
  h.gw.state.datetimeLive = false;
  // The real gateway's shape, and a clock seven years behind.
  h.gw.state.datetime = { timezone: 'Europe/Prague', automatic_time: true, date: '14. February 2019', time: '13:05:08' };
  const r = await h.config.setClock({ set_now: true });
  assert.equal(r.ok, true);
  const [[, path, body]] = h.writes();
  assert.equal(path, '/datetime');
  assert.match(body.date, /^\d{1,2}\. [A-Z][a-z]+ \d{4}$/);
  assert.match(body.time, /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(body.automatic_time, false);
  assert.deepEqual(Object.keys(body).sort(), ['automatic_time', 'date', 'time']);
});

test('a clock in a format nobody recognised is not set from here', async (t) => {
  const h = await setup();
  t.after(h.close);
  h.gw.state.datetimeLive = false;
  h.gw.state.datetime = { timezone: 'Europe/Prague', automatic_time: true, date: 'Wed Sep 16', time: '7pm' };
  const r = await h.config.setClock({ set_now: true });
  assert.equal(r.code, 409);
  assert.deepEqual(h.writes(), []);
});

test('a time zone must be real and known to the gateway', async (t) => {
  const h = await setup();
  t.after(h.close);
  assert.equal((await h.config.setClock({ timezone: 'Mars/Olympus' })).code, 400);
  assert.equal((await h.config.setClock({ timezone: 'America/New_York' })).code, 400, 'real, but not in the gateway list');
  assert.equal((await h.config.setClock({ timezone: 'Europe/London' })).ok, true);
  assert.equal((await h.config.setClock({ ntp: 'pool.ntp.org' })).code, 400);
  assert.deepEqual(h.writes(), [['POST', '/datetime', { timezone: 'Europe/London' }]]);
});

test('the location comes from Home Assistant, rounded to about a kilometre', async (t) => {
  const h = await setup();
  t.after(h.close);
  assert.equal((await h.config.setLocationFromHa()).ok, true);
  assert.deepEqual(h.writes(), [['POST', '/location', { lat: 50.09, lon: 14.42 }]]);
});

// ── Zones from areas ────────────────────────────────────────────────────────

test('the template asks for lights by the area they are really in', () => {
  assert.match(AREA_LIGHTS_TEMPLATE, /area_id\(e\) == area/);
  assert.match(AREA_LIGHTS_TEMPLATE, /select\('match', 'light\\\\\.'\)/);
});

test('lights are matched to gateway devices by map, identifier, or a unique name -- and never guessed', () => {
  const rows = [
    { area_id: 'kitchen', area: 'Kitchen', entity_id: 'light.kitchen', device_name: 'Something else', identifiers: [] },
    { area_id: 'kitchen', area: 'Kitchen', entity_id: 'light.spot', device_name: 'Spot', identifiers: ['lunatone|abc-device2'] },
    { area_id: 'hall', area: 'Hall', entity_id: 'light.hall', device_name: 'Hall', identifiers: [] },
    { area_id: 'hall', area: 'Hall', entity_id: 'light.other', device_name: 'Kitchen ceiling', identifiers: ['hue|device1'] },
    { area_id: 'bath', area: 'Bath', entity_id: 'light.bath', device_name: null, identifiers: [] },
  ];
  const map = { 7: { entity: 'light.kitchen', gear: 'short0' } };
  const m = matchLights(rows, { devices: DEVICES, deviceMap: map });
  assert.deepEqual(m.map((r) => [r.entity_id, r.device?.id ?? null, r.how]), [
    ['light.kitchen', 1, 'map'],
    ['light.spot', 2, 'identifier'],
    ['light.hall', null, 'name is not unique'],
    ['light.other', 1, 'name'],
    ['light.bath', null, 'no match'],
  ]);
});

test('the plan creates missing zones, updates changed ones, and leaves the rest alone', () => {
  const matched = [
    { area_id: 'k', area: 'Kitchen', entity_id: 'light.a', device: DEVICES[0], how: 'map' },
    { area_id: 'k', area: 'Kitchen', entity_id: 'light.b', device: DEVICES[1], how: 'name' },
    { area_id: 'h', area: 'Hall', entity_id: 'light.c', device: DEVICES[2], how: 'name' },
    { area_id: 'l', area: 'Living', entity_id: 'light.d', device: DEVICES[3], how: 'name' },
    { area_id: 'b', area: 'Bath', entity_id: 'light.e', device: null, how: 'no match' },
  ];
  const zones = [
    { id: 10, name: 'Kitchen', targets: [{ type: 'device', id: 2 }, { type: 'device', id: 1 }] },
    { id: 11, name: 'Hall', targets: [{ type: 'device', id: 4 }] },
    { id: 12, name: 'Living', targets: [{ type: 'device', id: 4 }, { type: 'group', id: 3 }] },
    { id: 13, name: 'Garden', targets: [] },
  ];
  const plan = planZones({ matched, zones });
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.update, [{ id: 11, before: [4], name: 'Hall', targets: [{ type: 'device', id: 3 }] }]);
  assert.deepEqual(plan.unchanged.map((u) => [u.name, u.reason]), [
    ['Kitchen', 'already matches'],
    ['Living', 'the zone also names groups or broadcasts, set up elsewhere; left alone'],
  ]);
  assert.deepEqual(plan.unmatched.map((u) => u.entity_id), ['light.e']);
  assert.deepEqual(plan.untouched, [{ id: 13, name: 'Garden' }]);

  const fresh = planZones({ matched, zones: [] });
  assert.deepEqual(fresh.create.map((z) => z.name), ['Kitchen', 'Hall', 'Living']);
  assert.notEqual(fresh.id, plan.id);
});

test('zones are applied only if the plan is still the one that was shown', async (t) => {
  const areaLights = [
    { area_id: 'k', area: 'Kitchen', entity_id: 'light.kitchen_ceiling', device_name: 'Kitchen ceiling', identifiers: [] },
  ];
  const h = await setup({ areaLights });
  t.after(h.close);
  const preview = await h.config.zonePlan();
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.plan.create, [{ name: 'Kitchen', targets: [{ type: 'device', id: 1 }] }]);

  // Someone renames a device in the meantime: the plan the person saw is gone.
  h.gw.state.zones.push({ id: 50, name: 'Kitchen', targets: [{ type: 'device', id: 3 }], features: {} });
  const stale = await h.config.applyZones(preview.plan.id);
  assert.equal(stale.code, 409);
  assert.deepEqual(h.writes(), []);

  const again = await h.config.zonePlan();
  const applied = await h.config.applyZones(again.plan.id);
  assert.equal(applied.ok, true);
  assert.deepEqual(h.writes(), [['PUT', '/zone/50', { name: 'Kitchen', targets: [{ type: 'device', id: 1 }] }]]);
  const second = await h.config.zonePlan();
  assert.deepEqual([second.plan.create, second.plan.update], [[], []], 'applying twice changes nothing');
});

test('a Home Assistant that cannot render the template is an error, not an empty plan', async (t) => {
  const h = await setup();
  t.after(h.close);
  const reader = createGatewayReader({ host: 'unused' });
  const config = createGatewayConfig({ host: 'unused', reader, ha: { renderTemplate: async () => ({ ok: false, error: 'HTTP 403' }) } });
  const r = await config.zonePlan();
  assert.equal(r.ok, false);
  assert.match(r.error, /403/);
});
