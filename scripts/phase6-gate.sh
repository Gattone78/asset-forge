#!/bin/bash
# Phase 6 Blackwell gate (req §7 Phase 6): Wan 2.2 14B text-to-video and image-to-video on the RTX PRO 6000,
# wall time + peak VRAM via scripts/run_workflow.py, then svc-post --mode video must find the clips non-blank.
# Runs on the GPU VM (hqadmin) from /srv/forge/src/asset-forge, e.g.:
#   tmux new -d -s forge-gate 'bash scripts/phase6-gate.sh > /srv/forge/tmp/phase6-gate.log 2>&1'
set -u
cd /srv/forge/src/asset-forge
say() { echo "[$(date +%T)] $*"; }

# 0. models present (download-wan22.sh writes "[hh:mm:ss] DONE" when it finishes)
until grep -q "] DONE" /srv/forge/models/download-wan22.log; do sleep 30; done
if grep -q "^FAILED" /srv/forge/models/download-wan22.log; then say "download FAILED"; grep "^FAILED" /srv/forge/models/download-wan22.log; exit 1; fi
say "models:"; ls -la /srv/forge/models/diffusion_models/wan2* /srv/forge/models/loras/wan2* /srv/forge/models/text_encoders/umt5* /srv/forge/models/vae/wan*

# 1. comfyui up (forge-api stops it again after its idle timeout once a job has run; the gate does not go through forge-api)
sudo nerdctl compose -f compose.yaml up -d --force-recreate comfyui
for i in $(seq 1 60); do curl -sf localhost:8188/system_stats >/dev/null && break; sleep 5; done
curl -sf localhost:8188/system_stats | python3 -c 'import sys,json; s=json.load(sys.stdin); print("comfyui", s["system"]["comfyui_version"], "torch", s["system"]["pytorch_version"], s["devices"][0]["name"])' || { say "comfyui not up"; exit 1; }

# 2. text-to-video: workflows/test-video.json (seed 1, 832x480, 81 frames @16 fps, lightx2v 4-step)
rm -rf /srv/forge/comfy/output/phase6
say "T2V gate: workflows/test-video.json"
python3 scripts/run_workflow.py workflows/test-video.json --timeout 3600 || { say "T2V workflow FAILED"; exit 1; }
say "T2V second run (warm models, same seed) for the steady-state time"
python3 scripts/run_workflow.py workflows/test-video.json --timeout 3600 || { say "T2V rerun FAILED"; exit 1; }

# 3. image-to-video: workflows/image-to-video.json with the approved snail thumbnail as init image (copied to comfy/input/jobs/phase6/init.png)
say "I2V gate: workflows/image-to-video.json + jobs/phase6/init.png"
python3 scripts/run_workflow.py workflows/image-to-video.json --timeout 3600 \
  --set '17.image="jobs/phase6/init.png"' --set '16.filename_prefix="phase6/test-i2v"' --set '12.noise_seed=1' --set '13.noise_seed=1' \
  || { say "I2V workflow FAILED"; exit 1; }

ls -la /srv/forge/comfy/output/phase6/

# 4. svc-post video mode: transcode + poster + non-blank/motion check (exit 3 = blank)
for n in test-video test-i2v; do
  src=$(ls /srv/forge/comfy/output/phase6/${n}_*.mp4 | tail -1)
  out=/srv/forge/tmp/phase6/$n; rm -rf "$out"; mkdir -p "$out"
  say "svc-post --mode video $src"
  sudo nerdctl run --rm --user 1000:1000 -v /srv/forge:/srv/forge forge/svc-post:0.1.0 --mode video --in "$src" --out-dir "$out" --name "$n" || { say "$n: svc-post video FAILED (exit $?)"; exit 1; }
  python3 -c "import json; v=json.load(open('$out/$n.sidecar.json'))['video']; print('$n', v)"
done
say "GATE PASSED"
