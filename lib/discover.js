// Active gear discovery.
//
// The DALI bus stays strictly read-only: the daemon asks Home Assistant to change one
// light at a time and watches which control-gear address moves on the bus in response.
// HA drives the gateway, exactly as it does when a knob is turned. Nothing here puts a
// frame on the wire.
//
// This DOES visibly change people's lights for a second or two each, so it is opt-in and
// every light is put back exactly as it was found.

export function createGearDiscovery({
  ha,
  deviceMap = {},
  log = () => {},
  probeBrightness = 128,
  tolerance = 20,
  settleMs = 1500,
  gapMs = 500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let watching = null;
  let aborted = null;
  let running = false;

  function observeLevel(target, level) {
    if (!watching) return;
    // Broadcast and group frames name no single gear, so they identify nothing.
    if (typeof target !== 'string' || !/^short\d+$/.test(target)) return;
    if (!watching.seen.has(target)) watching.seen.set(target, []);
    watching.seen.get(target).push(level);
  }

  // Someone turning a knob mid-probe injects levels of their own and would corrupt the
  // result -- and probing lights while a person is using them is rude besides.
  function abort(reason) {
    if (running && !aborted) aborted = reason;
  }

  async function probe(address, mapping) {
    const before = await ha.getLightState(mapping.entity);
    if (!before) return { address, entity: mapping.entity, result: 'unreachable' };

    // Aim somewhere clearly different from where the light already is, or the probe
    // produces no change and therefore no frame to correlate.
    const current = before.state === 'on' ? (before.brightness ?? 0) : 0;
    const target =
      Math.abs(current - probeBrightness) > tolerance * 2
        ? probeBrightness
        : Math.max(1, Math.min(254, current > 128 ? probeBrightness - 80 : probeBrightness + 80));

    watching = { seen: new Map() };
    await ha.callService('light', 'turn_on', { entity_id: mapping.entity, brightness: target });
    await sleep(settleMs);
    const seen = watching.seen;
    watching = null;

    // Adaptive Lighting can move an unrelated light at the same moment, so only accept a
    // gear that actually landed near the level we asked for.
    const candidates = [...seen.entries()]
      .filter(([, levels]) => levels.some((l) => Math.abs(l - target) <= tolerance))
      .map(([gear]) => gear);

    await restore(mapping.entity, before);
    await sleep(gapMs);

    if (candidates.length === 1) return { address, entity: mapping.entity, result: 'ok', gear: candidates[0], asked: target };
    if (candidates.length === 0) {
      return { address, entity: mapping.entity, result: 'no_response', asked: target, saw: [...seen.keys()] };
    }
    return { address, entity: mapping.entity, result: 'ambiguous', asked: target, candidates };
  }

  // Put the light back exactly as it was found, including "it was off".
  async function restore(entity, before) {
    if (before.state !== 'on') {
      await ha.callService('light', 'turn_off', { entity_id: entity });
      return;
    }
    const body = { entity_id: entity };
    if (before.brightness != null) body.brightness = before.brightness;
    if (before.kelvin != null) body.color_temp_kelvin = before.kelvin;
    await ha.callService('light', 'turn_on', body);
  }

  async function run() {
    running = true;
    aborted = null;
    const results = [];
    const entries = Object.entries(deviceMap);
    log({ kind: 'discover', step: 'start', devices: entries.length,
      note: 'probing one light at a time via Home Assistant; the DALI bus is not written to' });

    for (const [address, mapping] of entries) {
      if (aborted) break;
      // Strictly one light at a time: two moving at once makes every frame ambiguous.
      const result = await probe(Number(address), mapping);
      results.push(result);
      log({ kind: 'discover', step: 'device', ...result });
    }

    watching = null;
    running = false;

    if (aborted) {
      log({ kind: 'alert', alert: 'gear_discovery_aborted', reason: aborted,
        note: 'lights already probed were restored; re-run when the bus is idle' });
      return { aborted, results };
    }

    const found = results.filter((r) => r.result === 'ok');
    log({ kind: 'discover', step: 'result', mapped: found.length, of: results.length });
    if (found.length) {
      const snippet = Object.fromEntries(found.map((r) => [r.address, { entity: r.entity, gear: r.gear }]));
      log({ kind: 'discover', step: 'devices_json', mapping: snippet,
        note: 'paste the gear values into devices.json to make the mapping explicit' });
    }
    return { aborted: null, results };
  }

  return { run, observeLevel, abort, isRunning: () => running };
}
