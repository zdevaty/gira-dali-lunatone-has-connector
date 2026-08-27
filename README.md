# DALI bus logger + controller

Listens to a Lunatone DALI-2 IoT Gateway over WebSocket, decodes the bus traffic into
readable events, logs it as JSONL, flags suspicious patterns — and, since the Gira
controllers were switched to input-device mode, translates their knob gestures into
Home Assistant calls.

**The bus stays strictly read-only.** The daemon never transmits a DALI frame. Lights are
changed by asking Home Assistant, which asks the gateway. One bad write on the bus can
erase a device's configuration, so there is no code path that sends.

Zero dependencies, Node 22+.

## Quick start

```bash
# log only — no Home Assistant needed
CONTROL_ENABLED=false GATEWAY_IP=10.0.0.230 LOG_DIR=./logs node index.js

# full control
GATEWAY_IP=10.0.0.230 LOG_DIR=./logs \
  HA_URL=http://localhost:8123 HA_TOKEN=<long-lived-token> \
  DEVICE_MAP=./devices.json node index.js
```

```bash
npm test   # 147 tests, all offline
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `GATEWAY_IP` | — | **Required.** Gateway address, e.g. `10.0.0.230`. |
| `LOG_DIR` | — | **Required.** Directory for JSONL logs. |
| `CONTROL_ENABLED` | `true` | `false` = log only, never call HA. |
| `HA_URL` | `http://localhost:8123` | Home Assistant base URL. |
| `HA_TOKEN` | — | Required when control is enabled. |
| `DEVICE_MAP` | — | Required when control is enabled. Path to the JSON below. |
| `FLUSH_MS` | `200` | Minimum gap between HA calls per device. |
| `SPEED_CURVE` | `2,25,55,80` | Step size for each of the encoder's four rotation speeds, slowest first. |
| `RAMP_EVERY_REPORTS` | `2` | Reports of continued turning at an end stop before climbing one tier. |
| `BRIGHTNESS_GAIN` | `1.0` | Multiplier on brightness deltas. |
| `MIN_BRIGHTNESS` | `3` | Dimming floor; the knob never switches the light off. |
| `DISCOVER_GEAR` | `false` | `true` = probe every mapped light once at startup to measure the gear mapping. Changes lights briefly; restores them. |
| `MIN_CORRELATIONS` | `3` | Consistent observations before a measured gear mapping is accepted. |
| `LEVEL_DIVERGENCE` | `20` | How far HA's brightness may differ from the arc level on the bus before the bus is believed instead. |
| `COLOUR_GAIN` | `1.0` | Multiplier on colour deltas. |
| `CCT_BURST_MIN_SAMPLES` | `8` | Min samples before a narrow-range alert can fire. |
| `CCT_SPAN_THRESHOLD` | `40` | Mired span below which a burst is "narrow". |
| `LOG_FRAMES` | `all` | How much of the bus reaches the capture: `all`, `decoded` (no raw frames), `events` (only what the bridge did), `alerts`. |
| `CONSOLE` | `pretty` | `pretty` = every event, `quiet` = alerts and light changes only, `off` = nothing. |
| `LOG_RETENTION_DAYS` | `30` | Captures older than this are deleted. `0` = keep until the size cap decides. |
| `LOG_MAX_MB` | `512` | Total capture size; over it, the oldest go first. Today's is never deleted. |
| `LOG_MIN_FREE_MB` | `256` | Below this much free disk, stop capturing frames and keep bridging. |
| `WATCHDOG` | `true` | Worker thread that kills the process if the event loop wedges. |
| `WATCHDOG_TIMEOUT_MS` | `15000` | How long the event loop may be unresponsive first. |
| `GATEWAY_PROBE_PATH` | `/info` | Read-only endpoint used as a second opinion on whether the gateway is alive. |
| `GATEWAY_PROBE_MS` | `30000` | How often to ask it. |
| `GATEWAY_IDLE_MS` | `120000` | Socket silence, with the gateway answering HTTP, before the socket is treated as dead. Doubles up to an hour while the bus stays genuinely quiet. |

The daemon refuses to start with a plain error (no stack trace) if `GATEWAY_IP`/`LOG_DIR`
are missing, or if control is enabled without `HA_TOKEN`/`DEVICE_MAP`.

### Startup preflight

When control is enabled the daemon checks Home Assistant before it touches the bus, and says
precisely what is wrong if anything is. It is **never fatal** — bus logging continues either
way, because the log is useful even with HA down — but it is loud, since a daemon that cannot
reach HA otherwise looks exactly like one with nothing to do.

```
07:14:09  HA     config   url=http://10.0.0.101 token=present (183 chars)
07:14:09  HA     dns      status=ok host=10.0.0.101 address=10.0.0.101 family=IPv4
07:14:09  HA     api      status=ok httpStatus=200 message=API running.
07:14:09  HA     entity   status=ok address=0 entity=light.line_0_dali_00 state=off supported_color_modes=color_temp ha_kelvin_range=1000..10000 configured_kelvin_range=2700..6500
07:14:09  HA     result   status=ok
```

It checks, in order, stopping when a step makes the rest pointless:

| Step | Catches |
| --- | --- |
| `config` | Malformed `HA_URL`; confirms a token is present (**never logs the token**) |
| `dns` | Hostname doesn't resolve — including the `.local`/mDNS case, with the fix named |
| `api` | 401 bad/expired token · 403 forbidden · 404 wrong port · refused/no route/timeout |
| `entity` | Entity missing from HA · can't do `color_temp` · configured range differs from HA's |

Failures are logged as `ha_preflight_failed` with a `step`, a `reason`, and a `hint`. Network
errors are diagnosed rather than passed through as Node's bare `fetch failed`:

```
07:13:55  ALERT  HA preflight [dns]: hostname "homeassistant.local" does not resolve
          hint: .local names need mDNS, which WSL2 and many containers cannot resolve.
                Use the numeric IP in HA_URL instead.
```

### `devices.json`

Keyed by the **control device's** short address — the one in the event, not the driver's.

```json
{
  "0": { "entity": "light.obyvak",  "min_kelvin": 2700, "max_kelvin": 6500, "gear": "short0" },
  "1": { "entity": "light.loznice", "min_kelvin": 2700, "max_kelvin": 6500, "gear": "short1" }
}
```

An event from an address that isn't listed logs `unmapped_device` once and is ignored.

`gear` is which **control gear** address on the bus this knob's light answers to. It is what
lets the daemon check Home Assistant's brightness against the arc level actually on the wire.

**There is no default, deliberately.** Addresses are handed out by random search during
commissioning, independently in the two address spaces, so the bedroom's knob might come out
as A3 while the bedroom's driver comes out as A7. Two devices agreeing is a coincidence of a
particular bench, not a rule. And this value is not cosmetic: a wrong mapping makes the
daemon take another room's arc level, add the knob delta, and write it as *this* light's
absolute brightness. A missing mapping is visible in the log; a wrong one is not.

Left out (or `null`), the cross-check is **skipped** for that device rather than guessed.

### Two ways the daemon works the mapping out itself

Neither writes to the DALI bus. Both ask Home Assistant to move a light and watch which
control-gear address answers — HA drives the gateway, exactly as it does for a knob.

**Active, on demand — `DISCOVER_GEAR=true`.** Probes every mapped entity one at a time,
watches which gear responds, and prints a block ready to paste into `devices.json`. A whole
flat is mapped in one pass with nobody touching a knob:

```
gear   start devices=2 note=probing one light at a time via Home Assistant; the DALI bus is not written to
gear   A0 light.line_0_dali_00 = short7
gear   A1 light.line_0_dali_01 = short3
gear   result mapped=2 of=2
gear   paste into devices.json: { "0": {"gear": "short7"}, "1": {"gear": "short3"} }
```

It is **opt-in** because it visibly changes every mapped light for a second or two. Each
light is read first and put back exactly as it was found, including "it was off". Probes run
strictly one at a time — two lights moving at once makes every frame ambiguous — and a gear
only counts if the level it reported lands near the brightness that was asked for, so
Adaptive Lighting nudging another room mid-probe is not mistaken for an answer. Two gears
answering one probe is reported as `ambiguous` and mapped to nothing. If anyone turns a knob
while it runs, the whole thing aborts: their traffic would corrupt the result, and probing
lights someone is using is rude besides.

**Passive, always on.** Without `DISCOVER_GEAR` the daemon still learns, from the calls it
makes anyway during normal use.

It never needs to touch the bus to do it. The daemon knows when it caused a change, so an
arc level arriving right after one of its own HA calls is evidence of which gear that entity
drives:

```
called light.turn_on on light.obyvak → level frame for short7 within 500 ms → obyvak = short7
```

Measured on the 26 August log, the gap from a control call to the resulting level frame has a
median of **101 ms**, with 770 of 922 calls inside the 500 ms window — and 6% of level frames
have no call of ours in front of them at all (Adaptive Lighting moving the light on its own),
which is why one coincidence is never enough. A mapping is only accepted after
`MIN_CORRELATIONS` consistent observations with a clear winner, and frames naming no single
gear (broadcast, group) are ignored entirely.

- Nothing configured → the measured mapping is used and logged as `gear_mapping_learned`,
  so you can paste it into `devices.json` and make it explicit.
- Configured and it agrees → nothing to say.
- Configured and it disagrees → `gear_mapping_mismatch` with **both** values. The
  configured one still wins: an operator's assertion outranks an inference, but you get told.

For ground truth while wiring the flat — before any entity exists in HA to probe — light
each gear in turn via the gateway's `POST /device/{id}/control` and write down which room
came on.

## How the gestures map

| Gesture | Result |
| --- | --- |
| Turn, no button | Brightness, relative (`brightness_step`) |
| Hold button + turn | Colour temperature, absolute (`color_temp_kelvin`) |
| Short press, no turn | `light.toggle` |
| Short press after turning | Nothing — that was a colour gesture |

Details that matter, all measured on the hardware:

- **The position counter is shared** between brightness and colour and never resets. Only
  differences are meaningful, so the first position event after startup just sets a baseline.
- **Rotation speed comes from the hardware, in four steps.** The encoder reports its
  position at a fixed ~175 ms cadence no matter how fast the knob turns, so speed shows up
  as how far the counter moved between reports — and it is quantised into exactly four
  magnitudes: **1, 25, 55 and 80** counts. Over 290 measured position events nothing in
  between ever appears; every off-tier value in the capture is one of those four clipped by
  an end stop. Four tiers is all the resolution there is, so `SPEED_CURVE` maps them onto
  the step actually sent. The default raises only the slowest tier, from 1 to 2, because a
  step of 1 on a 255 scale is imperceptible.

- **At the end stops the counter stops carrying speed, so the daemon ramps.** The counter
  pins at 0 or 255 (it saturates, it never wraps — which is what makes a plain subtraction
  safe) while events keep arriving. A pinned report says "still turning" but says nothing
  about how fast.

  This is not an edge case. Once the counter maxes out it stays there, so most turning
  happens in this state: of 212 pinned reports measured, **149 arrived in a gesture that
  began pinned** and so had never measured a speed at all. Reading those as the slowest
  step — the old behaviour — is why the knob went dead at the limits.

  Instead the daemon starts from whatever speed the gesture last actually measured (or the
  slowest step if it measured nothing) and climbs one tier for every `RAMP_EVERY_REPORTS`
  reports of continued turning, capped at the top of the curve. A brief nudge stays
  fine-grained; sustained turning accelerates. On the longest real pinned run this takes
  ~2 s of turning from **10** units of travel to **252** — the full range instead of a
  crawl — while sending *fewer* HA calls, because bigger steps coalesce.

  Two details keep it honest: a report that lands exactly on an end stop is clipped by the
  travel left rather than by the hand slowing down (`220 → 255` is a fast turn with only 35
  counts of room), so it keeps its real tier instead of reading as a slow-down; and the
  direction of a pinned step comes from the last *real* movement rather than the
  `start_left`/`start_right` flag, since at these step sizes a stale direction would run the
  light the wrong way fast.
- **`long_stop` can arrive before the last position events of its own gesture.** After the
  button releases, a 200 ms grace window keeps mapping positions to colour. Without it, the
  tail of every colour gesture would jump the brightness instead.
- **Colour is held locally.** HA has no relative colour step, so the current value is read
  once via `GET /api/states/<entity>` at the start of each gesture and then tracked in
  memory. If that read fails or the light reports no colour temperature, the gesture starts
  from the middle of the configured range.
- **Calls are coalesced.** At 10 events/second, sending one call per event would flood HA;
  deltas accumulate and flush at most once per `FLUSH_MS`, with the remainder sent
  immediately when the gesture ends.
- **Dimming never switches the light off.** Turning the knob down stops at
  `MIN_BRIGHTNESS` instead of reaching 0, because a knob that kills the light at the bottom
  of its travel is disorienting — you then have to guess which way turns it back on. At the
  floor the daemon sends an **absolute** `brightness` rather than a relative step, and once
  resting there it sends nothing at all. A light that is already off stays off when turned
  down, and comes on when turned up.

  The floor defaults to 3 rather than 1 for a measured reason: HA's 0-255 brightness is
  quantised onto DALI's 254 arc levels, and on this hardware **brightness 1 maps to arc
  level 0 and switches the light off**. 2 is the exact edge (it reads back as 1) and the
  round trip is not monotonic — ask for 4 and read 4, ask for 5 and read 3. That same
  quantisation is why the floor is sent absolutely: a relative step sized to land exactly on
  the floor can still overshoot to 0, especially since HA applies `brightness_step` against
  its own state, which lags a command sent moments earlier.
- **The bus outranks Home Assistant on what a light is actually doing.** HA's brightness is
  a belief; the arc level on the wire is a fact, and the daemon is already watching every
  `level` frame go past. When the two disagree by more than `LEVEL_DIVERGENCE`, the bus wins
  and an absolute value is sent rather than a relative step.

  This check needs `gear` in `devices.json`, configured or measured. Without it the daemon
  has no idea which light a level frame belongs to and skips the check entirely — the 22:04
  failure below can recur until the mapping is known, which is a visible gap rather than a
  silent wrong answer.

  This is not hypothetical. On 26 August at 22:04 the light was switched on from off with a
  relative step, after which **HA reported 254 while the bus had been sitting at level 5 for
  23 seconds** — no `level` frame passed in that whole window, so the light demonstrably had
  not moved. Five gestures and twenty position events of turning *up* produced no HA call at
  all, because each one looked like "already at maximum". Then the first turn *down* was
  applied to HA's 254 and slammed the light to 252. From the knob it looked like turning
  right did nothing and turning left jumped to full brightness.

  Replaying those exact frames, before and after: the light starts at 5, HA believes 254.

  ```
  BEFORE   ABS 255 → light 255, then steps down to 199   (right turn slams it to full)
  AFTER    divergence: HA said 254, bus said 5
           ABS 7 → then +2 +4 +4 +2 +25 … tracking the knob up to 181, back down to 125
  ```

  A caveat worth knowing: HA's 0-255 brightness and DALI's arc level are not the same scale
  (brightness 3 lands on level 2, and 254 on 252), so the divergence threshold has to sit
  well above that normal drift — 20 is far above it, while 249 is unmistakable. When the bus
  is believed, the value sent mixes the two scales by a count or two; the error is small and
  corrects itself on the next reading.

- **Turning up at the top is never silent.** The ceiling mirrors the floor: at maximum the
  daemon sends an absolute `brightness: 255` rather than a trimmed relative step. If there is
  genuinely nothing to do, it logs `brightness_suppressed` with a reason. Five gestures
  producing no call and no log line is what hid the divergence above for an entire evening.

- **Nothing is ever queued.** If HA is unreachable the event is dropped — a brightness change
  applied five minutes late is worse than none. One `ha_unreachable` alert is logged at the
  start of an outage and one `ha_restored` on recovery, not one per event. Bus logging
  continues regardless.

### The emergency controller

One controller in the distribution board is still in broadcast mode and drives the lights
directly with 16-bit `FE xx` frames. Those are logged but **never mapped** — it is an
independent backup and the daemon stays out of its way.

## Log format

JSONL, one event per line, in `dali-YYYY-MM-DD.jsonl`. Raw bytes are kept on every event,
decoded or not, so a decoding mistake can always be recomputed from the record.

Frames on the bus fall into four groups, and only the first ever reaches the control logic:

| | `byte0 & 0x01` | Meaning | Drives lights? |
| --- | --- | --- | --- |
| `inputEvent` | `0` | An event a controller emitted | **Yes**, if addressed (see below) |
| `command` | `1` | A command addressed to a device (`byte1` = instance, `byte2` = opcode) | No, logged only |
| `command` (`scope: "special"`) | `1` | An unaddressed special command — **operands are reversed** | No, logged only |
| `response` | — | 8-bit answer, paired to the query it follows | No, logged only |

An answer with no query in the preceding 200 ms is logged `orphan_response`.

### Special commands read backwards

For an addressed command `byte1` is the instance and `byte2` the opcode. For a **special**
command the order is reversed: `byte0` selects the command class, `byte1` chooses the
command, and `byte2` is its parameter. Applying the addressed rule to one of these produces
nonsense — `C1 30 FF` is a DTR0 write, but read the other way round it becomes "instance
`0x30` on short address 96", and short addresses stop at 63.

`0xC1` is the one-parameter class (Terminate, Initialise, Randomise, Compare, Withdraw,
SearchAddrH/M/L, Program/VerifyShortAddress, QueryShortAddress, WriteMemoryLocation,
DTR0/1/2, SendTestframe). `0xC5`/`0xC7`/`0xC9` are the two-parameter class
(DirectWriteMemory, DTR1DTR0, DTR2DTR1), where `byte1` and `byte2` are *both* data — so not
even "byte1 chooses the command" holds there.

Only Compare, VerifyShortAddress and QueryShortAddress are questions, so only those arm the
response pairing. A DTR write is not a question, and arming it would let some later,
unrelated answer be attributed to it.

### Event addressing schemes

**The frame layout depends on the controller's configuration, not just on the bus.**
`QueryEventScheme` reports five: `instance`, `device`, `device_instance`, `device_group`,
`instance_group` — each with a different header. The installation runs **device/instance
addressing**, where `byte0` is the device's short address.

Under *instance* addressing `byte0` carries the instance **type** (`0x80 | type << 1`) and
there is no device address in the frame at all. Reading it as an address is how `82 80 02`
becomes "short65": a device that cannot exist.

So the decoder reads an address **only** for device/instance addressing, tags every event
with its `scheme`, and refuses to drive a light from any other one — an event with no
address can only produce a guessed one, and a light that moves for a guessed reason is
exactly the bug this tool exists to find. If someone flips the scheme in DALI Cockpit, the
daemon raises `unexpected_event_scheme` once rather than quietly decoding the new shape
with the old rules.

```json
{"ts":"2026-08-25T19:04:11.412Z","kind":"level","target":"group0","level":151,"bits":16,"bytes":"A0 97"}
{"ts":"2026-08-25T19:04:11.480Z","kind":"command","target":"short0","address":0,"instance":1,"opcode":"0x8C","category":"instance_query","bits":24,"bytes":"01 01 8C"}
{"ts":"2026-08-25T19:04:11.495Z","kind":"response","to":{"address":0,"instance":1,"opcode":"0x8C"},"value":0,"bits":8,"bytes":"00"}
{"ts":"2026-08-25T19:04:11.520Z","kind":"colour","target":"broadcast","mired":149,"kelvin":6711,"bits":16,"bytes":"FF E7"}
{"ts":"2026-08-25T19:04:12.003Z","kind":"inputEvent","target":"short0","address":0,"instanceType":"pushButton","event":"pressed","bits":24,"bytes":"00 80 01"}
{"ts":"2026-08-25T19:04:12.210Z","kind":"control","action":"color_temp_kelvin","target":"short0","entity":"light.obyvak","kelvin":4387}
{"ts":"2026-08-25T19:07:44.001Z","kind":"alert","alert":"narrow_cct_range","target":"group0","span":5,"samples":14}
```

Console output is one line per event, meant for `journalctl -f`:

```
21:52:19  A0     pushButton pressed
21:52:19  A0     absoluteInput 83
21:52:19  A0     → light.obyvak 4015 K
21:52:21  bcast  level 127
21:52:22  A0     cmd inst=1 op=0x8C (instance_query)   ← command, never a gesture
21:52:22  reply  0 → inst=1 op=0x8C                    ← its 8-bit answer
21:52:23         special dtr0 255                      ← unaddressed, operands reversed
21:52:23  bcast  cmd inst=device op=0xCC (instance_query)
21:07:44  ALERT  narrow_cct_range G0 span=5 samples=14
```

## Alerts

| Alert | Meaning |
| --- | --- |
| `narrow_cct_range` | A burst of ≥8 colour events spanning <40 mired — the controller's colour range has probably been narrowed by an accidental recalibration. This is the bug the tool exists to catch. |
| `calibration_saved` | Three quick off/on cycles, the documented Gira confirmation for saving a limit. **Unverified** — see below. |
| `dali_reset` | A RESET frame. Means a device lost its configuration. |
| `button_stuck` | A knob is jammed (furniture). Logged only, never acted on. |
| `unmapped_device` | An event from an address missing from `devices.json`. Logged once per address. |
| `gear_discovery_aborted` | Someone used a controller during `DISCOVER_GEAR`. Probed lights were restored; re-run when the bus is idle. |
| `gear_mapping_learned` | The gear a device drives was measured by correlation. Add it to `devices.json`. |
| `gear_mapping_mismatch` | `devices.json` disagrees with the measured mapping. Both values are logged; the configured one is used. |
| `ha_brightness_divergence` | Home Assistant's reported brightness disagrees with the arc level actually on the bus. The bus is believed and an absolute value is sent. |
| `unexpected_event_scheme` | The controller is not using device/instance addressing. Its events carry no device address, so they are logged but cannot control lights. Logged once per scheme. |
| `ha_unreachable` / `ha_restored` | Start and end of a Home Assistant outage. |

### Alerts added for running unattended

| Alert | Means |
| --- | --- |
| `command_dropped` | Home Assistant was not keeping up. Queued commands older than 1.5 s are discarded rather than applied late. |
| `log_paused_low_disk` / `log_resumed` | Free disk hit the floor. Frame capture stopped; alerts and bridging continue. |
| `log_write_failed` | The capture stream errored. The next flush opens a fresh handle. |
| `clock_step` | Wall and monotonic clocks disagreed by more than a second. Timestamps either side are not comparable. |
| `watchdog_kill` | The event loop stopped responding and the process was killed so the supervisor could restart it. |
| `frame_handler_failed` | A frame threw. Reported once, then every hundredth; the bridge keeps running. |
| `gateway_socket_stalled` | The gateway answers HTTP but the monitor socket has gone quiet. The socket is abandoned and reconnected. |
| `gateway_probe_unavailable` | No probe endpoint on this firmware, so stall detection is **off** — silence alone cannot tell a dead socket from a quiet bus. |
| `gateway_bus_errors` | The gateway reports bus faults of its own. Once per distinct fault, not once per probe. |
| `device_map_problem` | One `devices.json` entry was skipped. The rest of the map is in force. |
| `uncaught_exception` / `unhandled_rejection` | Written to the capture just before exiting non-zero. |

## What the first real capture showed

`logs/dali-2026-08-25.jsonl` is a 2h42m capture from the live installation (3,834 events).
Replaying it through the decoder drove the changes below and turned up several things worth deciding on.

**Fixed as a result:**

- **Command frames were being decoded as button presses.** 24-bit frames with S=1 are commands
  addressed *to* a control device, not events emitted *by* one. 18 of them (`01 00 02`,
  `01 00 01`, `C7 00 01`, …) decoded as `short_press`/`pressed`/`long_stop`. With control
  enabled, `01 00 02` would have been read as a short press with no rotation and **toggled a
  light**. Event frames now require S=0 *and* bit 7 set in byte 1.
- **8-bit frames** (178 of them) are answers to queries from another master on the bus. Each
  is paired with the command it answers and logged as `response`; all 178 paired, with **no
  orphans**. Measured query→answer gap is 3–39 ms, comfortably inside the 200 ms window.
- Together these took phantom input events to **zero** and undecoded frames from 567 to 92.
- **Special commands were being read with the addressed-command layout.** Their operands run
  in the opposite order, so all 84 `C1`/`C7` frames — DTR0/DTR1/DTR2 register writes — were
  logged as commands to instance `0x30` on "short address 96". Decoding them properly took
  the unknowns from 92 to 52.
- **Broadcast was being read as short address 127.** 40 `FF FE xx` frames claimed a device
  that cannot exist. Broadcast now decodes as `broadcast` and, since every device would
  answer at once, deliberately does *not* arm the query/response pairing. Unknowns: 52 → 12.
- **Two fixtures came from a different event scheme.** `82 80 02` and `84 8C 08` were
  captured under *instance* addressing, where `byte0` is the instance type rather than an
  address — so their "short65"/"short66" targets were the addressed-scheme rule misapplied,
  not real devices. Events now carry a `scheme`, and only device/instance addressing can
  drive a light.
- **A malformed WebSocket message killed the daemon.** A frame whose `data` was not an array
  threw out of the message handler and ended the process — losing the whole capture session
  over one bad frame. It now decodes as `unknown`.

**Open questions for you:**

- **`narrow_cct_range` fired twice, and one looks like a false positive.** At 18:10 it caught
  13 consecutive events pinned at exactly 500 mired (2000 K, the factory minimum) — the knob
  turning with the value hard against its limit, which is the signature worth seeing. But at
  17:12 it fired on a perfectly healthy slow turn: 150→182 mired over 3.4 s, i.e. 6667 K →
  5495 K. The value *was* moving, just by 32 mired inside one burst, under the 40 threshold.
  The spec assumed a healthy turn always spans far more than 40 mired; on real hardware a slow
  turn doesn't. Consider raising `CCT_SPAN_THRESHOLD`, requiring more samples, or keying the
  alert on the value being stuck at a range limit rather than merely spanning little.
- **The observed colour range is 100–1000 mired (1000–10000 K)**, wider than the 2000–10000 K
  factory range the spec describes. Worth checking which device reports 1000 mired.
- **No `A5 00` decode.** Ten of them appeared during the reconfiguration window; logged raw.
  With the special commands and event schemes now handled, these plus two push-button
  opcodes (`0x0E`, `0x0F`, once each) are the **only** remaining unknowns: 12 frames out of
  3,873. The 26 August capture decodes with **none**.
- **`FF FE CC` is categorised `instance_query` while its instance is `device`.** The opcode
  range table says `0x80`+ is an instance query, but `byte1 = 0xFE` means the command is
  addressed to the device as a whole, so the two labels contradict each other. The frame is
  decoded exactly as the spec's table says and the raw bytes are in the log either way —
  flagging it rather than guessing which half is wrong.

## Unverified assumptions

Two byte patterns are taken from the DALI standard rather than measured on this hardware.
Both fail safe — a wrong guess means the event decodes as `unknown` with its raw bytes in
the log and no alert, never a crash or a bus write.

1. **`dali_reset` = `A1 00`.** Five of these appeared in the capture between 19:19 and 19:33,
   which is consistent with the controllers being reconfigured in DALI Cockpit around then —
   suggestive, but not proof the byte pattern is right. Confirm by triggering a reset on a
   spare device and checking whether the alert fires.
2. **`button_stuck` = push-button opcode `0x08`.** Gira's other opcodes (`09`/`0B`/`0C`)
   don't follow the standard numbering, so this one is a guess, and `0x08` never appeared in
   the capture. Confirm by wedging a button down for more than 20 seconds. Two other
   push-button opcodes did show up unmapped, `0x0E` and `0x0F` (once each) — if the stuck
   event is one of those, this is where it will be.

`calibration_saved` is also unverified, and is tagged `"unverified": true` in the log.
Confirm it by deliberately saving a colour-temperature limit and checking the alert fires.

## Layout

```
index.js            config, WebSocket + reconnect, wiring, console output
lib/decoder.js      16-bit and 24-bit frame decoding, DT8 colour state machine
lib/anomaly.js      narrow_cct_range, calibration_saved detection
lib/control.js      gesture state machine, coalescing, bounded HA call queue
lib/ha-client.js    Home Assistant REST client, outage tracking
lib/discover.js     active gear-mapping discovery via HA (never writes to the bus)
lib/logstore.js     buffered JSONL capture: rotation, retention, disk floor
lib/clock.js        monotonic time for intervals; clock-step detection
lib/watchdog.js     worker thread that kills a wedged process
lib/lock.js         one instance per machine
lib/liveness.js     read-only gateway probe; half-open socket detection
lib/options.js      app / Supervisor runtime adapters
config.yaml         app manifest -- the repo root IS the app directory
Dockerfile          node:22-alpine; build context is the repo root
DOCS.md             the app's Documentation tab in Home Assistant
translations/       friendly option labels for the app config UI
deploy/systemd/     the unit and install notes for non-HAOS installs
docs/DESIGN.md      why it is put together this way, and what was rejected
test/               built from real bus captures; plus a fake gateway on loopback
```

## Running it on the Raspberry Pi

See [docs/DESIGN.md](docs/DESIGN.md). Short version: it becomes a Home Assistant
app, which puts the UI in the HA sidebar behind HA's own login and removes
the long-lived token entirely (`homeassistant_api: true` gets a scoped one from
the Supervisor).

The manifest lives at the repo root so the app installs with a clone. From the
Terminal app — the shared folder is still called `addons`, even though what
lives in it is now called an app:

```sh
git clone https://github.com/zdevaty/gira-dali-lunatone-has-connector /addons/dali_bridge
ha store reload
ha apps install local_dali_bridge
```

Or **Settings → Apps → App store → ⋮ → Check for updates**, then pick it from
**Local apps**.

To update, `sh /addons/dali_bridge/update.sh`, or by hand — all three steps
matter:

```sh
cd /addons/dali_bridge && git pull   # new source
ha store reload                      # the Supervisor re-reads config.yaml
ha apps update local_dali_bridge     # install the version it just found
```

`ha apps rebuild` alone rebuilds the image but leaves the Supervisor's store
index stale, so the Apps page keeps describing the old manifest and anything the
update added to `config.yaml` — an ingress panel, a new option — never takes
effect. For a non-HAOS install there is a systemd unit in `deploy/systemd/`.

The daemon is the wall switches now — with the controllers out of
application-controller mode, nothing else on the bus reacts to the knobs. That
is what everything in `docs/DESIGN.md` is organised around.
