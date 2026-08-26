// Just enough Home Assistant to answer the daemon: the API probe, one light's
// state, and the service calls it records.
import http from 'node:http';

export function createFakeHa({ brightness = 128, kelvin = 4000 } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/api/') return json({ message: 'API running.' });

    if (req.method === 'GET' && req.url.startsWith('/api/states/')) {
      return json({
        entity_id: decodeURIComponent(req.url.slice('/api/states/'.length)),
        state: 'on',
        attributes: {
          brightness,
          color_temp_kelvin: kelvin,
          supported_color_modes: ['color_temp'],
          min_color_temp_kelvin: 2000,
          max_color_temp_kelvin: 6535,
        },
      });
    }

    if (req.method === 'POST' && req.url.startsWith('/api/services/')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { calls.push({ service: req.url, ...JSON.parse(body) }); } catch { calls.push({ service: req.url, raw: body }); }
        json([]);
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return {
    calls,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => server.close(() => r())),
  };
}
