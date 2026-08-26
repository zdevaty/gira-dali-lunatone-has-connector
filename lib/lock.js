import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// One bridge per machine.
//
// After the cutover it is very easy to leave the old instance running: both
// connect to the gateway, both see the same knob turn, and both call Home
// Assistant. The light then moves twice as far as the hand did, which reads as
// a tuning problem and is not one.
//
// This catches the same-machine case honestly. Two instances on two different
// machines cannot be detected from here; the startup line names the host so the
// capture at least says who was running.
export function acquireLock(dir, { name = '.dali-bridge.lock' } = {}) {
  const file = path.join(dir, name);

  const mine = () => JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString() }) + '\n';

  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err?.code === 'EPERM'; // exists, just not ours to signal
    }
  };

  const claim = () => {
    const fd = fs.openSync(file, 'wx'); // fails if it already exists
    fs.writeSync(fd, mine());
    fs.closeSync(fd);
  };

  try {
    claim();
  } catch (err) {
    if (err?.code !== 'EEXIST') return { ok: true, release() {} }; // unwritable dir: do not block startup over it

    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      holder = null;
    }

    const sameHost = holder?.host === os.hostname();
    if (holder && sameHost && typeof holder.pid === 'number' && alive(holder.pid)) {
      return { ok: false, holder, release() {} };
    }

    // Stale: the previous owner died without cleaning up, which is what SIGKILL
    // and power cuts do.
    try {
      fs.unlinkSync(file);
      claim();
    } catch {
      return { ok: true, release() {} };
    }
  }

  return {
    ok: true,
    holder: null,
    release() {
      try {
        const held = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (held?.pid === process.pid) fs.unlinkSync(file);
      } catch {
        // Someone else's now, or already gone.
      }
    },
  };
}
