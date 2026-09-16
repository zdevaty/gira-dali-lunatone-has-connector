import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayAdmin, readLightState } from '../lib/gateway-admin.js';
import { createFakeGateway } from './helpers/fake-gateway.js';

// Identify, diagnostics and re-reads: the bus activities besides the scan.
// Against the fake gateway over real HTTP, so what is asserted is what would
// have gone over the wire.

async function setup({ devices, adminOptions = {} } = {}) {
  const gw = createFakeGateway();
  const port = await gw.listen();
  gw.setDevices(devices ?? [
    { id: 1, name: 'Kitchen', type: 'dimmable', line: 0, address: 2, available: true, groups: [], daliTypes: [6], status: {},
      features: { switchable: { status: true }, dimmable: { status: 42 } } },
    { id: 2, name: 'Off lamp', type: 'dimmable', line: 0, address: 3, available: true, groups: [], daliTypes: [6], status: {},
      features: { switchable: { status: false }, dimmable: { status: 0 } } },
    { id: 3, name: 'Relay', type: 'switchable', line: 0, address: 4, available: true, groups: [], daliTypes: [7], status: {}, features: {} },
  ]);
  const logs = [];
  let t = 0;
  const admin = createGatewayAdmin({
    host: `127.0.0.1:${port}`,
    log: (e) => logs.push(e),
    blinkMs: 1,
    now: () => t,
    ...adminOptions,
  });
  const controls = (id) => gw.adminRequests.filter((r) => r.path === `/device/${id}/control`).map((r) => r.body);
  return { gw, admin, logs, controls, advance: (ms) => { t += ms; }, close: () => gw.close() };
}

test('the light state is read only from what the gateway reports, never assumed', () => {
  assert.deepEqual(readLightState({ switchable: { status: true }, dimmable: { status: 42 } }), { on: true, level: 42 });
  assert.deepEqual(readLightState({ switchable: { status: false } }), { on: false, level: null });
  assert.deepEqual(readLightState({ dimmable: 30 }), { on: true, level: 30 });
  assert.equal(readLightState({ switchable: { status: true } }), null, 'on, at a level nobody told us');
  assert.equal(readLightState({}), null);
  assert.equal(readLightState(undefined), null);
  assert.equal(readLightState({ colorKelvin: { status: 3000 } }), null);
});

test('identify blinks three times and puts a lit light back at its level', async (t) => {
  const h = await setup();
  t.after(h.close);
  const r = await h.admin.identify(1);
  assert.equal(r.ok, true);
  assert.deepEqual(h.controls(1), [
    { dimmable: 100 }, { switchable: false },
    { dimmable: 100 }, { switchable: false },
    { dimmable: 100 }, { switchable: false },
    { dimmable: 42 },
  ]);
  const write = h.logs.find((e) => e.kind === 'gateway_write' && e.action === 'identify');
  assert.deepEqual(write.before, { on: true, level: 42 });
});

test('a light that was off is left off', async (t) => {
  const h = await setup();
  t.after(h.close);
  await h.admin.identify(2);
  assert.deepEqual(h.controls(2).at(-1), { switchable: false });
});

test('a light whose state cannot be read is not touched at all', async (t) => {
  const h = await setup();
  t.after(h.close);
  const r = await h.admin.identify(3);
  assert.equal(r.ok, false);
  assert.equal(r.code, 409);
  assert.match(r.error, /nothing was sent/);
  assert.deepEqual(h.controls(3), []);
});

test('a blink that fails half way still puts the light back, and says so if it cannot', async (t) => {
  const h = await setup();
  t.after(h.close);
  h.gw.state.controlFails = true;
  const r = await h.admin.identify(1);
  assert.equal(r.ok, false);
  // The first step failed; the restore was still attempted.
  assert.deepEqual(h.controls(1), [{ dimmable: 100 }, { dimmable: 42 }]);
  assert.ok(h.logs.some((e) => e.alert === 'identify_restore_failed'));
});

test('an unknown device is a 404 and sends nothing', async (t) => {
  const h = await setup();
  t.after(h.close);
  const r = await h.admin.identify(77);
  assert.equal(r.code, 404);
  assert.equal(h.gw.adminRequests.filter((q) => q.method !== 'GET').length, 0);
});

test('our own bus traffic is marked for a while after each activity, by its name', async (t) => {
  const h = await setup();
  t.after(h.close);
  assert.equal(h.admin.busy(), null);
  await h.admin.identify(1);
  assert.equal(h.admin.busy(), 'identify');
  h.advance(3001);
  assert.equal(h.admin.busy(), null);
});

test('one bus activity at a time: a second press while one runs is refused', async (t) => {
  const h = await setup({ adminOptions: { blinkMs: 30 } });
  t.after(h.close);
  const first = h.admin.identify(1);
  await new Promise((r) => setTimeout(r, 5));
  const second = await h.admin.readDiagnostics(1);
  assert.equal(second.code, 409);
  assert.match(second.error, /busy with this app's identify/);
  const scan = await h.admin.startScan('refresh');
  assert.equal(scan.code, 409);
  assert.equal((await first).ok, true);
});

test('diagnostics: a driver without part 252 or 253 is a fact, not an error', async (t) => {
  const h = await setup();
  t.after(h.close);
  h.gw.state.energy['1'] = { activeEnergyWattHours: 12345, activePowerWatt: 8.5 };
  const r = await h.admin.readDiagnostics(1);
  assert.equal(r.ok, true);
  assert.equal(r.energy.supported, true);
  assert.equal(r.energy.data.activePowerWatt, 8.5);
  assert.equal(r.diagnostics.supported, false);
  assert.equal(r.diagnostics.error, null);
  const write = h.logs.find((e) => e.action === 'diagnostics_read');
  assert.equal(write.scheduled, false);
  assert.equal(h.admin.busy(), null, 'a read changes no levels, so it leaves no settle window');
});

test('scenes and sensors are re-read with a body-less POST, logged as ours', async (t) => {
  const h = await setup();
  t.after(h.close);
  h.gw.state.scenes['1'] = { 0: { dimmable: 50 } };
  h.gw.state.sensors = [{ id: 1, name: 'Hall motion', unit: '', type: 'occupancy', value: 1, timestamp: '2026-09-16T10:00:00Z', addressType: 'dali' }];
  assert.deepEqual((await h.admin.refreshScenes(1)).scenes, { 0: { dimmable: 50 } });
  assert.equal((await h.admin.refreshSensors()).sensors.length, 1);
  const posts = h.gw.adminRequests.filter((q) => q.method === 'POST').map((q) => [q.path, q.body]);
  assert.deepEqual(posts, [['/device/1/scenes', undefined], ['/sensors', undefined]]);
  assert.deepEqual(h.logs.filter((e) => e.kind === 'gateway_write').map((e) => e.action), ['scenes_read', 'sensors_read']);
});

test('the device list says which lights can be identified', async (t) => {
  const h = await setup();
  t.after(h.close);
  const list = await h.admin.listDevices();
  assert.deepEqual(list.devices.map((d) => [d.id, d.identifiable]), [[1, true], [2, true], [3, false]]);
});
