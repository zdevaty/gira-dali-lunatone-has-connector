// Runs on its own thread so it can still think while the main thread cannot.
//
// The Supervisor's watchdog proves the HTTP port answers; systemd proves the
// process exists. Neither notices the failure that matters most here: the
// process is up, the socket accepts, and the event loop is wedged, so every
// knob in the building is dead and nothing anywhere says so.

import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';

const { timeoutMs } = workerData;
let last = performance.now();
let logFile = workerData.logFile ?? null;

// Monotonic on purpose. Measuring the stall with Date.now() would turn a
// forward NTP step into a kill, which on a Pi is a routine event at boot.
parentPort.on('message', (file) => {
  last = performance.now();
  if (typeof file === 'string') logFile = file;
});

setInterval(() => {
  const stalled = performance.now() - last;
  if (stalled < timeoutMs) return;

  if (logFile) {
    try {
      fs.appendFileSync(
        logFile,
        JSON.stringify({
          ts: new Date().toISOString(),
          kind: 'alert',
          alert: 'watchdog_kill',
          stalled_ms: Math.round(stalled),
          note: 'the event loop stopped responding; killing the process so the supervisor restarts it',
        }) + '\n',
      );
    } catch {
      // About to SIGKILL anyway.
    }
  }
  process.kill(process.pid, 'SIGKILL');
}, Math.max(250, Math.floor(timeoutMs / 4))).unref?.();
