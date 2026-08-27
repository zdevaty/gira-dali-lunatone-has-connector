# DALI bridge on the Raspberry Pi — design

Status: 26 Aug 2026. Sections 1-11 are the design. **Phase 1 is built and
tested** (see below); Phase 2 packaging is written but has never been built on
real hardware. Roll back to the tag `v0.1.0-bench` for the bench build this
started from.

### Build status

| Phase | State |
|---|---|
| 1 — safety | **Done.** Buffered capture store with rotation, retention and a disk floor; monotonic clock; bounded command queue; bounded burst state; crash and signal handling; watchdog thread; single-instance lock; console and capture volume levels; gateway stall detection (section 5). 147 tests, all offline. |
| 2 — packaging | **Written, unbuilt.** The repo root **is** the app (`config.yaml` + `Dockerfile` at top level), so it installs by cloning straight into `/addons`. There is no Docker on the machine it was written on, so the first build on the Pi is the real test. `ingress` and `watchdog` keys are deliberately left commented out until the UI exists behind them. |
| 3 — web UI | Not started. |
| 4 — setup features | Not started. |
| 5 — cutover | Not started, no longer blocked: open question 2 is answered, so the Pi can run alongside the bench instance first. |

Four latent bugs named in section 4 were found in the bench build and fixed:
rows 3, 7, 8 and 11. Each was verified by running its new test against the
previous code and watching it fail. A fifth was introduced and caught by the
end-to-end test during the work itself — an unref'd reconnect timer that made
the daemon exit instead of retry when the gateway was unreachable at startup.

---

## 1. What this actually is

It is easy to read this repo as "a DALI bus logger". It is not, any more.
`lib/control.js` says so in its own header:

> The controllers were switched out of application-controller mode, so nothing
> else on the bus reacts to the knobs any more — every light change now
> originates here.

**This process is the wall switches.** When it is not running, turning a Gira
knob in any of the ten rooms does nothing at all. The bus logging that the
project started as is now a secondary (if still valuable) function.

That single fact drives every decision below. "Extremely reliable" does not mean
"does not lose log lines". It means *the light comes on when someone turns the
knob*, at 23:00, in a house where nobody wants to debug anything.

### The chain, honestly

```
Gira knob → DALI bus → Lunatone gateway → WebSocket → THIS DAEMON
                                                          ↓ REST
                                                    Home Assistant
                                                          ↓ REST
                                            Lunatone gateway → DALI bus → driver → light
```

Seven hops. We own one of them. Two consequences worth saying out loud:

- **Home Assistant is a hard dependency of the wall switches.** If HA is
  restarting, the knobs are dead for those ~30 seconds, and there is nothing
  this daemon can do about it — the only alternatives are writing to the bus
  (forbidden) or re-commissioning the gateway's internal bindings (also
  a bus write, and it would take Adaptive Lighting out of the loop).
  The design cannot fix this. It *can* avoid adding to it, and it can make the
  outage visible instead of mysterious.
- **Our own contribution to downtime is the only part we control**, so it should
  be as close to zero as we can make it, and every failure should be loud.

### Constraints that outrank everything else

1. **The DALI bus is strictly read-only.** The daemon never transmits a frame.
   One bad write can erase a device's commissioning.
2. **The Home Assistant token never touches disk.** (Section 10 removes it
   entirely on the primary path.)
3. **The captures in `logs/` are real data**, not test debris.
4. **An unknown opcode stays `unknown`.** No invented names, no guessed
   addresses, no default `gear`.

---

## 2. Where it runs

### The decision depends on one fact I could not check tonight

The Pi was powered down, so this is the first thing to establish:

> **Settings → System → Repairs → ⋮ → System information → Installation Type**

| Installation type | Available | Recommendation |
|---|---|---|
| **Home Assistant OS** | app only (the OS is a locked appliance) | **App** |
| **Supervised** | app *or* systemd | **App** |
| **Container** (HA in Docker) | systemd *or* a sibling container | **systemd** |
| **Core** (venv) | systemd | **systemd** |

A Pi 4 running HA is HAOS in the large majority of cases, so the app is the
primary path and gets the detailed design. The systemd path is a genuine
fallback, not an afterthought — section 11.2 specifies it fully.

**This choice does not fork the code.** The daemon is one runtime-neutral core
with a thin adapter per environment (config source, HA credentials, paths). The
adapters are a few dozen lines each.

### Why an app, when systemd has fewer moving parts

systemd is the leaner mechanism, and on any other box I would pick it. The
app wins here because of what it gives us for free, none of which is
cosmetic:

- **Ingress**: a web UI inside the HA sidebar, at HA's own URL, behind HA's own
  login, reachable from the HA phone app without exposing a port or inventing an
  auth system. This is the whole answer to "simple access to setup and
  monitoring", and it is worth a great deal on its own.
- **`homeassistant_api: true`**: the Supervisor injects a scoped
  `SUPERVISOR_TOKEN` and proxies `http://supervisor/core/api`. **The long-lived
  token disappears from the design completely** — nothing to store, nothing to
  leak, nothing to expire at an inconvenient moment.
- **Supervisor watchdog + `boot: auto`**: restart on crash, restart on hang,
  start on boot, without writing a unit file.
- **Config UI with a typed schema**, and `/data` included in HA's backups.

The cost is Docker and the Supervisor in the dependency chain. On HAOS they are
already there and already carrying HA itself, so this adds no new failure domain.

---

## 3. Architecture

**One process.** The alternative — splitting the UI from the bridge so a UI bug
cannot touch the wall switches — is the textbook answer, and I rejected it: an
app is one container, so two processes means an init system (s6) inside it,
IPC, and two things to supervise, to buy isolation from a UI that serves maybe
five requests a day. At this size, fewer moving parts *is* the reliability
strategy. Instead the UI is contained by rule (section 6.3) and a wedged event
loop is caught by a watchdog thread (section 4.1).

The trigger to revisit: if the UI ever does real work — rendering large
captures, running analyses — split it then.

```
src/
  main.js            entry: build config, wire, start, signals, crash handler
  runtime/
    config.js        env + /data/options.json + defaults; validate; redact
    devices.js       devices.json: load, validate per-entry, atomic save, hot reload
    tuning.js        live-tunable behaviour (speed curve, flush, gains)
    clock.js         monotonic time; wall time; step detection
    lock.js          single-instance lock
    watchdog.js      worker thread; kills a wedged process
    sdnotify.js      systemd Type=notify + WatchdogSec (systemd path only)
  gateway/
    client.js        WS connect, backoff, one decoded frame out
    liveness.js      read-only GET /info probe + stall policy
  dali/
    decoder.js       UNCHANGED from v0.1.0-bench
    anomaly.js       + bounded burst buffers
  bridge/
    control.js       UNCHANGED except: monotonic clock, stale-call dropping
    discover.js      UNCHANGED
  ha/
    client.js        REST; SUPERVISOR_TOKEN or long-lived token
    sensors.js       optional: publish status sensors into HA
  obs/
    logstore.js      buffered async JSONL, rotation, retention, disk floor
    ring.js          fixed-size in-memory recent events
    health.js        health snapshot; event-loop lag
    console.js       human-readable stdout, level-controlled
  ui/
    server.js        node:http; routes; SSE
    public/          index.html, app.js, style.css — no build step
config.yaml          app manifest -- the repo root IS the app directory
Dockerfile           node:22-alpine; build context is the repo root
DOCS.md              the app's Documentation tab
translations/        friendly option labels for the app config UI
deploy/systemd/      dali-bridge.service, install.sh
docs/DESIGN.md       this file
```

`lib/` becomes `src/` in one commit that changes paths and imports only,
verified by the existing 94 tests. **`decoder.js` is not touched.** It is the
piece validated byte-by-byte against real captures, and it has no business
changing during a deployment project.

### Data flow

```
gateway WS ─→ decode ─→ ┬─→ ring buffer ──→ UI (SSE)
                        ├─→ logstore (buffered, async)
                        ├─→ console (level-filtered)
                        ├─→ anomaly detectors ──→ alerts
                        ├─→ control.observeLevel   (arc levels = ground truth)
                        └─→ control.handleEvent ──→ HA REST ──→ lights
```

One decoded frame fans out to five consumers, none of which may block the
others. Today `writeEvent` blocks all of them (section 7).

---

## 4. Reliability: the failure table

This is the core of the design. Each row is a way the wall switches die, how we
notice, and what we do. Rows marked **new** do not exist in the bench build.

| # | Failure | Symptom today | Detection | Mitigation |
|---|---|---|---|---|
| 1 | Process crashes | Switches dead until someone notices | Supervisor sees the container exit | `boot: auto` + watchdog; restart in ~2 s. Crash handler writes a `crash` event to the log first **(new)** |
| 2 | Event loop wedged (process alive, doing nothing) | Switches dead, everything looks healthy | Watchdog worker thread stops getting heartbeats **(new)** | Worker `SIGKILL`s the process; supervisor restarts it |
| 3 | **SD-card write stall** | Every frame blocks on `appendFileSync`; a stalled card freezes the bridge for seconds | Event-loop lag metric **(new)** | Buffered async writes; no `*Sync` fs calls outside startup **(new)** |
| 4 | WebSocket half-open (TCP black hole) | Frames silently stop; process healthy; switches dead | Read-only `GET /info` probe succeeds while the WS has been silent **(new)** | Abandon the socket and reconnect. Threshold backs off on a quiet bus — see section 5 |
| 5 | Gateway reboots / LAN blip | `close`/`error` fires | Already handled | Backoff reconnect; only reset the backoff after the link has been stable 30 s **(new — today a flapping link resets it every time)** |
| 6 | HA restarts | Calls fail for ~30 s | `ha_unreachable` alert (exists) | Drop calls, never queue; recover automatically |
| 7 | **HA slow → call backlog** | `st.chain` serialises calls behind a 5 s timeout. 10 events/s during a 30 s HA stall queues minutes of stale brightness writes that land long after the hand left the knob | Chain depth + queue age **(new)** | Drop any queued call older than `staleMs` (~1 s); cap chain depth; count and alert **(new)** |
| 8 | **Clock steps at boot** (the Pi has no RTC) | `now()` is `Date.now()`. A backward NTP step puts `lastFlush` in the future and `scheduleFlush` arms a timer for the size of the step — **a knob dead for as long as the correction** | Wall-vs-monotonic delta **(new)** | All interval logic on `performance.now()`; wall clock only for display and filenames **(new)** |
| 9 | Disk fills | HA goes down with it | Free-space check every 60 s **(new)** | Pause frame logging (keep alerts), keep bridging, alert. **HA's disk outranks our capture** |
| 10 | SD card wears out | Corruption, eventually unbootable | Write-error counter **(new)** | Batched writes, gzip, size cap; USB SSD recommended |
| 11 | **Unbounded colour burst** | `anomaly.js` pushes every sample into one array while frames keep arriving <2 s apart; `Math.max(...samples)` throws `RangeError` past ~100k entries and kills the process | — | Rolling window + incremental min/max **(new)** |
| 12 | One malformed frame throws | Killed the process once already (`bytes.map is not a function`) | Per-frame try/catch + counter **(new)** | Isolate the frame, keep running, alert on rate |
| 13 | Two instances running (WSL one left on after cutover) | Every gesture sent to HA twice | Local lockfile; instance id in the startup line **(new)** | Refuse to start locally; cross-host case documented |
| 14 | Config typo | Wrong room's light moves | Preflight (exists) | Fatal only where proceeding would be *wrong*; a bad entry is skipped, not fatal (section 9) |
| 15 | Memory leak | OOM, or the Pi swaps and HA suffers | RSS in health **(new)** | Bounded structures; `--max-old-space-size=128` so we die cleanly and restart instead of dragging HA down |
| 16 | Gateway IP changes (DHCP) | Reconnect loops forever | Connection alert (exists) | Static DHCP lease — a deployment requirement, not a code fix |
| 17 | Power cut mid-write | Truncated last JSONL line | — | Append-only; readers tolerate a partial final line |

Rows 3, 7, 8 and 11 are latent bugs in the current build that the bench never
exposed. Nothing about them is speculative — 7 and 8 follow directly from the
code as written, and 11 is a `RangeError` waiting for a long enough burst. **They
are the reason this is a design project and not a packaging exercise.**

### 4.1 The two watchdogs, and what each is allowed to conclude

- **Supervisor watchdog** → `GET /api/alive`. This endpoint reports **only our
  own liveness**: HTTP server answering, heartbeat fresh. It must **never** go
  unhealthy because Home Assistant or the gateway is down — restarting us would
  not fix either one, and would cost wall-switch availability for nothing. A
  common and expensive mistake; worth stating in the code comment too.
- **Watchdog worker thread** → catches the case the Supervisor cannot: the
  process is up and the socket accepts, but the event loop is blocked. The main
  thread posts a heartbeat every second; if the worker misses it for 15 s it
  `SIGKILL`s the process. ~30 lines, no dependencies.
- On the systemd path, `sd_notify` + `WatchdogSec=30` does the same job natively.

Crash-loop protection: the Supervisor raises an alert if an app dies ten
times in 30 minutes, so transient failures are handled with internal backoff and
never by exiting.

---

## 5. What the daemon does about the gateway link

Two independent signals, because a silent WebSocket and an idle bus look
identical from inside:

1. **`GET /info`** on the gateway every 30 s. Documented, read-only, and it
   returns bus health (`errors`, `lines`) which the health page can show.
   A `GET` can never put a frame on the bus.
2. **WS message silence.** If (1) is answering while the WS has produced nothing
   for `wsIdleMs`, the socket is the problem. Reconnect.

The gateway's own protocol has a `PingEvent` with an `echo` field, so an active
keepalive is possible — but it means *sending* on the socket, and this daemon
currently sends nothing at all. It stays off, and the `GET /info` probe gives us
stall detection without sending anything.

### Measured, 27 Aug 2026 — firmware v1.18.7/1.4.6

Watched one monitor socket for 300 s against the real gateway on an idle bus:

```
message types      : {"info":1}      ← the greeting, on connect
longest silence    : 300s
gateway closed us  : no, held the whole time
unprompted keepalive: NO
```

**There is no keepalive.** The gateway greets a new connection with one `info`
message and then says nothing whatsoever until the bus does. It also never drops
an idle client. Two consequences, both load-bearing:

1. **The HTTP probe is not a nicety, it is the entire mechanism.** Silence cannot
   distinguish a dead socket from a quiet bus, so where the probe endpoint is
   missing, stall detection must switch **off** rather than guess. That is what
   `gateway_probe_unavailable` does.
2. **The naive rule reconnects all night.** A quiet bus is silent for hours, so
   "silent for 120 s while HTTP answers" would fire roughly 700 times before
   morning. So each silence-triggered reconnect that turns up no real bus traffic
   **doubles** the threshold, capped at an hour; genuine bus traffic resets it.
   A stall during an active evening is still caught in about two minutes, while a
   quiet night costs a handful of reconnects.

The greeting is deliberately *not* counted as bus traffic for that reset — it
arrives on every reconnect, so treating it as evidence the bus is alive would
defeat the back-off entirely.

### Killing a socket that has stopped answering

`ws.close()` is not enough, and the end-to-end test proved it: closing opens a
*handshake* and waits for the peer to close back — and the socket worth killing
is precisely the one that has stopped answering, so that event may never arrive.
The daemon asks politely, then stops waiting after a 2 s grace and takes the
reconnect path regardless. The abandoned socket keeps its listeners, but the
disconnect handler is guarded, so a late close cannot cause a second reconnect.

---

## 6. The web UI

### 6.1 Pages

**Now** — the landing page. A status strip (bus / HA / bridge / uptime /
version), the live decoded frame stream with filter chips and pause, and the
recent-alerts rail. This is what you leave open on a second screen while
poking at the installation.

**Commissioning** — *the feature that earns the UI its place.* Addresses are
handed out by random search, so mapping ten rooms means walking the flat and
finding out which knob is which. The page shows every address seen on the bus,
and **the row lights up the instant that address speaks**. So:

> Walk into the bedroom. Turn the knob. The phone in your hand highlights
> `A6`. Pick `light.bedroom` from the dropdown. Tap *Find the driver* — it
> probes through HA and fills in `gear: short11`. Next room.

Mobile-first, because you are standing in a room with a phone, not sitting at a
desk. This replaces hand-editing `devices.json` for a job that is otherwise
genuinely tedious and easy to get wrong.

**Tuning** — the speed curve, ramp, flush window, divergence threshold, gains,
minimum brightness. **Applied live, no restart**, because tuning how a knob
*feels* is inherently iterative: turn, watch the log, adjust, turn again. A
restart in that loop costs switch availability and breaks concentration.

**Health** — uptime, RSS, event-loop lag, frames/min, reconnects, HA call
success rate, gateway bus errors, clock-sync state, disk used and free, and an
honest projection: *"at the current rate: 34 MB/day; 30-day retention will use
1.0 GB"*.

**Captures** — list, size, download, gzip state; *Export to /share* for a
capture worth keeping; *Mark now*, which writes a marker event into the log so
that "it just did the weird thing" is findable afterwards.

### 6.2 Transport

Server-sent events, with a **polling fallback**: if the browser sees no SSE
message within 5 s it switches to polling `/api/recent?since=<seq>` every
second. Both are served from the same fixed-size ring buffer, so the fallback is
a few lines rather than a second implementation. This exists because
`ingress_stream` is off by default and proxy buffering is exactly the kind of
thing that works on the bench and not in the sidebar. `ingress_stream: true` is
set; the fallback means a live view even if it misbehaves.

A comment heartbeat every 15 s keeps idle proxies from closing the stream.

### 6.3 Rules that keep the UI away from the wall switches

- The UI **reads snapshots**. It never touches gesture state directly.
- Fixed-size ring buffer (2000 events). Capped SSE clients. Slow consumers are
  dropped, not buffered.
- One concurrent capture download, streamed with backpressure.
- Every handler wrapped; a UI exception can never reach the frame path.
- No synchronous filesystem work in any handler.

### 6.4 Security

Under ingress, HA has already authenticated the viewer, so the app adds no
login — but it **only accepts connections from `172.30.32.2`** (the Supervisor),
per the ingress requirement, and the port is never published to the LAN.

Standalone (systemd), there is no such gate: the UI binds `127.0.0.1` by
default, and binding anywhere else **requires** `UI_TOKEN` or the daemon refuses
to start. Mutating routes are POST/PUT only and reject cross-origin requests.

There is no route, anywhere, that can send a DALI frame. The gateway module
issues `GET` only, and a test asserts the module contains no other method.

---

## 7. Storage and the SD card

An SD card is the least reliable component in the building, and continuous
logging is exactly the workload that kills it. It is also HA's disk: filling it
takes the whole house down, which is a far worse outcome than losing a capture.

- **Buffered async append.** Lines accumulate and flush on a 250 ms timer or at
  64 KB, through one `createWriteStream(…, {flags:'a'})` per day file. Replaces
  the current open/write/close-per-frame.
- **Backpressure.** If the stream backs up beyond a threshold, drop the oldest
  *frame* events (never alerts) and count the drops.
- **Rotation** at local midnight. `dali-YYYY-MM-DD.jsonl`, **local date** —
  a human debugging "what happened at 22:04" wants that in last night's file,
  not split across two by UTC. Timestamps inside stay ISO-8601 UTC.
- **Retention**: gzip after 1 day; delete beyond 30 days, or oldest-first while
  the total exceeds 512 MB. Only files matching
  `^dali-\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$` in our own directory. Never today's.
  Every deletion is logged as an event.
- **Free-space floor**: below 256 MB free, stop writing frames, keep writing
  alerts, keep bridging, alert loudly. Resume when space returns.
- **Gzip is streamed, never synchronous.** Gzipping a 40 MB capture on the main
  thread would freeze the bridge for seconds — precisely the kind of "reliable
  housekeeping breaks the actual job" bug worth naming.
- **Volume control**: `log_frames: all | decoded | events | alerts`. `all` while
  debugging; the health page shows what it costs per day.
- **Console**: `quiet` by default in the app. stdout goes to the app log,
  which is also the SD card — printing every frame writes it twice.

**Location**: `/data/logs`, with `backup_exclude: ["logs/**"]` so hundreds of
megabytes of captures stay out of every HA backup. `/data` is wiped if the
app is uninstalled, so *Export to /share* is a one-click button and the
uninstall warning is in the app docs. Captures worth keeping get kept
deliberately, which is how this project already treats them.

---

## 8. Time

The Pi has no real-time clock. It boots believing it is whenever it last was,
and NTP corrects it seconds later — possibly by hours, in either direction.

Everything that measures an interval moves to `performance.now()`: the flush
throttle, the hold grace window, the response-pairing window, the correlation
window, backoff. Wall-clock time is used only for `ts` fields and log filenames.

Without this, a backward step of one hour arms a flush timer an hour into the
future and **that knob is dead for an hour**, with nothing in the log to explain
it. It would be diagnosed as a hardware fault.

A clock-step detector compares wall and monotonic deltas each second and emits
`clock_step` when they disagree by more than a second, so the log says so.

---

## 9. Configuration

**One source of truth per value.** Two places to set the same thing is a
reliability bug, not a convenience.

| What | Where | Changed by | Restart? |
|---|---|---|---|
| Infrastructure (gateway host, log volume/retention, console level, control on/off) | app options → `/data/options.json` | HA app Config tab | yes (app restart) |
| Device map (address → entity, kelvin range, gear) | `/data/devices.json` | **the UI** | no — hot reload |
| Behaviour tuning (speed curve, flush, gains, thresholds) | `/data/tuning.json` | **the UI** | no — live apply |

Tuning parameters are deliberately **not** app options: they belong to the
thing that can change them live and show you the effect.

**Validation is split by consequence:**
- *Fatal* — the daemon cannot do its job at all (no gateway host). Refuse to
  start, say precisely why.
- *Skip and shout* — one malformed `devices.json` entry disables **one** knob
  and is logged. It must not prevent startup: refusing to start over one bad
  entry means every knob in the flat is dead instead of one. When availability
  is the requirement, partial validity beats all-or-nothing.
- *Warn* — a kelvin range outside what HA reports is clamped and noted.

`devices.json` is written atomically (temp + rename) with a `.bak` of the
previous version.

---

## 10. Credentials

On the app path the long-lived token **ceases to exist**:
`homeassistant_api: true` makes the Supervisor inject `SUPERVISOR_TOKEN` and
proxy `http://supervisor/core/api`. Nothing to store, nothing to rotate, nothing
to leak, and it cannot expire mid-gesture.

On the systemd path the token lives in `/etc/dali-bridge/env`, mode `0600`,
owned by the service user, `EnvironmentFile=`d in — never in the repo, never in
a log. `.gitignore` covers `.env*`.

A test scans the tracked tree for token-shaped strings and fails the suite if
one appears. The existing preflight rule stands: `token=present (N chars)`,
never the value.

---

## 11. Packaging

### 11.1 The app (primary)

```yaml
name: DALI Bridge
version: "0.2.0"
slug: dali_bridge
description: Read-only DALI bus monitor and Gira rotary bridge for a Lunatone DALI-2 IoT gateway
arch: [aarch64, amd64]
init: true            # node:22-alpine has no s6; Docker's init reaps and forwards SIGTERM
startup: services     # start before Home Assistant; the gateway link does not need HA
boot: auto
stage: experimental

ingress: true
ingress_port: 8099
ingress_stream: true  # server-sent events must not be buffered by the proxy
panel_icon: mdi:lightbulb-group
panel_title: DALI
panel_admin: true

# Our own liveness only. Never unhealthy because HA or the gateway is down:
# restarting us would not fix either, and would cost switch availability.
watchdog: http://[HOST]:[PORT:8099]/api/alive

homeassistant_api: true   # SUPERVISOR_TOKEN; no long-lived token anywhere

map:
  - type: share
    read_only: false      # only for "export this capture"

backup: hot               # never take the wall switches down for a backup
backup_exclude: ["logs/**"]

environment:
  NODE_OPTIONS: "--max-old-space-size=128"

options: {gateway_host: "", control_enabled: true, log_frames: all,
          log_retention_days: 30, log_max_mb: 512, console: quiet}
schema:  {gateway_host: str, control_enabled: bool,
          log_frames: "list(all|decoded|events|alerts)",
          log_retention_days: "int(0,3650)", log_max_mb: "int(16,102400)",
          console: "list(pretty|quiet|off)"}
```

`Dockerfile`: `FROM node:22-alpine`, copy source, `CMD ["node","src/main.js"]`.
No `npm install` — there are no dependencies, so there is no lockfile to drift,
no supply chain, and nothing to fetch at build time. Pin the base by digest once
the first build on the Pi records one.

`translations/en.yaml` gives every option a friendly name and help text in the
config UI. `DOCS.md` becomes the Documentation tab.

**Getting it there**: the manifest sits at the repo root precisely so the whole
thing installs with a clone. From the Terminal app (`git` ships in it):

```sh
git clone https://github.com/zdevaty/gira-dali-lunatone-has-connector /addons/dali_bridge
```

Then App store → ⋮ Check for updates → *Local apps*. Updating is
`git pull` in that directory, bump `version` in `config.yaml`, then Update.

The alternative — publishing this as an app *repository* (a `repository.yaml`
at the root, app in a subdirectory) so the Supervisor clones and updates it
itself with no shell at all — was considered and deferred. The Docker build
context is the app subdirectory, so it would force the entire application
down one level and rewrite every test import for a one-click update button. Not
worth it yet; revisit if updating becomes a chore.

### 11.2 systemd (fallback)

`Type=simple`, `Restart=always`, `RestartSec=2`, and critically
**`StartLimitIntervalSec=0`**: the default start limit gives up permanently
after five rapid failures, which is the exact opposite of what a service behind
physical wall switches should do.

*Revised while building:* this originally specified `Type=notify` with
`WatchdogSec=30` and an sd_notify implementation. The watchdog worker thread
(section 4.1) turned out to cover the same failure — a wedged event loop —
identically under both the Supervisor and systemd, so sd_notify would be a
second mechanism for one failure and one more thing to get wrong. Dropped.

Hardened with `DynamicUser`/dedicated user, `ProtectSystem=strict`,
`NoNewPrivileges`, an empty `CapabilityBoundingSet`, `MemoryMax=200M`, and
`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`.

---

## 12. Rollout

Deployment assumptions are the least-tested part of this whole plan, so they get
tested first — while the bench instance keeps the lights working.

1. **Phase 1 — safety (offline).** Buffered writer, rotation/retention/floor,
   monotonic clock, bounded anomaly buffers, stale-call dropping, crash and
   signal handling, single-instance lock, console levels. All unit-testable on
   WSL. No decoder or gesture-logic changes.
2. **Phase 2 — deploy in observe-only.** Package, install on the Pi with
   `control_enabled: false`. It logs; it touches nothing. Answers the open
   questions in section 14 with zero risk. The WSL instance keeps bridging.
3. **Phase 3 — the UI.** Monitoring pages first, then commissioning.
4. **Phase 4 — setup features.** Device-map editing, live tuning, discovery from
   the UI, optional HA status sensors.
5. **Phase 5 — cutover.** Stop the WSL instance, enable control on the Pi. Then
   the chaos checklist below.

**Rollback** at any point: `git checkout v0.1.0-bench` and run it on WSL exactly
as before.

---

## 13. Verification

Unit tests stay offline and dependency-free (94 today; every new module adds
its own). Plus, on the real Pi:

| Test | Expected |
|---|---|
| `kill -9` the process | Back in ~2 s; a knob works immediately after |
| Reboot the Pi | Bridge up with or before HA; knobs work |
| Unplug the gateway 60 s | `connection disconnected` alert; reconnect within 5 s of replug |
| Stop HA Core | `ha_unreachable`; knobs do nothing (documented); **recovery without a daemon restart** |
| Step the clock ±1 h | Knobs keep working; `clock_step` logged |
| Fill the disk to the floor | Frame logging pauses; bridging continues; alert raised |
| Block the event loop (fault injection) | Watchdog kills and restarts within 15 s |
| 24 h soak | RSS flat, event-loop lag p99 < 100 ms, zero unhandled errors |
| Synthetic 10× frame rate | No dropped gestures, no backlog |

The clock-step and disk-full tests matter most: they are the two failures that
would otherwise be diagnosed as haunted hardware.

---

## 14. Open questions — to be answered on real hardware

1. ~~**Which HA installation type?**~~ **Answered 27 Aug, by inference.**
   `GET /api/hassio/app/entrypoint.js` on the HA host returns **401, not 404** —
   the route is registered, which only happens when the `hassio` integration is
   loaded. So the Supervisor is present: HAOS or Supervised, and **the app
   path is available**. Worth ten seconds in System information to confirm
   directly, but the packaging can proceed on it.
2. ~~**Does the gateway accept two concurrent WebSocket monitor clients?**~~
   **Answered 27 Aug: yes, fully.** Two sockets held open across a real knob
   gesture received **29 frames each, byte-for-byte identical** -- start_right,
   the absolute counter climbing 96 -> 151, start_left, then 150 -> 70. Neither
   client was starved and neither was dropped. **The observe-only parallel run in
   Phase 2 is safe**, so the Pi can watch the bus alongside the bench instance
   before it takes over anything.

   Incidentally the first live decode by the current build: one gesture is about
   29 frames, which is the number to size capture volume from.
3. ~~**Does the gateway emit `PingEvent` unprompted?**~~ **Answered 27 Aug: no.**
   One `info` greeting on connect, then 300 s of complete silence on an idle bus,
   and it never dropped the client. See section 5 — this is why the HTTP probe is
   the whole mechanism and why the idle threshold backs off.
4. **Is the Pi booting from SD or USB?** Decides how hard to push on log volume.
5. **What is HA's actual restart frequency here?** It is the dominant source of
   switch downtime and we should measure it rather than assume.
6. ~~**Is `TZ` passed into app containers?**~~ **Answered 27 Aug: yes.** The
   first run on the Pi reported `Europe/Prague` in its startup line, matching
   Home Assistant's own setting rather than UTC. Capture files therefore roll at
   local midnight as intended.
7. **How long does a real reconnect take against the real gateway?** Against the
   fake it is about a second. It sets how much of a gesture a stall costs.

---

## 15. Explicitly not in this design

- **Rewriting as a HA custom integration.** The most HA-native option: config
  flow, real entities, no separate service. Rejected — it means rewriting a
  decoder that took real measurement to get right, in a runtime where a bug in
  our code can take Home Assistant down with it. The app gets us the same UI
  integration with a blast radius of one container.
- **Node-RED / AppDaemon / pyscript.** Same rewrite cost, worse latency for a
  175 ms control loop.
- **HA WebSocket transport instead of REST.** Genuinely better — one persistent
  connection, live `state_changed` instead of a GET per gesture, immediate HA
  restart detection. Deferred because the REST path is validated on real
  hardware and this project has enough moving parts already. The HA client is
  behind an interface so this is a swap, not a rewrite. **Phase 6.**
- **SQLite instead of JSONL.** Would give the UI indexed queries. JSONL stays:
  append-only is the kindest workload for an SD card and the friendliest to a
  power cut, and `grep` still works. Revisit if querying gets painful.
- **Log rotation as a general feature** was explicitly out of scope for the
  debug phase. It is in scope now because 24/7 on HA's own SD card is a
  different problem from a bench session.
- **`narrow_cct_range` scoping** to broadcast targets — still open, still
  waiting on your word, unchanged by any of this.
- **The anomaly-detector feedback loop** (our own output re-entering the
  detectors) — still unaddressed, still worth doing, not a deployment concern.
