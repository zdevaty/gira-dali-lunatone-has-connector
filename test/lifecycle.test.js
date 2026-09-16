import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireLock } from '../lib/lock.js';

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'dali-life-'));

// --- single instance ---------------------------------------------------------

const lockUrl = pathToFileURL(path.resolve('lib/lock.js')).href;

// A real second process holds the lock: one process asking twice is, correctly,
// not two instances.
async function holdLockInChild(dir) {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', `
import { acquireLock } from ${JSON.stringify(lockUrl)};
const lock = acquireLock(${JSON.stringify(dir)});
process.stdout.write(lock.ok ? 'held\\n' : 'refused\\n');
process.on('SIGTERM', () => { lock.release(); process.exit(0); });
setInterval(() => {}, 1000);
`],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const first = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(String(d).trim())));
  assert.equal(first, 'held');
  const stop = () => new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); });
  return { child, stop };
}

const writeLock = (dir, fields) =>
  fs.writeFileSync(
    path.join(dir, '.dali-bridge.lock'),
    JSON.stringify({ host: os.hostname(), started: '2020-01-01T00:00:00.000Z', ...fields }) + '\n',
  );

test('a second instance on the same machine is refused', async () => {
  const dir = await tmp();
  const { child, stop } = await holdLockInChild(dir);

  const second = acquireLock(dir);
  assert.equal(second.ok, false, 'two bridges would send every gesture to HA twice');
  assert.equal(second.holder.pid, child.pid);

  await stop();
  assert.equal(acquireLock(dir).ok, true, 'released, so the next one may start');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a lock naming our own pid is ours to take: the container restart case', async () => {
  // In the app container node is pid 7 on every start. After a power cut the
  // lock on /data named pid 7, the new bridge was pid 7, found it alive, and
  // refused to start until someone deleted the file by hand.
  const dir = await tmp();
  writeLock(dir, { pid: process.pid });
  assert.equal(acquireLock(dir).ok, true, 'the process holding pid 7 now is the new bridge itself');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a lock from a previous boot is stale even if its pid is alive now', async () => {
  const dir = await tmp();
  writeLock(dir, { pid: process.ppid, boot: '00000000-0000-0000-0000-000000000000' });
  assert.equal(acquireLock(dir).ok, true, 'pids restart from low numbers after every boot');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a lock whose pid now belongs to a later process is stale', async () => {
  const dir = await tmp();
  // A live pid that is not us, recorded with a start time it does not have.
  writeLock(dir, { pid: process.ppid, start: '1' });
  assert.equal(acquireLock(dir).ok, true, 'the pid was reused by something that started later');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a lock left behind by a dead process is taken over', async () => {
  const dir = await tmp();
  // PID 1 exists but is not us; use an unlikely-but-free pid instead.
  const deadPid = 0x7ffffffe;
  fs.writeFileSync(
    path.join(dir, '.dali-bridge.lock'),
    JSON.stringify({ pid: deadPid, host: os.hostname(), started: '2020-01-01T00:00:00.000Z' }) + '\n',
  );

  const lock = acquireLock(dir);
  assert.equal(lock.ok, true, 'SIGKILL and power cuts leave the file behind; that must not wedge startup');
  const held = JSON.parse(fs.readFileSync(path.join(dir, '.dali-bridge.lock'), 'utf8'));
  assert.equal(held.pid, process.pid);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a lock written by a different machine is taken over', async () => {
  const dir = await tmp();
  fs.writeFileSync(
    path.join(dir, '.dali-bridge.lock'),
    JSON.stringify({ pid: process.pid, host: 'some-other-box', started: '2020-01-01T00:00:00.000Z' }) + '\n',
  );
  // The capture directory is local, so a foreign host's lock is a leftover from
  // a copied directory, not a live claim. Same-host is the case this can decide.
  assert.equal(acquireLock(dir).ok, true);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('an unwritable directory does not block startup', async () => {
  const lock = acquireLock('/proc/nonexistent-dali-dir');
  assert.equal(lock.ok, true, 'failing to take a lock is not a reason to leave the switches dead');
});

// --- watchdog ----------------------------------------------------------------

const watchdogUrl = pathToFileURL(path.resolve('lib/watchdog.js')).href;

async function runFixture({ block, timeoutMs = 800, liveMs = 2500 }) {
  const dir = await tmp();
  const logFile = path.join(dir, 'watch.jsonl');
  const script = path.join(dir, 'fixture.mjs');
  fs.writeFileSync(script, `
import { startWatchdog } from ${JSON.stringify(watchdogUrl)};
startWatchdog({ timeoutMs: ${timeoutMs}, beatMs: 100, currentFile: () => ${JSON.stringify(logFile)} });
${block ? `setTimeout(() => { const end = Date.now() + 60000; while (Date.now() < end) {} }, 300);` : ''}
setTimeout(() => process.exit(0), ${liveMs});
`);

  const child = spawn(process.execPath, [script], { stdio: 'ignore' });
  const result = await new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  await fsp.rm(dir, { recursive: true, force: true });
  return { ...result, log };
}

test('a wedged event loop is killed, and the capture says why', async () => {
  const r = await runFixture({ block: true });
  assert.equal(r.signal, 'SIGKILL', 'the process must not be left up and useless');
  const entry = JSON.parse(r.log.trim().split('\n').at(-1));
  assert.equal(entry.alert, 'watchdog_kill');
  assert.ok(entry.stalled_ms >= 800, `stall was reported as ${entry.stalled_ms} ms`);
});

test('a healthy process is left alone', async () => {
  const r = await runFixture({ block: false });
  assert.equal(r.signal, null);
  assert.equal(r.code, 0, 'a running event loop must never be mistaken for a wedged one');
  assert.equal(r.log, '', 'and nothing is written about it');
});
