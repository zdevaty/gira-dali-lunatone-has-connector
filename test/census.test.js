import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCensus } from '../lib/census.js';

const input = (address, extra = {}) => ({
  kind: 'inputEvent', scheme: 'device_instance', address, target: `short${address}`, ...extra,
});

test('a knob that is turned appears, with what it last did', () => {
  const c = createCensus();
  c.note(input(6, { instanceType: 'generic', event: 'start_right' }));
  c.note(input(6, { instanceType: 'absoluteInput', value: 151 }));

  const [row] = c.list().devices;
  assert.equal(row.address, 6);
  assert.equal(row.target, 'short6');
  assert.equal(row.frames, 2);
  assert.equal(row.last_instance, 'absoluteInput');
  assert.equal(row.last_event, 'value=151', 'so the page can show the counter moving');
});

test('drivers are counted in their own address space', () => {
  const c = createCensus();
  c.note(input(0, { instanceType: 'generic', event: 'start_right' }));
  c.note({ kind: 'level', target: 'short11', level: 128 });
  c.note({ kind: 'colour', target: 'short11', kelvin: 3000 });

  const { devices, gear } = c.list();
  assert.deepEqual(devices.map((d) => d.address), [0]);
  assert.deepEqual(gear.map((g) => g.target), ['short11']);
  assert.equal(gear[0].frames, 2);
  assert.equal(gear[0].last_level, 128);
  assert.equal(gear[0].last_kelvin, 3000);
  assert.equal(c.counts().devices, 1, 'a knob at A0 says nothing about which driver its room uses');
});

test('broadcast and group frames are listed but marked as identifying nobody', () => {
  const c = createCensus();
  c.note({ kind: 'level', target: 'broadcast', level: 254 });
  c.note({ kind: 'level', target: 'group3', level: 100 });
  c.note({ kind: 'level', target: 'short7', level: 50 });

  const byTarget = Object.fromEntries(c.list().gear.map((g) => [g.target, g.addressable]));
  assert.equal(byTarget.broadcast, false);
  assert.equal(byTarget.group3, false);
  assert.equal(byTarget.short7, true);
});

test('an event scheme without an address never invents a row', () => {
  const c = createCensus();
  c.note({ kind: 'inputEvent', scheme: 'instance', instanceType: 'pushButton', event: 'pressed' });
  assert.deepEqual(c.list().devices, [], 'guessing an address here is how a light moves on its own');
});

test('rows age, so the page can show what just spoke', () => {
  let t = 0;
  const c = createCensus({ now: () => t });
  c.note(input(3, { instanceType: 'generic', event: 'stop' }));
  t += 8000;
  c.note(input(4, { instanceType: 'generic', event: 'stop' }));

  const rows = Object.fromEntries(c.list().devices.map((d) => [d.address, d.last_seen_age_s]));
  assert.equal(rows[3], 8);
  assert.equal(rows[4], 0);
});

test('malformed events cannot break the census', () => {
  const c = createCensus();
  for (const bad of [null, undefined, {}, { kind: 'level' }, { kind: 'inputEvent' }, 'x']) {
    assert.doesNotThrow(() => c.note(bad));
  }
  assert.deepEqual(c.counts(), { devices: 0, gear: 0 });
});
