// Anomaly detection — see spec section 5. Kept intentionally small: only the two
// detectors that need cross-event state (bursts, blinks). `dali_reset` alerts come
// straight out of the decoder and don't need anything from here.

export function createAnomalyDetector({
  burstMinSamples = 8,
  spanThreshold = 40,
  burstGapMs = 2000,
  blinkWindowMs = 5000,
} = {}) {
  const colourBursts = new Map(); // target -> { count, min, max, lastTs, alerted }
  const levelState = new Map(); // target -> { lastLevel, wentDark, blinkTimes: number[] }

  // Running min/max rather than the samples themselves. The old version pushed
  // every sample into an array that only ended when the traffic paused for two
  // seconds, and then spread it into Math.max -- which throws RangeError past
  // roughly 150k arguments. It takes a fault to get there (hours of unbroken
  // colour traffic), but the memory grows the whole way regardless, and the span
  // of a burst is exactly max minus min, so keeping the samples bought nothing.
  function onColour(target, mired, tsMs) {
    let burst = colourBursts.get(target);
    if (!burst || tsMs - burst.lastTs >= burstGapMs) {
      burst = { count: 0, min: mired, max: mired, lastTs: tsMs, alerted: false };
      colourBursts.set(target, burst);
    }
    burst.count += 1;
    if (mired < burst.min) burst.min = mired;
    if (mired > burst.max) burst.max = mired;
    burst.lastTs = tsMs;

    if (!burst.alerted && burst.count >= burstMinSamples) {
      const span = burst.max - burst.min;
      if (span < spanThreshold) {
        burst.alerted = true;
        return { kind: 'alert', alert: 'narrow_cct_range', target, span, samples: burst.count };
      }
    }
    return null;
  }

  function onLevel(target, level, tsMs) {
    let state = levelState.get(target);
    if (!state) {
      state = { lastLevel: null, wentDark: false, blinkTimes: [] };
      levelState.set(target, state);
    }

    let alert = null;
    if (state.lastLevel != null) {
      if (state.lastLevel > 0 && level === 0) {
        state.wentDark = true;
      } else if (state.wentDark && level > 0) {
        state.wentDark = false;
        state.blinkTimes = [...state.blinkTimes, tsMs].filter((t) => tsMs - t <= blinkWindowMs);
        if (state.blinkTimes.length >= 3) {
          state.blinkTimes = [];
          alert = { kind: 'alert', alert: 'calibration_saved', unverified: true, target };
        }
      }
    }
    state.lastLevel = level;
    return alert;
  }

  return { onColour, onLevel };
}
