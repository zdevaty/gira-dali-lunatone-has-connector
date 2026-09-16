// The Gateway page and the device extras on the Devices page: everything the
// gateway stores, and the buttons that change it. The routes that reach the
// bus or change the gateway are refused unless device management is on; the
// guard header has been checked by the server before anything here runs.

import { describeAutomations, resolveTargets } from '../gateway-read.js';

export function createGatewayRoutes({
  admin = null,
  reader = null,
  config = null,
  snapshots = null,
  watch = null,
  telemetry = null,
  liveness = null,
  ha = null,
  devices = null,
  writes = false,
} = {}) {
  const deviceMap = () => (devices ? devices.get() : {});
  const unavailable = { code: 503, body: { error: 'this part of the gateway page is not available' } };
  const reply = (r, okBody = r) => ({ code: r.ok ? 200 : r.code ?? 502, body: r.ok ? okBody : r });

  async function get(p, url) {
    if (p === '/api/gateway/overview') {
      if (!reader) return unavailable;
      const [info, location, polling, settings, haConfig] = await Promise.all([
        reader.info(), reader.location(), reader.statusQueries(), reader.settings(), ha ? ha.getConfig() : null,
      ]);
      const clock = watch ? await watch.checkClock() : null;
      const watched = watch ? watch.snapshot() : {};
      return { code: 200, body: {
        writes_enabled: writes,
        reachable: info.ok || info.status != null,
        info: info.value, info_error: info.error,
        lines: liveness?.snapshot().lines ?? null,
        clock, firmware: watched.firmware ?? info.value?.version ?? null, verified_firmware: watched.verified_firmware ?? null,
        upcoming: watched.upcoming ?? [],
        location: location.value, location_error: location.error,
        polling: polling.value, polling_error: polling.error,
        settings: settings.value,
        home_assistant: haConfig ? {
          time_zone: haConfig.time_zone,
          location: haConfig.latitude == null ? null : { lat: Math.round(haConfig.latitude * 100) / 100, lon: Math.round(haConfig.longitude * 100) / 100 },
        } : null,
        diagnostics: telemetry ? telemetry.snapshot() : null,
      } };
    }

    if (p === '/api/gateway/automations') {
      if (!reader) return unavailable;
      const [autos, devs, zones] = await Promise.all([reader.automations(), reader.devices(), reader.zones()]);
      return { code: 200, body: {
        automations: describeAutomations(autos, { devices: devs.value ?? [], zones: zones.value ?? [], deviceMap: deviceMap() }),
        errors: autos.errors,
      } };
    }

    if (p === '/api/gateway/zones') {
      if (!reader) return unavailable;
      const [zones, devs] = await Promise.all([reader.zones({ fresh: true }), reader.devices()]);
      if (!zones.ok) return { code: 502, body: { error: zones.error } };
      return { code: 200, body: {
        writes_enabled: writes,
        can_mirror: Boolean(config && ha),
        zones: zones.value.map((z) => ({ id: z.id, name: z.name ?? '', targets: resolveTargets(z.targets, { devices: devs.value ?? [], zones: zones.value }).labels })),
      } };
    }

    if (p === '/api/gateway/zones/plan') {
      if (!config) return unavailable;
      const r = await config.zonePlan();
      return reply(r, { plan: r.plan, writes_enabled: writes });
    }

    if (p === '/api/gateway/snapshots') {
      if (!snapshots) return unavailable;
      return { code: 200, body: { snapshots: await snapshots.list() } };
    }

    if (p === '/api/gateway/snapshots/compare') {
      if (!snapshots) return unavailable;
      const r = await snapshots.compare(String(url.searchParams.get('file') ?? ''));
      return reply(r);
    }

    if (p === '/api/gateway/diagnostics') {
      if (!telemetry) return unavailable;
      return { code: 200, body: { readings: telemetry.readings(), ...telemetry.snapshot(), writes_enabled: writes } };
    }

    if (p === '/api/gateway/sensors') {
      if (!reader) return unavailable;
      const r = await reader.sensors({ fresh: true });
      return r.ok ? { code: 200, body: { sensors: r.value, writes_enabled: writes } } : { code: 502, body: { error: r.error } };
    }

    const scenes = /^\/api\/gateway\/device\/(\d+)\/scenes$/.exec(p);
    if (scenes) {
      if (!reader) return unavailable;
      const r = await reader.scenes(Number(scenes[1]), { fresh: true });
      return r.ok ? { code: 200, body: { scenes: r.value } } : { code: r.status === 404 ? 404 : 502, body: { error: r.error } };
    }
    return null;
  }

  // `body` is already parsed. Returns null for a path that is not ours.
  async function write(method, p, body) {
    // A snapshot only reads the gateway, so it does not need device
    // management -- only the guard header, already checked.
    if (method === 'POST' && p === '/api/gateway/snapshots') {
      if (!snapshots) return unavailable;
      const r = await snapshots.take({ reason: 'requested from the panel' });
      return reply(r);
    }

    const routes = [
      ['POST', /^\/api\/gateway\/device\/(\d+)\/identify$/, (m) => admin?.identify(Number(m[1]))],
      ['POST', /^\/api\/gateway\/device\/(\d+)\/diagnostics$/, async (m) => {
        if (!telemetry) return null;
        const r = await telemetry.read(Number(m[1]));
        return r.ok ? { ...r, readings: telemetry.readings().filter((x) => x.device.id === Number(m[1])) } : r;
      }],
      ['POST', /^\/api\/gateway\/device\/(\d+)\/scenes$/, (m) => admin?.refreshScenes(Number(m[1]))],
      ['POST', /^\/api\/gateway\/sensors\/refresh$/, () => admin?.refreshSensors()],
      ['PUT', /^\/api\/gateway\/polling\/(\d+)$/, (m) => config?.setPolling(Number(m[1]), body)],
      ['POST', /^\/api\/gateway\/clock$/, () => config?.setClock(body)],
      ['POST', /^\/api\/gateway\/location$/, () => config?.setLocationFromHa()],
      ['POST', /^\/api\/gateway\/zones\/apply$/, () => config?.applyZones(String(body?.plan ?? ''))],
    ];
    for (const [m, re, run] of routes) {
      const match = method === m ? re.exec(p) : null;
      if (!match) continue;
      if (!writes) return { code: 403, body: { error: 'device management is switched off in the app configuration' } };
      const r = await run(match);
      if (!r) return unavailable;
      return reply(r);
    }
    return null;
  }

  return { get, write };
}
