import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createGatewayAdmin, assertSafeScanBody, validateDeviceUpdate, SCAN_MODES,
} from '../lib/gateway-admin.js';

// A gateway that records every request and answers from a script.
function fakeGateway({ scanStates = ['in progress', 'done'], devices = [], failPost = null } = {}) {
  const requests = [];
  let polls = 0;
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const scanModel = (status) => ({ id: 's1', progress: status === 'done' ? 100 : 40, found: 3, foundSensors: 0, status,
    lines: [{ line: 0, scanState: status === 'done' ? 'done' : 'scanning', found: 3, addressed: 1, scanned: 3, progress: 40 }] });

  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: pathname, body });
    if (method === 'GET' && pathname === '/devices') return reply(200, { devices, timeSignature: {} });
    if (method === 'POST' && pathname === '/dali/scan') {
      if (failPost) return reply(failPost, { detail: 'scan already running' });
      return reply(200, scanModel('in progress'));
    }
    if (method === 'GET' && pathname === '/dali/scan') {
      const state = scanStates[Math.min(polls, scanStates.length - 1)];
      polls += 1;
      return reply(200, scanModel(state));
    }
    if (method === 'POST' && pathname === '/dali/scan/cancel') return reply(200, scanModel('cancelled'));
    if (method === 'PUT' && pathname.startsWith('/device/')) return reply(200, { id: Number(pathname.split('/')[2]), ...body });
    return reply(404, { detail: 'Not Found' });
  };
  return { fetchImpl, requests };
}

function harness(gwOptions, adminOptions = {}) {
  let t = 0;
  const timers = new Map();
  let nextId = 1;
  const gw = fakeGateway(gwOptions);
  const logs = [];
  const finished = [];
  const admin = createGatewayAdmin({
    host: '10.0.0.230',
    fetchImpl: gw.fetchImpl,
    log: (e) => logs.push(e),
    onScanFinished: async (summary) => { finished.push(summary); return { ha_reload: { ok: true } }; },
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    ...adminOptions,
  });
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  async function advance(ms) {
    const end = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      t = Math.max(t, due[1].at);
      due[1].fn();
      await flush();
    }
    t = end;
    await flush();
  }
  return { admin, gw, logs, finished, advance, flush };
}

// ── The line that must never be crossed ─────────────────────────────────────

test('no scan mode can send newInstallation:true, and none relies on the gateway defaults', async () => {
  for (const mode of SCAN_MODES) {
    const h = harness();
    const r = await h.admin.startScan(mode);
    assert.equal(r.ok, true, mode);
    const sent = h.gw.requests.find((q) => q.method === 'POST' && q.path === '/dali/scan');
    assert.equal(sent.body.newInstallation, false, `${mode} must say newInstallation:false explicitly`);
    assert.equal(typeof sent.body.noAddressing, 'boolean', `${mode} must not fall back to the default, which addresses`);
    await h.admin.cancelScan();
  }
});

test('the two modes are exactly refresh (no addressing) and extend (addressing new devices only)', async () => {
  const bodies = {};
  for (const mode of SCAN_MODES) {
    const h = harness();
    await h.admin.startScan(mode);
    bodies[mode] = h.gw.requests.find((q) => q.method === 'POST' && q.path === '/dali/scan').body;
    await h.admin.cancelScan();
  }
  assert.deepEqual(bodies, {
    refresh: { newInstallation: false, noAddressing: true },
    extend: { newInstallation: false, noAddressing: false },
  });
});

test('a new installation is not a mode, whatever it is called', async () => {
  for (const mode of ['newInstallation', 'new', 'install', 'reset', '', undefined, null, '__proto__', 'constructor', 'toString']) {
    const h = harness();
    const r = await h.admin.startScan(mode);
    assert.equal(r.ok, false, String(mode));
    assert.equal(r.code, 400);
    assert.equal(h.gw.requests.length, 0, `nothing reached the gateway for ${String(mode)}`);
  }
});

test('the last-moment check refuses anything but an explicit, known body', () => {
  assert.throws(() => assertSafeScanBody({}), /newInstallation:false/);
  assert.throws(() => assertSafeScanBody({ newInstallation: true, noAddressing: true }));
  assert.throws(() => assertSafeScanBody({ newInstallation: 0, noAddressing: true }), 'falsy is not false');
  assert.throws(() => assertSafeScanBody({ newInstallation: false }), /noAddressing/);
  assert.throws(() => assertSafeScanBody({ newInstallation: false, noAddressing: false, useLines: [0] }), /unexpected/);
  assert.doesNotThrow(() => assertSafeScanBody({ newInstallation: false, noAddressing: true }));
});

test('nothing in the bridge can write newInstallation:true or reach the dangerous endpoints', () => {
  // Source scan, like the token test: a future edit that adds one of these
  // should have to delete this test to get through, and explain why.
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.js')) files.push(full);
    }
  };
  walk('lib');
  files.push('index.js');
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /newInstallation\s*:\s*true/, file);
    assert.doesNotMatch(text, /sendDali(16|24)/, `${file}: raw frames`);
    assert.doesNotMatch(text, /\/(group|zone|broadcast)\/[^'"`]*\/control|broadcast\/control/, `${file}: group, zone or broadcast control`);
    assert.doesNotMatch(text, /saveToScene|fadeRate|fadeTime\s*:/, `${file}: settings stored in the driver`);
    assert.doesNotMatch(text, /['"`]\/(reset|reboot|ethernet)['"`]/, `${file}: reset, reboot or network settings`);
    // Device control exists for identify alone, and only these two files may
    // name it: the table that allows it and the module that blinks.
    if (!/lib[\\/](gateway-http|gateway-admin)\.js$/.test(file)) {
      assert.doesNotMatch(text, /['"`][^'"`]*\/device\/[^'"`]*\/control/, `${file}: device control outside identify`);
    }
  }
});

// ── Scanning ────────────────────────────────────────────────────────────────

test('a scan is polled to the end, recorded, and handed on for the HA reload', async () => {
  const h = harness({ scanStates: ['in progress', 'addressing', 'done'] });
  await h.admin.startScan('extend');
  assert.equal(h.admin.status().active, true);
  assert.equal(h.admin.scanning(), true);

  await h.advance(10_000);
  assert.equal(h.admin.status().active, false);
  assert.equal(h.finished.length, 1);
  assert.equal(h.finished[0].outcome, 'done');
  assert.equal(h.finished[0].found, 3);
  assert.equal(h.finished[0].addressed, 1);

  const last = h.admin.status().last;
  assert.deepEqual(last.after, { ha_reload: { ok: true } });

  const writes = h.logs.filter((e) => e.kind === 'gateway_write').map((e) => e.action);
  assert.deepEqual(writes, ['scan_start', 'scan_finished'], 'every write is in the capture');
});

test('scan traffic keeps counting as ours for a while after the gateway says done', async () => {
  const h = harness({ scanStates: ['done'] });
  await h.admin.startScan('refresh');
  await h.advance(2_000);
  assert.equal(h.admin.status().active, false);
  assert.equal(h.admin.scanning(), true, 'settling');
  await h.advance(10_000);
  assert.equal(h.admin.scanning(), false);
});

test('two presses start one scan', async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.admin.startScan('refresh'), h.admin.startScan('refresh')]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  assert.equal(h.gw.requests.filter((q) => q.method === 'POST' && q.path === '/dali/scan').length, 1);
  await h.admin.cancelScan();
});

test('a scan started elsewhere is reported, not fought', async () => {
  const h = harness({ failPost: 409 });
  const r = await h.admin.startScan('refresh');
  assert.equal(r.ok, false);
  assert.equal(r.code, 409);
  assert.equal(h.admin.status().active, false, 'free to try again later');
});

test('a scan that never finishes is given up on, not polled forever', async () => {
  const h = harness({ scanStates: ['in progress'] }, { maxScanMs: 60_000 });
  await h.admin.startScan('refresh');
  await h.advance(70_000);
  assert.equal(h.admin.status().active, false);
  assert.equal(h.admin.status().last.outcome, 'timed_out');
  assert.ok(h.logs.some((e) => e.alert === 'gateway_scan_failed'));
  assert.equal(h.finished.length, 0, 'no HA reload after a scan that did not finish');
});

test('cancel stops polling and records the outcome', async () => {
  const h = harness({ scanStates: ['in progress'] });
  await h.admin.startScan('extend');
  const r = await h.admin.cancelScan();
  assert.equal(r.ok, true);
  assert.equal(h.admin.status().last.outcome, 'cancelled');
  const before = h.gw.requests.length;
  await h.advance(60_000);
  assert.equal(h.gw.requests.length, before);
});

// ── Names and groups ────────────────────────────────────────────────────────

test('a device update sends only name and groups, cleaned', async () => {
  const h = harness();
  const r = await h.admin.updateDevice(7, { name: '  Kitchen ceiling ', groups: [3, 1, 3] });
  assert.equal(r.ok, true);
  const put = h.gw.requests.find((q) => q.method === 'PUT');
  assert.equal(put.path, '/device/7');
  assert.deepEqual(put.body, { name: 'Kitchen ceiling', groups: [1, 3] });
  assert.ok(h.logs.some((e) => e.kind === 'gateway_write' && e.action === 'device_update' && e.id === 7));
});

test('anything else about a device is refused before it reaches the gateway', async () => {
  const h = harness();
  for (const bad of [
    { address: 5 },
    { name: '' },
    { name: 'x'.repeat(65) },
    { groups: [16] },
    { groups: [-1] },
    { groups: '1,2' },
    {},
    null,
  ]) {
    const r = await h.admin.updateDevice(7, bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  assert.equal((await h.admin.updateDevice(-1, { name: 'x' })).ok, false);
  assert.equal(h.gw.requests.length, 0);
});

test('devices are not changed while a scan is running', async () => {
  const h = harness({ scanStates: ['in progress'] });
  await h.admin.startScan('refresh');
  const r = await h.admin.updateDevice(1, { name: 'x' });
  assert.equal(r.code, 409);
  assert.equal(h.gw.requests.filter((q) => q.method === 'PUT').length, 0);
  await h.admin.cancelScan();
});

test('validateDeviceUpdate says what is wrong in words', () => {
  const r = validateDeviceUpdate({ name: 'ok', colour: 'red' });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /"colour" cannot be changed/);
});

// ── Reads ───────────────────────────────────────────────────────────────────

test('the device list is read and trimmed to what the page shows', async () => {
  const h = harness({ devices: [{ id: 1, name: 'Line 0 DALI 00', type: 'dimmable', line: 0, address: 0, available: true,
    groups: [0], daliTypes: [6, 8], status: { lampFailure: false }, features: { big: 'object' } }] });
  const r = await h.admin.listDevices();
  assert.equal(r.reachable, true);
  assert.equal(r.devices.length, 1);
  assert.equal(r.devices[0].name, 'Line 0 DALI 00');
  assert.equal(r.devices[0].features, undefined);
});

test('an unreachable gateway gives an empty list and a reason, not a throw', async () => {
  const admin = createGatewayAdmin({ host: 'x', fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'EHOSTUNREACH' } }); } });
  const r = await admin.listDevices();
  assert.equal(r.reachable, false);
  assert.deepEqual(r.devices, []);
  assert.match(r.error, /EHOSTUNREACH/);
});
