import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDeviceStore, validateDeviceMap } from '../lib/devices.js';

async function tmpStore(initial) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dali-dev-'));
  const file = path.join(dir, 'devices.json');
  if (initial !== undefined) fs.writeFileSync(file, typeof initial === 'string' ? initial : JSON.stringify(initial));
  const logs = [];
  const changes = [];
  const store = createDeviceStore({ file, log: (e) => logs.push(e), onChange: (m) => changes.push(m) });
  return { dir, file, store, logs, changes, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

const good = { entity: 'light.bedroom', min_kelvin: 2700, max_kelvin: 6500, gear: 'short11' };

test('a valid map loads', async () => {
  const h = await tmpStore({ 6: good });
  const { map, problems } = h.store.load();
  assert.deepEqual(problems, []);
  assert.equal(map['6'].entity, 'light.bedroom');
  assert.equal(map['6'].gear, 'short11');
  await h.cleanup();
});

test('one bad entry disables one knob, not every knob', async () => {
  const h = await tmpStore({ 0: good, 1: { min_kelvin: 3000 }, nine: good, 99: good });
  const { map, problems } = h.store.load();
  assert.deepEqual(Object.keys(map), ['0'], 'the good entry survives');
  assert.equal(problems.length, 3);
  assert.ok(problems.some((p) => p.includes('"1" has no "entity"')));
  assert.ok(problems.some((p) => p.includes('"nine" is not a short address')));
  assert.ok(problems.some((p) => p.includes('"99" is above the highest short address')));
  await h.cleanup();
});

test('a missing map is a normal state on a fresh install, not an error', async () => {
  const h = await tmpStore(undefined);
  const { map, problems } = h.store.load();
  assert.deepEqual(map, {});
  assert.match(problems[0], /turn a knob/, 'and it says what to do about it');
  await h.cleanup();
});

test('corrupt JSON does not stop the daemon', async () => {
  const h = await tmpStore('{ not json');
  const { map, problems } = h.store.load();
  assert.deepEqual(map, {});
  assert.match(problems[0], /not valid JSON/);
  await h.cleanup();
});

test('gear is never guessed', async () => {
  const h = await tmpStore({ 0: { entity: 'light.x' }, 1: { entity: 'light.y', gear: 'A7' } });
  const { map, problems } = h.store.load();
  assert.equal(map['0'].gear, null, 'no default: the two address spaces are numbered independently');
  assert.equal(map['1'].gear, null, '"A7" is not a short address');
  assert.ok(problems.some((p) => p.includes('not a short address')));
  await h.cleanup();
});

test('a nonsense kelvin range falls back rather than inverting', async () => {
  const h = await tmpStore({ 0: { entity: 'light.x', min_kelvin: 6500, max_kelvin: 2700 } });
  const { map, problems } = h.store.load();
  assert.equal(map['0'].min_kelvin, 2700);
  assert.equal(map['0'].max_kelvin, 6500);
  assert.ok(problems.some((p) => p.includes('min_kelvin >= max_kelvin')));
  await h.cleanup();
});

test('saving is atomic and keeps the previous version', async () => {
  const h = await tmpStore({ 0: good });
  h.store.load();

  const res = await h.store.save({ 0: good, 6: { entity: 'light.kitchen' } });
  assert.equal(res.ok, true);
  assert.equal(Object.keys(h.store.get()).length, 2, 'reloaded in place, no restart');
  assert.deepEqual(h.changes.at(-1), h.store.get(), 'and the controller is told');

  const bak = JSON.parse(fs.readFileSync(`${h.file}.bak`, 'utf8'));
  assert.deepEqual(Object.keys(bak), ['0'], 'the version before the save is recoverable');
  assert.ok(!fs.existsSync(`${h.file}.tmp`), 'no temp file left behind');
  await h.cleanup();
});

test('the saved file is readable JSON a person can edit', async () => {
  const h = await tmpStore({});
  h.store.load();
  await h.store.save({ 6: { entity: 'light.bedroom' } });
  const text = fs.readFileSync(h.file, 'utf8');
  assert.match(text, /\n {2}"6": \{/, 'indented, not minified');
  assert.match(text, /\n$/, 'and ends with a newline');
  await h.cleanup();
});

test('a save that would produce an empty map is refused', async () => {
  const h = await tmpStore({ 0: good });
  h.store.load();
  const res = await h.store.save({ nonsense: { nope: true } });
  assert.equal(res.ok, false);
  assert.equal(Object.keys(h.store.get()).length, 1, 'the working map is left alone');
  await h.cleanup();
});

test('validate is usable without a file, for checking before saving', () => {
  const { map, problems } = validateDeviceMap({ 3: { entity: 'light.a' }, bad: {} });
  assert.deepEqual(Object.keys(map), ['3']);
  assert.equal(problems.length, 1);
});
