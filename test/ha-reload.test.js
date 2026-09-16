import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHaClient } from '../lib/ha-client.js';

function fakeFetch(routes) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? 'GET'} ${u.pathname}`;
    requests.push({ key, search: u.search, body: init.body ? JSON.parse(init.body) : undefined });
    const [status, body] = routes[key] ?? [404, { message: 'Not Found' }];
    return { ok: status < 400, status, json: async () => body };
  };
  return { fetchImpl, requests };
}

test('reloads the integration by its config entries when HA allows it', async () => {
  const f = fakeFetch({
    'GET /api/config/config_entries/entry': [200, [
      { entry_id: 'abc', domain: 'lunatone' },
      { entry_id: 'zzz', domain: 'hue' },
    ]],
    'POST /api/config/config_entries/entry/abc/reload': [200, { require_restart: false }],
  });
  const logs = [];
  const ha = createHaClient({ url: 'http://ha', token: 't', fetchImpl: f.fetchImpl, log: (e) => logs.push(e) });
  const r = await ha.reloadIntegration('lunatone', { viaEntities: ['light.line_0_dali_00'] });
  assert.equal(r.ok, true);
  assert.equal(r.method, 'config_entries');
  assert.equal(r.entries, 1, 'only the Lunatone entry, even if HA returns others');
  assert.ok(!f.requests.some((q) => q.key.includes('zzz')));
  assert.ok(!f.requests.some((q) => q.key.startsWith('POST /api/services')), 'no fallback needed');
});

test('falls back to reload_config_entry through a mapped entity when the config API is refused', async () => {
  const f = fakeFetch({
    'GET /api/config/config_entries/entry': [401, { message: 'Unauthorized' }],
    'POST /api/services/homeassistant/reload_config_entry': [200, []],
  });
  const logs = [];
  const ha = createHaClient({ url: 'http://ha', token: 't', fetchImpl: f.fetchImpl, log: (e) => logs.push(e) });
  const r = await ha.reloadIntegration('lunatone', { viaEntities: ['light.line_0_dali_00'] });
  assert.equal(r.ok, true);
  assert.equal(r.method, 'service');
  const call = f.requests.find((q) => q.key === 'POST /api/services/homeassistant/reload_config_entry');
  assert.deepEqual(call.body, { entity_id: 'light.line_0_dali_00' });
  assert.equal(ha.isDown(), false, 'a refused endpoint is an answer, not an outage');
  assert.ok(!logs.some((e) => e.alert === 'ha_unreachable'));
});

test('with neither path available it says so, and names what it tried', async () => {
  const f = fakeFetch({ 'GET /api/config/config_entries/entry': [200, []] });
  const ha = createHaClient({ url: 'http://ha', token: 't', fetchImpl: f.fetchImpl });
  const r = await ha.reloadIntegration('lunatone', { viaEntities: [] });
  assert.equal(r.ok, false);
  assert.equal(r.attempts[0].method, 'config_entries');
  assert.equal(r.attempts[0].entries, 0);
});
