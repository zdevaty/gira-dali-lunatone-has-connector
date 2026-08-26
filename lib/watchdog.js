import { Worker } from 'node:worker_threads';

// Heartbeat from the main thread to a watcher that cannot be blocked by it.
// `beat` carries the current capture file so the worker can write down why it
// killed us -- a process that dies without explanation gets diagnosed twice.
export function startWatchdog({
  timeoutMs = 15_000,
  beatMs = 1000,
  currentFile = () => null,
  enabled = true,
} = {}) {
  if (!enabled) return { stop() {}, beat() {} };

  const worker = new Worker(new URL('./watchdog-worker.js', import.meta.url), {
    workerData: { timeoutMs, logFile: currentFile() },
  });
  worker.unref(); // never keeps the process alive on its own
  worker.on('error', () => {}); // a dead watchdog must not take the bridge with it

  const beat = () => {
    try {
      worker.postMessage(currentFile());
    } catch {
      // Worker gone; nothing to do that would not be worse.
    }
  };

  const timer = setInterval(beat, beatMs);
  timer.unref?.();

  return {
    beat,
    stop() {
      clearInterval(timer);
      worker.terminate().catch(() => {});
    },
  };
}
