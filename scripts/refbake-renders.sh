#!/bin/bash
# Render each reference-image bake-off job's final GLB from front (az 0), side (az 90) and back (az 180)
# so mesh completeness, back-side detail and silhouette can be compared between views=front and views=multi.
#   ./scripts/refbake-renders.sh <job-id>:<label> ...      (labels like robot-front, robot-multi)
set -u
BL="sudo nerdctl run --rm --user 1000:1000 -v /srv/forge:/srv/forge --entrypoint blender forge/svc-post:0.1.0 -b --python-exit-code 1 --python /app/blender/forge_post.py --"
OUT=/srv/forge/bakeoff/refbake; mkdir -p "$OUT"
for spec in "$@"; do
  id="${spec%%:*}"; label="${spec##*:}"
  glb=$(ls /srv/forge/jobs/$id/out/*.blender.glb 2>/dev/null | head -1)
  [ -z "$glb" ] && glb=$(ls /srv/forge/jobs/$id/out/*.glb | grep -v blender | head -1)
  for az in 0 90 180; do
    case $az in 0) v=front;; 90) v=side;; 180) v=back;; esac
    $BL render --in "$glb" --out "$OUT/refbake-$label-$v.png" --size 512 --azimuth $az --elevation 12 2>&1 | grep -E "forge_post\] render"
  done
done
echo REFBAKE DONE
