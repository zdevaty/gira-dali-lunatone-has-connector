import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRing } from '../lib/ring.js';

const ev = (kind, extra = {}) => ({ kind, ...extra });

test('events come back in order with their sequence numbers', () => {
  const ring = createRing(10);
  ring.push(ev('level', { level: 1 }));
  ring.push(ev('level', { level: 2 }));
  const { events, seq } = ring.since(0);
  assert.deepEqual(events.map((e) => e.level), [1, 2]);
  assert.deepEqual(events.map((e) => e.seq), [1, 2]);
  assert.equal(seq, 2);
});

test('a client resumes from where it left off', () => {
  const ring = createRing(10);
  for (let i = 1; i <= 5; i++) ring.push(ev('level', { level: i }));
  const first = ring.since(0);
  ring.push(ev('level', { level: 6 }));
  const next = ring.since(first.seq);
  assert.deepEqual(next.events.map((e) => e.level), [6]);
});

test('the buffer is bounded and says how much it dropped', () => {
  const ring = createRing(4);
  for (let i = 1; i <= 10; i++) ring.push(ev('level', { level: i }));
  assert.equal(ring.size(), 4, 'never grows past capacity');

  const { events, dropped } = ring.since(0);
  assert.deepEqual(events.map((e) => e.level), [7, 8, 9, 10], 'oldest overwritten first');
  assert.equal(dropped, 6, 'the gap is reported, not papered over');
});

test('a client that kept up is told nothing was dropped', () => {
  const ring = createRing(4);
  for (let i = 1; i <= 4; i++) ring.push(ev('level'));
  assert.equal(ring.since(3).dropped, 0);
});

test('filtering by kind and target', () => {
  const ring = createRing(10);
  ring.push(ev('level', { target: 'short0' }));
  ring.push(ev('alert', { target: 'short0' }));
  ring.push(ev('level', { target: 'short7' }));

  assert.equal(ring.since(0, { kinds: new Set(['alert']) }).events.length, 1);
  assert.equal(ring.since(0, { target: 'short7' }).events.length, 1);
  assert.equal(ring.since(0, { kinds: new Set(['level']), target: 'short0' }).events.length, 1);
});

test('a limit keeps the newest, not the oldest', () => {
  const ring = createRing(100);
  for (let i = 1; i <= 50; i++) ring.push(ev('level', { level: i }));
  const { events } = ring.since(0, { limit: 5 });
  assert.deepEqual(events.map((e) => e.level), [46, 47, 48, 49, 50]);
});

test('an empty ring is not a special case for callers', () => {
  const ring = createRing(10);
  assert.deepEqual(ring.since(0), { events: [], seq: 0, dropped: 0, capacity: 10 });
});

test('a nonsense cursor does not throw', () => {
  const ring = createRing(4);
  ring.push(ev('level'));
  for (const bad of [-5, NaN, Infinity, undefined, 'abc']) {
    assert.doesNotThrow(() => ring.since(bad));
  }
});
