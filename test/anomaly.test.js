import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnomalyDetector } from '../lib/anomaly.js';

test('narrow_cct_range: 3-sample burst with small span does not alert (below min samples)', () => {
  const anomaly = createAnomalyDetector({ burstMinSamples: 8, spanThreshold: 40 });
  const mireds = [118, 100, 101];
  let baseTs = 1_000_000;
  const alerts = mireds.map((mired) => anomaly.onColour('broadcast', mired, (baseTs += 200)));
  assert.ok(alerts.every((a) => a === null));
});

test('narrow_cct_range: 14-sample burst with 5-mired span alerts', () => {
  const anomaly = createAnomalyDetector({ burstMinSamples: 8, spanThreshold: 40 });
  const mireds = [100, 101, 102, 103, 104, 105, 104, 103, 102, 101, 100, 101, 102, 105];
  let baseTs = 1_000_000;
  const alerts = mireds.map((mired) => anomaly.onColour('group0', mired, (baseTs += 200)));
  const fired = alerts.filter(Boolean);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].alert, 'narrow_cct_range');
  assert.equal(fired[0].target, 'group0');
  assert.equal(fired[0].span, 5);
  assert.ok(fired[0].samples >= 8);
});

test('narrow_cct_range: 14-sample burst with 200-mired span does not alert', () => {
  const anomaly = createAnomalyDetector({ burstMinSamples: 8, spanThreshold: 40 });
  const mireds = [100, 130, 160, 190, 220, 250, 280, 300, 270, 240, 210, 180, 150, 100];
  let baseTs = 1_000_000;
  const alerts = mireds.map((mired) => anomaly.onColour('group1', mired, (baseTs += 200)));
  assert.ok(alerts.every((a) => a === null));
});

test('narrow_cct_range: a gap of >= 2s starts a new burst (count resets)', () => {
  const anomaly = createAnomalyDetector({ burstMinSamples: 8, spanThreshold: 40 });
  let ts = 1_000_000;
  for (let i = 0; i < 7; i++) anomaly.onColour('broadcast', 100, (ts += 200));
  // Gap >= 2000ms breaks the burst even though span would qualify.
  ts += 2500;
  const alerts = [];
  for (let i = 0; i < 7; i++) alerts.push(anomaly.onColour('broadcast', 100, (ts += 200)));
  assert.ok(alerts.every((a) => a === null), 'burst restarted, so 7 samples should not reach the 8-sample minimum');
});

test('calibration_saved: three blink cycles within the window alerts as unverified', () => {
  const anomaly = createAnomalyDetector();
  let ts = 1_000_000;
  const levels = [200, 0, 200, 0, 200, 0, 200]; // 3 dark->light transitions
  const alerts = levels.map((level) => anomaly.onLevel('group0', level, (ts += 500)));
  const fired = alerts.filter(Boolean);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].alert, 'calibration_saved');
  assert.equal(fired[0].unverified, true);
});

test('calibration_saved: two blinks within the window does not alert', () => {
  const anomaly = createAnomalyDetector();
  let ts = 1_000_000;
  const levels = [200, 0, 200, 0, 200];
  const alerts = levels.map((level) => anomaly.onLevel('group0', level, (ts += 500)));
  assert.ok(alerts.every((a) => a === null));
});
