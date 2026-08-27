import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUiServer } from '../lib/ui/server.js';
import { createRing } from '../lib/ring.js';
import { createHealth } from '../lib/health.js';

async function harness(options = {}) {
  const ring = createRing(50);
  const health = createHealth({ version: '0.3.0' });
  const logs = [];
  const pub = await fsp.mkdtemp(path.join(os.tmpdir(), 'dali-ui-'));
  fs.writeFileSync(path.join(pub, 'index.html'), '<h1>DALI</h1>');

  const ui = createUiServer({ port: 0, bind: '127.0.0.1', ring, health, publicDir: pub,
    log: (e) => logs.push(e), ...options });
  const port = await ui.start();
  const base = `http://127.0.0.1:${port}`;

  return {
    ui, ring, health, logs, base,
    get: (p, init) => fetch(base + p, init),
    async cleanup() { await ui.stop(); await fsp.rm(pub, { recursive: true, force: true }); },
  };
}

test('the watchdog endpoint reports our liveness and nothing else', async () => {
  const h = await harness();
  const body = await (await h.get('/api/alive')).json();
  assert.equal(body.ok, true);
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'uptime_s', 'version']);
  await h.cleanup();
});

test('the watchdog stays healthy when the gateway and HA are down', async () => {
  // If it did not, the Supervisor would restart us -- fixing neither, and
  // costing wall-switch availability to do it.
  const h = await harness({
    ha: { isDown: () => true },
    liveness: { snapshot: () => ({ reachable: false, probeFailures: 99 }) },
  });
  const res = await h.get('/api/alive');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);

  const full = await (await h.get('/api/health')).json();
  assert.equal(full.gateway.reachable, false, 'the Health page still tells the truth');
  assert.equal(full.home_assistant.reachable, false);
  await h.cleanup();
});

test('health merges what each subsystem owns', async () => {
  const h = await harness({
    liveness: { snapshot: () => ({ reachable: true, version: 'v1.18.7/1.4.6' }) },
    store: { usage: async () => ({ files: 3, bytes: 4096 }), stats: () => ({ paused: false, dropped: 0 }) },
  });
  const body = await (await h.get('/api/health')).json();
  assert.equal(body.gateway.version, 'v1.18.7/1.4.6');
  assert.equal(body.logs.files, 3);
  assert.equal(body.logs.paused, false);
  assert.equal(body.version, '0.3.0');
  await h.cleanup();
});

test('recent events can be resumed, filtered and limited', async () => {
  const h = await harness();
  h.ring.push({ kind: 'level', target: 'short0', level: 1 });
  h.ring.push({ kind: 'alert', alert: 'boom' });
  h.ring.push({ kind: 'level', target: 'short7', level: 2 });

  const all = await (await h.get('/api/recent')).json();
  assert.equal(all.events.length, 3);
  assert.equal(all.seq, 3);

  const resumed = await (await h.get('/api/recent?since=2')).json();
  assert.deepEqual(resumed.events.map((e) => e.seq), [3]);

  const alerts = await (await h.get('/api/recent?kinds=alert')).json();
  assert.equal(alerts.events.length, 1);

  const one = await (await h.get('/api/recent?target=short7')).json();
  assert.equal(one.events[0].level, 2);
  await h.cleanup();
});

test('the live stream sends a backlog then pushes new events', async () => {
  const h = await harness();
  h.ring.push({ kind: 'level', level: 41 });

  const res = await h.get('/api/events');
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const readUntil = async (needle) => {
    const deadline = Date.now() + 4000;
    while (!buf.includes(needle)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle} in: ${buf}`);
      const { value } = await reader.read();
      buf += decoder.decode(value ?? new Uint8Array(), { stream: true });
    }
  };

  await readUntil('event: backlog');
  assert.match(buf, /"level":41/, 'a viewer arriving late still sees what just happened');

  h.ui.broadcast(2, { kind: 'inputEvent', instanceType: 'generic', event: 'start_right' });
  await readUntil('start_right');

  await reader.cancel();
  await h.cleanup();
});

test('a stream client filters server-side, so a busy bus stays cheap', async () => {
  const h = await harness();
  const res = await h.get('/api/events?kinds=alert');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  h.ui.broadcast(1, { kind: 'level', level: 99 });
  h.ui.broadcast(2, { kind: 'alert', alert: 'the_one_i_want' });

  const deadline = Date.now() + 4000;
  while (!buf.includes('the_one_i_want')) {
    if (Date.now() > deadline) throw new Error('timed out');
    const { value } = await reader.read();
    buf += decoder.decode(value ?? new Uint8Array(), { stream: true });
  }
  assert.doesNotMatch(buf, /"level":99/, 'filtered kinds never reach the wire');

  await reader.cancel();
  await h.cleanup();
});

test('too many live viewers is refused rather than unbounded', async () => {
  const h = await harness({ maxClients: 2 });
  const a = await h.get('/api/events');
  const b = await h.get('/api/events');
  const c = await h.get('/api/events');
  assert.equal(c.status, 503);

  await a.body.cancel();
  await b.body.cancel();
  await c.body?.cancel?.();
  await h.cleanup();
});

test('broadcast never throws into the caller, whatever the client does', async () => {
  // It is called from the frame handler. A viewer with a broken socket must not
  // be able to take the bridge down.
  const h = await harness();
  const res = await h.get('/api/events');
  await res.body.cancel();
  await new Promise((r) => setTimeout(r, 50));
  assert.doesNotThrow(() => h.ui.broadcast(1, { kind: 'level', level: 1 }));
  await h.cleanup();
});

test('static files are served, and traversal is refused', async () => {
  const h = await harness();
  assert.equal(await (await h.get('/')).text(), '<h1>DALI</h1>');
  assert.equal((await h.get('/')).headers.get('content-type'), 'text/html; charset=utf-8');

  for (const attempt of ['/../../../etc/passwd', '/..%2f..%2fetc/passwd']) {
    const res = await h.get(attempt);
    assert.ok(res.status === 403 || res.status === 404, `${attempt} gave ${res.status}`);
  }
  await h.cleanup();
});

test('mutations need the guard header, which a cross-origin form cannot set', async () => {
  const h = await harness();
  const bare = await h.get('/api/devices', { method: 'PUT', body: '{}' });
  assert.equal(bare.status, 403);
  assert.match((await bare.json()).error, /x-dali-ui/);
  await h.cleanup();
});

test('only the ingress proxy may connect when allowFrom is set', async () => {
  const h = await harness({ allowFrom: '172.30.32.2' });
  const res = await h.get('/api/alive');
  assert.equal(res.status, 403, 'we are not the Supervisor, so we are refused');
  await h.cleanup();
});

test('an unknown API path is a 404, not a static file miss', async () => {
  const h = await harness();
  const res = await h.get('/api/nope');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'no such endpoint');
  await h.cleanup();
});

// --- commissioning ----------------------------------------------------------

function fakeDevices(initial = {}) {
  let map = { ...initial };
  let problems = [];
  return {
    file: '/config/devices.json',
    get: () => map,
    problems: () => problems,
    async save(next) {
      if (!next || typeof next !== 'object' || Array.isArray(next)) {
        return { ok: false, problems: ['not an object'], map: null };
      }
      map = next;
      problems = [];
      return { ok: true, problems, map };
    },
  };
}

test('the commissioning page gets the map and everything seen on the bus', async () => {
  const census = {
    list: () => ({
      devices: [{ address: 6, target: 'short6', frames: 12, last_seen_age_s: 1, last_event: 'start_right' }],
      gear: [{ target: 'short11', addressable: true, frames: 4, last_level: 128 }],
    }),
  };
  const h = await harness({ census, devices: fakeDevices({ 6: { entity: 'light.bedroom' } }) });

  const body = await (await h.get('/api/devices')).json();
  assert.equal(body.map['6'].entity, 'light.bedroom');
  assert.equal(body.seen.devices[0].address, 6);
  assert.equal(body.seen.devices[0].last_event, 'start_right', 'so the row can light up as you turn it');
  assert.equal(body.seen.gear[0].target, 'short11');
  assert.equal(body.file, '/config/devices.json', 'and where to edit it by hand');
  await h.cleanup();
});

test('the entity picker lists lights from Home Assistant', async () => {
  const h = await harness({
    ha: {
      isDown: () => false,
      listLights: async () => [{ entity_id: 'light.bedroom', name: 'Bedroom', supports_color_temp: true }],
    },
  });
  const body = await (await h.get('/api/entities')).json();
  assert.equal(body.lights[0].entity_id, 'light.bedroom');
  assert.equal(body.reachable, true);
  await h.cleanup();
});

test('an unreachable Home Assistant gives an empty picker, not a broken page', async () => {
  const h = await harness({ ha: { isDown: () => true, listLights: async () => [] } });
  const body = await (await h.get('/api/entities')).json();
  assert.deepEqual(body.lights, []);
  assert.equal(body.reachable, false, 'and the page can say why it is empty');
  await h.cleanup();
});

test('saving the map goes through validation and reports what it rejected', async () => {
  const h = await harness({ devices: fakeDevices() });

  const ok = await h.get('/api/devices', {
    method: 'PUT',
    headers: { 'x-dali-ui': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ 6: { entity: 'light.bedroom' } }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).map['6'].entity, 'light.bedroom');

  const bad = await h.get('/api/devices', {
    method: 'PUT',
    headers: { 'x-dali-ui': '1' },
    body: '[1,2,3]',
  });
  assert.equal(bad.status, 400);
  await h.cleanup();
});

test('a malformed body is a clear 400, not a stack trace', async () => {
  const h = await harness({ devices: fakeDevices() });
  const res = await h.get('/api/devices', {
    method: 'PUT', headers: { 'x-dali-ui': '1' }, body: '{ not json',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not valid JSON/);
  await h.cleanup();
});

test('an oversized body is refused rather than buffered', async () => {
  // This runs in the process that drives the wall switches; an unbounded read
  // here would be a way to grow its memory from outside.
  const h = await harness({ devices: fakeDevices() });
  const res = await h.get('/api/devices', {
    method: 'PUT', headers: { 'x-dali-ui': '1' }, body: 'x'.repeat(400 * 1024),
  }).catch((err) => ({ status: 0, err }));
  assert.notEqual(res.status, 200);
  await h.cleanup();
});

test('saving without a device map configured says so', async () => {
  const h = await harness();
  const res = await h.get('/api/devices', {
    method: 'PUT', headers: { 'x-dali-ui': '1' }, body: '{}',
  });
  assert.equal(res.status, 503);
  await h.cleanup();
});
