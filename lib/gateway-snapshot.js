// A copy of how the gateway is set up, kept as a file whenever it changes.
//
// The gateway holds a great deal the bridge depends on and nobody else keeps a
// record of: device names and groups, scene levels, zones, schedules, polling.
// A factory reset, a firmware update or a well-meant afternoon in DALI Cockpit
// can change any of it without a trace. So once a night, after anything this
// app changes, and on request, every part is read (GETs only: nothing reaches
// the bus), stripped of what changes by itself -- levels, lamp status, time
// signatures -- and compared with the last copy. A new file is written only
// when something differs, so the directory is a history of changes rather
// than of nights.
//
// What changed is logged. If nothing from this app wrote to the gateway since
// the last copy, it changed from somewhere else, and that is an alert.

import fsp from 'node:fs/promises';
import path from 'node:path';

const FILE_RE = /^gateway-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.json$/;

// Arrays of records with ids become objects keyed by id, so a diff says
// "device 7: name" instead of "item 3 of 12: name".
function keyed(list) {
  if (!Array.isArray(list) || !list.every((x) => x && typeof x === 'object' && (typeof x.id === 'number' || typeof x.id === 'string'))) return list;
  return Object.fromEntries(list.map((x) => [String(x.id), x]));
}

const omit = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
};

const featureNames = (f) => (f && typeof f === 'object' ? Object.keys(f).sort() : f);

// Everything that describes the setup, and nothing that describes the moment.
export function normalise(parts) {
  const out = {};
  if (parts.info) {
    const lines = parts.info.lines && typeof parts.info.lines === 'object'
      ? Object.fromEntries(Object.entries(parts.info.lines).map(([k, v]) => [k, { device: v?.device ?? null }]))
      : undefined;
    out.info = { ...omit(parts.info, ['errors', 'lines']), ...(lines ? { lines } : {}) };
  }
  if (parts.devices) {
    out.devices = keyed(parts.devices.map((d) => ({ ...omit(d, ['status', 'available', 'timeSignature']), features: featureNames(d.features) })));
  }
  if (parts.scenes) out.scenes = parts.scenes;
  if (parts.zones) out.zones = keyed(parts.zones.map((z) => ({ ...omit(z, ['timeSignature']), features: featureNames(z.features) })));
  if (parts.sensors) out.sensors = keyed(parts.sensors.map((s) => omit(s, ['value', 'timestamp'])));
  if (parts.status_queries) out.status_queries = parts.status_queries;
  if (parts.settings) out.settings = parts.settings;
  if (parts.datetime) out.datetime = { timezone: parts.datetime.timezone ?? null, automatic_time: parts.datetime.automatic_time ?? null };
  if (parts.location) out.location = parts.location;
  if (parts.automations) {
    out.automations = {
      schedules: keyed(parts.automations.schedules),
      circadians: keyed(parts.automations.circadians),
      sequences: keyed((parts.automations.sequences ?? []).map((s) => omit(s, ['active']))),
      trigger_actions: keyed(parts.automations.trigger_actions),
      event_trigger_actions: keyed(parts.automations.event_trigger_actions),
    };
  }
  return out;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Differences as a flat list. Parts that failed to read on either side are
// skipped: a part that could not be read has not been deleted.
export function diff(before, after, { skip = [] } = {}) {
  const changes = [];
  const walk = (a, b, at) => {
    if (isObject(a) && isObject(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (at.length === 0 && skip.includes(k)) continue;
        if (!(k in b)) changes.push({ path: [...at, k], op: 'removed', before: a[k] });
        else if (!(k in a)) changes.push({ path: [...at, k], op: 'added', after: b[k] });
        else walk(a[k], b[k], [...at, k]);
      }
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ path: at, op: 'changed', before: a, after: b });
  };
  walk(before ?? {}, after ?? {}, []);
  return changes;
}

// A change in words, using names from the snapshot it happened in.
export function describeChange(change, { before = {}, after = {} } = {}) {
  const [part, id, ...rest] = change.path;
  const field = rest.join('.');
  const recordName = (snap) => {
    const r = snap?.[part]?.[id];
    if (part === 'devices' && r) return `device ${id} “${r.name ?? ''}”${r.address != null ? ` (A${r.address})` : ''}`;
    if (part === 'zones' && r) return `zone ${id} “${r.name ?? ''}”`;
    if (part === 'sensors' && r) return `sensor ${id} “${r.name ?? ''}”`;
    return null;
  };
  const value = (v) => (v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const what = recordName(after) ?? recordName(before);
  let subject;
  if (part === 'scenes') subject = `scenes of device ${id}${rest.length ? `, scene ${rest[0]}${rest.length > 1 ? ` ${rest.slice(1).join('.')}` : ''}` : ''}`;
  else if (part === 'automations') subject = `${String(id ?? '').replace(/_/g, ' ')}${rest.length ? ` ${rest[0]}${rest.length > 1 ? `: ${rest.slice(1).join('.')}` : ''}` : ''}`;
  else if (what) subject = `${what}${field ? `: ${field}` : ''}`;
  else subject = change.path.join('.');
  if (change.op === 'added') return `${subject} added${isObject(change.after) ? '' : `: ${value(change.after)}`}`;
  if (change.op === 'removed') return `${subject} removed`;
  return `${subject}: ${value(change.before)} → ${value(change.after)}`;
}

export function createGatewaySnapshots({
  reader,
  dir,
  log = () => {},
  keep = 100,
  now = Date.now,
  lastOwnWriteAt = () => null,
  // Local time, when the house is asleep and nobody is in DALI Cockpit.
  dailyAt = { hour: 3, minute: 30 },
  startDelayMs = 120_000,
  soonMs = 60_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!reader || !dir) throw new Error('createGatewaySnapshots requires a reader and a directory');
  let timer = null;
  let soonTimer = null;
  let running = null;
  let stopped = false;

  async function collect() {
    const errors = {};
    const take = async (name, fn) => {
      try {
        const r = await fn();
        if (!r.ok) { errors[name] = r.error; return undefined; }
        return r.value;
      } catch (err) {
        errors[name] = String(err?.message ?? err);
        return undefined;
      }
    };
    const parts = {};
    parts.info = await take('info', () => reader.info({ fresh: true }));
    parts.devices = await take('devices', () => reader.devices({ fresh: true }));
    if (parts.devices) {
      parts.scenes = {};
      for (const d of parts.devices) {
        const s = await take(`scenes`, () => reader.scenes(d.id, { fresh: true }));
        if (s !== undefined) parts.scenes[String(d.id)] = s;
      }
      if (errors.scenes) delete parts.scenes;
    }
    parts.zones = await take('zones', () => reader.zones({ fresh: true }));
    parts.sensors = await take('sensors', () => reader.sensors({ fresh: true }));
    parts.status_queries = await take('status_queries', () => reader.statusQueries({ fresh: true }));
    parts.settings = await take('settings', () => reader.settings({ fresh: true }));
    parts.datetime = await take('datetime', () => reader.datetime());
    parts.location = await take('location', () => reader.location({ fresh: true }));
    const autos = await reader.automations({ fresh: true });
    if (Object.keys(autos.errors).length === Object.keys(autos).length - 1) {
      errors.automations = Object.values(autos.errors)[0];
    } else {
      for (const [k, e] of Object.entries(autos.errors)) errors[`automations.${k}`] = e;
      parts.automations = autos;
    }
    for (const k of Object.keys(parts)) if (parts[k] === undefined) delete parts[k];
    return { data: normalise(parts), errors };
  }

  async function files() {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      return [];
    }
    return names.filter((n) => FILE_RE.test(n)).sort().reverse();
  }

  async function load(name) {
    if (!FILE_RE.test(name)) return null;
    try {
      return JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
    } catch {
      return null;
    }
  }

  const skipped = (a, b) => [...new Set([...Object.keys(a?.errors ?? {}), ...Object.keys(b?.errors ?? {})])]
    .map((k) => k.split('.')[0]);

  async function take({ reason = 'requested' } = {}) {
    if (running) return running;
    running = (async () => {
      const { data, errors } = await collect();
      if (!Object.keys(data).length) {
        log({ kind: 'alert', alert: 'gateway_snapshot_failed', reason, errors });
        return { ok: false, error: 'the gateway answered none of the reads', errors };
      }
      const [latestName] = await files();
      const latest = latestName ? await load(latestName) : null;
      const takenAt = now();
      const changes = latest ? diff(latest.data, data, { skip: skipped(latest, { errors }) }) : null;

      if (latest && changes.length === 0) {
        log({ kind: 'gateway_snapshot', reason, changed: false, file: latestName, errors: Object.keys(errors).length ? errors : undefined });
        return { ok: true, changed: false, file: latestName, errors };
      }

      const stamp = new Date(takenAt).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
      const name = `gateway-${stamp}.json`;
      const doc = {
        taken_at: new Date(takenAt).toISOString(),
        reason,
        firmware: data.info?.version ?? null,
        errors,
        changes: changes ? changes.length : null,
        data,
      };
      await fsp.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `.${name}.tmp`);
      await fsp.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`);
      await fsp.rename(tmp, path.join(dir, name));

      const all = await files();
      for (const old of all.slice(keep)) await fsp.rm(path.join(dir, old), { force: true });

      const described = changes ? changes.map((c) => describeChange(c, { before: latest.data, after: data })) : [];
      log({ kind: 'gateway_snapshot', reason, changed: true, file: name, changes: changes ? changes.length : null,
        first: described.slice(0, 5), errors: Object.keys(errors).length ? errors : undefined });

      if (latest) {
        const was = latest.data?.info?.version;
        const is = data.info?.version;
        if (was && is && was !== is) {
          log({ kind: 'alert', alert: 'gateway_firmware_changed', from: was, to: is,
            note: 'the bus decoder was checked against v1.18.7/1.4.6; watch Now for unknown frames' });
        }
        const own = lastOwnWriteAt();
        const since = Date.parse(latest.taken_at);
        if (own === null || !(own >= since)) {
          log({ kind: 'alert', alert: 'gateway_config_changed', changes: changes.length, first: described.slice(0, 5),
            note: 'nothing in this app wrote to the gateway since the previous snapshot; compare them on the Gateway page' });
        }
      }
      return { ok: true, changed: true, file: name, changes: described, errors };
    })();
    try {
      return await running;
    } catch (err) {
      log({ kind: 'alert', alert: 'gateway_snapshot_failed', reason, error: String(err?.message ?? err) });
      return { ok: false, error: String(err?.message ?? err) };
    } finally {
      running = null;
    }
  }

  async function list() {
    const out = [];
    for (const name of (await files()).slice(0, 60)) {
      const doc = await load(name);
      if (doc) out.push({ file: name, taken_at: doc.taken_at, reason: doc.reason, firmware: doc.firmware, changes: doc.changes, errors: Object.keys(doc.errors ?? {}) });
    }
    return out;
  }

  // One snapshot against the one before it.
  async function compare(name) {
    const all = await files();
    const i = all.indexOf(name);
    if (i < 0) return { ok: false, code: 404, error: 'no such snapshot' };
    const after = await load(name);
    const before = all[i + 1] ? await load(all[i + 1]) : null;
    if (!after) return { ok: false, code: 500, error: 'the snapshot could not be read' };
    if (!before) return { ok: true, file: name, previous: null, changes: [] };
    const changes = diff(before.data, after.data, { skip: skipped(before, after) });
    return {
      ok: true, file: name, previous: all[i + 1],
      changes: changes.map((c) => ({ ...c, text: describeChange(c, { before: before.data, after: after.data }) })),
    };
  }

  function msUntilDaily() {
    const t = new Date(now());
    const next = new Date(t);
    next.setHours(dailyAt.hour, dailyAt.minute, 0, 0);
    if (next.getTime() <= t.getTime()) next.setDate(next.getDate() + 1);
    return next.getTime() - t.getTime();
  }

  function schedule(ms, reason) {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(async () => {
      timer = null;
      await take({ reason }).catch(() => {});
      schedule(msUntilDaily(), 'nightly');
    }, ms);
    timer?.unref?.();
  }

  // After this app changes the gateway, a little later, once: a scan or a
  // zone mirror is several writes, and one copy of the result is enough.
  function soon(reason) {
    if (stopped || soonTimer) return;
    soonTimer = setTimer(() => {
      soonTimer = null;
      take({ reason }).catch(() => {});
    }, soonMs);
    soonTimer?.unref?.();
  }

  return {
    take, list, compare, soon,
    start: () => schedule(startDelayMs, 'startup'),
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      if (soonTimer) clearTimer(soonTimer);
      timer = null;
      soonTimer = null;
    },
  };
}
