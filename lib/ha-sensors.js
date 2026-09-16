// The bridge's own state, published into Home Assistant as a handful of
// entities, so a dashboard or an automation can see it without opening the
// panel. Opt-in (`ha_sensors`).
//
// Rules, in order of importance:
//
//   1. Never in the way of a knob. Nothing here runs on the frame path: events
//      only update a few fields, and gestures never trigger a write -- a turn
//      of the knob is thirty frames and each one would be a POST competing with
//      the light it is moving. Writes happen on a heartbeat, or a few seconds
//      after a change worth knowing about sooner (gateway lost, an alert).
//   2. One write at a time, and a failed round stops at the first failure. HA
//      being down should cost one timeout per round, not five queued behind it.
//   3. These are state-machine entries, not registry entities (no unique_id,
//      so they cannot be renamed in the UI). HA drops them on restart; the
//      heartbeat and the `ha_restored` alert put them back.
//
// Writing state into HA is the only thing this does. It never reads a light
// and never goes near the bus.

import { monotonicNow } from './clock.js';

// Alerts about HA itself: publishing on `ha_unreachable` cannot succeed, and
// the sensors' own failures would otherwise schedule more of themselves.
const NOT_WORTH_A_WRITE = new Set(['ha_unreachable']);

export function createHaSensors({
  ha,
  health,
  liveness = null,
  version = 'unknown',
  controlEnabled = false,
  gatewayHost = null,
  entityFor = () => null,
  prefix = 'dali_bridge',
  heartbeatMs = 60_000,
  minGapMs = 5_000,
  now = monotonicNow,
  wall = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  setRepeat = setInterval,
  clearRepeat = clearInterval,
} = {}) {
  if (!ha || typeof ha.setState !== 'function') throw new Error('createHaSensors requires an HA client');
  if (!health) throw new Error('createHaSensors requires health');

  const startedIso = new Date(wall()).toISOString();
  let gatewayConnected = false;
  let lastGesture = null;
  let lastAlert = null;
  let alerts = 0;

  let running = false;
  let stopped = false;
  let inFlight = null;
  let again = false;
  let soonTimer = null;
  let heartbeat = null;
  let lastRoundAt = -Infinity;
  const stats = { rounds: 0, writes: 0, failedRounds: 0 };

  function noteEvent(event) {
    if (!event || typeof event.kind !== 'string') return;
    switch (event.kind) {
      case 'inputEvent':
        // Only addressable controllers: an event without a device address
        // cannot be attributed to a knob, and saying "something moved" is not
        // information.
        if (event.target) {
          lastGesture = { at: event.ts, device: event.target, address: event.address ?? null };
        }
        break;
      case 'connection':
        if (event.status === 'connected' || event.status === 'disconnected') {
          const was = gatewayConnected;
          gatewayConnected = event.status === 'connected';
          if (was !== gatewayConnected) soon();
        }
        break;
      case 'alert':
        // Our own scan's traffic, not a fault: an automation must not fire on it.
        if (event.during_scan) break;
        alerts += 1;
        lastAlert = { alert: event.alert, at: event.ts ?? new Date(wall()).toISOString() };
        if (!NOT_WORTH_A_WRITE.has(event.alert)) soon();
        break;
    }
  }

  const entity = (domain, name) => `${domain}.${prefix}${name ? `_${name}` : ''}`;

  function states({ final = false } = {}) {
    const gw = liveness ? liveness.snapshot() : null;
    const snap = health.snapshot();
    const mapped = lastGesture?.address != null ? entityFor(lastGesture.address) : null;

    return [
      {
        entity_id: entity('sensor', 'status'),
        state: final ? 'stopped' : 'running',
        attributes: {
          friendly_name: 'DALI bridge',
          icon: 'mdi:lightbulb-group',
          version,
          control_enabled: controlEnabled,
          started: startedIso,
          // The heartbeat. A bridge that died without saying so stops moving
          // this; see DOCS.md for the automation that notices.
          last_seen: new Date(wall()).toISOString(),
        },
      },
      {
        entity_id: entity('binary_sensor', 'gateway'),
        // Unknown once we stop, not "off": nobody is watching any more.
        state: final ? 'unavailable' : gatewayConnected ? 'on' : 'off',
        attributes: {
          friendly_name: 'DALI gateway',
          device_class: 'connectivity',
          host: gatewayHost,
          http_reachable: gw ? gw.reachable ?? null : null,
          stalls: gw ? gw.stalls ?? 0 : null,
          disconnects: snap.counts.disconnects,
        },
      },
      {
        entity_id: entity('sensor', 'bus_activity'),
        state: final ? 'unavailable' : snap.bus.frames_per_minute,
        attributes: {
          friendly_name: 'DALI bus activity',
          icon: 'mdi:swap-horizontal',
          unit_of_measurement: 'frames/min',
          state_class: 'measurement',
        },
      },
      {
        entity_id: entity('sensor', 'last_gesture'),
        state: lastGesture ? lastGesture.at : 'unknown',
        attributes: {
          friendly_name: 'DALI last knob use',
          device_class: 'timestamp',
          icon: 'mdi:knob',
          device: lastGesture?.device ?? null,
          light: mapped,
        },
      },
      {
        entity_id: entity('sensor', 'last_alert'),
        state: lastAlert ? lastAlert.alert : 'none',
        attributes: {
          friendly_name: 'DALI last alert',
          icon: 'mdi:alert-circle-outline',
          at: lastAlert?.at ?? null,
          alerts_since_start: alerts,
        },
      },
    ];
  }

  async function round(opts) {
    stats.rounds += 1;
    lastRoundAt = now();
    for (const s of states(opts)) {
      let ok = false;
      try {
        ok = await ha.setState(s.entity_id, s.state, s.attributes);
      } catch {
        ok = false;
      }
      if (!ok) {
        stats.failedRounds += 1;
        return false;
      }
      stats.writes += 1;
    }
    return true;
  }

  // Coalesces: a burst of alerts during an outage is one round, not one each.
  function publish(opts) {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = round(opts).finally(() => {
      inFlight = null;
      if (again && running) {
        again = false;
        soon();
      }
    });
    return inFlight;
  }

  function soon() {
    if (!running || soonTimer) return;
    const wait = Math.max(0, lastRoundAt + minGapMs - now());
    soonTimer = setTimer(() => {
      soonTimer = null;
      if (running) publish().catch(() => {});
    }, wait);
    soonTimer?.unref?.();
  }

  function start() {
    if (running || stopped) return;
    running = true;
    publish().catch(() => {});
    heartbeat = setRepeat(() => { publish().catch(() => {}); }, heartbeatMs);
    heartbeat?.unref?.();
  }

  // Says "stopped" on the way out, so a deliberate restart does not look like
  // a crash. Bounded by the caller's shutdown budget; a crash or SIGKILL skips
  // this entirely, which is what `last_seen` is for.
  async function stop({ timeoutMs = 1500 } = {}) {
    if (stopped) return;
    stopped = true;
    const wasRunning = running;
    running = false;
    if (soonTimer) clearTimer(soonTimer);
    soonTimer = null;
    if (heartbeat) clearRepeat(heartbeat);
    heartbeat = null;
    if (!wasRunning) return;

    let budget;
    await Promise.race([
      (async () => {
        await inFlight?.catch(() => {});
        await round({ final: true });
      })(),
      new Promise((resolve) => { budget = setTimer(resolve, timeoutMs); }),
    ]).catch(() => {});
    clearTimer(budget);
  }

  return { noteEvent, publish, start, stop, states, stats: () => ({ ...stats }) };
}
