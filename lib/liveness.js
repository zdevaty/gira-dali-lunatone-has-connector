// Is the socket dead, or is the bus just quiet?
//
// A half-open TCP connection is the worst failure this daemon has, because
// nothing about it looks wrong: the process is healthy, the socket is open, and
// frames have simply stopped. Every knob in the building is dead and the log
// says nothing at all.
//
// Silence on its own cannot be the trigger. A DALI bus with nobody home is
// legitimately silent for hours, and reconnecting every couple of minutes all
// night to prove otherwise would drop events during the one gesture that
// mattered. So the stall rule needs a SECOND, independent opinion: a plain HTTP
// GET to the gateway. If that answers while the socket has said nothing for a
// long time, the socket is the problem.
//
// The probe is a GET, and only ever a GET. It cannot put a frame on the DALI bus
// under any circumstances -- which is the whole reason it is preferred here over
// the gateway's own WebSocket ping, even though that ping exists.

import { monotonicNow } from './clock.js';

export function createGatewayLiveness({
  host,
  probePath = '/info',
  probeEveryMs = 30_000,
  idleMs = 120_000,
  maxIdleMs = 3_600_000,
  timeoutMs = 4000,
  onStall = () => {},
  log = () => {},
  now = monotonicNow,
  fetchImpl = fetch,
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (h) => clearInterval(h),
} = {}) {
  if (!host) throw new Error('createGatewayLiveness requires a host');

  const url = `http://${host}${probePath}`;
  let timer = null;
  let connected = false;
  let lastMessageAt = null;
  let stallReported = false;

  // Measured on the real gateway (27 Aug 2026, firmware v1.18.7/1.4.6): it sends
  // one `info` greeting on connect and then NOTHING -- 300 s of an idle bus
  // produced not one further message, and it never dropped the client. So there
  // is no keepalive to lean on, and a silent socket on a quiet bus is
  // indistinguishable from a dead one except via the HTTP probe.
  //
  // Which means the naive rule reconnects every idleMs all night for no reason:
  // roughly 700 times before morning. So each silence-triggered reconnect that
  // turns up no actual bus traffic doubles the threshold, up to maxIdleMs. Real
  // traffic resets it, so a genuine stall during the day is still caught in
  // about two minutes, while a quiet night costs a handful of reconnects.
  let idleStreak = 0;
  const currentIdleMs = () => Math.min(idleMs * 2 ** idleStreak, maxIdleMs);

  // Set once the gateway tells us this endpoint is not there. Without a working
  // probe there is no second opinion, and the ONLY safe thing to do about
  // silence is nothing: reconnecting a quiet-but-healthy link every idleMs would
  // cost frames for no reason.
  let probeDisabled = false;

  let lastErrorSignature = null;
  let identified = false;
  const state = {
    reachable: null,
    latencyMs: null,
    version: null,
    uid: null,
    lastProbeAt: null,
    probeFailures: 0,
    stalls: 0,
  };

  function noteConnected() {
    connected = true;
    lastMessageAt = now();
    stallReported = false;
  }

  function noteDisconnected() {
    connected = false;
    lastMessageAt = null;
  }

  // Called for EVERY message, not just decoded bus frames: anything arriving at
  // all proves the socket carries traffic, which is the only question here.
  //
  // `busFrame` is separate because the greeting arrives on every reconnect and
  // so cannot be evidence that the BUS is active -- only that the socket is. Only
  // real bus traffic clears the escalation.
  function noteMessage(busFrame = false) {
    lastMessageAt = now();
    stallReported = false;
    if (busFrame) idleStreak = 0;
  }

  async function probe() {
    const started = now();
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      state.lastProbeAt = started;
      state.latencyMs = Math.round(now() - started);

      if (res.status === 404) {
        probeDisabled = true;
        state.reachable = true;
        log({
          kind: 'alert', alert: 'gateway_probe_unavailable', url,
          note: 'this firmware has no such endpoint; stall detection is off, because silence alone cannot tell a dead socket from a quiet bus',
        });
        return null;
      }
      if (!res.ok) {
        state.probeFailures += 1;
        state.reachable = false;
        return null;
      }

      const body = await res.json().catch(() => null);
      state.reachable = true;
      state.probeFailures = 0;
      if (body) {
        state.version = body.version ?? state.version;
        state.uid = body.uid ?? state.uid;
        // Once: a capture found weeks later should say which gateway and which
        // firmware produced it, the same way the startup line says which build
        // of this daemon wrote it.
        if (!identified) {
          identified = true;
          log({
            kind: 'gateway', name: body.name ?? null, version: body.version ?? null,
            uid: body.uid ?? null, tier: body.tier ?? null,
            lines: body.descriptor?.lines ?? null,
          });
        }
        reportBusErrors(body.errors);
      }
      return body;
    } catch (err) {
      state.lastProbeAt = started;
      state.probeFailures += 1;
      state.reachable = false;
      state.latencyMs = null;
      return null;
    }
  }

  // The gateway reports its own bus health. Worth surfacing, but once per
  // distinct fault -- not once every thirty seconds for as long as it lasts.
  function reportBusErrors(errors) {
    if (!errors || typeof errors !== 'object') return;
    const keys = Object.keys(errors);
    const signature = keys.length ? JSON.stringify(errors) : null;
    if (signature === lastErrorSignature) return;
    lastErrorSignature = signature;
    if (signature) {
      log({ kind: 'alert', alert: 'gateway_bus_errors', errors, note: 'reported by the gateway itself, not decoded from the bus' });
    } else {
      log({ kind: 'alert', alert: 'gateway_bus_errors_cleared' });
    }
  }

  async function tick() {
    await probe();

    if (!connected || probeDisabled || lastMessageAt === null) return;
    if (state.reachable !== true) return; // the gateway is down; reconnecting proves nothing
    const threshold = currentIdleMs();
    const silentFor = now() - lastMessageAt;
    if (silentFor < threshold || stallReported) return;

    stallReported = true;
    state.stalls += 1;
    idleStreak += 1;
    log({
      kind: 'alert', alert: 'gateway_socket_stalled',
      silent_for_ms: Math.round(silentFor), threshold_ms: Math.round(threshold),
      next_threshold_ms: Math.round(currentIdleMs()), probe_latency_ms: state.latencyMs,
      note: 'the gateway answers HTTP but the monitor socket has gone quiet; reconnecting it. This gateway sends no keepalive, so a genuinely idle bus looks the same -- the threshold backs off until real bus traffic returns',
    });
    try {
      onStall(silentFor);
    } catch {
      // A failing reconnect handler must not take the prober down with it.
    }
  }

  function start() {
    if (timer) return;
    tick().catch(() => {});
    timer = setTimer(() => { tick().catch(() => {}); }, probeEveryMs);
    timer?.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearTimer(timer);
    timer = null;
  }

  return {
    start, stop, tick, probe,
    noteConnected, noteDisconnected, noteMessage,
    snapshot: () => ({
      ...state,
      connected,
      probeDisabled,
      idleThresholdMs: currentIdleMs(),
      silentForMs: lastMessageAt === null ? null : Math.round(now() - lastMessageAt),
    }),
  };
}
