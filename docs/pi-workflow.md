# Shared Raspberry Pi setup

Open `http://plotter-pi.local/` from a computer on the same network.

## Presets

Open **presets**, enter a name and choose **Save current setup**. Presets store
pen, paper and motion settings on the Pi. On another computer, select the name
and choose **Load**. Use **Refresh** to see presets saved since opening the page.
Loading is disabled during plotting. Loading changes settings without moving
the pen. Drawing-specific layer selections and the current pen origin stay with
the current drawing/session.

Preset files live outside the installation at `~/.local/share/saxi/presets.json`.
Set `SAXI_DATA_DIR` on the server to choose a different data directory. Updates
replace the application while retaining these files. A damaged preset file is
reported as an error and is not silently replaced.

The same actions are available through the HTTP API:

- `GET /presets` lists saved setups.
- `PUT /presets/:name` saves settings as JSON. The response to `GET /presets`
  contains the settings format in each entry's `options` field.
- `DELETE /presets/:name` deletes a saved setup.
- `POST /presets/:name/load` loads the latest saved setup, applies its hardware
  model and returns its settings. It refuses to load during a plot or update.

Names are URL-encoded. These endpoints are for the same trusted local network as
the plot controls; browser writes from unrelated origins are rejected.

## Completion sound

Check **completion sound** in each browser you want to hear. Enabling it plays
the chime once to confirm the browser permits audio. **Test sound** plays it
again. A completed plot plays the chime; cancelling does not. Keep the browser
open and the computer awake. Enable sound again after reloading the page.

## Update the Pi

From a Mac or Linux build computer with Node.js 24 LTS, Git, SSH and access to
the Pi's existing passwordless service-management commands:

```sh
npm run update:pi -- pedro@plotter-pi.local
```

Run this from a clean checkout of this fork. The command fetches `origin/main`,
builds and tests locally, and stages the release and production dependencies on
the Pi before stopping the service. If a plot is in progress, the update is
refused. Otherwise the service reserves the idle plotter, backs up the old
installation, installs the release and checks it. If startup fails, it restores
the old installation and starts it again.

Backups, including the previous dependencies, service file and default data
directory, are retained under `/var/backups/plotter-pi/saxi-update.*`. The update
command prints the exact backup location. Review and remove older backups only
when you no longer need them.

The update reservation can also be managed through the API:

```sh
curl --fail -H 'Content-Type: application/json' -d '{"updating":true}' http://plotter-pi.local/maintenance
curl --fail -X DELETE http://plotter-pi.local/maintenance
```

Acquiring a reservation returns 409 if a plot or another update is active.
Starting a plot while reserved returns 503. A reservation expires after five
minutes and remains active through a service restart until released.

The service runs as the regular Pi user. Port 80 is enabled only for the service
with `AmbientCapabilities=CAP_NET_BIND_SERVICE` and
`CapabilityBoundingSet=CAP_NET_BIND_SERVICE`.

## Console boot

For a dedicated plotter Pi, `sudo systemctl set-default multi-user.target` makes
the next boot omit the desktop. SSH and Saxi still start normally. To restore
desktop boot, use `sudo systemctl set-default graphical.target` and reboot.
