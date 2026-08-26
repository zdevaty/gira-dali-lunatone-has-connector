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

  const server = http.createServer((req, res) => {
    // The liveness probe the design proposes: read-only, and it exists.
    if (req.url === '/info') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'fake-gateway', errors: 0, lines: [{ id: 0, status: 'ok' }] }));
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
    clients: () => sockets.size,
    connections: () => connections,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
