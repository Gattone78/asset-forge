#!/bin/bash
# Build a Forge image on the VM using the Forge BuildKit daemon (cache on /srv/forge).
# Run on gpu from the repo checkout:  ./deploy/build.sh [service]   (default: comfyui)
set -euo pipefail
cd "$(dirname "$0")/.."
SERVICE="${1:-comfyui}"
export BUILDKIT_HOST=unix:///run/forge-buildkit/buildkitd.sock
export TMPDIR=/srv/forge/tmp
mkdir -p "$TMPDIR"
echo "[$(date +%T)] root free before: $(df -h / | awk 'NR==2{print $4}')"
sudo env BUILDKIT_HOST="$BUILDKIT_HOST" TMPDIR="$TMPDIR" nerdctl compose --profile tools build --progress plain "$SERVICE"
echo "[$(date +%T)] root free after:  $(df -h / | awk 'NR==2{print $4}')"
sudo nerdctl images | grep "forge/$SERVICE"
echo "[$(date +%T)] BUILD DONE"
