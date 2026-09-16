import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wallTime, zonedToEpoch, parseGatewayDateTime, formatGatewayDateTime, isValidTimeZone,
} from '../lib/zoned-time.js';
import { analyseClock, resolveTargets, describeAutomations, knobsFor } from '../lib/gateway-read.js';

// ── Wall time in a zone ─────────────────────────────────────────────────────

test('a wall time in Prague converts to the right instant, summer and winter', () => {
  assert.equal(new Date(zonedToEpoch({ year: 2026, month: 7, day: 1, hour: 12 }, 'Europe/Prague')).toISOString(), '2026-07-01T10:00:00.000Z');
  assert.equal(new Date(zonedToEpoch({ year: 2026, month: 1, day: 1, hour: 12 }, 'Europe/Prague')).toISOString(), '2026-01-01T11:00:00.000Z');
  const w = wallTime(Date.parse('2026-09-16T17:30:05Z'), 'Europe/Prague');
  assert.deepEqual(w, { year: 2026, month: 9, day: 16, hour: 19, minute: 30, second: 5, weekday: 'wednesday' });
});

test('across a DST change the conversion still lands on a real instant', () => {
  // 29 Mar 2026: 02:00 does not exist in Prague; 03:00 does.
  const skipped = zonedToEpoch({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, 'Europe/Prague');
  const w = wallTime(skipped, 'Europe/Prague');
  assert.ok(w.hour === 1 || w.hour === 3, `landed at ${w.hour}:${w.minute}`);
  const after = zonedToEpoch({ year: 2026, month: 3, day: 29, hour: 3, minute: 30 }, 'Europe/Prague');
  assert.equal(new Date(after).toISOString(), '2026-03-29T01:30:00.000Z');
});

test('the gateway\'s date and time are read in the shapes worth accepting, and nothing else', () => {
  assert.deepEqual(parseGatewayDateTime('2026-09-16', '19:49:39').wall, { year: 2026, month: 9, day: 16, hour: 19, minute: 49, second: 39 });
  assert.equal(parseGatewayDateTime('16.09.2026', '19:49').dateShape, 'dotted');
  // Firmware 1.18.7/1.4.6, as reported by the real gateway.
  const real = parseGatewayDateTime('14. February 2019', '13:05:08');
  assert.deepEqual(real.wall, { year: 2019, month: 2, day: 14, hour: 13, minute: 5, second: 8 });
  assert.equal(real.dateShape, 'dayMonthName');
  assert.equal(parseGatewayDateTime('4. march 2019', '13:05:08').wall.month, 3);
  assert.equal(parseGatewayDateTime('14. Febtober 2019', '13:05:08'), null);
  assert.equal(parseGatewayDateTime('2026-09-16', '19:49:39.123').timeShape, 'hms');
  // Ambiguous or strange: not guessed at.
  assert.equal(parseGatewayDateTime('09/16/2026', '19:49:39'), null);
  assert.equal(parseGatewayDateTime('2026-13-01', '10:00:00'), null);
  assert.equal(parseGatewayDateTime('2026-09-16', '7pm'), null);
  assert.equal(parseGatewayDateTime(null, '10:00'), null);
});

test('the clock is written back in the format it was read in', () => {
  const at = Date.parse('2026-09-16T17:30:05Z');
  assert.deepEqual(formatGatewayDateTime(at, 'Europe/Prague', { dateShape: 'iso', timeShape: 'hms' }), { date: '2026-09-16', time: '19:30:05' });
  assert.deepEqual(formatGatewayDateTime(at, 'Europe/Prague', { dateShape: 'dotted', timeShape: 'hm' }), { date: '16.09.2026', time: '19:30' });
  assert.deepEqual(formatGatewayDateTime(at, 'Europe/Prague', { dateShape: 'dayMonthName', timeShape: 'hms' }), { date: '16. September 2026', time: '19:30:05' });
  assert.equal(formatGatewayDateTime(Date.parse('2026-03-04T12:00:00Z'), 'UTC', { dateShape: 'dayMonthName', timeShape: 'hms' }).date, '4. March 2026');
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
});

// ── Clock ───────────────────────────────────────────────────────────────────

test('drift is the gateway ahead of us, in seconds, by its own zone', () => {
  const now = Date.parse('2026-09-16T17:30:00Z');
  const c = analyseClock({ timezone: 'Europe/Prague', automatic_time: false, date: '2026-09-16', time: '19:32:00' }, now);
  assert.equal(c.recognised, true);
  assert.equal(c.drift_s, 120);
  const slow = analyseClock({ timezone: 'UTC', date: '2026-09-16', time: '17:29:30' }, now);
  assert.equal(slow.drift_s, -30);
});

test('a clock that cannot be read says why instead of reporting a drift', () => {
  const now = Date.now();
  assert.match(analyseClock({ timezone: 'Nowhere/City', date: '2026-09-16', time: '10:00:00' }, now).problem, /unknown time zone/);
  assert.match(analyseClock({ timezone: 'UTC', date: 'Wednesday', time: '10:00' }, now).problem, /unrecognised/);
  assert.equal(analyseClock({}, now).drift_s, null);
});

// ── Targets and automations ─────────────────────────────────────────────────

const devices = [
  { id: 1, name: 'Kitchen', address: 0, line: 0, groups: [0, 4] },
  { id: 2, name: 'Hall', address: 1, line: 0, groups: [4] },
  { id: 3, name: 'Line 1 lamp', address: 0, line: 1, groups: [4] },
];

test('group and broadcast ids are line-qualified, as the gateway documents', () => {
  assert.deepEqual(resolveTargets([{ type: 'group', id: 4 }], { devices }).devices.map((d) => d.id), [1, 2]);
  assert.deepEqual(resolveTargets([{ type: 'group', id: 20 }], { devices }).devices.map((d) => d.id), [3]);
  assert.deepEqual(resolveTargets([{ type: 'broadcast', id: 1 }], { devices }).devices.map((d) => d.id), [3]);
  assert.equal(resolveTargets([{ type: 'group', id: 20 }], { devices }).labels[0], 'group 4 on line 1');
});

test('a zone reaches its own targets, and an unknown target reaches nothing', () => {
  const zones = [{ id: 9, name: 'Downstairs', targets: [{ type: 'device', id: 2 }] }];
  const r = resolveTargets([{ type: 'zone', id: 9 }, { type: 'daliGear', id: 5 }, { type: 'device', id: 99 }], { devices, zones });
  assert.deepEqual(r.devices.map((d) => d.id), [2]);
  assert.deepEqual(r.labels, ['zone “Downstairs”', 'daliGear 5', 'device 99 (not in the device list)']);
});

test('knobs are only found through a known driver, and only on line 0', () => {
  const map = { 5: { entity: 'light.kitchen', gear: 'short0' }, 6: { entity: 'light.hall' } };
  assert.deepEqual(knobsFor(devices[0], map), [{ knob: 5, entity: 'light.kitchen' }]);
  assert.deepEqual(knobsFor(devices[1], map), [], 'no driver in the map, no claim');
  assert.deepEqual(knobsFor(devices[2], map), [], 'the map carries no line');
});

test('an automation that changes a knob-driven light says which knob', () => {
  const autos = {
    schedules: [{ id: 1, name: 'Morning', enabled: true, recallMode: 'timeOfDay', recallTime: { hour: 7, minute: 0 },
      activeWeekdays: { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false },
      targets: [{ type: 'group', id: 4 }], action: { type: 'features', data: { dimmable: 60 } } }],
    sequences: [{ id: 2, active: false, name: 'Party', steps: [{ type: 'features', data: { targets: [{ type: 'device', id: 2 }], features: {} } }], isMacro: false, loop: true }],
    trigger_actions: [{ id: 3, enabled: false, name: 'Mirror', sources: [{ type: 'd16gear', address: 20, line: 0 }], targets: [{ type: 'device', id: 1 }] }],
    event_trigger_actions: [{ id: 4, enabled: true, source_line: 0, target_lines: [1], filters: { instanceType: [3] } }],
  };
  const out = describeAutomations(autos, { devices, deviceMap: { 5: { entity: 'light.kitchen', gear: 'short0' } } });
  const morning = out.find((a) => a.name === 'Morning');
  assert.equal(morning.summary, 'at 07:00, mon tue wed thu fri → dimmable 60');
  assert.deepEqual(morning.knobs, [{ knob: 5, entity: 'light.kitchen', device: '“Kitchen” (A0)' }]);
  assert.match(out.find((a) => a.kind === 'sequence').summary, /1 step, loops/);
  assert.equal(out.find((a) => a.kind === 'trigger_action').enabled, false);
  assert.match(out.find((a) => a.kind === 'trigger_action').summary, /address 20 on line 0/);
  assert.match(out.find((a) => a.kind === 'event_trigger_action').summary, /line 0 to line 1 \(instanceType 3\)/);
});
