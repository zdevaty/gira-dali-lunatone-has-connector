# Vendor reference

`lunatone-dali2-iot-openapi.json` — OpenAPI 3.1 schema of the Lunatone DALI-2
IoT gateway's REST API, as served by firmware **1.18.7/1.4.6** (the gateway at
10.0.0.230). Downloaded 2026-09-16. Reference only: nothing loads it at runtime.

Endpoints that put frames on the bus or change the gateway are dangerous here.
The bridge uses `GET /devices`, `GET/POST /dali/scan` (two fixed bodies, never a
new installation), `POST /dali/scan/cancel` and `PUT /device/{id}` (name and
groups) -- all in `lib/gateway-admin.js`, all behind a button. Apart from the
scan's two safe modes, nothing in this table is reachable from the code:

| Endpoint | Why it matters |
|---|---|
| `POST /dali/scan` | **An empty body is not harmless**: the defaults (`noAddressing: false`, `newInstallation: false`) run a *system extension*, which assigns addresses. `newInstallation: true` deletes every device and re-addresses the whole bus, breaking every knob mapping and every Home Assistant entity |
| `POST /dali/sendDali16/{line}`, `/sendDali24/{line}` | Raw bus frames |
| `POST /device/{id}/control`, `/group/…`, `/broadcast/…`, `/zone/…` | Light commands; this is what the Home Assistant integration uses |
| `DELETE /devices`, `DELETE /reset`, `POST /reboot` | Self-explanatory |

Plus `GET /info` for the liveness probe.
