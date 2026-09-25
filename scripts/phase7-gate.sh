#!/bin/bash
# Phase 7 Blackwell gate (req §7 Phase 7): ACE-Step 1.5 (music), Stable Audio 3 Small-SFX (sfx) and MMAudio (foley from a
# Phase 6 clip) on the RTX PRO 6000 via scripts/run_workflow.py (wall time + peak VRAM), each output must be non-silent
# (mean level above -50 dBFS, measured with ffmpeg in the svc-post image); then the CPU narration gate in svc-audio.
# Runs on the GPU VM (hqadmin) from /srv/forge/src/asset-forge, e.g.:
#   tmux new -d -s forge-gate 'bash scripts/phase7-gate.sh > /srv/forge/tmp/phase7-gate.log 2>&1'
set -u
cd /srv/forge/src/asset-forge
say() { echo "[$(date +%T)] $*"; }
level() {  # mean/max volume of an audio file, via the svc-post image's ffmpeg
  sudo nerdctl run --rm --user 1000:1000 -v /srv/forge:/srv/forge --entrypoint ffmpeg forge/svc-post:0.1.0 -v info -i "$1" -af volumedetect -f null - 2>&1 | grep -E "mean_volume|max_volume|Duration" | tr -s " " | tr "\n" " "; echo
}
nonsilent() { local m; m=$(sudo nerdctl run --rm --user 1000:1000 -v /srv/forge:/srv/forge --entrypoint ffmpeg forge/svc-post:0.1.0 -v info -i "$1" -af volumedetect -f null - 2>&1 | sed -nE "s/.*mean_volume: (-?[0-9.]+) dB.*/\1/p"); [ -n "$m" ] && awk -v m="$m" 'BEGIN{exit !(m > -50)}'; }

# 0. models + images
grep -q "] DONE" /srv/forge/models/download-audio.log || { say "download not finished"; exit 1; }
grep -q "^FAILED" /srv/forge/models/download-audio.log && { say "download FAILED"; grep "^FAILED" /srv/forge/models/download-audio.log; exit 1; }
sudo nerdctl images | grep -q "forge/comfyui *0.1.1" || { say "forge/comfyui:0.1.1 missing"; exit 1; }
sudo nerdctl images | grep -q "forge/svc-audio" || { say "forge/svc-audio missing"; exit 1; }
[ -d /srv/forge/models/mmaudio/nvidia/bigvgan_v2_44khz_128band_512x ] || { say "bigvgan folder missing"; exit 1; }

# 1. comfyui 0.1.1 up
sudo nerdctl compose -f compose.yaml up -d comfyui
for i in $(seq 1 60); do curl -sf localhost:8188/system_stats >/dev/null && break; sleep 5; done
curl -sf localhost:8188/system_stats | python3 -c 'import sys,json; s=json.load(sys.stdin); print("comfyui", s["system"]["comfyui_version"], "torch", s["system"]["pytorch_version"], s["devices"][0]["name"])' || { say "comfyui not up"; exit 1; }
curl -sf localhost:8188/object_info | python3 -c 'import sys,json; o=json.load(sys.stdin); print("nodes:", [n for n in ["TextEncodeAceStepAudio1.5","EmptyAceStep1.5LatentAudio","MMAudioSampler","MMAudioModelLoader","LoadVideo","GetVideoComponents","SaveAudio"] if n in o], "missing:", [n for n in ["TextEncodeAceStepAudio1.5","MMAudioSampler"] if n not in o])'
rm -rf /srv/forge/comfy/output/phase7

# 2. music: ACE-Step 1.5 turbo, 30 s instrumental, seed 1 (cold, then warm at seed 2)
say "MUSIC gate: workflows/test-music.json"
python3 scripts/run_workflow.py workflows/test-music.json --timeout 1800 || { say "music workflow FAILED"; exit 1; }
python3 scripts/run_workflow.py workflows/test-music.json --timeout 1800 --set 5.seed=2 --set 8.seed=2 --set '10.filename_prefix="phase7/test-music-seed2"' || { say "music rerun FAILED"; exit 1; }
f=$(ls /srv/forge/comfy/output/phase7/test-music_*.flac | head -1); level "$f"; nonsilent "$f" && say "music: non-silent OK" || { say "music: SILENT"; exit 1; }

# 3. sfx: Stable Audio 3 Small-SFX, 5 s, seed 1 (cold, then warm at seed 2)
say "SFX gate: workflows/test-sfx.json"
python3 scripts/run_workflow.py workflows/test-sfx.json --timeout 1800 || { say "sfx workflow FAILED"; exit 1; }
python3 scripts/run_workflow.py workflows/test-sfx.json --timeout 1800 --set 6.seed=2 --set '8.filename_prefix="phase7/test-sfx-seed2"' || { say "sfx rerun FAILED"; exit 1; }
f=$(ls /srv/forge/comfy/output/phase7/test-sfx_*.flac | head -1); level "$f"; nonsilent "$f" && say "sfx: non-silent OK" || { say "sfx: SILENT"; exit 1; }

# 4. foley: MMAudio on the Phase 6 robot clip (comfy/input/phase7/clip.mp4), seed 1
say "FOLEY gate: workflows/test-foley.json"
python3 scripts/run_workflow.py workflows/test-foley.json --timeout 1800 || { say "foley workflow FAILED"; exit 1; }
f=$(ls /srv/forge/comfy/output/phase7/test-foley_*.flac | head -1); level "$f"; nonsilent "$f" && say "foley: non-silent OK" || { say "foley: SILENT"; exit 1; }
ls -la /srv/forge/comfy/output/phase7/

# 5. narration: svc-audio (CPU), one sentence
say "TTS gate: svc-audio"
out=/srv/forge/tmp/phase7/tts; rm -rf "$out"; mkdir -p "$out"
t0=$(date +%s)
sudo nerdctl run --rm --user 1000:1000 -v /srv/forge:/srv/forge forge/svc-audio:0.1.0 --text "Welcome to Meadowbots, a garden of little robots." --voice af_heart --out-dir "$out" --name test-tts || { say "tts FAILED (exit $?)"; exit 1; }
say "tts wall $(( $(date +%s) - t0 )) s"; python3 -c "import json; print(json.load(open('$out/test-tts.sidecar.json'))['audio'])"
say "GATE PASSED"
