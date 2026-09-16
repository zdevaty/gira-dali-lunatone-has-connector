import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema, findOperation, validate } from './helpers/openapi.js';
import { createFakeGateway } from './helpers/fake-gateway.js';
import { GATEWAY_REQUESTS, createGatewayHttp } from '../lib/gateway-http.js';
import { createGatewayAdmin } from '../lib/gateway-admin.js';
import { createGatewayConfig } from '../lib/gateway-config.js';
import { createGatewayReader } from '../lib/gateway-read.js';

// The fake gateway is what every other test believes the gateway to be, and
// the bodies the bridge builds are what the real one will receive. Both are
// checked here against the gateway's own OpenAPI schema (firmware 1.18.7), so
// neither can drift into a shape the gateway never had.
//
// Not a substitute for the hardware: the schema leaves `features` and scene
// values as untyped objects, and says nothing of formats inside strings.

const spec = loadSchema();

// A complete diagnostics answer: the schema requires every field.
const fullDiagnostics = () => Object.fromEntries(Object.entries(spec.components.schemas.DiagnosticsMaintenanceData.properties)
  .map(([k, v]) => [k, v.type === 'boolean' ? false : v.type === 'integer' ? 3600 : 230.5]));

async function populated() {
  const gw = createFakeGateway();
  const port = await gw.listen();
  gw.setDevices([
    { id: 1, name: 'Kitchen', type: 'dimmable', line: 0, address: 0, available: true, groups: [0], daliTypes: [6, 8],
      status: { raw: 4, controlGearFailure: false, lampFailure: false, lampOn: true, limitError: false, fadeRunning: false, resetState: false, isUnaddressed: false, powerCycleSeen: false },
      features: { switchable: { status: true }, dimmable: { status: 40 } }, timeSignature: { timestamp: 1, counter: 1 } },
  ]);
  Object.assign(gw.state, {
    zones: [{ id: 1, name: 'Hall', targets: [{ type: 'device', id: 1 }], features: {}, timeSignature: { timestamp: 1, counter: 1 } }],
    sensors: [{ id: 3, name: 'Hall lux', unit: 'lx', type: 'light', value: 120, timestamp: '2026-09-16T10:00:00Z', addressType: 'dali', daliSensorAddress: { line: 0, address: 5, instanceNumber: 0 } }],
    scenes: { 1: { 0: { dimmable: 50 } } },
    energy: { 1: { activeEnergyWattHours: 1200.5, activePowerWatt: 7.1 } },
    diagnostics: { 1: fullDiagnostics() },
    schedules: [{ id: 1, name: 'Morning', enabled: true, targets: [{ type: 'device', id: 1 }], recallMode: 'timeOfDay', recallTime: { hour: 7, minute: 0, second: 0 }, action: { type: 'features', data: { dimmable: 60 } } }],
    circadians: [{ id: 1, name: 'Day', enabled: true, targets: [{ type: 'zone', id: 1 }], longest: { day: 21, month: 6, steps: [{ hour: 8, dimmable: 80 }] }, shortest: { day: 21, month: 12, steps: [{ hour: 8, dimmable: 60 }] } }],
    sequences: [{ id: 1, active: false, name: 'Party', steps: [{ type: 'features', data: { targets: [{ type: 'device', id: 1 }], features: { dimmable: 10 } }, delay: 1 }], isMacro: false }],
    triggerActions: [{ id: 1, enabled: true, name: 'Mirror', sources: [{ type: 'd16gear', address: 3, line: 0 }], targets: [{ type: 'device', id: 1 }] }],
    eventTriggerActions: [{ id: 1, enabled: true, name: 'Forward', source_line: 0, target_lines: [1], filters: { instanceType: [3] } }],
  });
  return { gw, host: `127.0.0.1:${port}` };
}

test('every read the bridge makes gets an answer in the shape of the schema', async (t) => {
  const { gw, host } = await populated();
  t.after(() => gw.close());
  const http = createGatewayHttp({ host });
  for (const [method, re, kind] of GATEWAY_REQUESTS) {
    if (method !== 'GET') continue;
    const path = re.source.slice(1, -1).replace(/\\\//g, '/').replace(/\\d\+/g, kind === 'read' && /readStatus/.test(re.source) ? '0' : '1');
    const r = await http.get(path);
    assert.equal(r.ok, true, `${path}: ${r.error}`);
    const { op } = findOperation(spec, method, path);
    const schema = op.responses['200']?.content?.['application/json']?.schema;
    if (!schema) continue;
    assert.deepEqual(validate(spec, schema, r.data), [], `${method} ${path}`);
  }
});

test('every body the bridge sends fits the gateway\'s request schema', async (t) => {
  const { gw, host } = await populated();
  t.after(() => gw.close());
  const reader = createGatewayReader({ host, cacheMs: 0 });
  const admin = createGatewayAdmin({ host, blinkMs: 1, pollMs: 1 });
  const config = createGatewayConfig({
    host, reader,
    ha: {
      getConfig: async () => ({ time_zone: 'Europe/London', latitude: 50.1, longitude: 14.4 }),
      renderTemplate: async () => ({ ok: true, text: JSON.stringify([{ area_id: 'k', area: 'Kitchen', entity_id: 'light.kitchen', device_name: 'Kitchen ceiling', identifiers: [] }]) }),
    },
  });

  await admin.startScan('refresh');
  await admin.cancelScan();
  await admin.updateDevice(1, { name: 'Kitchen ceiling', groups: [0, 3] });
  await admin.identify(1);
  await config.setPolling(0, { delayBetweenQueries: 30, queryStatus: true, queryActualLevel: false });
  await config.setPolling(1, { delayBetweenQueries: 60, queryStatus: true, queryActualLevel: true });
  await config.setClock({ timezone: 'Europe/London' });
  await config.setClock({ set_now: true });
  await config.setLocationFromHa();
  const plan = await config.zonePlan();
  await config.applyZones(plan.plan.id);

  const sent = gw.adminRequests.filter((r) => r.body !== undefined);
  const paths = new Set(sent.map((r) => `${r.method} ${r.path.replace(/\d+/g, 'N')}`));
  for (const expected of ['POST /dali/scan', 'PUT /device/N', 'POST /device/N/control', 'PUT /automations/statusQueries/N',
    'POST /automations/statusQueries/N', 'POST /datetime', 'POST /location', 'POST /zone']) {
    assert.ok(paths.has(expected), `${expected} was exercised`);
  }
  for (const r of sent) {
    const { op } = findOperation(spec, r.method, r.path);
    const schema = op.requestBody?.content?.['application/json']?.schema;
    assert.ok(schema, `${r.method} ${r.path} takes a body`);
    assert.deepEqual(validate(spec, schema, r.body), [], `${r.method} ${r.path} ${JSON.stringify(r.body)}`);
  }
});

test('the validator itself catches a wrong shape', () => {
  const { op } = findOperation(spec, 'POST', '/location');
  const schema = op.requestBody.content['application/json'].schema;
  assert.deepEqual(validate(spec, schema, { lat: 1, lon: 2 }), []);
  assert.ok(validate(spec, schema, { lat: '1' }).length >= 2);
  const zones = findOperation(spec, 'GET', '/zones').op.responses['200'].content['application/json'].schema;
  assert.ok(validate(spec, zones, { zones: [{ id: 1, targets: [{ type: 'lamp', id: 1 }], features: {} }] }).some((p) => /not one of/.test(p)));
});
