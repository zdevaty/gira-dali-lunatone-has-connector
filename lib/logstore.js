// JSONL capture store.
//
// The bench version called fs.appendFileSync once per frame: an open, a write
// and a close, synchronously, inside the frame handler. On a Raspberry Pi that
// handler is also the wall-switch path, and the file is on an SD card -- a card
// that stalls for 200 ms stalls every knob in the building for 200 ms with it.
// So: buffer, and write asynchronously through one appending stream.
//
// The second job here is to stop this daemon from taking Home Assistant down.
// It writes to HA's own disk, continuously, forever. A capture is worth a lot;
// it is not worth the house. Hence the size cap, the retention sweep and the
// free-space floor, and hence the rule that when the disk gets tight we stop
// logging frames and keep bridging.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const FILE_RE = /^dali-(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/;
const MB = 1024 * 1024;

// Local date, not UTC. Someone debugging "what happened at 22:04 last night"
// wants that in last night's file; UTC naming splits an evening in two.
export function localDay(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function createLogStore({
  dir,
  flushMs = 250,
  maxBufferBytes = 1 * MB,
  retentionDays = 30,
  maxBytes = 512 * MB,
  gzipAfterDays = 1,
  minFreeBytes = 256 * MB,
  now = () => Date.now(),
  log = () => {},
  // Injected so tests can simulate a full disk without filling one.
  freeBytes = async () => {
    const s = await fsp.statfs(dir);
    return s.bavail * s.bsize;
  },
} = {}) {
  if (!dir) throw new Error('createLogStore requires a dir');
  fs.mkdirSync(dir, { recursive: true }); // startup only

  let buffer = []; // { line, keep }
  let bufferBytes = 0;
  let stream = null;
  let streamDay = null;
  let closed = false;
  let paused = false; // low disk
  let sweeping = false;

  const stats = {
    written: 0,
    dropped: 0, // buffer overflow, i.e. the disk could not keep up
    droppedLowDisk: 0,
    writeErrors: 0,
    lastError: null,
  };

  function openStream(day) {
    const file = path.join(dir, `dali-${day}.jsonl`);
    const s = fs.createWriteStream(file, { flags: 'a' });
    s.on('error', (err) => {
      stats.writeErrors += 1;
      stats.lastError = String(err?.message ?? err);
      // Drop the handle: the next flush opens a fresh one. A stream that has
      // errored never recovers, and silently buffering into it loses everything.
      if (stream === s) {
        stream = null;
        streamDay = null;
      }
      log({ kind: 'alert', alert: 'log_write_failed', error: stats.lastError });
    });
    streamDay = day;
    return s;
  }

  function currentFile() {
    return path.join(dir, `dali-${localDay(now())}.jsonl`);
  }

  // One line per event, same shape the bench build produced, so old captures and
  // anything that reads them stay compatible.
  function write(event, tsMs = now()) {
    if (closed) return;
    const keep = event?.kind === 'alert';

    if (paused && !keep) {
      stats.droppedLowDisk += 1;
      return;
    }

    let line;
    try {
      line = JSON.stringify(event) + '\n';
    } catch {
      return; // an unserialisable event is not worth crashing the bridge for
    }

    buffer.push({ line, keep, day: localDay(tsMs) });
    bufferBytes += line.length;

    if (bufferBytes > maxBufferBytes) shed();
  }

  // The disk is not keeping up. Drop frames, never alerts: an alert is the thing
  // that explains the gap, so it is the last line worth losing.
  function shed() {
    const kept = [];
    let keptBytes = 0;
    // Walk from the newest backwards so what survives is the most recent frames
    // plus every alert.
    for (let i = buffer.length - 1; i >= 0; i--) {
      const entry = buffer[i];
      if (entry.keep || keptBytes + entry.line.length <= maxBufferBytes / 2) {
        kept.push(entry);
        keptBytes += entry.line.length;
      } else {
        stats.dropped += 1;
      }
    }
    kept.reverse();
    buffer = kept;
    bufferBytes = keptBytes;
  }

  // Resolves once every line in this batch has been handed to the OS. Callers in
  // the frame path ignore the promise; shutdown and the tests await it.
  function flush() {
    if (closed || buffer.length === 0) return Promise.resolve();

    // A day boundary inside the buffer splits the write. Rare (once a day), and
    // it keeps every line in the file its timestamp says it belongs to.
    const batch = buffer;
    buffer = [];
    bufferBytes = 0;

    const waits = [];
    let i = 0;
    while (i < batch.length) {
      const day = batch[i].day;
      let j = i;
      while (j < batch.length && batch[j].day === day) j++;
      const chunk = batch.slice(i, j).map((e) => e.line).join('');

      if (!stream || streamDay !== day) {
        if (stream) stream.end();
        stream = openStream(day);
      }
      const count = j - i;
      waits.push(
        new Promise((resolve) => {
          try {
            stream.write(chunk, () => resolve());
            stats.written += count;
          } catch (err) {
            stats.writeErrors += 1;
            stats.lastError = String(err?.message ?? err);
            resolve();
          }
        }),
      );
      i = j;
    }
    return Promise.all(waits).then(() => undefined);
  }

  // The crash path, and only the crash path. Everything else here is async by
  // rule; here the process is about to stop existing, and a buffered
  // explanation that never reaches the disk is not an explanation.
  function drainSync() {
    if (buffer.length === 0) return 0;
    const batch = buffer;
    buffer = [];
    bufferBytes = 0;

    let written = 0;
    let i = 0;
    while (i < batch.length) {
      const day = batch[i].day;
      let j = i;
      while (j < batch.length && batch[j].day === day) j++;
      try {
        // May interleave with whatever the stream still owes the OS. Both are
        // appends, so nothing already written is at risk; the ordering of the
        // last few lines is a small price for having them at all.
        fs.appendFileSync(path.join(dir, `dali-${day}.jsonl`), batch.slice(i, j).map((e) => e.line).join(''));
        written += j - i;
      } catch {
        // Nothing left to try.
      }
      i = j;
    }
    return written;
  }

  async function checkSpace() {
    let free;
    try {
      free = await freeBytes();
    } catch {
      return; // cannot tell; carry on rather than stop logging on a stat failure
    }
    if (!paused && free < minFreeBytes) {
      paused = true;
      await flush();
      log({
        kind: 'alert', alert: 'log_paused_low_disk',
        free_mb: Math.round(free / MB), floor_mb: Math.round(minFreeBytes / MB),
        note: 'frame logging stopped to protect the disk Home Assistant runs on; alerts are still written and the bridge is unaffected',
      });
    } else if (paused && free >= minFreeBytes * 1.25) {
      // Hysteresis: resuming the moment we touch the floor would flap.
      paused = false;
      log({ kind: 'alert', alert: 'log_resumed', free_mb: Math.round(free / MB), dropped: stats.droppedLowDisk });
    }
  }

  async function listFiles() {
    const names = await fsp.readdir(dir);
    const out = [];
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (!m) continue; // never touch a file we did not create
      const full = path.join(dir, name);
      let st;
      try {
        st = await fsp.stat(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      out.push({ name, full, day: m[1], gz: Boolean(m[2]), size: st.size });
    }
    out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    return out;
  }

  const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

  // Housekeeping. Everything here is streamed or awaited: gzipping a 40 MB
  // capture synchronously would freeze the bridge for seconds, which would be a
  // fine example of the maintenance breaking the thing it maintains.
  async function sweep() {
    if (sweeping || closed) return null;
    sweeping = true;
    try {
      const today = localDay(now());
      const result = { gzipped: [], deleted: [] };
      let files = await listFiles();

      for (const f of files) {
        if (f.gz || f.day === today) continue;
        if (dayDiff(today, f.day) < gzipAfterDays) continue;
        const tmp = `${f.full}.gz.tmp`;
        try {
          await pipeline(fs.createReadStream(f.full), zlib.createGzip(), fs.createWriteStream(tmp));
          await fsp.rename(tmp, `${f.full}.gz`);
          await fsp.unlink(f.full);
          result.gzipped.push(f.name);
          log({ kind: 'log', action: 'gzipped', file: f.name });
        } catch (err) {
          await fsp.unlink(tmp).catch(() => {});
          log({ kind: 'alert', alert: 'log_gzip_failed', file: f.name, error: String(err?.message ?? err) });
        }
      }

      files = await listFiles();
      const remove = async (f, reason) => {
        if (f.day === today) return false; // today's capture is never a candidate
        try {
          await fsp.unlink(f.full);
          result.deleted.push(f.name);
          log({ kind: 'log', action: 'deleted', file: f.name, reason, size: f.size });
          return true;
        } catch (err) {
          log({ kind: 'alert', alert: 'log_delete_failed', file: f.name, error: String(err?.message ?? err) });
          return false;
        }
      };

      if (retentionDays > 0) {
        for (const f of files) {
          if (dayDiff(today, f.day) > retentionDays) await remove(f, 'retention');
        }
        files = await listFiles();
      }

      let total = files.reduce((n, f) => n + f.size, 0);
      for (const f of files) {
        if (total <= maxBytes) break;
        if (await remove(f, 'size_cap')) total -= f.size;
      }

      return result;
    } finally {
      sweeping = false;
    }
  }

  const flushTimer = setInterval(flush, flushMs);
  flushTimer.unref?.();
  const spaceTimer = setInterval(() => { checkSpace().catch(() => {}); }, 60_000);
  spaceTimer.unref?.();
  // A day boundary is also the moment to do the housekeeping.
  let sweepDay = localDay(now());
  const sweepTimer = setInterval(() => {
    const today = localDay(now());
    if (today !== sweepDay) {
      sweepDay = today;
      sweep().catch(() => {});
    }
  }, 60_000);
  sweepTimer.unref?.();

  async function close() {
    if (closed) return;
    await flush();
    closed = true;
    clearInterval(flushTimer);
    clearInterval(spaceTimer);
    clearInterval(sweepTimer);
    if (!stream) return;
    const s = stream;
    stream = null;
    await new Promise((resolve) => {
      s.end(resolve);
      // Shutdown is bounded: the Supervisor SIGKILLs 10 s after SIGTERM, and a
      // stuck disk must not eat that budget.
      setTimeout(resolve, 2000).unref?.();
    });
  }

  async function usage() {
    const files = await listFiles();
    return {
      files: files.length,
      bytes: files.reduce((n, f) => n + f.size, 0),
      oldest: files[0]?.day ?? null,
      newest: files[files.length - 1]?.day ?? null,
    };
  }

  return {
    write, flush, drainSync, close, sweep, usage, checkSpace, listFiles,
    currentFile,
    stats: () => ({ ...stats, paused, buffered: buffer.length }),
  };
}
