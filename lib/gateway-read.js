// What the gateway stores, read without touching the bus, and made legible:
// which devices an automation reaches, which knobs drive those devices, and
// whether the gateway's clock can be trusted to run its schedules.
//
// Every request here is a `read` in lib/gateway-http.js.

import { createGatewayHttp } from './gateway-http.js';
import { isValidTimeZone, parseGatewayDateTime, zonedToEpoch } from './zoned-time.js';

const AUTOMATIONS = {
  schedules: ['/automations/schedules', 'schedulers'],
  circadians: ['/automations/circadians', 'circadians'],
  sequences: ['/automations/sequences', 'sequences'],
  trigger_actions: ['/automations/triggerActions', 'triggerActions'],
  event_trigger_actions: ['/automations/eventTriggerActions', null],
};

export function createGatewayReader({ host, http = null, fetchImpl = fetch, cacheMs = 3000, now = Date.now } = {}) {
  const gw = http ?? createGatewayHttp({ host, fetchImpl });
  // A page load asks for the same few things at once; a few seconds of cache
  // keeps that to one request each without ever showing anything stale for
  // long.
  const cache = new Map();

  async function get(path, { fresh = false } = {}) {
    const hit = cache.get(path);
    if (!fresh && hit && now() - hit.at < cacheMs) return hit.value;
    const pending = gw.get(path);
    const value = await pending;
    if (value.ok) cache.set(path, { at: now(), value });
    else cache.delete(path);
    return value;
  }

  const unwrap = (r, pick) => (r.ok ? { ok: true, value: pick(r.data), error: null } : { ok: false, value: null, error: r.error, status: r.status });
  const list = (key) => (data) => (Array.isArray(key ? data?.[key] : data) ? (key ? data[key] : data) : []);

  return {
    get,
    forget: () => cache.clear(),
    info: async (opts) => unwrap(await get('/info', opts), (d) => d ?? {}),
    devices: async (opts) => unwrap(await get('/devices', opts), list('devices')),
    device: async (id) => unwrap(await get(`/device/${id}`, { fresh: true }), (d) => d),
    scenes: async (id, opts) => unwrap(await get(`/device/${id}/scenes`, opts), (d) => d ?? {}),
    zones: async (opts) => unwrap(await get('/zones', opts), list('zones')),
    sensors: async (opts) => unwrap(await get('/sensors', opts), list('sensors')),
    settings: async (opts) => unwrap(await get('/settings', opts), (d) => d ?? {}),
    location: async (opts) => unwrap(await get('/location', opts), (d) => d ?? null),
    datetime: async (opts) => unwrap(await get('/datetime', { fresh: true, ...opts }), (d) => d ?? {}),
    timezones: async () => unwrap(await get('/datetime/timezones'), (d) => (Array.isArray(d) ? d : Array.isArray(d?.timezones) ? d.timezones : [])),
    statusQueries: async (opts) => unwrap(await get('/automations/statusQueries', opts), (d) => (d && typeof d === 'object' ? d : {})),
    async automations(opts) {
      const out = { errors: {} };
      for (const [name, [path, key]] of Object.entries(AUTOMATIONS)) {
        const r = unwrap(await get(path, opts), list(key));
        out[name] = r.value ?? [];
        if (!r.ok) out.errors[name] = r.error;
      }
      return out;
    },
  };
}

// ── Clock ───────────────────────────────────────────────────────────────────

// How far the gateway's clock is from ours, in seconds (positive: gateway
// ahead). The gateway runs its schedules by this clock in its own time zone.
export function analyseClock(raw, nowMs) {
  const out = {
    timezone: raw?.timezone ?? null,
    automatic_time: typeof raw?.automatic_time === 'boolean' ? raw.automatic_time : null,
    date: raw?.date ?? null,
    time: raw?.time ?? null,
    recognised: false,
    drift_s: null,
    instant: null,
    shape: null,
    problem: null,
  };
  if (!isValidTimeZone(out.timezone)) {
    out.problem = out.timezone ? `unknown time zone "${out.timezone}"` : 'the gateway reports no time zone';
    return out;
  }
  const parsed = parseGatewayDateTime(out.date, out.time);
  if (!parsed) {
    out.problem = `unrecognised date/time format: "${out.date}" "${out.time}"`;
    return out;
  }
  out.recognised = true;
  out.shape = { dateShape: parsed.dateShape, timeShape: parsed.timeShape };
  out.instant = zonedToEpoch(parsed.wall, out.timezone);
  out.drift_s = Math.round((out.instant - nowMs) / 1000);
  return out;
}

// ── What an automation reaches ──────────────────────────────────────────────

// Resolves automation targets to gateway devices. Only what the gateway's own
// data says: a group target is the devices whose `groups` contain it, a zone
// is its own targets, and a broadcast is every device on the line. A target
// type this does not know is kept as a label and reaches nothing.
//
// Group and broadcast ids are line-qualified: group 4 on line 1 is id 20
// (1 * 16 + 4), per the gateway's own API documentation.
export function resolveTargets(targets, { devices = [], zones = [] } = {}, depth = 0) {
  const reached = new Map();
  const labels = [];
  for (const t of Array.isArray(targets) ? targets : []) {
    const type = t?.type;
    if (type === 'device') {
      const d = devices.find((x) => x.id === t.id);
      labels.push(d ? deviceLabel(d) : `device ${t.id} (not in the device list)`);
      if (d) reached.set(d.id, d);
    } else if (type === 'group' && Number.isInteger(t.id)) {
      const line = Math.floor(t.id / 16);
      const group = t.id % 16;
      labels.push(`group ${group}${line ? ` on line ${line}` : ''}`);
      for (const d of devices) if ((d.line ?? 0) === line && d.groups?.includes(group)) reached.set(d.id, d);
    } else if (type === 'broadcast' && Number.isInteger(t.id)) {
      labels.push(`everything on line ${t.id}`);
      for (const d of devices) if ((d.line ?? 0) === t.id) reached.set(d.id, d);
    } else if (type === 'zone' && depth < 3) {
      const z = zones.find((x) => x.id === t.id);
      labels.push(z ? `zone “${z.name ?? z.id}”` : `zone ${t.id} (not found)`);
      if (z) for (const d of resolveTargets(z.targets, { devices, zones }, depth + 1).devices) reached.set(d.id, d);
    } else {
      labels.push(`${type ?? 'unknown'} ${t?.id ?? t?.address ?? ''}`.trim());
    }
  }
  return { labels, devices: [...reached.values()] };
}

export function deviceLabel(d) {
  const addr = d.address == null ? '' : ` (A${d.address}${d.line ? ` line ${d.line}` : ''})`;
  return `“${d.name || `device ${d.id}`}”${addr}`;
}

// The knobs that drive a device, from the saved map. Only a mapping with a
// known driver counts, and only on line 0: the map's gear addresses carry no
// line, so on a multi-line gateway anything else would be a guess.
export function knobsFor(device, deviceMap = {}) {
  if (device.address == null || (device.line ?? 0) !== 0) return [];
  const gear = `short${device.address}`;
  return Object.entries(deviceMap)
    .filter(([, m]) => m?.gear === gear)
    .map(([knob, m]) => ({ knob: Number(knob), entity: m.entity }));
}

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const pad = (n) => String(n ?? 0).padStart(2, '0');

function featuresSummary(features) {
  if (!features || typeof features !== 'object') return '';
  return Object.entries(features)
    .map(([k, v]) => `${k} ${typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`)
    .join(', ');
}

function scheduleSummary(s) {
  const t = s.recallTime ?? {};
  const time = `${pad(t.hour)}:${pad(t.minute)}${t.second ? `:${pad(t.second)}` : ''}`;
  const mode = s.recallMode ?? 'timeOfDay';
  const when = mode === 'timeOfDay' ? `at ${time}`
    : `${time} ${mode.replace(/([A-Z])/g, ' $1').toLowerCase()}`;
  const days = s.activeWeekdays && typeof s.activeWeekdays === 'object'
    ? WEEKDAYS.filter((d) => s.activeWeekdays[d] !== false)
    : WEEKDAYS;
  const daysText = days.length === 7 ? 'every day' : days.map((d) => d.slice(0, 3)).join(' ');
  const action = featuresSummary(s.action?.data?.features ?? s.action?.data);
  return `${when}, ${daysText}${action ? ` → ${action}` : ''}`;
}

// Every automation the gateway runs by itself, with the devices it reaches
// and the knobs that drive those devices. `knobs` non-empty on an enabled
// automation is the interesting case: something other than Home Assistant
// changes a light that a knob also changes.
export function describeAutomations(automations, { devices = [], zones = [], deviceMap = {} } = {}) {
  const out = [];
  const add = (kind, a, summary, targets) => {
    const r = resolveTargets(targets, { devices, zones });
    const knobs = [];
    for (const d of r.devices) for (const k of knobsFor(d, deviceMap)) knobs.push({ ...k, device: deviceLabel(d) });
    out.push({
      kind, id: a.id ?? null, name: a.name || '', enabled: a.enabled !== false,
      active: typeof a.active === 'boolean' ? a.active : null,
      summary, targets: r.labels, devices: r.devices.map((d) => d.id), knobs,
    });
  };

  for (const s of automations.schedules ?? []) add('schedule', s, scheduleSummary(s), s.targets);
  for (const c of automations.circadians ?? []) {
    const steps = c.longest?.steps?.length ?? 0;
    add('circadian', c, `daily curve, ${steps} step${steps === 1 ? '' : 's'} on the longest day`, c.targets);
  }
  for (const q of automations.sequences ?? []) {
    const steps = Array.isArray(q.steps) ? q.steps : [];
    const targets = steps.flatMap((st) => st?.data?.targets ?? []);
    const summary = `${steps.length} step${steps.length === 1 ? '' : 's'}${q.loop ? ', loops' : q.repeat ? `, repeats ${q.repeat}×` : ''}${q.isMacro ? ', macro' : ''}`;
    add('sequence', q, summary, targets);
  }
  for (const ta of automations.trigger_actions ?? []) {
    const sources = (ta.sources ?? []).map((s) => (s.type === 'd16gear' || s.type === 'd16group'
      ? `${s.type === 'd16gear' ? 'address' : 'group'} ${s.address} on line ${s.line}`
      : `${s.type} ${s.id}`));
    add('trigger_action', ta, `repeats what is sent to ${sources.join(', ') || 'nothing'}`, ta.targets);
  }
  for (const e of automations.event_trigger_actions ?? []) {
    const filters = Object.entries(e.filters ?? {}).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join('/') : v}`).join(', ');
    add('event_trigger_action', e,
      `forwards input events from line ${e.source_line} to line ${(e.target_lines ?? []).join(', ')}${filters ? ` (${filters})` : ''}`, []);
  }
  return out;
}

export { WEEKDAYS };
