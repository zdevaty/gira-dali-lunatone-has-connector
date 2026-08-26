import { lookup } from 'node:dns/promises';

// Turns a thrown fetch/DNS error into something a human can act on. Node buries
// the useful part in err.cause, and "fetch failed" on its own tells you nothing.
export function diagnoseNetworkError(err, { host, port, url } = {}) {
  const code = err?.cause?.code ?? err?.code;
  const where = `${host ?? url}${port ? `:${port}` : ''}`;

  if (err?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
    return { reason: `timed out connecting to ${where}`, hint: 'Host is filtered or on another network. Check firewall and that you are on the same LAN.' };
  }
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return {
        reason: `hostname "${host}" does not resolve`,
        hint: String(host).endsWith('.local')
          ? '.local names need mDNS, which WSL2 and many containers cannot resolve. Use the numeric IP in HA_URL instead.'
          : 'Check the spelling, or use the numeric IP in HA_URL.',
      };
    case 'ECONNREFUSED':
      return { reason: `connection refused by ${where}`, hint: 'Something answered but nothing is listening on that port. Check the port in HA_URL (HA behind a proxy is often :80, direct is :8123).' };
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return { reason: `no route to ${where}`, hint: 'Wrong subnet, or the host is down.' };
    case 'ECONNRESET':
      return { reason: `connection reset by ${where}`, hint: 'A proxy or TLS mismatch — check http vs https in HA_URL.' };
    case 'ERR_INVALID_URL':
      return { reason: `HA_URL is not a valid URL: ${url}`, hint: 'It must include the scheme, e.g. http://10.0.0.101 or http://10.0.0.101:8123' };
    default:
      return { reason: `${err?.message ?? err}${code ? ` (${code})` : ''}`, hint: 'Unclassified network failure.' };
  }
}

// Home Assistant REST client. Deliberately queue-free: a call that fails is
// dropped, never retried or replayed — a brightness change applied five minutes
// late is worse than none at all. Outages produce exactly one alert at the start
// and one on recovery, not one per event.

export function createHaClient({ url, token, log = () => {}, timeoutMs = 5000, fetchImpl = fetch } = {}) {
  const baseUrl = String(url ?? '').replace(/\/+$/, '');
  let down = false;

  function markUp() {
    if (down) {
      down = false;
      log({ kind: 'alert', alert: 'ha_restored' });
    }
  }

  function markDown(err) {
    if (!down) {
      down = true;
      log({ kind: 'alert', alert: 'ha_unreachable', error: String(err && err.message ? err.message : err) });
    }
  }

  async function request(path, options = {}) {
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(options.headers ?? {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      markUp();
      return res;
    } catch (err) {
      markDown(err);
      return null;
    }
  }

  // Returns the light's current colour temperature in kelvin, or null when the
  // call fails or the light isn't reporting one (off, or in RGB mode).
  async function getLightKelvin(entityId) {
    const res = await request(`/api/states/${encodeURIComponent(entityId)}`);
    if (!res) return null;
    try {
      const state = await res.json();
      const kelvin = state?.attributes?.color_temp_kelvin;
      return typeof kelvin === 'number' ? kelvin : null;
    } catch {
      return null;
    }
  }

  // Current brightness 0-255, or null when the call fails. An "off" light reports
  // no brightness attribute at all, which is reported here as 0 — distinct from
  // null, because "off" is a fact we can act on and "unknown" is not.
  async function getLightBrightness(entityId) {
    const res = await request(`/api/states/${encodeURIComponent(entityId)}`);
    if (!res) return null;
    try {
      const state = await res.json();
      if (state?.state !== 'on') return 0;
      const brightness = state?.attributes?.brightness;
      return typeof brightness === 'number' ? brightness : 0;
    } catch {
      return null;
    }
  }

  // Everything needed to put a light back exactly as it was found.
  async function getLightState(entityId) {
    const res = await request(`/api/states/${encodeURIComponent(entityId)}`);
    if (!res) return null;
    try {
      const state = await res.json();
      const attrs = state?.attributes ?? {};
      return {
        state: state?.state,
        brightness: typeof attrs.brightness === 'number' ? attrs.brightness : null,
        kelvin: typeof attrs.color_temp_kelvin === 'number' ? attrs.color_temp_kelvin : null,
      };
    } catch {
      return null;
    }
  }

  async function callService(domain, service, body) {
    await request(`/api/services/${domain}/${service}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  // Startup check: prove we can actually reach HA and that every mapped entity
  // exists and can do what the gestures will ask of it. Never fatal — the bus log
  // is useful even with HA completely down — but loud, because a silent daemon
  // that can't reach HA looks identical to one with nothing to do.
  async function preflight(deviceMap = {}) {
    let ok = true;
    const fail = (step, reason, hint) => {
      ok = false;
      log({ kind: 'alert', alert: 'ha_preflight_failed', step, reason, ...(hint ? { hint } : {}) });
    };

    let parsed;
    try {
      parsed = new URL(baseUrl || url);
    } catch {
      fail('url', `HA_URL is not a valid URL: ${url}`, 'Include the scheme, e.g. http://10.0.0.101');
      return false;
    }

    log({ kind: 'preflight', step: 'config', url: parsed.origin, token: token ? `present (${String(token).length} chars)` : 'MISSING' });

    // 1. DNS — separated out so "does not resolve" never hides behind "fetch failed".
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    try {
      const { address, family } = await lookup(parsed.hostname);
      log({ kind: 'preflight', step: 'dns', status: 'ok', host: parsed.hostname, address, family: `IPv${family}` });
    } catch (err) {
      const { reason, hint } = diagnoseNetworkError(err, { host: parsed.hostname, port, url });
      fail('dns', reason, hint);
      return false; // nothing downstream can work
    }

    // 2. API reachable and the token accepted.
    try {
      const res = await fetchImpl(`${parsed.origin}/api/`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 401) {
        fail('auth', 'HA rejected the token (HTTP 401)', 'The long-lived access token is wrong, revoked, or expired. Create a new one in your HA profile.');
        return false;
      }
      if (res.status === 403) {
        fail('auth', 'HA refused the request (HTTP 403)', 'The token is valid but not permitted to use the REST API.');
        return false;
      }
      if (res.status === 404) {
        fail('api', `reached ${parsed.origin} but /api/ returned 404`, 'Something is listening there, but it is not the HA API. Check the port — HA behind a proxy is usually :80, direct is :8123.');
        return false;
      }
      if (!res.ok) {
        fail('api', `GET ${parsed.origin}/api/ returned HTTP ${res.status}`);
        return false;
      }
      const body = await res.json().catch(() => null);
      log({ kind: 'preflight', step: 'api', status: 'ok', httpStatus: res.status, message: body?.message ?? null });
    } catch (err) {
      const { reason, hint } = diagnoseNetworkError(err, { host: parsed.hostname, port, url });
      fail('api', reason, hint);
      return false;
    }

    // 3. Every mapped entity: does it exist, and can it do colour temperature?
    for (const [address, mapping] of Object.entries(deviceMap)) {
      const entity = mapping.entity;
      try {
        const res = await fetchImpl(`${parsed.origin}/api/states/${encodeURIComponent(entity)}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 404) {
          fail('entity', `device map address ${address} -> "${entity}" does not exist in HA`, 'Check the entity_id in DEVICE_MAP against Developer Tools > States.');
          continue;
        }
        if (!res.ok) {
          fail('entity', `GET state of "${entity}" returned HTTP ${res.status}`);
          continue;
        }
        const state = await res.json();
        const attrs = state?.attributes ?? {};
        const modes = attrs.supported_color_modes ?? [];
        const supportsCct = modes.includes('color_temp');
        const haMin = attrs.min_color_temp_kelvin;
        const haMax = attrs.max_color_temp_kelvin;

        log({
          kind: 'preflight', step: 'entity', status: supportsCct ? 'ok' : 'no_color_temp',
          address, entity, state: state.state, supported_color_modes: modes,
          ha_kelvin_range: haMin != null ? [haMin, haMax] : null,
          configured_kelvin_range: [mapping.min_kelvin, mapping.max_kelvin],
        });

        if (!supportsCct) {
          fail('entity', `"${entity}" does not support color_temp (modes: ${modes.join(', ') || 'none'})`, 'Colour gestures on this device will do nothing. Brightness will still work.');
        } else if (haMin != null && (mapping.min_kelvin < haMin || mapping.max_kelvin > haMax)) {
          // Not a failure: clamping to a narrower range than the hardware allows
          // is usually deliberate. Only worth saying out loud.
          log({
            kind: 'preflight', step: 'entity', status: 'range_note', address, entity,
            note: `configured ${mapping.min_kelvin}-${mapping.max_kelvin} K lies outside what HA reports (${haMin}-${haMax} K); values will be clamped to the configured range`,
          });
        }
      } catch (err) {
        const { reason, hint } = diagnoseNetworkError(err, { host: parsed.hostname, port, url });
        fail('entity', `checking "${entity}": ${reason}`, hint);
      }
    }

    log({ kind: 'preflight', step: 'result', status: ok ? 'ok' : 'failed' });
    return ok;
  }

  return { getLightKelvin, getLightBrightness, getLightState, callService, preflight, isDown: () => down };
}
