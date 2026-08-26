import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGearDiscovery } from '../lib/discover.js';

// A fake installation: entities whose lights answer on a given gear address, plus a bus
// that emits an arc level when HA changes one. No timers -- `sleep` just runs the queued
// bus traffic, so the tests are instant and deterministic.
function makeBench({ wiring, states = {}, noise = null } = {}) {
  const calls = [];
  const logs = [];
  let discovery;
  const lightState = { ...states };

  const ha = {
    getLightState: async (entity) => lightState[entity] ?? { state: 'off', brightness: null, kelvin: null },
    callService: async (domain, service, body) => {
      calls.push({ domain, service, ...body });
      const gear = wiring[body.entity_id];
      // Only a turn_on with a brightness moves a level on the bus.
      if (service === 'turn_on' && body.brightness !== undefined && gear) {
        pendingBus.push([gear, body.brightness]);
        if (noise) pendingBus.push(noise);
      }
    },
  };
  let pendingBus = [];

  discovery = createGearDiscovery({
    ha,
    deviceMap: Object.fromEntries(Object.entries(wiring).map(([entity], i) => [String(i), { entity }])),
    log: (e) => logs.push(e),
    settleMs: 0,
    gapMs: 0,
    sleep: async () => {
      // Standing in for real time passing: the bus delivers what the call provoked.
      const queued = pendingBus;
      pendingBus = [];
      for (const [gear, level] of queued) discovery.observeLevel(gear, level);
    },
  });

  return { discovery, calls, logs, lightState };
}

test('a probe identifies the gear that answered it', async () => {
  const b = makeBench({ wiring: { 'light.obyvak': 'short7' } });
  const { results } = await b.discovery.run();

  assert.equal(results.length, 1);
  assert.equal(results[0].result, 'ok');
  assert.equal(results[0].gear, 'short7', 'the gear that moved is the one that answered');
  // The daemon asked Home Assistant; it did not write to the bus.
  assert.ok(b.calls.every((c) => c.domain === 'light'));
});

test('the mapping is offered in a form that can be pasted into devices.json', async () => {
  const b = makeBench({ wiring: { 'light.obyvak': 'short7', 'light.loznice': 'short3' } });
  await b.discovery.run();

  const snippet = b.logs.find((l) => l.step === 'devices_json');
  assert.ok(snippet);
  assert.deepEqual(snippet.mapping, {
    0: { entity: 'light.obyvak', gear: 'short7' },
    1: { entity: 'light.loznice', gear: 'short3' },
  });
});

test('a light that was off is switched back off', async () => {
  const b = makeBench({
    wiring: { 'light.obyvak': 'short7' },
    states: { 'light.obyvak': { state: 'off', brightness: null, kelvin: null } },
  });
  await b.discovery.run();

  assert.equal(b.calls.at(-1).service, 'turn_off', 'a light found off must not be left on');
});

test('a light that was on is restored to its exact brightness and colour', async () => {
  const b = makeBench({
    wiring: { 'light.obyvak': 'short7' },
    states: { 'light.obyvak': { state: 'on', brightness: 61, kelvin: 3200 } },
  });
  await b.discovery.run();

  const restore = b.calls.at(-1);
  assert.equal(restore.service, 'turn_on');
  assert.equal(restore.brightness, 61);
  assert.equal(restore.color_temp_kelvin, 3200);
});

test('the probe aims away from where the light already sits', async () => {
  // Probing at 128 a light already at 128 would produce no change and no frame.
  const b = makeBench({
    wiring: { 'light.obyvak': 'short7' },
    states: { 'light.obyvak': { state: 'on', brightness: 128, kelvin: null } },
  });
  const { results } = await b.discovery.run();

  assert.notEqual(results[0].asked, 128, 'a probe must actually change something');
  assert.equal(results[0].result, 'ok');
});

test('an unrelated light moving at the same moment is not mistaken for the answer', async () => {
  // Adaptive Lighting nudging another room mid-probe, at a level nothing like the one asked for.
  const b = makeBench({ wiring: { 'light.obyvak': 'short7' }, noise: ['short2', 12] });
  const { results } = await b.discovery.run();

  assert.equal(results[0].result, 'ok');
  assert.equal(results[0].gear, 'short7', 'only the gear that landed near the asked level counts');
});

test('two gears answering the same probe is reported as ambiguous, never guessed', async () => {
  const b = makeBench({ wiring: { 'light.obyvak': 'short7' }, noise: ['short2', 128] });
  const { results } = await b.discovery.run();

  assert.equal(results[0].result, 'ambiguous');
  assert.deepEqual(results[0].candidates.sort(), ['short2', 'short7']);
  assert.equal(results[0].gear, undefined, 'no mapping is invented from an ambiguous probe');
});

test('a light nothing answers for is reported, not silently skipped', async () => {
  const b = makeBench({ wiring: { 'light.obyvak': null } });
  const { results } = await b.discovery.run();

  assert.equal(results[0].result, 'no_response');
});

test('broadcast and group frames identify nothing', async () => {
  const b = makeBench({ wiring: { 'light.obyvak': 'broadcast' } });
  const { results } = await b.discovery.run();

  assert.equal(results[0].result, 'no_response', 'a frame naming no single gear cannot answer a probe');
});

test('someone using a knob aborts discovery and the run says so', async () => {
  const b = makeBench({ wiring: { 'light.obyvak': 'short7', 'light.loznice': 'short3' } });
  const original = b.discovery.observeLevel;
  // A person turns a knob while the first probe is in flight.
  b.discovery.observeLevel = (target, level) => {
    b.discovery.abort('a controller was used during discovery');
    return original(target, level);
  };
  const { aborted, results } = await b.discovery.run();

  assert.ok(aborted, 'the run must stop rather than map against someone else"s traffic');
  assert.ok(results.length < 2, 'and must not carry on to the next room');
  assert.ok(b.logs.some((l) => l.alert === 'gear_discovery_aborted'));
});

test('an unreachable light does not stop the rest of the run', async () => {
  const b = makeBench({ wiring: { 'light.obyvak': 'short7', 'light.loznice': 'short3' } });
  b.discovery = createGearDiscovery({
    ha: { getLightState: async () => null, callService: async () => {} },
    deviceMap: { 0: { entity: 'light.obyvak' }, 1: { entity: 'light.loznice' } },
    log: () => {}, settleMs: 0, gapMs: 0, sleep: async () => {},
  });
  const { results } = await b.discovery.run();

  assert.equal(results.length, 2, 'every device is still visited');
  assert.ok(results.every((r) => r.result === 'unreachable'));
});
