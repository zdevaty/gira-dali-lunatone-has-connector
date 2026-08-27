// The device map: which knob drives which Home Assistant light.
//
// Never all-or-nothing. A malformed entry disables ONE knob and is reported; it
// must not prevent startup, because refusing to start disables every knob in the
// building instead of one. A fresh install has no map at all, and the daemon is
// still useful then -- it is the thing that tells you which addresses exist.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function validateDeviceMap(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { map: {}, problems: ['the device map must be a JSON object keyed by short address'] };
  }

  const map = {};
  const problems = [];
  for (const [address, entry] of Object.entries(parsed)) {
    if (!/^\d+$/.test(address)) {
      problems.push(`entry "${address}" is not a short address and was skipped`);
      continue;
    }
    if (Number(address) > 63) {
      // Short addresses stop at 63 in both spaces; anything above is a decode
      // mistake or a typo, and acting on it would name a device that cannot exist.
      problems.push(`entry "${address}" is above the highest short address (63) and was skipped`);
      continue;
    }
    if (!entry || typeof entry !== 'object' || typeof entry.entity !== 'string' || entry.entity === '') {
      problems.push(`entry "${address}" has no "entity" and was skipped`);
      continue;
    }
    if (entry.gear != null && !/^short\d+$/.test(String(entry.gear))) {
      problems.push(`entry "${address}" has gear "${entry.gear}", which is not a short address; ignoring it`);
    }

    const min = Number(entry.min_kelvin) || 2700;
    const max = Number(entry.max_kelvin) || 6500;
    if (min >= max) problems.push(`entry "${address}" has min_kelvin >= max_kelvin; using the defaults`);

    map[address] = {
      entity: entry.entity,
      min_kelvin: min < max ? min : 2700,
      max_kelvin: min < max ? max : 6500,
      // No default, deliberately. Control devices and control gear are numbered
      // independently at commissioning, so any guess is a coincidence at best --
      // and what this feeds is an absolute brightness write to whichever light
      // it names. A missing mapping is visible; a wrong one is not.
      gear: typeof entry.gear === 'string' && /^short\d+$/.test(entry.gear) ? entry.gear : null,
    };
  }
  return { map, problems };
}

export function createDeviceStore({ file, log = () => {}, onChange = () => {} } = {}) {
  if (!file) throw new Error('createDeviceStore requires a file');

  let map = {};
  let problems = [];

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8'); // startup, and after an explicit save
    } catch (err) {
      map = {};
      problems = err.code === 'ENOENT'
        ? [`no device map at ${file} yet — turn a knob and the log will name its address`]
        : [`could not read ${file}: ${err.message}`];
      return { map, problems };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      map = {};
      problems = [`${file} is not valid JSON: ${err.message}`];
      return { map, problems };
    }

    ({ map, problems } = validateDeviceMap(parsed));
    return { map, problems };
  }

  // Temp file then rename, so a crash mid-write cannot leave a half-written map
  // that the next start would reject. The previous version is kept as .bak,
  // because this is a file a person edits by hand and by UI in turn.
  async function save(next) {
    const check = validateDeviceMap(next);
    const fatal = check.problems.filter((p) => p.includes('was skipped') || p.includes('must be a JSON object'));
    if (fatal.length && Object.keys(check.map).length === 0) {
      return { ok: false, problems: check.problems, map: null };
    }

    const tmp = `${file}.tmp`;
    const body = JSON.stringify(next, null, 2) + '\n';
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      try {
        await fsp.copyFile(file, `${file}.bak`);
      } catch {
        // No previous version; nothing to keep.
      }
      await fsp.writeFile(tmp, body, 'utf8');
      await fsp.rename(tmp, file);
    } catch (err) {
      await fsp.unlink(tmp).catch(() => {});
      return { ok: false, problems: [`could not write ${file}: ${err.message}`], map: null };
    }

    load();
    log({ kind: 'devices', action: 'saved', file, devices: Object.keys(map).length, problems: problems.length });
    onChange(map, problems);
    return { ok: true, problems, map };
  }

  return {
    load,
    save,
    get: () => map,
    problems: () => problems,
    file,
  };
}
