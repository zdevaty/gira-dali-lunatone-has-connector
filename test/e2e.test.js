import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createFakeGateway } from './helpers/fake-gateway.js';
import { createFakeHa } from './helpers/fake-ha.js';

// The whole daemon, against a gateway on loopback. Offline like everything else
// here, but it exercises the parts no unit test reaches: process startup, the
// capture reaching the disk, one bad frame not taking the bridge down, and a
// clean shutdown flushing what was still buffered.

const read = (dir) => {
  const file = fs.readdirSync(dir).find((n) => n.endsWith('.jsonl'));
  if (!file) return [];
  return fs
    .readFileSync(path.join(dir, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return { kind: 'UNPARSEABLE', raw: l }; }
    });
};

async function waitFor(fn, { timeoutMs = 8000, everyMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

test('end to end: connect, decode, survive a bad frame, shut down cleanly', async (t) => {
  const gw = createFakeGateway();
  const port = await gw.listen();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dali-e2e-'));

  const child = spawn(process.execPath, ['index.js'], {
    env: {
      ...process.env,
      GATEWAY_IP: `127.0.0.1:${port}`,
      LOG_DIR: dir,
      CONTROL_ENABLED: 'false',
      CONSOLE: 'off',
      WATCHDOG: 'false', // this test blocks nothing; keep the child's exit ours to control
    },
    stdio: 'ignore',
  });

  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await gw.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  await waitFor(() => read(dir).some((e) => e.kind === 'connection' && e.status === 'connected'));
  assert.equal(gw.clients(), 1);

  // A real 16-bit level frame, then rubbish in three shapes, then another real
  // frame. The last one is the assertion that matters: it proves the daemon was
  // still there afterwards.
  gw.send(gw.monitor(16, [0x00, 0x96]));
  gw.send(gw.monitor(16, 'not-an-array'));
  gw.send({ type: 'daliMonitor' });
  gw.send('}{ not json at all');
  gw.send(gw.monitor(16, [0x02, 0x64]));

  const events = await waitFor(() => {
    const all = read(dir);
    const levels = all.filter((e) => e.kind === 'level');
    return levels.length >= 2 ? all : null;
  });

  const levels = events.filter((e) => e.kind === 'level');
  assert.deepEqual(
    levels.map((e) => [e.target, e.level]),
    [['short0', 150], ['short1', 100]],
    'both real frames decoded; the rubbish between them changed nothing',
  );
  assert.equal(events.filter((e) => e.kind === 'UNPARSEABLE').length, 0, 'the capture stayed valid JSONL');

  const startup = events.find((e) => e.kind === 'startup');
  assert.ok(startup, 'the capture says what wrote it');
  assert.equal(startup.control, false);
  assert.equal(startup.ha_token, null, 'no token, and never the value');

  assert.ok(fs.existsSync(path.join(dir, '.dali-bridge.lock')), 'the instance lock is held while running');

  child.kill('SIGTERM');
  const exit = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  assert.equal(exit.code, 0, 'SIGTERM is a clean shutdown, not a kill');

  const final = read(dir);
  assert.equal(final.at(-1).status, 'shutdown', 'the buffer was flushed on the way out');
  assert.equal(final.at(-1).signal, 'SIGTERM');
  assert.ok(!fs.existsSync(path.join(dir, '.dali-bridge.lock')), 'the lock is released');
});

test('a second instance refuses to start', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dali-e2e-'));
  const env = { ...process.env, GATEWAY_IP: '127.0.0.1:1', LOG_DIR: dir, CONTROL_ENABLED: 'false', CONSOLE: 'off', WATCHDOG: 'false' };

  const first = spawn(process.execPath, ['index.js'], { env, stdio: 'ignore' });
  t.after(async () => {
    if (first.exitCode === null) first.kill('SIGKILL');
    await fsp.rm(dir, { recursive: true, force: true });
  });
  await waitFor(() => fs.existsSync(path.join(dir, '.dali-bridge.lock')));

  const second = spawn(process.execPath, ['index.js'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  second.stderr.on('data', (d) => { stderr += d; });
  const exit = await new Promise((resolve) => second.on('exit', (code) => resolve(code)));

  assert.equal(exit, 1);
  assert.match(stderr, /another instance is already running/);
  assert.match(stderr, /twice/, 'and says why it matters');
});

test('an unreachable gateway is retried, not treated as a reason to exit', async (t) => {
  // The gateway is very likely to be unreachable for a few seconds at boot: the
  // Pi brings up the network while this is already starting. Exiting there would
  // leave the supervisor restarting us into the same race, with no lights and
  // no logs to show for it.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dali-e2e-'));
  const child = spawn(process.execPath, ['index.js'], {
    env: { ...process.env, GATEWAY_IP: '127.0.0.1:1', LOG_DIR: dir, CONTROL_ENABLED: 'false', CONSOLE: 'off', WATCHDOG: 'false' },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await fsp.rm(dir, { recursive: true, force: true });
  });

  await waitFor(() => read(dir).filter((e) => e.kind === 'connection' && e.status === 'disconnected').length >= 3);
  assert.equal(child.exitCode, null, 'still running, still trying');
});

test('a real gesture from the capture reaches Home Assistant', async (t) => {
  // The bytes below are lifted verbatim from logs/dali-2026-08-26.jsonl: a Gira
  // knob turned right, three absolute-position reports, then stop. This is the
  // one assertion that covers the whole chain at once -- gateway frame in,
  // Home Assistant call out -- through the real decoder and the real gesture
  // machine, after all the reliability surgery.
  const gw = createFakeGateway();
  const ha = createFakeHa({ brightness: 128 });
  const [gwPort, haPort] = [await gw.listen(), await ha.listen()];
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dali-e2e-'));
  fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify({
    0: { entity: 'light.obyvak', min_kelvin: 2700, max_kelvin: 6500, gear: 'short0' },
  }));

  const child = spawn(process.execPath, ['index.js'], {
    env: {
      ...process.env,
      GATEWAY_IP: `127.0.0.1:${gwPort}`,
      LOG_DIR: dir,
      DEVICE_MAP: path.join(dir, 'devices.json'),
      HA_URL: `http://127.0.0.1:${haPort}`,
      HA_TOKEN: 'test-token',
      CONTROL_ENABLED: 'true',
      CONSOLE: 'off',
      WATCHDOG: 'false',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await gw.close();
    await ha.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  await waitFor(() => read(dir).some((e) => e.kind === 'connection' && e.status === 'connected'));

  const hex = (s) => s.split(' ').map((b) => parseInt(b, 16));
  gw.send(gw.monitor(24, hex('00 84 00'))); // generic: start_right
  await new Promise((r) => setTimeout(r, 60));
  for (const frame of ['00 8C 01', '00 8C 1A', '00 8C 33']) { // absolute: 1, 26, 51
    gw.send(gw.monitor(24, hex(frame)));
    await new Promise((r) => setTimeout(r, 220)); // outside the 200 ms flush window
  }
  gw.send(gw.monitor(24, hex('00 84 02'))); // generic: stop

  const turnOns = await waitFor(() => {
    const c = ha.calls.filter((x) => x.service === '/api/services/light/turn_on');
    return c.length >= 2 ? c : null;
  });

  assert.ok(turnOns.every((c) => c.entity_id === 'light.obyvak'), 'the mapped entity, and only it');
  assert.ok(
    turnOns.every((c) => c.brightness_step === 25),
    `two 25-count turns should each send one 25-step: ${JSON.stringify(turnOns)}`,
  );

  // The capture is buffered and flushes every 250 ms, so it can legitimately lag
  // the HA call that has already gone out. Wait for it rather than racing it.
  const events = await waitFor(() => {
    const all = read(dir);
    return all.some((e) => e.kind === 'inputEvent' && e.value === 51) ? all : null;
  });
  assert.ok(events.some((e) => e.kind === 'inputEvent' && e.instanceType === 'generic' && e.event === 'start_right'));
  assert.ok(events.some((e) => e.kind === 'control' && e.action === 'brightness_step'));
  assert.ok(
    !JSON.stringify(events).includes('test-token'),
    'the token must not appear anywhere in the capture',
  );
});

test('a silent socket is reconnected while the gateway still answers HTTP', async (t) => {
  // The half-open TCP case, end to end. The fake gateway accepts the connection
  // and then says nothing at all, while /info keeps answering -- which is
  // exactly what a black-holed connection looks like from inside the daemon.
  const gw = createFakeGateway();
  const port = await gw.listen();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dali-e2e-'));

  const child = spawn(process.execPath, ['index.js'], {
    env: {
      ...process.env,
      GATEWAY_IP: `127.0.0.1:${port}`,
      LOG_DIR: dir,
      CONTROL_ENABLED: 'false',
      CONSOLE: 'off',
      WATCHDOG: 'false',
      GATEWAY_PROBE_MS: '300',
      GATEWAY_IDLE_MS: '1500',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (process.env.DALI_E2E_DUMP) {
      console.error('--- daemon log ---');
      for (const e of read(dir)) console.error('   ', JSON.stringify(e).slice(0, 160));
      console.error('--- gateway connections:', gw.connections(), 'child exit:', child.exitCode, '---');
    }
    if (child.exitCode === null) child.kill('SIGKILL');
    await gw.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  await waitFor(() => read(dir).some((e) => e.kind === 'connection' && e.status === 'connected'));
  assert.equal(gw.connections(), 1);

  // Say nothing. The socket stays open and healthy-looking the whole time.
  const events = await waitFor(
    () => (read(dir).some((e) => e.alert === 'gateway_socket_stalled') ? read(dir) : null),
    { timeoutMs: 10_000 },
  );

  const stall = events.find((e) => e.alert === 'gateway_socket_stalled');
  assert.ok(stall.silent_for_ms >= 1500, `reported ${stall.silent_for_ms} ms of silence`);
  assert.ok(typeof stall.probe_latency_ms === 'number', 'and that HTTP was answering at the time');

  await waitFor(() => gw.connections() >= 2, { timeoutMs: 10_000 });
  // The gateway object updates the instant the socket is accepted; the capture
  // is buffered and flushes every 250 ms. Wait for it rather than racing it.
  await waitFor(
    () => read(dir).filter((e) => e.kind === 'connection' && e.status === 'connected').length >= 2,
    { timeoutMs: 5000 },
  );
});

test('quiet console still shows what happened, just not every frame', async (t) => {
  // The bug this guards: `quiet` was a hand-written allow-list that omitted
  // startup, gateway and inputEvent, so an observe-only run printed one
  // connection line and then nothing -- indistinguishable from a broken
  // install, and reported as one on the first real deployment.
  const gw = createFakeGateway();
  const port = await gw.listen();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dali-e2e-'));

  const child = spawn(process.execPath, ['index.js'], {
    env: {
      ...process.env,
      GATEWAY_IP: `127.0.0.1:${port}`,
      LOG_DIR: dir,
      CONTROL_ENABLED: 'false',
      CONSOLE: 'quiet',
      WATCHDOG: 'false',
      GATEWAY_IDLE_MS: '600000',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await gw.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  await waitFor(() => out.includes('connection connected'));

  const hex = (str) => str.split(' ').map((b) => parseInt(b, 16));
  gw.send(gw.monitor(24, hex('00 84 00'))); // someone turns a knob
  gw.send(gw.monitor(16, hex('00 96')));    // and a light responds on the bus

  await waitFor(() => out.includes('start_right'), { timeoutMs: 5000 });

  assert.match(out, /start\s+v/, 'the build identifies itself');
  assert.match(out, /generic start_right/, 'a knob being turned is not "every frame"');
  assert.doesNotMatch(out, /level 150/, 'but the per-frame bus traffic is still suppressed');
});

test('status sensors reach Home Assistant, even with control off, and say stopped on the way out', async (t) => {
  const gw = createFakeGateway();
  const gwPort = await gw.listen();
  const ha = createFakeHa();
  const haPort = await ha.listen();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dali-e2e-'));

  const child = spawn(process.execPath, ['index.js'], {
    env: {
      ...process.env,
      GATEWAY_IP: `127.0.0.1:${gwPort}`,
      LOG_DIR: dir,
      CONTROL_ENABLED: 'false',
      HA_SENSORS: 'true',
      HA_URL: `http://127.0.0.1:${haPort}`,
      HA_TOKEN: 'fake-test-credential',
      CONSOLE: 'off',
      WATCHDOG: 'false',
      UI: 'false',
    },
    stdio: 'ignore',
  });

  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await gw.close();
    await ha.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const latest = (id) => [...ha.states].reverse().find((s) => s.entity_id === id);

  await waitFor(() => latest('sensor.dali_bridge_status')?.state === 'running');
  assert.equal(latest('sensor.dali_bridge_status').auth, 'Bearer fake-test-credential');

  // Connecting is worth a write within seconds, not at the minute heartbeat.
  await waitFor(() => latest('binary_sensor.dali_bridge_gateway')?.state === 'on', { timeoutMs: 10_000 });

  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(latest('sensor.dali_bridge_status').state, 'stopped');
  assert.equal(latest('binary_sensor.dali_bridge_gateway').state, 'unavailable');
  assert.equal(ha.calls.length, 0, 'control is off: the sensors must not have turned into light calls');
});

test('a scan from the panel: exact body to the gateway, our own traffic marked, HA reloaded', async (t) => {
  const gw = createFakeGateway();
  const gwPort = await gw.listen();
  gw.setDevices([{ id: 1, name: 'Line 0 DALI 00', type: 'dimmable', line: 0, address: 0, available: true, groups: [], daliTypes: [6], status: {} }]);
  const ha = createFakeHa();
  const haPort = await ha.listen();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dali-e2e-'));
  fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify({ 3: { entity: 'light.line_0_dali_00' } }));

  const child = spawn(process.execPath, ['index.js'], {
    env: {
      ...process.env,
      GATEWAY_IP: `127.0.0.1:${gwPort}`,
      LOG_DIR: dir,
      CONTROL_ENABLED: 'false',
      DEVICE_MAP: path.join(dir, 'devices.json'),
      HA_URL: `http://127.0.0.1:${haPort}`,
      HA_TOKEN: 'fake-test-credential',
      UI_PORT: '0',
      SCAN_RELOAD_SETTLE_MS: '100',
      CONSOLE: 'off',
      WATCHDOG: 'false',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await gw.close();
    await ha.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const ui = await waitFor(() => read(dir).find((e) => e.kind === 'ui' && e.status === 'listening'));
  await waitFor(() => read(dir).some((e) => e.kind === 'connection' && e.status === 'connected'));
  const base = `http://127.0.0.1:${ui.port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dali-ui': '1' }, body: JSON.stringify(body) });

  const list = await (await fetch(`${base}/api/gateway/devices`)).json();
  assert.equal(list.devices[0].name, 'Line 0 DALI 00');
  assert.equal(list.writes_enabled, true);

  assert.equal((await post('/api/gateway/scan', { mode: 'newInstallation' })).status, 400);
  assert.equal((await post('/api/gateway/scan', {})).status, 400, 'no mode is not a default mode');
  const started = await post('/api/gateway/scan', { mode: 'extend' });
  assert.equal(started.status, 200);

  // Gear blinking during a scan looks exactly like the Gira calibration
  // confirmation: three off/on cycles on one address inside five seconds.
  for (const level of [100, 0, 100, 0, 100, 0, 100]) gw.send(gw.monitor(16, [0x00, level]));
  // And every scan ends with TERMINATE.
  gw.send(gw.monitor(16, [0xa1, 0x00]));

  const last = await (async () => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const st = await (await fetch(`${base}/api/gateway/scan`)).json();
      if (st.last?.after) return st.last;
      if (Date.now() > deadline) throw new Error(`scan never finished: ${JSON.stringify(st)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  })();

  const scans = gw.adminRequests.filter((r) => r.method === 'POST' && r.path === '/dali/scan');
  assert.equal(scans.length, 1, 'the refused requests never reached the gateway');
  assert.deepEqual(scans[0].body, { newInstallation: false, noAddressing: false });

  assert.equal(last.outcome, 'done');
  assert.equal(last.after.ha_reload.ok, true);
  assert.deepEqual(ha.reloads, ['/api/config/config_entries/entry/lunatone-1/reload']);
  assert.deepEqual(last.after.missing_entities, []);

  const events = read(dir);
  const blink = events.find((e) => e.kind === 'alert' && e.alert === 'calibration_saved');
  assert.ok(blink, 'still logged');
  assert.equal(blink.during_scan, true, 'but marked as our own scan');
  assert.ok(events.some((e) => e.kind === 'command' && e.command === 'terminate'), 'TERMINATE is a command, not an alert');
  assert.ok(!events.some((e) => e.alert === 'dali_reset'));
  assert.deepEqual(events.filter((e) => e.kind === 'gateway_write').map((e) => e.action), ['scan_start', 'scan_finished']);
  assert.equal(ha.calls.length, 0, 'no light was touched');
});

test('the gateway page end to end: identify is marked as ours, a setup copy is kept, bus power loss is an alert', async (t) => {
  const gw = createFakeGateway();
  const gwPort = await gw.listen();
  gw.setDevices([{ id: 1, name: 'Line 0 DALI 00', type: 'dimmable', line: 0, address: 0, available: true, groups: [], daliTypes: [6], status: {},
    features: { switchable: { status: true }, dimmable: { status: 35 } } }]);
  const ha = createFakeHa();
  const haPort = await ha.listen();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dali-e2e-'));
  const snapDir = path.join(dir, 'snapshots');

  const child = spawn(process.execPath, ['index.js'], {
    env: {
      ...process.env,
      GATEWAY_IP: `127.0.0.1:${gwPort}`,
      LOG_DIR: dir,
      CONTROL_ENABLED: 'false',
      HA_URL: `http://127.0.0.1:${haPort}`,
      HA_TOKEN: 'fake-test-credential',
      UI_PORT: '0',
      SNAPSHOT_DIR: snapDir,
      SNAPSHOT_START_MS: '300',
      GATEWAY_WATCH_START_MS: '300',
      GATEWAY_PROBE_MS: '300',
      CONSOLE: 'off',
      WATCHDOG: 'false',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await gw.close();
    await ha.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const ui = await waitFor(() => read(dir).find((e) => e.kind === 'ui' && e.status === 'listening'));
  await waitFor(() => read(dir).some((e) => e.kind === 'connection' && e.status === 'connected'));
  const base = `http://127.0.0.1:${ui.port}`;

  // The page and its script are served.
  assert.match(await (await fetch(`${base}/`)).text(), /panel-hub/);
  assert.equal((await fetch(`${base}/gateway.js`)).status, 200);

  // A copy of the setup is taken shortly after start.
  const snap = await waitFor(() => read(dir).find((e) => e.kind === 'gateway_snapshot'));
  assert.equal(snap.changed, true);
  assert.equal(fs.readdirSync(snapDir).filter((n) => n.endsWith('.json')).length, 1);

  const overview = await (await fetch(`${base}/api/gateway/overview`)).json();
  assert.equal(overview.info.version, 'v1.18.7/1.4.6');
  assert.equal(overview.clock.recognised, true);
  assert.ok(Math.abs(overview.clock.drift_s) <= 2, `drift ${overview.clock.drift_s}`);
  assert.equal(overview.home_assistant.time_zone, 'Europe/Prague');

  // Identify, with the blink it causes on the bus arriving meanwhile.
  const identifying = fetch(`${base}/api/gateway/device/1/identify`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dali-ui': '1' }, body: '{}' });
  await waitFor(() => gw.adminRequests.some((r) => r.path === '/device/1/control'));
  for (const level of [254, 0, 254, 0, 254, 0, 254]) gw.send(gw.monitor(16, [0x00, level]));
  const identified = await identifying;
  assert.equal(identified.status, 200);
  const blink = await waitFor(() => read(dir).find((e) => e.kind === 'alert' && e.alert === 'calibration_saved'));
  assert.equal(blink.during, 'identify');
  const controls = gw.adminRequests.filter((r) => r.path === '/device/1/control').map((r) => r.body);
  assert.deepEqual(controls.at(-1), { dimmable: 35 }, 'put back where it was');
  assert.ok(read(dir).some((e) => e.kind === 'gateway_write' && e.action === 'identify'));

  // The bus power supply fails.
  gw.setLines({ 0: { lineStatus: 'noPower', sendBlockedInitialize: false, sendBlockedQuiescent: false, sendBlockedMacroRunning: false, sendBufferFull: false } });
  const lost = await waitFor(() => read(dir).find((e) => e.alert === 'dali_bus_power_lost'));
  assert.equal(lost.line, 0);

  assert.equal(ha.calls.length, 0, 'no Home Assistant service was called');
});

test('a tuning save changes what the very next knob turn sends, with no restart', async (t) => {
  const gw = createFakeGateway();
  const ha = createFakeHa({ brightness: 128 });
  const [gwPort, haPort] = [await gw.listen(), await ha.listen()];
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dali-e2e-'));
  fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify({
    0: { entity: 'light.obyvak', min_kelvin: 2700, max_kelvin: 6500, gear: 'short0' },
  }));
  const child = spawn(process.execPath, ['index.js'], {
    env: {
      ...process.env,
      GATEWAY_IP: `127.0.0.1:${gwPort}`,
      LOG_DIR: dir,
      DEVICE_MAP: path.join(dir, 'devices.json'),
      HA_URL: `http://127.0.0.1:${haPort}`,
      HA_TOKEN: 'test-token',
      CONTROL_ENABLED: 'true',
      UI_PORT: '0',
      CONSOLE: 'off',
      WATCHDOG: 'false',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await gw.close();
    await ha.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const ui = await waitFor(() => read(dir).find((e) => e.kind === 'ui' && e.status === 'listening'));
  await waitFor(() => read(dir).some((e) => e.kind === 'connection' && e.status === 'connected'));
  const hex = (s) => s.split(' ').map((b) => parseInt(b, 16));
  const turn = async (frames) => {
    gw.send(gw.monitor(24, hex('00 84 00')));
    await new Promise((r) => setTimeout(r, 60));
    for (const frame of frames) {
      gw.send(gw.monitor(24, hex(frame)));
      await new Promise((r) => setTimeout(r, 250));
    }
    gw.send(gw.monitor(24, hex('00 84 02')));
  };
  const steps = () => ha.calls.filter((x) => x.brightness_step !== undefined).map((x) => x.brightness_step);

  await turn(['00 8C 01', '00 8C 1A']); // baseline, then a 25-count report
  await waitFor(() => steps().length >= 1);
  assert.deepEqual(steps(), [25]);

  const res = await fetch(`http://127.0.0.1:${ui.port}/api/tuning`, {
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-dali-ui': '1' },
    body: JSON.stringify({ speedCurve: [2, 10, 55, 80] }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).applied, true);

  await turn(['00 8C 33']); // another 25-count report
  await waitFor(() => steps().length >= 2);
  assert.deepEqual(steps(), [25, 10]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'tuning.json'), 'utf8')), { speedCurve: [2, 10, 55, 80] });
  const logged = await waitFor(() => read(dir).find((e) => e.kind === 'tuning' && e.action === 'saved'));
  assert.deepEqual(logged.changed.speedCurve, { from: [2, 25, 55, 80], to: [2, 10, 55, 80] });
});
