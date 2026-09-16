'use strict';

// The Gateway page, and the extras on each Devices card: identify, scenes,
// diagnostics, sensors. Loaded after app.js and uses its helpers ($, el, send,
// ago, gwWrites).
//
// Every button that reaches the bus or changes the gateway says so next to
// it, and the ones whose effect outlasts the moment ask once more.

const gwReadings = new Map();

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

const problemText = (body, res) => (body?.problems ?? [body?.error ?? `HTTP ${res?.status}`]).join(' · ');

function kv(pairs) {
  const dl = el('dl', 'kv');
  for (const [k, v, cls] of pairs) {
    if (v === null || v === undefined || v === '') continue;
    dl.append(el('dt', null, k), el('dd', cls ?? null, String(v)));
  }
  return dl;
}

// A button that says what it did, in place, and never runs twice at once.
function actionButton(label, cls, run) {
  const btn = el('button', `btn ${cls ?? ''}`.trim(), label);
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try { await run(btn); } finally { btn.disabled = false; }
  });
  return btn;
}

// ── Devices page: identify, diagnostics, scenes ────────────────────────────

async function loadReadings() {
  try {
    const body = await getJson('api/gateway/diagnostics');
    gwReadings.clear();
    for (const r of body.readings ?? []) gwReadings.set(r.device.id, r);
  } catch { /* the cards show without them */ }
}

function diagnosticsView(reading) {
  const box = el('div', 'diag');
  if (!reading) return box;
  const s = reading.summary;
  if (s.energy_supported === false && s.diagnostics_supported === false) {
    box.append(el('p', 'hint', 'This driver does not report energy or diagnostics (DALI parts 252 and 253).'));
    return box;
  }
  box.append(kv([
    ['Energy', s.energy_kwh == null ? null : `${s.energy_kwh} kWh`],
    ['Power', s.power_w == null ? null : `${s.power_w} W`],
    ['Driver temperature', s.gear_temperature_c == null ? null : `${s.gear_temperature_c} °C`],
    ['Lamp temperature', s.light_source_temperature_c == null ? null : `${s.light_source_temperature_c} °C`],
    ['Lamp on for', s.light_on_hours == null ? null : `${s.light_on_hours} h${s.life_used_percent != null ? ` (${s.life_used_percent}% of rated life)` : ''}`,
      s.life_used_percent > 80 ? 'bad' : null],
    ['Lamp starts', s.light_starts],
    ['Driver running for', s.gear_operating_hours == null ? null : `${s.gear_operating_hours} h`],
    ['Supply', s.supply_voltage == null ? null : `${s.supply_voltage} V`],
    ['Power factor', s.power_factor],
    ['Problems', s.failures.length ? s.failures.join(', ') : (s.diagnostics_supported ? 'none reported' : null), s.failures.length ? 'bad' : null],
  ]));
  box.append(el('p', 'hint', `Read ${ago(Math.round((Date.now() - Date.parse(reading.at)) / 1000))}.`));
  return box;
}

function scenesView(scenes) {
  const rows = Object.entries(scenes ?? {}).filter(([, v]) => v && Object.values(v).some((x) => x !== null && !(typeof x === 'object' && Object.values(x).every((y) => y === null))));
  if (!rows.length) return el('p', 'hint', 'No scenes are configured on this driver, as far as the gateway knows.');
  const table = el('table', 'scenes');
  const head = el('tr');
  head.append(el('th', null, 'Scene'), el('th', null, 'Values'));
  table.append(head);
  for (const [n, v] of rows.sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const tr = el('tr');
    const values = Object.entries(v).filter(([, x]) => x !== null)
      .map(([k, x]) => `${k} ${typeof x === 'object' ? Object.entries(x).filter(([, y]) => y !== null).map(([a, b]) => `${a}=${typeof b === 'number' ? Math.round(b * 100) / 100 : b}`).join(' ') : x}`);
    tr.append(el('td', null, n), el('td', null, values.join(' · ')));
    table.append(tr);
  }
  const wrap = el('div', 'scroll');
  wrap.append(table);
  return wrap;
}

function deviceExtras(dev) {
  const more = el('details', 'more');
  more.append(el('summary', null, 'Identify, scenes, diagnostics'));

  const note = el('p', 'hint', '');
  const actions = el('div', 'dev-actions');

  const identify = actionButton('Blink', '', async () => {
    note.textContent = 'Blinking…';
    const res = await send('POST', `api/gateway/device/${dev.id}/identify`);
    const body = await res.json().catch(() => ({}));
    note.textContent = res.ok
      ? `Blinked three times and put back ${body.restored?.on ? `at ${Math.round(body.restored.level)}%` : 'off'}.`
      : `Not blinked: ${problemText(body, res)}`;
  });
  identify.disabled = !gwWrites || dev.identifiable === false;
  identify.title = dev.identifiable === false
    ? 'The gateway does not report this light\'s level, so it could not be put back afterwards'
    : 'Switches the light full on and off three times, then back to how it was';

  const diagBox = el('div');
  diagBox.append(diagnosticsView(gwReadings.get(dev.id)));
  const readDiag = actionButton('Read diagnostics', '', async () => {
    note.textContent = 'Reading from the driver… this can take a while.';
    const res = await send('POST', `api/gateway/device/${dev.id}/diagnostics`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { note.textContent = `Not read: ${problemText(body, res)}`; return; }
    const reading = body.readings?.[0];
    if (reading) gwReadings.set(dev.id, reading);
    diagBox.replaceChildren(diagnosticsView(reading));
    note.textContent = '';
  });
  readDiag.disabled = !gwWrites;

  const scenesBox = el('div');
  const showScenes = actionButton('Scenes', '', async () => {
    try {
      const body = await getJson(`api/gateway/device/${dev.id}/scenes`);
      scenesBox.replaceChildren(el('p', 'hint', 'As last seen by the gateway.'), scenesView(body.scenes));
      scenesBox.append(rereadScenes);
    } catch (err) {
      scenesBox.replaceChildren(el('p', 'hint', `Could not load scenes: ${err.message}`));
    }
  });
  const rereadScenes = actionButton('Re-read scenes from the driver', '', async () => {
    note.textContent = 'Reading sixteen scenes from the driver…';
    const res = await send('POST', `api/gateway/device/${dev.id}/scenes`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { note.textContent = `Not read: ${problemText(body, res)}`; return; }
    note.textContent = '';
    scenesBox.replaceChildren(el('p', 'hint', 'Just read from the driver.'), scenesView(body.scenes), rereadScenes);
  });
  rereadScenes.disabled = !gwWrites;

  actions.append(identify, readDiag, showScenes);
  more.append(el('p', 'hint', 'Blink, diagnostics and re-reading scenes put frames on the bus. Blink changes the light for a few seconds and puts it back.'), actions, note, diagBox, scenesBox);
  return more;
}

// ── Devices page: sensors ──────────────────────────────────────────────────

function renderSensors(list) {
  const box = $('#gw-sensors-box');
  box.hidden = !list.length;
  const host = $('#gw-sensors');
  host.replaceChildren();
  for (const s of list) {
    const row = el('div', 'gear');
    const where = s.daliSensorAddress ? `A${s.daliSensorAddress.address} instance ${s.daliSensorAddress.instanceNumber}` : s.addressType ?? '';
    const when = s.timestamp ? ago(Math.round((Date.now() - Date.parse(s.timestamp)) / 1000)) : '';
    row.append(el('b', null, s.name || `sensor ${s.id}`), el('span', null, `${s.value ?? '—'} ${s.unit ?? ''}`.trim()), el('span', 'muted', [s.type, where, when].filter(Boolean).join(' · ')));
    host.append(row);
  }
}

async function loadSensors() {
  try {
    const body = await getJson('api/gateway/sensors');
    renderSensors(body.sensors ?? []);
    $('#sensors-refresh').disabled = !body.writes_enabled;
  } catch {
    $('#gw-sensors-box').hidden = true;
  }
}

$('#sensors-refresh').addEventListener('click', async () => {
  const btn = $('#sensors-refresh');
  btn.disabled = true;
  try {
    const res = await send('POST', 'api/gateway/sensors/refresh');
    const body = await res.json().catch(() => ({}));
    if (res.ok) renderSensors(body.sensors ?? []);
    else gwBanner(`Sensors not re-read: ${problemText(body, res)}`);
  } finally {
    btn.disabled = false;
  }
});

// ── Gateway page ───────────────────────────────────────────────────────────

let hubWrites = false;

function hubBanner(text, cls = 'bad') {
  const b = el('div', `banner ${cls}`, text);
  $('#hub-banners').append(b);
  return b;
}

async function hubSend(method, url, body, doneText) {
  const res = await send(method, url, body);
  const out = await res.json().catch(() => ({}));
  $('#hub-banners').replaceChildren();
  if (res.ok) hubBanner(doneText, 'ok');
  else hubBanner(`Not done: ${problemText(out, res)}`);
  return { res, out };
}

const LINE_TEXT = { ok: 'powered', lowPower: 'LOW POWER', noPower: 'NO POWER', notReachable: 'interface not reachable' };

function renderIdentity(o) {
  const host = $('#hub-identity');
  host.replaceChildren();
  const info = o.info ?? {};
  const fw = o.firmware ?? info.version;
  host.append(kv([
    ['Name', info.name],
    ['Firmware', fw ? `${fw}${o.verified_firmware && fw !== o.verified_firmware ? ` — the decoder was checked against ${o.verified_firmware}` : ''}` : null,
      o.verified_firmware && fw && fw !== o.verified_firmware ? 'bad' : null],
    ['Tier', info.tier],
    ['Serial', info.device?.serial],
    ['Article', info.device?.articleInfo],
  ]));
  if (o.info_error) host.append(el('p', 'hint', `Gateway not answering: ${o.info_error}`));

  const lines = o.lines ?? {};
  if (!Object.keys(lines).length) {
    host.append(el('p', 'hint', 'Bus power: not reported yet (it comes with the gateway check every 30 seconds).'));
    return;
  }
  for (const [line, l] of Object.entries(lines)) {
    const row = el('div', 'gear');
    const bad = l.status !== 'ok';
    row.append(el('b', null, `Line ${line}`), el('span', bad ? 'bad-text' : 'ok-text', LINE_TEXT[l.status] ?? l.status ?? 'unknown'),
      el('span', 'muted', l.blocked?.length ? `cannot send: ${l.blocked.join(', ')}` : ''));
    host.append(row);
  }
}

function renderClock(o) {
  const host = $('#hub-clock');
  host.replaceChildren();
  const c = o.clock;
  const haZone = o.home_assistant?.time_zone ?? null;
  if (!c) {
    host.append(el('p', 'hint', 'The gateway clock has not been read.'));
  } else {
    const off = Math.abs(c.drift_s ?? 0);
    const amount = off >= 2 * 365 * 86400 ? `${Math.round(off / (365.25 * 86400) * 10) / 10} years`
      : off >= 2 * 86400 ? `${Math.round(off / 86400)} days`
        : off >= 7200 ? `${Math.round(off / 3600)} hours`
          : off >= 120 ? `${Math.round(off / 60)} min` : `${off} s`;
    const drift = c.drift_s == null ? null : off < 5 ? 'right' : `${amount} ${c.drift_s > 0 ? 'fast' : 'slow'}`;
    host.append(kv([
      ['Gateway time', `${c.date ?? '?'} ${c.time ?? '?'}`],
      ['Compared with this server', drift ?? c.problem, c.drift_s != null && Math.abs(c.drift_s) >= 60 ? 'bad' : null],
      ['Time zone', `${c.timezone ?? '?'}${haZone && c.timezone !== haZone ? ` — Home Assistant uses ${haZone}` : ''}`, haZone && c.timezone !== haZone ? 'bad' : null],
      ['Network time', c.automatic_time == null ? null : c.automatic_time ? 'on' : 'off'],
    ]));
  }
  const loc = o.location;
  const haLoc = o.home_assistant?.location;
  host.append(kv([
    ['Gateway location', loc ? `${loc.lat}, ${loc.lon}` : o.location_error ?? 'not set'],
    ['Home Assistant location', haLoc ? `${haLoc.lat}, ${haLoc.lon} (rounded to about a kilometre)` : null],
  ]));

  const actions = el('div', 'dev-actions');
  if (haZone && c && c.timezone !== haZone) {
    actions.append(actionButton(`Use ${haZone}`, '', () => hubSend('POST', 'api/gateway/clock', { timezone: haZone }, `Time zone set to ${haZone}.`).then(loadHub)));
  }
  if (c?.recognised) {
    actions.append(actionButton('Set the clock to now', '', () => hubSend('POST', 'api/gateway/clock', { set_now: true }, 'Clock set. Network time is now off on the gateway.').then(loadHub)));
  }
  if (c && c.automatic_time === false) {
    actions.append(actionButton('Turn network time on', '', () => hubSend('POST', 'api/gateway/clock', { automatic_time: true }, 'Network time switched on. It only helps if the gateway can reach the internet.').then(loadHub)));
  }
  if (haLoc && (!loc || loc.lat !== haLoc.lat || loc.lon !== haLoc.lon)) {
    actions.append(actionButton('Use Home Assistant\'s location', '', () => hubSend('POST', 'api/gateway/location', {}, 'Location set.').then(loadHub)));
  }
  for (const b of actions.querySelectorAll('button')) b.disabled = !hubWrites;
  if (actions.childElementCount) host.append(actions);
  if (c && !c.recognised) host.append(el('p', 'hint', `The clock cannot be set from here: ${c.problem}.`));
}

function renderPolling(o) {
  const host = $('#hub-polling');
  host.replaceChildren();
  if (o.polling_error) { host.append(el('p', 'hint', `Not readable: ${o.polling_error}`)); return; }
  const lines = Object.entries(o.polling ?? {});
  if (!lines.length) host.append(el('p', 'hint', 'The gateway does not poll any line.'));
  for (const [line, q] of lines) {
    const form = el('div', 'poll');
    const delay = Object.assign(el('input'), { type: 'number', min: '0.5', max: '3600', step: '0.5', value: q.delayBetweenQueries ?? '' });
    const status = Object.assign(el('input'), { type: 'checkbox', checked: q.queryStatus === true });
    const level = Object.assign(el('input'), { type: 'checkbox', checked: q.queryActualLevel === true });
    const label = (text, input) => { const l = el('label', 'check'); l.append(input, ` ${text}`); return l; };
    const delayField = el('label', 'check');
    delayField.append(`Line ${line}: every `, delay, ' s');
    const save = actionButton('Save', 'btn-primary', () => hubSend('PUT', `api/gateway/polling/${line}`, {
      delayBetweenQueries: Number(delay.value), queryStatus: status.checked, queryActualLevel: level.checked,
    }, `Polling on line ${line} saved.`).then(loadHub));
    save.disabled = !hubWrites;
    for (const i of [delay, status, level]) i.disabled = !hubWrites;
    form.append(delayField, label('status', status), label('level', level), save);
    host.append(form);
  }
}

const KIND_TEXT = { schedule: 'schedule', circadian: 'circadian', sequence: 'sequence', trigger_action: 'trigger action', event_trigger_action: 'event forwarding' };

function renderAutomations(body, upcoming) {
  const host = $('#hub-automations');
  host.replaceChildren();
  const list = body.automations ?? [];
  const errors = Object.entries(body.errors ?? {});
  if (errors.length) host.append(el('p', 'hint', `Not readable: ${errors.map(([k, v]) => `${k} (${v})`).join(', ')}`));
  if (!list.length && !errors.length) {
    host.append(el('p', 'hint', 'None. Nothing on the gateway changes a light by itself.'));
    return;
  }
  for (const a of list) {
    const card = el('div', `dev auto${a.enabled ? '' : ' off'}`);
    const head = el('div', 'dev-head');
    head.append(el('span', 'badge', KIND_TEXT[a.kind] ?? a.kind), el('b', null, a.name || `#${a.id}`),
      el('span', 'muted', a.enabled ? (a.active ? 'running' : 'enabled') : 'disabled'));
    card.append(head, el('div', 'said', a.summary));
    if (a.targets.length) card.append(el('div', 'driven', `→ ${a.targets.join(', ')}`));
    if (a.enabled && a.knobs.length) {
      card.append(el('div', 'banner bad', `Changes lights that knobs also drive: ${a.knobs.map((k) => `A${k.knob} → ${k.entity}`).join(', ')}. A light that moves on its own may be this.`));
    }
    host.append(card);
  }
  if (upcoming?.length) {
    host.append(el('p', 'hint', `Due soon: ${upcoming.map((u) => `“${u.name || u.id}” at ${clock(u.at)}`).join(', ')}. Each shows up in Now when it is due.`));
  }
}

function renderZones(body) {
  const host = $('#hub-zones');
  host.replaceChildren();
  $('#zones-plan').hidden = !body.can_mirror;
  $('#zones-plan').disabled = !body.writes_enabled;
  if (!body.zones?.length) { host.append(el('p', 'hint', 'The gateway has no zones.')); return; }
  for (const z of body.zones) {
    const row = el('div', 'gear');
    row.append(el('b', null, z.name || `zone ${z.id}`), el('span', 'muted', z.targets.join(', ') || 'empty'));
    host.append(row);
  }
}

$('#zones-plan').addEventListener('click', async () => {
  const host = $('#hub-zone-plan');
  host.replaceChildren(el('p', 'hint', 'Asking Home Assistant for its areas…'));
  let body;
  try {
    body = await getJson('api/gateway/zones/plan');
  } catch (err) {
    host.replaceChildren(el('div', 'banner bad', err.message));
    return;
  }
  const plan = body.plan;
  const box = el('div', 'confirm');
  const section = (title, items, fmt) => {
    if (!items.length) return;
    box.append(el('p', null, title));
    const ul = el('ul', 'hint');
    for (const i of items) ul.append(el('li', null, fmt(i)));
    box.append(ul);
  };
  const names = (targets) => targets.map((t) => {
    const light = plan.areas.flatMap((a) => a.lights).find((l) => l.device?.id === t.id);
    return light ? `${light.device.name || `device ${t.id}`} (${light.entity_id})` : `device ${t.id}`;
  }).join(', ');
  section('Create', plan.create, (z) => `“${z.name}”: ${names(z.targets)}`);
  section('Update', plan.update, (z) => `“${z.name}”: ${names(z.targets)}`);
  section('Left as they are', plan.unchanged, (z) => `“${z.name}” — ${z.reason}`);
  section('Lights not matched to a gateway device, so not included', plan.unmatched, (l) => `${l.entity_id} in ${l.area} — ${l.how}`);
  section('Gateway zones with no matching area, not touched', plan.untouched, (z) => `“${z.name || z.id}”`);
  const matched = plan.areas.flatMap((a) => a.lights).filter((l) => l.device);
  if (matched.length) box.append(el('p', 'hint', `Matched by ${[...new Set(matched.map((l) => l.how))].join(', ')}.`));

  if (plan.create.length || plan.update.length) {
    const apply = actionButton('Apply to the gateway', 'btn-primary', async () => {
      const { res } = await hubSend('POST', 'api/gateway/zones/apply', { plan: plan.id }, 'Zones updated.');
      if (res.ok) { host.replaceChildren(); loadHub(); }
    });
    apply.disabled = !body.writes_enabled;
    box.append(apply);
  } else {
    box.append(el('p', 'hint', 'Nothing to change.'));
  }
  const cancel = actionButton('Close', '', () => host.replaceChildren());
  box.append(' ', cancel);
  host.replaceChildren(box);
});

async function showDiff(file) {
  const host = $('#hub-diff');
  host.replaceChildren(el('p', 'hint', 'Comparing…'));
  let body;
  try {
    body = await getJson(`api/gateway/snapshots/compare?file=${encodeURIComponent(file)}`);
  } catch (err) {
    host.replaceChildren(el('p', 'hint', err.message));
    return;
  }
  if (!body.previous) { host.replaceChildren(el('p', 'hint', 'The first copy: nothing to compare it with.')); return; }
  const box = el('div', 'diff');
  box.append(el('p', 'hint', `${file} against ${body.previous}:`));
  const ul = el('ul');
  for (const c of body.changes) ul.append(el('li', `op-${c.op}`, c.text));
  if (!body.changes.length) ul.append(el('li', null, 'No differences.'));
  box.append(ul);
  host.replaceChildren(box);
}

function renderSnapshots(body) {
  const host = $('#hub-snapshots');
  host.replaceChildren();
  if (!body.snapshots?.length) { host.append(el('p', 'hint', 'No copies yet. The first is taken two minutes after the app starts.')); return; }
  for (const s of body.snapshots) {
    const row = el('button', 'gear linkish');
    row.type = 'button';
    row.append(el('b', null, new Date(s.taken_at).toLocaleString()), el('span', null, s.changes == null ? 'first copy' : `${s.changes} change${s.changes === 1 ? '' : 's'}`),
      el('span', 'muted', `${s.reason}${s.errors?.length ? ` · not read: ${s.errors.join(', ')}` : ''}`));
    row.addEventListener('click', () => showDiff(s.file));
    host.append(row);
  }
}

$('#snapshot-take').addEventListener('click', async () => {
  const btn = $('#snapshot-take');
  btn.disabled = true;
  try {
    const res = await send('POST', 'api/gateway/snapshots');
    const body = await res.json().catch(() => ({}));
    $('#hub-banners').replaceChildren();
    if (!res.ok) hubBanner(`No copy taken: ${problemText(body, res)}`);
    else hubBanner(body.changed ? `Saved ${body.file}${body.changes?.length ? `: ${body.changes.slice(0, 3).join('; ')}${body.changes.length > 3 ? '…' : ''}` : ''}.` : 'Nothing has changed since the last copy.', 'ok');
    renderSnapshots(await getJson('api/gateway/snapshots'));
  } finally {
    btn.disabled = false;
  }
});

async function loadHub() {
  let overview;
  try {
    overview = await getJson('api/gateway/overview');
  } catch (err) {
    $('#hub-banners').replaceChildren();
    hubBanner(`Could not read the gateway: ${err.message}`);
    return;
  }
  hubWrites = overview.writes_enabled === true;
  if (!hubWrites && !$('#hub-banners').childElementCount) {
    hubBanner('Device management is switched off in the app configuration, so the settings here are read-only.');
  }
  renderIdentity(overview);
  renderClock(overview);
  renderPolling(overview);
  const [autos, zones, snaps] = await Promise.all([
    getJson('api/gateway/automations').catch((err) => ({ automations: [], errors: { all: err.message } })),
    getJson('api/gateway/zones').catch(() => ({ zones: [], can_mirror: false })),
    getJson('api/gateway/snapshots').catch(() => ({ snapshots: [] })),
  ]);
  renderAutomations(autos, overview.upcoming);
  renderZones(zones);
  renderSnapshots(snaps);
}
