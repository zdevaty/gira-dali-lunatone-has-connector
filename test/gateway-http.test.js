import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GATEWAY_REQUESTS, classifyGatewayRequest, assertSafeGatewayBody, createGatewayHttp,
} from '../lib/gateway-http.js';
import { loadSchema, findOperation } from './helpers/openapi.js';

// The table is the whole of what the bridge may ask of the gateway. A change
// to it should have to change this test too, and say why.
test('the bridge may make exactly these requests, and each is what it says it is', () => {
  const table = GATEWAY_REQUESTS.map(([m, re, kind]) => `${kind} ${m} ${re.source.replace(/\\\//g, '/')}`);
  assert.deepEqual(table, [
    'read GET ^/info$',
    'read GET ^/devices$',
    'read GET ^/device/\\d+$',
    'read GET ^/device/\\d+/scenes$',
    'read GET ^/dali/scan$',
    'read GET ^/dali/readStatus/\\d+$',
    'read GET ^/datetime$',
    'read GET ^/datetime/timezones$',
    'read GET ^/location$',
    'read GET ^/settings$',
    'read GET ^/zones$',
    'read GET ^/sensors$',
    'read GET ^/automations/statusQueries$',
    'read GET ^/automations/schedules$',
    'read GET ^/automations/circadians$',
    'read GET ^/automations/sequences$',
    'read GET ^/automations/triggerActions$',
    'read GET ^/automations/eventTriggerActions$',
    'bus POST ^/dali/scan$',
    'bus POST ^/dali/scan/cancel$',
    'bus PUT ^/device/\\d+$',
    'bus POST ^/device/\\d+/control$',
    'bus GET ^/device/\\d+/energyReporting$',
    'bus GET ^/device/\\d+/diagnosticsMaintenance$',
    'bus POST ^/device/\\d+/scenes$',
    'bus POST ^/sensors$',
    'config PUT ^/automations/statusQueries/\\d+$',
    'config POST ^/automations/statusQueries/\\d+$',
    'config POST ^/datetime$',
    'config POST ^/location$',
    'config POST ^/zone$',
    'config PUT ^/zone/\\d+$',
  ]);
});

test('every allowed request exists in the gateway\'s own API, so none is a typo', () => {
  const spec = loadSchema();
  for (const [method, re] of GATEWAY_REQUESTS) {
    const sample = re.source.slice(1, -1).replace(/\\\//g, '/').replace(/\\d\+/g, '7');
    assert.ok(findOperation(spec, method, sample), `${method} ${sample} is not in the OpenAPI schema`);
  }
});

test('nothing that deletes, resets, reboots, sends raw frames or controls groups is allowed', () => {
  const dangerous = [
    ['DELETE', '/devices'], ['DELETE', '/device/1'], ['DELETE', '/reset'], ['POST', '/reboot'],
    ['POST', '/dali/sendDali16/0'], ['POST', '/dali/sendDali24/0'],
    ['POST', '/group/1/control'], ['POST', '/broadcast/control'], ['POST', '/zone/1/control'],
    ['PUT', '/settings'], ['PUT', '/info'], ['POST', '/ethernet'], ['DELETE', '/zones'], ['DELETE', '/zone/1'],
    ['DELETE', '/sensors'], ['POST', '/automations/scheduler'], ['PUT', '/automations/scheduler/1'],
    ['POST', '/automations/sequence/1/start'], ['DELETE', '/automations/statusQueries/0'], ['POST', '/location/detect'],
    ['GET', '/device/1/control'], ['POST', '/device/1/control/extra'], ['POST', '/device/x/control'],
  ];
  for (const [m, p] of dangerous) assert.equal(classifyGatewayRequest(m, p), null, `${m} ${p}`);
});

test('identify can carry a level or on/off, and nothing that outlives the blink', () => {
  const ok = (body) => assert.doesNotThrow(() => assertSafeGatewayBody('POST', '/device/3/control', body), JSON.stringify(body));
  const no = (body) => assert.throws(() => assertSafeGatewayBody('POST', '/device/3/control', body), undefined, JSON.stringify(body));
  ok({ dimmable: 100 });
  ok({ dimmable: 0 });
  ok({ switchable: false });
  no({ saveToScene: 1 });
  no({ fadeTime: 0 });
  no({ fadeRate: 1 });
  no({ dimmable: 50, fadeTime: 0 });
  no({ dimmableWithFade: { dimValue: 50, fadeTime: 0 } });
  no({ colorKelvin: 3000 });
  no({ scene: 1 });
  no({ dimmable: 101 });
  no({ dimmable: '50' });
  no({ switchable: 1 });
  no({ dimmable: 10, switchable: true });
  no({});
  no(undefined);
});

test('zones may only list devices: a broadcast zone would reach the whole bus', () => {
  assert.doesNotThrow(() => assertSafeGatewayBody('POST', '/zone', { name: 'Kitchen', targets: [{ type: 'device', id: 1 }] }));
  assert.throws(() => assertSafeGatewayBody('POST', '/zone', { name: 'All', targets: [{ type: 'broadcast', id: 0 }] }));
  assert.throws(() => assertSafeGatewayBody('POST', '/zone', { name: 'G', targets: [{ type: 'group', id: 1 }] }));
  assert.throws(() => assertSafeGatewayBody('PUT', '/zone/2', { name: 'K', targets: [{ type: 'device', id: 1, extra: 1 }] }));
  assert.throws(() => assertSafeGatewayBody('POST', '/zone', { name: '', targets: [] }));
  assert.throws(() => assertSafeGatewayBody('POST', '/zone', { name: 'K', targets: [], features: {} }));
});

test('settings bodies are checked before they leave', () => {
  assert.doesNotThrow(() => assertSafeGatewayBody('PUT', '/automations/statusQueries/0', { delayBetweenQueries: 30, queryStatus: true, queryActualLevel: false }));
  assert.throws(() => assertSafeGatewayBody('PUT', '/automations/statusQueries/0', { delayBetweenQueries: 0.1, queryStatus: true, queryActualLevel: true }));
  assert.throws(() => assertSafeGatewayBody('PUT', '/automations/statusQueries/0', { delayBetweenQueries: 30 }));
  assert.throws(() => assertSafeGatewayBody('POST', '/datetime', {}));
  assert.throws(() => assertSafeGatewayBody('POST', '/datetime', { timezone: 'UTC', ntpServer: 'x' }));
  assert.throws(() => assertSafeGatewayBody('POST', '/location', { lat: 91, lon: 0 }));
  assert.throws(() => assertSafeGatewayBody('GET', '/devices', {}), 'a read carries no body');
  assert.throws(() => assertSafeGatewayBody('POST', '/sensors', { line: 0 }));
});

test('a refused request never reaches the network', async () => {
  let fetched = 0;
  const http = createGatewayHttp({ host: 'gw', fetchImpl: async () => { fetched += 1; return { ok: true, status: 200, json: async () => ({}) }; } });
  await assert.rejects(() => http.request('DELETE', '/devices'), /not something the bridge may ask/);
  await assert.rejects(() => http.request('POST', '/device/1/control', { saveToScene: 3 }), /unexpected fields/);
  assert.equal(fetched, 0);
  const r = await http.get('/devices');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'read');
  assert.equal(fetched, 1);
});

test('gateway failures are answers, not throws', async () => {
  const down = createGatewayHttp({ host: 'gw', fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'EHOSTUNREACH' } }); } });
  assert.deepEqual(await down.get('/info'), { ok: false, kind: 'read', status: null, error: 'gateway unreachable: EHOSTUNREACH' });
  const refusing = createGatewayHttp({ host: 'gw', fetchImpl: async () => ({ ok: false, status: 422, json: async () => ({ detail: [{ msg: 'bad' }] }) }) });
  const r = await refusing.request('POST', '/location', { lat: 1, lon: 2 });
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 422/);
});
