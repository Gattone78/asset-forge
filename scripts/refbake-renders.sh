#!/bin/bash
# Render each reference-image bake-off job's final GLB from front (az 0), side (az 90) and back (az 180)
# so mesh completeness, back-side detail and silhouette can be compared between views=front and views=multi.
#   ./scripts/refbake-renders.sh <job-id>:<label> ...      (labels like robot-front, robot-multi)
# Uses <name>.blender.glb (uncompressed) when present; otherwise decompresses the meshopt final with
# gltf-transform first, since Blender's importer has no EXT_meshopt_compression decoder.
set -u
GT="sudo nerdctl run --rm --user 1000:1000 -v /srv/forge:/srv/forge --entrypoint gltf-transform forge/svc-post:0.1.0"
BL="sudo nerdctl run --rm --user 1000:1000 -v /srv/forge:/srv/forge --entrypoint blender forge/svc-post:0.1.0 -b --python-exit-code 1 --python /app/blender/forge_post.py --"
OUT=/srv/forge/bakeoff/refbake; mkdir -p "$OUT"
for spec in "$@"; do
  id="${spec%%:*}"; label="${spec##*:}"
  glb=$(ls /srv/forge/jobs/$id/out/*.blender.glb 2>/dev/null | head -1)
  if [ -z "$glb" ]; then
    final=$(ls /srv/forge/jobs/$id/out/*.glb | grep -v blender | head -1)
    glb="$OUT/$label.plain.glb"
    $GT copy "$final" "$glb" >/dev/null 2>&1 || { echo "decompress failed for $label"; continue; }
  fi
  for az in 0 90 180; do
    case $az in 0) v=front;; 90) v=side;; 180) v=back;; esac
    $BL render --in "$glb" --out "$OUT/refbake-$label-$v.png" --size 512 --azimuth $az --elevation 12 2>&1 | grep -E "forge_post\] render|Error|rror:" | tail -2
  done
done
ls "$OUT"
echo REFBAKE DONE
