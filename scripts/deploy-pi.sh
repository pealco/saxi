#!/usr/bin/env bash
set -euo pipefail

# Called by update-pi.sh after the build and tests pass on the other computer.
revision="${1:?Expected commit}"
digest="${2:?Expected archive checksum}"
archive="${3:?Expected release archive}"
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$digest" =~ ^[a-f0-9]{64}$ ]] || exit 1
live_dir="$HOME/saxi"
stage=''
backup=''
locked=0
stopped=0
swapped=0

cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if (( result != 0 )); then
    if (( stopped )); then
      sudo -n systemctl stop saxi || true
      if [[ -n "$backup" ]] && sudo -n test -d "$backup/saxi"; then
        if (( swapped )); then sudo -n mv "$live_dir" "$backup/failed-release"; fi
        sudo -n mv "$backup/saxi" "$live_dir"
      fi
      sudo -n systemctl start saxi || true
      echo "Update failed; restored the previous installation. Backup: $backup" >&2
    fi
    if (( locked )); then
      for _attempt in {1..20}; do
        if curl -fsS -X DELETE http://127.0.0.1/maintenance >/dev/null; then break; fi
        sleep 1
      done
    fi
  fi
  if [[ -n "$stage" && -d "$stage" ]]; then rm -rf -- "$stage"; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

printf '%s  %s\n' "$digest" "$archive" | sha256sum -c -
test -z "$(git -C "$live_dir" status --porcelain)" || { echo 'Pi source has local changes; refusing to overwrite.' >&2; exit 1; }
origin="$(git -C "$live_dir" remote get-url origin)"
stage="$(mktemp -d "$HOME/.saxi-release.XXXXXX")"
tar -xzf "$archive" -C "$stage"
git -C "$stage" init -q
git -C "$stage" remote add origin "$origin"
git -C "$stage" fetch -q --depth=1 origin "$revision"
git -C "$stage" reset -q --mixed FETCH_HEAD
git -C "$stage" branch -M main
git -C "$stage" update-ref refs/remotes/origin/main "$revision"
git -C "$stage" branch --set-upstream-to=origin/main main >/dev/null
git -C "$stage" diff --exit-code
cd "$stage"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
npm rebuild @serialport/bindings-cpp --ignore-scripts=false --no-audit --no-fund
node --input-type=module -e 'import {autoDetect} from "@serialport/bindings-cpp"; if (typeof autoDetect().list !== "function") process.exit(1);'
node cli.mjs --version

# The server atomically refuses this reservation if a plot is active.
curl --fail-with-body -sS -X POST -H 'Content-Type: application/json' -d '{"updating":true}' http://127.0.0.1/maintenance
locked=1
sudo -n install -d -m 700 /var/backups/plotter-pi
backup="$(sudo -n mktemp -d /var/backups/plotter-pi/saxi-update.XXXXXX)"
sudo -n cp -a /etc/systemd/system/saxi.service "$backup/saxi.service"
if [[ -d "$HOME/.local/share/saxi" ]]; then sudo -n cp -a "$HOME/.local/share/saxi" "$backup/data"; fi
sudo -n systemctl stop saxi
stopped=1
sudo -n mv "$live_dir" "$backup/saxi"
mv "$stage" "$live_dir"
swapped=1
stage=''
sudo -n systemctl start saxi

healthy=0
for _attempt in {1..20}; do
  if curl -fsS http://127.0.0.1/plot/status | node -e 'let b=""; process.stdin.on("data",c=>b+=c); process.stdin.on("end",()=>{try{if(JSON.parse(b).plotting!==false)process.exit(1)}catch{process.exit(1)}})'; then
    if systemctl is-active --quiet saxi; then healthy=1; break; fi
  fi
  sleep 1
done
if (( ! healthy )); then echo 'New service failed its health check.' >&2; exit 1; fi
node "$live_dir/scripts/verify-server.mjs"
curl -fsS -X DELETE http://127.0.0.1/maintenance >/dev/null
locked=0
echo "Installed $revision. Previous installation: $backup/saxi"
