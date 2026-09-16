'use strict';

// The Tuning page. Loaded after app.js and uses its helpers ($, el, send,
// clock, describe, label).
//
// The loop it exists for: change a value, save, turn the knob, watch what was
// sent, adjust. So the feed of knob reports and Home Assistant calls sits at
// the top, and saving applies at once.

let tuningState = null;
let tuningDraft = {};
let tuningFeedTimer = null;
let tuningCursor = 0;

const SOURCE_TEXT = { page: 'set here', environment: 'from the environment', default: 'default' };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function tuningBanner(text, cls = 'bad') {
  $('#tuning-banners').append(el('div', `banner ${cls}`, text));
}

function tuningDirtyKeys() {
  if (!tuningState) return [];
  return Object.keys(tuningDraft).filter((k) => !same(tuningDraft[k], tuningState.values[k]));
}

function refreshTuningDirty() {
  const n = tuningDirtyKeys().length;
  $('#tuning-savebar').hidden = n === 0;
  $('#tuning-dirty').textContent = n === 1 ? '1 unsaved change' : `${n} unsaved changes`;
  for (const row of document.querySelectorAll('#tuning-form .tune')) {
    row.classList.toggle('dirty', tuningDirtyKeys().includes(row.dataset.key));
  }
}

function numberInput(value, onInput) {
  const input = Object.assign(el('input'), { type: 'number', step: 'any', value: String(value), inputMode: 'decimal' });
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

function tuningRow(field) {
  const row = el('div', 'tune');
  row.dataset.key = field.key;
  const head = el('div', 'tune-head');
  head.append(el('label', null, field.label));
  const source = tuningState.source[field.key];
  head.append(el('span', `badge${source === 'page' ? ' ok' : ''}`, SOURCE_TEXT[source] ?? source));
  row.append(head);

  const inputs = el('div', 'tune-inputs');
  const current = tuningDraft[field.key] ?? tuningState.values[field.key];
  if (Array.isArray(field.default)) {
    const names = ['slowest', 'slow', 'fast', 'fastest'];
    current.forEach((v, i) => {
      const wrap = el('label', 'tune-part');
      wrap.append(numberInput(v, (text) => {
        const next = [...(tuningDraft[field.key] ?? tuningState.values[field.key])];
        next[i] = text === '' ? '' : Number(text);
        tuningDraft[field.key] = next;
        refreshTuningDirty();
      }), el('span', 'hint', names[i]));
      inputs.append(wrap);
    });
  } else {
    inputs.append(numberInput(current, (text) => {
      tuningDraft[field.key] = text === '' ? '' : Number(text);
      refreshTuningDirty();
    }));
  }
  inputs.append(el('span', 'unit', field.unit));
  row.append(inputs);

  const foot = el('div', 'tune-foot');
  foot.append(el('span', 'hint', field.help));
  const def = Array.isArray(field.default) ? field.default.join(', ') : String(field.default);
  if (!same(tuningState.values[field.key], field.default)) {
    const back = el('button', 'linklike', `back to default (${def})`);
    back.type = 'button';
    back.addEventListener('click', () => {
      tuningDraft[field.key] = Array.isArray(field.default) ? [...field.default] : field.default;
      renderTuning();
      refreshTuningDirty();
    });
    foot.append(back);
  }
  row.append(foot);
  return row;
}

function renderTuning() {
  const form = $('#tuning-form');
  form.replaceChildren();
  let section = null;
  let group = null;
  for (const field of tuningState.fields) {
    if (field.group !== group) {
      group = field.group;
      section = el('div', 'section');
      const head = el('div', 'section-head');
      head.append(el('h2', null, group));
      section.append(head);
      form.append(section);
    }
    section.append(tuningRow(field));
  }
  $('#tuning-undo').disabled = !tuningState.can_undo;
  $('#tuning-file').textContent = tuningState.file ? `Saved to ${tuningState.file}. Only settings changed here are written there.` : '';
}

async function loadTuning({ message = null, cls = 'ok' } = {}) {
  $('#tuning-banners').replaceChildren();
  try {
    const res = await fetch('api/tuning');
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    tuningState = body;
  } catch (err) {
    tuningBanner(`Could not load the tuning: ${err.message}`);
    return;
  }
  tuningDraft = {};
  if (message) tuningBanner(message, cls);
  if (!tuningState.applied) {
    tuningBanner('Control of the lights is off in the app configuration. Changes are saved, but no knob uses them until it is on.');
  }
  for (const p of tuningState.problems ?? []) tuningBanner(p);
  renderTuning();
  refreshTuningDirty();
}

async function tuningCall(method, url, body, done) {
  const res = await send(method, url, body);
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('#tuning-banners').replaceChildren();
    tuningBanner(`Not saved: ${(out.problems ?? [out.error ?? `HTTP ${res.status}`]).join(' · ')}`);
    return false;
  }
  const changed = out.changed ?? [];
  await loadTuning({ message: changed.length ? `${done} ${changed.length === 1 ? '1 setting' : `${changed.length} settings`}${out.applied ? ', applied. Turn a knob.' : '.'}` : 'Nothing changed.' });
  return true;
}

$('#tuning-save').addEventListener('click', async () => {
  const btn = $('#tuning-save');
  btn.disabled = true;
  try {
    const changes = Object.fromEntries(tuningDirtyKeys().map((k) => [k, tuningDraft[k]]));
    await tuningCall('PUT', 'api/tuning', changes, 'Saved');
  } finally {
    btn.disabled = false;
  }
});
$('#tuning-discard').addEventListener('click', () => { tuningDraft = {}; renderTuning(); refreshTuningDirty(); });
$('#tuning-undo').addEventListener('click', () => tuningCall('POST', 'api/tuning/undo', {}, 'Undone:'));

let resetArmed = false;
$('#tuning-reset').addEventListener('click', async () => {
  const btn = $('#tuning-reset');
  if (!resetArmed) {
    resetArmed = true;
    btn.textContent = 'Press again to reset everything';
    setTimeout(() => { resetArmed = false; btn.textContent = 'Reset everything to defaults…'; }, 4000);
    return;
  }
  resetArmed = false;
  btn.textContent = 'Reset everything to defaults…';
  await tuningCall('POST', 'api/tuning/reset', {}, 'Reset');
});

// ── The feed: knob reports and what was sent, while the page is open ───────
function feedRow(e) {
  const row = el('div', `row k-${e.kind}`);
  row.append(el('span', 't', clock(e.ts)), el('span', 'w', label(e)), el('span', 'd', describe(e)));
  return row;
}

async function pollTuningFeed() {
  const qs = new URLSearchParams({ since: String(tuningCursor), kinds: 'inputEvent,control,tuning,alert', limit: '100' });
  try {
    const data = await (await fetch(`api/recent?${qs}`)).json();
    const feed = $('#tuning-feed');
    for (const e of data.events ?? []) {
      tuningCursor = Math.max(tuningCursor, e.seq ?? 0);
      // Position reports are ten a second; the calls they became say more.
      if (e.kind === 'inputEvent' && e.instanceType === 'absoluteInput') continue;
      feed.append(feedRow(e));
    }
    while (feed.childElementCount > 60) feed.firstElementChild.remove();
    feed.scrollTop = feed.scrollHeight;
  } catch { /* next tick */ }
}

async function openTuning() {
  await loadTuning();
  if (tuningFeedTimer) return;
  // Start from now: the feed is for the turn you are about to make.
  try {
    const data = await (await fetch('api/recent?limit=1')).json();
    tuningCursor = data.events?.at(-1)?.seq ?? 0;
  } catch { tuningCursor = 0; }
  $('#tuning-feed').replaceChildren();
  tuningFeedTimer = setInterval(pollTuningFeed, 1000);
}

function closeTuning() {
  if (tuningFeedTimer) clearInterval(tuningFeedTimer);
  tuningFeedTimer = null;
}
