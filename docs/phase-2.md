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
2. Blender: join to one object named `pivot_root` (§8), **normalize** — origin at feet, centred, uniform scale to `target_height_m` (0.6 m), Y-up, −Z forward. **Correction from Checkpoint B:** TRELLIS.2 output faces **+Z** (the glTF convention), not −Z as the Checkpoint A draft claimed — my Blender azimuth test had the glTF↔Blender axis mapping inverted, and the Three.js viewer (camera on −Z shows the back) settled it. The profile now sets `forward_yaw_deg: 180` and normalize turns the model to face −Z.
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

### 4. forge-api

`forge-api/` — Fastify 5, better-sqlite3 (WAL), `ws`, `sharp`, `yaml`; TypeScript run directly by **Node 22.23.2's type stripping** (no build step; Node lives at `/srv/forge/tools/node`, installed from the official tarball, nothing apt-installed). ~600 lines in six files:

| File | Role |
|---|---|
| `src/server.ts` | REST per §6 (`POST/GET /jobs`, `/jobs/:id`, `/jobs/:id/assets`, `/assets/:job/*`, `approve`, `reject`, `rerun`, `/profiles`, `/health`, plus `/jobs/:id/log` and a `/viewer` debug page) |
| `src/worker.ts` | single worker loop: `refs → 3d → post`, job folder layout per §4, candidate pick, idle timer |
| `src/comfy.ts` | ComfyUI client (`POST /prompt`, WebSocket `executing`/`progress`/`execution_error`, `/history`), container lifecycle, free-VRAM guard, boot gate |
| `src/workflows.ts` | loads `workflows/*.json`, addresses nodes **by `_meta.title` only** |
| `src/db.ts`, `src/profiles.ts` | SQLite job table; YAML profiles + sha256 |

**Runs on the VM host, not in a container** (§3 allows either). It runs as `hqadmin` under `deploy/forge-api.service` and shells out to `sudo nerdctl compose -f compose.yaml up -d comfyui` / `stop comfyui` and `sudo nerdctl run … forge/svc-post:0.1.0`. `deploy/sudoers-forge` scopes exactly those commands (installed at `/etc/sudoers.d/forge`; hqadmin's blanket NOPASSWD makes it redundant today). nerdctl inside a container would have needed the containerd socket, CNI and nerdctl's own host state — the more fragile option.

**GPU lifecycle (§3, §9):** `ensureUp()` first waits for the host (`nvidia-smi -L` + `/var/run/cdi/nvidia.yaml`; needed — see boot note below), then applies the free-VRAM guard (`nvidia-smi --query-gpu=memory.free` < `FORGE_MIN_FREE_VRAM_GB` → refuse and name the holders), then `compose up -d comfyui` and polls `/system_stats` (ready in 7 s warm, 10–16 s cold). After a job with nothing queued, a timer fires at `FORGE_GPU_IDLE_TIMEOUT` and calls `compose stop comfyui`, then polls `nvidia-smi` until used VRAM < 1 GB — a stop counts only when VRAM is back at baseline. Observed unattended after the VM came back: 6 queued jobs ran, then `[idle] comfyui stopped in 11s; VRAM used 2 MiB`.

**Job pipeline:** `refs` = `image-refs.json` (FLUX, batch of `count` candidates at `seed`, prompt = `<prompt>, <style_prompt>, front view…`), candidates scored by subject bounding-box area × centring against a background colour estimated from the image border (FLUX's "white" is ~245, not 255), all N kept in `refs/` with `candidates.json`; `3d` = `image-to-3d.json` (the Phase 1 TRELLIS.2 graph + in-graph DC remesh, seeds = `seed+1` on all four samplers per §8, `target_resolution` from the profile) → `raw/{raw,painted,remeshed-painted}.glb`; `post` = svc-post route C with the hires bake, sidecar merged from the API's request/model stages. Files are **renamed** from ComfyUI's output dir into the job folder (same filesystem, no copy). Reruns with the same seed restart `comfyui` first (determinism finding).

**Boot note:** after the Proxmox outage the VM booted with six jobs queued. `forge-api` started at boot, picked the first job within seconds, and two jobs failed with `nvidia-smi` errors because the driver was not up yet — exactly the §9 hazard. The boot gate above (plus `After=nvidia-cdi-refresh.service`) was added and deployed; `comfyui` itself is never started at boot.

### 5. Reference-image bake-off (single front view vs multi-view)

Ran through the API as real jobs (seed 7, 3 prompts × `views=front|multi`): garden robot, chubby snail with a spiral shell, hopping frog with a leaf hat. `views=multi` generates side and back images with the same seed and view suffixes and feeds all three through `image-to-3d-multi.json` (three `LoadImage` → mask/crop each → `ImageBatch` → `Trellis2Conditioning`).

**Result: multi-view is a no-op with ComfyUI core's TRELLIS.2 node.** The frog `front` and `multi` outputs are hash-identical (raw geometry `44ce90eb…`, final `5bb71223…`), and the node's source explains why: `Trellis2Conditioning` encodes each batch image separately and concatenates them as *independent objects* (batch dimension), whereas `Pixal3DMultiViewConditioning` is the node that averages tokens across views of one object — a different model (Pixal3D, `Comfy-Org/Pixal3D`, 11 GB bf16). On top of that, FLUX schnell does not keep the character consistent across independently generated view prompts even at the same seed (the frog's side/back references are a peach-coloured different creature).

**Decision:** `image.views: front` is the profile default and the only effective mode. `POST /jobs` now returns 501 for `views=multi` with this explanation rather than silently producing the front-only result; `image-to-3d-multi.json` stays in the repo as the experiment. If back-side quality ever matters more than the extra model, the path is Pixal3D multi-view (already supported by the same ComfyUI build and template) with a consistent multi-view image source — a separate decision, not Phase 2. Renders: `docs/phase-2/renders/refbake-<creature>-<mode>-{front,side,back}.png`.

### 6. `forge` CLI
`forge-cli/forge.mjs`, zero dependencies, `FORGE_URL` (default `http://192.168.1.51:8080`): `job creature|prop|plant "prompt" [--profile --seed --count --height --views --rig]`, `status`, `watch` (polls every 2 s, prints stage/progress changes, exits 1 on failure), `list [--status --profile]`, `get <id> [dir] [--all]`, `approve`, `reject`, `rerun [--seed]`, `health`, `profiles`. Run from the workstation with `node forge-cli/forge.mjs …` (or symlink as `forge`).

### 7. Boot
`deploy/forge-api.service` (enabled) starts `forge-api` at boot; `comfyui` is only ever started by the worker on demand. `forge-buildkit.service` also starts at boot (harmless, no GPU). big-cat is untouched and does not auto-start (its own placeholder `WorkingDirectory`).

### Acceptance run (§7)

From the workstation, `FORGE_URL=http://192.168.1.51:8080`:

```
node forge-cli/forge.mjs job creature "a round friendly garden robot with big eyes" --profile meadowbots-flat --seed 1
node forge-cli/forge.mjs watch 094f127c-4f5c-4a02-bea8-a07a4f40b9cd
node forge-cli/forge.mjs get   094f127c-4f5c-4a02-bea8-a07a4f40b9cd ~/forge-review/acceptance-094f12
```

| Criterion | Result |
|---|---|
| `forge job creature …` returns a job id | yes, immediately (201) |
| `forge watch` shows stages | `starting → refs 5–30 % → 3d 30–80 % (per-sampler WebSocket progress) → post 80 % → review 100 %`; **113 s** end to end with comfyui already up (refs 22 s, 3D 52.5 s, post 38 s); ~125–175 s with a cold comfyui start |
| `forge get` downloads `.glb` + `.fbx` + sidecar | 4.26 MB GLB (2048² albedo), 0.43 MB FBX, sidecar, thumbnail, post report, plus the uncompressed `.blender.glb` |
| Loads in Three.js, stands on the ground at the requested height, faces −Z, within budget | Verified in the `/viewer` page (Three.js **0.186**, the version Meadowbots pins, `GLTFLoader` + `MeshoptDecoder` exactly as `src/core/Assets.js` in the Meadowbots repo wires them): 11,480 triangles, bbox min y = 0.0000, height 0.600 m, camera on −Z shows the face. Sidecar agrees (`bbox_min [-0.240, 0, -0.212]`, `bbox_max [0.240, 0.6, 0.212]`). Not yet dropped into the Meadowbots scene itself — that is Phil's check; the loader path is identical. |
| Same seed twice → byte-identical raw output | Geometry-identical (raw, painted and remeshed GLB binary chunks hash equal: `ba735ca4…`, `ce996173…`, `8603f3ba…`) for job `c01ffde4` and its same-seed rerun `293d25d9`; FLUX candidates pixel-identical. Files differ only in ComfyUI's embedded prompt metadata — see the determinism note above for why "byte-identical" is the wrong test. |
| After the idle timeout comfyui is stopped and VRAM ≈ 0 | Observed twice unattended with the timeout at 120 s: `[idle] comfyui stopped in 11s; VRAM used 2 MiB` (after the boot batch) and `stopped in 12s; VRAM used 2 MiB` at 17:17:49, exactly 120 s after the last job. `/health` reports `idle_stop_at` while the timer runs. Timeout restored to 600 s in `/srv/forge/.env`. |
| No non-Forge container touched | big-cat's three containers stayed in `Created` throughout |

Renders of the accepted asset (Blender, same camera as the bake-off): `docs/phase-2/renders/acceptance-robot-{front,side,back}.png`. Outputs in Phil's `~/forge-review/acceptance-094f12/`.

**Two bugs found by the acceptance run and fixed:** (1) the glTF importer leaves Blender objects in quaternion rotation mode, so `rotation_euler` — my yaw — was silently ignored until `rotation_mode = "XYZ"` was set; caught by comparing vertex arrays of a yaw-0 and yaw-180 job (identical), then confirmed rotated (x, z negated on 100 % of vertices). (2) The candidate scorer treated the whole image as subject because FLUX's white background is ≈245, not 255; now the background is estimated from the image border.

## Requirements that turned out wrong in practice (proposed changes)

1. **§7 "byte-identical raw output"** → "geometry-identical raw output from a cold `comfyui`". ComfyUI writes the prompt into every GLB and PNG, and TRELLIS.2 diverges in a warm process after other seeds. forge-api already restarts comfyui for same-seed reruns.
2. **§3 reference-image bake-off** → the multi-view arm cannot be run with TRELLIS.2 in ComfyUI core (batch = separate objects); the API returns 501 for `views=multi`. Adopting Pixal3D multi-view is a separate decision.
3. **§3 "decimate in svc-post"** → the DC remesh must run in the ComfyUI graph (GPU); svc-post only welds/simplifies/bakes. Reflected in `image-to-3d.json`.
4. **§9 boot** → `forge-api` needs an explicit GPU-host readiness gate, not just "never start comfyui at boot": with jobs queued it will start comfyui within seconds of boot, and the driver/CDI are not ready. Implemented; worth a sentence in §9.
5. **§4 storage** → a creature job keeps ~630 MB of raw TRELLIS.2 output (`raw/`). At 100 jobs that is 63 GB. Since raw output is reproducible from the seed (cold), I suggest a retention rule: keep `raw/` only for approved jobs, or prune it after N days. Not implemented — Phil's call.
6. **§8 naming** → the slug now drops stop words (`garden-robot-eyes`, not `a-round-friendly-garden-robot-wi`).

## Surprises / worth knowing

- The VM went unreachable at 20:02 UTC on 18 Sep while the first bake-off jobs ran (ping OK, all TCP dead); the guest journal simply ends, no OOM or hung-task record, and Phil then took Proxmox down. Cause unknown; nothing in the guest points at Forge. After the reboot the queued jobs ran to completion unattended.
- `nerdctl compose run` cannot run non-interactively (no `-T`); the API uses plain `nerdctl run`.
- Blender exits 0 on Python exceptions unless `--python-exit-code 1` is passed; the first bake-off silently produced nothing because of this.
- Blender's glTF importer creates corner-domain colour attributes; export splits every vertex unless colours are converted to point domain first (file size ×3, and "boundary edges" everywhere).
- Meadowbots' `Assets.js` already handles meshopt + quantized attributes, so the output format needs no loader change on the game side.
- Per-job wall time is dominated by TRELLIS.2 (≈50 s) and the hires bake (≈12 s); FLUX is 2 s per image. `comfyui` cold start adds 7–16 s.

## State-changing commands run (gpu only; pve untouched)

svc-post image built ×8 (iterations), `forge-api.service` + `/etc/sudoers.d/forge` installed and enabled, Node 22.23.2 unpacked to `/srv/forge/tools/node`, `/srv/forge/.env` created (idle timeout 120 s for testing, restored to 600 s), `/srv/forge/profiles/meadowbots-flat.yaml` copied, comfyui started/stopped by forge-api, 15 jobs run (`/srv/forge/jobs`; 10 in review, 4 failed by the outage/boot, 1 superseded), bake-off artefacts under `/srv/forge/bakeoff`. big-cat untouched.

## Next (Phase 3)

Review UI (`forge-ui`, Nuxt 3 + Vuetify) over this API; the `/viewer` page shows the Three.js loading path it needs. Caddy snippet for `forge.gattonehq.com` → `192.168.1.51:8080` (Phase 3 deliverable).
