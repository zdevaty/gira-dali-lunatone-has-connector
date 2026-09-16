import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTuningStore, validateTuning, TUNING_FIELDS, TUNING_DEFAULTS } from '../lib/tuning.js';
import { createController } from '../lib/control.js';

async function tmp() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dali-tune-'));
  return { dir, file: path.join(dir, 'tuning.json'), cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

test('every tuning key is one the controller actually has, with the same defaults', () => {
  const controller = createController({ ha: {} });
  const live = controller.getTuning();
  assert.deepEqual(Object.keys(live).sort(), TUNING_FIELDS.map((f) => f.key).sort());
  assert.deepEqual(live, TUNING_DEFAULTS);
});

test('validation says what is wrong in words, and never lets a NaN through', () => {
  assert.equal(validateTuning({ speedCurve: '3, 20, 50, 90', flushMs: '150' }).ok, true);
  assert.deepEqual(validateTuning({ speedCurve: '3, 20, 50, 90' }).value.speedCurve, [3, 20, 50, 90]);
  const bad = validateTuning({ speedCurve: [80, 55, 25, 2], minBrightness: 1, flushMs: 'fast', brightnessGain: NaN, colour: 1, maxQueue: 2.5 });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems, [
    'Step per speed: must not get smaller as the knob turns faster',
    'Lowest brightness: must be between 2 and 128',
    'At most one call every: must be a number',
    'Brightness gain: must be a number',
    '"colour" is not a tuning setting',
    'Calls waiting per light, at most: must be a whole number',
  ]);
  assert.equal(validateTuning({ speedCurve: [1, 2, 3] }).ok, false);
  assert.equal(validateTuning([]).ok, false);
});

test('defaults, then the environment, then the page; the file keeps only what the page changed', async (t) => {
  const f = await tmp();
  t.after(f.cleanup);
  const changes = [];
  const store = createTuningStore({ file: f.file, env: { MIN_BRIGHTNESS: '5', FLUSH_MS: 'soon' }, log: () => {}, onChange: (v) => changes.push(v) });
  let values = store.load();
  assert.equal(values.minBrightness, 5);
  assert.equal(values.flushMs, 200, 'a bad environment value falls back to the default');
  assert.equal(store.snapshot().source.minBrightness, 'environment');

  const r = await store.save({ brightnessGain: 1.5, flushMs: 200, minBrightness: 5 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.changed, ['brightnessGain']);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { brightnessGain: 1.5 }, 'values equal to the base are not pinned');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].brightnessGain, 1.5);
  assert.equal(store.snapshot().source.brightnessGain, 'page');

  // A restart reads it back.
  values = createTuningStore({ file: f.file, env: {} }).load();
  assert.equal(values.brightnessGain, 1.5);
});

test('a refused save changes nothing, on disk or live', async (t) => {
  const f = await tmp();
  t.after(f.cleanup);
  let applied = 0;
  const store = createTuningStore({ file: f.file, env: {}, onChange: () => { applied += 1; } });
  store.load();
  const r = await store.save({ brightnessGain: 1.2, flushMs: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 400);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(applied, 0);
  assert.equal(store.values().brightnessGain, 1);
});

test('undo puts back the settings before the last save, once', async (t) => {
  const f = await tmp();
  t.after(f.cleanup);
  const store = createTuningStore({ file: f.file, env: {} });
  store.load();
  assert.equal((await store.undo()).code, 409);
  await store.save({ colourGain: 2 });
  await store.save({ colourGain: 3, rampEveryReports: 4 });
  const u = await store.undo();
  assert.equal(u.ok, true);
  assert.deepEqual([store.values().colourGain, store.values().rampEveryReports], [2, 2]);
  assert.equal(store.snapshot().can_undo, false);
});

test('reset one setting or all of them', async (t) => {
  const f = await tmp();
  t.after(f.cleanup);
  const logs = [];
  const store = createTuningStore({ file: f.file, env: {}, log: (e) => logs.push(e) });
  store.load();
  await store.save({ colourGain: 2, staleMs: 3000 });
  await store.reset(['colourGain']);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { staleMs: 3000 });
  await store.reset();
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), {});
  assert.equal((await store.reset(['nope'])).code, 400);
  const reset = logs.filter((e) => e.kind === 'tuning' && e.action === 'reset');
  assert.deepEqual(reset.at(-1).changed, { staleMs: { from: 3000, to: 1500 } }, 'the capture says what the knobs felt like before and after');
});

test('a damaged file costs only its bad settings, and says so', async (t) => {
  const f = await tmp();
  t.after(f.cleanup);
  fs.writeFileSync(f.file, JSON.stringify({ colourGain: 2, flushMs: -1, typo: 1 }));
  const logs = [];
  const store = createTuningStore({ file: f.file, env: {}, log: (e) => logs.push(e) });
  const values = store.load();
  assert.equal(values.colourGain, 2);
  assert.equal(values.flushMs, 200);
  assert.equal(logs.filter((e) => e.alert === 'tuning_problem').length, 2);

  fs.writeFileSync(f.file, '{ not json');
  const again = createTuningStore({ file: f.file, env: {}, log: () => {} });
  assert.equal(again.load().colourGain, 1);
  assert.match(again.snapshot().problems[0], /not valid JSON/);
});
