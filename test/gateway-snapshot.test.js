import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGatewaySnapshots, normalise, diff, describeChange } from '../lib/gateway-snapshot.js';
import { createGatewayReader } from '../lib/gateway-read.js';
import { createFakeGateway } from './helpers/fake-gateway.js';

async function setup() {
  const gw = createFakeGateway();
  const port = await gw.listen();
  gw.setDevices([
    { id: 1, name: 'Kitchen', type: 'dimmable', line: 0, address: 0, available: true, groups: [1], daliTypes: [6],
      status: { lampOn: true }, features: { switchable: { status: true }, dimmable: { status: 40 } }, timeSignature: { timestamp: 1, counter: 1 } },
  ]);
  gw.state.scenes['1'] = { 0: { dimmable: 50 } };
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dali-snap-'));
  const logs = [];
  let clock = Date.parse('2026-09-16T01:00:00Z');
  let ownWrite = null;
  const reader = createGatewayReader({ host: `127.0.0.1:${port}`, cacheMs: 0 });
  const snaps = createGatewaySnapshots({
    reader, dir, log: (e) => logs.push(e), now: () => clock, lastOwnWriteAt: () => ownWrite, keep: 3,
  });
  return {
    gw, dir, logs, snaps,
    tick: (ms) => { clock += ms; },
    ownWrite: () => { ownWrite = clock; },
    files: () => fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(),
    close: async () => { await gw.close(); await fsp.rm(dir, { recursive: true, force: true }); },
  };
}

test('what changes by itself is left out of the copy', () => {
  const data = normalise({
    info: { name: 'gw', version: 'v1', errors: { x: 1 }, lines: { 0: { lineStatus: 'ok', sendBufferFull: false, device: { serial: 5 } } } },
    devices: [{ id: 1, name: 'K', status: { lampOn: true }, available: true, timeSignature: {}, features: { dimmable: { status: 40 }, switchable: { status: true } } }],
    sensors: [{ id: 2, name: 'motion', value: 1, timestamp: 'x', type: 'occupancy' }],
    datetime: { timezone: 'UTC', automatic_time: true, date: 'd', time: 't' },
    automations: { schedules: [], circadians: [], sequences: [{ id: 3, active: true, name: 's' }], trigger_actions: [], event_trigger_actions: [] },
  });
  assert.deepEqual(data.info, { name: 'gw', version: 'v1', lines: { 0: { device: { serial: 5 } } } });
  assert.deepEqual(data.devices, { 1: { id: 1, name: 'K', features: ['dimmable', 'switchable'] } });
  assert.deepEqual(data.sensors, { 2: { id: 2, name: 'motion', type: 'occupancy' } });
  assert.deepEqual(data.datetime, { timezone: 'UTC', automatic_time: true });
  assert.deepEqual(data.automations.sequences, { 3: { id: 3, name: 's' } });
});

test('a diff names records by id and says what happened to them', () => {
  const before = { devices: { 1: { id: 1, name: 'Kitchen', address: 0, groups: [1] }, 2: { id: 2, name: 'Old', address: 1 } } };
  const after = { devices: { 1: { id: 1, name: 'Kitchen ceiling', address: 0, groups: [1, 2] }, 3: { id: 3, name: 'New', address: 4 } } };
  const changes = diff(before, after);
  assert.deepEqual(changes.map((c) => describeChange(c, { before, after })).sort(), [
    'device 1 “Kitchen ceiling” (A0): groups: [1] → [1,2]',
    'device 1 “Kitchen ceiling” (A0): name: Kitchen → Kitchen ceiling',
    'device 2 “Old” (A1) removed',
    'device 3 “New” (A4) added',
  ]);
});

test('a part that could not be read is not a part that was deleted', () => {
  assert.deepEqual(diff({ zones: { 1: {} }, devices: {} }, { devices: {} }, { skip: ['zones'] }), []);
});

test('the first copy is written; an unchanged gateway writes nothing more', async (t) => {
  const h = await setup();
  t.after(h.close);
  const first = await h.snaps.take({ reason: 'startup' });
  assert.equal(first.changed, true);
  assert.equal(h.files().length, 1);
  const doc = JSON.parse(fs.readFileSync(path.join(h.dir, h.files()[0]), 'utf8'));
  assert.equal(doc.data.devices['1'].name, 'Kitchen');
  assert.deepEqual(doc.data.scenes, { 1: { 0: { dimmable: 50 } } });
  assert.equal(doc.firmware, 'v1.18.7/1.4.6');

  // A lamp going off and a level changing are not changes to the setup.
  h.gw.state.scenes['1'] = { 0: { dimmable: 50 } };
  h.tick(86_400_000);
  const second = await h.snaps.take({ reason: 'nightly' });
  assert.equal(second.changed, false);
  assert.equal(h.files().length, 1);
});

test('a change nobody here made is an alert; one this app made is not', async (t) => {
  const h = await setup();
  t.after(h.close);
  await h.snaps.take({ reason: 'startup' });

  h.tick(60_000);
  h.gw.state.zones.push({ id: 1, name: 'Hall', targets: [{ type: 'device', id: 1 }], features: {} });
  const outside = await h.snaps.take({ reason: 'nightly' });
  assert.equal(outside.changed, true);
  assert.deepEqual(outside.changes, ['zone 1 “Hall” added']);
  const alert = h.logs.find((e) => e.alert === 'gateway_config_changed');
  assert.equal(alert.changes, 1);

  h.tick(60_000);
  h.ownWrite();
  h.tick(1000);
  h.gw.state.settings.dali_ping = false;
  await h.snaps.take({ reason: 'after a change from this app' });
  assert.equal(h.logs.filter((e) => e.alert === 'gateway_config_changed').length, 1, 'no second alert');
});

test('a firmware update is its own alert', async (t) => {
  const h = await setup();
  t.after(h.close);
  await h.snaps.take();
  h.tick(1000);
  // The fake gateway's /info is fixed, so change what the copy remembers.
  const [name] = h.files();
  const doc = JSON.parse(fs.readFileSync(path.join(h.dir, name), 'utf8'));
  doc.data.info.version = 'v1.17.0/1.4.0';
  fs.writeFileSync(path.join(h.dir, name), JSON.stringify(doc));
  await h.snaps.take();
  const alert = h.logs.find((e) => e.alert === 'gateway_firmware_changed');
  assert.deepEqual([alert.from, alert.to], ['v1.17.0/1.4.0', 'v1.18.7/1.4.6']);
});

test('only the newest copies are kept, and each compares with the one before', async (t) => {
  const h = await setup();
  t.after(h.close);
  for (let i = 0; i < 5; i++) {
    h.gw.state.settings.dali_ping = i % 2 === 0;
    h.tick(3_600_000);
    await h.snaps.take({ reason: `round ${i}` });
  }
  assert.equal(h.files().length, 3);
  const list = await h.snaps.list();
  assert.equal(list[0].reason, 'round 4');
  const cmp = await h.snaps.compare(list[0].file);
  assert.deepEqual(cmp.changes.map((c) => c.text), ['settings.dali_ping: false → true']);
  assert.equal((await h.snaps.compare('../../etc/passwd')).code, 404);
});

test('a gateway that answers nothing leaves no file and says so', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dali-snap-'));
  const logs = [];
  const reader = createGatewayReader({ host: '127.0.0.1:9', fetchImpl: async () => { throw new Error('down'); } });
  const snaps = createGatewaySnapshots({ reader, dir, log: (e) => logs.push(e) });
  const r = await snaps.take();
  assert.equal(r.ok, false);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.ok(logs.some((e) => e.alert === 'gateway_snapshot_failed'));
  await fsp.rm(dir, { recursive: true, force: true });
});
