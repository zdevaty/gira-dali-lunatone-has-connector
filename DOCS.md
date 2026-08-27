# DALI Bridge

Watches the DALI bus through a Lunatone DALI-2 IoT gateway and turns Gira
rotary-knob gestures into Home Assistant light calls.

**It never transmits on the DALI bus.** The bus is read through the gateway's
monitor socket; every light change goes out through Home Assistant, which asks
the gateway. One bad frame on a DALI bus can erase a device's commissioning, so
there is no code path here that can send one.

## Installing and updating

The repo root is the add-on directory, so it installs by cloning. From the
Terminal add-on (`git` is already there):

```sh
git clone https://github.com/zdevaty/gira-dali-lunatone-has-connector /addons/dali_bridge
```

Then **Settings → Add-ons → Add-on Store → ⋮ → Check for updates**, and it
appears under *Local add-ons*.

To update later:

```sh
cd /addons/dali_bridge && git pull
```

Bump `version` in `config.yaml` if it did not change in the pull, then click
**Update** on the add-on page. A rebuild takes a minute or two on a Pi 4.

## First run

1. Set **Gateway address** to the gateway's IP and leave **Control the lights**
   off. Start the add-on and read the log: you should see `connection connected`
   and then frames as lights change.
2. Turn a knob. You will see `unmapped_device short6` — that is how you learn
   which address belongs to which room, since DALI hands addresses out at
   commissioning time in no particular order.
3. Write `/data/devices.json` (see below), then switch **Control the lights** on.

## devices.json

Lives at `/data/devices.json`, so it survives updates and is included in Home
Assistant backups. Keyed by the *control device* (knob) short address:

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
add-on: refusing to start would disable every knob in the building instead of one.

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

JSONL, one line per frame, in `/data/logs`, rotated daily and gzipped after a
day. They are **excluded from Home Assistant backups** on purpose — they are
large and change constantly.

`/data` is deleted if you uninstall the add-on. Copy anything worth keeping to
`/share` first.

If the disk gets tight the add-on stops capturing frames and keeps bridging.
Protecting the disk Home Assistant runs on matters more than any capture.

## If the lights stop responding

The bridge is one link in a long chain: knob → bus → gateway → this add-on →
Home Assistant → gateway → bus → driver. Two things worth knowing:

- **While Home Assistant is restarting, the knobs are dead.** Nothing here can
  change that; the only path to the lights is through HA.
- If the add-on log has stopped entirely, check the gateway is reachable. The
  bridge retries forever and says `connection disconnected` each time.
