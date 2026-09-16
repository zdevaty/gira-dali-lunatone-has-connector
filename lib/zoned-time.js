// Wall-clock time in a named time zone, without a library.
//
// The gateway keeps its own clock and time zone and runs its schedules by
// them, so comparing its clock with ours, or working out when one of its
// schedules is due, means converting between an instant and a wall time in a
// zone that may not be ours. Intl knows every zone's offset at every instant;
// this is the arithmetic around it.

const partsFormatter = new Map();
function formatter(timeZone) {
  let f = partsFormatter.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'long',
    });
    partsFormatter.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

// The wall time in `timeZone` at instant `ms`.
export function wallTime(ms, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
    weekday: parts.weekday.toLowerCase(),
  };
}

// The instant at which `timeZone` shows this wall time. Twice round is enough:
// the offset can only change once near any given instant. In the hour a DST
// change skips, this lands an hour later; in the hour it repeats, on the first.
export function zonedToEpoch({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const w = wallTime(guess, timeZone);
    const shown = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    guess += asUtc - shown;
  }
  return guess;
}

// The gateway's /datetime returns `date` and `time` as strings, and the schema
// does not say in what format. These are the shapes worth accepting; anything
// else is reported as unrecognised rather than guessed at. The shape found is
// kept, so the clock can be set back in the same format it was read in.
const DATE_SHAPES = [
  { name: 'iso', re: /^(\d{4})-(\d{2})-(\d{2})$/, pick: (m) => [m[1], m[2], m[3]], format: (y, mo, d) => `${y}-${mo}-${d}` },
  { name: 'dotted', re: /^(\d{2})\.(\d{2})\.(\d{4})$/, pick: (m) => [m[3], m[2], m[1]], format: (y, mo, d) => `${d}.${mo}.${y}` },
];
const TIME_SHAPES = [
  { name: 'hms', re: /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/, format: (h, mi, s) => `${h}:${mi}:${s}` },
  { name: 'hm', re: /^(\d{2}):(\d{2})$/, format: (h, mi) => `${h}:${mi}` },
];

export function parseGatewayDateTime(date, time) {
  if (typeof date !== 'string' || typeof time !== 'string') return null;
  // Some firmwares put the whole thing in one field.
  const joined = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/.exec(date);
  if (joined && !time) return parseGatewayDateTime(joined[1], joined[2]);
  const ds = DATE_SHAPES.find((s) => s.re.test(date.trim()));
  const ts = TIME_SHAPES.find((s) => s.re.test(time.trim()));
  if (!ds || !ts) return null;
  const [year, month, day] = ds.pick(ds.re.exec(date.trim())).map(Number);
  const tm = ts.re.exec(time.trim());
  const hour = Number(tm[1]);
  const minute = Number(tm[2]);
  const second = tm[3] === undefined ? 0 : Number(tm[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  return { wall: { year, month, day, hour, minute, second }, dateShape: ds.name, timeShape: ts.name };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

// The instant `ms`, written the way the gateway wrote it.
export function formatGatewayDateTime(ms, timeZone, { dateShape, timeShape }) {
  const ds = DATE_SHAPES.find((s) => s.name === dateShape);
  const ts = TIME_SHAPES.find((s) => s.name === timeShape);
  if (!ds || !ts) return null;
  const w = wallTime(ms, timeZone);
  return {
    date: ds.format(pad(w.year, 4), pad(w.month), pad(w.day)),
    time: ts.format(pad(w.hour), pad(w.minute), pad(w.second)),
  };
}
