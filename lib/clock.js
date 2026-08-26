// Two clocks, deliberately.
//
// The Raspberry Pi has no real-time clock. It boots believing it is whenever it
// last was, and NTP corrects it seconds later -- possibly by hours, in either
// direction. Anything that measures an INTERVAL must therefore not read the wall
// clock, because a backward step makes "how long since the last flush" negative
// and arms a timer for the size of the correction. The knob is then dead for as
// long as the step, with nothing in the log to explain it, and it gets diagnosed
// as a hardware fault.
//
// So: `monotonicNow` for every window, throttle and timeout; `Date.now()` only
// for timestamps a human reads and for log filenames.

export function monotonicNow() {
  return performance.now();
}

// Watches the two clocks against each other and says so when they disagree.
// Both are sampled at the same instant, so a late interval shows up equally in
// each and cancels out -- only a genuine step survives the subtraction.
export function createClockWatch({
  log = () => {},
  wall = () => Date.now(),
  mono = monotonicNow,
  toleranceMs = 1000,
} = {}) {
  let lastWall = wall();
  let lastMono = mono();

  function check() {
    const w = wall();
    const m = mono();
    const drift = (w - lastWall) - (m - lastMono);
    lastWall = w;
    lastMono = m;
    if (Math.abs(drift) <= toleranceMs) return 0;

    const stepMs = Math.round(drift);
    log({
      kind: 'alert',
      alert: 'clock_step',
      step_ms: stepMs,
      direction: stepMs > 0 ? 'forward' : 'backward',
      note: 'the system clock jumped; timestamps before and after this line are not comparable',
    });
    return stepMs;
  }

  return { check };
}
