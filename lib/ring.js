// Fixed-size buffer of recent events, for the live view.
//
// The UI must never be able to affect the wall switches, and the cheapest way
// to guarantee that is to give it nothing that can grow: a fixed number of
// slots, overwritten oldest-first, with a monotonic sequence number so a client
// can say "everything since 4021" and be told honestly when the answer is
// "I no longer have that far back".

export function createRing(capacity = 2000) {
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacity must be a positive integer');

  const slots = new Array(capacity);
  let seq = 0; // sequence of the most recent event; 0 means nothing yet

  function push(event) {
    seq += 1;
    slots[(seq - 1) % capacity] = { seq, event };
    return seq;
  }

  const oldestSeq = () => Math.max(1, seq - capacity + 1);

  // Everything after `since`. `dropped` is how many events fell out of the
  // buffer before the caller got to them -- the UI shows that as a gap rather
  // than pretending the stream was continuous.
  function since(afterSeq = 0, { kinds = null, target = null, limit = 500 } = {}) {
    const from = Number.isFinite(afterSeq) ? Math.max(0, Math.floor(afterSeq)) : 0;
    const oldest = oldestSeq();
    const dropped = seq === 0 ? 0 : Math.max(0, oldest - 1 - from);

    const out = [];
    for (let s = Math.max(from + 1, oldest); s <= seq; s++) {
      const slot = slots[(s - 1) % capacity];
      if (!slot || slot.seq !== s) continue;
      const e = slot.event;
      if (kinds && !kinds.has(e.kind)) continue;
      if (target && e.target !== target) continue;
      out.push({ seq: s, ...e });
    }

    // Newest wins when the caller asks for fewer than we have.
    const events = out.length > limit ? out.slice(out.length - limit) : out;
    return { events, seq, dropped, capacity };
  }

  return {
    push,
    since,
    seq: () => seq,
    size: () => Math.min(seq, capacity),
    capacity,
  };
}
