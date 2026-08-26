import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createDecoder } from './lib/decoder.js';
import { createAnomalyDetector } from './lib/anomaly.js';
import { createHaClient } from './lib/ha-client.js';
import { createController } from './lib/control.js';
import { createGearDiscovery } from './lib/discover.js';
import { monotonicNow, createClockWatch } from './lib/clock.js';
import { createLogStore } from './lib/logstore.js';
import { startWatchdog } from './lib/watchdog.js';
import { acquireLock } from './lib/lock.js';

const MAX_BACKOFF_MS = 60_000;
// How long a link must hold before its backoff is forgiven. A gateway that
// accepts a connection and immediately drops it would otherwise reset the
// backoff on every attempt and be retried once a second, forever.
const STABLE_MS = 30_000;
const SHUTDOWN_BUDGET_MS = 3000;
const { version: VERSION } = createRequire(import.meta.url)('./package.json');

function fatal(...lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

function loadDeviceMap(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    fatal(`dali-logger: could not read DEVICE_MAP at ${filePath}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fatal(`dali-logger: DEVICE_MAP at ${filePath} must be a JSON object keyed by short address.`);
  }
  const map = {};
  for (const [address, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry.entity !== 'string') {
      fatal(`dali-logger: DEVICE_MAP entry "${address}" is missing an "entity" field.`);
    }
    map[address] = {
      entity: entry.entity,
      min_kelvin: Number(entry.min_kelvin) || 2700,
      max_kelvin: Number(entry.max_kelvin) || 6500,
      // Which control-gear address on the bus this knob's light answers to. No default:
      // the two address spaces are commissioned independently, so any guess is a
      // coincidence at best. Left null, the daemon measures it instead of assuming.
      gear: typeof entry.gear === 'string' ? entry.gear : null,
    };
  }
  return map;
}

// The speed curve is four numbers because the encoder resolves exactly four speeds.
// Validated strictly: a typo here would silently change how every knob in the building
// behaves, and a NaN would send `brightness_step: null` to Home Assistant.
function loadSpeedCurve(raw) {
  if (!raw) return [2, 25, 55, 80];
  const parts = String(raw).split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n <= 0)) {
    fatal(
      `dali-logger: SPEED_CURVE must be four positive numbers, slowest first — got "${raw}".`,
      'It maps the encoder\'s four rotation speeds onto step sizes, e.g. SPEED_CURVE=2,25,55,80',
    );
  }
  return parts;
}

function loadConfig() {
  const gatewayIp = process.env.GATEWAY_IP;
  const logDir = process.env.LOG_DIR;
  if (!gatewayIp || !logDir) {
    fatal(
      'dali-logger: GATEWAY_IP and LOG_DIR environment variables are required.',
      'Example: GATEWAY_IP=10.0.0.230 LOG_DIR=./logs node index.js',
    );
  }

  const controlEnabled = !['false', '0', 'no'].includes(String(process.env.CONTROL_ENABLED ?? 'true').toLowerCase());
  let deviceMap = {};
  if (controlEnabled) {
    if (!process.env.HA_TOKEN) {
      fatal(
        'dali-logger: HA_TOKEN is required when CONTROL_ENABLED is true.',
        'Create a long-lived access token in Home Assistant, or set CONTROL_ENABLED=false to log only.',
      );
    }
    if (!process.env.DEVICE_MAP) {
      fatal(
        'dali-logger: DEVICE_MAP is required when CONTROL_ENABLED is true.',
        'Point it at a JSON file mapping control-device short addresses to HA entities.',
      );
    }
    deviceMap = loadDeviceMap(process.env.DEVICE_MAP);
  }

  return {
    gatewayIp,
    logDir,
    cctBurstMinSamples: Number(process.env.CCT_BURST_MIN_SAMPLES) || 8,
    cctSpanThreshold: Number(process.env.CCT_SPAN_THRESHOLD) || 40,
    controlEnabled,
    deviceMap,
    haUrl: process.env.HA_URL || 'http://localhost:8123',
    haToken: process.env.HA_TOKEN,
    flushMs: Number(process.env.FLUSH_MS) || 200,
    speedCurve: loadSpeedCurve(process.env.SPEED_CURVE),
    rampEveryReports: Number(process.env.RAMP_EVERY_REPORTS) || 2,
    levelDivergence: Number(process.env.LEVEL_DIVERGENCE ?? 20),
    discoverGear: ['true', '1', 'yes'].includes(String(process.env.DISCOVER_GEAR ?? '').toLowerCase()),
    brightnessGain: Number(process.env.BRIGHTNESS_GAIN) || 1,
    colourGain: Number(process.env.COLOUR_GAIN) || 1,
    minBrightness: Number(process.env.MIN_BRIGHTNESS ?? 3),
    logFrames: loadChoice('LOG_FRAMES', ['all', 'decoded', 'events', 'alerts'], 'all'),
    consoleLevel: loadChoice('CONSOLE', ['pretty', 'quiet', 'off'], 'pretty'),
    logRetentionDays: Number(process.env.LOG_RETENTION_DAYS ?? 30),
    logMaxMb: Number(process.env.LOG_MAX_MB ?? 512),
    logMinFreeMb: Number(process.env.LOG_MIN_FREE_MB ?? 256),
  };
}

function loadChoice(name, allowed, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = String(raw).toLowerCase();
  if (!allowed.includes(value)) {
    fatal(`dali-logger: ${name} must be one of ${allowed.join(', ')} -- got "${raw}".`);
  }
  return value;
}

// How much of the bus reaches the capture file. `all` while debugging; the
// lower settings exist because this now runs on the SD card Home Assistant
// boots from, and `raw` alone is a third of every capture so far.
const FRAME_KINDS = new Set([
  'level', 'colour', 'raw', 'command', 'response', 'orphan_response', 'unknown', 'inputEvent',
]);

function wantLogged(level, kind) {
  switch (level) {
    case 'alerts': return kind === 'alert' || kind === 'connection';
    case 'events': return !FRAME_KINDS.has(kind) || kind === 'inputEvent';
    case 'decoded': return kind !== 'raw';
    default: return true;
  }
}

// stdout goes to the add-on log, which is the same SD card. Printing every frame
// writes the capture twice.
const CONSOLE_ALWAYS = new Set(['alert', 'connection', 'control', 'preflight', 'discover', 'log']);

function wantPrinted(level, kind) {
  if (level === 'off') return false;
  if (level === 'quiet') return CONSOLE_ALWAYS.has(kind);
  return true;
}

function targetAbbrev(target) {
  if (!target) return '';
  if (target === 'broadcast') return 'bcast';
  const group = target.match(/^group(\d+)$/);
  if (group) return `G${group[1]}`;
  const short = target.match(/^short(\d+)$/);
  if (short) return `A${short[1]}`;
  return target;
}

function formatConsoleLine(event) {
  const time = new Date(event.ts).toTimeString().slice(0, 8);
  const label = targetAbbrev(event.target);

  if (event.kind === 'alert') {
    // Preflight failures carry prose meant to be read, not key=value noise.
    if (event.alert === 'ha_preflight_failed') {
      const hint = event.hint ? `\n          hint: ${event.hint}` : '';
      return `${time}  ALERT  HA preflight [${event.step}]: ${event.reason}${hint}`;
    }
    const extra = Object.entries(event)
      .filter(([k]) => !['kind', 'ts', 'bits', 'bytes', 'alert', 'target'].includes(k))
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    return `${time}  ALERT  ${[event.alert, label, extra].filter(Boolean).join(' ')}`;
  }

  switch (event.kind) {
    case 'level':
      return `${time}  ${label.padEnd(6)} level ${event.level}`;
    case 'colour':
      return `${time}  ${label.padEnd(6)} colour ${event.mired} mired (${event.kelvin} K)`;
    case 'inputEvent': {
      // A non-default event scheme has no address, so show the scheme instead of an
      // empty label rather than letting it look like a nameless device.
      const who = event.scheme === 'device_instance' ? label : `[${event.scheme}]`;
      return `${time}  ${who.padEnd(6)} ${event.instanceType} ${event.event ?? event.value}`;
    }
    case 'control': {
      const what =
        event.action === 'brightness_step'
          ? `brightness_step ${event.step > 0 ? '+' : ''}${event.step}`
          : event.action === 'color_temp_kelvin'
            ? `${event.kelvin} K`
            : event.action === 'brightness'
              ? `brightness ${event.brightness}${event.floored ? ' (FLOORED)' : event.ceiling ? ' (CEILING)' : ''}`
              : event.action === 'brightness_suppressed'
                ? `no change — ${event.reason}`
                : event.action;
      return `${time}  ${label.padEnd(6)} → ${event.entity} ${what}`;
    }
    case 'raw':
      return `${time}  ${label.padEnd(6)} raw ${event.bytes}`;
    case 'command': {
      if (event.scope === 'special') {
        const operands = event.values
          ? Object.entries(event.values).map(([k, v]) => `${k}=${v}`).join(' ')
          : event.value != null ? `${event.value}` : '';
        return `${time}  ${''.padEnd(6)} special ${event.command}${operands ? ` ${operands}` : ''}`;
      }
      return `${time}  ${label.padEnd(6)} cmd inst=${event.instance} op=${event.opcode} (${event.category})`;
    }
    case 'response': {
      const what = event.to.special ? event.to.special : `inst=${event.to.instance} op=${event.to.opcode}`;
      return `${time}  reply  ${event.value} → ${what}`;
    }
    case 'orphan_response':
      return `${time}  reply  ${event.value} (orphan)`;
    case 'unknown':
      return `${time}  unknown ${event.bits}b ${event.bytes}`;
    case 'connection':
      return `${time}  connection ${event.status}`;
    case 'startup':
      return `${time}  start  v${event.version} on ${event.host} (node ${event.node}, ${event.tz}) gateway=${event.gateway} control=${event.control} logs=${event.log_dir} [${event.log_frames}]`;
    case 'log':
      return `${time}  logs   ${event.action} ${event.file}${event.reason ? ` (${event.reason})` : ''}`;
    case 'discover': {
      if (event.step === 'device') {
        const detail =
          event.result === 'ok' ? `= ${event.gear}`
            : event.result === 'ambiguous' ? `AMBIGUOUS: ${event.candidates.join(', ')}`
              : event.result === 'no_response' ? `no gear responded (saw: ${event.saw.join(', ') || 'nothing'})`
                : event.result;
        return `${time}  gear   A${event.address} ${event.entity} ${detail}`;
      }
      if (event.step === 'devices_json') {
        return `${time}  gear   paste into devices.json:\n${JSON.stringify(event.mapping, null, 2)}`;
      }
      return `${time}  gear   ${event.step} ${Object.entries(event).filter(([k]) => !['kind', 'ts', 'step'].includes(k)).map(([k, v]) => `${k}=${v}`).join(' ')}`;
    }
    case 'preflight': {
      const detail = Object.entries(event)
        .filter(([k]) => !['kind', 'ts', 'step'].includes(k))
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('..') : v}`)
        .join(' ');
      return `${time}  HA     ${event.step.padEnd(8)} ${detail}`;
    }
    default:
      return `${time}  ${JSON.stringify(event)}`;
  }
}

function main() {
  const config = loadConfig();

  fs.mkdirSync(config.logDir, { recursive: true });
  const lock = acquireLock(config.logDir);
  if (!lock.ok) {
    fatal(
      `dali-logger: another instance is already running here (pid ${lock.holder?.pid}, started ${lock.holder?.started}).`,
      'Two bridges on one bus send every gesture to Home Assistant twice, which looks like a tuning fault and is not one.',
      `If you are sure it is gone, remove ${config.logDir}/.dali-bridge.lock`,
    );
  }

  const store = createLogStore({
    dir: config.logDir,
    retentionDays: config.logRetentionDays,
    maxBytes: config.logMaxMb * 1024 * 1024,
    minFreeBytes: config.logMinFreeMb * 1024 * 1024,
    log: (event) => emit(event),
  });

  const decoder = createDecoder();
  const anomaly = createAnomalyDetector({
    burstMinSamples: config.cctBurstMinSamples,
    spanThreshold: config.cctSpanThreshold,
  });

  function emit(partialEvent, tsMs = Date.now()) {
    const event = { ts: new Date(tsMs).toISOString(), ...partialEvent };
    if (wantPrinted(config.consoleLevel, event.kind)) console.log(formatConsoleLine(event));
    if (wantLogged(config.logFrames, event.kind)) store.write(event, tsMs);
    return event;
  }

  // The first line of every capture says what wrote it, so a file found weeks
  // later can be attributed to a build and a machine. Never the token, only that
  // one is present -- same rule as the preflight.
  emit({
    kind: 'startup',
    version: VERSION,
    node: process.version,
    host: os.hostname(),
    pid: process.pid,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    gateway: config.gatewayIp,
    control: config.controlEnabled,
    ha_url: config.controlEnabled ? config.haUrl : null,
    ha_token: config.haToken ? `present (${String(config.haToken).length} chars)` : null,
    log_dir: config.logDir,
    log_frames: config.logFrames,
    retention_days: config.logRetentionDays,
    max_mb: config.logMaxMb,
  });

  // Housekeeping at startup as well as at midnight: the daemon may have been
  // down across a rollover, and an oversized capture directory is exactly what
  // you inherit after a crash loop.
  store.sweep().catch(() => {});

  const watchdog = startWatchdog({
    timeoutMs: Number(process.env.WATCHDOG_TIMEOUT_MS ?? 15_000),
    enabled: !['false', '0', 'no'].includes(String(process.env.WATCHDOG ?? 'true').toLowerCase()),
    currentFile: () => store.currentFile(),
  });

  // Crash-only. An unhandled error means the process is in a state nobody
  // reasoned about, and the supervisor restarts us in about two seconds -- far
  // less than the time it takes anyone to notice a daemon that is running but
  // subtly wrong. Write down why first: stdout is block-buffered when it is a
  // pipe (which it is under both Docker and systemd), so the last console lines
  // before an exit are routinely lost. The capture file is not.
  let dying = false;
  function die(alert, err) {
    if (dying) process.exit(1);
    dying = true;
    try {
      emit({ kind: 'alert', alert, error: String(err?.stack ?? err?.message ?? err) });
      store.drainSync();
      lock.release();
    } catch {
      // Nothing useful left to do.
    }
    process.exit(1);
  }
  process.on('uncaughtException', (err) => die('uncaught_exception', err));
  process.on('unhandledRejection', (err) => die('unhandled_rejection', err));

  let leaving = false;
  async function shutdown(signal) {
    if (leaving) return;
    leaving = true;
    emit({ kind: 'connection', status: 'shutdown', signal });
    watchdog.stop();
    // Bounded: the Supervisor sends SIGKILL ten seconds after SIGTERM, and a
    // hung Home Assistant call must not spend that budget.
    await Promise.race([
      Promise.all([controller ? controller.settled() : null, store.close()]),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_BUDGET_MS)),
    ]).catch(() => {});
    store.drainSync();
    lock.release();
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const ha = config.controlEnabled
    ? createHaClient({ url: config.haUrl, token: config.haToken, log: emit })
    : null;

  const controller = config.controlEnabled
    ? createController({
        deviceMap: config.deviceMap,
        ha,
        log: emit,
        flushMs: config.flushMs,
        speedCurve: config.speedCurve,
        rampEveryReports: config.rampEveryReports,
        levelDivergence: config.levelDivergence,
        brightnessGain: config.brightnessGain,
        colourGain: config.colourGain,
        minBrightness: config.minBrightness,
        // Every window and throttle in the gesture machine is measured against
        // this. It must not be the wall clock: this daemon is meant to run on a
        // Raspberry Pi, which has no RTC and gets its clock stepped by NTP a few
        // seconds after boot. See lib/clock.js.
        now: monotonicNow,
      })
    : null;

  const schemesSeen = new Set();

  // Says so in the log when the system clock jumps, so that timestamps either
  // side of the step are not silently compared.
  const clockWatch = createClockWatch({ log: emit });
  setInterval(() => clockWatch.check(), 1000).unref();

  // Opt-in, because it visibly changes every mapped light for a second or two. It never
  // writes to the bus: each probe is a Home Assistant call, and the bus is only watched.
  const discovery =
    config.controlEnabled && config.discoverGear
      ? createGearDiscovery({ ha, deviceMap: config.deviceMap, log: emit })
      : null;

  // One frame must never be able to take the bridge down. It has happened once
  // already: a gateway message with `data` as a string threw out of the message
  // handler and ended the process.
  let frameErrors = 0;
  function handleFrame(bits, bytes) {
    try {
      decodeAndDispatch(bits, bytes);
    } catch (err) {
      frameErrors += 1;
      // Once, then every hundredth: a systematically malformed stream would
      // otherwise fill the capture with the same stack trace.
      if (frameErrors === 1 || frameErrors % 100 === 0) {
        emit({
          kind: 'alert', alert: 'frame_handler_failed', count: frameErrors,
          bits, bytes: Array.isArray(bytes) ? bytes.join(' ') : String(bytes),
          error: String(err?.message ?? err),
        });
      }
    }
  }

  function decodeAndDispatch(bits, bytes) {
    // One timestamp for both decoding (query/response pairing) and the log line,
    // so the pairing window is measured against what the log actually shows.
    const tsMs = Date.now();
    const decoded = decoder.decodeFrame(bits, bytes, tsMs);
    const event = emit(decoded, tsMs);

    // The event scheme is part of the controller's configuration. If someone flips it
    // in DALI Cockpit the frame layout changes underneath us, so say so loudly once
    // rather than quietly decoding the new shape with the old rules.
    if (event.kind === 'inputEvent' && event.scheme !== 'device_instance' && !schemesSeen.has(event.scheme)) {
      schemesSeen.add(event.scheme);
      emit({ kind: 'alert', alert: 'unexpected_event_scheme', scheme: event.scheme,
        note: 'controller is not using device/instance addressing; these events carry no device address and will not control lights' }, tsMs);
    }

    let alert = null;
    if (event.kind === 'colour') {
      alert = anomaly.onColour(event.target, event.mired, tsMs);
    } else if (event.kind === 'level') {
      alert = anomaly.onLevel(event.target, event.level, tsMs);
    }
    if (alert) emit(alert);

    // Only 24-bit input events drive lights; 16-bit frames (the emergency
    // broadcast controller) are logged above and deliberately not mapped.
    // Arc levels are the only direct evidence of what a light is actually doing, so
    // feed them to the controller as a check on what Home Assistant reports.
    if (controller && event.kind === 'level') controller.observeLevel(event.target, event.level);
    if (discovery && event.kind === 'level') discovery.observeLevel(event.target, event.level);
    // A knob being turned mid-probe injects levels of its own and would corrupt the
    // mapping, so hand the bus back to the person using it.
    if (discovery && event.kind === 'inputEvent') discovery.abort('a controller was used during discovery');
    if (controller) controller.handleEvent(event);
  }

  let backoffMs = 1000;
  let discoveryStarted = false;

  function connect() {
    if (leaving) return;
    const ws = new WebSocket(`ws://${config.gatewayIp}`);
    let stableTimer = null;
    // Node's WebSocket fires only 'error' (no 'close') when the initial handshake
    // fails, but only 'close' (no 'error') when an established connection drops —
    // so both need to trigger reconnect, guarded to fire once per attempt.
    let down = false;

    function handleDown() {
      if (down) return;
      down = true;
      if (stableTimer) clearTimeout(stableTimer);
      if (leaving) return;
      emit({ kind: 'connection', status: 'disconnected' });
      // Deliberately NOT unref'd. This is the only thing keeping the process
      // alive while the gateway is unreachable, and a bridge that quietly exits
      // because the network was not up yet at boot is the worst of both worlds:
      // no lights, no logs, and a supervisor restarting it into the same race.
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }

    ws.addEventListener('open', () => {
      emit({ kind: 'connection', status: 'connected' });
      // Forgiven only once the link has proven it can hold. Resetting on `open`
      // alone turns a flapping gateway into a once-a-second retry loop.
      stableTimer = setTimeout(() => {
        backoffMs = 1000;
      }, STABLE_MS);
      stableTimer.unref?.();
      // Discovery needs the bus in view to see which gear answers, so it can only start
      // once the gateway is actually connected. Once per run, not on every reconnect.
      if (discovery && !discoveryStarted) {
        discoveryStarted = true;
        discovery.run().catch((err) =>
          emit({ kind: 'alert', alert: 'gear_discovery_failed', reason: String(err?.message ?? err) }),
        );
      }
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const frame = msg && msg.type === 'daliMonitor' ? msg.data : null;
      if (!frame) return;
      handleFrame(frame.bits, frame.data);
    });

    ws.addEventListener('close', handleDown);
    ws.addEventListener('error', handleDown);
  }

  // Check HA before touching the bus. A failure is reported in full detail but is
  // never fatal: logging the bus is useful on its own, and HA may come back later.
  if (ha) {
    ha.preflight(config.deviceMap)
      .then((ok) => {
        if (!ok) {
          console.error('dali-logger: Home Assistant preflight FAILED — see the alerts above.');
          console.error('             Bus logging continues; light control will not work until this is fixed.');
        }
      })
      .catch((err) => emit({ kind: 'alert', alert: 'ha_preflight_failed', step: 'internal', reason: String(err?.message ?? err) }))
      .finally(connect);
  } else {
    connect();
  }
}

main();
