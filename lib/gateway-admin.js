// The only code in the bridge that asks the gateway to put anything on the bus.
//
// Until September 2026 the bus was strictly read-only from here. The exception
// agreed then is narrow, and this module is its whole extent:
//
//   - a device scan, in exactly two modes: re-reading the existing addresses
//     (`refresh`) and addressing new, unaddressed devices (`extend`);
//   - a device's name and group membership.
//
// Each is started by a person pressing a button on the panel, never by the
// bridge on its own. Everything else the gateway API offers -- raw 16/24-bit
// frames, light control, deleting devices, reset, reboot -- is not reachable
// from here, and the path allow-list below is what makes that a property of the
// code rather than a promise.
//
// A new installation (newInstallation set to true) deletes every device the
// gateway knows and re-addresses the whole bus: every knob mapping and every
// Home Assistant entity would be wrong afterwards. An empty scan body is not harmless either -- the gateway's
// defaults run an addressing extension. So every body is built here, in full,
// from a fixed table, and checked again just before it is sent.

import { monotonicNow } from './clock.js';

const SCAN_BODIES = Object.freeze({
  refresh: Object.freeze({ newInstallation: false, noAddressing: true }),
  extend: Object.freeze({ newInstallation: false, noAddressing: false }),
});

const ALLOWED = [
  ['GET', /^\/devices$/],
  ['GET', /^\/dali\/scan$/],
  ['POST', /^\/dali\/scan$/],
  ['POST', /^\/dali\/scan\/cancel$/],
  ['PUT', /^\/device\/\d+$/],
];

const FINISHED = new Set(['done', 'cancelled', 'bus error', 'not started']);

export const SCAN_MODES = Object.keys(SCAN_BODIES);

export function assertSafeScanBody(body) {
  if (!body || typeof body !== 'object') throw new Error('scan body must be an object');
  if (body.newInstallation !== false) throw new Error('refusing a scan that is not explicitly newInstallation:false');
  if (typeof body.noAddressing !== 'boolean') throw new Error('refusing a scan without an explicit noAddressing');
  const extra = Object.keys(body).filter((k) => k !== 'newInstallation' && k !== 'noAddressing');
  if (extra.length) throw new Error(`refusing unexpected scan fields: ${extra.join(', ')}`);
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

export function createGatewayAdmin({
  host,
  log = () => {},
  fetchImpl = fetch,
  timeoutMs = 8000,
  pollMs = 2000,
  maxScanMs = 30 * 60_000,
  // Scan traffic goes on for a little while after the gateway says done.
  settleMs = 10_000,
  onScanFinished = async () => null,
  now = monotonicNow,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!host) throw new Error('createGatewayAdmin requires a host');
  const base = `http://${host}`;

  let scan = null; // { mode, startedAt, status, after }
  let lastResult = null;
  let pollTimer = null;
  let settleUntil = -Infinity;
  let finishing = false; // the scan is over, the HA reload is not

  async function call(method, path, body) {
    if (!ALLOWED.some(([m, re]) => m === method && re.test(path))) {
      throw new Error(`${method} ${path} is not something the bridge may ask the gateway`);
    }
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return { ok: false, status: null, error: `gateway unreachable: ${err?.cause?.code ?? err?.message ?? err}` };
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const detail = typeof data?.detail === 'string' ? data.detail : data?.detail ? JSON.stringify(data.detail) : '';
      return { ok: false, status: res.status, error: `gateway answered HTTP ${res.status}${detail ? `: ${detail}` : ''}`, data };
    }
    return { ok: true, status: res.status, data };
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
      })),
    };
  }

  // ── Scan ─────────────────────────────────────────────────────────────────
  function scanning() {
    return scan !== null || now() < settleUntil;
  }

  function status() {
    return {
      active: scan !== null,
      finishing,
      settling: scan === null && now() < settleUntil,
      mode: scan?.mode ?? null,
      gateway: scan?.status ?? null,
      last: lastResult,
    };
  }

  async function startScan(mode) {
    if (!Object.hasOwn(SCAN_BODIES, mode)) {
      return { ok: false, code: 400, error: `unknown scan mode "${mode}"; expected ${SCAN_MODES.join(' or ')}` };
    }
    if (scan || finishing) return { ok: false, code: 409, error: 'a scan is already running' };

    const body = { ...SCAN_BODIES[mode] };
    assertSafeScanBody(body);

    // Claimed before the request, so two presses cannot both get through.
    scan = { mode, startedAt: now(), status: 'starting', after: null };
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
    settleUntil = now() + settleMs;
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
    if (scan) return { ok: false, code: 409, problems: ['a scan is running; change devices once it has finished'] };

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

  function stop() {
    if (pollTimer) clearTimer(pollTimer);
    pollTimer = null;
  }

  return { listDevices, startScan, cancelScan, status, scanning, updateDevice, stop };
}
