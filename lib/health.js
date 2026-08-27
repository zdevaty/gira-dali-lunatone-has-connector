// What the daemon knows about itself.
//
// Two audiences with different needs, and conflating them is a classic and
// expensive mistake:
//
//   alive()    -- for the Supervisor watchdog. OUR liveness only. It must never
//                 go false because Home Assistant or the gateway is down:
//                 restarting us would fix neither and would cost wall-switch
//                 availability for nothing.
//   snapshot() -- for a person looking at the Health page, where the state of
//                 everything we depend on is exactly what they came to see.

import { monotonicNow } from './clock.js';

const SECOND_BUCKETS = 60;

export function createHealth({
  version = 'unknown',
  runtime = 'standalone',
  controlEnabled = false,
  now = monotonicNow,
  wall = () => Date.now(),
  sampleMs = 500,
  lagSamples = 240,
} = {}) {
  const startedMono = now();
  const startedWall = wall();

  const kinds = new Map();
  const buckets = new Array(SECOND_BUCKETS).fill(0);
  let bucketIndex = 0;
  let bucketAt = now();

  const counts = {
    frames: 0,
    alerts: 0,
    connects: 0,
    disconnects: 0,
    haCalls: 0,
    gestures: 0,
    frameErrors: 0,
    clockSteps: 0,
    commandsDropped: 0,
  };

  let lastFrameAt = null;
  let lastAlert = null;
  const lag = [];
  let lagTimer = null;

  const FRAME_KINDS = new Set([
    'level', 'colour', 'raw', 'command', 'response', 'orphan_response', 'unknown', 'inputEvent',
  ]);

  function rollBuckets() {
    const t = now();
    const elapsed = Math.floor((t - bucketAt) / 1000);
    if (elapsed <= 0) return;

    // Walking more than the whole ring is pointless -- everything is stale --
    // but the clock must still jump the FULL distance. Advancing it only by the
    // clamped amount leaves a permanent backlog, so every later call re-clears
    // the buckets and the rate reads zero forever. On a bus that is idle most
    // of the night, that is the normal case, not an edge one.
    const steps = Math.min(elapsed, SECOND_BUCKETS);
    for (let i = 0; i < steps; i++) {
      bucketIndex = (bucketIndex + 1) % SECOND_BUCKETS;
      buckets[bucketIndex] = 0;
    }
    bucketAt += elapsed * 1000;
  }

  // Every emitted event passes through here. Deliberately total: a kind nobody
  // thought about still gets counted rather than silently ignored.
  function noteEvent(event) {
    if (!event || typeof event.kind !== 'string') return;
    kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);

    if (FRAME_KINDS.has(event.kind)) {
      counts.frames += 1;
      lastFrameAt = now();
      rollBuckets();
      buckets[bucketIndex] += 1;
      if (event.kind === 'inputEvent') counts.gestures += 1;
    }

    switch (event.kind) {
      case 'alert':
        counts.alerts += 1;
        lastAlert = { alert: event.alert, ts: event.ts ?? new Date(wall()).toISOString() };
        if (event.alert === 'clock_step') counts.clockSteps += 1;
        if (event.alert === 'frame_handler_failed') counts.frameErrors = event.count ?? counts.frameErrors + 1;
        if (event.alert === 'command_dropped') counts.commandsDropped = event.dropped ?? counts.commandsDropped + 1;
        break;
      case 'connection':
        if (event.status === 'connected') counts.connects += 1;
        if (event.status === 'disconnected') counts.disconnects += 1;
        break;
      case 'control':
        counts.haCalls += 1;
        break;
    }
  }

  function framesPerMinute() {
    rollBuckets();
    return buckets.reduce((a, b) => a + b, 0);
  }

  function percentile(sorted, p) {
    if (sorted.length === 0) return null;
    const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return Math.round(sorted[i] * 10) / 10;
  }

  function start() {
    if (lagTimer) return;
    let expected = now() + sampleMs;
    lagTimer = setInterval(() => {
      const t = now();
      lag.push(Math.max(0, t - expected));
      if (lag.length > lagSamples) lag.shift();
      expected = t + sampleMs;
    }, sampleMs);
    lagTimer.unref?.();
  }

  function stop() {
    if (!lagTimer) return;
    clearInterval(lagTimer);
    lagTimer = null;
  }

  // Cheap, synchronous, and safe to call on every request.
  function alive() {
    return { ok: true, uptime_s: Math.round((now() - startedMono) / 1000), version };
  }

  function snapshot(extra = {}) {
    const sortedLag = [...lag].sort((a, b) => a - b);
    const mem = process.memoryUsage?.() ?? {};
    return {
      version,
      runtime,
      control_enabled: controlEnabled,
      started: new Date(startedWall).toISOString(),
      uptime_s: Math.round((now() - startedMono) / 1000),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      process: {
        pid: process.pid,
        node: process.version,
        rss_mb: mem.rss ? Math.round(mem.rss / 1048576) : null,
        heap_mb: mem.heapUsed ? Math.round(mem.heapUsed / 1048576) : null,
        loop_lag_ms: { p50: percentile(sortedLag, 50), p99: percentile(sortedLag, 99), samples: lag.length },
      },
      bus: {
        frames: counts.frames,
        frames_per_minute: framesPerMinute(),
        last_frame_age_s: lastFrameAt === null ? null : Math.round((now() - lastFrameAt) / 1000),
        by_kind: Object.fromEntries([...kinds.entries()].sort((a, b) => b[1] - a[1])),
      },
      counts: { ...counts },
      last_alert: lastAlert,
      ...extra,
    };
  }

  return { noteEvent, snapshot, alive, start, stop, framesPerMinute };
}
