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
