import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyAddonOptions, applySupervisorEnvironment } from '../lib/options.js';

async function optionsFile(contents) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dali-opts-'));
  const file = path.join(dir, 'options.json');
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return { file, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

test('add-on options become environment variables', async () => {
  const o = await optionsFile({ gateway_host: '10.0.0.230', log_frames: 'decoded', log_retention_days: 14, control_enabled: false });
  const env = {};
  const applied = applyAddonOptions({ file: o.file, env });
  assert.equal(env.GATEWAY_IP, '10.0.0.230');
  assert.equal(env.LOG_FRAMES, 'decoded');
  assert.equal(env.LOG_RETENTION_DAYS, '14');
  assert.equal(env.CONTROL_ENABLED, 'false', 'booleans survive as strings the config loader already understands');
  assert.deepEqual(Object.keys(applied).sort(), ['CONTROL_ENABLED', 'GATEWAY_IP', 'LOG_FRAMES', 'LOG_RETENTION_DAYS']);
  await o.cleanup();
});

test('the environment wins over the add-on options', async () => {
  const o = await optionsFile({ gateway_host: '10.0.0.230' });
  const env = { GATEWAY_IP: '192.168.1.5' };
  applyAddonOptions({ file: o.file, env });
  assert.equal(env.GATEWAY_IP, '192.168.1.5', 'a shell override must always be possible');
  await o.cleanup();
});

test('no options file, or a corrupt one, changes nothing', async () => {
  assert.equal(applyAddonOptions({ file: '/nonexistent/options.json', env: {} }), null);
  const o = await optionsFile('{ not json');
  assert.equal(applyAddonOptions({ file: o.file, env: {} }), null);
  await o.cleanup();
});

test('empty option values are ignored rather than blanking a default', async () => {
  const o = await optionsFile({ gateway_host: '', log_frames: null });
  const env = {};
  applyAddonOptions({ file: o.file, env });
  assert.deepEqual(env, {}, 'an unfilled field in the config UI must not become an empty setting');
  await o.cleanup();
});

test('under the Supervisor, the token comes from the environment HA provides', () => {
  const env = { SUPERVISOR_TOKEN: 'scoped-token' };
  assert.equal(applySupervisorEnvironment({ env }), true);
  assert.equal(env.HA_URL, 'http://supervisor/core', 'the proxy path matters: /core/api, not /api');
  assert.equal(env.HA_TOKEN, 'scoped-token');
});

test('outside the Supervisor nothing is invented', () => {
  const env = {};
  assert.equal(applySupervisorEnvironment({ env }), false);
  assert.deepEqual(env, {});
});

test('the reported version matches the one Home Assistant shows', () => {
  // The app log said v0.1.0 while the Apps page said 0.2.1, so the running
  // build could not be identified from its own output. config.yaml is the
  // source of truth: it is what HA displays and what gates the Update button.
  const cfg = fs.readFileSync(new URL('../config.yaml', import.meta.url), 'utf8');
  const manifest = /^version:\s*"([^"]+)"/m.exec(cfg)?.[1];
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest, 'config.yaml must declare a version');
  assert.equal(pkg.version, manifest, 'bump both, or neither');
});
