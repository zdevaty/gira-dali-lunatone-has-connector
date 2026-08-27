import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayLiveness } from '../lib/liveness.js';
import { createFakeGateway } from './helpers/fake-gateway.js';

// The failure being defended against: the socket is open, the process is fine,
// and frames have simply stopped. Every knob in the building is dead and nothing
// says so. The hard part is that a quiet bus looks identical from inside, which
// is why none of these tests are about silence alone.

function harness({ probeResult = 'ok', ...options } = {}) {
  const logs = [];
  const stalls = [];
  let t = 0;
  let mode = probeResult;

  const fetchImpl = async () => {
    if (mode === 'down') throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    if (mode === '404') return { ok: false, status: 404, json: async () => ({}) };
    if (mode === '500') return { ok: false, status: 500, json: async () => ({}) };
    return {
      ok: true, status: 200,
      json: async () => ({ name: 'DALI-2 IoT', version: 'v1.18.7/1.4.6', uid: 'abc', errors: mode === 'errors' ? { line0: 'busError' } : {} }),
    };
  };

  const liveness = createGatewayLiveness({
    host: '10.0.0.230',
    idleMs: 120_000,
    log: (e) => logs.push(e),
    onStall: (silentFor) => stalls.push(silentFor),
    now: () => t,
    fetchImpl,
    setTimer: () => null, // ticks are driven by hand
    clearTimer: () => {},
    ...options,
  });

  return {
    liveness, logs, stalls,
    advance: (ms) => { t += ms; },
    setProbe: (m) => { mode = m; },
    alerts: () => logs.filter((e) => e.kind === 'alert').map((e) => e.alert),
  };
}

test('a working probe records what the gateway says about itself', async () => {
  const h = harness();
  await h.liveness.tick();
  const s = h.liveness.snapshot();
  assert.equal(s.reachable, true);
  assert.equal(s.version, 'v1.18.7/1.4.6');
  assert.equal(s.uid, 'abc');
  assert.equal(s.probeFailures, 0);
});

test('a silent socket with a reachable gateway is a stalled socket', async () => {
  const h = harness();
  h.liveness.noteConnected();
  h.liveness.noteMessage();

  h.advance(60_000);
  await h.liveness.tick();
  assert.deepEqual(h.stalls, [], 'a minute of quiet is just a quiet bus');

  h.advance(70_000); // now past idleMs
  await h.liveness.tick();
  assert.equal(h.stalls.length, 1, 'the gateway answers HTTP but the socket has not spoken: reconnect it');
  assert.ok(h.alerts().includes('gateway_socket_stalled'));
});

test('a silent socket with an unreachable gateway is NOT a stalled socket', async () => {
  // The gateway is down or the LAN is cut. Reconnecting the socket fixes
  // neither, and the socket is about to drop on its own anyway.
  const h = harness({ probeResult: 'down' });
  h.liveness.noteConnected();
  h.liveness.noteMessage();
  h.advance(300_000);
  await h.liveness.tick();
  assert.deepEqual(h.stalls, [], 'no second opinion, so no conclusion');
  assert.equal(h.liveness.snapshot().reachable, false);
});

test('any message at all resets the window', async () => {
  const h = harness();
  h.liveness.noteConnected();
  for (let i = 0; i < 5; i++) {
    h.advance(100_000);
    h.liveness.noteMessage(); // the gateway's own greeting counts, not just bus frames
    await h.liveness.tick();
  }
  assert.deepEqual(h.stalls, [], 'traffic is traffic; it proves the socket carries it');
});

test('a disconnected socket is never reported as stalled', async () => {
  const h = harness();
  h.liveness.noteConnected();
  h.liveness.noteMessage();
  h.liveness.noteDisconnected();
  h.advance(300_000);
  await h.liveness.tick();
  assert.deepEqual(h.stalls, [], 'we already know it is down; the reconnect loop owns that');
});

test('one stall is reported once, not once per probe', async () => {
  const h = harness();
  h.liveness.noteConnected();
  h.liveness.noteMessage(true);
  h.advance(200_000);

  await h.liveness.tick();
  await h.liveness.tick();
  await h.liveness.tick();
  assert.equal(h.stalls.length, 1, 'not once per probe for as long as it lasts');
});

test('a quiet bus backs the threshold off instead of reconnecting all night', async () => {
  // Measured on the real gateway: no keepalive at all, so a silent socket on an
  // idle bus is indistinguishable from a dead one. Without this back-off the
  // naive rule reconnects every two minutes from dusk until morning.
  const h = harness({ idleMs: 120_000, maxIdleMs: 960_000 });
  h.liveness.noteConnected();
  h.liveness.noteMessage(true);

  const thresholds = [];
  for (let i = 0; i < 5; i++) {
    thresholds.push(h.liveness.snapshot().idleThresholdMs);
    h.advance(h.liveness.snapshot().idleThresholdMs + 1000);
    await h.liveness.tick();
    h.liveness.noteMessage(false); // the gateway's greeting on the new connection
  }

  assert.deepEqual(thresholds, [120_000, 240_000, 480_000, 960_000, 960_000], 'doubles, then caps');
  assert.equal(h.stalls.length, 5, 'still checking, just less often');
});

test('real bus traffic resets the back-off, so a daytime stall is caught fast', async () => {
  const h = harness({ idleMs: 120_000 });
  h.liveness.noteConnected();
  h.liveness.noteMessage(true);

  h.advance(130_000);
  await h.liveness.tick();
  assert.equal(h.liveness.snapshot().idleThresholdMs, 240_000, 'backed off after a quiet stretch');

  h.liveness.noteMessage(false); // greeting: proves the socket, not the bus
  assert.equal(h.liveness.snapshot().idleThresholdMs, 240_000, 'a greeting is not evidence the bus is alive');

  h.liveness.noteMessage(true); // someone turned a light on
  assert.equal(h.liveness.snapshot().idleThresholdMs, 120_000, 'the bus is active again: back to fast detection');

  h.advance(130_000);
  await h.liveness.tick();
  assert.equal(h.stalls.length, 2, 'and a stall during an active period is caught in two minutes');
});

test('a firmware without the probe endpoint turns stall detection OFF', async () => {
  // This is the important one. With no second opinion, the only safe response to
  // silence is nothing: reconnecting a quiet-but-healthy link every two minutes
  // all night would drop frames during the one gesture that mattered.
  const h = harness({ probeResult: '404' });
  await h.liveness.tick();
  assert.ok(h.alerts().includes('gateway_probe_unavailable'));
  assert.equal(h.liveness.snapshot().probeDisabled, true);

  h.liveness.noteConnected();
  h.liveness.noteMessage();
  h.advance(600_000);
  await h.liveness.tick();
  assert.deepEqual(h.stalls, [], 'ten minutes of silence, and still no guess');
});

test('bus errors the gateway reports are surfaced once per distinct fault', async () => {
  const h = harness({ probeResult: 'errors' });
  await h.liveness.tick();
  await h.liveness.tick();
  await h.liveness.tick();
  assert.equal(h.alerts().filter((a) => a === 'gateway_bus_errors').length, 1, 'once, not every thirty seconds');

  h.setProbe('ok');
  await h.liveness.tick();
  assert.ok(h.alerts().includes('gateway_bus_errors_cleared'));
});

test('a failing reconnect handler cannot take the prober down', async () => {
  const h = harness({ onStall: () => { throw new Error('reconnect blew up'); } });
  h.liveness.noteConnected();
  h.liveness.noteMessage();
  h.advance(200_000);
  await h.liveness.tick(); // must not reject
  assert.ok(h.alerts().includes('gateway_socket_stalled'));
});

test('the probe works over real HTTP against the gateway shape', async () => {
  const gw = createFakeGateway();
  const port = await gw.listen();
  const logs = [];
  const liveness = createGatewayLiveness({
    host: `127.0.0.1:${port}`,
    log: (e) => logs.push(e),
    setTimer: () => null,
    clearTimer: () => {},
  });

  const body = await liveness.probe();
  assert.equal(body.name, 'DALI-2 IoT');
  assert.equal(liveness.snapshot().reachable, true);
  assert.equal(liveness.snapshot().version, 'v1.18.7/1.4.6');

  gw.setInfoErrors({ line0: 'busError' });
  await liveness.probe();
  assert.equal(logs.at(-1).alert, 'gateway_bus_errors');

  gw.setInfoStatus(404);
  await liveness.probe();
  assert.equal(liveness.snapshot().probeDisabled, true);

  await gw.close();
});

test('the gateway identifies itself in the capture, once', async () => {
  const h = harness();
  await h.liveness.tick();
  await h.liveness.tick();
  const ids = h.logs.filter((e) => e.kind === 'gateway');
  assert.equal(ids.length, 1, 'once per run, not once per probe');
  assert.equal(ids[0].version, 'v1.18.7/1.4.6');
  assert.equal(ids[0].name, 'DALI-2 IoT');
});
