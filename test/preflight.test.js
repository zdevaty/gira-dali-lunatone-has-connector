import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHaClient, diagnoseNetworkError } from '../lib/ha-client.js';

const DEVICE_MAP = { 0: { entity: 'light.obyvak', min_kelvin: 2700, max_kelvin: 6500 } };

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function stateResponse({ modes = ['color_temp'], min = 2000, max = 6535, state = 'on' } = {}) {
  return jsonResponse({
    entity_id: 'light.obyvak',
    state,
    attributes: { supported_color_modes: modes, min_color_temp_kelvin: min, max_color_temp_kelvin: max },
  });
}

// 127.0.0.1 so the real DNS step resolves; the mocked fetch supplies everything after.
function harness(fetchImpl, { url = 'http://127.0.0.1:8123', token = 'tok' } = {}) {
  const logs = [];
  const ha = createHaClient({ url, token, log: (e) => logs.push(e), fetchImpl });
  return { ha, logs, failures: () => logs.filter((e) => e.alert === 'ha_preflight_failed') };
}

test('preflight passes and reports each step when HA is healthy', async () => {
  const h = harness(async (target) =>
    target.endsWith('/api/') ? jsonResponse({ message: 'API running.' }) : stateResponse(),
  );
  const ok = await h.ha.preflight(DEVICE_MAP);

  assert.equal(ok, true);
  assert.equal(h.failures().length, 0);
  const steps = h.logs.filter((e) => e.kind === 'preflight').map((e) => e.step);
  assert.deepEqual(steps.slice(0, 2), ['config', 'dns']);
  assert.ok(steps.includes('api'));
  assert.ok(steps.includes('entity'));
  assert.equal(h.logs.find((e) => e.step === 'result').status, 'ok');
});

test('preflight never logs the token itself', async () => {
  const secret = 'super-secret-token-value';
  const h = harness(
    async (target) => (target.endsWith('/api/') ? jsonResponse({ message: 'API running.' }) : stateResponse()),
    { token: secret },
  );
  await h.ha.preflight(DEVICE_MAP);
  assert.ok(!JSON.stringify(h.logs).includes(secret), 'the token must never reach the log');
  assert.match(h.logs.find((e) => e.step === 'config').token, /^present \(\d+ chars\)$/);
});

test('a 401 is reported as a token problem, not a network problem', async () => {
  const h = harness(async () => jsonResponse({ message: 'Unauthorized' }, 401));
  assert.equal(await h.ha.preflight(DEVICE_MAP), false);
  const failure = h.failures()[0];
  assert.equal(failure.step, 'auth');
  assert.match(failure.reason, /401/);
  assert.match(failure.hint, /token/i);
});

test('a 404 on /api/ is reported as wrong port, not as HA being down', async () => {
  const h = harness(async () => jsonResponse({}, 404));
  assert.equal(await h.ha.preflight(DEVICE_MAP), false);
  const failure = h.failures()[0];
  assert.equal(failure.step, 'api');
  assert.match(failure.hint, /port/i);
});

test('a missing entity is named explicitly, and the check continues', async () => {
  const h = harness(async (target) => (target.endsWith('/api/') ? jsonResponse({ message: 'API running.' }) : jsonResponse({}, 404)), {});
  assert.equal(await h.ha.preflight({ ...DEVICE_MAP, 1: { entity: 'light.missing', min_kelvin: 2700, max_kelvin: 6500 } }), false);
  const failures = h.failures();
  assert.equal(failures.length, 2, 'both entities are checked, not just the first');
  assert.match(failures[0].reason, /light\.obyvak/);
  assert.match(failures[1].reason, /light\.missing/);
});

test('an entity that cannot do colour temperature is flagged', async () => {
  const h = harness(async (target) =>
    target.endsWith('/api/') ? jsonResponse({ message: 'API running.' }) : stateResponse({ modes: ['brightness'] }),
  );
  assert.equal(await h.ha.preflight(DEVICE_MAP), false);
  const failure = h.failures()[0];
  assert.match(failure.reason, /does not support color_temp/);
  assert.match(failure.hint, /[Bb]rightness will still work/);
});

test('a configured range wider than HA reports is a note, not a failure', async () => {
  const h = harness(async (target) =>
    target.endsWith('/api/') ? jsonResponse({ message: 'API running.' }) : stateResponse({ min: 3000, max: 5000 }),
  );
  assert.equal(await h.ha.preflight(DEVICE_MAP), true, 'clamping to a different range is deliberate, not an error');
  assert.ok(h.logs.some((e) => e.status === 'range_note'));
});

test('network errors are diagnosed rather than left as "fetch failed"', () => {
  const wrap = (code, name) => Object.assign(new Error('fetch failed'), { name, cause: { code } });

  const dns = diagnoseNetworkError(wrap('ENOTFOUND'), { host: 'homeassistant.local' });
  assert.match(dns.reason, /does not resolve/);
  assert.match(dns.hint, /mDNS/, '.local names should get the mDNS explanation');

  const plainDns = diagnoseNetworkError(wrap('ENOTFOUND'), { host: 'ha-box' });
  assert.doesNotMatch(plainDns.hint, /mDNS/, 'non-.local names get a different hint');

  assert.match(diagnoseNetworkError(wrap('ECONNREFUSED'), { host: 'h', port: '80' }).reason, /refused/);
  assert.match(diagnoseNetworkError(wrap('ECONNREFUSED'), { host: 'h', port: '80' }).hint, /port/);
  assert.match(diagnoseNetworkError(wrap('EHOSTUNREACH'), { host: 'h' }).reason, /no route/);
  assert.match(diagnoseNetworkError(wrap('ECONNRESET'), { host: 'h' }).hint, /https/);
  assert.match(diagnoseNetworkError(wrap(null, 'TimeoutError'), { host: 'h' }).reason, /timed out/);
});

test('an unresolvable hostname fails at the DNS step and skips the rest', async () => {
  let calls = 0;
  const h = harness(
    async () => {
      calls++;
      return jsonResponse({});
    },
    { url: 'http://this-host-does-not-exist.invalid:8123' },
  );
  assert.equal(await h.ha.preflight(DEVICE_MAP), false);
  const failure = h.failures()[0];
  assert.equal(failure.step, 'dns');
  assert.equal(calls, 0, 'no HTTP attempted once DNS has already failed');
});

test('a base URL with a path is preserved, as the Supervisor proxy requires', async () => {
  // Under the add-on the API is at http://supervisor/core/api. Using the origin
  // alone would ask http://supervisor/api and report a confident, wrong reason.
  const asked = [];
  const h = harness(
    async (url) => {
      asked.push(String(url));
      if (String(url).endsWith('/api/')) return { ok: true, status: 200, json: async () => ({ message: 'API running.' }) };
      return {
        ok: true, status: 200,
        json: async () => ({ state: 'on', attributes: { supported_color_modes: ['color_temp'], min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6535 } }),
      };
    },
    { url: 'http://127.0.0.1:8123/core' },
  );

  await h.ha.preflight({ 0: { entity: 'light.x', min_kelvin: 2700, max_kelvin: 6500 } });
  assert.ok(asked.some((u) => u === 'http://127.0.0.1:8123/core/api/'), `asked: ${asked.join(', ')}`);
  assert.ok(asked.some((u) => u.startsWith('http://127.0.0.1:8123/core/api/states/')), `asked: ${asked.join(', ')}`);
});
