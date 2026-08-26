// Anomaly detection — see spec section 5. Kept intentionally small: only the two
// detectors that need cross-event state (bursts, blinks). `dali_reset` alerts come
// straight out of the decoder and don't need anything from here.

export function createAnomalyDetector({
  burstMinSamples = 8,
  spanThreshold = 40,
  burstGapMs = 2000,
  blinkWindowMs = 5000,
} = {}) {
  const colourBursts = new Map(); // target -> { samples: number[], lastTs, alerted }
  const levelState = new Map(); // target -> { lastLevel, wentDark, blinkTimes: number[] }

  function onColour(target, mired, tsMs) {
    let burst = colourBursts.get(target);
    if (!burst || tsMs - burst.lastTs >= burstGapMs) {
      burst = { samples: [], lastTs: tsMs, alerted: false };
      colourBursts.set(target, burst);
    }
    burst.samples.push(mired);
    burst.lastTs = tsMs;

    if (!burst.alerted && burst.samples.length >= burstMinSamples) {
      const span = Math.max(...burst.samples) - Math.min(...burst.samples);
      if (span < spanThreshold) {
        burst.alerted = true;
        return { kind: 'alert', alert: 'narrow_cct_range', target, span, samples: burst.samples.length };
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
