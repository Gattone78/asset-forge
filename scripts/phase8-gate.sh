#!/bin/bash
# Phase 8 Blackwell gate: Qwen-Image-Edit 2511 restyle on the RTX PRO 6000 (workflows/test-restyle.json, seed 1, "pixar" instruction),
# wall time + peak VRAM via scripts/run_workflow.py; the output must differ from the input (SSIM below 0.9) and must not be blank.
# Input photo: comfy/input/phase8/photo.png (the gate uses the Phase 6 robot poster frame — a photoreal-looking render we own).
# Runs on the GPU VM (hqadmin) from /srv/forge/src/asset-forge:
#   tmux new -d -s forge-gate 'bash scripts/phase8-gate.sh > /srv/forge/tmp/phase8-gate.log 2>&1'
set -u
cd /srv/forge/src/asset-forge
say() { echo "[$(date +%T)] $*"; }
ff() { sudo nerdctl run --rm --user 1000:1000 -v /srv/forge:/srv/forge --entrypoint ffmpeg forge/svc-post:0.1.0 "$@"; }

grep -q "] DONE" /srv/forge/models/download-qwen-edit.log || { say "download not finished"; exit 1; }
grep -q "^FAILED" /srv/forge/models/download-qwen-edit.log && { say "download FAILED"; exit 1; }
[ -f /srv/forge/comfy/input/phase8/photo.png ] || { say "no gate photo at comfy/input/phase8/photo.png"; exit 1; }

sudo nerdctl compose -f compose.yaml up -d --force-recreate comfyui
for i in $(seq 1 60); do curl -sf localhost:8188/system_stats >/dev/null && break; sleep 5; done
curl -sf localhost:8188/object_info | python3 -c 'import sys,json; o=json.load(sys.stdin); need=["TextEncodeQwenImageEditPlus","FluxKontextImageScale","FluxKontextMultiReferenceLatentMethod","CFGNorm"]; print("nodes missing:", [n for n in need if n not in o])' || { say "comfyui not up"; exit 1; }
rm -rf /srv/forge/comfy/output/phase8

say "RESTYLE gate: workflows/test-restyle.json (pixar, seed 1, cold)"
python3 scripts/run_workflow.py workflows/test-restyle.json --timeout 1800 || { say "restyle workflow FAILED"; exit 1; }
say "RESTYLE warm, seed 2, 2d instruction"
python3 scripts/run_workflow.py workflows/test-restyle.json --timeout 1800 --set 13.seed=2 --set '15.filename_prefix="phase8/test-restyle-2d"' \
  --set '8.prompt="Redraw this as a flat 2D cartoon: clean line art, cel shading, simple shapes, bright flat colors, keep the same subject, pose and framing"' || { say "restyle rerun FAILED"; exit 1; }
ls -la /srv/forge/comfy/output/phase8/

out=$(ls /srv/forge/comfy/output/phase8/test-restyle_*.png | head -1)
# SSIM of the input (scaled to the output's size) against the restyled output; "All:" is the mean over channels. 1.0 = identical.
ssim=$(ff -v info -i /srv/forge/comfy/input/phase8/photo.png -i "$out" -filter_complex "[0:v][1:v]scale2ref[a][b];[a][b]ssim" -f null - 2>&1 | sed -nE 's/.*All:([0-9.]+).*/\1/p' | tail -1)
sz=$(stat -c %s "$out")
say "SSIM input vs restyled: ${ssim:-?}; output ${sz} bytes"
[ "$sz" -gt 50000 ] || { say "restyle: output too small to be a real image"; exit 1; }
awk -v s="${ssim:-1}" 'BEGIN{exit !(s < 0.9)}' && say "restyle: changed the image, OK" || { say "restyle: FAILED — output (nearly) identical to the input"; exit 1; }
say "GATE PASSED"
