#!/usr/bin/env bash
set -euo pipefail

main() {
  target="${1:-pedro@plotter-pi.local}"
  repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$repo"
  if [[ -n "$(git status --porcelain)" ]]; then
    echo 'Commit or stash local changes before updating.' >&2
    return 1
  fi
  git fetch origin main
  git merge --ff-only origin/main
  test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" || { echo 'Local commits have not been pushed to main.' >&2; return 1; }
  revision="$(git rev-parse HEAD)"
  temporary="$(mktemp -d "${TMPDIR:-/tmp}/saxi-build.XXXXXX")"
  remote_dir=''
  trap 'rm -rf "$temporary"; if [[ -n "$remote_dir" ]]; then ssh -o BatchMode=yes "$target" "rm -rf -- '\''$remote_dir'\''" || true; fi' EXIT

  echo "Building and testing $revision on this computer…"
  npm ci --ignore-scripts --no-audit --no-fund
  npm run build
  npm test
  mkdir "$temporary/release"
  git archive HEAD | tar -x -C "$temporary/release"
  cp -R dist "$temporary/release/dist"
  COPYFILE_DISABLE=1 tar --no-xattrs -czf "$temporary/release.tgz" -C "$temporary/release" .
  digest="$(shasum -a 256 "$temporary/release.tgz" | cut -d ' ' -f 1)"
  remote_dir="$(ssh -o BatchMode=yes "$target" 'mktemp -d /tmp/saxi-upload.XXXXXX')"
  if [[ ! "$remote_dir" =~ ^/tmp/saxi-upload\.[a-zA-Z0-9]+$ ]]; then
    echo 'Unexpected upload directory from the Pi.' >&2
    remote_dir=''
    return 1
  fi
  scp "$temporary/release.tgz" scripts/deploy-pi.sh "$target:$remote_dir/"
  ssh -o BatchMode=yes "$target" "bash '$remote_dir/deploy-pi.sh' '$revision' '$digest' '$remote_dir/release.tgz'"
}

main "$@"
