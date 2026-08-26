# systemd install (non-HAOS fallback)

Only needed if Home Assistant is **not** HAOS or Supervised. Check first:
Settings → System → Repairs → ⋮ → System information → *Installation Type*.
If it says Home Assistant OS or Supervised, use the add-on instead (`addon/`).

```sh
sudo useradd --system --home /opt/dali-bridge --shell /usr/sbin/nologin dali-bridge
sudo mkdir -p /opt/dali-bridge /etc/dali-bridge /var/lib/dali-bridge
sudo rsync -a --delete index.js lib/ package.json docs/ /opt/dali-bridge/
sudo chown -R dali-bridge:dali-bridge /var/lib/dali-bridge
```

The token lives here and nowhere else — never in the repo, never in a log:

```sh
sudo install -m 0600 -o root -g root /dev/null /etc/dali-bridge/env
sudo tee /etc/dali-bridge/env >/dev/null <<'ENV'
GATEWAY_IP=10.0.0.230
LOG_DIR=/var/lib/dali-bridge/logs
DEVICE_MAP=/var/lib/dali-bridge/devices.json
HA_URL=http://127.0.0.1:8123
HA_TOKEN=paste-the-long-lived-token-here
CONTROL_ENABLED=false
CONSOLE=quiet
ENV
sudo chmod 600 /etc/dali-bridge/env
```

```sh
sudo cp deploy/systemd/dali-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dali-bridge
journalctl -u dali-bridge -f
```

Start with `CONTROL_ENABLED=false` and watch the bus for a while before letting
it touch anything. Flip it to `true` and `systemctl restart dali-bridge` once
the capture looks right.
