// Just enough Home Assistant to answer the daemon: the API probe, one light's
// state, and the service calls and state writes it records.
import http from 'node:http';

export function createFakeHa({ brightness = 128, kelvin = 4000, areaLights = [], config = { time_zone: 'Europe/Prague', latitude: 50.0875, longitude: 14.4213 } } = {}) {
  const calls = [];
  const templates = [];
  const states = [];
  const reloads = [];
  const server = http.createServer((req, res) => {
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/api/') return json({ message: 'API running.' });

    if (req.method === 'GET' && req.url === '/api/config') return json({ ...config, version: '2026.9.0' });

    // Only the area template the bridge sends; answered from `areaLights`,
    // which is what that template renders to.
    if (req.method === 'POST' && req.url === '/api/template') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        templates.push(body);
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(JSON.stringify(areaLights));
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/states') {
      return json([{ entity_id: 'light.line_0_dali_00', state: 'on', attributes: { friendly_name: 'Line 0 DALI 00', supported_color_modes: ['color_temp'] } }]);
    }

    if (req.method === 'GET' && req.url.startsWith('/api/config/config_entries/entry?')) {
      return json([{ entry_id: 'lunatone-1', domain: 'lunatone' }]);
    }
    if (req.method === 'POST' && /^\/api\/config\/config_entries\/entry\/[^/]+\/reload$/.test(req.url)) {
      reloads.push(req.url);
      return json({ require_restart: false });
    }

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

    if (req.method === 'POST' && req.url.startsWith('/api/states/')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const entity_id = decodeURIComponent(req.url.slice('/api/states/'.length));
        try { states.push({ entity_id, auth: req.headers.authorization, ...JSON.parse(body) }); } catch { states.push({ entity_id, raw: body }); }
        json({ entity_id });
      });
      return;
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
    templates,
    states,
    reloads,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => server.close(() => r())),
  };
}
