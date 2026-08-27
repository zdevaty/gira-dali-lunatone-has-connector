'use strict';

// Every URL here is relative WITHOUT a leading slash. Under ingress this page is
// served from /api/hassio_ingress/<token>/, so "api/health" resolves inside that
// prefix and "/api/health" would escape it and 404.

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const clock = (iso) => (iso ? new Date(iso).toTimeString().slice(0, 8) : '--:--:--');
const ago = (s) =>
  s == null ? 'never' : s < 2 ? 'just now' : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;

// ── Tabs ────────────────────────────────────────────────────────────────────
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('is-on', t === tab);
    for (const p of document.querySelectorAll('.panel')) {
      p.classList.toggle('is-on', p.id === `panel-${tab.dataset.panel}`);
    }
    if (tab.dataset.panel === 'commission') loadDevices();
  });
}

// ── One readable line per event ─────────────────────────────────────────────
function describe(e) {
  switch (e.kind) {
    case 'level': return `level ${e.level}`;
    case 'colour': return `${e.kelvin} K (${e.mired} mired)`;
    case 'inputEvent': return `${e.instanceType} ${e.event ?? e.value ?? ''}`.trim();
    case 'control': {
      if (e.action === 'brightness_step') return `→ ${e.entity} step ${e.step > 0 ? '+' : ''}${e.step}`;
      if (e.action === 'brightness') return `→ ${e.entity} brightness ${e.brightness}${e.floored ? ' (floor)' : e.ceiling ? ' (ceiling)' : ''}`;
      if (e.action === 'color_temp_kelvin') return `→ ${e.entity} ${e.kelvin} K`;
      if (e.action === 'brightness_suppressed') return `→ ${e.entity} no change — ${e.reason}`;
      return `→ ${e.entity} ${e.action}`;
    }
    case 'alert': return `${e.alert}${e.entity ? ` ${e.entity}` : ''}${fields(e)}${e.note ? ` — ${e.note}` : ''}`;
    case 'connection': return `connection ${e.status}`;
    case 'gateway': return `${e.name} ${e.version}`;
    case 'startup': return `started v${e.version} on ${e.host}`;
    case 'command': return e.scope === 'special' ? `special ${e.command}` : `cmd inst=${e.instance} op=${e.opcode}`;
    case 'response': return `reply ${e.value}`;
    case 'raw': return `raw ${e.bytes}`;
    case 'unknown': return `unknown ${e.bits}b ${e.bytes}`;
    case 'ui': return `web ui ${e.status} on :${e.port}`;
    case 'devices': return `device map ${e.action} (${e.devices} devices)`;
    case 'log': return `capture ${e.action} ${e.file ?? ''}`;
    default: return e.kind;
  }
}

// An alert's whole value is usually the numbers it carries: divergence without
// ha_brightness and bus_level is eleven identical lines that say nothing.
const SKIP_FIELDS = new Set(['kind', 'ts', 'seq', 'bits', 'bytes', 'alert', 'target', 'note', 'entity']);
function fields(e) {
  const parts = [];
  for (const [k, v] of Object.entries(e)) {
    if (SKIP_FIELDS.has(k) || v === null || v === undefined || v === '') continue;
    parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

const label = (e) => {
  if (!e.target) return '';
  if (e.target === 'broadcast') return 'bcast';
  const m = /^short(\d+)$/.exec(e.target);
  return m ? `A${m[1]}` : e.target;
};

// ── Live stream ─────────────────────────────────────────────────────────────
const stream = $('#stream');
const MAX_ROWS = 400;
let paused = false;
let filterKinds = '';
let cursor = 0;
let sse = null;
let pollTimer = null;
let sawStreamData = false;

function addRow(e) {
  if (paused) return;
  const row = el('div', `row k-${e.kind}`);
  row.append(el('span', 't', clock(e.ts)), el('span', 'w', label(e)), el('span', 'd', describe(e)));
  const atBottom = stream.scrollTop + stream.clientHeight >= stream.scrollHeight - 40;
  stream.append(row);
  while (stream.childElementCount > MAX_ROWS) stream.firstElementChild.remove();
  if (atBottom) stream.scrollTop = stream.scrollHeight;
  $('#stream-hint').textContent = '';
}

function noteGap(dropped) {
  if (!dropped) return;
  stream.append(el('div', 'row gap', `… ${dropped} events not shown`));
}

function handleEvent(e) {
  cursor = Math.max(cursor, e.seq ?? 0);
  addRow(e);
  if (e.kind === 'inputEvent') markLive(e);
}

// SSE is the good path. If the stream never delivers -- a proxy that buffers, an
// ingress without ingress_stream -- fall back to polling the same ring rather
// than showing a dead page.
function connectStream() {
  if (sse) sse.close();
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  sawStreamData = false;

  const qs = new URLSearchParams({ since: String(cursor) });
  if (filterKinds) qs.set('kinds', filterKinds);
  sse = new EventSource(`api/events?${qs}`);

  sse.addEventListener('backlog', (msg) => {
    sawStreamData = true;
    const data = JSON.parse(msg.data);
    noteGap(data.dropped);
    for (const e of data.events) handleEvent(e);
  });
  sse.onmessage = (msg) => { sawStreamData = true; handleEvent(JSON.parse(msg.data)); };
  sse.onerror = () => { if (!sawStreamData) startPolling(); };

  setTimeout(() => { if (!sawStreamData) startPolling(); }, 5000);
}

function startPolling() {
  if (pollTimer) return;
  if (sse) { sse.close(); sse = null; }
  $('#stream-hint').textContent = 'Live stream unavailable — polling instead.';
  const tick = async () => {
    const qs = new URLSearchParams({ since: String(cursor) });
    if (filterKinds) qs.set('kinds', filterKinds);
    try {
      const data = await (await fetch(`api/recent?${qs}`)).json();
      noteGap(data.dropped);
      for (const e of data.events) handleEvent(e);
    } catch { /* next tick */ }
  };
  pollTimer = setInterval(tick, 1000);
  tick();
}

for (const chip of document.querySelectorAll('#filters .chip')) {
  chip.addEventListener('click', () => {
    for (const c of document.querySelectorAll('#filters .chip')) c.classList.toggle('is-on', c === chip);
    filterKinds = chip.dataset.kinds;
    stream.replaceChildren();
    cursor = 0;
    connectStream();
  });
}

$('#pause').addEventListener('click', () => {
  paused = !paused;
  $('#pause').textContent = paused ? 'Resume' : 'Pause';
  $('#pause').classList.toggle('btn-primary', paused);
});

// ── Status strip and health ─────────────────────────────────────────────────
function setPill(id, state, detail) {
  const pill = $(id);
  pill.classList.remove('ok', 'bad', 'warn');
  if (state) pill.classList.add(state);
  pill.lastElementChild.textContent = detail;
}

const uptime = (s) =>
  s == null ? '—' : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 86400)}d`;

async function loadHealth() {
  let h;
  try {
    h = await (await fetch('api/health')).json();
  } catch {
    setPill('#pill-bridge', 'bad', 'unreachable');
    return;
  }

  const gw = h.gateway ?? {};
  const connected = gw.connected === true;
  setPill('#pill-bus', connected ? (gw.reachable === false ? 'warn' : 'ok') : 'bad',
    connected ? (h.bus.last_frame_age_s == null ? 'quiet' : ago(h.bus.last_frame_age_s)) : 'down');
  setPill('#pill-ha', h.home_assistant == null ? '' : h.home_assistant.reachable ? 'ok' : 'bad',
    h.home_assistant == null ? 'not used' : h.home_assistant.reachable ? 'ok' : 'unreachable');
  setPill('#pill-bridge', h.control_enabled ? 'ok' : 'warn',
    h.control_enabled ? `${h.counts.haCalls} calls` : 'watching only');

  $('#version').textContent = `v${h.version}`;
  $('#uptime').textContent = uptime(h.uptime_s);

  const lag = h.process.loop_lag_ms ?? {};
  const cards = [
    ['Uptime', uptime(h.uptime_s)],
    ['Frames/min', h.bus.frames_per_minute],
    ['Frames total', h.bus.frames.toLocaleString()],
    ['Last frame', ago(h.bus.last_frame_age_s)],
    ['Gestures', h.counts.gestures],
    ['HA calls', h.counts.haCalls],
    ['Reconnects', h.counts.disconnects, h.counts.disconnects > 5 ? 'bad' : ''],
    ['Alerts', h.counts.alerts, h.counts.alerts ? 'bad' : 'ok'],
    ['Memory', h.process.rss_mb == null ? '—' : `${h.process.rss_mb} MB`],
    ['Loop lag p99', lag.p99 == null ? '—' : `${lag.p99} ms`, lag.p99 > 100 ? 'bad' : 'ok'],
    ['Captures', h.logs?.bytes == null ? '—' : `${(h.logs.bytes / 1048576).toFixed(1)} MB`],
    ['Capture files', h.logs?.files ?? '—'],
    ['Gateway', gw.version ?? '—'],
    ['Timezone', h.tz ?? '—'],
  ];
  const grid = $('#health-cards');
  grid.replaceChildren();
  for (const [l, v, cls] of cards) {
    const card = el('div', `card ${cls ?? ''}`.trim());
    card.append(el('div', 'v', String(v)), el('div', 'l', l));
    grid.append(card);
  }
  $('#health-raw').textContent = JSON.stringify(h, null, 2);
}

// ── Commissioning ───────────────────────────────────────────────────────────
let lights = [];
let saved = {};      // the map as the server has it
let draft = {};      // what the person has typed
let seen = { devices: [], gear: [] };
const rows = new Map();
let sortPending = null;

const dirtyKeys = () =>
  [...new Set([...Object.keys(draft), ...Object.keys(saved)])].filter(
    (k) => JSON.stringify(draft[k] ?? null) !== JSON.stringify(saved[k] ?? null),
  );

function refreshDirty() {
  const n = dirtyKeys().length;
  $('#savebar').hidden = n === 0;
  $('#dirty-count').textContent = n === 1 ? '1 unsaved change' : `${n} unsaved changes`;
}

function entityOptions(selected) {
  const sel = el('select');
  sel.append(new Option('— choose a light —', ''));
  const known = new Set();
  for (const l of lights) {
    known.add(l.entity_id);
    sel.append(new Option(`${l.name}${l.supports_color_temp ? '' : '  (no colour temp)'}`, l.entity_id));
  }
  // A map written by hand may name something Home Assistant does not have, or
  // HA may simply be unreachable. Either way, never silently drop the value.
  if (selected && !known.has(selected)) sel.append(new Option(`${selected} (not in Home Assistant)`, selected));
  sel.value = selected ?? '';
  return sel;
}

function gearOptions(selected) {
  const sel = el('select');
  sel.append(new Option('— learn it automatically —', ''));
  const known = new Set();
  for (const g of seen.gear.filter((g) => g.addressable)) {
    known.add(g.target);
    sel.append(new Option(`${g.target.replace('short', 'A')} — last level ${g.last_level ?? '?'}`, g.target));
  }
  if (selected && !known.has(selected)) sel.append(new Option(selected.replace('short', 'A'), selected));
  sel.value = selected ?? '';
  return sel;
}

function deviceCard(dev) {
  const key = String(dev.address);
  const entry = draft[key] ?? {};
  const card = el('div', 'dev');
  card.dataset.address = key;
  if (entry.entity) card.classList.add('mapped');

  const head = el('div', 'dev-head');
  head.append(el('span', 'addr', `A${dev.address}`), el('span', 'said', dev.last_event ?? ''), el('span', 'ago', ago(dev.last_seen_age_s)));
  card.append(head);

  const lightField = el('div', 'field');
  const lightSel = entityOptions(entry.entity);
  lightSel.addEventListener('change', () => {
    if (lightSel.value) {
      draft[key] = { ...(draft[key] ?? {}), entity: lightSel.value };
    } else {
      delete draft[key];
    }
    card.classList.toggle('mapped', Boolean(lightSel.value));
    refreshDirty();
  });
  lightField.append(el('label', null, 'Light'), lightSel);
  card.append(lightField);

  const gearField = el('div', 'field');
  const gearSel = gearOptions(entry.gear);
  gearSel.addEventListener('change', () => {
    if (!draft[key]) return;
    if (gearSel.value) draft[key].gear = gearSel.value;
    else delete draft[key].gear;
    refreshDirty();
  });
  gearField.append(el('label', null, 'Driver'), gearSel);
  card.append(gearField);

  return card;
}

function renderDevices() {
  const host = $('#devices');
  host.replaceChildren();
  rows.clear();
  $('#commission-empty').hidden = seen.devices.length > 0;

  for (const dev of [...seen.devices].sort((a, b) => a.last_seen_age_s - b.last_seen_age_s)) {
    const card = deviceCard(dev);
    rows.set(String(dev.address), card);
    host.append(card);
  }

  const gearHost = $('#gear-list');
  gearHost.replaceChildren();
  $('#gear-count').textContent = seen.gear.length ? `(${seen.gear.length})` : '';
  for (const g of seen.gear) {
    const row = el('div', 'gear');
    row.append(
      el('b', null, g.target.replace('short', 'A')),
      el('span', null, g.last_level != null ? `level ${g.last_level}` : ''),
      el('span', 'muted', g.addressable ? `${g.frames} frames · ${ago(g.last_seen_age_s)}` : 'names a group, not one driver'),
    );
    gearHost.append(row);
  }
  refreshDirty();
}

// The point of the page: the controller you just turned announces itself.
function markLive(e) {
  if (typeof e.address !== 'number') return;
  const key = String(e.address);
  const card = rows.get(key);
  if (!card) { loadDevices(); return; } // an address we had not seen before

  card.classList.add('live');
  const said = card.querySelector('.said');
  if (said) said.textContent = describe(e).replace(/^\w+ /, '');
  const agoEl = card.querySelector('.ago');
  if (agoEl) agoEl.textContent = 'just now';
  clearTimeout(card._live);
  card._live = setTimeout(() => card.classList.remove('live'), 1200);

  // Float it to the top, throttled so a fast gesture does not thrash the list.
  if (!sortPending) {
    sortPending = setTimeout(() => {
      sortPending = null;
      const host = $('#devices');
      if (host.firstElementChild !== card) host.prepend(card);
    }, 400);
  }
}

async function loadDevices() {
  try {
    const [dev, ents] = await Promise.all([
      fetch('api/devices').then((r) => r.json()),
      fetch('api/entities').then((r) => r.json()).catch(() => ({ lights: [] })),
    ]);
    seen = dev.seen ?? { devices: [], gear: [] };
    saved = dev.map ?? {};
    // Keep whatever the person has typed but not yet saved.
    draft = { ...JSON.parse(JSON.stringify(saved)), ...draft };
    lights = ents.lights ?? [];
    $('#devices-file').textContent = dev.file ? `Saved to ${dev.file}` : '';

    const host = $('#panel-commission');
    host.querySelector('.banner')?.remove();
    if (ents.reachable === false) {
      host.querySelector('.lede').after(
        Object.assign(el('div', 'banner bad'), { textContent: 'Home Assistant is unreachable, so the light list is empty. Anything already mapped is still shown.' }),
      );
    }
    if (dev.problems?.length) {
      host.querySelector('.lede').after(
        Object.assign(el('div', 'banner bad'), { textContent: dev.problems.join(' · ') }),
      );
    }
    renderDevices();
  } catch {
    $('#commission-empty').textContent = 'Could not load the device map.';
  }
}

$('#save').addEventListener('click', async () => {
  const btn = $('#save');
  btn.disabled = true;
  try {
    const res = await fetch('api/devices', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-dali-ui': '1' },
      body: JSON.stringify(draft),
    });
    const body = await res.json();
    const host = $('#panel-commission');
    host.querySelector('.banner')?.remove();
    const banner = el('div', `banner ${res.ok ? 'ok' : 'bad'}`);
    banner.textContent = res.ok
      ? `Saved${body.problems?.length ? ` — ${body.problems.join(' · ')}` : '. The bridge picked it up without a restart.'}`
      : `Not saved: ${body.problems?.join(' · ') ?? body.error}`;
    host.querySelector('.lede').after(banner);
    if (res.ok) { saved = body.map ?? draft; draft = JSON.parse(JSON.stringify(saved)); refreshDirty(); }
  } finally {
    btn.disabled = false;
  }
});

$('#revert').addEventListener('click', () => {
  draft = JSON.parse(JSON.stringify(saved));
  renderDevices();
});

// ── Go ──────────────────────────────────────────────────────────────────────
connectStream();
loadHealth();
loadDevices();
setInterval(loadHealth, 5000);
