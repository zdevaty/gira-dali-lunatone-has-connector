import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createLogStore, localDay } from '../lib/logstore.js';

// These tests use a real temporary directory. The point of this module is what
// it does to a filesystem -- renames, gzip, unlink, append -- and a fake fs
// would only prove that the fake behaves as I imagined it.
async function tmpStore(options = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dali-logstore-'));
  const logs = [];
  const store = createLogStore({ dir, flushMs: 60_000, log: (e) => logs.push(e), ...options });
  return {
    dir, store, logs,
    read: (name) => fs.readFileSync(path.join(dir, name), 'utf8'),
    names: () => fs.readdirSync(dir).sort(),
    async cleanup() {
      await store.close();
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

const day = (offsetDays = 0, base = Date.parse('2026-08-26T12:00:00')) =>
  localDay(base + offsetDays * 86400000);

const at = (offsetDays = 0) => Date.parse('2026-08-26T12:00:00') + offsetDays * 86400000;

test('writes are buffered: nothing reaches the disk until flush', async () => {
  const h = await tmpStore({ now: () => at(0) });
  h.store.write({ kind: 'level', target: 'short0', level: 42 }, at(0));
  assert.deepEqual(h.names(), [], 'the frame path must not touch the filesystem');
  await h.store.flush();
  assert.deepEqual(h.names(), [`dali-${day(0)}.jsonl`]);
  await h.cleanup();
});

test('flushed lines are one JSON object per line, in order', async () => {
  const h = await tmpStore({ now: () => at(0) });
  for (const level of [1, 2, 3]) h.store.write({ kind: 'level', level }, at(0));
  await h.store.flush();
  const lines = h.read(`dali-${day(0)}.jsonl`).trim().split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => JSON.parse(l).level), [1, 2, 3]);
  await h.cleanup();
});

test('a day boundary inside one buffer splits into two files', async () => {
  const h = await tmpStore({ now: () => at(0) });
  h.store.write({ kind: 'level', level: 1 }, at(0));
  h.store.write({ kind: 'level', level: 2 }, at(1));
  await h.store.flush();
  assert.deepEqual(h.names(), [`dali-${day(0)}.jsonl`, `dali-${day(1)}.jsonl`]);
  assert.equal(JSON.parse(h.read(`dali-${day(1)}.jsonl`)).level, 2);
  await h.cleanup();
});

test('an existing capture is appended to, never truncated', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dali-logstore-'));
  const file = path.join(dir, `dali-${day(0)}.jsonl`);
  fs.writeFileSync(file, '{"kind":"existing"}\n');

  const store = createLogStore({ dir, flushMs: 60_000, now: () => at(0) });
  store.write({ kind: 'level', level: 7 }, at(0));
  await store.flush();
  await store.close();

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).kind, 'existing', 'real captures are never overwritten');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('when the buffer overflows, frames are shed and alerts are kept', async () => {
  const h = await tmpStore({ now: () => at(0), maxBufferBytes: 2000 });
  h.store.write({ kind: 'alert', alert: 'first_alert' }, at(0));
  for (let i = 0; i < 400; i++) h.store.write({ kind: 'level', target: 'short0', level: i }, at(0));
  h.store.write({ kind: 'alert', alert: 'last_alert' }, at(0));
  await h.store.flush();

  const events = h.read(`dali-${day(0)}.jsonl`).trim().split('\n').map((l) => JSON.parse(l));
  const alerts = events.filter((e) => e.kind === 'alert').map((e) => e.alert);
  assert.deepEqual(alerts, ['first_alert', 'last_alert'], 'an alert explains the gap; it is the last thing to drop');
  assert.ok(h.store.stats().dropped > 0, 'frames were shed');
  assert.ok(events.length < 402, 'the buffer did not grow without bound');
  await h.cleanup();
});

test('a low disk pauses frame logging, keeps alerts, and keeps the bridge running', async () => {
  let free = 1000 * 1024 * 1024;
  const h = await tmpStore({
    now: () => at(0),
    minFreeBytes: 256 * 1024 * 1024,
    freeBytes: async () => free,
  });

  free = 10 * 1024 * 1024; // disk nearly full
  await h.store.checkSpace();
  assert.equal(h.logs.at(-1).alert, 'log_paused_low_disk');

  h.store.write({ kind: 'level', level: 1 }, at(0));
  h.store.write({ kind: 'alert', alert: 'still_important' }, at(0));
  await h.store.flush();
  const events = h.read(`dali-${day(0)}.jsonl`).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.kind), ['alert'], 'frames dropped, the alert written');
  assert.equal(h.store.stats().droppedLowDisk, 1);

  free = 260 * 1024 * 1024; // just above the floor
  await h.store.checkSpace();
  assert.equal(h.store.stats().paused, true, 'hysteresis: do not resume the moment we touch the floor');

  free = 400 * 1024 * 1024;
  await h.store.checkSpace();
  assert.equal(h.store.stats().paused, false);
  assert.equal(h.logs.at(-1).alert, 'log_resumed');
  await h.cleanup();
});

test('sweep gzips yesterday and leaves today alone', async () => {
  const h = await tmpStore({ now: () => at(0), gzipAfterDays: 1 });
  fs.writeFileSync(path.join(h.dir, `dali-${day(-1)}.jsonl`), '{"kind":"old"}\n');
  h.store.write({ kind: 'level', level: 1 }, at(0));
  await h.store.flush();

  await h.store.sweep();
  assert.deepEqual(h.names(), [`dali-${day(-1)}.jsonl.gz`, `dali-${day(0)}.jsonl`]);
  const back = zlib.gunzipSync(fs.readFileSync(path.join(h.dir, `dali-${day(-1)}.jsonl.gz`))).toString();
  assert.equal(back, '{"kind":"old"}\n', 'the capture survives the round trip intact');
  await h.cleanup();
});

test('sweep deletes past the retention horizon and logs every deletion', async () => {
  const h = await tmpStore({ now: () => at(0), retentionDays: 3, gzipAfterDays: 99 });
  for (const offset of [-10, -5, -2, 0]) {
    fs.writeFileSync(path.join(h.dir, `dali-${day(offset)}.jsonl`), '{"kind":"x"}\n');
  }
  await h.store.sweep();
  assert.deepEqual(h.names(), [`dali-${day(-2)}.jsonl`, `dali-${day(0)}.jsonl`]);
  const deleted = h.logs.filter((e) => e.action === 'deleted').map((e) => e.file);
  assert.deepEqual(deleted.sort(), [`dali-${day(-10)}.jsonl`, `dali-${day(-5)}.jsonl`].sort());
  await h.cleanup();
});

test('sweep enforces the size cap oldest-first and never deletes today', async () => {
  const h = await tmpStore({ now: () => at(0), retentionDays: 0, gzipAfterDays: 99, maxBytes: 2500 });
  for (const offset of [-3, -2, -1, 0]) {
    fs.writeFileSync(path.join(h.dir, `dali-${day(offset)}.jsonl`), 'x'.repeat(1000));
  }
  await h.store.sweep();
  const left = h.names();
  assert.ok(left.includes(`dali-${day(0)}.jsonl`), "today's capture is never a candidate");
  assert.ok(!left.includes(`dali-${day(-3)}.jsonl`), 'the oldest went first');
  assert.ok(left.length < 4);
  await h.cleanup();
});

test('sweep never touches a file it did not create', async () => {
  const h = await tmpStore({ now: () => at(0), retentionDays: 1, maxBytes: 1, gzipAfterDays: 0 });
  const strangers = ['notes.txt', 'dali-bad.jsonl', 'other-2020-01-01.jsonl', 'dali-2020-01-01.jsonl.bak'];
  for (const name of strangers) fs.writeFileSync(path.join(h.dir, name), 'keep me');
  await h.store.sweep();
  for (const name of strangers) {
    assert.ok(fs.existsSync(path.join(h.dir, name)), `${name} must survive`);
  }
  await h.cleanup();
});

test('close flushes what is still buffered', async () => {
  const h = await tmpStore({ now: () => at(0) });
  h.store.write({ kind: 'level', level: 99 }, at(0));
  await h.store.close();
  assert.equal(JSON.parse(h.read(`dali-${day(0)}.jsonl`)).level, 99);
  await fsp.rm(h.dir, { recursive: true, force: true });
});

test('usage reports what the captures cost on disk', async () => {
  const h = await tmpStore({ now: () => at(0) });
  fs.writeFileSync(path.join(h.dir, `dali-${day(-1)}.jsonl`), 'x'.repeat(500));
  h.store.write({ kind: 'level', level: 1 }, at(0));
  await h.store.flush();
  const usage = await h.store.usage();
  assert.equal(usage.files, 2);
  assert.ok(usage.bytes > 500);
  assert.equal(usage.oldest, day(-1));
  assert.equal(usage.newest, day(0));
  await h.cleanup();
});

test('the real free-space probe works on this platform', async () => {
  // The default freeBytes() uses fs.statfs. If that is unavailable the store
  // would silently never pause, so prove it returns a real number here.
  const h = await tmpStore();
  await h.store.checkSpace();
  assert.equal(h.logs.filter((e) => e.alert === 'log_paused_low_disk').length, 0);
  const s = await fsp.statfs(h.dir);
  assert.ok(s.bavail * s.bsize > 0, 'statfs reports free space');
  await h.cleanup();
});
