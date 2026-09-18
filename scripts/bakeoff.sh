#!/bin/bash
# Phase 2 decimation bake-off on the VM. For each seed: three decimation routes to the profile budget,
# boundary-edge check, and matching-angle renders. Then the full flat-albedo post pipeline on every route
# so Phil can compare the baked result too.
#   ./scripts/bakeoff.sh            (from /srv/forge/src/asset-forge; needs forge/svc-post + forge/comfyui images)
# Plain `nerdctl run` rather than `nerdctl compose run`: compose run insists on a TTY and has no -T flag (nerdctl 2.3.5).
set -u
cd "$(dirname "$0")/.."
OUT=/srv/forge/comfy/output/phase2
BK=/srv/forge/bakeoff; mkdir -p "$BK/renders"
POST="sudo nerdctl run --rm --user 1000:1000 -v /srv/forge:/srv/forge forge/svc-post:0.1.0"
BL="sudo nerdctl run --rm --user 1000:1000 -v /srv/forge:/srv/forge --entrypoint blender forge/svc-post:0.1.0 -b --python-exit-code 1 --python /app/blender/forge_post.py --"
CHECK="sudo nerdctl run --rm -v /srv/forge:/srv/forge forge/comfyui:0.1.0 python /srv/forge/src/asset-forge/scripts/check_mesh.py"
PROFILE=/srv/forge/profiles/meadowbots-flat.yaml
ts() { date +%T; }
for s in 1 2 3; do
  raw=$OUT/robot-seed$s-painted_00001_.glb          # 14 M tris, vertex colours
  ing=$OUT/robot-seed$s-ingraph20k_00001_.glb       # in-graph remesh+decimate, painted
  rem=$OUT/robot-seed$s-remeshed-painted_00001_.glb # in-graph DC remesh (5.7 M), painted
  echo "[$(ts)] ==== seed $s ===="
  echo "[$(ts)] render raw"
  $BL render --in "$raw" --out "$BK/renders/robot-seed$s-raw.png" --stats "$BK/robot-seed$s-raw.stats.json" --force-vertex-colors
  # Route A: gltf-transform weld+simplify straight from the 14 M raw
  echo "[$(ts)] route A gltftransform"
  $POST --in "$raw" --out-dir "$BK/seed$s-gltftransform" --name "robot-seed$s-gltftransform" --profile "$PROFILE" --decimate gltf --material vertex --no-fbx
  # Route B: in-graph remesh + midpoint decimate (already ~20k)
  echo "[$(ts)] route B ingraph"
  $POST --in "$ing" --out-dir "$BK/seed$s-ingraph" --name "robot-seed$s-ingraph" --profile "$PROFILE" --decimate none --material vertex --no-fbx
  # Route C: in-graph DC remesh (5.7 M, closed) then gltf-transform simplify
  echo "[$(ts)] route C hybrid"
  $POST --in "$rem" --out-dir "$BK/seed$s-hybrid" --name "robot-seed$s-hybrid" --profile "$PROFILE" --decimate gltf --material vertex --no-fbx
  # Route D: in-graph DC remesh then Blender collapse decimate
  echo "[$(ts)] route D blender"
  $POST --in "$rem" --out-dir "$BK/seed$s-blender" --name "robot-seed$s-blender" --profile "$PROFILE" --decimate blender --material vertex --no-fbx
  for r in gltftransform ingraph hybrid blender; do
    echo "[$(ts)] check $r"
    pre="$BK/seed$s-$r/robot-seed$s-$r.simplified.glb"; [ -f "$pre" ] || pre="$BK/seed$s-$r/robot-seed$s-$r.blender.glb"
    $CHECK "$pre" --min-tris 1000 | grep -E "triangles=|boundary|PASS|FAIL" | sed "s/^/  seed$s $r (pre-export $(basename $pre)): /"
    $CHECK "$BK/seed$s-$r/robot-seed$s-$r.glb" --min-tris 1000 | grep -E "triangles=|boundary" | sed "s/^/  seed$s $r (final glb): /"
    $BL render --in "$BK/seed$s-$r/robot-seed$s-$r.blender.glb" --out "$BK/renders/robot-seed$s-$r.png" --stats "$BK/robot-seed$s-$r.stats.json"
  done
done
echo "[$(ts)] BAKEOFF DONE"
