import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealth } from '../lib/health.js';

function harness(options = {}) {
  let t = 0;
  const health = createHealth({ version: '0.3.0', now: () => t, wall: () => 1_700_000_000_000, ...options });
  return { health, advance: (ms) => { t += ms; }, at: () => t };
}

test('alive() reports only our own liveness', () => {
  // The Supervisor watchdog points at this. If it went unhealthy because Home
  // Assistant or the gateway were down, the Supervisor would restart us --
  // fixing neither, and costing wall-switch availability to do it.
  const h = harness();
  h.advance(90_000);
  const a = h.health.alive();
  assert.equal(a.ok, true);
  assert.equal(a.uptime_s, 90);
  assert.deepEqual(Object.keys(a).sort(), ['ok', 'uptime_s', 'version']);
});

test('frames are counted by kind, and gestures separately', () => {
  const h = harness();
  h.health.noteEvent({ kind: 'level', level: 1 });
  h.health.noteEvent({ kind: 'level', level: 2 });
  h.health.noteEvent({ kind: 'inputEvent', instanceType: 'generic' });
  h.health.noteEvent({ kind: 'startup' });

  const s = h.health.snapshot();
  assert.equal(s.bus.frames, 3, 'startup is not a bus frame');
  assert.equal(s.bus.by_kind.level, 2);
  assert.equal(s.counts.gestures, 1);
});

test('frames per minute rolls off, so an idle bus reads as idle', () => {
  const h = harness();
  for (let i = 0; i < 10; i++) h.health.noteEvent({ kind: 'level' });
  assert.equal(h.health.framesPerMinute(), 10);

  h.advance(30_000);
  assert.equal(h.health.framesPerMinute(), 10, 'still inside the window');

  h.advance(31_000);
  assert.equal(h.health.framesPerMinute(), 0, 'and gone once the window passes');
});

test('a long silence does not corrupt the buckets', () => {
  const h = harness();
  h.health.noteEvent({ kind: 'level' });
  h.advance(6 * 60 * 60 * 1000); // a quiet night
  assert.equal(h.health.framesPerMinute(), 0);
  h.health.noteEvent({ kind: 'level' });
  assert.equal(h.health.framesPerMinute(), 1, 'and it starts counting again cleanly');
});

test('last frame age is what tells you the bus went quiet', () => {
  const h = harness();
  assert.equal(h.health.snapshot().bus.last_frame_age_s, null, 'nothing seen yet is not zero');
  h.health.noteEvent({ kind: 'level' });
  h.advance(45_000);
  assert.equal(h.health.snapshot().bus.last_frame_age_s, 45);
});

test('connections, alerts and HA calls are tallied', () => {
  const h = harness();
  h.health.noteEvent({ kind: 'connection', status: 'connected' });
  h.health.noteEvent({ kind: 'connection', status: 'disconnected' });
  h.health.noteEvent({ kind: 'connection', status: 'connected' });
  h.health.noteEvent({ kind: 'control', action: 'brightness_step' });
  h.health.noteEvent({ kind: 'alert', alert: 'clock_step', ts: '2026-08-27T10:00:00.000Z' });

  const s = h.health.snapshot();
  assert.equal(s.counts.connects, 2);
  assert.equal(s.counts.disconnects, 1);
  assert.equal(s.counts.haCalls, 1);
  assert.equal(s.counts.clockSteps, 1);
  assert.equal(s.last_alert.alert, 'clock_step');
});

test('alerts that carry their own running total are trusted over ours', () => {
  const h = harness();
  h.health.noteEvent({ kind: 'alert', alert: 'command_dropped', dropped: 17 });
  assert.equal(h.health.snapshot().counts.commandsDropped, 17);
});

test('event loop lag is sampled and reported as percentiles', async () => {
  // Real timers here: the point is to measure the real loop, so a fake clock
  // would only prove the arithmetic.
  const health = createHealth({ version: 'x', sampleMs: 10, lagSamples: 50 });
  health.start();
  await new Promise((r) => setTimeout(r, 120));
  health.stop();

  const lag = health.snapshot().process.loop_lag_ms;
  assert.ok(lag.samples > 0, 'something was measured');
  assert.ok(lag.p50 !== null && lag.p50 >= 0);
  assert.ok(lag.p99 >= lag.p50, 'p99 is not below p50');
});

test('snapshot merges in what other subsystems own', () => {
  const h = harness();
  const s = h.health.snapshot({ gateway: { reachable: true }, logs: { bytes: 42 } });
  assert.equal(s.gateway.reachable, true);
  assert.equal(s.logs.bytes, 42);
  assert.equal(s.version, '0.3.0', 'and does not lose its own fields');
});

test('a malformed event cannot break the counters', () => {
  const h = harness();
  for (const bad of [null, undefined, {}, { kind: 5 }, 'nonsense']) {
    assert.doesNotThrow(() => h.health.noteEvent(bad));
  }
  assert.equal(h.health.snapshot().bus.frames, 0);
});
