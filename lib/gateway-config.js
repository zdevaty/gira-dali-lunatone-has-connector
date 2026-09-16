// Changes to the gateway's own settings, from the panel. None of these put a
// frame on the bus; each changes how the gateway behaves afterwards, so each
// is a button press, logged as a `gateway_write`, and built from a fixed shape
// that lib/gateway-http.js checks once more before sending.
//
//   - how often the gateway polls its drivers (status and actual level);
//   - its time zone and clock, which its schedules run by;
//   - its location, which its sunrise and sunset schedules run by;
//   - zones mirrored from Home Assistant areas. Zones are created and updated,
//     never deleted, and only ever list devices.

import crypto from 'node:crypto';
import { createGatewayHttp } from './gateway-http.js';
import { analyseClock } from './gateway-read.js';
import { formatGatewayDateTime, isValidTimeZone } from './zoned-time.js';

export function validatePolling(input) {
  const problems = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, problems: ['the settings must be an object'] };
  const extra = Object.keys(input).filter((k) => !['delayBetweenQueries', 'queryStatus', 'queryActualLevel'].includes(k));
  if (extra.length) problems.push(`cannot be changed from here: ${extra.join(', ')}`);
  const d = Number(input.delayBetweenQueries);
  if (!Number.isFinite(d) || d < 0.5 || d > 3600) problems.push('the delay must be between 0.5 and 3600 seconds');
  if (typeof input.queryStatus !== 'boolean') problems.push('say whether to query status');
  if (typeof input.queryActualLevel !== 'boolean') problems.push('say whether to query the actual level');
  if (problems.length) return { ok: false, problems };
  return { ok: true, value: { delayBetweenQueries: Math.round(d * 10) / 10, queryStatus: input.queryStatus, queryActualLevel: input.queryActualLevel } };
}

// Lights in Home Assistant areas, with enough about each light's device to
// find it in the gateway's list. One template call, because the REST API has
// no other way to reach the area registry.
export const AREA_LIGHTS_TEMPLATE = `{%- set ns = namespace(rows=[]) -%}
{%- for area in areas() -%}
  {%- for e in area_entities(area) | select('match', 'light\\\\.') -%}
    {%- if area_id(e) == area -%}
      {%- set dev = device_id(e) -%}
      {%- set ns.rows = ns.rows + [{
        'area_id': area,
        'area': area_name(area),
        'entity_id': e,
        'device_name': device_attr(dev, 'name') if dev else none,
        'identifiers': (device_attr(dev, 'identifiers') | map('join', '|') | list) if dev else []
      }] -%}
    {%- endif -%}
  {%- endfor -%}
{%- endfor -%}
{{ ns.rows | tojson }}`;

// Which gateway device is behind a Home Assistant light. Three ways, most
// certain first, and a light none of them settles stays unmatched:
//
//   map         the knob map names both the entity and its driver address;
//   identifier  the HA device's Lunatone identifier ends in "device<id>";
//   name        the HA device has exactly the gateway device's name, and no
//               other gateway device has that name.
export function matchLights(rows, { devices = [], deviceMap = {}, domain = 'lunatone' } = {}) {
  const line0 = (addr) => {
    const hits = devices.filter((d) => d.address === addr && (d.line ?? 0) === 0);
    return hits.length === 1 && devices.filter((d) => d.address === addr).length === 1 ? hits[0] : null;
  };
  const byMap = new Map();
  for (const m of Object.values(deviceMap)) {
    const a = /^short(\d+)$/.exec(m?.gear ?? '');
    if (m?.entity && a) {
      const d = line0(Number(a[1]));
      if (d) byMap.set(m.entity, d);
    }
  }

  return rows.map((row) => {
    const mapped = byMap.get(row.entity_id);
    if (mapped) return { ...row, device: mapped, how: 'map' };

    const ids = (row.identifiers ?? [])
      .filter((s) => typeof s === 'string' && s.startsWith(`${domain}|`))
      .map((s) => /device[-_]?(\d+)$/i.exec(s))
      .filter(Boolean)
      .map((m) => Number(m[1]));
    const byId = [...new Set(ids)].map((id) => devices.find((d) => d.id === id)).filter(Boolean);
    if (byId.length === 1) return { ...row, device: byId[0], how: 'identifier' };

    const name = typeof row.device_name === 'string' ? row.device_name.trim() : '';
    const byName = name ? devices.filter((d) => (d.name ?? '').trim() === name) : [];
    if (byName.length === 1) return { ...row, device: byName[0], how: 'name' };

    return { ...row, device: null, how: byName.length > 1 ? 'name is not unique' : 'no match' };
  });
}

const sameTargets = (a, b) => JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify([...b].sort((x, y) => x - y));

// The zones Home Assistant's areas imply, against the zones the gateway has.
export function planZones({ matched, zones = [] }) {
  const areas = new Map();
  for (const row of matched) {
    if (!areas.has(row.area_id)) areas.set(row.area_id, { name: row.area, lights: [], ids: new Set() });
    const a = areas.get(row.area_id);
    a.lights.push({ entity_id: row.entity_id, device: row.device ? { id: row.device.id, name: row.device.name, address: row.device.address } : null, how: row.how });
    if (row.device) a.ids.add(row.device.id);
  }

  const create = [];
  const update = [];
  const unchanged = [];
  const usedZones = new Set();
  for (const a of areas.values()) {
    const ids = [...a.ids];
    if (!ids.length) continue;
    const same = zones.filter((z) => (z.name ?? '').trim() === a.name.trim());
    if (same.length > 1) {
      unchanged.push({ name: a.name, reason: 'more than one gateway zone has this name; left alone' });
      same.forEach((z) => usedZones.add(z.id));
      continue;
    }
    const existing = same[0];
    const current = existing ? (existing.targets ?? []).filter((t) => t.type === 'device').map((t) => t.id) : null;
    const body = { name: a.name, targets: ids.sort((x, y) => x - y).map((id) => ({ type: 'device', id })) };
    if (!existing) {
      create.push(body);
    } else {
      usedZones.add(existing.id);
      const otherTargets = (existing.targets ?? []).filter((t) => t.type !== 'device');
      if (otherTargets.length) {
        unchanged.push({ id: existing.id, name: a.name, reason: 'the zone also names groups or broadcasts, set up elsewhere; left alone' });
      } else if (sameTargets(current, ids)) {
        unchanged.push({ id: existing.id, name: a.name, reason: 'already matches' });
      } else {
        update.push({ id: existing.id, before: current, ...body });
      }
    }
  }

  const unmatched = [...areas.values()].flatMap((a) => a.lights.filter((l) => !l.device).map((l) => ({ area: a.name, ...l })));
  const untouched = zones.filter((z) => !usedZones.has(z.id)).map((z) => ({ id: z.id, name: z.name ?? '' }));
  const operations = { create, update };
  const id = crypto.createHash('sha1').update(JSON.stringify(operations)).digest('hex').slice(0, 12);
  return {
    id,
    areas: [...areas.values()].map((a) => ({ name: a.name, lights: a.lights })),
    create, update, unchanged, unmatched, untouched,
  };
}

export function createGatewayConfig({
  host,
  http = null,
  fetchImpl = fetch,
  reader,
  ha = null,
  deviceMap = () => ({}),
  domain = 'lunatone',
  log = () => {},
  onChanged = () => {},
  now = Date.now,
} = {}) {
  const gw = http ?? createGatewayHttp({ host, fetchImpl });
  if (!reader) throw new Error('createGatewayConfig requires a reader');

  async function write(action, method, path, body) {
    log({ kind: 'gateway_write', action, effect: 'config', method, path, body, note: 'requested from the panel' });
    const r = await gw.request(method, path, body);
    reader.forget();
    if (!r.ok) {
      log({ kind: 'alert', alert: 'gateway_config_failed', action, error: r.error });
    } else {
      try { onChanged(action); } catch { /* a snapshot request must not fail the write */ }
    }
    return r;
  }

  // ── Status polling ───────────────────────────────────────────────────────
  async function setPolling(line, input) {
    if (!Number.isInteger(line) || line < 0) return { ok: false, code: 400, problems: ['the line must be a whole number'] };
    const checked = validatePolling(input);
    if (!checked.ok) return { ok: false, code: 400, problems: checked.problems };
    const current = await reader.statusQueries({ fresh: true });
    if (!current.ok) return { ok: false, code: 502, problems: [current.error] };
    const exists = Object.hasOwn(current.value, String(line));
    const r = await write('status_polling', exists ? 'PUT' : 'POST', `/automations/statusQueries/${line}`, checked.value);
    return r.ok ? { ok: true, polling: r.data ?? checked.value } : { ok: false, code: 502, problems: [r.error] };
  }

  // ── Clock ────────────────────────────────────────────────────────────────
  // { timezone } sets the zone; { automatic_time } switches network time on or
  // off; { set_now: true } writes this machine's time, in the zone and the
  // exact format the gateway itself reported -- and refuses if that format was
  // not recognised, rather than guess at one.
  async function setClock(input = {}) {
    const extra = Object.keys(input ?? {}).filter((k) => !['timezone', 'automatic_time', 'set_now'].includes(k));
    if (extra.length) return { ok: false, code: 400, problems: [`cannot be changed from here: ${extra.join(', ')}`] };
    const body = {};

    let zone = null;
    if (input.timezone !== undefined) {
      if (!isValidTimeZone(input.timezone)) return { ok: false, code: 400, problems: [`"${input.timezone}" is not a time zone`] };
      const known = await reader.timezones();
      if (known.ok && known.value.length && !known.value.includes(input.timezone)) {
        return { ok: false, code: 400, problems: [`the gateway does not know the time zone "${input.timezone}"`] };
      }
      body.timezone = input.timezone;
      zone = input.timezone;
    }
    if (input.automatic_time !== undefined) {
      if (typeof input.automatic_time !== 'boolean') return { ok: false, code: 400, problems: ['automatic_time must be true or false'] };
      body.automatic_time = input.automatic_time;
    }
    if (input.set_now === true) {
      const raw = await reader.datetime();
      if (!raw.ok) return { ok: false, code: 502, problems: [raw.error] };
      const clock = analyseClock(raw.value, now());
      if (!clock.recognised) {
        return { ok: false, code: 409, problems: [`the gateway's date format was not recognised (${clock.problem}), so the clock is not set from here`] };
      }
      const formatted = formatGatewayDateTime(now(), zone ?? clock.timezone, clock.shape);
      body.date = formatted.date;
      body.time = formatted.time;
      // A manual time only sticks with network time off.
      body.automatic_time = false;
    }
    if (!Object.keys(body).length) return { ok: false, code: 400, problems: ['nothing to change'] };
    const r = await write('clock', 'POST', '/datetime', body);
    return r.ok ? { ok: true, datetime: r.data ?? body } : { ok: false, code: 502, problems: [r.error] };
  }

  // ── Location ─────────────────────────────────────────────────────────────
  // From Home Assistant, to two decimal places: about a kilometre, which is
  // far more than sunrise needs and all the gateway is told.
  async function setLocationFromHa() {
    if (!ha) return { ok: false, code: 503, problems: ['Home Assistant is not configured'] };
    const cfg = await ha.getConfig();
    if (!cfg || typeof cfg.latitude !== 'number' || typeof cfg.longitude !== 'number') {
      return { ok: false, code: 502, problems: ['Home Assistant did not report a location'] };
    }
    const body = { lat: Math.round(cfg.latitude * 100) / 100, lon: Math.round(cfg.longitude * 100) / 100 };
    const r = await write('location', 'POST', '/location', body);
    return r.ok ? { ok: true, location: r.data ?? body } : { ok: false, code: 502, problems: [r.error] };
  }

  // ── Zones from areas ─────────────────────────────────────────────────────
  async function zonePlan() {
    if (!ha) return { ok: false, code: 503, error: 'Home Assistant is not configured' };
    const rendered = await ha.renderTemplate(AREA_LIGHTS_TEMPLATE);
    if (!rendered.ok) return { ok: false, code: 502, error: `Home Assistant could not list its areas: ${rendered.error}` };
    let rows;
    try {
      rows = JSON.parse(rendered.text);
      if (!Array.isArray(rows)) throw new Error('not a list');
    } catch (err) {
      return { ok: false, code: 502, error: `Home Assistant's area list was not readable: ${err.message}` };
    }
    const [devices, zones] = await Promise.all([reader.devices({ fresh: true }), reader.zones({ fresh: true })]);
    if (!devices.ok) return { ok: false, code: 502, error: devices.error };
    if (!zones.ok) return { ok: false, code: 502, error: zones.error };
    const matched = matchLights(rows, { devices: devices.value, deviceMap: deviceMap(), domain });
    return { ok: true, plan: planZones({ matched, zones: zones.value }) };
  }

  // Applies the plan only if it is still the plan the person looked at.
  async function applyZones(planId) {
    const fresh = await zonePlan();
    if (!fresh.ok) return fresh;
    if (fresh.plan.id !== planId) {
      return { ok: false, code: 409, error: 'something changed since the preview; look at it again before applying', plan: fresh.plan };
    }
    const results = [];
    for (const z of fresh.plan.create) {
      const r = await write('zone_create', 'POST', '/zone', { name: z.name, targets: z.targets });
      results.push({ name: z.name, action: 'created', ok: r.ok, error: r.error ?? null });
      if (!r.ok) break;
    }
    if (results.every((r) => r.ok)) {
      for (const z of fresh.plan.update) {
        const r = await write('zone_update', 'PUT', `/zone/${z.id}`, { name: z.name, targets: z.targets });
        results.push({ name: z.name, action: 'updated', ok: r.ok, error: r.error ?? null });
        if (!r.ok) break;
      }
    }
    const ok = results.every((r) => r.ok);
    return { ok, code: ok ? 200 : 502, results };
  }

  return { setPolling, setClock, setLocationFromHa, zonePlan, applyZones };
}
