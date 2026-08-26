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

test('a second instance on the same machine is refused', async () => {
  const dir = await tmp();
  const first = acquireLock(dir);
  assert.equal(first.ok, true);

  const second = acquireLock(dir);
  assert.equal(second.ok, false, 'two bridges would send every gesture to HA twice');
  assert.equal(second.holder.pid, process.pid);

  first.release();
  assert.equal(acquireLock(dir).ok, true, 'released, so the next one may start');
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
