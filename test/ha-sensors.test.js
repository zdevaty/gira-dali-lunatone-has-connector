import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealth } from '../lib/health.js';
import { createHaSensors } from '../lib/ha-sensors.js';

// A clock and timers we move by hand, and an HA that records writes and can be
// made to fail or hang.
function harness(options = {}) {
  let t = 0;
  const timers = new Map();
  let nextId = 1;
  const setTimer = (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: t + ms }); return id; };
  const clearTimer = (id) => { timers.delete(id); };
  const repeats = new Map();
  const setRepeat = (fn, ms) => { const id = nextId++; repeats.set(id, { fn, every: ms, at: t + ms }); return id; };
  const clearRepeat = (id) => { repeats.delete(id); };

  const writes = [];
  const ha = {
    fail: false,
    hang: false,
    async setState(entity_id, state, attributes) {
      if (ha.hang) return new Promise(() => {});
      if (ha.fail) return false;
      writes.push({ entity_id, state, attributes });
      return true;
    },
  };

  const health = createHealth({ now: () => t });
  const sensors = createHaSensors({
    ha, health,
    version: '9.9.9',
    gatewayHost: '10.0.0.230',
    now: () => t,
    wall: () => 1_758_000_000_000 + t,
    setTimer, clearTimer, setRepeat, clearRepeat,
    ...options,
  });

  const flush = () => new Promise((r) => setImmediate(r));
  async function advance(ms) {
    const end = t + ms;
    for (;;) {
      const due = [...timers.entries(), ...repeats.entries()]
        .filter(([, v]) => v.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, v] = due;
      t = Math.max(t, v.at);
      if (repeats.has(id)) v.at += v.every; else timers.delete(id);
      v.fn();
      await flush();
    }
    t = end;
    await flush();
  }

  const latest = (id) => [...writes].reverse().find((w) => w.entity_id === id);
  // Every event the daemon emits reaches both, as in index.js.
  const emit = (event) => { health.noteEvent(event); sensors.noteEvent(event); };
  return { ha, health, sensors, writes, advance, flush, latest, emit, timers };
}

test('start publishes every sensor once, with the gateway not yet connected', async () => {
  const h = harness();
  h.sensors.start();
  await h.flush();

  assert.deepEqual(h.writes.map((w) => w.entity_id), [
    'sensor.dali_bridge_status',
    'binary_sensor.dali_bridge_gateway',
    'sensor.dali_bridge_bus_activity',
    'sensor.dali_bridge_last_gesture',
    'sensor.dali_bridge_last_alert',
  ]);
  assert.equal(h.latest('sensor.dali_bridge_status').state, 'running');
  assert.equal(h.latest('sensor.dali_bridge_status').attributes.version, '9.9.9');
  assert.equal(h.latest('binary_sensor.dali_bridge_gateway').state, 'off');
  assert.equal(h.latest('binary_sensor.dali_bridge_gateway').attributes.device_class, 'connectivity');
  assert.equal(h.latest('sensor.dali_bridge_last_gesture').state, 'unknown');
  assert.equal(h.latest('sensor.dali_bridge_last_alert').state, 'none');
  h.sensors.stop();
});

test('knob frames never trigger a write: the heartbeat carries them', async () => {
  // A single turn is ~30 frames. A POST per frame would compete with the very
  // light the knob is moving.
  const h = harness({ entityFor: (address) => (address === 3 ? 'light.kitchen' : null) });
  h.sensors.start();
  await h.flush();
  const before = h.writes.length;

  for (let i = 0; i < 30; i++) {
    h.emit({ kind: 'inputEvent', ts: '2026-09-16T18:00:00.000Z', target: 'short3', address: 3, instance: 3 });
    await h.advance(100);
  }
  await h.advance(10_000);
  assert.equal(h.writes.length, before, 'no write for a gesture before the heartbeat');

  await h.advance(60_000);
  const gesture = h.latest('sensor.dali_bridge_last_gesture');
  assert.equal(gesture.state, '2026-09-16T18:00:00.000Z');
  assert.equal(gesture.attributes.device, 'short3');
  assert.equal(gesture.attributes.light, 'light.kitchen');
  h.sensors.stop();
});

test('an event without a device address is not a gesture we can name', async () => {
  const h = harness();
  h.emit({ kind: 'inputEvent', ts: '2026-09-16T18:00:00.000Z', scheme: 'instance' });
  assert.equal(h.sensors.states().find((s) => s.entity_id.endsWith('last_gesture')).state, 'unknown');
});

test('losing the gateway is published within seconds, not at the next heartbeat', async () => {
  const h = harness();
  h.sensors.start();
  await h.flush();
  h.emit({ kind: 'connection', status: 'connected' });
  await h.advance(5_000);
  assert.equal(h.latest('binary_sensor.dali_bridge_gateway').state, 'on');

  h.emit({ kind: 'connection', status: 'disconnected' });
  await h.advance(5_000);
  assert.equal(h.latest('binary_sensor.dali_bridge_gateway').state, 'off');
  h.sensors.stop();
});

test('a burst of alerts is one round, spaced from the last one', async () => {
  const h = harness();
  h.sensors.start();
  await h.flush();
  const rounds = h.sensors.stats().rounds;

  for (let i = 0; i < 20; i++) h.emit({ kind: 'alert', alert: 'unmapped_device', ts: `2026-09-16T18:00:0${i % 10}.000Z` });
  await h.advance(5_000);

  assert.equal(h.sensors.stats().rounds, rounds + 1);
  const last = h.latest('sensor.dali_bridge_last_alert');
  assert.equal(last.state, 'unmapped_device');
  assert.equal(last.attributes.alerts_since_start, 20);
  h.sensors.stop();
});

test('HA down costs one failed write per round, not one per sensor', async () => {
  const h = harness();
  h.ha.fail = true;
  let attempts = 0;
  const original = h.ha.setState;
  h.ha.setState = async (...args) => { attempts += 1; return original(...args); };

  h.sensors.start();
  await h.flush();
  await h.advance(60_000);
  assert.equal(attempts, 2, 'two rounds (start + heartbeat), one attempt each');
  assert.equal(h.sensors.stats().failedRounds, 2);
  h.sensors.stop();
});

test('ha_unreachable does not schedule a write, ha_restored does: HA forgot the sensors', async () => {
  const h = harness();
  h.sensors.start();
  await h.flush();
  const rounds = h.sensors.stats().rounds;

  h.emit({ kind: 'alert', alert: 'ha_unreachable' });
  await h.advance(10_000);
  assert.equal(h.sensors.stats().rounds, rounds, 'nothing to write to');

  h.emit({ kind: 'alert', alert: 'ha_restored' });
  await h.advance(5_000);
  assert.equal(h.sensors.stats().rounds, rounds + 1);
  h.sensors.stop();
});

test('a hung HA holds one round, never a pile of them', async () => {
  const h = harness();
  h.ha.hang = true;
  h.sensors.start();
  await h.flush();
  for (let i = 0; i < 10; i++) {
    h.emit({ kind: 'alert', alert: 'gateway_socket_stalled' });
    await h.advance(60_000);
  }
  assert.equal(h.sensors.stats().rounds, 1);
});

test('stopping says so: status stopped, gateway unavailable, no timers left', async () => {
  const h = harness();
  h.sensors.start();
  await h.flush();
  h.emit({ kind: 'connection', status: 'connected' });

  await h.sensors.stop();
  assert.equal(h.latest('sensor.dali_bridge_status').state, 'stopped');
  assert.equal(h.latest('binary_sensor.dali_bridge_gateway').state, 'unavailable');
  assert.equal(h.latest('sensor.dali_bridge_bus_activity').state, 'unavailable');
  assert.equal(h.timers.size, 0);

  const count = h.writes.length;
  await h.advance(120_000);
  assert.equal(h.writes.length, count, 'nothing after stop');
});

test('stopping against a hung HA is bounded by the shutdown budget', async () => {
  let t = 0;
  const health = createHealth({ now: () => t });
  const sensors = createHaSensors({
    ha: { setState: () => new Promise(() => {}) },
    health,
    heartbeatMs: 3_600_000,
  });
  sensors.start();
  const started = Date.now();
  await sensors.stop({ timeoutMs: 50 });
  assert.ok(Date.now() - started < 1000, 'the Supervisor SIGKILLs ten seconds after SIGTERM');
});

test('nothing it publishes looks like a credential', () => {
  const h = harness();
  const text = JSON.stringify(h.sensors.states());
  assert.doesNotMatch(text, /token|eyJ[A-Za-z0-9_-]{10,}/i);
});
