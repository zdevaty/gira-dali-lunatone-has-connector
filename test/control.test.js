import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../lib/control.js';
import { createHaClient } from '../lib/ha-client.js';
import { createDecoder } from '../lib/decoder.js';

const hex = (str) => str.split(' ').map((b) => parseInt(b, 16));

// Event builders matching the decoder's inputEvent shape (address A0). `scheme` is
// part of that shape: only device/instance addressing carries an address at all.
const ev = (address, rest) => ({ kind: 'inputEvent', scheme: 'device_instance', address, target: `short${address}`, ...rest });
const btn = (event, address = 0) => ev(address, { instance: 0, instanceType: 'pushButton', event });
const gen = (event, address = 0) => ev(address, { instance: 1, instanceType: 'generic', event });
const abs = (value, address = 0) => ev(address, { instance: 3, instanceType: 'absoluteInput', value });

function makeHarness({ deviceMap, kelvin = 4000, brightness = 128, ...options } = {}) {
  const calls = [];
  const logs = [];
  const timers = new Set();
  let currentTime = 0;

  const ha = {
    getLightKelvin: async () => kelvin,
    getLightBrightness: async () => brightness,
    callService: async (domain, service, body) => {
      calls.push({ domain, service, ...body });
    },
  };

  const controller = createController({
    deviceMap: deviceMap ?? { 0: { entity: 'light.obyvak', min_kelvin: 2700, max_kelvin: 6500 } },
    ha,
    log: (event) => logs.push(event),
    now: () => currentTime,
    setTimer: (fn, ms) => {
      const timer = { fn, at: currentTime + ms };
      timers.add(timer);
      return timer;
    },
    clearTimer: (timer) => timers.delete(timer),
    ...options,
  });

  // Flush pending microtasks so chained HA calls land before assertions.
  async function settle() {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  async function advance(ms) {
    currentTime += ms;
    for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
      if (timer.at <= currentTime) {
        timers.delete(timer);
        timer.fn();
      }
    }
    await settle();
  }

  async function feed(events, stepMs = 0) {
    for (const event of events) {
      controller.handleEvent(event);
      await settle();
      if (stepMs) await advance(stepMs);
    }
    await settle();
  }

  // A clock STEP, as distinct from time passing: the reading changes but no
  // interval has elapsed, so nothing becomes due. This is what NTP does to a
  // Raspberry Pi a few seconds after boot, in either direction.
  function jump(ms) {
    currentTime += ms;
  }

  return { controller, calls, logs, feed, advance, settle, jump, now: () => currentTime };
}

// A device map with the gear address spelled out. There is no default for it, so any
// test that exercises the bus cross-check has to say which gear the entity drives.
const mappedTo = (gear) => ({ 0: { entity: 'light.obyvak', min_kelvin: 2700, max_kelvin: 6500, gear } });

const brightnessCalls = (calls) => calls.filter((c) => c.brightness_step !== undefined);
const colourCalls = (calls) => calls.filter((c) => c.color_temp_kelvin !== undefined);

test('fixture: press + turn right then left maps entirely to colour, never brightness', async () => {
  const h = makeHarness();
  // Real capture from addendum section 7, including long_stop arriving BEFORE
  // the last two position events of the same gesture.
  await h.feed([
    btn('pressed'),
    gen('start_right'),
    abs(82),
    abs(83),
    btn('long_start'),
    abs(108),
    btn('long_repeat'),
    abs(133),
    abs(158),
    gen('stop'),
    gen('start_left'),
    abs(133),
    abs(108),
    btn('long_stop'),
    abs(83),
    abs(82),
    gen('stop'),
  ]);

  assert.equal(brightnessCalls(h.calls).length, 0, 'a colour gesture must never touch brightness');
  assert.ok(colourCalls(h.calls).length > 0, 'colour calls should have been made');
  assert.equal(h.calls.filter((c) => c.service === 'toggle').length, 0);
});

test('fixture: position events after long_stop still map to colour (200ms grace window)', async () => {
  const h = makeHarness();
  await h.feed([btn('pressed'), gen('start_right'), abs(82), abs(83), btn('long_stop')]);
  const colourBefore = colourCalls(h.calls).length;

  // Within the grace window: still colour. The delta is classified when the event
  // arrives, so it stays colour even though the throttled flush lands later.
  await h.advance(50);
  await h.feed([abs(108)]);
  await h.advance(200);
  assert.equal(brightnessCalls(h.calls).length, 0);
  assert.ok(colourCalls(h.calls).length > colourBefore, 'grace-window position event should produce a colour call');

  // Past the grace window: back to brightness.
  await h.advance(500);
  await h.feed([abs(133)]);
  await h.advance(200);
  assert.equal(brightnessCalls(h.calls).length, 1, 'after grace expires, position maps to brightness again');
});

test('fixture: gesture at the end stop still drives colour though every position reads 0', async () => {
  const h = makeHarness();
  await h.feed([
    btn('pressed'),
    gen('start_left'),
    abs(57),
    abs(0),
    btn('long_start'),
    btn('long_repeat'),
    abs(0), // knob still turning, counter saturated
    btn('long_stop'),
    abs(0),
    gen('stop'),
  ]);

  const colour = colourCalls(h.calls);
  assert.ok(colour.length > 0, 'saturated positions must still produce colour calls');
  assert.equal(brightnessCalls(h.calls).length, 0);
  // Turning left lowers kelvin and it must never fall below the configured floor.
  assert.ok(colour.every((c) => c.color_temp_kelvin >= 2700 && c.color_temp_kelvin <= 6500));
});

test('saturated events step in the current direction rather than stalling', async () => {
  const h = makeHarness({ saturatedStep: 4 });
  // Establish baseline, then feed repeated identical positions while turning right.
  await h.feed([gen('start_right'), abs(200), abs(200)]);
  await h.advance(300);
  await h.feed([abs(200)]);
  await h.advance(300);
  const steps = brightnessCalls(h.calls).map((c) => c.brightness_step);
  assert.ok(steps.length > 0);
  assert.ok(steps.every((s) => s > 0), `expected positive steps while turning right, got ${steps}`);
});

test('rotation without a press changes only brightness', async () => {
  const h = makeHarness();
  await h.feed([gen('start_right'), abs(105), abs(106), abs(131), gen('stop')]);

  assert.equal(colourCalls(h.calls).length, 0, 'no press means no colour change');
  const steps = brightnessCalls(h.calls);
  assert.ok(steps.length > 0);
  // 105 is the baseline. The encoder's +1 (slowest tier) maps to a step of 2 and its
  // +25 maps to 25, accumulating to 27 across coalesced calls.
  assert.equal(steps.reduce((sum, c) => sum + c.brightness_step, 0), 27);
});

// Rotation speed: the encoder resolves four tiers (1/25/55/80 counts per report) and
// loses all of it once the counter pins at an end stop.
test('the four encoder speed tiers map onto the configured curve', async () => {
  // A separate harness per tier: the position counter is free-running, so its baseline
  // deliberately carries across gestures and a shared one would add a step between them.
  const measured = [];
  for (const [from, to] of [[100, 101], [100, 125], [100, 155], [100, 180]]) {
    const h = makeHarness({ brightness: 3 });
    await h.feed([gen('start_right'), abs(from), abs(to), gen('stop')], 300);
    await h.advance(500);
    measured.push(brightnessCalls(h.calls).map((c) => c.brightness_step));
  }
  // 1 -> 2, 25 -> 25, 55 -> 55, 80 -> 80.
  assert.deepEqual(measured, [[2], [25], [55], [80]]);
});

test('the slowest tier is no longer a single step', async () => {
  const h = makeHarness({ brightness: 128 });
  await h.feed([gen('start_right'), abs(100), abs(101), gen('stop')], 300);
  await h.advance(500);
  // The encoder's smallest movement was reaching HA as brightness_step 1, which is
  // imperceptible on a 255 scale.
  assert.equal(brightnessCalls(h.calls)[0].brightness_step, 2);
});

test('speed survives the end stop: a pinned counter keeps the last measured tier', async () => {
  // Starting low so the 255 ceiling never clamps a step and hides the tier.
  const h = makeHarness({ brightness: 3 });
  // Turn fast up to the top of the counter, then keep turning while it reports 255.
  await h.feed([gen('start_right'), abs(95), abs(175), abs(255), abs(255)], 300);
  await h.advance(500);

  const steps = brightnessCalls(h.calls).map((c) => c.brightness_step);
  // The +80 tier must carry through the pinned report rather than collapsing to the
  // slowest step the moment the counter runs out of room.
  assert.deepEqual(steps, [80, 80, 80], 'position in the counter must not change the feel');
});

test('a report clipped by the end stop is not read as slowing down', async () => {
  const h = makeHarness({ brightness: 3 });
  // 225 -> 250 is a clean +25. 250 -> 255 is the same speed with only 5 counts of room
  // left, which would classify as the slowest tier if its magnitude were taken literally.
  await h.feed([gen('start_right'), abs(200), abs(225), abs(250), abs(255), abs(255)], 300);
  await h.advance(500);

  const steps = brightnessCalls(h.calls).map((c) => c.brightness_step);
  assert.deepEqual(steps, [25, 25, 25, 25], 'the clipped report keeps its real tier');
});

test('direction while pinned comes from the last real movement', async () => {
  const h = makeHarness({ brightness: 128 });
  // start_right, then actually turn left into the bottom stop. The synthesised steps
  // must follow the movement, not the stale start flag.
  await h.feed([gen('start_right'), abs(100), abs(20), abs(0), abs(0)], 300);
  await h.advance(500);

  const steps = brightnessCalls(h.calls).map((c) => c.brightness_step);
  assert.ok(steps.every((s) => s < 0), `expected downward steps, got ${steps}`);
});

test('with no movement measured yet, a pinned counter starts at the slow step', async () => {
  const h = makeHarness({ brightness: 128, rampEveryReports: 99 });
  // Gesture begins with the counter already pinned: nothing has been measured, so
  // there is no tier to carry and the start flag is all we have.
  await h.feed([gen('start_right'), abs(255), abs(255)], 300);
  await h.advance(500);

  const steps = brightnessCalls(h.calls).map((c) => c.brightness_step);
  assert.ok(steps.length > 0);
  assert.ok(steps.every((s) => s === 2), `expected the slow step, got ${steps}`);
});

test('a gesture that begins pinned ramps up instead of crawling', async () => {
  // The dominant real case: the counter is already at its limit from an earlier
  // gesture, so this one never measures a speed at all. Measured on the bus, 149 of
  // 212 pinned reports look like this.
  const h = makeHarness({ brightness: 3, rampEveryReports: 2 });
  await h.feed([gen('start_right'), abs(255)], 300); // baseline, no step
  // Six reports: 2+2+25+25+55+55 = 164, which stays clear of the 255 ceiling so the
  // ramp is visible rather than clipped by it.
  for (let i = 0; i < 6; i++) await h.feed([abs(255)], 300);
  await h.advance(500);

  const steps = brightnessCalls(h.calls).map((c) => c.brightness_step);
  // Starts fine-grained, climbs a tier every 2 reports, and never leaves the curve.
  assert.deepEqual(steps, [2, 2, 25, 25, 55, 55]);
});

test('the ramp is capped by the top of the curve', async () => {
  const h = makeHarness({ brightness: 3, rampEveryReports: 1 });
  await h.feed([gen('start_right'), abs(255)], 300);
  for (let i = 0; i < 20; i++) await h.feed([abs(255)], 300);
  await h.advance(500);

  const steps = brightnessCalls(h.calls).map((c) => c.brightness_step);
  // Steps beyond the first few are trimmed by the 255 ceiling, so the invariant that
  // matters is that the ramp never asks for more than the curve's top tier.
  assert.ok(steps.every((v) => v <= 80), `ramp exceeded the curve: ${steps}`);
  assert.ok(steps.includes(80), 'the ramp does reach the top tier');
});

test('the ramp starts from the speed the gesture actually measured', async () => {
  const h = makeHarness({ brightness: 3, rampEveryReports: 99 });
  // A fast turn into the stop, then pinned reports. With the ramp effectively
  // disabled, the pinned reports must hold the measured tier, not restart at slow.
  await h.feed([gen('start_right'), abs(95), abs(175), abs(255), abs(255)], 300);
  await h.advance(500);

  const steps = brightnessCalls(h.calls).map((c) => c.brightness_step);
  assert.deepEqual(steps, [80, 80, 80], 'a measured tier carries through the end stop');
});

test('speed memory does not leak from one gesture into the next', async () => {
  const h = makeHarness({ brightness: 3, rampEveryReports: 99 });
  // A fast gesture ending at the stop, then a new one that begins already pinned. The
  // new gesture has measured nothing, so it must not inherit the previous gesture's 80.
  await h.feed([gen('start_right'), abs(95), abs(175), abs(255), gen('stop')], 300);
  h.calls.length = 0;
  await h.feed([gen('start_right'), abs(255), abs(255)], 300);
  await h.advance(500);

  const steps = brightnessCalls(h.calls).map((c) => c.brightness_step);
  assert.ok(steps.every((s) => s === 2), `expected the fallback step, got ${steps}`);
});

// "Do not send level 0 when modifying brightness" — dimming must stop at the
// bottom of the range rather than switching the light off.
test('dimming down never drives brightness to 0', async () => {
  const h = makeHarness({ brightness: 18 });
  // A -25 step from 18 would land on 0 and switch the light off.
  await h.feed([gen('start_left'), abs(32), abs(7), gen('stop')]);

  // At the floor it switches to an ABSOLUTE value, which cannot drift onto 0 the
  // way a computed relative step can (HA quantises 0-255 onto DALI's 254 levels).
  const absolute = h.calls.filter((c) => c.brightness !== undefined);
  assert.equal(absolute.length, 1, 'the floor is sent as an absolute value');
  // 3, not 1: HA brightness 1 maps to DALI arc level 0 and switches the light off.
  assert.equal(absolute[0].brightness, 3);
  assert.ok(
    !h.calls.some((c) => c.brightness === 0 || c.brightness_step <= -18),
    `nothing may drive 18 to 0, got ${JSON.stringify(h.calls)}`,
  );
});

test('once at the floor, further dimming sends nothing at all', async () => {
  const h = makeHarness({ brightness: 1 });
  await h.feed([gen('start_left'), abs(50), abs(25), gen('stop')]);
  assert.equal(h.calls.length, 0, 'already at the floor: no pointless HA call');
});

test('MIN_BRIGHTNESS is configurable', async () => {
  const h = makeHarness({ brightness: 40, minBrightness: 25 });
  await h.feed([gen('start_left'), abs(60), abs(35), gen('stop')]);
  const absolute = h.calls.filter((c) => c.brightness !== undefined);
  assert.equal(absolute.at(-1).brightness, 25, 'floors at the configured minimum');
});

test('a light that is off stays off when turned down, and comes on when turned up', async () => {
  const off = makeHarness({ brightness: 0 });
  await off.feed([gen('start_left'), abs(50), abs(25), gen('stop')]);
  assert.equal(off.calls.length, 0, 'turning down an off light must not switch it on at the floor');

  const on = makeHarness({ brightness: 0 });
  await on.feed([gen('start_right'), abs(25), abs(50), gen('stop')]);
  const steps = brightnessCalls(on.calls);
  assert.ok(steps.length > 0 && steps[0].brightness_step > 0, 'turning up switches it on');
});

test('brightening is not capped by the floor logic', async () => {
  const h = makeHarness({ brightness: 100 });
  await h.feed([gen('start_right'), abs(10), abs(35), gen('stop')]);
  assert.equal(brightnessCalls(h.calls).at(-1).brightness_step, 25, 'upward steps pass through untouched');
});

test('brightness is re-read at the start of each gesture, not cached across them', async () => {
  // The light may be changed elsewhere between gestures (HA app, the emergency
  // controller), so a stale cached value would compute the floor against fiction.
  let reads = 0;
  let current = 200;
  const calls = [];
  const controller = createController({
    deviceMap: { 0: { entity: 'light.obyvak', min_kelvin: 2700, max_kelvin: 6500 } },
    ha: {
      getLightKelvin: async () => 4000,
      getLightBrightness: async () => {
        reads++;
        return current;
      },
      callService: async (domain, service, body) => calls.push({ domain, service, ...body }),
    },
    log: () => {},
  });
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  };
  const feed = async (events) => {
    for (const e of events) {
      controller.handleEvent(e);
      await settle();
    }
  };

  await feed([gen('start_right'), abs(10), abs(20), gen('stop')]);
  assert.equal(reads, 1);

  // Someone dims the light right down from the HA app.
  current = 5;
  await feed([gen('start_left'), abs(20), abs(10), gen('stop')]);
  assert.equal(reads, 2, 'the second gesture must consult HA again');
  // Floored against the *new* value: from 5 a -10 step would pass 0, so the
  // absolute floor is sent instead.
  assert.equal(calls.at(-1).brightness, 3);
});

test('when HA brightness is unknown the step still goes through', async () => {
  const h = makeHarness({ brightness: null });
  await h.feed([gen('start_left'), abs(50), abs(25), gen('stop')]);
  const steps = brightnessCalls(h.calls);
  assert.ok(steps.length > 0, 'an unknown current value must not silently swallow the gesture');
  assert.equal(steps.at(-1).brightness_step, -25, 'passed through unchanged; HA does its own clamping');
  assert.equal(h.calls.filter((c) => c.brightness !== undefined).length, 0, 'no absolute floor without a known value');
});

// Reproduces the 26 Aug 22:04 failure: the light was switched on from off with a
// relative step, after which HA reported 254 while the bus had been sitting at level 5
// for 23 seconds. Every step up was silently discarded as "already at maximum", and the
// first step down was applied to 254 and slammed the light to full.
test('the bus level wins when Home Assistant disagrees with it', async () => {
  const h = makeHarness({ brightness: 254, deviceMap: mappedTo('short0') });
  h.controller.observeLevel('short0', 5);

  await h.feed([gen('start_right'), abs(100), abs(101)], 300);
  await h.advance(500);

  // No brightness_step may be sent against a baseline the bus contradicts.
  assert.equal(brightnessCalls(h.calls).length, 0, 'no relative step against a bad baseline');
  const absolute = h.calls.filter((c) => c.brightness !== undefined);
  assert.equal(absolute.length, 1);
  assert.equal(absolute[0].brightness, 7, 'the bus level plus the step, sent absolutely');

  const alert = h.logs.find((l) => l.alert === 'ha_brightness_divergence');
  assert.ok(alert, 'the divergence is reported, not silently worked around');
  assert.equal(alert.ha_brightness, 254);
  assert.equal(alert.bus_level, 5);
});

test('turning up at the top sends the ceiling instead of going silent', async () => {
  const h = makeHarness({ brightness: 250, deviceMap: mappedTo('short0') });
  h.controller.observeLevel('short0', 250);
  await h.feed([gen('start_right'), abs(100), abs(125)], 300);
  await h.advance(500);

  // 250 + 25 overshoots 255, which used to send nothing at all.
  const absolute = h.calls.filter((c) => c.brightness !== undefined);
  assert.equal(absolute.length, 1, 'the ceiling is sent as an absolute value');
  assert.equal(absolute[0].brightness, 255);
});

test('a step that genuinely changes nothing says so in the log', async () => {
  const h = makeHarness({ brightness: 255, deviceMap: mappedTo('short0') });
  h.controller.observeLevel('short0', 255);
  await h.feed([gen('start_right'), abs(100), abs(125)], 300);
  await h.advance(500);

  assert.equal(h.calls.length, 0, 'nothing to send at the maximum');
  const note = h.logs.find((l) => l.action === 'brightness_suppressed');
  assert.ok(note, 'but a debugging tool must never go quiet without saying why');
  assert.equal(note.reason, 'already at maximum');
});

test('agreement between HA and the bus leaves relative steps alone', async () => {
  const h = makeHarness({ brightness: 128, deviceMap: mappedTo('short0') });
  h.controller.observeLevel('short0', 126); // normal quantisation drift, not divergence
  await h.feed([gen('start_right'), abs(100), abs(125)], 300);
  await h.advance(500);

  assert.deepEqual(brightnessCalls(h.calls).map((c) => c.brightness_step), [25]);
  assert.equal(h.logs.filter((l) => l.alert === 'ha_brightness_divergence').length, 0);
});

test('levels for an unrelated gear address are ignored', async () => {
  const h = makeHarness({ brightness: 254, deviceMap: mappedTo('short0') });
  h.controller.observeLevel('short7', 5); // a different light on the bus
  await h.feed([gen('start_right'), abs(100), abs(101)], 300);
  await h.advance(500);

  assert.equal(h.logs.filter((l) => l.alert === 'ha_brightness_divergence').length, 0,
    'another light\'s level must not be read as this one diverging');
});

// The gear mapping has no default: control gear and control devices are commissioned
// independently, by random search, so any guess is a coincidence at best.
test('with no gear configured the bus cross-check is skipped, not guessed', async () => {
  // Same divergence as the 22:04 failure, but nothing says which gear this entity drives.
  const h = makeHarness({ brightness: 254 }); // default map has no `gear`
  h.controller.observeLevel('short0', 5);

  await h.feed([gen('start_right'), abs(100), abs(101)], 300);
  await h.advance(500);

  assert.equal(h.logs.filter((l) => l.alert === 'ha_brightness_divergence').length, 0,
    'an unmapped level must not be attributed to this light');
  // It falls back to ordinary behaviour rather than writing a brightness derived from
  // a level that might belong to another room.
  const absolute = h.calls.filter((c) => c.brightness !== undefined);
  assert.ok(absolute.every((c) => c.brightness !== 7), 'no write derived from an unowned level');
});

test('the gear mapping is measured from the daemon\'s own calls', async () => {
  const h = makeHarness({ brightness: 128, minCorrelations: 3 });
  // Each toggle is an HA call this daemon made; a level frame arriving just after it is
  // evidence of which gear that entity drives. Nothing is sent to the bus to find out.
  for (let i = 0; i < 3; i++) {
    await h.feed([btn('pressed'), btn('short_press')]);
    await h.settle();
    h.controller.observeLevel('short7', 100 + i);
    await h.advance(50);
  }

  const learned = h.logs.find((l) => l.alert === 'gear_mapping_learned');
  assert.ok(learned, 'the mapping is reported once measured');
  assert.equal(learned.gear, 'short7');
  assert.equal(learned.observations, 3);
});

test('a measured mapping that contradicts devices.json is reported, not silently used', async () => {
  const h = makeHarness({ brightness: 128, minCorrelations: 2, deviceMap: mappedTo('short0') });
  for (let i = 0; i < 2; i++) {
    await h.feed([btn('pressed'), btn('short_press')]);
    await h.settle();
    h.controller.observeLevel('short7', 100 + i);
    await h.advance(50);
  }

  const mismatch = h.logs.find((l) => l.alert === 'gear_mapping_mismatch');
  assert.ok(mismatch, 'the disagreement must surface');
  assert.equal(mismatch.configured, 'short0');
  assert.equal(mismatch.measured, 'short7');
});

test('one coincidence is not a mapping', async () => {
  const h = makeHarness({ brightness: 128, minCorrelations: 3 });
  await h.feed([btn('pressed'), btn('short_press')]);
  await h.settle();
  h.controller.observeLevel('short7', 100);
  await h.advance(50);

  assert.equal(h.logs.filter((l) => l.alert === 'gear_mapping_learned').length, 0,
    'Adaptive Lighting and the emergency controller move levels too');
});

test('a level arriving long after our call is not attributed to it', async () => {
  const h = makeHarness({ brightness: 128, minCorrelations: 1, correlationWindowMs: 500 });
  await h.feed([btn('pressed'), btn('short_press')]);
  await h.settle();
  await h.advance(2000); // well past the window
  h.controller.observeLevel('short7', 100);

  assert.equal(h.logs.filter((l) => l.alert === 'gear_mapping_learned').length, 0);
});

test('broadcast and group levels are evidence of nothing', async () => {
  const h = makeHarness({ brightness: 128, minCorrelations: 1 });
  await h.feed([btn('pressed'), btn('short_press')]);
  await h.settle();
  // The emergency controller in the distribution board drives the bus by broadcast.
  h.controller.observeLevel('broadcast', 100);
  h.controller.observeLevel('group0', 100);

  assert.equal(h.logs.filter((l) => l.alert === 'gear_mapping_learned').length, 0,
    'a frame naming no single gear cannot identify one');
});

test('short press without rotation toggles the light', async () => {
  const h = makeHarness();
  await h.feed([btn('pressed'), btn('short_press')]);
  assert.deepEqual(
    h.calls.map((c) => `${c.domain}.${c.service}`),
    ['light.toggle'],
  );
});

test('short press after rotation does not toggle', async () => {
  const h = makeHarness();
  await h.feed([btn('pressed'), gen('start_right'), abs(82), abs(90), btn('short_press')]);
  assert.equal(h.calls.filter((c) => c.service === 'toggle').length, 0, 'colour gesture must not end in a toggle');
  assert.ok(colourCalls(h.calls).length > 0);
});

test('coalescing: 10 events in one second produce at most 6 HTTP calls', async () => {
  const h = makeHarness({ flushMs: 200 });
  h.controller.handleEvent(gen('start_right'));
  h.controller.handleEvent(abs(100)); // baseline
  await h.settle();

  for (let i = 1; i <= 10; i++) {
    await h.advance(100);
    h.controller.handleEvent(abs(100 + i));
    await h.settle();
  }

  assert.ok(h.calls.length <= 6, `expected <= 6 calls from coalescing, got ${h.calls.length}`);
  assert.ok(h.calls.length > 0);
});

test('colour is sent absolutely, clamped to the configured kelvin range', async () => {
  const h = makeHarness({ kelvin: 6400 });
  await h.feed([btn('pressed'), gen('start_right'), abs(0), abs(255), btn('long_stop')]);
  const colour = colourCalls(h.calls);
  assert.ok(colour.length > 0);
  // A full-scale positive sweep from 6400 K must clamp at the 6500 K ceiling.
  assert.equal(colour.at(-1).color_temp_kelvin, 6500);
});

test('colour gesture falls back to mid-range when HA cannot report the current value', async () => {
  const h = makeHarness();
  h.controller.handleEvent(btn('pressed'));
  await h.settle();
  // Simulate a failed GET by starting from a controller whose ha returns null.
  const failing = makeHarness({ kelvin: null });
  await failing.feed([btn('pressed'), gen('start_right'), abs(10), abs(20), btn('long_stop')]);
  const colour = colourCalls(failing.calls);
  assert.ok(colour.length > 0, 'gesture must still work when the current value is unknown');
  // Midpoint of 2700..6500 is 4600; a small +10 step lands just above it.
  assert.ok(colour[0].color_temp_kelvin > 4600 && colour[0].color_temp_kelvin < 4800);
});

test('16-bit frames from the emergency broadcast controller are never mapped', async () => {
  const h = makeHarness();
  h.controller.handleEvent({ kind: 'level', target: 'broadcast', level: 127, bits: 16, bytes: 'FE 7F' });
  h.controller.handleEvent({ kind: 'colour', target: 'broadcast', mired: 118, kelvin: 8475, bits: 16, bytes: 'FF E7' });
  await h.settle();
  assert.equal(h.calls.length, 0, 'FE xx frames must not trigger HA calls');
});

test('events from a non-default addressing scheme never drive a light', async () => {
  const h = makeHarness();
  const decoder = createDecoder();

  // The controller reconfigured to *instance* addressing: same gestures, different
  // frame shape, and no device address anywhere in them. Feeding a full press-and-turn
  // must produce nothing -- inventing an address here would move a light with no
  // explanation in the log.
  for (const frame of ['82 80 01', '80 84 00', '84 8C 20', '80 84 02', '82 80 02']) {
    const event = decoder.decodeFrame(24, hex(frame), 1000);
    assert.equal(event.kind, 'inputEvent', `${frame} should still decode`);
    assert.equal(event.scheme, 'instance');
    h.controller.handleEvent(event);
  }
  await h.advance(500);
  assert.equal(h.calls.length, 0, 'no HA call may result from an addressless scheme');

  // And it is not silently swallowed either: the same knob under the current scheme
  // still works, so the guard is on the scheme and not on the events themselves.
  await h.feed([btn('pressed'), abs(10), abs(40)], 60);
  await h.advance(500);
  assert.ok(h.calls.length > 0, 'device/instance addressing still controls the light');
});

test('commands and responses never touch the control state machine', async () => {
  const decoder = createDecoder();
  const h = makeHarness();

  // Establish a real gesture baseline first, so we can prove the command frames
  // in the middle change nothing.
  await h.feed([btn('pressed'), gen('start_right'), abs(100)]);
  const before = h.calls.length;

  // `01 01 8C` is a query on instance 1 — the rotation instance. Feeding it (and
  // its 8-bit answer) through must not look like knob movement.
  for (const [bits, frame] of [[24, '01 01 8C'], [8, '00'], [24, '01 03 8C'], [8, '7F']]) {
    const event = decoder.decodeFrame(bits, frame.split(' ').map((b) => parseInt(b, 16)), 1000);
    assert.ok(['command', 'response', 'orphan_response'].includes(event.kind));
    h.controller.handleEvent(event);
    await h.settle();
  }

  assert.equal(h.calls.length, before, 'no HA call may result from commands or responses');

  // The gesture still behaves as if the commands were never there: this position
  // continues the colour gesture from 100, it does not restart from a new baseline.
  await h.feed([abs(125), btn('long_stop')]);
  assert.equal(brightnessCalls(h.calls).length, 0, 'still a colour gesture, untouched by the commands');
});

test('unmapped address is logged once and never crashes or calls HA', async () => {
  const h = makeHarness({ deviceMap: { 0: { entity: 'light.obyvak', min_kelvin: 2700, max_kelvin: 6500 } } });
  await h.feed([btn('pressed', 7), gen('start_right', 7), abs(50, 7), abs(80, 7)]);

  assert.equal(h.calls.length, 0);
  const unmapped = h.logs.filter((e) => e.alert === 'unmapped_device');
  assert.equal(unmapped.length, 1, 'should log once per address, not once per event');
  assert.equal(unmapped[0].target, 'short7');
});

test('button stuck raises an alert but calls nothing', async () => {
  const h = makeHarness();
  await h.feed([btn('stuck')]);
  assert.equal(h.calls.length, 0);
  assert.equal(h.logs.filter((e) => e.alert === 'button_stuck').length, 1);
});

test('released ends the hold like long_stop does', async () => {
  const h = makeHarness();
  await h.feed([btn('pressed'), gen('start_right'), abs(82), abs(90), btn('released')]);
  await h.advance(500);
  await h.feed([abs(120)]);
  assert.equal(brightnessCalls(h.calls).length, 1, 'after released + grace, movement is brightness again');
});

test('decoder output feeds the controller directly (integration across the seam)', async () => {
  const decoder = createDecoder();
  const h = makeHarness();
  const frames = ['00 80 01', '00 84 00', '00 8C 5F', '00 8C 78', '00 80 0C'];
  for (const frame of frames) {
    const event = decoder.decodeFrame(24, frame.split(' ').map((b) => parseInt(b, 16)));
    h.controller.handleEvent(event);
    await h.settle();
  }
  assert.ok(colourCalls(h.calls).length > 0, 'real decoded frames should drive a colour gesture');
  assert.equal(brightnessCalls(h.calls).length, 0);
});

test('HA outage: one alert at the start, one on recovery, no crash', async () => {
  const logs = [];
  let mode = 'fail';
  const fetchImpl = async () => {
    if (mode === 'fail') throw new Error('connect ECONNREFUSED');
    return { ok: true, json: async () => ({ attributes: { color_temp_kelvin: 4000 } }) };
  };
  const ha = createHaClient({ url: 'http://ha.local', token: 't', log: (e) => logs.push(e), fetchImpl });

  await ha.callService('light', 'turn_on', { entity_id: 'light.x', brightness_step: 5 });
  await ha.callService('light', 'turn_on', { entity_id: 'light.x', brightness_step: 5 });
  await ha.callService('light', 'turn_on', { entity_id: 'light.x', brightness_step: 5 });
  assert.equal(logs.filter((e) => e.alert === 'ha_unreachable').length, 1, 'one alert per outage, not per event');

  mode = 'ok';
  await ha.callService('light', 'turn_on', { entity_id: 'light.x', brightness_step: 5 });
  assert.equal(logs.filter((e) => e.alert === 'ha_restored').length, 1);

  mode = 'fail';
  await ha.callService('light', 'turn_on', { entity_id: 'light.x', brightness_step: 5 });
  assert.equal(logs.filter((e) => e.alert === 'ha_unreachable').length, 2, 'a new outage alerts again');
});

test('HA errors never propagate out of the controller', async () => {
  const h = makeHarness();
  const failing = createController({
    deviceMap: { 0: { entity: 'light.obyvak', min_kelvin: 2700, max_kelvin: 6500 } },
    ha: {
      getLightKelvin: async () => {
        throw new Error('down');
      },
      callService: async () => {
        throw new Error('down');
      },
    },
    log: () => {},
  });
  failing.handleEvent(btn('pressed'));
  failing.handleEvent(gen('start_right'));
  failing.handleEvent(abs(10));
  failing.handleEvent(abs(40));
  failing.handleEvent(btn('long_stop'));
  await failing.settled();
  await h.settle();
  assert.ok(true, 'no unhandled rejection escaped');
});


// --- Clock steps -----------------------------------------------------------
// The Pi has no RTC. Every one of these fails if interval logic trusts a clock
// that can move backwards, and each failure looks like broken hardware rather
// than a bug: a knob that does nothing, or one that changes colour when you
// asked for brightness.

test('a backward clock step does not strand the flush timer', async () => {
  const h = makeHarness();
  await h.feed([gen('start_right'), abs(100), abs(125)]);
  assert.equal(brightnessCalls(h.calls).length, 1, 'first step should be sent immediately');

  h.jump(-3_600_000); // NTP sets the clock back an hour

  await h.feed([abs(150)]);
  assert.equal(
    brightnessCalls(h.calls).length,
    2,
    'the step after the jump must be sent now, not scheduled an hour into the future',
  );
});

test('a backward clock step does not hold the colour grace window open', async () => {
  const h = makeHarness();
  await h.feed([btn('pressed'), gen('start_right'), abs(100), abs(125)]);
  assert.equal(colourCalls(h.calls).length, 1, 'held rotation is a colour gesture');
  await h.feed([btn('long_stop')]);

  h.jump(-3_600_000);

  const before = colourCalls(h.calls).length;
  await h.feed([gen('start_right'), abs(100), abs(125)]);
  assert.equal(colourCalls(h.calls).length, before, 'the grace window must have closed');
  assert.equal(brightnessCalls(h.calls).length, 1, 'the gesture after the step is brightness');
});

test('a backward clock step attributes no gear correlation', async () => {
  const learned = (logs) => logs.filter((e) => e.alert === 'gear_mapping_learned');

  const ok = makeHarness({ minCorrelations: 1 });
  await ok.feed([gen('start_right'), abs(100), abs(125)]);
  ok.controller.observeLevel('short7', 120);
  await ok.settle();
  assert.equal(learned(ok.logs).length, 1, 'a level right after our own call is evidence');

  const stepped = makeHarness({ minCorrelations: 1 });
  await stepped.feed([gen('start_right'), abs(100), abs(125)]);
  stepped.jump(-3_600_000);
  stepped.controller.observeLevel('short7', 120);
  await stepped.settle();
  assert.equal(
    learned(stepped.logs).length,
    0,
    'a negative window age proves nothing and must not be treated as a hit',
  );
});
