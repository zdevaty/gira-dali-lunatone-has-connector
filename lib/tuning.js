// How the knobs feel, as a file the Tuning page edits and the controller
// applies live.
//
// Three layers, each overriding the one before: the built-in defaults, the
// environment (SPEED_CURVE, MIN_BRIGHTNESS, ... -- still honoured for a bench
// run), and /config/tuning.json, which is what the page writes. The file holds
// only what was changed from the page, so "reset" is deleting keys, and a
// value set in the environment is not silently frozen into it.
//
// Validation is strict and says what is wrong in words: a NaN here would send
// `brightness_step: null` to Home Assistant from every knob in the flat. A
// file that fails validation is not applied in part -- each bad key is dropped,
// logged, and the rest is used, which is the same rule devices.json follows:
// one bad value must not cost every knob.
//
// Every change is a `tuning` event in the capture, with before and after, so
// "the knobs felt different from Tuesday" can be matched to what changed.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const number = (min, max, { integer = false } = {}) => (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return { error: 'must be a number' };
  if (integer && !Number.isInteger(n)) return { error: 'must be a whole number' };
  if (n < min || n > max) return { error: `must be between ${min} and ${max}` };
  return { value: n };
};

// The order here is the order on the page.
export const TUNING_FIELDS = Object.freeze([
  {
    key: 'speedCurve', env: 'SPEED_CURVE', group: 'Turning', label: 'Step per speed',
    default: [2, 25, 55, 80], unit: 'brightness steps',
    help: 'How far one report moves the light at each of the encoder\'s four speeds, slowest first. Brightness runs 0-255.',
    parse: (v) => {
      const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
      if (!parts || parts.length !== 4) return { error: 'must be four numbers, slowest first' };
      const nums = parts.map((p) => (typeof p === 'string' ? Number(p.trim()) : p));
      if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > 255)) return { error: 'each must be a number above 0 and at most 255' };
      if (nums.some((n, i) => i > 0 && n < nums[i - 1])) return { error: 'must not get smaller as the knob turns faster' };
      return { value: nums };
    },
  },
  {
    key: 'rampEveryReports', env: 'RAMP_EVERY_REPORTS', group: 'Turning', label: 'Speed up at an end stop every',
    default: 2, unit: 'reports', parse: number(1, 20, { integer: true }),
    help: 'Once the encoder sits at its end stop it stops reporting speed, so the step climbs one speed after this many reports of continued turning (about 175 ms each). Lower accelerates sooner.',
  },
  {
    key: 'brightnessGain', env: 'BRIGHTNESS_GAIN', group: 'Brightness', label: 'Brightness gain',
    default: 1, unit: '×', parse: number(0.1, 5),
    help: 'Multiplies every brightness step. Below 1 is finer, above 1 is faster.',
  },
  {
    key: 'minBrightness', env: 'MIN_BRIGHTNESS', group: 'Brightness', label: 'Lowest brightness',
    default: 3, unit: 'of 255', parse: number(2, 128, { integer: true }),
    help: 'Turning down stops here, so the knob never switches a light off. Measured on this hardware: 1 switches the light off and 2 is the edge, so it cannot go below 2.',
  },
  {
    key: 'levelDivergence', env: 'LEVEL_DIVERGENCE', group: 'Brightness', label: 'Trust the bus beyond',
    default: 20, unit: 'steps', parse: number(0, 255, { integer: true }),
    help: 'When Home Assistant\'s brightness and the level actually seen on the bus differ by more than this, the bus is believed and an absolute brightness is sent.',
  },
  {
    key: 'colourGain', env: 'COLOUR_GAIN', group: 'Colour', label: 'Colour gain',
    default: 1, unit: '×', parse: number(0.1, 5),
    help: 'Multiplies every colour temperature step. At 1, a full turn\'s worth of steps crosses the light\'s whole kelvin range once.',
  },
  {
    key: 'flushMs', env: 'FLUSH_MS', group: 'Timing', label: 'At most one call every',
    default: 200, unit: 'ms', parse: number(50, 2000, { integer: true }),
    help: 'Steps arriving faster are added together and sent as one Home Assistant call. Lower feels more immediate and asks more of Home Assistant.',
  },
  {
    key: 'maxQueue', env: 'MAX_QUEUE', group: 'Timing', label: 'Calls waiting per light, at most',
    default: 4, unit: 'calls', parse: number(1, 20, { integer: true }),
    help: 'When Home Assistant is slow, older waiting calls are dropped beyond this, so a light never keeps moving after the hand has left the knob.',
  },
  {
    key: 'staleMs', env: 'STALE_MS', group: 'Timing', label: 'Drop a call older than',
    default: 1500, unit: 'ms', parse: number(200, 10_000, { integer: true }),
    help: 'A call that waited this long for Home Assistant is discarded instead of applied late.',
  },
]);

const FIELD = new Map(TUNING_FIELDS.map((f) => [f.key, f]));

export const TUNING_DEFAULTS = Object.freeze(Object.fromEntries(TUNING_FIELDS.map((f) => [f.key, f.default])));

// { ok, value, problems }: value has only the keys given, parsed.
export function validateTuning(input, { partial = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, value: {}, problems: ['the settings must be an object'] };
  const value = {};
  const problems = [];
  for (const [key, raw] of Object.entries(input)) {
    const field = FIELD.get(key);
    if (!field) { problems.push(`"${key}" is not a tuning setting`); continue; }
    const r = field.parse(raw);
    if (r.error) problems.push(`${field.label}: ${r.error}`);
    else value[key] = r.value;
  }
  if (!partial) for (const f of TUNING_FIELDS) if (!(f.key in value) && !problems.some((p) => p.startsWith(f.label))) problems.push(`${f.label}: missing`);
  return { ok: problems.length === 0, value, problems };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createTuningStore({ file = null, env = process.env, log = () => {}, onChange = () => {} } = {}) {
  // Defaults, then the environment. Bad environment values were already fatal
  // at startup for SPEED_CURVE; the rest fall back to the default, loudly.
  const base = { ...TUNING_DEFAULTS, speedCurve: [...TUNING_DEFAULTS.speedCurve] };
  const fromEnv = new Set();
  for (const f of TUNING_FIELDS) {
    const raw = env[f.env];
    if (raw === undefined || raw === '') continue;
    const r = f.parse(raw);
    if (r.error) {
      log({ kind: 'alert', alert: 'tuning_problem', setting: f.key, source: f.env, problem: r.error, note: 'the default is used instead' });
    } else {
      base[f.key] = r.value;
      fromEnv.add(f.key);
    }
  }

  let overrides = {};
  let previous = null; // the overrides before the last change, for Undo
  let problems = [];

  const effective = () => ({ ...base, ...overrides });

  function load() {
    problems = [];
    if (!file) return effective();
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') problems.push(`could not read ${file}: ${err.message}`);
      overrides = {};
      return effective();
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      problems.push(`${file} is not valid JSON (${err.message}); using the defaults until it is fixed or saved from the page`);
      overrides = {};
      return effective();
    }
    const checked = validateTuning(parsed);
    overrides = checked.value;
    problems.push(...checked.problems);
    for (const problem of problems) log({ kind: 'alert', alert: 'tuning_problem', file, problem, note: 'that setting is ignored; the rest apply' });
    log({ kind: 'tuning', action: 'loaded', file, settings: overrides });
    return effective();
  }

  async function write(next) {
    if (!file) return;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
    await fsp.rename(tmp, file);
  }

  async function commit(next, action) {
    const before = effective();
    const oldOverrides = overrides;
    // Only what differs from the base is kept, so the file never pins a value
    // that merely happens to equal today's default.
    const trimmed = Object.fromEntries(Object.entries(next).filter(([k, v]) => !same(v, base[k])));
    try {
      await write(trimmed);
    } catch (err) {
      return { ok: false, code: 500, problems: [`could not save ${file}: ${err.message}`] };
    }
    previous = oldOverrides;
    overrides = trimmed;
    problems = [];
    const after = effective();
    const changed = TUNING_FIELDS.map((f) => f.key).filter((k) => !same(before[k], after[k]));
    if (changed.length) {
      log({ kind: 'tuning', action, changed: Object.fromEntries(changed.map((k) => [k, { from: before[k], to: after[k] }])) });
      try { onChange(after); } catch { /* the controller refusing is reported by the caller */ }
    }
    return { ok: true, changed, ...snapshot() };
  }

  async function save(input) {
    const checked = validateTuning(input);
    if (!checked.ok) return { ok: false, code: 400, problems: checked.problems };
    return commit({ ...overrides, ...checked.value }, 'saved');
  }

  async function reset(keys = null) {
    if (keys !== null && (!Array.isArray(keys) || keys.some((k) => !FIELD.has(k)))) {
      return { ok: false, code: 400, problems: ['reset takes a list of setting names, or nothing for all'] };
    }
    const next = keys === null ? {} : Object.fromEntries(Object.entries(overrides).filter(([k]) => !keys.includes(k)));
    return commit(next, 'reset');
  }

  async function undo() {
    if (previous === null) return { ok: false, code: 409, problems: ['nothing to undo'] };
    const target = previous;
    const r = await commit(target, 'undone');
    if (r.ok) previous = null;
    return r.ok ? { ...r, ...snapshot() } : r;
  }

  function snapshot() {
    const values = effective();
    return {
      file,
      values,
      source: Object.fromEntries(TUNING_FIELDS.map((f) => [f.key, f.key in overrides ? 'page' : fromEnv.has(f.key) ? 'environment' : 'default'])),
      base,
      can_undo: previous !== null,
      problems,
      fields: TUNING_FIELDS.map(({ key, group, label, unit, help, default: def }) => ({ key, group, label, unit, help, default: def })),
    };
  }

  return { load, save, reset, undo, snapshot, values: effective };
}
