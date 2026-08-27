# DALI Bridge

Watches the DALI bus through a Lunatone DALI-2 IoT gateway and turns Gira
rotary-knob gestures into Home Assistant light calls.

**It never transmits on the DALI bus.** The bus is read through the gateway's
monitor socket; every light change goes out through Home Assistant, which asks
the gateway. One bad frame on a DALI bus can erase a device's commissioning, so
there is no code path here that can send one.

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

3. Write `/data/devices.json` (see below) using the addresses you just collected,
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
