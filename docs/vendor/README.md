# Vendor reference

`lunatone-dali2-iot-openapi.json` — OpenAPI 3.1 schema of the Lunatone DALI-2
IoT gateway's REST API, as served by firmware **1.18.7/1.4.6** (the gateway at
10.0.0.230). Downloaded 2026-09-16. Reference only: nothing loads it at runtime.

Endpoints that put frames on the bus or change the gateway are dangerous here.
Everything the bridge may request is one table in `lib/gateway-http.js`, each
entry marked read, bus or config, with its body checked before sending;
`test/gateway-http.test.js` pins the table and `test/contract.test.js` checks
the bodies and the fake gateway against this schema. Of the endpoints below,
only the scan's two safe modes and `POST /device/{id}/control` for a blink
(`dimmable` or `switchable` alone) are reachable:

| Endpoint | Why it matters |
|---|---|
| `POST /dali/scan` | **An empty body is not harmless**: the defaults (`noAddressing: false`, `newInstallation: false`) run a *system extension*, which assigns addresses. `newInstallation: true` deletes every device and re-addresses the whole bus, breaking every knob mapping and every Home Assistant entity |
| `POST /dali/sendDali16/{line}`, `/sendDali24/{line}` | Raw bus frames |
| `POST /device/{id}/control`, `/group/…`, `/broadcast/…`, `/zone/…` | Light commands; this is what the Home Assistant integration uses. `saveToScene`, `fadeTime` and `fadeRate` are stored in the driver |
| `GET /device/{id}/energyReporting`, `/diagnosticsMaintenance` | GETs, but answered by querying the driver over the bus |
| `PUT /settings`, `POST /ethernet`, `PUT /info` | Gateway settings; `dali_ping` and logging, network, name |
| `POST/PUT/DELETE /automations/…` | Automations that act on the bus by themselves |
| `DELETE /devices`, `DELETE /reset`, `POST /reboot` | Self-explanatory |

Plus `GET /info` for the liveness probe, which also carries each line's bus
power (`lines.*.lineStatus`).
