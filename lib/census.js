// Who is on the bus.
//
// DALI hands out short addresses by random search at commissioning time, so
// nothing tells you which knob is in which room except turning it and watching.
// This is the record of that: every address seen, in both address spaces, with
// enough context for the commissioning page to light up the row that just spoke.
//
// Control devices (knobs) and control gear (drivers) are numbered independently,
// which is why they are counted separately here and why a knob at A0 says
// nothing at all about which driver its room's light answers to.

import { monotonicNow } from './clock.js';

export function createCensus({ now = monotonicNow, wall = () => Date.now() } = {}) {
  const devices = new Map(); // address -> record
  const gear = new Map(); // target -> record

  function touch(map, key, extra) {
    let rec = map.get(key);
    if (!rec) {
      rec = { frames: 0, firstSeen: wall(), lastSeen: wall(), lastMono: now() };
      map.set(key, rec);
    }
    rec.frames += 1;
    rec.lastSeen = wall();
    rec.lastMono = now();
    // Not Object.assign: it copies undefined values too, so a colour frame
    // would wipe the last known arc level and vice versa.
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) rec[key] = value;
    }
    return rec;
  }

  function note(event) {
    if (!event || typeof event.kind !== 'string') return;

    if (event.kind === 'inputEvent') {
      // Only device/instance addressing carries an address. Anything else is
      // logged but identifies nobody, so it must not invent a row.
      if (event.scheme !== 'device_instance' || typeof event.address !== 'number') return;
      touch(devices, event.address, {
        lastInstance: event.instanceType ?? null,
        lastEvent: event.event ?? (event.value !== undefined ? `value=${event.value}` : null),
      });
      return;
    }

    if (event.kind === 'level' || event.kind === 'colour') {
      if (typeof event.target !== 'string') return;
      touch(gear, event.target, {
        lastLevel: event.kind === 'level' ? event.level : undefined,
        lastKelvin: event.kind === 'colour' ? event.kelvin : undefined,
      });
    }
  }

  const age = (rec) => Math.round((now() - rec.lastMono) / 1000);

  function list() {
    return {
      devices: [...devices.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([address, r]) => ({
          address,
          target: `short${address}`,
          frames: r.frames,
          last_seen_age_s: age(r),
          last_seen: new Date(r.lastSeen).toISOString(),
          last_instance: r.lastInstance ?? null,
          last_event: r.lastEvent ?? null,
        })),
      gear: [...gear.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([target, r]) => ({
          target,
          // Only a short address identifies one driver. Broadcast and group
          // frames name a set, so they can never be evidence for a mapping.
          addressable: /^short\d+$/.test(target),
          frames: r.frames,
          last_seen_age_s: age(r),
          last_seen: new Date(r.lastSeen).toISOString(),
          last_level: r.lastLevel ?? null,
          last_kelvin: r.lastKelvin ?? null,
        })),
    };
  }

  return { note, list, counts: () => ({ devices: devices.size, gear: gear.size }) };
}
