# DALI Bridge

Watches the DALI bus through a Lunatone DALI-2 IoT gateway and turns Gira
rotary-knob gestures into Home Assistant light calls.

**It never transmits on the DALI bus on its own.** The bus is read through the
gateway's monitor socket; every light change goes out through Home Assistant,
which asks the gateway. One bad frame on a DALI bus can erase a device's
commissioning, so the only exceptions are buttons on the **Devices** and
**Gateway** pages -- scan, name and groups, blink, diagnostics and scene reads,
the gateway's polling, clock, location and zones -- which ask the gateway to do
it and only when you press them. The one thing that can run without a button
is the diagnostics read, and only if you set **Read driver diagnostics every
(hours)**. The app cannot send raw frames, cannot switch groups or the whole
bus, and cannot start a new installation that re-addresses the bus.

## Installing and updating

The repo root is the app directory, so it installs by cloning. `git` already
ships in the Terminal app, and the folder Home Assistant shares for custom apps
is still called `addons` even though the apps themselves are no longer called
add-ons:

```sh
git clone https://github.com/zdevaty/gira-dali-lunatone-has-connector /addons/dali_bridge
```

Then **Settings → Apps → App store** (bottom right) **→ ⋮ → Check for updates**.
It appears under **Local apps**. Or from the terminal:

```sh
ha store reload          # the same as "Check for updates"
ha apps install local_dali_bridge
```

To update later, one command does all of it and prints back what ended up
installed:

```sh
sh /addons/dali_bridge/update.sh
```

Or by hand — **all three steps**:

```sh
cd /addons/dali_bridge && git pull   # 1. new source
ha store reload                      # 2. the Supervisor re-reads config.yaml
ha apps update local_dali_bridge     # 3. install the version it just found
```

Step 2 is the one that is easy to miss. `ha apps rebuild` rebuilds the image
from whatever source is on disk, but the Supervisor's idea of the app — its
version, whether it has an ingress panel, what its options are — comes from a
store index that only `ha store reload` refreshes. Skip it and you get a
container running new code while the Apps page still describes the old manifest,
and anything the update added to config.yaml never takes effect.

If step 3 reports nothing to update, the store index is still stale; run
`ha apps info local_dali_bridge` and check the version it reports against
`grep '^version:' /addons/dali_bridge/config.yaml`.

`ha apps` also takes `logs`, `restart`, `rebuild`, `info` and `stats`, all with
the same slug. The old `ha addons` spelling still works as an alias. A rebuild
takes a minute or two on a Pi 4.

## Turn on Watchdog

On the app's **Info** tab, switch **Watchdog** on. Without it, Home Assistant
does not restart the app when it crashes -- and the app deliberately kills
itself if it ever freezes, counting on that restart. With it off, either leaves
every knob dead until someone starts the app by hand.

Also leave **Start on boot** on.

## The DALI panel

Once the app is running there is a **DALI** entry in the Home Assistant sidebar.
No extra login: Home Assistant has already authenticated you, and the app
accepts connections only from the ingress proxy, so the port is never reachable
from your network.

- **Now** — everything on the bus as it happens, with filters for knobs, lights,
  what was sent to Home Assistant, and alerts.
- **Commission** — the point of the panel. Walk the flat and turn each knob; the
  controller that just spoke jumps to the top and flashes. Give it the light it
  should drive and move on. Saving applies immediately, with no restart.
- **Tuning** — how the knobs feel: step sizes, gains, the brightness floor,
  timing. Applied at the next turn, no restart.
- **Devices** — the gateway's device list: scan for new devices, names, groups,
  blink, scenes, diagnostics, and DALI-2 sensors.
- **Gateway** — bus power, the gateway's clock, polling, what it runs by itself,
  zones, and a history of its setup.
- **Health** — uptime, frame rate, memory, event-loop lag, reconnects, capture
  size, and the gateway's own firmware and bus state.

The **Driver** field on each controller can be left alone. It is the control
gear address that room's light answers to, and the bridge measures it from its
own calls rather than guessing — the two address spaces are numbered
independently, so a knob at A0 says nothing about which driver its light uses.

## First run

1. Set **Gateway address** to the gateway's IP and leave **Control the lights**
   off. Start the app and read the log. Within a second or two you should see:

   ```
   start  v0.2.1 on ... gateway=10.0.0.230 control=false ...
   connection connected
   gw     DALI-2 IoT v1.18.7/1.4.6 (1 line, tier plus)
   ```

   That third line is the one that matters: it means the app reached the gateway
   over HTTP as well as the bus socket. If it is missing, the gateway address is
   wrong or unreachable from the container.

2. Turn a knob. With **App log detail** on `pretty` you will see the raw gesture:
   `generic start_right`, then a stream of `absoluteInput value=...` as the
   counter moves. Note the address in front of them — `A6` and so on. That is
   how you learn which knob is which, since DALI hands addresses out in no
   particular order at commissioning time.

   On `quiet` you still see the knob turns, but not the arc levels and colour
   frames underneath them.

3. Map the knobs on the **Commission** page, or write `devices.json` (see below), using the addresses you just collected,
   then switch **Control the lights** on. From then on an unmapped knob reports
   `unmapped_device` once per address.

## devices.json

Lives at `/config/devices.json` inside the app, which is
`/addon_configs/local_dali_bridge/devices.json` on the host — so you can edit it
from the Terminal app, the File editor or Samba, and it survives updates and is
backed up. Keyed by the *control device* (knob) short address:

```json
{
  "6": {
    "entity": "light.bedroom",
    "min_kelvin": 2700,
    "max_kelvin": 6500,
    "gear": null
  }
}
```

`gear` is the *control gear* (driver) address the same room's light answers to.
There is deliberately no default. Control devices and control gear are numbered
independently at commissioning, so a bedroom knob may be `A6` while the bedroom
driver is `A11`; a default that happens to work on a bench and is quietly wrong
in a flat is worse than a missing value. Leave it `null` and the bridge measures
it from its own calls, then tells you what it found.

A malformed entry disables that one knob and is reported. It does not stop the
app: refusing to start would disable every knob in the building instead of one.

## What the log tells you

| Line | Meaning |
|---|---|
| `unmapped_device` | A knob was turned that `devices.json` does not know |
| `gear_mapping_learned` | The bridge worked out which driver an entity drives |
| `gear_mapping_mismatch` | `devices.json` disagrees with what was observed |
| `ha_brightness_divergence` | HA's brightness disagreed with the bus; the bus won |
| `command_dropped` | Home Assistant was not keeping up; late commands discarded |
| `log_paused_low_disk` | Disk got tight; frames no longer captured, bridge unaffected |
| `clock_step` | The system clock jumped; timestamps across it are not comparable |
| `watchdog_kill` | The event loop wedged and the process was killed to recover |
| `unexpected_event_scheme` | A controller is not using device/instance addressing |
| `gateway_write` | The app asked the gateway for a scan or a device change (always logged) |
| `during_scan=true` | This alert came from scan traffic, not a fault |
| `gateway_scan_failed` | A scan was refused, hit a bus error or never finished |
| `ha_integration_reload_failed` | After a scan, reload the Lunatone integration by hand |
| `ha_sensors_disabled` | Status sensors were turned on but there is no token to publish them with |
| `during=identify` (or `scan`, `diagnostics`…) | This alert came from the app's own bus activity |
| `dali_bus_power_lost` / `_low` / `_restored` | The gateway reports the DALI bus power supply gone, weak, or back |
| `gateway_send_blocked` | The gateway cannot send on a line right now; Home Assistant's light changes will not arrive |
| `gateway_config_changed` | The gateway's setup changed and nothing in this app did it -- compare on the Gateway page |
| `gateway_firmware_changed` / `_unverified` | The gateway's firmware changed, or is not the one the decoder was checked with |
| `gateway_clock_drift` / `_unreadable` | The gateway's clock is a minute or more out, or its format was not understood |
| `gateway_timezone_mismatch` | The gateway and Home Assistant are in different time zones |
| `driver_reports_failure` | A diagnostics read found a fault flag set (open circuit, thermal shutdown…) |
| `identify_restore_failed` | A blink could not put the light back; set it from Home Assistant |
| `gateway_automation` | Not an alert: a schedule stored on the gateway was due. It acts without this app |
| `tuning` | Not an alert: a tuning setting changed, with its old and new value |
| `tuning_problem` | A tuning value in `tuning.json` or the environment was invalid and ignored; the default is used |

## Adding devices

The chain, and who does what:

| Step | Where |
|---|---|
| Wire the device in | — |
| Give it an address and put it in the gateway's list | **DALI panel → Devices → Add new devices** |
| Make Home Assistant see the new light | automatic after the scan (Lunatone integration reload) |
| Name it, set its groups | **Devices**, on the device's card |
| Knob event mode (device/instance addressing) | still **DALI Cockpit** — the gateway API has no setting for it |
| Which knob drives which light | **Commission** |

**Refresh device list** re-reads the devices that already have addresses and
changes nothing on them. Use it when a device shows as missing or not
responding.

**Add new devices…** is the gateway's *system extension*: devices without an
address get one, and devices that have one keep it. It asks you to confirm,
because it puts a lot of traffic on the bus and the knobs may not respond until
it finishes. Afterwards the app reloads the Lunatone integration and checks
that every light a knob is mapped to still exists; the result is shown on the
page with a button to go and map a knob.

What the app will **not** do, on purpose: a *new installation* (the gateway
deletes every device and re-addresses the whole bus, which would break every
knob mapping and every Home Assistant entity), raw DALI frames, deleting
devices, reset or reboot. Use DALI Cockpit or the gateway's own page for those,
knowing what they do.

On a device's card:

- **Name** is stored on the gateway. Home Assistant shows it after the
  Lunatone integration is reloaded; entity IDs normally stay the same.
- **Groups** are stored *in the device*, so saving them writes to the bus and
  asks once more. Lights answer group commands by these.

A scan's own traffic can look alarming in the log -- lights blinking reads like
the knob calibration confirmation, for instance.
Anything raised during a scan and for ten seconds after carries
`during_scan=true`, and the status sensors ignore it.

Every request the app makes of the gateway is written to the capture as a
`gateway_write` line, whatever **How much of the bus to capture** is set to.
To make the page read-only, switch off **Device management from the panel**.

## Tuning how the knobs feel

Open **Tuning**, change a value, press **Save and apply**, and turn a knob. The
feed at the top shows the knob's button and turn events and exactly what was
sent to Home Assistant, so you can see the effect of a change as well as feel it.

| Setting | Turn it… |
|---|---|
| **Step per speed** | The four numbers are how far one report moves the light at each rotation speed, slowest first. Raise *slowest* if a gentle turn does nothing visible; lower *fastest* if a quick spin overshoots. |
| **Speed up at an end stop every** | Once the knob's counter hits its end it stops reporting speed; lower this to accelerate sooner while you keep turning. |
| **Brightness gain**, **Colour gain** | Scales everything at once. Below 1 is finer. |
| **Lowest brightness** | Where turning down stops. Never below 2: on this hardware 1 switches the light off. |
| **Trust the bus beyond** | How far Home Assistant's brightness may disagree with the level on the bus before the bus wins. |
| **At most one call every** | Lower feels more immediate and puts more load on Home Assistant. |
| **Calls waiting per light**, **Drop a call older than** | What happens when Home Assistant is slow: late steps are dropped rather than applied after your hand has left the knob. |

**Undo last save** goes back one step; **back to default** under a setting
resets just that one. Saved settings live in
`/addon_configs/local_dali_bridge/tuning.json`, which holds only what you
changed. Every change is written to the capture with its old and new value.

With **Control the lights** off, changes are saved but nothing uses them until
it is on.

## On a device's card: blink, scenes, diagnostics

Open **Identify, scenes, diagnostics** under a device on the **Devices** page.

- **Blink** switches the light full on and off three times, then puts it back
  where it was. It reads the light's current level from the gateway first; if
  the gateway does not report it, the button is disabled, because a light left
  at full in the night is worse than no blink. A blink looks exactly like the
  knob calibration confirmation, so anything it raises carries `during=identify`.
- **Scenes** shows the scene levels the gateway last saw. **Re-read scenes from
  the driver** asks the driver itself, over the bus.
- **Read diagnostics** asks the driver over the bus for what DALI-2 drivers can
  report (DALI parts 252 and 253): energy used, power, driver and lamp
  temperature, how long the lamp has been on against its rated life, start
  counts, supply voltage, and fault flags. Many drivers support neither part;
  the card then says so.

To read every driver regularly -- for Home Assistant's Energy dashboard, or to
be told of a failing driver -- set **Read driver diagnostics every (hours)**.
Each pass reads one driver at a time and waits while someone is using a knob.
It is the only bus traffic the app makes on its own, which is why it is off
until you set it.

**Sensors** (DALI-2 occupancy, light level and the like) are listed below the
devices, with the value the gateway holds. **Re-read from the bus** asks them.

## The Gateway page

- **Gateway and bus**: firmware, and each line's power. `NO POWER` means the
  DALI bus power supply has failed: every knob and light on that line is dead,
  however healthy everything else looks.
- **Clock and location**: the gateway runs its own schedules by its own clock
  and time zone. The page compares both with this server and Home Assistant,
  and offers to fix them. *Set the clock to now* turns the gateway's network
  time off, because a manual time only sticks that way.
- **Driver polling**: see *The gateway polls your drivers*.
- **Runs on the gateway by itself**: schedules, circadian curves, sequences and
  forwarding rules stored on the gateway, with the lights they reach. If one
  changes a light a knob also drives, it says so -- a light that moves on its
  own is often this. When a time-of-day schedule is due, a line appears in
  **Now**.
- **Zones**: *Mirror Home Assistant areas…* shows what it would create and
  change before doing anything. Lights are matched to gateway devices through
  the knob map, the Lunatone device identifier, or an exact, unique device
  name; anything else is listed as unmatched and left out. Zones are never
  deleted, and a zone that also names groups is left alone.
- **Setup history**: a copy of the gateway's setup, saved nightly and after
  every change from the panel, but only when something differs. Click one to
  see what changed since the copy before. The files are in
  `/addon_configs/local_dali_bridge/gateway-snapshots`, which Home Assistant
  backups include. If the setup changes and nothing in this app did it,
  `gateway_config_changed` is raised.

## Status sensors in Home Assistant

Turn on **Status sensors in Home Assistant** in the Configuration tab and
restart the app. It then publishes:

| Entity | State | Worth knowing |
|---|---|---|
| `sensor.dali_bridge_status` | `running` / `stopped` | `version`, `started`, and `last_seen`, which moves every minute |
| `binary_sensor.dali_bridge_gateway` | `on` when connected to the gateway | `http_reachable`, `stalls`, `disconnects` |
| `sensor.dali_bridge_bus_activity` | frames per minute | Zero for hours is normal at night |
| `sensor.dali_bridge_last_gesture` | when a knob was last used | `device` and the `light` it is mapped to |
| `sensor.dali_bridge_last_alert` | the latest alert's name | `at`, `alerts_since_start` |

They update every minute, and within about five seconds when the gateway
connects or drops or an alert fires. Knob turns never cause a write of their
own, so the sensors cannot slow a light down.

These are not full entities: they have no unique ID, so they cannot be renamed
or put in an area, and **Home Assistant forgets them when it restarts** until
the bridge writes them again, within a minute. Automations that read them
should tolerate a minute of `unavailable` after an HA restart.

A deliberate stop says `stopped`. A crash or a power cut says nothing, so to
be told the bridge has gone quiet, watch `last_seen`:

```yaml
alias: DALI bridge silent
triggers:
  - trigger: template
    value_template: >-
      {% set seen = state_attr('sensor.dali_bridge_status', 'last_seen') %}
      {{ seen is not none and now() - as_datetime(seen) > timedelta(minutes=5) }}
actions:
  - action: notify.notify
    data:
      message: The DALI bridge has not reported for five minutes. The knobs may be dead.
```

and for the gateway, a state trigger on `binary_sensor.dali_bridge_gateway`
going `off` for two minutes.

Also published, when there is something to publish:

| Entity | From |
|---|---|
| `binary_sensor.dali_bridge_bus_power` | each line's bus power, as the gateway reports it; `unavailable` until it has |
| `sensor.dali_bridge_l0_a2_energy`, `_power`, `_temperature`, `_light_hours` | the last diagnostics read of line 0, address 2 |
| `binary_sensor.dali_bridge_l0_a2_problem` | on when that driver reports a fault flag |
| `sensor.dali_bridge_sensor_7`, `binary_sensor.dali_bridge_sensor_7` | DALI-2 sensor 7 on the gateway; occupancy is a binary sensor |

The energy sensors are `total_increasing` in kWh, so the Energy dashboard can
use them -- but only as often as they are read.

## The gateway polls your drivers

Once devices are in the gateway's list, the gateway asks each driver about once
a second for its status and its level. In **Now** that reads:

```
A0  query status
    reply A0 status: lamp on
A0  query actual level
    reply A0 level 254
```

That traffic is the gateway's, not the app's, and it is what the **lamp
failure** and **on** badges on the Devices page are built from -- the same bits,
decoded the same way. A level of `unknown (MASK)` is the driver saying it cannot
tell, which is what a failed or missing lamp answers.

It adds a few frames a second to the capture. Nothing in the knobs or this app
needs it that often: on the **Gateway** page, under *Driver polling*, set it to
every 30-60 seconds and a failed lamp still shows within a minute. Or set **How
much of the bus to capture** to `events`.

## Captures

JSONL, one line per frame, rotated daily and gzipped after a day.

By default they go to `/data/logs`, which is **excluded from Home Assistant
backups** on purpose — they are large and change constantly. The catch is that
`/data` is private to this app, so until the web UI can serve downloads nothing
else can read them: not the Terminal app, not Samba.

While you are actively debugging, set **Capture directory** to
`/share/dali-bridge` instead. Then `cat /share/dali-bridge/dali-*.jsonl` works
from the Terminal app. The cost is that they land in every full backup, so put
it back to `/data/logs` when you are done.

`/data` is deleted if you uninstall the app. Copy anything worth keeping to
`/share` first.

If the disk gets tight the app stops capturing frames and keeps bridging.
Protecting the disk Home Assistant runs on matters more than any capture.

## If the lights stop responding

The bridge is one link in a long chain: knob → bus → gateway → this app →
Home Assistant → gateway → bus → driver. Two things worth knowing:

- **While Home Assistant is restarting, the knobs are dead.** Nothing here can
  change that; the only path to the lights is through HA.
- If the app log has stopped entirely, check the gateway is reachable. The
  bridge retries forever and says `connection disconnected` each time.
