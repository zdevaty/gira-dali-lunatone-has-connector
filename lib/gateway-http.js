// Every HTTP request the bridge may make of the gateway, in one table.
//
// The gateway's API can erase the installation in a single call, so what the
// bridge is allowed to ask for is a property of this file rather than of the
// care taken at each call site. Each entry says what the request does to the
// installation:
//
//   read    -- answered from what the gateway already stores. Nothing reaches
//              the bus, nothing changes.
//   bus     -- the gateway puts frames on the DALI bus: it queries drivers, or
//              changes them. Only ever on a button press, apart from the
//              opt-in scheduled diagnostics read (see DESIGN.md constraint 1).
//   config  -- changes the gateway's own settings. No frames, but the
//              gateway behaves differently afterwards. Button press only.
//
// A request that is not in the table is refused before it leaves the process,
// and every request with a body is checked once more, here, just before it is
// sent -- whatever the module that built it thought it was doing.

const INT = '\\d+';
const p = (source) => new RegExp(`^${source}$`);

export const GATEWAY_REQUESTS = Object.freeze([
  // ── read ────────────────────────────────────────────────────────────────
  ['GET', p('/info'), 'read'],
  ['GET', p('/devices'), 'read'],
  ['GET', p(`/device/${INT}`), 'read'],
  // Last known values, updated from scene commands the gateway sees.
  ['GET', p(`/device/${INT}/scenes`), 'read'],
  ['GET', p('/dali/scan'), 'read'],
  ['GET', p(`/dali/readStatus/${INT}`), 'read'],
  ['GET', p('/datetime'), 'read'],
  ['GET', p('/datetime/timezones'), 'read'],
  ['GET', p('/location'), 'read'],
  ['GET', p('/settings'), 'read'],
  ['GET', p('/zones'), 'read'],
  ['GET', p('/sensors'), 'read'],
  ['GET', p('/automations/statusQueries'), 'read'],
  ['GET', p('/automations/schedules'), 'read'],
  ['GET', p('/automations/circadians'), 'read'],
  ['GET', p('/automations/sequences'), 'read'],
  ['GET', p('/automations/triggerActions'), 'read'],
  ['GET', p('/automations/eventTriggerActions'), 'read'],

  // ── bus ─────────────────────────────────────────────────────────────────
  ['POST', p('/dali/scan'), 'bus'],
  ['POST', p('/dali/scan/cancel'), 'bus'],
  // Name and groups. Groups are stored in the device.
  ['PUT', p(`/device/${INT}`), 'bus'],
  // Identify only: see assertSafeGatewayBody for the two bodies it may carry.
  ['POST', p(`/device/${INT}/control`), 'bus'],
  // GETs, but answered by querying the driver's memory banks over the bus.
  ['GET', p(`/device/${INT}/energyReporting`), 'bus'],
  ['GET', p(`/device/${INT}/diagnosticsMaintenance`), 'bus'],
  // Re-reads every scene level from the driver.
  ['POST', p(`/device/${INT}/scenes`), 'bus'],
  // Re-reads the sensors.
  ['POST', p('/sensors'), 'bus'],

  // ── config ──────────────────────────────────────────────────────────────
  ['PUT', p(`/automations/statusQueries/${INT}`), 'config'],
  ['POST', p(`/automations/statusQueries/${INT}`), 'config'],
  ['POST', p('/datetime'), 'config'],
  ['POST', p('/location'), 'config'],
  ['POST', p('/zone'), 'config'],
  ['PUT', p(`/zone/${INT}`), 'config'],
]);

export function classifyGatewayRequest(method, path) {
  const hit = GATEWAY_REQUESTS.find(([m, re]) => m === method && re.test(path));
  return hit ? hit[2] : null;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function onlyKeys(body, allowed, what) {
  if (!isPlainObject(body)) throw new Error(`${what}: the body must be an object`);
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${what}: refusing unexpected fields: ${extra.join(', ')}`);
}

// The last check before a body leaves the process. Throws; never repairs.
export function assertSafeGatewayBody(method, path, body) {
  const kind = classifyGatewayRequest(method, path);
  if (!kind) throw new Error(`${method} ${path} is not something the bridge may ask the gateway`);
  if (kind === 'read' || method === 'GET') {
    if (body !== undefined) throw new Error(`${method} ${path} carries no body`);
    return kind;
  }

  if (path === '/dali/scan') {
    onlyKeys(body, ['newInstallation', 'noAddressing'], 'scan');
    if (body.newInstallation !== false) throw new Error('refusing a scan that is not explicitly newInstallation:false');
    if (typeof body.noAddressing !== 'boolean') throw new Error('refusing a scan without an explicit noAddressing');
    return kind;
  }
  if (path === '/dali/scan/cancel' || path === '/sensors' || /\/scenes$/.test(path)) {
    if (body !== undefined) throw new Error(`${path} carries no body`);
    return kind;
  }
  if (/^\/device\/\d+$/.test(path)) {
    onlyKeys(body, ['name', 'groups'], 'device update');
    if (Object.keys(body).length === 0) throw new Error('device update: nothing to change');
    return kind;
  }
  if (/^\/device\/\d+\/control$/.test(path)) {
    // Exactly one of two things: a level in percent, or on/off. Nothing that
    // saves a scene, sets a fade time or rate, or touches colour -- those are
    // stored in the driver and outlive the blink.
    onlyKeys(body, ['dimmable', 'switchable'], 'identify');
    const keys = Object.keys(body);
    if (keys.length !== 1) throw new Error('identify: exactly one of dimmable or switchable');
    if (keys[0] === 'dimmable' && !(typeof body.dimmable === 'number' && body.dimmable >= 0 && body.dimmable <= 100)) {
      throw new Error('identify: dimmable must be a number from 0 to 100');
    }
    if (keys[0] === 'switchable' && typeof body.switchable !== 'boolean') {
      throw new Error('identify: switchable must be true or false');
    }
    return kind;
  }
  if (/^\/automations\/statusQueries\/\d+$/.test(path)) {
    onlyKeys(body, ['delayBetweenQueries', 'queryStatus', 'queryActualLevel'], 'status polling');
    const d = body.delayBetweenQueries;
    if (!(typeof d === 'number' && d >= 0.5 && d <= 3600)) throw new Error('status polling: the delay must be 0.5 to 3600 seconds');
    if (typeof body.queryStatus !== 'boolean' || typeof body.queryActualLevel !== 'boolean') {
      throw new Error('status polling: queryStatus and queryActualLevel must both be given');
    }
    return kind;
  }
  if (path === '/datetime') {
    onlyKeys(body, ['timezone', 'automatic_time', 'date', 'time'], 'clock');
    if (Object.keys(body).length === 0) throw new Error('clock: nothing to change');
    for (const k of ['timezone', 'date', 'time']) {
      if (body[k] !== undefined && typeof body[k] !== 'string') throw new Error(`clock: ${k} must be a string`);
    }
    if (body.automatic_time !== undefined && typeof body.automatic_time !== 'boolean') throw new Error('clock: automatic_time must be true or false');
    return kind;
  }
  if (path === '/location') {
    onlyKeys(body, ['lat', 'lon'], 'location');
    if (!(typeof body.lat === 'number' && body.lat >= -90 && body.lat <= 90)) throw new Error('location: lat out of range');
    if (!(typeof body.lon === 'number' && body.lon >= -180 && body.lon <= 180)) throw new Error('location: lon out of range');
    return kind;
  }
  if (path === '/zone' || /^\/zone\/\d+$/.test(path)) {
    // Zones name devices, and only devices: a zone of "broadcast" would make
    // anything that addresses the zone address the whole bus.
    onlyKeys(body, ['name', 'targets'], 'zone');
    if (typeof body.name !== 'string' || !body.name.trim()) throw new Error('zone: a name is required');
    if (!Array.isArray(body.targets) || !body.targets.every((t) => isPlainObject(t)
      && Object.keys(t).length === 2 && t.type === 'device' && Number.isInteger(t.id) && t.id >= 0)) {
      throw new Error('zone: targets must be a list of {type: "device", id}');
    }
    return kind;
  }
  throw new Error(`${method} ${path}: no body check exists for this request, so it is not sent`);
}

export function createGatewayHttp({ host, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!host) throw new Error('createGatewayHttp requires a host');
  const base = `http://${host}`;

  // Never throws for a gateway problem: the answer says what went wrong. It
  // does throw for a request the bridge must not make, because that is a bug
  // here, not a condition to handle.
  async function request(method, path, body, { timeout = timeoutMs } = {}) {
    const kind = assertSafeGatewayBody(method, path, body);
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? 'timed out' : err?.cause?.code ?? err?.message ?? String(err);
      return { ok: false, kind, status: null, error: `gateway unreachable: ${reason}` };
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const detail = typeof data?.detail === 'string' ? data.detail : data?.detail ? JSON.stringify(data.detail) : '';
      return { ok: false, kind, status: res.status, error: `gateway answered HTTP ${res.status}${detail ? `: ${detail}` : ''}`, data };
    }
    return { ok: true, kind, status: res.status, data };
  }

  return { request, get: (path, opts) => request('GET', path, undefined, opts), host };
}
