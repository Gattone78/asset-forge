# Phase 1 — Blackwell verification

Date: 2026-09-18. Host: `k8s-gpu-1` (VMID 102), RTX PRO 6000 Blackwell Max-Q (sm_120, 96 GB), driver 580.126.09 / CUDA 13.0. Runtime: containerd 2.3.3 + rootful nerdctl 2.3.5. big-cat stopped by Phil for the session; Kubernetes idle. Proxmox untouched.

## Result: all five gates pass

| Gate | Criterion | Result | Wall time | Peak VRAM |
|---|---|---|---|---|
| 1 ComfyUI base | container starts, web UI on LAN, `nvidia-smi` inside shows GPU | **PASS** | ready 10 s after `up` | 560 MiB idle |
| 2 FLUX.1 schnell | 1024² image, seed 1, non-blank, < 30 s warm | **PASS** | cold 14.4 s (incl. load); warm 2.0 s | 35.8 GB |
| 3 TRELLIS.2 | GLB > 1000 tris, closed surface (not point cloud) | **PASS** | cold 44.1 s; warm 26.1 s (1024 res) | 18.6 GB warm (see notes) |
| 4 UniRig | > 5 bones + skin weights in a valid GLB from `giraffe.glb` | **PASS** | cold 62.1 s (incl. 2.9 GB ckpt download); warm 16.1 s | 5.4 GB |
| 5 Unload | stop container → VRAM baseline | **PASS** | `compose stop` 10 s | 2 MiB after, no processes |

## Versions and pins (all in `comfyui/Dockerfile`)

| Component | Version / pin |
|---|---|
| Base image | `nvidia/cuda:13.0.3-base-ubuntu24.04` (driver libs come from the host via CDI; torch ships its own CUDA runtime) |
| Python | 3.12.3 (system, venv at `/opt/venv`) |
| torch / torchvision / torchaudio | **2.14.0+cu130** / 0.29.0+cu130 / 2.11.0+cu130 (`--index-url https://download.pytorch.org/whl/cu130`). cu128 index stops at torch 2.11.0; cu130 is the current stable line and works on the 580 driver. |
| ComfyUI | **v0.36.0**, commit `ee71d5c4993f29086b27fde1629a945ae48425bf` (2026-09-15); frontend 1.52.7, templates 0.11.62 |
| numpy / transformers / safetensors / trimesh | 2.5.2 / 5.17.0 / 0.8.0 / 5.1.0 |
| TRELLIS.2 | **native ComfyUI core** (Comfy-Org/ComfyUI PR #14718, merged 2026-08-22, kijai) — pure PyTorch, **no CUDA extensions** (spconv / flex_gemm / cumesh / nvdiffrast are re-implemented in torch) |
| ComfyUI-UniRig | `PozzettiAndrea/ComfyUI-UniRig` @ `69ee59dc459d2da7cb0291930c1f944886c31d7c` (2026-07-31), comfy-env 0.4.1, comfy-3d-viewers |
| UniRig isolated env (pixi, created at first run) | torch **2.8.0+cu128**, flash_attn 2.8.3, spconv 2.3.8, torch_scatter 2.1.2, torch_cluster 1.6.3, bpy (Blender 4.2). 12 GB at `/srv/forge/comfy/ce` |
| Image | `forge/comfyui:0.1.0`, 8.8 GB (4.7 GB compressed) |

Build flags: BuildKit v0.31.2 via a Forge-only daemon (`deploy/forge-buildkit.service`, OCI worker, root `/srv/forge/buildkit`, socket `/run/forge-buildkit/buildkitd.sock`); `deploy/build.sh` wraps `nerdctl compose build` with `BUILDKIT_HOST` and `TMPDIR=/srv/forge/tmp`. pip cache is a BuildKit cache mount. No `--no-cache`; first build ≈ 5 min, UniRig rebuild ≈ 4.5 min (mostly image export/load). No compiler, no nvcc, nothing built from source.

## Models (all under `/srv/forge/models`, 49 GB)

| Stage | Files | Source | License |
|---|---|---|---|
| FLUX.1 schnell | `diffusion_models/flux1-schnell.safetensors` (bf16, 23.8 GB), `vae/ae.safetensors`, `text_encoders/t5xxl_fp16.safetensors`, `text_encoders/clip_l.safetensors` | `Comfy-Org/flux1-schnell` (unet), `Comfy-Org/Lumina_Image_2.0_Repackaged` (same FLUX VAE), `comfyanonymous/flux_text_encoders` | Apache-2.0 |
| TRELLIS.2 | `diffusion_models/trellis_2_bf16.safetensors` (10.3 GB), `vae/trellis_2_shape_vae_bf16.safetensors`, `vae/trellis_2_texture_vae_bf16.safetensors`, `clip_vision/dino_v3_L_naf_fp32.safetensors`, `background_removal/birefnet.safetensors` | `Comfy-Org/TRELLIS.2`, `Comfy-Org/Pixal3D` (DINOv3-NAF), `Comfy-Org/BiRefNet` | MIT (TRELLIS.2) |
| UniRig | `unirig/skeleton.safetensors`, `unirig/skin.safetensors` (2.9 GB, auto-downloaded on first run) | `apozz/UniRig-safetensors` | MIT |

`black-forest-labs/FLUX.1-schnell` on Hugging Face is now **gated** (HTTP 401 `GatedRepo`); the Comfy-Org mirror is not. `HF_TOKEN` is therefore not needed for anything in Phase 1. `clip_vision/dino_v3_vit_l.safetensors` (from the TRELLIS.2 repo) was also downloaded but the official template uses the NAF variant from the Pixal3D repo, so the workflow uses that.

## Gate details

### Gate 1 — base
`sudo nerdctl compose up -d comfyui` → `/system_stats` in 10 s: ComfyUI 0.36.0, torch 2.14.0+cu130, device `cuda:0 NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition`, 97,247 MiB, `torch.cuda.get_device_capability() == (12, 0)`. `nvidia-smi` inside the container shows the GPU (driver 580.126.09). From the workstation, `http://192.168.1.51:8188/` returns 200 with `<title>ComfyUI</title>`.

### Gate 2 — FLUX.1 schnell (`workflows/test-flux.json`)
UNETLoader (bf16) + DualCLIPLoader (t5xxl fp16 + clip_l) + VAELoader; EmptySD3LatentImage 1024²; KSampler seed 1, 4 steps, cfg 1.0, euler/simple; ConditioningZeroOut as negative. Cold run 14.4 s including model load; two warm runs 2.0 s each. Output `phase1/test-flux_00001_.png` is a 1024² pastel garden robot on white (470 KB PNG, clearly non-blank). Peak VRAM 35.8 GB (bf16 unet + fp16 T5 resident). That image is the input for Gate 3.

### Gate 3 — TRELLIS.2 (`workflows/test-trellis2.json`)
Node choice: evaluated `visualbruno/ComfyUI-Trellis2` (documented Blackwell failures: spconv bf16, flash-attn on sm_120, mocked flex_gemm — issue #157), `PozzettiAndrea/ComfyUI-TRELLIS2` (wrapper with CUDA extensions), and **ComfyUI core** (PR #14718). Core is pure PyTorch, maintained by Comfy-Org, and is what the official template uses, so the wrappers were not built. The requirement said "community node"; core is the better answer to the same question (no sm_120 extension build at all) and the two wrappers remain the fallback if core ever regresses.

Pipeline (from the official `3d_pixal3d_trellis2_image_to_model` template, TRELLIS.2 branch, all seeds = 1): BiRefNet mask → ImageCropToMask → DINOv3-NAF `Trellis2Conditioning` → structure KSampler (12 steps, cfg 7.5, CFGOverride 0.667→1, RescaleCFG 0.7, ModelSamplingSD3 shift 5) → `VaeDecodeStructureTrellis2` (32) → `Trellis2ShapeStage` → KSampler 20 steps → `Trellis2UpsampleStage` **1024** → KSampler 12 steps → `VaeDecodeShapeTrellis` → `Trellis2TextureStage` → KSampler 12 steps cfg 1 → `VaeDecodeTextureTrellis` → `PaintMesh` (vertex colours) → `SaveGLB`. Extra branches: `RemeshMesh` (udf, 512) → `DecimateMesh` (20k, midpoint) → `SaveGLB`, and `RenderMesh` → `SaveImage`.

Mesh assertion (`scripts/check_mesh.py`, run inside the container with trimesh; also parses the glTF header directly):

| Output | Triangles | Vertices | Primitive mode | Boundary edges | Watertight |
|---|---|---|---|---|---|
| raw shape (`test-trellis2-raw`) | **14,040,584** | 6,968,400 | TRIANGLES only | 177,701 (0.42 %) | no (Euler −17,174) |
| DC remesh udf 512 (`test-trellis2-remeshed`) | 5,677,110 | 2,825,552 | TRIANGLES | **6 (0.00 %)** | no by strict test, effectively closed |
| remesh → decimate 20k midpoint | 19,737 | 10,247 | TRIANGLES | 1,273 (2.15 %) | no |
| remesh sdf + manifold → decimate | 14,007 | 12,731 | TRIANGLES | 12,440 (29.6 %) | no (worse) |

Verdict: a real triangle mesh (no POINTS primitives, > 1000 tris by four orders of magnitude) that renders as a solid closed surface (`phase1/test-trellis2-render_00001_.png`, ray-cast render with vertex colours — recognisably the robot). Strict watertightness fails on the raw decoder output (0.42 % boundary edges, small holes typical of the 1024-res shape decoder), and the udf DC remesh closes it to 6 boundary edges. The known Blackwell failure mode (point cloud / voxel samples instead of a mesh) did **not** occur. Bounds are unit-normalised (extents 0.90 × 1.00 × 0.58), Y-up with the robot upright.

Timing/VRAM: first run 44.1 s with FLUX still resident (33 GB baseline, so the TRELLIS peak was masked); alone after a container restart the full pipeline is 26.1 s warm with peak 18.6 GB and 13.7 GB resident afterwards; the remesh+decimate re-runs are 10 s (cached upstream). A cold-alone measurement was not captured because a validation error on the first attempt still executed the valid branches. Treat **≈ 19 GB** as the TRELLIS.2 working set at 1024; 1536 (the template default) was not tried.

### Gate 4 — UniRig (`workflows/test-rig.json`)
`UniRigLoadMesh(input/giraffe.glb)` → `UniRigLoadModel(auto, auto)` → `UniRigAutoRig(skeleton_template=articulationxl, target_face_count=50000)` → FBX. comfy-env runs the node in a persistent subprocess worker inside the pixi env over a Unix socket; the worker chose **flash attention** (`[comfy-attn] Varlen attention: flash`) on sm_120 without complaint. Output `output/phase1-giraffe-rigged_articulationxl.fbx` (6.2 MB). Converted with `scripts/fbx_to_glb.py` (bpy 4.2 from the isolated env, `export_skins=True`) → `phase1/test-rig-giraffe.glb`:

- 1 skin, **50 joints** (`bone_0` … `bone_49`, root `bone_0`), `JOINTS_0`/`WEIGHTS_0` on the mesh (Blender clamps to 4 influences per vertex), 21,636 triangles, loads in trimesh as a valid scene. `articulationxl` bones are not Mixamo-named; per §8 the sidecar will list them.
- Warm rerun 16.1 s, peak 5.4 GB, 3.0 GB resident (the worker keeps the model loaded; it dies with the container).

`giraffe.glb` came from `VAST-AI-Research/UniRig/examples` (Git LFS, 6.3 MB) and lives at `/srv/forge/comfy/input/giraffe.glb`.

### Gate 5 — unload
`sudo nerdctl compose stop comfyui`: 10 s (SIGKILL after the 10 s grace period — exit 137; ComfyUI does not handle SIGTERM quickly with a worker attached). VRAM 3,019 MiB → **2 MiB**, `nvidia-smi` lists no processes. Earlier `compose down` with FLUX + TRELLIS resident: 13.7 GB → 2 MiB in 13 s. Stopping the container is a reliable unload.

## Disk after Phase 1

| Location | Used |
|---|---|
| `/srv/forge/models` | 49 GB |
| `/srv/forge/comfy/ce` (UniRig pixi env) | 12 GB |
| `/srv/forge/buildkit` (Forge BuildKit cache) | 26 GB |
| `/srv/forge/comfy/output` (Phase 1 artefacts) | 1.4 GB |
| `/srv/forge` total | 87 GB used, **307 GB free** |
| Root disk | 69 GB free at start → 46 GB at the low point (two builds + running container) → **104 GB free** after the container stopped. `nerdctl image prune` reclaimed nothing. See "Surprises". |

The §9 30 GB floor was never approached.

## Decisions taken

- **TRELLIS.2 via ComfyUI core**, not a community wrapper (rationale above). Hunyuan3D fallback not needed (open item §11 closed).
- **UniRig via `ComfyUI-UniRig` in a comfy-env isolated environment** rather than the `svc-rig` FastAPI fallback. The env is created once at first run by `python install.py` inside the container (`COMFY_ENV_ROOT=/opt/ComfyUI/ce` → `/srv/forge/comfy/ce`), not at image build: comfy-env/pixi resolves CUDA packages against the running host, the env is 12 GB, and keeping it on the bind mount survives image rebuilds. Documented in the Dockerfile; Phase 2's compose start script should run the install if the env is missing (or set `COMFY_ENV_AUTO_INSTALL=1`).
- **torch 2.14.0+cu130** for ComfyUI; the UniRig env independently pins torch 2.8.0+cu128. Both run on the 580 driver.
- **bf16 weights** for FLUX and TRELLIS.2 (96 GB is plenty); the int8 variants the template defaults to are not used.
- Container user is uid 1000 (`comfy`, renamed from the base image's `ubuntu`) so bind-mount files are owned by `hqadmin`.

## Surprises / worth knowing

- **FLUX.1-schnell is gated on Hugging Face now.** Comfy-Org mirrors are not; no token needed.
- **TRELLIS.2 became native in ComfyUI (Aug 2026)** and the whole Blackwell CUDA-extension risk in §10 evaporated. `VaeDecodeShapeTrellis` at 1024 emits 14 M triangles and a 252 MB GLB; DC remesh in-graph brings that to 5.7 M and is watertight to 6 edges. The in-graph midpoint decimator opens ~2 % boundary edges; Phase 2's post stage should compare it with gltf-transform `simplify`/meshopt before choosing.
- **Dynamic combo inputs in API-format workflows** (`RemeshMesh.sign_mode`, `DecimateMesh.placement_mode`) need their nested options spelled as `"sign_mode.qef": false` etc.; ComfyUI executes the valid output branches of a prompt even when validation fails for another branch.
- **ComfyUI needs SIGKILL** on `compose stop` (exit 137 after 10 s). Harmless for an on-demand container, but `forge-api` should expect ~10 s for a stop.
- **Root-disk free space rose to 104 GB after the container stopped** (from 46 GB while it ran and 69 GB at session start). Something transient lived on root while the container ran, most likely the pixi package cache written into the container's writable layer during the 12 GB env install, or the image tarball staged by `nerdctl load`. A quick look afterwards: root now holds containerd 81 GB (of which overlay snapshots 59 GB), the system buildkit 19 GB, and 41 GB under `/var/lib/nerdctl` that is entirely big-cat named volumes (vLLM HF cache), so none of that is Forge. Container logs are tiny. Not chased further; worth a look if root ever gets tight during a build.
- `nvidia/cuda` has no `13.0.0`/`13.0.1` Ubuntu 24.04 tags; `13.0.3` is the oldest.
- comfy-env prints `[MISSING -- run install.py]` at startup and registers 0 nodes until the env exists; the UniRig nodes only appeared after the install and a container restart.

## State-changing commands run (all on gpu; none on pve)

`systemctl enable --now forge-buildkit` (new unit); `nerdctl compose build` ×2; `nerdctl compose up/down/restart/stop comfyui`; model downloads into `/srv/forge/models` (three tmux sessions `forge-dl*`); `python install.py` for UniRig inside the container (tmux `forge`); `nerdctl image prune -f` (reclaimed 0). big-cat containers untouched (still `Created`).

## Next (Phase 2, not started)

Prompt → GLB creature end to end: `forge-api` (SQLite queue, worker loop, ComfyUI submission of `image-refs.json` + `image-to-3d.json`, on-demand `comfyui` start/stop with the free-VRAM guard), `svc-post`, `meadowbots-flat` profile, `forge` CLI. The Phase 1 workflows are the starting point for `image-refs.json` and `image-to-3d.json`.
