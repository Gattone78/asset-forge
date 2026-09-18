#!/bin/bash
# Build the comfyui image on the VM using the Forge BuildKit daemon (cache on /srv/forge).
# Run on gpu from the repo checkout: ./deploy/build.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export BUILDKIT_HOST=unix:///run/forge-buildkit/buildkitd.sock
export TMPDIR=/srv/forge/tmp
mkdir -p "$TMPDIR"
echo "[$(date +%T)] root free before: $(df -h / | awk 'NR==2{print $4}')"
sudo env BUILDKIT_HOST="$BUILDKIT_HOST" TMPDIR="$TMPDIR" nerdctl compose build --progress plain comfyui
echo "[$(date +%T)] root free after:  $(df -h / | awk 'NR==2{print $4}')"
sudo nerdctl images | grep forge/comfyui
echo "[$(date +%T)] BUILD DONE"
