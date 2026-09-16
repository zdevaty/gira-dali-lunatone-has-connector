// Things about the gateway worth noticing without anyone asking. GETs only.
//
//   - Its clock. It runs its own schedules by it, in its own time zone, so a
//     gateway an hour out switches the hall light on an hour out, and nothing
//     in the bus capture would say why.
//   - Its firmware, against the one this bridge's decoder was checked with.
//   - Its time-of-day schedules. When one is due, a marker goes into the event
//     stream. The marker does not claim the frames that follow are the
//     schedule's; it says the gateway was due to act, so that a light changing
//     at 07:00 with no knob and no Home Assistant call has an explanation to
//     look at. Sunrise and sunset schedules are not marked: that would mean
//     computing the gateway's idea of sunrise, and a wrong marker is worse
//     than none.

import { analyseClock, createGatewayReader, describeAutomations, WEEKDAYS } from './gateway-read.js';
import { wallTime, zonedToEpoch } from './zoned-time.js';

export const VERIFIED_FIRMWARE = 'v1.18.7/1.4.6';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// Whether a schedule applies on a day, by the gateway's calendar. Absent
// fields restrict nothing.
export function scheduleActiveOn(s, { year, month, day, weekday }) {
  if (s.enabled === false) return false;
  if (s.activeWeekdays && s.activeWeekdays[weekday] === false) return false;
  if (s.activeMonths && s.activeMonths[MONTHS[month - 1]] === false) return false;
  const days = s.activeDays?.days;
  if (Array.isArray(days) && days.length && !days.includes(day)) return false;
  const p = s.activePeriod;
  if (p && Number.isInteger(p.startMonth) && Number.isInteger(p.endMonth)) {
    const md = month * 100 + day;
    const start = p.startMonth * 100 + (p.startDay ?? 1);
    const end = p.endMonth * 100 + (p.endDay ?? 31);
    const inside = start <= end ? md >= start && md <= end : md >= start || md <= end;
    if (!inside) return false;
  }
  void year;
  return true;
}

// When, by OUR clock, each time-of-day schedule next fires by the gateway's
// clock, within `horizonMs`. Drift is the gateway's lead over us in seconds.
export function dueSchedules(schedules, { nowMs, timeZone, driftS = 0, horizonMs }) {
  const out = [];
  const driftMs = driftS * 1000;
  // Today and tomorrow on the gateway's calendar cover any horizon under a day.
  const gatewayNow = nowMs + driftMs;
  for (let offsetDays = 0; offsetDays <= 1; offsetDays++) {
    const w = wallTime(gatewayNow + offsetDays * 86_400_000, timeZone);
    for (const s of schedules) {
      if ((s.recallMode ?? 'timeOfDay') !== 'timeOfDay' || !s.recallTime) continue;
      if (!scheduleActiveOn(s, w)) continue;
      const t = s.recallTime;
      const gatewayAt = zonedToEpoch({ year: w.year, month: w.month, day: w.day, hour: t.hour ?? 0, minute: t.minute ?? 0, second: t.second ?? 0 }, timeZone);
      const ourAt = gatewayAt - driftMs;
      if (ourAt > nowMs && ourAt <= nowMs + horizonMs) out.push({ schedule: s, at: ourAt, day: `${w.year}-${w.month}-${w.day}` });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export function createGatewayWatch({
  host,
  reader = null,
  ha = null,
  deviceMap = () => ({}),
  log = () => {},
  now = Date.now,
  clockEveryMs = 3_600_000,
  driftAlertS = 60,
  horizonMs = 15 * 60_000,
  startDelayMs = 20_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const gw = reader ?? createGatewayReader({ host });
  const timers = new Set();
  let stopped = false;
  let clock = null;
  let driftReported = false;
  let unreadableReported = false;
  let zoneMismatchReported = false;
  let firmware = null;
  let upcoming = [];
  // Planned once each: the plan is redone every horizon, and a schedule due
  // right at its edge must neither be dropped nor marked twice.
  const planned = new Map();

  function later(fn, ms) {
    if (stopped) return null;
    const t = setTimer(() => { timers.delete(t); fn(); }, ms);
    t?.unref?.();
    timers.add(t);
    return t;
  }

  async function checkClock() {
    const raw = await gw.datetime();
    if (!raw.ok) return clock;
    clock = { ...analyseClock(raw.value, now()), checked_at: new Date(now()).toISOString() };

    if (!clock.recognised) {
      if (!unreadableReported) {
        unreadableReported = true;
        log({ kind: 'alert', alert: 'gateway_clock_unreadable', problem: clock.problem,
          note: 'the clock and schedule markers are off until this is understood; nothing else is affected' });
      }
      return clock;
    }
    const off = Math.abs(clock.drift_s) >= driftAlertS;
    if (off && !driftReported) {
      driftReported = true;
      log({ kind: 'alert', alert: 'gateway_clock_drift', drift_s: clock.drift_s, timezone: clock.timezone,
        automatic_time: clock.automatic_time,
        note: 'the gateway runs its schedules by this clock; set it on the Gateway page' });
    } else if (!off && driftReported) {
      driftReported = false;
      log({ kind: 'alert', alert: 'gateway_clock_ok', drift_s: clock.drift_s });
    }

    if (ha && !zoneMismatchReported) {
      const cfg = await ha.getConfig();
      if (cfg?.time_zone && clock.timezone && cfg.time_zone !== clock.timezone) {
        zoneMismatchReported = true;
        log({ kind: 'alert', alert: 'gateway_timezone_mismatch', gateway: clock.timezone, home_assistant: cfg.time_zone });
      }
    }
    return clock;
  }

  async function checkFirmware() {
    const info = await gw.info();
    if (!info.ok) return;
    const version = info.value.version ?? null;
    if (version === firmware) return;
    firmware = version;
    if (version && version !== VERIFIED_FIRMWARE) {
      log({ kind: 'alert', alert: 'gateway_firmware_unverified', version, verified: VERIFIED_FIRMWARE,
        note: 'the bus decoder was checked against the verified version; frames it does not know stay unknown, but watch for them' });
    }
  }

  async function planMarkers() {
    for (const [key, p] of planned) if (p.at < now() - 2 * 86_400_000) planned.delete(key);
    upcoming = [...planned.values()].filter((p) => p.at >= now()).map((p) => p.info);
    if (!clock?.recognised) return;
    const [autos, devices, zones] = await Promise.all([gw.automations(), gw.devices(), gw.zones()]);
    if (autos.errors.schedules) return;
    const due = dueSchedules(autos.schedules, { nowMs: now(), timeZone: clock.timezone, driftS: clock.drift_s, horizonMs });
    const described = describeAutomations({ schedules: autos.schedules }, {
      devices: devices.value ?? [], zones: zones.value ?? [], deviceMap: deviceMap(),
    });
    for (const { schedule, at, day } of due) {
      // By the gateway's calendar day, so a change in measured drift between
      // two plans cannot plan the same firing twice.
      const key = `${schedule.id}@${day}`;
      if (planned.has(key)) continue;
      const d = described.find((x) => x.id === schedule.id) ?? {};
      const info = { id: schedule.id, name: schedule.name ?? '', at: new Date(at).toISOString() };
      planned.set(key, { at, info });
      upcoming.push(info);
      later(() => {
        log({
          kind: 'gateway_automation', automation: 'schedule', id: schedule.id, name: schedule.name ?? '',
          summary: d.summary ?? null, targets: d.targets ?? [],
          knobs: (d.knobs ?? []).map((k) => `A${k.knob} → ${k.entity}`),
          note: 'due now by the gateway clock; this app did not send it',
        });
      }, at - now());
    }
  }

  async function round() {
    try {
      await checkFirmware();
      await checkClock();
      await planMarkers();
    } catch {
      // A watch is never worth an exception in the bridge.
    }
  }

  function start() {
    later(function tick() {
      round().finally(() => later(tick, Math.min(clockEveryMs, horizonMs)));
    }, startDelayMs);
  }

  // Markers are replanned every horizon, and the clock is checked with them:
  // one /datetime a quarter of an hour, which is cheap.
  function stop() {
    stopped = true;
    for (const t of timers) clearTimer(t);
    timers.clear();
  }

  return {
    start, stop, round, checkClock,
    snapshot: () => ({ clock, firmware, verified_firmware: VERIFIED_FIRMWARE, upcoming }),
  };
}

export { WEEKDAYS };
