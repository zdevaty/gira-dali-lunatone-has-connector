import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecoder } from '../lib/decoder.js';

function hex(str) {
  return str.split(' ').map((b) => (b === '??' ? null : parseInt(b, 16)));
}

test('broadcast level frames (knob turned back and forth)', () => {
  const decoder = createDecoder();
  const frames = ['FE FE', 'FE E5', 'FE AE', 'FE 77', 'FE 40', 'FE 1F', 'FE 38', 'FE 6F', 'FE A6', 'FE DD', 'FE FE'];
  const expectedLevels = [254, 229, 174, 119, 64, 31, 56, 111, 166, 221, 254];

  frames.forEach((frame, i) => {
    const event = decoder.decodeFrame(16, hex(frame));
    assert.equal(event.kind, 'level');
    assert.equal(event.target, 'broadcast');
    assert.equal(event.level, expectedLevels[i]);
    assert.equal(event.bytes, frame);
  });
});

test('colour temperature sequence produces exactly one colour event with correct mired/kelvin', () => {
  const decoder = createDecoder();
  const sequence = ['A3 76', 'C3 00', 'C1 08', 'FF E7', 'FE 1F'];
  const events = sequence.map((frame) => decoder.decodeFrame(16, hex(frame)));

  assert.deepEqual(events.map((e) => e.kind), ['raw', 'raw', 'raw', 'colour', 'level']);
  const colourEvents = events.filter((e) => e.kind === 'colour');
  assert.equal(colourEvents.length, 1);
  assert.equal(colourEvents[0].mired, 118);
  assert.equal(colourEvents[0].kelvin, 8475);
  assert.equal(colourEvents[0].target, 'broadcast');

  const levelEvent = events.find((e) => e.kind === 'level');
  assert.equal(levelEvent.level, 31);
});

test('colour temperature sequences, stuck at limit (three consecutive bursts)', () => {
  const decoder = createDecoder();
  const cases = [
    { seq: ['A3 76', 'C3 00', 'C1 08', 'FF E7', 'FE 1F'], mired: 118, kelvin: 8475 },
    { seq: ['A3 64', 'C3 00', 'C1 08', 'FF E7', 'FE 1F'], mired: 100, kelvin: 10000 },
    { seq: ['A3 65', 'C3 00', 'C1 08', 'FF E7', 'FE 1F'], mired: 101, kelvin: 9901 },
  ];

  for (const { seq, mired, kelvin } of cases) {
    const events = seq.map((frame) => decoder.decodeFrame(16, hex(frame)));
    const colourEvents = events.filter((e) => e.kind === 'colour');
    assert.equal(colourEvents.length, 1);
    assert.equal(colourEvents[0].mired, mired);
    assert.equal(colourEvents[0].kelvin, kelvin);
  }
});

test('DTR0/DTR1 state is never reset between sequences', () => {
  // The second and third sequences above only resend DTR0 (mired changes) and rely
  // on DTR1 staying at 0 from the first sequence's C3 00 — covered implicitly by the
  // test above, but assert it explicitly for a decoder that skips the C3 frame.
  const decoder = createDecoder();
  decoder.decodeFrame(16, hex('C3 00')); // DTR1 = 0
  decoder.decodeFrame(16, hex('A3 64')); // DTR0 = 0x64
  const event = decoder.decodeFrame(16, hex('FF E7'));
  assert.equal(event.kind, 'colour');
  assert.equal(event.mired, 100);
  assert.equal(event.kelvin, 10000);
});

test('instance addressing (legacy scheme) yields no device address', () => {
  const decoder = createDecoder();
  // These fixtures were captured while the controller was set to *instance*
  // addressing. In that scheme byte0 carries the instance TYPE (0x80 | type << 1),
  // not an address -- so `82 >> 1 = 65` and `84 >> 1 = 66` are not devices but the
  // addressed-scheme rule misapplied to a differently shaped frame. Short addresses
  // stop at 63, so a "short65" is always a decoding error rather than a discovery.
  const press = decoder.decodeFrame(24, hex('82 80 02'));
  assert.equal(press.kind, 'inputEvent');
  assert.equal(press.scheme, 'instance');
  assert.equal(press.instanceType, 'pushButton');
  assert.equal(press.event, 'short_press');
  assert.equal(press.address, undefined, 'instance addressing carries no address');
  assert.equal(press.target, undefined, 'and so has no device to name');

  const turnRight = ['80 84 00', '84 8C 08', '80 84 02'].map((f) => decoder.decodeFrame(24, hex(f)));
  assert.equal(turnRight[0].instanceType, 'generic');
  assert.equal(turnRight[0].event, 'start_right');
  assert.equal(turnRight[1].instanceType, 'absoluteInput');
  assert.equal(turnRight[1].value, 8);
  assert.equal(turnRight[2].event, 'stop');
  assert.ok(turnRight.every((e) => e.scheme === 'instance' && e.address === undefined));

  const turnLeft = ['80 84 01', '84 8C 07', '80 84 02'].map((f) => decoder.decodeFrame(24, hex(f)));
  assert.equal(turnLeft[0].event, 'start_left');
  assert.equal(turnLeft[1].value, 7);
  assert.equal(turnLeft[2].event, 'stop');
});

test('the current scheme (device/instance) is what carries an address', () => {
  const decoder = createDecoder();
  // Same three gestures after the controller was switched to device/instance
  // addressing -- the layout the installation runs today.
  const press = decoder.decodeFrame(24, hex('00 80 02'));
  assert.equal(press.scheme, 'device_instance');
  assert.equal(press.address, 0);
  assert.equal(press.target, 'short0');
  assert.equal(press.instanceType, 'pushButton');
  assert.equal(press.event, 'short_press');

  const turn = decoder.decodeFrame(24, hex('00 84 00'));
  assert.equal(turn.instanceType, 'generic');
  assert.equal(turn.event, 'start_right');
  assert.equal(turn.address, 0);
});

test('command frames (S=1) are never decoded as input events', () => {
  const decoder = createDecoder();
  // Captured commands that previously decoded as pressed/short_press/long_stop/
  // long_repeat. `01 00 02` reading as a short press would have toggled a light.
  for (const frame of ['01 00 01', '01 00 02', '01 00 0C', '01 00 0B', 'C7 00 01', '01 02 46']) {
    const event = decoder.decodeFrame(24, hex(frame), 1000);
    assert.notEqual(event.kind, 'inputEvent', `${frame} must not decode as an input event`);
    assert.equal(event.kind, 'command');
    assert.equal(event.bytes, frame);
  }
  // A query on instance 1 or 3 is the dangerous case: those are the rotation
  // instances, so misreading one as an event would look like knob movement.
  const query = decoder.decodeFrame(24, hex('01 01 8C'), 1000);
  assert.equal(query.kind, 'command');
  assert.equal(query.instance, 1);
});

test('event frames must have bit 7 set in byte 1', () => {
  const decoder = createDecoder();
  // Even address byte (S=0) but byte1 lacks the 0x80 marker: not an event frame.
  const event = decoder.decodeFrame(24, hex('00 00 01'));
  assert.equal(event.kind, 'unknown');
});

test('captured button released (00 80 00) decodes, despite the spec saying Gira never sends it', () => {
  const decoder = createDecoder();
  const event = decoder.decodeFrame(24, hex('00 80 00'));
  assert.equal(event.kind, 'inputEvent');
  assert.equal(event.event, 'released');
});

test('unmapped push-button opcodes seen on the bus decode as unknown, not as a wrong event', () => {
  const decoder = createDecoder();
  for (const frame of ['00 80 0F', '00 80 0E']) {
    const event = decoder.decodeFrame(24, hex(frame));
    assert.equal(event.kind, 'unknown', `${frame} is an unmapped opcode and must stay unknown`);
    assert.equal(event.bytes, frame);
  }
});

test('startup scan decodes as command/response pairs with nothing left unknown', () => {
  const decoder = createDecoder();
  // Real startup enumeration from logs/dali-2026-08-25.jsonl: the gateway queries
  // the device as a whole, then instance 1, then instance 0.
  const exchange = [
    ['24', '01 FE 30', '8', '2A'],
    ['24', '01 01 8C', '8', '00'],
    ['24', '01 00 86', '8', 'FF'],
  ];

  let ts = 1_000_000;
  const events = [];
  for (const [, cmdFrame, , respFrame] of exchange) {
    events.push(decoder.decodeFrame(24, hex(cmdFrame), (ts += 10)));
    events.push(decoder.decodeFrame(8, hex(respFrame), (ts += 15)));
  }

  assert.equal(events.filter((e) => e.kind === 'unknown').length, 0, 'no line may stay unknown');
  assert.deepEqual(
    events.map((e) => e.kind),
    ['command', 'response', 'command', 'response', 'command', 'response'],
  );

  // Device-wide command, opcode in the device range.
  assert.deepEqual(
    { instance: events[0].instance, opcode: events[0].opcode, category: events[0].category, address: events[0].address },
    { instance: 'device', opcode: '0x30', category: 'device', address: 0 },
  );
  assert.equal(events[1].value, 0x2a);

  // Matches the worked example in the spec exactly.
  assert.deepEqual(events[3], {
    kind: 'response',
    to: { address: 0, instance: 1, opcode: '0x8C' },
    value: 0,
    bits: 8,
    bytes: '00',
  });
  assert.equal(events[2].category, 'instance_query');
  assert.equal(events[4].instance, 0);
  assert.equal(events[5].value, 255);
});

test('the addendum startup fixture leaves no line unknown', () => {
  const decoder = createDecoder();
  // Verbatim from the addendum: the gateway probing the bus at 06:53:52. Note the
  // spec's wording says "three pairs", but the excerpt holds four queries and only
  // two answers -- the last two were cut off mid-exchange. What it actually asserts
  // is the part that matters: not one of these six lines may stay `unknown`.
  const fixture = [
    [24, '01 01 8C'],
    [8, '00'],
    [24, '01 02 8C'],
    [8, '00'],
    [24, '01 01 8D'],
    [24, '01 02 8D'],
  ];

  let ts = 1_000_000;
  const events = fixture.map(([bits, frame]) => decoder.decodeFrame(bits, hex(frame), (ts += 12)));

  assert.equal(events.filter((e) => e.kind === 'unknown').length, 0, 'no line may stay unknown');
  assert.deepEqual(
    events.map((e) => e.kind),
    ['command', 'response', 'command', 'response', 'command', 'command'],
  );

  // Instance 2 is queried alongside instance 1 -- an instance number we have never
  // seen emit an event. It decodes as a command regardless, which is the point:
  // the decoder reads the S bit, not a whitelist of instances it recognises.
  assert.deepEqual(
    events.map((e) => (e.kind === 'command' ? `${e.instance}/${e.opcode}` : `=${e.value}`)),
    ['1/0x8C', '=0', '2/0x8C', '=0', '1/0x8D', '2/0x8D'],
  );
  assert.ok(events.every((e) => e.kind !== 'command' || e.category === 'instance_query'));

  // The unanswered query at the end must not linger and adopt a later, unrelated
  // answer: 0x8D was over 200 ms ago by the time this arrives.
  const stale = decoder.decodeFrame(8, hex('42'), ts + 500);
  assert.equal(stale.kind, 'orphan_response');
});

test('opcode ranges are categorised, and gaps between them stay unknown', () => {
  const decoder = createDecoder();
  const category = (opcode) => decoder.decodeFrame(24, [0x01, 0x00, opcode], 1000);
  assert.equal(category(0x00).category, 'device');
  assert.equal(category(0x5f).category, 'device');
  assert.equal(category(0x61).category, 'instance_write');
  assert.equal(category(0x68).category, 'instance_write');
  assert.equal(category(0x80).category, 'instance_query');
  assert.equal(category(0xff).category, 'instance_query');
  // 0x60 and 0x69–0x7F are not described; never invent a name for them.
  assert.equal(category(0x60).kind, 'unknown');
  assert.equal(category(0x69).kind, 'unknown');
  assert.equal(category(0x7f).kind, 'unknown');
});

test('special commands are decoded by their own layout, not as instance/opcode', () => {
  const decoder = createDecoder();
  // Seen on the real bus 80 times. byte1 is a command SELECTOR here, not an instance,
  // and byte2 is its parameter -- the reverse of an addressed command's operand order.
  // Read with the addressed-command rule this is "short96, instance 0x30", a device
  // that cannot exist: short addresses stop at 63.
  const dtr0 = decoder.decodeFrame(24, hex('C1 30 FF'), 1000);
  assert.deepEqual(dtr0, { kind: 'command', scope: 'special', command: 'dtr0', value: 0xff, bits: 24, bytes: 'C1 30 FF' });
  assert.equal(dtr0.address, undefined, 'a special command is unaddressed');

  assert.equal(decoder.decodeFrame(24, hex('C1 31 00'), 1000).command, 'dtr1');
  assert.equal(decoder.decodeFrame(24, hex('C1 32 00'), 1000).command, 'dtr2');

  // Commands with no parameter carry no value at all.
  const terminate = decoder.decodeFrame(24, hex('C1 00 00'), 1000);
  assert.equal(terminate.command, 'terminate');
  assert.equal(terminate.value, undefined);

  // Two-parameter class: byte1 and byte2 are BOTH data, so even "byte1 selects the
  // command" is wrong here.
  const both = decoder.decodeFrame(24, hex('C7 00 01'), 1000);
  assert.deepEqual(both, { kind: 'command', scope: 'special', command: 'dtr1_dtr0', values: { dtr1: 0, dtr0: 1 }, bits: 24, bytes: 'C7 00 01' });

  // An unknown selector still stays unknown rather than being given a name.
  assert.equal(decoder.decodeFrame(24, hex('C1 7E 00'), 1000).kind, 'unknown');
});

test('only genuine special-command queries arm the response pairing', () => {
  const decoder = createDecoder();
  // A DTR0 write is not a question; an 8-bit frame after it belongs to nobody.
  decoder.decodeFrame(24, hex('C1 30 FF'), 1000);
  assert.equal(decoder.decodeFrame(8, hex('2A'), 1010).kind, 'orphan_response');

  // QueryShortAddress is a question, so its answer is paired.
  decoder.decodeFrame(24, hex('C1 0A 00'), 2000);
  const answer = decoder.decodeFrame(8, hex('2A'), 2010);
  assert.equal(answer.kind, 'response');
  assert.deepEqual(answer.to, { special: 'query_short_address', opcode: '0x0A' });
});

test('a response with no preceding query is an orphan_response and throws nothing', () => {
  const decoder = createDecoder();
  const event = decoder.decodeFrame(8, hex('FF'), 1000);
  assert.equal(event.kind, 'orphan_response');
  assert.equal(event.value, 255);
  assert.equal(event.bytes, 'FF');
});

test('a response arriving more than 200ms after its query is an orphan', () => {
  const decoder = createDecoder();
  decoder.decodeFrame(24, hex('01 01 8C'), 1000);
  const late = decoder.decodeFrame(8, hex('00'), 1000 + 201);
  assert.equal(late.kind, 'orphan_response');

  // ...and inside the window it pairs.
  decoder.decodeFrame(24, hex('01 01 8C'), 2000);
  const intime = decoder.decodeFrame(8, hex('00'), 2000 + 200);
  assert.equal(intime.kind, 'response');
});

test('one query answers exactly one response; a second frame is an orphan', () => {
  const decoder = createDecoder();
  decoder.decodeFrame(24, hex('01 01 8C'), 1000);
  assert.equal(decoder.decodeFrame(8, hex('00'), 1010).kind, 'response');
  assert.equal(decoder.decodeFrame(8, hex('00'), 1020).kind, 'orphan_response');
});

test('unknown frame does not throw and is logged with raw bytes', () => {
  const decoder = createDecoder();
  const event = decoder.decodeFrame(16, hex('E1 42'));
  assert.equal(event.kind, 'unknown');
  assert.equal(event.bytes, 'E1 42');
});

test('null bytes (undetected gateway response) decode to unknown, never throw', () => {
  const decoder = createDecoder();
  const event = decoder.decodeFrame(16, hex('?? 08'));
  assert.equal(event.kind, 'unknown');
  assert.equal(event.bytes, '?? 08');
});

test('unrecognized bit length decodes to unknown', () => {
  const decoder = createDecoder();
  const event = decoder.decodeFrame(32, [0x01, 0x02, 0x03, 0x04]);
  assert.equal(event.kind, 'unknown');
  assert.equal(event.bits, 32);
});
