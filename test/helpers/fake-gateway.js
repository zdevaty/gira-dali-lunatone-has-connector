// A minimal RFC 6455 server, enough to impersonate the Lunatone gateway's
// monitor socket. Zero dependencies, like everything else here.
//
// Server-to-client frames are unmasked, which is the whole of what we need to
// send: the daemon never sends anything on this socket.

import http from 'node:http';
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function textFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export function createFakeGateway() {
  const sockets = new Set();
  let connections = 0;
  let infoStatus = 200;
  let infoErrors = {};
  // The admin side: device list and scans. Every request is recorded, so a
  // test can prove exactly what the bridge asked the gateway to do.
  const adminRequests = [];
  let devices = [];
  let scanPolls = null;
  let infoLines = { 0: { sendBlockedInitialize: false, sendBlockedQuiescent: false, sendBlockedMacroRunning: false, sendBufferFull: false, lineStatus: 'ok' } };
  // The rest of the gateway's stored state, in the shapes of its OpenAPI
  // schema. Tests change it through `state`.
  const state = {
    datetime: { timezone: 'Europe/Prague', automatic_time: true, date: '2026-09-16', time: '12:00:00' },
    datetimeLive: true,
    timezones: ['Europe/Prague', 'Europe/London', 'UTC'],
    location: { lat: 50.08, lon: 14.42 },
    settings: { dali_ping: true, log_file_enabled: false },
    zones: [],
    sensors: [],
    scenes: {},
    energy: {},
    diagnostics: {},
    statusQueries: { 0: { delayBetweenQueries: 1, queryStatus: true, queryActualLevel: true } },
    schedules: [],
    circadians: [],
    sequences: [],
    triggerActions: [],
    eventTriggerActions: [],
    controlFails: false,
  };
  let nextZoneId = 1;

  const server = http.createServer((req, res) => {
    // The liveness probe the design proposes. The body is the real shape, taken
    // from the gateway at 10.0.0.230 on 27 Aug 2026 -- `errors` is an object
    // keyed by fault, not a count, which is what the detector reads.
    if (req.url === '/info') {
      if (infoStatus !== 200) {
        res.writeHead(infoStatus);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        name: 'DALI-2 IoT',
        version: 'v1.18.7/1.4.6',
        tier: 'plus',
        uid: '6feb271f-e396-42e2-8557-6dd1ae30bf2a',
        startupMode: 'normal',
        errors: infoErrors,
        descriptor: { lines: 1, bufferSize: 32, tickResolution: 1, maxYnFrameSize: 64, implementedMacros: [], deviceListSpecifier: 0, protocolVersionMajor: 1, protocolVersionMinor: 6, powerSupplyImplemented: true },
        lines: infoLines,
      }));
      return;
    }
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const scanModel = (status) => ({ id: 'scan-1', progress: status === 'done' ? 100 : 50, found: devices.length,
      foundSensors: 0, status, lines: [{ line: 0, scanState: status === 'done' ? 'done' : 'scanning', found: devices.length, addressed: 1, scanned: devices.length, progress: 50 }] });

    const known = ['/devices', '/dali/', '/device/', '/datetime', '/location', '/settings', '/zone', '/sensors', '/automations/'];
    if (known.some((k) => req.url === k || req.url.startsWith(k))) {
      let text = '';
      req.on('data', (c) => { text += c; });
      req.on('end', () => {
        let body;
        try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
        adminRequests.push({ method: req.method, path: req.url, body });
        if (req.method === 'GET' && req.url === '/devices') return json(200, { devices, timeSignature: { timestamp: 1, counter: 1 } });
        if (req.method === 'POST' && req.url === '/dali/scan') { scanPolls = 0; return json(200, scanModel('in progress')); }
        if (req.method === 'POST' && req.url === '/dali/scan/cancel') { scanPolls = null; return json(200, scanModel('cancelled')); }
        if (req.method === 'GET' && req.url === '/dali/scan') {
          if (scanPolls === null) return json(200, scanModel('not started'));
          scanPolls += 1;
          return json(200, scanModel(scanPolls >= 2 ? 'done' : 'in progress'));
        }
        const url = req.url;
        const m = (re) => re.exec(url);
        const device = (id) => devices.find((d) => d.id === Number(id));
        let hit;

        if (req.method === 'GET' && (hit = m(/^\/device\/(\d+)$/))) return device(hit[1]) ? json(200, device(hit[1])) : json(404, { detail: 'device not found' });
        if (req.method === 'PUT' && (hit = m(/^\/device\/(\d+)$/))) {
          const d = device(hit[1]);
          if (!d) return json(404, { detail: 'device not found' });
          Object.assign(d, body);
          return json(200, d);
        }
        if (req.method === 'POST' && (hit = m(/^\/device\/(\d+)\/control$/))) {
          const d = device(hit[1]);
          if (!d) return json(404, { detail: 'device not found' });
          if (state.controlFails) return json(500, { detail: 'bus error' });
          d.features ??= {};
          if ('dimmable' in body) {
            d.features.dimmable = { status: body.dimmable };
            d.features.switchable = { status: body.dimmable > 0 };
          }
          if ('switchable' in body) d.features.switchable = { status: body.switchable };
          return json(200, {});
        }
        if ((hit = m(/^\/device\/(\d+)\/scenes$/))) {
          if (!device(hit[1])) return json(404, { detail: 'device not found' });
          return json(200, state.scenes[hit[1]] ?? {});
        }
        if (req.method === 'GET' && (hit = m(/^\/device\/(\d+)\/(energyReporting|diagnosticsMaintenance)$/))) {
          if (!device(hit[1])) return json(404, { detail: 'device not found' });
          const data = (hit[2] === 'energyReporting' ? state.energy : state.diagnostics)[hit[1]];
          return data ? json(200, data) : json(501, { detail: 'not implemented' });
        }
        if (req.method === 'GET' && (hit = m(/^\/dali\/readStatus\/(\d+)$/))) {
          const l = infoLines[hit[1]];
          return l ? json(200, { line: Number(hit[1]), busVoltageDown: l.lineStatus === 'noPower', initializeMode: false, quiescentMode: false, lineStatus: l.lineStatus }) : json(404, { detail: 'line not found' });
        }
        if (req.method === 'GET' && url === '/datetime') {
          if (!state.datetimeLive) return json(200, state.datetime);
          // Now, in the zone, in the gateway's own format.
          const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: state.datetime.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
            .formatToParts(new Date(Date.now() + (state.clockOffsetMs ?? 0))).map((x) => [x.type, x.value]));
          return json(200, { ...state.datetime, date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` });
        }
        if (req.method === 'POST' && url === '/datetime') { Object.assign(state.datetime, body); return json(200, state.datetime); }
        if (req.method === 'GET' && url === '/datetime/timezones') return json(200, { timezones: state.timezones });
        if (req.method === 'GET' && url === '/location') return json(200, state.location);
        if (req.method === 'POST' && url === '/location') { state.location = body; return json(200, body); }
        if (req.method === 'GET' && url === '/settings') return json(200, state.settings);
        if (req.method === 'GET' && url === '/zones') return json(200, { zones: state.zones, timeSignature: { timestamp: 1, counter: 1 } });
        if (req.method === 'POST' && url === '/zone') {
          const z = { id: nextZoneId++, name: body.name, targets: body.targets, features: {}, timeSignature: { timestamp: 1, counter: 1 } };
          state.zones.push(z);
          return json(200, z);
        }
        if (req.method === 'PUT' && (hit = m(/^\/zone\/(\d+)$/))) {
          const z = state.zones.find((x) => x.id === Number(hit[1]));
          if (!z) return json(404, { detail: 'zone not found' });
          Object.assign(z, body);
          return json(200, z);
        }
        if (req.method === 'GET' && url === '/sensors') return json(200, { sensors: state.sensors });
        if (req.method === 'POST' && url === '/sensors') return json(200, { sensors: state.sensors });
        if (req.method === 'GET' && url === '/automations/statusQueries') return json(200, state.statusQueries);
        if ((hit = m(/^\/automations\/statusQueries\/(\d+)$/)) && (req.method === 'PUT' || req.method === 'POST')) {
          if (req.method === 'PUT' && !state.statusQueries[hit[1]]) return json(404, { detail: 'line not found' });
          state.statusQueries[hit[1]] = body;
          return json(200, body);
        }
        if (req.method === 'GET' && url === '/automations/schedules') return json(200, { schedulers: state.schedules });
        if (req.method === 'GET' && url === '/automations/circadians') return json(200, { circadians: state.circadians, timeSignature: { timestamp: 1, counter: 1 } });
        if (req.method === 'GET' && url === '/automations/sequences') return json(200, { sequences: state.sequences });
        if (req.method === 'GET' && url === '/automations/triggerActions') return json(200, { triggerActions: state.triggerActions });
        if (req.method === 'GET' && url === '/automations/eventTriggerActions') return json(200, state.eventTriggerActions);
        json(404, { detail: 'Not Found' });
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });

  return {
    listen: () =>
      new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    send(message) {
      const buf = textFrame(typeof message === 'string' ? message : JSON.stringify(message));
      for (const s of sockets) s.write(buf);
    },
    monitor: (bits, data) => ({ type: 'daliMonitor', data: { bits, data } }),
    // The gateway greets every new connection with this before any bus traffic.
    greet: () => ({ type: 'info', data: { name: 'DALI-2 IoT', version: 'v1.18.7/1.4.6' } }),
    setInfoStatus: (code) => { infoStatus = code; },
    setDevices: (list) => { devices = list; },
    setLines: (lines) => { infoLines = lines; },
    state,
    adminRequests,
    setInfoErrors: (errors) => { infoErrors = errors; },
    clients: () => sockets.size,
    connections: () => connections,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
