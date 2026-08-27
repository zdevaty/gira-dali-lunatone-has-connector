// The web UI's server.
//
// Rules that keep this away from the wall switches, because it shares a process
// with them:
//   - it reads snapshots and never touches gesture state;
//   - every handler is wrapped, so a bug here cannot reach the frame path;
//   - no synchronous filesystem work, ever;
//   - the SSE client list is capped and slow consumers are dropped, not buffered.
//
// Authentication is deliberately absent under ingress: Home Assistant has
// already authenticated whoever reaches us, and the Supervisor is the only thing
// that can reach the port at all. That last part is enforced here rather than
// assumed -- `allowFrom` rejects anything not coming from the ingress proxy.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// Mutating requests must carry this. A cross-origin <form> cannot set a custom
// header, and a cross-origin fetch that sets one triggers a preflight we never
// answer -- so this is the whole CSRF story, with no tokens to manage.
const GUARD_HEADER = 'x-dali-ui';

export function createUiServer({
  port = 8099,
  bind = '0.0.0.0',
  allowFrom = null,
  ring,
  health,
  liveness = null,
  store = null,
  ha = null,
  census = null,
  devices = null,
  publicDir = path.join(HERE, 'public'),
  log = () => {},
  maxClients = 8,
  heartbeatMs = 15_000,
  maxBacklogBytes = 1 << 20,
} = {}) {
  if (!ring || !health) throw new Error('createUiServer requires ring and health');

  const clients = new Set();
  let server = null;
  let heartbeat = null;
  let usageCache = { at: 0, value: null };

  const json = (res, code, body) => {
    const text = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(text);
  };

  // Only the ingress proxy may talk to us. Under ingress this is also the CSRF
  // boundary: a browser cannot reach this port directly at all.
  function permitted(req) {
    if (!allowFrom) return true;
    const peer = req.socket?.remoteAddress ?? '';
    return peer === allowFrom || peer === `::ffff:${allowFrom}`;
  }

  async function serveStatic(req, res, urlPath) {
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const full = path.join(publicDir, rel);
    // Traversal guard: resolve first, then prove it stayed inside.
    if (!path.resolve(full).startsWith(path.resolve(publicDir) + path.sep)) {
      return json(res, 403, { error: 'forbidden' });
    }
    try {
      const body = await fs.readFile(full);
      res.writeHead(200, {
        'content-type': TYPES[path.extname(full)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      res.end(body);
    } catch {
      json(res, 404, { error: 'not found' });
    }
  }

  async function usage() {
    if (!store) return null;
    // Cheap enough hourly, too expensive per request: the sweep stats a whole
    // directory, and the Health page polls.
    if (Date.now() - usageCache.at < 30_000) return usageCache.value;
    try {
      usageCache = { at: Date.now(), value: await store.usage() };
    } catch {
      usageCache = { at: Date.now(), value: null };
    }
    return usageCache.value;
  }

  async function fullHealth() {
    return health.snapshot({
      gateway: liveness ? liveness.snapshot() : null,
      home_assistant: ha ? { reachable: !ha.isDown() } : null,
      logs: { ...(await usage()), ...(store ? store.stats() : {}) },
    });
  }

  function parseKinds(value) {
    if (!value) return null;
    const set = new Set(String(value).split(',').map((s) => s.trim()).filter(Boolean));
    return set.size ? set : null;
  }

  function openStream(req, res) {
    if (clients.size >= maxClients) return json(res, 503, { error: 'too many live viewers' });

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Belt and braces against a proxy that buffers; ingress_stream handles the
      // Supervisor's side.
      'x-accel-buffering': 'no',
    });

    const url = new URL(req.url, 'http://localhost');
    const client = {
      res,
      kinds: parseKinds(url.searchParams.get('kinds')),
      target: url.searchParams.get('target') || null,
    };
    clients.add(client);

    res.write('retry: 2000\n\n');
    const backlog = ring.since(Number(url.searchParams.get('since') ?? 0), {
      kinds: client.kinds, target: client.target, limit: 200,
    });
    res.write(`event: backlog\ndata: ${JSON.stringify(backlog)}\n\n`);

    const drop = () => {
      clients.delete(client);
      try { res.end(); } catch { /* already gone */ }
    };
    req.on('close', drop);
    req.on('error', drop);
  }

  // Called for every emitted event. Must be cheap and must never throw into the
  // frame path that calls it.
  function broadcast(seq, event) {
    if (clients.size === 0) return;
    let payload = null;
    for (const client of clients) {
      if (client.kinds && !client.kinds.has(event.kind)) continue;
      if (client.target && event.target !== client.target) continue;
      try {
        // A viewer whose connection has stopped draining is dropped rather than
        // buffered: the alternative is unbounded memory in the bridge process.
        if (client.res.writableLength > maxBacklogBytes) {
          clients.delete(client);
          client.res.destroy();
          continue;
        }
        payload ??= JSON.stringify({ seq, ...event });
        client.res.write(`data: ${payload}\n\n`);
      } catch {
        clients.delete(client);
      }
    }
  }

  // Bounded: a device map is small, and an unbounded read here would be a way
  // to grow memory in the process that runs the wall switches.
  function readBody(req, limit = 256 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' || req.method === 'HEAD') {
      switch (p) {
        // The Supervisor watchdog. Our own liveness only -- see lib/health.js.
        case '/api/alive':
          return json(res, 200, health.alive());
        case '/api/health':
          return json(res, 200, await fullHealth());
        case '/api/recent':
          return json(res, 200, ring.since(Number(url.searchParams.get('since') ?? 0), {
            kinds: parseKinds(url.searchParams.get('kinds')),
            target: url.searchParams.get('target') || null,
            limit: Math.min(1000, Number(url.searchParams.get('limit') ?? 300) || 300),
          }));
        case '/api/events':
          return openStream(req, res);
        case '/api/devices':
          return json(res, 200, {
            file: devices?.file ?? null,
            map: devices ? devices.get() : {},
            problems: devices ? devices.problems() : [],
            seen: census ? census.list() : { devices: [], gear: [] },
          });
        case '/api/entities':
          return json(res, 200, { lights: ha ? await ha.listLights() : [], reachable: ha ? !ha.isDown() : null });
        default:
          if (p.startsWith('/api/')) return json(res, 404, { error: 'no such endpoint' });
          return serveStatic(req, res, p);
      }
    }

    if (req.headers[GUARD_HEADER] !== '1') {
      return json(res, 403, { error: `mutations require the ${GUARD_HEADER} header` });
    }

    if (req.method === 'PUT' && p === '/api/devices') {
      if (!devices) return json(res, 503, { error: 'no device map is configured' });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        return json(res, 400, { error: `body is not valid JSON: ${err.message}` });
      }
      const result = await devices.save(body);
      return json(res, result.ok ? 200 : 400, result);
    }

    return json(res, 404, { error: 'no such endpoint' });
  }

  const handler = (req, res) => {
    if (!permitted(req)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('forbidden\n');
    }
    route(req, res).catch((err) => {
      // A UI bug must never escape into the process that runs the wall switches.
      log({ kind: 'alert', alert: 'ui_request_failed', path: req.url, error: String(err?.message ?? err) });
      try { json(res, 500, { error: 'internal error' }); } catch { /* response already gone */ }
    });
  };

  function start() {
    if (server) return Promise.resolve(null);
    server = http.createServer(handler);
    server.on('error', (err) => {
      log({ kind: 'alert', alert: 'ui_server_failed', error: String(err?.message ?? err),
        note: 'the web UI is unavailable; the bridge itself is unaffected' });
    });
    heartbeat = setInterval(() => {
      for (const client of clients) {
        try { client.res.write(': ping\n\n'); } catch { clients.delete(client); }
      }
    }, heartbeatMs);
    heartbeat.unref?.();

    return new Promise((resolve) => {
      server.listen(port, bind, () => {
        const actual = server.address();
        log({ kind: 'ui', status: 'listening', port: actual?.port ?? port, bind,
          restricted_to: allowFrom ?? 'anyone who can reach the port' });
        resolve(actual?.port ?? port);
      });
    });
  }

  async function stop() {
    if (heartbeat) clearInterval(heartbeat);
    for (const client of clients) { try { client.res.end(); } catch { /* gone */ } }
    clients.clear();
    if (!server) return;
    const s = server;
    server = null;
    await new Promise((resolve) => {
      s.close(resolve);
      setTimeout(resolve, 1000).unref?.();
    });
  }

  return { start, stop, broadcast, clients: () => clients.size, handler };
}
