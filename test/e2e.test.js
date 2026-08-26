import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createFakeGateway } from './helpers/fake-gateway.js';

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
