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
//
// A pid and a hostname do not name a process inside a container. The app's
// container always has the same hostname, and node is always pid 7 behind
// Docker's init, so after a power cut the lock left on /data says "pid 7, this
// host" -- and the new bridge, itself pid 7, found that pid alive and refused
// to start, forever. The kernel's boot id and the process start time are what
// make the claim specific: a pid from another boot, or a pid now held by a
// process that started at a different moment, is not the holder.
export function acquireLock(dir, { name = '.dali-bridge.lock' } = {}) {
  const file = path.join(dir, name);

  const mine = () =>
    JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      boot: bootId(),
      start: processStart(process.pid),
      started: new Date().toISOString(),
    }) + '\n';

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

    if (holderIsLive(holder, alive)) {
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

function holderIsLive(holder, alive) {
  if (!holder || typeof holder.pid !== 'number') return false;
  if (holder.host !== os.hostname()) return false;
  // We are the only process that can be us. In a container this is the common
  // case, not a corner: the same pid comes back on every start.
  if (holder.pid === process.pid) return false;
  if (!alive(holder.pid)) return false;

  // Only compare what both sides could read. Without /proc (not Linux) this
  // falls back to the pid check, which is still right outside containers.
  const boot = bootId();
  if (holder.boot && boot && holder.boot !== boot) return false;
  const start = processStart(holder.pid);
  if (holder.start && start && holder.start !== start) return false;
  return true;
}

function bootId() {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// Field 22 of /proc/<pid>/stat: start time in clock ticks since boot. The
// command name in field 2 may contain spaces and parentheses, so count from the
// last ')'.
export function processStart(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}
