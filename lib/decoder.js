// DALI frame decoder — see spec section 4 for the addressing/opcode scheme this
// implements. Byte-level behaviour is verified against every fixture in section 8.

const PUSH_BUTTON_EVENTS = {
  // 0x00 is never sent by the Gira controllers (measured), but it is enabled in
  // their event filter, so decode it anyway — the control state machine treats it
  // as a hold-ending event alongside long_stop / short_press.
  0x00: 'released',
  0x01: 'pressed',
  0x02: 'short_press',
  0x09: 'long_start',
  0x0b: 'long_repeat',
  0x0c: 'long_stop',
  // ASSUMPTION: 0x08 is the DALI-301 standard "button stuck" code. Gira's other
  // opcodes (09/0B/0C) don't follow that numbering, so this one is unconfirmed —
  // if it's wrong, a real stuck event just logs as `unknown` with its raw bytes
  // and no alert fires. Confirm by wedging a button down for >20 s.
  0x08: 'stuck',
};

const GENERIC_EVENTS = {
  0x00: 'start_right',
  0x01: 'start_left',
  0x02: 'stop',
};

function formatBytes(bytes) {
  if (!Array.isArray(bytes)) return String(bytes ?? '');
  return bytes.map((b) => (b == null ? '??' : b.toString(16).toUpperCase().padStart(2, '0'))).join(' ');
}

function hexByte(b) {
  return `0x${b.toString(16).toUpperCase().padStart(2, '0')}`;
}

function decodeAddress(b0) {
  if (b0 === 0xfe || b0 === 0xff) return { type: 'broadcast', label: 'broadcast' };
  if (b0 >= 0x80 && b0 <= 0x9f) {
    const n = (b0 & 0x1e) >> 1;
    return { type: 'group', label: `group${n}` };
  }
  if (b0 <= 0x7f) {
    const a = b0 >> 1;
    return { type: 'short', label: `short${a}` };
  }
  return null;
}

// An 8-bit answer follows its query closely; measured on the real bus the gap is
// 3–39 ms across 178 exchanges, so 200 ms is a generous ceiling.
const RESPONSE_WINDOW_MS = 200;

// Only the opcode ranges, never invented names for individual opcodes.
function opcodeCategory(opcode) {
  if (opcode <= 0x5f) return 'device';
  if (opcode >= 0x61 && opcode <= 0x68) return 'instance_write';
  if (opcode >= 0x80) return 'instance_query';
  return null;
}

// Special device commands. These are NOT addressed frames: byte0 selects the
// command class, and the operand order is reversed relative to an addressed
// command. For the one-parameter class (0xC1) byte1 chooses the command and byte2
// is its parameter -- so byte1 is a command selector, never an instance number.
const SPECIAL_ONE_PARAM = {
  0x00: { name: 'terminate' },
  0x01: { name: 'initialise', param: true },
  0x02: { name: 'randomise' },
  0x03: { name: 'compare', query: true },
  0x04: { name: 'withdraw' },
  0x05: { name: 'search_addrh', param: true },
  0x06: { name: 'search_addrm', param: true },
  0x07: { name: 'search_addrl', param: true },
  0x08: { name: 'program_short_address', param: true },
  0x09: { name: 'verify_short_address', param: true, query: true },
  0x0a: { name: 'query_short_address', query: true },
  0x20: { name: 'write_memory_location', param: true },
  0x21: { name: 'write_memory_location_no_reply', param: true },
  0x30: { name: 'dtr0', param: true },
  0x31: { name: 'dtr1', param: true },
  0x32: { name: 'dtr2', param: true },
  0x33: { name: 'send_testframe', param: true },
};

// Two-parameter class: byte1 and byte2 are BOTH data, so not even "byte1 selects
// the command" holds here.
const SPECIAL_TWO_PARAM = {
  0xc5: { name: 'direct_write_memory', fields: ['address', 'data'] },
  0xc7: { name: 'dtr1_dtr0', fields: ['dtr1', 'dtr0'] },
  0xc9: { name: 'dtr2_dtr1', fields: ['dtr2', 'dtr1'] },
};

// Event addressing schemes. Which one is in use is part of the CONTROLLER'S
// configuration (QueryEventScheme reports five: instance, device, device_instance,
// device_group, instance_group) and each lays out the frame header differently.
// Reading an address out of the wrong scheme manufactures devices that cannot
// exist -- short addresses only go up to 63 -- so an unrecognised header is left
// undecoded rather than given a plausible-looking address.
const INSTANCE_TYPES = { 0: 'generic', 1: 'pushButton', 2: 'absoluteInput' };

function decodeEventHeader(b0) {
  // device/instance addressing: byte0 is the device's short address. This is what
  // the installation currently runs.
  if (b0 <= 0x7f) return { scheme: 'device_instance', address: b0 >> 1 };
  // instance addressing (legacy): byte0 carries the instance TYPE, not an address.
  if (b0 >= 0x80 && b0 <= 0xbf) {
    const instanceType = INSTANCE_TYPES[(b0 & 0x3f) >> 1];
    return instanceType ? { scheme: 'instance', instanceType } : null;
  }
  return null;
}

// Colour-temperature DTR0/DTR1 state is stateful and deliberately never reset —
// the real device doesn't reset it either, so neither do we.
export function createDecoder() {
  let dtr0 = null;
  let dtr1 = null;
  let pendingQuery = null;

  function decode16(bytes) {
    const bytesStr = formatBytes(bytes);
    if (bytes.some((b) => b == null)) {
      return { kind: 'unknown', bits: 16, bytes: bytesStr };
    }
    const [b0, b1] = bytes;
    const s = b0 & 1;

    if (b0 === 0xa3) {
      dtr0 = b1;
      return { kind: 'raw', bits: 16, bytes: bytesStr };
    }
    if (b0 === 0xc3) {
      dtr1 = b1;
      return { kind: 'raw', bits: 16, bytes: bytesStr };
    }
    if (b0 === 0xc1) {
      return { kind: 'raw', bits: 16, bytes: bytesStr };
    }
    if (b0 === 0xa1 && b1 === 0x00) {
      // Assumed byte pattern for RESET (standard DALI-102 special command),
      // not confirmed against this gateway — see plan's "open items".
      return { kind: 'alert', alert: 'dali_reset', bits: 16, bytes: bytesStr };
    }

    const target = decodeAddress(b0);
    if (!target) {
      return { kind: 'unknown', bits: 16, bytes: bytesStr };
    }

    if (s === 0) {
      return { kind: 'level', target: target.label, level: b1, bits: 16, bytes: bytesStr };
    }

    if (b1 === 0xe7) {
      if (dtr0 == null || dtr1 == null) {
        return { kind: 'unknown', bits: 16, bytes: bytesStr };
      }
      const mired = (dtr1 << 8) | dtr0;
      const kelvin = Math.round(1_000_000 / mired);
      return { kind: 'colour', target: target.label, mired, kelvin, bits: 16, bytes: bytesStr };
    }

    return { kind: 'raw', target: target.label, bits: 16, bytes: bytesStr };
  }

  // Special commands are unaddressed and their operands run in the opposite order
  // to an addressed command, so they must be split off BEFORE byte1 is read as an
  // instance. `C1 30 FF` is a DTR0 write, not a command to "short96" instance 0x30.
  function decodeSpecial(b0, b1, b2, bytesStr, tsMs) {
    const two = SPECIAL_TWO_PARAM[b0];
    if (two) {
      const [f1, f2] = two.fields;
      // Register writes, never queries -- nothing answers them.
      return { kind: 'command', scope: 'special', command: two.name, values: { [f1]: b1, [f2]: b2 }, bits: 24, bytes: bytesStr };
    }

    const spec = SPECIAL_ONE_PARAM[b1];
    if (!spec) return { kind: 'unknown', bits: 24, bytes: bytesStr };

    // Only three commands in this family are questions (Compare, VerifyShortAddress,
    // QueryShortAddress) and they are sent during commissioning, not at run time.
    // Arming the response pairing on a register write would let a later, unrelated
    // answer be attributed to it.
    if (spec.query) pendingQuery = { special: spec.name, opcode: hexByte(b1), tsMs };

    const event = { kind: 'command', scope: 'special', command: spec.name, bits: 24, bytes: bytesStr };
    if (spec.param) event.value = b2;
    return event;
  }

  // Command frame: byte1 is the instance address, byte2 the opcode.
  function decodeCommand(target, b1, b2, bytesStr, tsMs) {
    let instance;
    if (b1 === 0xfe) instance = 'device'; // addressed to the device as a whole
    else if (b1 <= 0x1f) instance = b1;
    else return { kind: 'unknown', bits: 24, bytes: bytesStr };

    const category = opcodeCategory(b2);
    if (!category) return { kind: 'unknown', bits: 24, bytes: bytesStr };

    const opcode = hexByte(b2);
    // Any command MAY be answered, so remember it -- except a broadcast, which every
    // device would answer at once. Measured: no 8-bit frame ever follows a broadcast
    // in the capture, so arming one could only ever mis-attribute a later answer.
    if (target.address != null) {
      pendingQuery = { address: target.address, instance, opcode, tsMs };
    }

    const event = { kind: 'command', target: target.label, instance, opcode, category, bits: 24, bytes: bytesStr };
    if (target.address != null) event.address = target.address;
    return event;
  }

  function decode24(bytes, tsMs) {
    const bytesStr = formatBytes(bytes);
    if (bytes.some((b) => b == null)) {
      return { kind: 'unknown', bits: 24, bytes: bytesStr };
    }
    const [b0, b1, b2] = bytes;
    const s = b0 & 1;

    if (s === 1) {
      // Unaddressed special commands first: their operands are laid out in the
      // reverse order, so reading byte1 as an instance would misparse every one.
      // Only the byte0 values we have a documented layout for -- guessing at the
      // rest of the 0xA0-0xFB space would misparse frames in a new way instead.
      if (b0 === 0xc1 || SPECIAL_TWO_PARAM[b0]) return decodeSpecial(b0, b1, b2, bytesStr, tsMs);
      // S=1 is a command addressed TO a control device, not an event emitted BY one.
      // Running commands through the event decoder invents phantom button presses:
      // on the real bus `01 00 02` would otherwise read as a short press and toggle
      // a light. Commands are logged and never reach the control state machine.
      if (b0 <= 0x7f) return decodeCommand({ label: `short${b0 >> 1}`, address: b0 >> 1 }, b1, b2, bytesStr, tsMs);
      // Broadcast: the addressed layout, but with no single device to attribute an
      // answer to. Short addresses stop at 63, so `0xFF >> 1 = 127` would be a device
      // that cannot exist.
      if (b0 === 0xfd || b0 === 0xff) return decodeCommand({ label: 'broadcast', address: null }, b1, b2, bytesStr, tsMs);
      return { kind: 'unknown', bits: 24, bytes: bytesStr };
    }

    const header = decodeEventHeader(b0);
    if (!header) return { kind: 'unknown', bits: 24, bytes: bytesStr };

    // Event frames always set bit 7 of byte 1 (0x80 | instance<<2 | data high bits).
    // Anything else is not an event frame, whatever its payload looks like.
    if ((b1 & 0x80) === 0) {
      return { kind: 'unknown', bits: 24, bytes: bytesStr };
    }

    const data = ((b1 & 0x03) << 8) | b2;
    const base = { kind: 'inputEvent', scheme: header.scheme, bits: 24, bytes: bytesStr };

    if (header.scheme === 'device_instance') {
      // Only this scheme carries a device address, so only this scheme can drive a
      // light. byte1 holds the instance number within the device.
      base.target = `short${header.address}`;
      base.address = header.address;
      base.instance = (b1 & 0x7f) >> 2;
      base.instanceType = { 0: 'pushButton', 1: 'generic', 3: 'absoluteInput' }[base.instance];
    } else {
      // Instance addressing: the type comes from byte0 and there is no address at
      // all. Decoded so the log stays readable, but deliberately left without a
      // target so nothing downstream can mistake it for an addressable device.
      base.instanceType = header.instanceType;
    }

    if (!base.instanceType) return { kind: 'unknown', bits: 24, bytes: bytesStr };

    if (base.instanceType === 'absoluteInput') {
      base.value = data;
      return base;
    }
    const table = base.instanceType === 'pushButton' ? PUSH_BUTTON_EVENTS : GENERIC_EVENTS;
    const event = table[data];
    if (!event) return { kind: 'unknown', bits: 24, bytes: bytesStr };
    base.event = event;
    return base;
  }

  // 8-bit frames are answers to the last query put on the bus. We never query, so
  // these always belong to some other master (DALI Cockpit, the gateway's own
  // startup scan) — pairing them with the query makes the exchange readable.
  function decode8(bytes, tsMs) {
    const bytesStr = formatBytes(bytes);
    if (bytes.some((b) => b == null)) {
      return { kind: 'unknown', bits: 8, bytes: bytesStr };
    }
    const value = bytes[0];

    if (pendingQuery && tsMs - pendingQuery.tsMs <= RESPONSE_WINDOW_MS) {
      const { tsMs: _t, ...to } = pendingQuery;
      // One query, one answer: consume it so a second frame can't claim it too.
      pendingQuery = null;
      return { kind: 'response', to, value, bits: 8, bytes: bytesStr };
    }

    pendingQuery = null;
    return { kind: 'orphan_response', value, bits: 8, bytes: bytesStr };
  }

  function decodeFrame(bits, bytes, tsMs = Date.now()) {
    // A malformed message must not end the capture session: this is a live debugging
    // tool, and losing the run to one unexpected frame costs more than the frame did.
    if (!Array.isArray(bytes)) return { kind: 'unknown', bits, bytes: formatBytes(bytes) };
    if (bits === 8) return decode8(bytes, tsMs);
    if (bits === 16) return decode16(bytes);
    if (bits === 24) return decode24(bytes, tsMs);
    return { kind: 'unknown', bits, bytes: formatBytes(bytes) };
  }

  return { decodeFrame };
}
