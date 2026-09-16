import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayWatch, dueSchedules, scheduleActiveOn, VERIFIED_FIRMWARE } from '../lib/gateway-watch.js';
import { createGatewayTelemetry, summariseDiagnostics } from '../lib/gateway-telemetry.js';
import { createGatewayLiveness } from '../lib/liveness.js';

const WEEKDAYS_OFF = { saturday: false, sunday: false };

// ── Schedules ───────────────────────────────────────────────────────────────

test('a schedule applies by weekday, month, day list and period, and absent fields restrict nothing', () => {
  const wed = { year: 2026, month: 9, day: 16, weekday: 'wednesday' };
  const sat = { year: 2026, month: 9, day: 19, weekday: 'saturday' };
  assert.equal(scheduleActiveOn({}, wed), true);
  assert.equal(scheduleActiveOn({ enabled: false }, wed), false);
  assert.equal(scheduleActiveOn({ activeWeekdays: WEEKDAYS_OFF }, sat), false);
  assert.equal(scheduleActiveOn({ activeMonths: { september: false } }, wed), false);
  assert.equal(scheduleActiveOn({ activeDays: { days: [1, 15] } }, wed), false);
  assert.equal(scheduleActiveOn({ activePeriod: { startMonth: 11, startDay: 1, endMonth: 2, endDay: 28 } }, wed), false, 'winter only');
  assert.equal(scheduleActiveOn({ activePeriod: { startMonth: 11, startDay: 1, endMonth: 2, endDay: 28 } }, { ...wed, month: 1, day: 5 }), true, 'across new year');
});

test('a schedule is due by the gateway clock, in its zone, corrected for its drift', () => {
  const nowMs = Date.parse('2026-09-16T04:50:00Z'); // 06:50 in Prague
  const schedules = [
    { id: 1, name: 'Morning', recallMode: 'timeOfDay', recallTime: { hour: 7, minute: 0 } },
    { id: 2, name: 'Sunrise', recallMode: 'afterSunrise', recallTime: { hour: 0, minute: 10 } },
    { id: 3, name: 'Evening', recallMode: 'timeOfDay', recallTime: { hour: 19, minute: 0 } },
  ];
  const due = dueSchedules(schedules, { nowMs, timeZone: 'Europe/Prague', driftS: 0, horizonMs: 15 * 60_000 });
  assert.deepEqual(due.map((d) => [d.schedule.id, new Date(d.at).toISOString()]), [[1, '2026-09-16T05:00:00.000Z']]);

  // A gateway two minutes fast gets there two minutes early by our clock.
  const fast = dueSchedules(schedules, { nowMs, timeZone: 'Europe/Prague', driftS: 120, horizonMs: 15 * 60_000 });
  assert.equal(new Date(fast[0].at).toISOString(), '2026-09-16T04:58:00.000Z');
});

test('just before midnight, tomorrow morning\'s schedule is still found', () => {
  const nowMs = Date.parse('2026-09-16T21:55:00Z'); // 23:55 in Prague
  const due = dueSchedules([{ id: 1, recallTime: { hour: 0, minute: 5 } }], { nowMs, timeZone: 'Europe/Prague', horizonMs: 15 * 60_000 });
  assert.equal(new Date(due[0].at).toISOString(), '2026-09-16T22:05:00.000Z');
});

// ── The watch ───────────────────────────────────────────────────────────────

function fakeReader({ datetime, version = VERIFIED_FIRMWARE, schedules = [] }) {
  return {
    datetime: async () => ({ ok: true, value: datetime() }),
    info: async () => ({ ok: true, value: { version } }),
    automations: async () => ({ schedules, circadians: [], sequences: [], trigger_actions: [], event_trigger_actions: [], errors: {} }),
    devices: async () => ({ ok: true, value: [{ id: 1, name: 'Hall', address: 3, line: 0, groups: [] }] }),
    zones: async () => ({ ok: true, value: [] }),
  };
}

function timers() {
  let t = Date.parse('2026-09-16T04:50:00Z');
  const list = new Map();
  let id = 0;
  return {
    now: () => t,
    setTimer: (fn, ms) => { id += 1; list.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (i) => list.delete(i),
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...list.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        list.delete(next[0]);
        t = next[1].at;
        next[1].fn();
        for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      }
      t = end;
    },
  };
}

test('a drifting gateway clock is one alert, and one more when it is right again', async () => {
  const clock = timers();
  let offsetS = 300;
  const iso = () => new Date(clock.now() + offsetS * 1000).toISOString();
  const logs = [];
  const watch = createGatewayWatch({
    reader: fakeReader({ datetime: () => ({ timezone: 'UTC', automatic_time: false, date: iso().slice(0, 10), time: iso().slice(11, 19) }) }),
    log: (e) => logs.push(e), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  await watch.round();
  await watch.round();
  assert.deepEqual(logs.filter((e) => e.alert).map((e) => [e.alert, e.drift_s]), [['gateway_clock_drift', 300]]);
  offsetS = 1;
  await watch.round();
  assert.deepEqual(logs.filter((e) => e.alert).map((e) => e.alert), ['gateway_clock_drift', 'gateway_clock_ok']);
});

test('an unverified firmware and an unreadable clock are each said once', async () => {
  const clock = timers();
  const logs = [];
  const watch = createGatewayWatch({
    reader: fakeReader({ datetime: () => ({ timezone: 'UTC', date: 'Wednesday', time: 'noon' }), version: 'v2.0.0/2.0.0' }),
    log: (e) => logs.push(e), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  await watch.round();
  await watch.round();
  assert.deepEqual(logs.map((e) => e.alert), ['gateway_firmware_unverified', 'gateway_clock_unreadable']);
});

test('a due schedule is marked once, when it is due, and not claimed as ours', async () => {
  const clock = timers();
  const logs = [];
  const iso = () => new Date(clock.now()).toISOString();
  const watch = createGatewayWatch({
    reader: fakeReader({
      datetime: () => ({ timezone: 'Europe/Prague', automatic_time: true, date: iso().slice(0, 10), time: new Date(clock.now() + 7_200_000).toISOString().slice(11, 19) }),
      schedules: [{ id: 5, name: 'Morning', enabled: true, recallMode: 'timeOfDay', recallTime: { hour: 7, minute: 0 }, targets: [{ type: 'device', id: 1 }], action: { type: 'features', data: { dimmable: 80 } } }],
    }),
    deviceMap: () => ({ 9: { entity: 'light.hall', gear: 'short3' } }),
    log: (e) => logs.push(e), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    startDelayMs: 0,
  });
  watch.start();
  await clock.advance(5 * 60_000);
  assert.equal(watch.snapshot().upcoming.length, 1);
  assert.equal(logs.filter((e) => e.kind === 'gateway_automation').length, 0);
  await clock.advance(6 * 60_000);
  const markers = logs.filter((e) => e.kind === 'gateway_automation');
  assert.equal(markers.length, 1);
  assert.equal(new Date(markers[0].ts ?? clock.now()).getTime() >= Date.parse('2026-09-16T05:00:00Z'), true);
  assert.deepEqual(markers[0].knobs, ['A9 → light.hall']);
  assert.match(markers[0].note, /did not send it/);
  await clock.advance(60 * 60_000);
  assert.equal(logs.filter((e) => e.kind === 'gateway_automation').length, 1, 'replanning does not mark it twice');
  watch.stop();
});

// ── Bus power ───────────────────────────────────────────────────────────────

test('bus power lost, low and restored are alerts on change, not every probe', async () => {
  let lines = { 0: { lineStatus: 'ok', sendBufferFull: false } };
  const logs = [];
  const live = createGatewayLiveness({
    host: 'gw',
    log: (e) => logs.push(e),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: 'v', errors: {}, lines }) }),
    setTimer: () => null, clearTimer: () => {},
  });
  await live.probe();
  assert.deepEqual(live.snapshot().lines, { 0: { status: 'ok', blocked: [] } });
  lines = { 0: { lineStatus: 'noPower', sendBufferFull: false } };
  await live.probe();
  await live.probe();
  lines = { 0: { lineStatus: 'lowPower', sendBlockedQuiescent: true } };
  await live.probe();
  lines = { 0: { lineStatus: 'ok' } };
  await live.probe();
  assert.deepEqual(logs.filter((e) => e.kind === 'alert' && e.alert !== 'gateway_bus_errors_cleared').map((e) => e.alert), [
    'dali_bus_power_lost', 'dali_bus_power_low', 'gateway_send_blocked', 'dali_bus_power_restored', 'gateway_send_unblocked',
  ]);
});

test('a line that is down at startup is said at once', async () => {
  const logs = [];
  const live = createGatewayLiveness({
    host: 'gw', log: (e) => logs.push(e),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ lines: { 0: { lineStatus: 'notReachable' } } }) }),
    setTimer: () => null, clearTimer: () => {},
  });
  await live.probe();
  assert.equal(logs.find((e) => e.kind === 'alert').alert, 'dali_line_unreachable');
});

// ── Telemetry ───────────────────────────────────────────────────────────────

test('diagnostics are summarised in hours, kWh and plain failure names', () => {
  const s = summariseDiagnostics({
    energy: { supported: true, data: { activeEnergyWattHours: 12345, activePowerWatt: 7.5 } },
    diagnostics: { supported: true, data: { lightSourceOnTimeSeconds: 36_000_000, ratedMedianUsefulLifeOfLuminaireHours: 50_000, controlGearTemperatureCelsius: 48, lightSourceOpenCircuit: true, controlGearThermalDerating: false } },
  });
  assert.equal(s.energy_kwh, 12.345);
  assert.equal(s.light_on_hours, 10_000);
  assert.equal(s.life_used_percent, 20);
  assert.deepEqual(s.failures, ['lightSourceOpenCircuit']);
});

function telemetryHarness({ gestureAgoMs = null, busy = () => null } = {}) {
  const clock = timers();
  const reads = [];
  const admin = {
    busy,
    readDiagnostics: async (id, opts) => {
      reads.push([id, opts.scheduled, clock.now()]);
      return { ok: true, energy: { supported: true, data: { activeEnergyWattHours: 1000 * id, activePowerWatt: id } }, diagnostics: { supported: false, data: null, error: null } };
    },
  };
  const reader = {
    devices: async () => ({ ok: true, value: [{ id: 1, name: 'Kitchen', address: 0, line: 0 }, { id: 2, name: 'Hall', address: 1, line: 0 }, { id: 3, name: 'Unaddressed', address: null }] }),
    sensors: async () => ({ ok: true, value: [
      { id: 7, name: 'Hall motion', unit: '', type: 'occupancy', value: 1, timestamp: 't', addressType: 'dali', daliSensorAddress: { line: 0, address: 5, instanceNumber: 1 } },
      { id: 8, name: 'Hall lux', unit: 'lx', type: 'light', value: 312, timestamp: 't', addressType: 'dali' },
    ] }),
  };
  const logs = [];
  const monotonic = { t: 0 };
  const telemetry = createGatewayTelemetry({
    admin, reader, log: (e) => logs.push(e), intervalHours: 24,
    lastGestureAt: () => (gestureAgoMs === null ? null : -gestureAgoMs),
    now: () => monotonic.t, wall: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    pauseMs: 1000, retryMs: 30_000,
  });
  return { telemetry, reads, clock, logs, monotonic };
}

test('the scheduled read is off unless an interval is set, and then waits ten minutes after start', async () => {
  const h = telemetryHarness();
  h.telemetry.start();
  await h.clock.advance(9 * 60_000);
  assert.equal(h.reads.length, 0);
  await h.clock.advance(4 * 60 * 60_000);
  assert.deepEqual(h.reads.map((r) => [r[0], r[1]]), [[1, true], [2, true]], 'addressed drivers only, flagged as scheduled');
  h.telemetry.stop();

  const off = createGatewayTelemetry({ admin: { busy: () => null, readDiagnostics: async () => { throw new Error('must not run'); } }, reader: {}, intervalHours: 0 });
  off.start();
  off.stop();
});

test('a scheduled read waits while a knob is in use or the bus is busy, and gives up after a while', async () => {
  let busy = 'identify';
  // A knob used ten seconds before the pass is due.
  const h = telemetryHarness({ gestureAgoMs: 10_000, busy: () => busy });
  h.telemetry.start();
  // The first pass is due at a tenth of the interval: 2.4 hours.
  await h.clock.advance(2.4 * 3_600_000 + 2 * 60_000);
  assert.equal(h.reads.length, 0, 'held back');
  // The knob was long ago, but the bus is still ours.
  h.monotonic.t += 10 * 60_000;
  await h.clock.advance(60_000);
  assert.equal(h.reads.length, 0, 'still held back by the bus');
  busy = null;
  await h.clock.advance(60_000);
  assert.equal(h.reads.length >= 1, true, 'quiet: the pass goes ahead');
  h.telemetry.stop();

  const stuck = telemetryHarness({ gestureAgoMs: null, busy: () => 'scan' });
  stuck.telemetry.start();
  await stuck.clock.advance(2.4 * 3_600_000 + 11 * 60_000);
  assert.equal(stuck.reads.length, 0);
  assert.ok(stuck.logs.some((e) => e.alert === 'diagnostics_pass_abandoned'));
  stuck.telemetry.stop();
});

test('readings and sensors become Home Assistant entities with the right classes', async () => {
  const h = telemetryHarness();
  await h.telemetry.read(1);
  await h.telemetry.pollSensorsOnce();
  const states = Object.fromEntries(h.telemetry.haStates().map((s) => [s.entity_id, s]));
  assert.deepEqual(Object.keys(states).sort(), [
    'binary_sensor.dali_bridge_sensor_7',
    'sensor.dali_bridge_l0_a0_energy',
    'sensor.dali_bridge_l0_a0_power',
    'sensor.dali_bridge_sensor_8',
  ]);
  assert.equal(states['sensor.dali_bridge_l0_a0_energy'].state, 1);
  assert.equal(states['sensor.dali_bridge_l0_a0_energy'].attributes.state_class, 'total_increasing');
  assert.equal(states['sensor.dali_bridge_l0_a0_energy'].attributes.friendly_name, 'Kitchen energy');
  assert.equal(states['binary_sensor.dali_bridge_sensor_7'].state, 'on');
  assert.equal(states['binary_sensor.dali_bridge_sensor_7'].attributes.device_class, 'occupancy');
  assert.equal(states['sensor.dali_bridge_sensor_8'].attributes.device_class, 'illuminance');
  assert.equal(states['sensor.dali_bridge_sensor_8'].attributes.unit_of_measurement, 'lx');
});
