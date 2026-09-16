// Everything in the bridge that asks the gateway to put frames on the bus.
//
// Until September 2026 the bus was strictly read-only from here. The exceptions
// agreed since are narrow, and this module is their whole extent:
//
//   - a device scan, in exactly two modes: re-reading the existing addresses
//     (`refresh`) and addressing new, unaddressed devices (`extend`);
//   - a device's name and group membership;
//   - identify: blink one light a few times and put it back as it was;
//   - reading a driver's energy and diagnostics data (DALI parts 252/253),
//     which the gateway does by querying the driver's memory banks;
//   - re-reading a driver's scene levels, and the sensors, from the bus.
//
// Each is started by a person pressing a button. The one exception is the
// diagnostics read, which can also run on a schedule -- but only when the
// `diagnostics_interval_hours` option has been set, which is off by default and
// is that decision being made. Everything else the gateway API offers -- raw
// 16/24-bit frames, group, broadcast and zone control, scene saving, fade
// settings, deleting devices, reset, reboot -- is not reachable: see
// lib/gateway-http.js, which refuses any request not in its table.
//
// A new installation deletes every device the gateway knows and re-addresses
// the whole bus: every knob mapping and every Home Assistant entity would be
// wrong afterwards. An empty scan body is not harmless either -- the gateway's
// defaults run an addressing extension. So every body is built here, in full,
// from a fixed table, and checked again just before it is sent.
//
// One bus activity at a time. Each leaves a settle window behind it, during
// which traffic on the bus is still counted as ours (see `busy`), so that the
// blinking of an identify is never mistaken for a knob calibration and the
// levels of a scan are never learned as a mapping.

import { monotonicNow } from './clock.js';
import { createGatewayHttp, assertSafeGatewayBody } from './gateway-http.js';

const SCAN_BODIES = Object.freeze({
  refresh: Object.freeze({ newInstallation: false, noAddressing: true }),
  extend: Object.freeze({ newInstallation: false, noAddressing: false }),
});

const FINISHED = new Set(['done', 'cancelled', 'bus error', 'not started']);

export const SCAN_MODES = Object.keys(SCAN_BODIES);

export function assertSafeScanBody(body) {
  assertSafeGatewayBody('POST', '/dali/scan', body);
}

export function validateDeviceUpdate(input) {
  const problems = [];
  const update = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, problems: ['the update must be an object'] };
  }
  for (const key of Object.keys(input)) {
    if (key !== 'name' && key !== 'groups') problems.push(`"${key}" cannot be changed from here`);
  }
  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : null;
    if (!name) problems.push('the name must be a non-empty string');
    else if (name.length > 64) problems.push('the name is longer than 64 characters');
    else update.name = name;
  }
  if (input.groups !== undefined) {
    // DALI has sixteen groups, 0-15.
    if (!Array.isArray(input.groups) || !input.groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 15)) {
      problems.push('groups must be a list of whole numbers from 0 to 15');
    } else {
      update.groups = [...new Set(input.groups)].sort((a, b) => a - b);
    }
  }
  if (!problems.length && Object.keys(update).length === 0) problems.push('nothing to change');
  return problems.length ? { ok: false, problems } : { ok: true, update };
}

// What the gateway says a light is doing now, from GET /device/{id}. The
// schema types `features` only as an object; this reads the `status` of the
// `switchable` and `dimmable` features, and anything else is "unknown", which
// refuses the identify rather than risk leaving the light changed.
export function readLightState(features) {
  if (!features || typeof features !== 'object') return null;
  const value = (f) => (f && typeof f === 'object' && 'status' in f ? f.status : f);
  const level = value(features.dimmable);
  const on = value(features.switchable);
  const hasLevel = typeof level === 'number' && Number.isFinite(level);
  if (typeof on === 'boolean') {
    if (on && !hasLevel) return null; // on, at a level we cannot put back
    return { on, level: hasLevel ? level : null };
  }
  if (hasLevel) return { on: level > 0, level };
  return null;
}

export function createGatewayAdmin({
  host,
  http = null,
  log = () => {},
  fetchImpl = fetch,
  timeoutMs = 8000,
  // Reads that the gateway answers by querying the bus take their time.
  busTimeoutMs = 60_000,
  pollMs = 2000,
  maxScanMs = 30 * 60_000,
  // Scan traffic goes on for a little while after the gateway says done.
  settleMs = 10_000,
  identifySettleMs = 3000,
  // One blink: full, then off. Long enough to see through a fade time.
  blinkMs = 700,
  blinks = 3,
  onScanFinished = async () => null,
  now = monotonicNow,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  sleep = (ms) => new Promise((resolve) => { const t = setTimer(resolve, ms); t?.unref?.(); }),
} = {}) {
  if (!host && !http) throw new Error('createGatewayAdmin requires a host');
  const gw = http ?? createGatewayHttp({ host, fetchImpl, timeoutMs });

  let scan = null; // { mode, startedAt, status }
  let lastResult = null;
  let pollTimer = null;
  let finishing = false; // the scan is over, the HA reload is not
  // The other bus activities: { name, id, startedAt }.
  let activity = null;
  // Traffic after an activity ends is still ours until this.
  let settle = { name: null, until: -Infinity };

  const call = (method, path, body, opts) => gw.request(method, path, body, opts);

  function busyWith() {
    if (scan || finishing) return 'scan';
    if (activity) return activity.name;
    return null;
  }

  // What the bus is doing on our behalf right now, including the settle
  // window after it: 'scan', 'identify', 'diagnostics', 'scenes', 'sensors',
  // or null. The frame path reads this.
  function busy() {
    const current = busyWith();
    if (current) return current;
    return now() < settle.until ? settle.name : null;
  }

  function settleAfter(name, ms) {
    const until = now() + ms;
    if (until > settle.until) settle = { name, until };
  }

  async function exclusive(name, detail, fn, { settleMs: after = 0 } = {}) {
    const current = busyWith();
    if (current) return { ok: false, code: 409, error: `the bus is busy with this app's ${current}; try again when it has finished` };
    activity = { name, startedAt: now(), ...detail };
    try {
      return await fn();
    } finally {
      activity = null;
      settleAfter(name, after);
    }
  }

  // ── Reads ────────────────────────────────────────────────────────────────
  async function listDevices() {
    const r = await call('GET', '/devices');
    if (!r.ok) return { reachable: r.status !== null, error: r.error, devices: [] };
    const devices = Array.isArray(r.data?.devices) ? r.data.devices : [];
    return {
      reachable: true,
      error: null,
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name ?? '',
        type: d.type ?? null,
        line: d.line ?? null,
        address: d.address ?? null,
        available: d.available ?? null,
        groups: Array.isArray(d.groups) ? d.groups : [],
        daliTypes: Array.isArray(d.daliTypes) ? d.daliTypes : [],
        status: d.status ?? null,
        identifiable: readLightState(d.features) !== null,
      })),
    };
  }

  // ── Scan ─────────────────────────────────────────────────────────────────
  function scanning() {
    return busy() === 'scan';
  }

  function status() {
    return {
      active: scan !== null,
      finishing,
      settling: scan === null && !finishing && busy() === 'scan',
      mode: scan?.mode ?? null,
      gateway: scan?.status ?? null,
      last: lastResult,
      activity: activity ? { name: activity.name, id: activity.id ?? null } : null,
    };
  }

  async function startScan(mode) {
    if (!Object.hasOwn(SCAN_BODIES, mode)) {
      return { ok: false, code: 400, error: `unknown scan mode "${mode}"; expected ${SCAN_MODES.join(' or ')}` };
    }
    const current = busyWith();
    if (current === 'scan') return { ok: false, code: 409, error: 'a scan is already running' };
    if (current) return { ok: false, code: 409, error: `the bus is busy with this app's ${current}; try again when it has finished` };

    const body = { ...SCAN_BODIES[mode] };
    assertSafeScanBody(body);

    // Claimed before the request, so two presses cannot both get through.
    scan = { mode, startedAt: now(), status: 'starting' };
    log({ kind: 'gateway_write', action: 'scan_start', mode, body, note: 'requested from the panel' });

    const r = await call('POST', '/dali/scan', body);
    if (!r.ok) {
      scan = null;
      const error = r.status === 409 ? 'the gateway is already scanning (started elsewhere?)' : r.error;
      log({ kind: 'alert', alert: 'gateway_scan_failed', mode, error });
      return { ok: false, code: r.status === 409 ? 409 : 502, error };
    }
    scan.status = r.data ?? null;
    schedulePoll();
    return { ok: true, status: status() };
  }

  function schedulePoll() {
    if (pollTimer) clearTimer(pollTimer);
    pollTimer = setTimer(() => { pollTimer = null; poll().catch(() => {}); }, pollMs);
    pollTimer?.unref?.();
  }

  async function poll() {
    if (!scan) return;
    const r = await call('GET', '/dali/scan');
    if (!scan) return; // cancelled while we waited
    if (r.ok) scan.status = r.data ?? null;

    const state = scan.status?.status;
    const overdue = now() - scan.startedAt > maxScanMs;
    if (r.ok && FINISHED.has(state) && state !== 'not started') return finish(state);
    if (overdue) return finish('timed_out');
    schedulePoll();
  }

  async function finish(outcome) {
    const done = scan;
    scan = null;
    settleAfter('scan', settleMs);
    const summary = {
      mode: done.mode,
      outcome,
      found: done.status?.found ?? null,
      found_sensors: done.status?.foundSensors ?? null,
      addressed: Array.isArray(done.status?.lines)
        ? done.status.lines.reduce((a, l) => a + (l.addressed ?? 0), 0)
        : null,
      duration_s: Math.round((now() - done.startedAt) / 1000),
    };
    log({ kind: 'gateway_write', action: 'scan_finished', ...summary });
    if (outcome === 'bus error' || outcome === 'timed_out') {
      log({ kind: 'alert', alert: 'gateway_scan_failed', ...summary });
    }

    let after = null;
    if (outcome === 'done') {
      finishing = true;
      try {
        after = await onScanFinished(summary);
      } catch (err) {
        after = { error: String(err?.message ?? err) };
      } finally {
        finishing = false;
        // The reload can outlast the settle window; the window starts again
        // from the end of it, because the scan's tail is still on the bus.
        settleAfter('scan', settleMs);
      }
    }
    lastResult = { ...summary, after, finished_at: new Date().toISOString() };
  }

  async function cancelScan() {
    if (!scan) return { ok: false, code: 409, error: 'no scan is running' };
    log({ kind: 'gateway_write', action: 'scan_cancel' });
    const r = await call('POST', '/dali/scan/cancel');
    if (!r.ok) return { ok: false, code: 502, error: r.error };
    if (pollTimer) clearTimer(pollTimer);
    pollTimer = null;
    if (scan) {
      scan.status = r.data ?? scan.status;
      await finish('cancelled');
    }
    return { ok: true, status: status() };
  }

  // ── Name and groups ──────────────────────────────────────────────────────
  async function updateDevice(id, input) {
    if (!Number.isInteger(id) || id < 0) return { ok: false, code: 400, problems: ['device id must be a whole number'] };
    const checked = validateDeviceUpdate(input);
    if (!checked.ok) return { ok: false, code: 400, problems: checked.problems };
    const current = busyWith();
    if (current === 'scan') return { ok: false, code: 409, problems: ['a scan is running; change devices once it has finished'] };
    if (current) return { ok: false, code: 409, problems: [`the bus is busy with this app's ${current}; try again in a moment`] };

    // Group membership is stored in the device itself, so this one reaches the
    // bus. The name lives on the gateway.
    log({ kind: 'gateway_write', action: 'device_update', id, ...checked.update });
    const r = await call('PUT', `/device/${id}`, checked.update);
    if (!r.ok) {
      log({ kind: 'alert', alert: 'gateway_device_update_failed', id, error: r.error });
      return { ok: false, code: r.status === 404 ? 404 : 502, problems: [r.error] };
    }
    return { ok: true, device: r.data };
  }

  // ── Identify ─────────────────────────────────────────────────────────────
  // Blink one light, then put it back. The state to put back is read from the
  // gateway first; if it cannot be read, nothing is sent at all, because a
  // light left at full in the middle of the night is worse than no blink.
  async function identify(id) {
    if (!Number.isInteger(id) || id < 0) return { ok: false, code: 400, error: 'device id must be a whole number' };
    return exclusive('identify', { id }, async () => {
      const r = await call('GET', `/device/${id}`);
      if (!r.ok) return { ok: false, code: r.status === 404 ? 404 : 502, error: r.error };
      const before = readLightState(r.data?.features);
      if (!before) {
        return { ok: false, code: 409, error: 'the gateway does not report this light\'s current level, so it could not be put back after blinking; nothing was sent' };
      }
      const address = r.data?.address ?? null;
      log({ kind: 'gateway_write', action: 'identify', id, address, before, note: 'requested from the panel' });

      const steps = [];
      for (let i = 0; i < blinks; i++) steps.push({ dimmable: 100 }, { switchable: false });
      const restore = before.on ? { dimmable: before.level } : { switchable: false };

      let failed = null;
      try {
        for (const body of steps) {
          const s = await call('POST', `/device/${id}/control`, body);
          if (!s.ok) { failed = s.error; break; }
          await sleep(blinkMs);
        }
      } finally {
        // Always, even after a failed step: a half-finished blink is exactly
        // the state that must not be left behind.
        const back = await call('POST', `/device/${id}/control`, restore);
        if (!back.ok) {
          log({ kind: 'alert', alert: 'identify_restore_failed', id, address, before, error: back.error,
            note: 'the light may be left off or at full; set it from Home Assistant' });
          failed ??= back.error;
        }
      }
      if (failed) return { ok: false, code: 502, error: failed };
      return { ok: true, id, address, restored: before };
    }, { settleMs: identifySettleMs });
  }

  // ── Diagnostics (DALI parts 252 and 253) ─────────────────────────────────
  // Two reads, each a series of memory-bank queries on the bus. A driver that
  // does not implement a part answers 501, which is a fact about the driver,
  // not an error.
  async function readDiagnostics(id, { scheduled = false } = {}) {
    if (!Number.isInteger(id) || id < 0) return { ok: false, code: 400, error: 'device id must be a whole number' };
    return exclusive('diagnostics', { id }, async () => {
      log({ kind: 'gateway_write', action: 'diagnostics_read', id, scheduled,
        note: scheduled ? 'diagnostics_interval_hours is set' : 'requested from the panel' });
      const part = async (path) => {
        const r = await call('GET', path, undefined, { timeout: busTimeoutMs });
        if (r.ok) return { supported: true, data: r.data ?? null, error: null };
        if (r.status === 501) return { supported: false, data: null, error: null };
        return { supported: null, data: null, error: r.error, status: r.status };
      };
      const energy = await part(`/device/${id}/energyReporting`);
      if (energy.status === 404) return { ok: false, code: 404, error: energy.error };
      const diagnostics = await part(`/device/${id}/diagnosticsMaintenance`);
      const ok = energy.error === null || diagnostics.error === null;
      return { ok, code: ok ? 200 : 502, id, energy, diagnostics, error: ok ? null : energy.error };
    });
  }

  // ── Scenes and sensors, re-read from the bus ─────────────────────────────
  async function refreshScenes(id) {
    if (!Number.isInteger(id) || id < 0) return { ok: false, code: 400, error: 'device id must be a whole number' };
    return exclusive('scenes', { id }, async () => {
      log({ kind: 'gateway_write', action: 'scenes_read', id, note: 'requested from the panel' });
      const r = await call('POST', `/device/${id}/scenes`, undefined, { timeout: busTimeoutMs });
      if (!r.ok) return { ok: false, code: r.status === 404 ? 404 : 502, error: r.error };
      return { ok: true, scenes: r.data ?? {} };
    });
  }

  async function refreshSensors() {
    return exclusive('sensors', {}, async () => {
      log({ kind: 'gateway_write', action: 'sensors_read', note: 'requested from the panel' });
      const r = await call('POST', '/sensors', undefined, { timeout: busTimeoutMs });
      if (!r.ok) return { ok: false, code: 502, error: r.error };
      return { ok: true, sensors: Array.isArray(r.data?.sensors) ? r.data.sensors : [] };
    });
  }

  function stop() {
    if (pollTimer) clearTimer(pollTimer);
    pollTimer = null;
  }

  return {
    listDevices, startScan, cancelScan, status, scanning, busy, updateDevice,
    identify, readDiagnostics, refreshScenes, refreshSensors, stop,
  };
}
