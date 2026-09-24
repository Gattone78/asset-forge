#!/bin/bash
# Build the review UI on the VM: npm install + nuxt generate -> forge-ui/.output/public, then restart forge-api
# so it picks the static files up. Run on gpu from the repo checkout:  ./deploy/build-ui.sh
set -euo pipefail
cd "$(dirname "$0")/../forge-ui"
export PATH=/srv/forge/tools/node/bin:$PATH
export NUXT_TELEMETRY_DISABLED=1
echo "[$(date +%T)] npm install"; npm install --no-audit --no-fund 2>&1 | tail -2
echo "[$(date +%T)] nuxt generate"; npx nuxt generate 2>&1 | tail -8
ls .output/public | head; du -sh .output/public
echo "[$(date +%T)] restart forge-api"; sudo systemctl restart forge-api; sleep 3; systemctl is-active forge-api
curl -s -o /dev/null -w "GET /ui/ -> HTTP %{http_code}\n" http://127.0.0.1:8080/ui/
echo "[$(date +%T)] UI BUILD DONE"
