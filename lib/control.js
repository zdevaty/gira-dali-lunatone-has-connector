// Gesture state machine: turns 24-bit input-device events into Home Assistant
// calls. See addendum sections 2–4.
//
// The controllers were switched out of application-controller mode, so nothing
// else on the bus reacts to the knobs any more — every light change now
// originates here. The bus itself stays strictly read-only; we only talk to HA.
//
// Timers and the clock are injected so the throttling logic is testable without
// waiting in real time.

// Rotation speed, as the hardware actually reports it.
//
// The encoder sends its position at a fixed ~175 ms cadence regardless of how fast the
// knob turns, so speed shows up as how far the counter moved between reports -- and it
// is quantised into exactly four magnitudes: 1, 25, 55 and 80 counts. Measured over 290
// position events, nothing in between ever appears; every off-tier value in the capture
// is one of those four clipped by an end stop. Four tiers is all the resolution there
// is to extract, so the curve below maps those four onto the step we actually send.
const TIER_BOUNDARIES = [13, 41, 68]; // midpoints between 1/25, 25/55 and 55/80

function tierIndex(magnitude) {
  if (magnitude >= TIER_BOUNDARIES[2]) return 3;
  if (magnitude >= TIER_BOUNDARIES[1]) return 2;
  if (magnitude >= TIER_BOUNDARIES[0]) return 1;
  return 0;
}

export function createController({
  deviceMap = {},
  ha,
  log = () => {},
  flushMs = 200,
  graceMs = 200,
  speedCurve = [2, 25, 55, 80],
  rampEveryReports = 2,
  levelDivergence = 20,
  correlationWindowMs = 500,
  minCorrelations = 3,
  maxQueue = 4,
  staleMs = 1500,
  maxBackoffMs = 2000,
  brightnessGain = 1,
  colourGain = 1,
  minBrightness = 3,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
} = {}) {
  const devices = new Map();
  const unmappedSeen = new Set();

  // Which control-gear address on the bus belongs to which control device.
  //
  // There is deliberately NO default. Addresses are handed out by random search during
  // commissioning, independently in the two address spaces, so a bedroom's knob might
  // land on A3 while the same bedroom's driver lands on A7. Two devices agreeing on a
  // bench is a coincidence, not a rule -- and a default that works on the bench and is
  // quietly wrong in the flat is worse than a missing value, because what this feeds is
  // an absolute brightness write to whichever light it names. A missing mapping is
  // visible; a wrong one is not.
  //
  // Values are numeric because handleEvent keys device state by the numeric address off
  // the decoded frame -- a string key would quietly create a second, parallel state
  // object and observed levels would never reach the device that needs them.
  const gearToAddress = new Map();
  function indexGear() {
    gearToAddress.clear();
    for (const [address, mapping] of Object.entries(deviceMap)) {
      if (mapping.gear) gearToAddress.set(mapping.gear, Number(address));
    }
  }
  indexGear();

  // Applied without a restart, because a restart costs wall-switch availability
  // and mapping ten rooms means saving ten times. The map object is mutated in
  // place rather than replaced: handleEvent reads deviceMap[address] at use
  // time, so the same object staying identity-stable is what makes this work.
  function setDeviceMap(next) {
    const before = new Map(Object.entries(deviceMap).map(([address, m]) => [address, m?.entity]));
    for (const key of Object.keys(deviceMap)) delete deviceMap[key];
    Object.assign(deviceMap, next ?? {});
    indexGear();

    // A measurement says "the entity mapped to THIS address drives THAT gear".
    // Change the entity and it is a statement about a light this address no
    // longer controls -- and what it feeds is an ABSOLUTE brightness write, so a
    // stale one does not merely mislead, it pins the new light to the old one's
    // level.
    //
    // Measured on the first real remap: A0 moved from light..._00 to _01 while
    // gear short0 sat at level 40, and every gesture afterwards computed
    // 40 + delta and slammed the new light to level 64. The knob looked broken.
    // Anything learned about an address whose entity changed goes with it,
    // including the last level observed for it.
    for (const [address, entity] of before) {
      if (deviceMap[address]?.entity === entity) continue;
      const key = Number(address);
      measured.delete(key);
      tally.delete(key);
      reported.delete(key);
      const st = devices.get(key);
      if (st) st.observedLevel = null;
    }

    // An in-flight correlation was armed under the old map and can no longer be
    // attributed to anything.
    pending = null;
    unmappedSeen.clear();
  }

  // The mapping can also be MEASURED rather than accepted, and without putting anything
  // on the bus: the daemon knows when it caused a change, so an arc level arriving right
  // after one of its own HA calls is evidence of which gear that entity drives.
  // Home Assistant being slow is a property of Home Assistant, not of one room,
  // so the throttle is shared. A knob held against its end stop can ask for five
  // calls a second, and each one makes HA talk to the gateway; when that starts
  // timing out, sending harder makes it worse.
  let haBackoffMs = 0;
  const effectiveFlushMs = () => Math.max(flushMs, haBackoffMs);

  // Only an explicit `false` is a failure. A client that reports nothing is not
  // evidence of trouble, and treating silence as failure would throttle every
  // caller that does not happen to return a boolean.
  function noteCallResult(ok) {
    if (ok !== false) {
      // Recover gently rather than snapping back to full rate and re-flooding.
      haBackoffMs = haBackoffMs <= flushMs ? 0 : Math.floor(haBackoffMs / 2);
      return;
    }
    const next = haBackoffMs === 0 ? flushMs * 2 : haBackoffMs * 2;
    haBackoffMs = Math.min(maxBackoffMs, next);
    if (haBackoffMs === maxBackoffMs && !backoffReported) {
      backoffReported = true;
      log({ kind: 'alert', alert: 'ha_slow', backoff_ms: haBackoffMs,
        note: 'Home Assistant is not answering in time; the bridge has slowed its calls to let it catch up' });
    }
  }
  let backoffReported = false;

  const tally = new Map(); // address -> Map(gear -> count)
  const measured = new Map(); // address -> gear, once the evidence is unambiguous
  const reported = new Set();
  let pending = null; // the one outstanding HA call a frame could still be attributed to

  function noteCommand(st) {
    // Two rooms changing at once makes any following frame ambiguous, so abandon the
    // window rather than guess which of them the frame belongs to.
    const age = pending ? now() - pending.at : Infinity;
    if (pending && pending.address !== st.address && age >= 0 && age <= correlationWindowMs) {
      pending.ambiguous = true;
      return;
    }
    pending = { address: st.address, at: now(), ambiguous: false };
  }

  function correlate(gear) {
    if (!pending || pending.ambiguous) return;
    // Negative age = the clock stepped backwards; the window is meaningless, so
    // attribute nothing rather than attribute it wrongly for the size of the step.
    const age = now() - pending.at;
    if (age < 0 || age > correlationWindowMs) return;
    const { address } = pending;
    pending = null; // one call explains one frame

    if (!tally.has(address)) tally.set(address, new Map());
    const counts = tally.get(address);
    counts.set(gear, (counts.get(gear) ?? 0) + 1);

    // Adaptive Lighting and the emergency controller also move levels, so a single
    // coincidence proves nothing: require repetition and a clear winner.
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const [topGear, topCount] = ranked[0];
    const runnerUp = ranked[1]?.[1] ?? 0;
    if (topCount < minCorrelations || topCount === runnerUp) return;
    if (measured.get(address) === topGear) return;
    measured.set(address, topGear);

    const entry = deviceMap[String(address)] ?? {};
    if (entry.gear && entry.gear !== topGear && !reported.has(address)) {
      reported.add(address);
      log({ kind: 'alert', alert: 'gear_mapping_mismatch', target: `short${address}`, entity: entry.entity,
        configured: entry.gear, measured: topGear, observations: topCount,
        note: 'devices.json disagrees with the gear this entity is observed to drive' });
    } else if (!entry.gear) {
      log({ kind: 'alert', alert: 'gear_mapping_learned', target: `short${address}`, entity: entry.entity,
        gear: topGear, observations: topCount,
        note: 'measured by correlating this daemon\'s own HA calls with arc levels; set it in the Driver field on the Commission page to make it explicit' });
    }
  }

  function stateFor(address) {
    let st = devices.get(address);
    if (!st) {
      st = {
        address: Number(address),
        target: `short${address}`,
        held: false,
        graceUntil: 0,
        direction: 1,
        lastPos: null,
        rotated: false,
        // Speed carried across reports so an end stop doesn't erase it.
        tierIdx: null,
        tierSign: null,
        pinnedReports: 0,
        pendingBrightness: 0,
        pendingColour: 0,
        brightness: null,
        brightnessReady: null,
        colourKelvin: null,
        colourReady: null,
        lastFlush: -Infinity,
        // Last arc level actually seen on the bus for this device -- ground truth,
        // unlike Home Assistant's idea of the brightness.
        observedLevel: null,
        timer: null,
        // Serialises HA calls per device so colour steps are applied and sent in
        // the order the knob produced them. Bounded -- see enqueue().
        queue: [],
        running: null,
        dropped: 0,
        dropReported: null,
      };
      devices.set(address, st);
    }
    return st;
  }

  // A position event maps to colour while the button is held — plus a short grace
  // window afterwards, because long_stop can arrive before the last position
  // event of the same gesture (measured).
  function isColourGesture(st) {
    if (st.held) return true;
    // The remaining grace is checked from both ends. `now() < graceUntil` alone
    // would hold the window open for the whole of a backward clock step, turning
    // every brightness gesture into a colour gesture until the clock caught up.
    const remaining = st.graceUntil - now();
    return remaining > 0 && remaining <= graceMs;
  }

  function beginHold(st, mapping) {
    st.held = true;
    st.rotated = false;
    st.graceUntil = 0;
    st.colourKelvin = null;
    const mid = (mapping.min_kelvin + mapping.max_kelvin) / 2;
    st.colourReady = Promise.resolve()
      .then(() => ha.getLightKelvin(mapping.entity))
      .then((kelvin) => (typeof kelvin === 'number' ? kelvin : mid))
      .catch(() => mid);
  }

  function endHold(st, mapping) {
    st.held = false;
    st.graceUntil = now() + graceMs;
    flush(st, mapping);
  }

  function onButton(st, mapping, event) {
    switch (event.event) {
      case 'pressed':
      // A missed `pressed` frame shouldn't strand the gesture in brightness mode.
      case 'long_start':
        if (!st.held) beginHold(st, mapping);
        break;
      case 'long_repeat':
        break;
      case 'short_press': {
        // A short press that had rotation in it was a colour gesture, not a tap.
        // Without this check every colour adjustment would end by toggling the light.
        const wasRotated = st.rotated;
        endHold(st, mapping);
        if (!wasRotated) {
          send(st, { kind: 'control', action: 'toggle', target: st.target, entity: mapping.entity }, () => {
            noteCommand(st);
            return ha.callService('light', 'toggle', { entity_id: mapping.entity });
          });
        }
        break;
      }
      case 'long_stop':
      case 'released':
        endHold(st, mapping);
        break;
      case 'stuck':
        // Furniture pinning a knob down. Log it; never act on it.
        log({ kind: 'alert', alert: 'button_stuck', target: st.target, entity: mapping.entity });
        break;
    }
  }

  function onGeneric(st, mapping, event) {
    if (event.event === 'start_right' || event.event === 'start_left') {
      st.direction = event.event === 'start_right' ? 1 : -1;
      // New gesture: no speed has been measured yet, so nothing to carry over.
      st.tierIdx = null;
      st.tierSign = null;
      st.pinnedReports = 0;
      if (isColourGesture(st)) {
        st.rotated = true;
      } else {
        // Brightness gesture starting: re-read the real value, since it may have
        // been changed elsewhere (HA app, the emergency controller) since last time.
        st.brightness = null;
        st.brightnessReady = Promise.resolve()
          .then(() => ha.getLightBrightness(mapping.entity))
          .catch(() => null);
      }
    } else if (event.event === 'stop') {
      flush(st, mapping);
    }
  }

  function onPosition(st, mapping, event) {
    const pos = event.value;
    if (st.lastPos == null) {
      // First position ever seen: no baseline to diff against. The counter is
      // free-running and shared between brightness and colour, so only the
      // difference carries meaning.
      st.lastPos = pos;
      return;
    }
    const raw = pos - st.lastPos;
    // The counter saturates rather than wrapping (measured: it pins at 0 and 255, it
    // never jumps 255 -> 0), which is what makes a plain subtraction safe here.
    const pinned = pos === 0 || pos === 255;
    st.lastPos = pos;

    let delta;
    if (raw !== 0) {
      const sign = Math.sign(raw);
      const observed = tierIndex(Math.abs(raw));
      // A report that lands exactly on an end stop was cut short by the travel left,
      // not by the hand slowing down -- `220 -> 255` is a fast turn with only 35 counts
      // of room. Reading its magnitude literally would brake right at the limit, so
      // keep the previous tier when it was faster.
      const idx = pinned && st.tierIdx > observed ? st.tierIdx : observed;
      st.tierIdx = idx;
      st.tierSign = sign;
      st.pinnedReports = 0;
      delta = sign * speedCurve[idx];
    } else {
      // Pinned at an end stop: the counter reports the same value every ~175 ms and
      // carries no speed information at all. This is not an edge case -- once the
      // counter maxes out it stays there, so most turning happens in this state, and
      // measured on the real bus 149 of 212 pinned reports arrive in a gesture that
      // began pinned and so never measured anything.
      //
      // With no speed to read, ramp: start where the gesture last actually measured
      // (or the slowest step if it measured nothing) and climb a tier for every few
      // reports of continued turning. A brief nudge stays fine-grained, sustained
      // turning accelerates, and the top of the curve caps it. The counter's position
      // therefore stops deciding how the knob feels.
      st.pinnedReports += 1;
      // Direction from the last real movement where there is one: at these step sizes
      // a stale start_left/start_right flag would run the light the wrong way fast.
      const sign = st.tierSign ?? st.direction;
      const climbed = Math.floor((st.pinnedReports - 1) / rampEveryReports);
      const idx = Math.min(speedCurve.length - 1, (st.tierIdx ?? 0) + climbed);
      delta = sign * speedCurve[idx];
    }

    if (isColourGesture(st)) {
      st.rotated = true;
      st.pendingColour += delta;
    } else {
      st.pendingBrightness += delta;
    }
    scheduleFlush(st, mapping);
  }

  // Deadtime is 0.10 s, so up to 10 events/second arrive. Coalesce them: leading
  // edge fires immediately, the rest are throttled to one call per flushMs.
  function scheduleFlush(st, mapping) {
    const t = now();
    const interval = effectiveFlushMs();
    const since = t - st.lastFlush;
    // A negative interval means the clock moved backwards under us. Flushing now
    // is always safe; arming a timer for `flushMs - since` would silence this
    // knob for the size of the step.
    if (since >= interval || since < 0) {
      flush(st, mapping);
    } else if (!st.timer) {
      st.timer = setTimer(() => {
        st.timer = null;
        flush(st, mapping);
      }, interval - since);
    }
  }

  // A debugging tool must never go quiet without saying why: five gestures in a row
  // producing no HA call at all, with nothing in the log, is what hid the divergence
  // above for an entire evening.
  function suppressed(st, mapping, reason) {
    log({ kind: 'control', action: 'brightness_suppressed', target: st.target, entity: mapping.entity, reason });
  }

  // The per-device call queue is bounded on purpose.
  //
  // The bench version chained every call onto a promise with no limit. With Home
  // Assistant healthy that is invisible: calls take milliseconds. With HA slow,
  // each one waits out the client's 5 s timeout, and a knob turning at ~5 flushes
  // a second through a 30 s stall queues minutes of brightness writes that land
  // long after the hand left the knob. ha-client.js says a change applied five
  // minutes late is worse than none at all; without this, it was not true.
  //
  // So: drop the oldest when the queue is full, and drop anything that waited
  // too long to still be what the hand asked for. The light then moves less far
  // than the hand did, which is self-correcting -- you turn a bit more -- rather
  // than moving on its own a minute later, which is not.
  function enqueue(st, label, fn) {
    st.queue.push({ at: now(), label, fn });
    while (st.queue.length > maxQueue) {
      st.queue.shift();
      st.dropped += 1;
      noteDrop(st, 'queue_full');
    }
    pump(st);
  }

  // One alert per run of dropping, not one per dropped call: a stalled HA would
  // otherwise fill the capture with the same line.
  function noteDrop(st, reason) {
    if (st.dropReported === reason) return;
    st.dropReported = reason;
    log({
      kind: 'alert', alert: 'command_dropped', target: st.target, reason, dropped: st.dropped,
      note: 'Home Assistant is not keeping up; late commands are discarded rather than applied after the fact',
    });
  }

  function pump(st) {
    if (st.running) return st.running;
    st.running = (async () => {
      while (st.queue.length) {
        const item = st.queue.shift();
        const age = now() - item.at;
        // Negative age means the clock stepped; treat it as unusable, same as stale.
        if (age < 0 || age > staleMs) {
          st.dropped += 1;
          noteDrop(st, 'stale');
          continue;
        }
        st.dropReported = null;
        try {
          await item.fn();
        } catch {
          // The HA client reports its own failures; one bad call must not stop
          // the queue behind it.
        }
      }
    })().finally(() => {
      st.running = null;
    });
    return st.running;
  }

  function send(st, logEvent, call) {
    log(logEvent);
    enqueue(st, logEvent.action, call);
  }

  function flush(st, mapping) {
    st.lastFlush = now();
    if (st.timer) {
      clearTimer(st.timer);
      st.timer = null;
    }

    if (st.pendingBrightness !== 0) {
      const step = Math.round(st.pendingBrightness * brightnessGain);
      // With a gain below 1 a small delta can round to zero; keep it pending
      // rather than silently dropping the movement.
      if (step !== 0) {
        st.pendingBrightness = 0;
        sendBrightness(st, mapping, step);
      }
    }

    if (st.pendingColour !== 0) {
      const delta = st.pendingColour;
      st.pendingColour = 0;
      sendColour(st, mapping, delta);
    }
  }

  // Dimming down must never switch the light off: a knob that kills the light at
  // the bottom of its travel is disorienting, and you then have to guess which way
  // turns it back on. The step stays relative (HA has brightness_step for exactly
  // this), but it is trimmed so the result never lands below minBrightness.
  function sendBrightness(st, mapping, delta) {
    enqueue(st, 'brightness', async () => {
      if (st.brightness == null) {
        // Seeded at gesture start; fetched on demand if we missed the start event.
        st.brightness = await (st.brightnessReady ?? ha.getLightBrightness(mapping.entity));
      }

      // Home Assistant could not say. The bus can: an arc level is what the
      // light is actually doing, and reading it does not depend on HA answering.
      //
      // Without this the floor and ceiling checks below are skipped whenever HA
      // is slow -- which is exactly when a knob held against its end stop is
      // flooding HA with steps. Measured on the real installation: the light
      // saturated, every further step was still sent, HA timed out, and the
      // timeouts kept the brightness unknown, so it never stopped. The bus was
      // reporting level 219 throughout.
      if (st.brightness == null && st.observedLevel != null) {
        st.brightness = st.observedLevel;
      }

      // Home Assistant's brightness is a belief; the arc level on the bus is what the
      // light is actually doing. They can drift far apart -- measured on 26 Aug, HA
      // reported 254 while the bus had been sitting at level 5 for 23 seconds, after
      // the light was switched on from off with a relative step. Every step up was
      // then silently discarded as "already at maximum", and the first step down was
      // applied to 254 and slammed the light to full.
      //
      // So when the two disagree materially, believe the bus and send an absolute
      // value: a relative step is only ever as good as the baseline HA applies it to.
      if (
        st.brightness != null &&
        st.observedLevel != null &&
        Math.abs(st.brightness - st.observedLevel) > levelDivergence
      ) {
        const target = Math.min(255, Math.max(minBrightness, st.observedLevel + delta));
        log({
          kind: 'alert', alert: 'ha_brightness_divergence', target: st.target, entity: mapping.entity,
          ha_brightness: st.brightness, bus_level: st.observedLevel, sending: target,
        });
        st.brightness = target;
        noteCommand(st);
        noteCallResult(await ha.callService('light', 'turn_on', { entity_id: mapping.entity, brightness: target }));
        return;
      }

      const current = st.brightness;
      let step = delta;

      if (current == null) {
        // Brightness unknown (HA unreachable). Pass the step through unchanged
        // rather than guessing — HA still clamps, we just can't protect the floor.
      } else if (current <= 0) {
        // Light is off. Turning up switches it on; turning down leaves it off.
        if (delta <= 0) return suppressed(st, mapping, 'light is off');
      } else if (current + delta <= minBrightness) {
        // Landing on or below the floor. Send the floor ABSOLUTELY rather than a
        // computed step: HA's brightness is quantised onto DALI's 254 arc levels
        // (ask for 18, read back 17) and brightness_step is applied against HA's
        // own state, which lags a just-sent command. A relative step sized to hit
        // the floor exactly can therefore still land on 0 and switch the light
        // off. An absolute value cannot.
        //
        // The floor itself must clear that quantisation: measured on this
        // hardware, HA brightness 1 maps to DALI arc level 0 and switches the
        // light OFF. 2 is the exact edge (reads back as 1) and the round trip is
        // not monotonic (4 -> 4, but 5 -> 3), so the default floor is 3.
        if (current <= minBrightness) return suppressed(st, mapping, 'resting on the floor');
        st.brightness = minBrightness;
        log({ kind: 'control', action: 'brightness', target: st.target, entity: mapping.entity, brightness: minBrightness, floored: true });
        noteCommand(st);
        noteCallResult(await ha.callService('light', 'turn_on', { entity_id: mapping.entity, brightness: minBrightness }));
        return;
      } else if (current + delta > 255) {
        // Mirror of the floor. Send the ceiling ABSOLUTELY rather than a trimmed
        // step, for the same reason: a relative step is applied against HA's own
        // state and cannot be trusted to land exactly on 255. Turning up at the top
        // must always produce a command -- going silent is what made the divergence
        // above so hard to see from the outside.
        if (current >= 255) return suppressed(st, mapping, 'already at maximum');
        st.brightness = 255;
        log({ kind: 'control', action: 'brightness', target: st.target, entity: mapping.entity, brightness: 255, ceiling: true });
        noteCommand(st);
        noteCallResult(await ha.callService('light', 'turn_on', { entity_id: mapping.entity, brightness: 255 }));
        return;
      }

      if (current != null) st.brightness = Math.min(255, Math.max(0, current + step));
      log({ kind: 'control', action: 'brightness_step', target: st.target, entity: mapping.entity, step });
      noteCommand(st);
      noteCallResult(await ha.callService('light', 'turn_on', { entity_id: mapping.entity, brightness_step: step }));
    });
  }

  // HA has no relative step for colour temperature, so the current value is held
  // locally for the duration of the gesture and sent absolutely.
  function sendColour(st, mapping, delta) {
    const { min_kelvin: min, max_kelvin: max } = mapping;
    enqueue(st, 'colour', async () => {
      if (st.colourKelvin == null) {
        st.colourKelvin = st.colourReady ? await st.colourReady : (min + max) / 2;
      }
      const stepKelvin = (delta * (max - min) * colourGain) / 255;
      st.colourKelvin = Math.min(max, Math.max(min, st.colourKelvin + stepKelvin));
      const kelvin = Math.round(st.colourKelvin);
      log({ kind: 'control', action: 'color_temp_kelvin', target: st.target, entity: mapping.entity, kelvin });
      noteCommand(st);
      noteCallResult(await ha.callService('light', 'turn_on', { entity_id: mapping.entity, color_temp_kelvin: kelvin }));
    });
  }

  function handleEvent(event) {
    // 16-bit frames belong to the emergency broadcast controller in the
    // distribution board — logged elsewhere, never mapped here.
    if (!event || event.kind !== 'inputEvent') return;

    // Only device/instance addressing carries a device address. If the controller is
    // reconfigured to another event scheme its frames arrive without one; they are
    // logged, never mapped. Guessing an address here is how you get a light that
    // moves on its own with nothing in the log to explain it.
    if (event.scheme !== 'device_instance' || typeof event.address !== 'number') return;

    const address = event.address;
    const mapping = deviceMap[String(address)];
    if (!mapping) {
      // Once per address: an unmapped knob would otherwise emit 10 lines a second.
      if (!unmappedSeen.has(address)) {
        unmappedSeen.add(address);
        log({ kind: 'alert', alert: 'unmapped_device', target: event.target ?? `short${address}` });
      }
      return;
    }

    const st = stateFor(address);
    switch (event.instanceType) {
      case 'pushButton':
        return onButton(st, mapping, event);
      case 'generic':
        return onGeneric(st, mapping, event);
      case 'absoluteInput':
        return onPosition(st, mapping, event);
      default:
        return;
    }
  }

  // Arc levels seen on the bus, fed in from the frame log. This is the only direct
  // evidence of what a light is really doing -- everything else is HA's opinion.
  function observeLevel(target, level) {
    // Broadcast and group frames name no single gear, so they are evidence of nothing.
    if (typeof target !== 'string' || !/^short\d+$/.test(target)) return;
    correlate(target);

    // Configuration first: an operator asserting a mapping outranks a measurement, and a
    // disagreement is reported above rather than silently resolved either way.
    let address = gearToAddress.get(target);
    if (address === undefined) {
      for (const [addr, gear] of measured) if (gear === target) address = addr;
    }
    // Nothing configured and nothing measured yet: skip the cross-check rather than
    // guess which light this level belongs to. A missing check is visible in the log;
    // a check against the wrong light writes a brightness to the wrong room.
    if (address === undefined) return;
    stateFor(address).observedLevel = level;
  }

  // Exposed so callers can await in-flight HA calls (tests, shutdown).
  function settled() {
    return Promise.all([...devices.values()].map((st) => st.running ?? Promise.resolve()));
  }

  return { handleEvent, observeLevel, settled, setDeviceMap };
}
