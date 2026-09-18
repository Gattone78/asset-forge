# Phase 2 — Prompt → GLB creature, end to end

Date: 2026-09-18. Host `k8s-gpu-1` (`ssh gpu`), big-cat stopped by Phil, Proxmox untouched. Branch `phase-2`.

## Checkpoint A — post stage

### 1. BuildKit cache location
`forge-buildkit.service` runs `buildkitd --root /srv/forge/buildkit` and `buildctl du` reports 26.9 GB there. **The cache is on `/srv/forge`; nothing to fix.** The Phase 1 root-disk swing (46 → 104 GB) was containerd's content store and overlay snapshots on the root disk during `nerdctl load` of the built image, which §9 explicitly allows ("containerd keeps images on the root disk"). `/var/lib/nerdctl` (41 GB) is big-cat's named volumes.

### 2. Decimation bake-off (three TRELLIS.2 meshes, seeds 1/2/3 of the Phase 1 robot)

Routes, all to the `meadowbots-flat` budget (target 12 k, max 20 k tris), measured on the mesh *before* Blender export (Blender's exporter splits vertices at UV seams, which would read as open edges):

| Route | seed 1 | seed 2 | seed 3 | Wall | Verdict |
|---|---|---|---|---|---|
| raw (TRELLIS.2, vertex-painted) | 15.43 M tris, 368 MB | 14.53 M | 15.0 M | — | input |
| A `gltf-transform weld → simplify` from raw | stalls at 8.07 M (0.34 % boundary); Blender fallback 746 k | stalls 7.19 M → 542 k | stalls 6.53 M → 499 k | 185–267 s | dead end — meshopt's simplifier will not collapse the decoder's topology |
| B in-graph `RemeshMesh` + `DecimateMesh` (midpoint) | 19,262 tris, **4.06 %** boundary edges, 162 KB | 19,812, 2.15 % | 19,905, 0.43 % | ~1 s | in budget but visibly mangled (see renders) |
| **C in-graph `RemeshMesh` (udf 512) → `gltf-transform weld → simplify`** | **13,148 tris, 0 boundary, 106 KB** | **11,639, 0, 90 KB** | **11,683, 0, 93 KB** | ~20 s | **pick** |
| D in-graph remesh → Blender collapse decimate | 132 k tris (cannot reach ratio), 743 KB | 31.8 k | 27.7 k | 87–108 s | slow, misses target |

**Why C:** it is the only route that reaches the budget with zero boundary edges on every seed, it is the smallest file, it is fast, and it keeps the silhouette (renders). The DC remesh has to stay on the GPU side because gltf-transform cannot simplify the raw decoder output at all (route A), so the split is: remesh in `workflows/image-to-3d.json`, simplify/bake in `svc-post`. Route B's in-graph decimator was also found to be **non-deterministic** on identical input (19,687 vs 19,779 tris), another reason not to use it. `simplify` needs `--error 0.003` (0.001 stops at ~40–80 k); svc-post loosens the error ×3 per attempt until the mesh is under `max_tris`, and falls back to Blender collapse if that ever fails.

Renders (same orthographic camera, azimuth 35°, elevation 18°) in `docs/phase-2/renders/`: `robot-seedN-raw.png`, `-ingraph.png` (B), `-gltftransform.png` (A), `-remesh-gltftransform.png` (C, vertex colours), `-remesh-blender.png` (D), `-final.png` (C + baked albedo). Copied to Phil's `~/forge-review/`.

### 3. Post pipeline (svc-post) — proven on the three meshes

`svc-post` = `node:22-bookworm-slim` + `@gltf-transform/cli 4.5.0` + **Blender 4.5.14 LTS** headless, run per job as uid 1000 via `sudo nerdctl run --rm --user 1000:1000 -v /srv/forge:/srv/forge forge/svc-post:0.1.0` (`nerdctl compose run` insists on a TTY and has no `-T`, so the API uses plain `nerdctl run`). Orchestrator `svc-post/post.mjs`; Blender part `svc-post/blender/forge_post.py` (`process` and `render` subcommands).

Steps and results per mesh (`/srv/forge/bakeoff/final-seedN/`):

1. `gltf-transform weld` + `simplify` (route C) — 11.6–13.1 k tris.
2. Blender: join to one object named `pivot_root` (§8), **normalize** — origin at feet, centred, uniform scale to `target_height_m` (0.6 m), Y-up, −Z forward. TRELLIS.2 output already faces −Z (checked by rendering the seed-1 mesh from four azimuths), so `forward_yaw_deg` is 0 in the profile and stays available for other models.
3. **Bake to albedo (flat profile):** Smart-UV the low-poly, then Cycles CPU `EMIT` bake **selected-to-active from the 15 M-triangle painted raw mesh** (cage 2 % of height) into a 2048² PNG; 11–15 s. Vertex colours are then dropped and the material is Principled with the texture as base colour, roughness 1, specular 0. Baking from the high-res source rather than the decimated mesh's own vertex colours is what keeps the eyes and stripes sharp (`robot-seedN-final.png` vs `-remesh-gltftransform.png`).
4. Thumbnail (`thumb.png`, 512², Cycles CPU, emission-only so lighting-independent), GLB export (point-domain colours / shared vertices), **FBX export** (`-Z forward`, `Y up`, textures embedded).
5. `gltf-transform meshopt` (`EXT_meshopt_compression` + `KHR_mesh_quantization`, both *required* extensions — Three.js needs `GLTFLoader.setMeshoptDecoder`) → final `.glb`.
6. Sidecar JSON with the post stage, geometry (tris, verts, height, bbox in glTF axes), textures, files.

| Mesh | Final tris | Final GLB | FBX | Post wall |
|---|---|---|---|---|
| seed 1 | 13,148 | 3.68 MB | 505 KB | 41.0 s |
| seed 2 | 11,639 | 3.12 MB | 437 KB | 40.9 s |
| seed 3 | 11,683 | 3.33 MB | 441 KB | 33.3 s |

The GLB size is the 2048² albedo PNG; the geometry itself is ~100 KB. `gltf-transform validate` reports no errors or hints on the final files.

### Determinism (checked because §7 requires byte-identical reruns)

- **Cold container:** FLUX seed 1 and TRELLIS.2 seed 1 reproduce exactly. Four cold runs across two sessions (Phase 1 ×2, `det2-a`, `det2-b`) have the identical geometry hash (`e5d069fd…`, 14,040,584 tris) and identical FLUX pixel data (`ae9e76b5…`).
- **But not byte-identical files:** ComfyUI embeds the whole prompt (including the output filename prefix) in the GLB `asset.extras` and in PNG text chunks, so any two runs differ in metadata. The reproducibility test therefore compares the GLB binary chunk and the PNG pixel data.
- **Warm container after other seeds:** seed 1 run after seeds 2 and 3 in the same process produced a different mesh (15,427,684 tris). So reproducibility holds for cold starts. `forge-api` restarts `comfyui` before a same-seed rerun (`POST /jobs/:id/rerun` without a new seed), which costs about 40 s and is the on-demand path anyway.
- In-graph `DecimateMesh` is non-deterministic even on identical input; it is not used.

## Checkpoint B — forge-api + CLI

(filled in below)
