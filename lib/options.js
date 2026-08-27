// Runtime adapters: the same daemon, told where it is.
//
// The design keeps one core and a thin adapter per environment rather than a
// build per deployment. These are the adapters -- roughly forty lines between
// them -- and everything below them reads plain environment variables exactly
// as it did on the bench.

import fs from 'node:fs';

// Home Assistant writes the add-on's Configuration tab here as JSON. The
// environment still wins, so a shell can override any of it for a one-off run.
const OPTION_TO_ENV = {
  gateway_host: 'GATEWAY_IP',
  control_enabled: 'CONTROL_ENABLED',
  device_map: 'DEVICE_MAP',
  log_dir: 'LOG_DIR',
  log_frames: 'LOG_FRAMES',
  log_retention_days: 'LOG_RETENTION_DAYS',
  log_max_mb: 'LOG_MAX_MB',
  log_min_free_mb: 'LOG_MIN_FREE_MB',
  console: 'CONSOLE',
  speed_curve: 'SPEED_CURVE',
  min_brightness: 'MIN_BRIGHTNESS',
};

export function applyAddonOptions({ file = '/data/options.json', env = process.env } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // not running as an add-on, which is the normal case on a bench
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const applied = {};
  for (const [key, name] of Object.entries(OPTION_TO_ENV)) {
    const value = parsed[key];
    if (value === undefined || value === null || value === '') continue;
    if (env[name] !== undefined && env[name] !== '') continue;
    env[name] = String(value);
    applied[name] = env[name];
  }
  return applied;
}

// With `homeassistant_api: true` the Supervisor injects a scoped token and
// proxies Core at http://supervisor/core. This is why the primary deployment
// stores no long-lived access token anywhere: there is nothing to store, nothing
// to rotate, and nothing that can expire in the middle of a gesture.
export function applySupervisorEnvironment({ env = process.env } = {}) {
  if (!env.SUPERVISOR_TOKEN) return false;
  if (!env.HA_URL) env.HA_URL = 'http://supervisor/core';
  if (!env.HA_TOKEN) env.HA_TOKEN = env.SUPERVISOR_TOKEN;
  return true;
}
