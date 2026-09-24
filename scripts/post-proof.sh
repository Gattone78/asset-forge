#!/bin/bash
# Phase 2 step 3 proof: the chosen post pipeline end to end on the three robot meshes.
#   in-graph DC remesh (painted) -> gltf-transform weld+simplify -> Blender: normalize, UV, bake albedo
#   from the 15 M-tri painted raw (selected-to-active), thumbnail, GLB + FBX -> meshopt -> sidecar.
# Produces docs-ready renders: robot-seedN-final.png (baked albedo) next to the bake-off renders.
#   ./scripts/post-proof.sh [hires|self]     (default hires; "self" bakes from the decimated mesh's own colours)
set -u
cd "$(dirname "$0")/.."
MODE="${1:-hires}"
OUT=/srv/forge/comfy/output/phase2
BK=/srv/forge/bakeoff; mkdir -p "$BK/renders"
POST="sudo nerdctl run --rm --user 1000:1000 -v /srv/forge:/srv/forge forge/svc-post:0.1.0"
BL="sudo nerdctl run --rm --user 1000:1000 -v /srv/forge:/srv/forge --entrypoint blender forge/svc-post:0.1.0 -b --python-exit-code 1 --python /app/blender/forge_post.py --"
CHECK="sudo nerdctl run --rm -v /srv/forge:/srv/forge forge/comfyui:0.1.0 python /srv/forge/src/asset-forge/scripts/check_mesh.py"
PROFILE=/srv/forge/profiles/meadowbots-flat.yaml
ts() { date +%T; }
for s in 1 2 3; do
  rem=$OUT/robot-seed$s-remeshed-painted_00001_.glb
  raw=$OUT/robot-seed$s-painted_00001_.glb
  name="meadowbots-creature-garden-robot-seed$s"
  echo "[$(ts)] ==== seed $s ($MODE bake) ===="
  if [ "$MODE" = hires ]; then
    $POST --in "$rem" --hires "$raw" --out-dir "$BK/final-seed$s" --name "$name" --profile "$PROFILE" --decimate gltf --material flat-albedo
  else
    $POST --in "$rem" --out-dir "$BK/final-seed$s" --name "$name" --profile "$PROFILE" --decimate gltf --material flat-albedo
  fi
  echo "[$(ts)] check + render"
  $CHECK "$BK/final-seed$s/$name.glb" --min-tris 1000 | grep -E "triangles=|boundary|primitives" | sed "s/^/  seed$s final: /"
  $BL render --in "$BK/final-seed$s/$name.blender.glb" --out "$BK/renders/robot-seed$s-final.png" --stats "$BK/robot-seed$s-final.stats.json"
  ls -la "$BK/final-seed$s/" | sed "s/^/  /"
done
echo "[$(ts)] PROOF DONE"
