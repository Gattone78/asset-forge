# Asset Forge — Requirements (v2)

Self-hosted, all-local AI media generation pipeline for games. First consumer: **Meadowbots** (Three.js + Vite, WebXR, Quest 3 + iPad/TV). Designed so additional games get their own style profile without re-architecting anything.

This document supersedes the earlier Asset Forge requirements (ComfyUI-based). None of that was executed; start clean.

**Audience:** Claude Code, running on Phil's workstation, executing over SSH. Read the whole doc before doing anything.

---

## 1. Locked decisions

| Area | Decision |
|---|---|
| v1 media types | 3D models (text→image→3D), 2D images/textures/sprites, auto-rigging. Video (trailers/promo clips) is Phase 6. Audio is a later phase. |
| Generation model | **Batch at build time.** Jobs produce candidate assets; Phil reviews and downloads keepers. No runtime generation in v1. |
| Determinism | Every job records seeds. Every job inherits a per-game **style profile**. Re-running a job with the same inputs must reproduce the same output. |
| Host | Existing `k8s-gpu-1` VM (Ubuntu 24.04, RTX PRO 6000 Blackwell Max-Q via PCIe passthrough). **Docker Compose**, not Kubernetes. Kubernetes stays shut down while Forge runs. |
| Noise | GPU fan noise during jobs is fine. **Idle must be quiet:** model services load on demand and unload after an idle timeout. Nothing holds the GPU at rest. |
| Tooling | Plain scripts + `docker compose`. Idempotent where cheap, but do not build a framework. |
| Repo | `github.com/Gattone78/asset-forge` (personal account, SSH alias per existing multi-account config). |
| Interfaces | CLI, REST API, web review UI. Async job queue with status. MCP server is a later phase. |
| Models | Open-weight, all local. TRELLIS.2 (image→3D), FLUX.1 schnell (text→image), UniRig (auto-rig). Hunyuan3D 2.x as fallback only if TRELLIS.2 fails Blackwell verification. |
| GPU host | **ComfyUI** runs all GPU models as a single on-demand container. Workflows are committed JSON files; `forge-api` submits them via ComfyUI's HTTP/WebSocket API. Standalone FastAPI wrappers are the fallback only for a model with no working Blackwell-compatible ComfyUI node. |
| Licensing | Hobby use only; no license gating required. Record the model license in each sidecar anyway. |
| Meadowbots asset budget | 5–20k tris, 2k textures max, flat-shaded with a simple albedo texture. Full PBR available as a profile option for other games. |
| Output formats | GLB (primary) + FBX. |
| Post-processing | Decimate + compress (meshopt or Draco). Also normalize origin/scale/up-axis by default — AI outputs come out at random scale and orientation. Disableable per profile. |
| Rigging | Auto-rig only (skeleton + skin weights). Animation is procedural in Three.js. Rigging applies to creatures/bots only; plants and props get a **named-pivot convention** instead of a skeleton. |
| Storage | Local disk on a new dedicated VM volume. Sidecar JSON next to each asset. No catalog DB, no MinIO, no NAS. |
| Delivery to game | Manual download from the review UI. |
| First deliverable | **Prompt → reviewed GLB creature, end to end.** |

---

## 2. Hosts and access

Claude Code operates from the workstation over SSH. Two targets:

| Target | Role | Use for |
|---|---|---|
| Proxmox host | Hypervisor | Adding the data disk to the VM (`qm`). Nothing else. |
| `k8s-gpu-1` VM | GPU worker | Everything else: Docker, models, services, storage. |

**Discover, don't assume.** Before any change, verify and record in `docs/environment.md`:

- SSH hostnames/IPs. The GPU VM's Proxmox VMID is **102** (verify with `qm list` on the host before any `qm` command).
- `nvidia-smi` driver version, CUDA version reported, GPU name. **GPU passthrough to VM 102 is already verified working (Phil, Sep 2026)** — do not troubleshoot passthrough or touch Proxmox PCI config; only verify the driver/CUDA/Docker layers inside the VM.
- Docker version, `nvidia-container-toolkit` present, `docker run --rm --gpus all nvidia/cuda:12.8.0-base-ubuntu24.04 nvidia-smi` succeeds.
- Existing disks and mounts (`lsblk`, `df -h`), free space on root.
- Whether Kubernetes services (kubelet, containerd workloads) are running. If they are, stop and ask — do not stop them unilaterally.
- Existing Caddy config location and how hostnames are added (Caddy runs in an LXC outside k8s; Phil adds routes there).

**Command hygiene:** every command you run or propose must say which machine it targets. Explain impact before anything destructive (disk ops, deleting containers/volumes, stopping services).

**Visibility:** any remote command expected to run longer than ~30 seconds (Docker builds, model downloads, Phase 1 smoke tests, batch jobs) runs inside a named tmux session on the VM — `tmux new -d -s forge '<command>'` — so Phil can attach from a second terminal or phone (`ssh k8s-gpu-1`, then `tmux attach -t forge`) and so the job survives a dropped SSH connection. When you start one, tell Phil the attach command. Poll `tmux capture-pane -pt forge` or a log file for progress rather than blocking on the session.

---

## 3. Architecture

Single-GPU, single-worker design. One job runs on the GPU at a time. Keep it boring.

```
workstation ──ssh──▶ k8s-gpu-1
                        │
   forge CLI ──http──▶ forge-api (Node/TS, Fastify)  ◀── forge-ui (Nuxt 3)
                        │  SQLite job queue + worker loop
                        ├─▶ comfyui   (on-demand GPU container: FLUX.1 schnell, TRELLIS.2, UniRig nodes)
                        │     workflows/*.json submitted via /prompt, progress via WebSocket
                        └─▶ svc-post  (gltf-transform + Blender headless; CPU only)
                        │
                     /srv/forge  (data volume)
```

### Services (docker compose)

| Service | Stack | GPU | Notes |
|---|---|---|---|
| `forge-api` | Node 22 / TypeScript / Fastify / better-sqlite3 | no | REST API, job queue, worker loop, static file serving for assets. Always on. |
| `forge-ui` | Nuxt 3 + Vuetify | no | Review/approve/download UI. Talks only to `forge-api`. Always on. |
| `comfyui` | ComfyUI (pinned commit) + custom nodes, torch CUDA 12.8+ wheel, TRELLIS.2 CUDA extensions built for `sm_120` | yes | Single GPU workflow host. Nodes: FLUX (core), TRELLIS.2 (community node), UniRig (community node if it builds; see fallback). Models mounted from `/srv/forge/models`. ComfyUI's own web UI stays reachable on the LAN for workflow authoring. |
| `svc-post` | Node 22 + `@gltf-transform/cli`, Blender 4.x headless | no | Normalize, decimate, compress, FBX export, texture bake-down to albedo. CPU only, runs per job then exits. |
| `svc-rig` (fallback only) | Python 3.11, FastAPI, UniRig | yes | Built **only** if no ComfyUI UniRig node passes Phase 1 on Blackwell. Same on-demand rules as `comfyui`. |

**Workflows are code.** `workflows/` in the repo holds one API-format JSON per stage: `image-refs.json`, `image-to-3d.json`, `rig.json`, plus sprite/texture variants in Phase 5. `forge-api` loads the JSON, patches the input nodes (prompt, seed, image path, profile values), submits to `POST /prompt`, tracks progress on the WebSocket, and collects outputs from ComfyUI's output dir (bind-mounted under `/srv/forge/jobs/<id>/raw/`). Workflows are authored/tuned in ComfyUI's web UI, exported as API format, and committed. Never hand-edit node IDs in code; look nodes up by title.

**GPU is on-demand.** `forge-api` starts the `comfyui` container when a job needs it and stops it after `FORGE_GPU_IDLE_TIMEOUT` (default 10 min) with no queued or running jobs, via the Docker socket (`docker compose up -d comfyui` / `docker compose stop comfyui`). Stopping the container is the unload mechanism — do not rely on in-process VRAM freeing. `comfyui` is never `restart: always`. Custom-node auto-updating is disabled; node versions are pinned in the Dockerfile.

**One GPU workload at a time** in v1. ComfyUI's own queue serializes stages naturally; `forge-api` submits one workflow at a time per job.

### Job pipeline (creature, v1)

```
prompt + profile
  → comfyui/image-refs.json:   text → N reference images (front view, neutral bg, seed recorded)
  → comfyui/image-to-3d.json:  best image → raw GLB
  → svc-post:   normalize (origin at feet, Y-up, unit = meters, target height from profile)
                bake to albedo (flat profile) or keep PBR
                decimate to profile tri budget
                meshopt compress → final .glb
                Blender: export .fbx
  → comfyui/rig.json (or svc-rig): if rigged → skeleton + weights → rigged .glb / .fbx
  → sidecar.json written; job status = review
```

Reference images: **quality is the criterion.** Phase 2 must run a bake-off on 3 sample prompts comparing (a) single front view vs. (b) multi-view (front + side + back, same seed, consistent style) as TRELLIS.2 input, judged by mesh completeness, back-side detail, and silhouette fidelity. Adopt the winner as the profile default (`image.views`), keep the other as a per-job option, and record the result in `docs/phase-2.md`. Whichever mode is used, generate N candidates (default 4), pick by simple heuristic (largest subject bounding box, most centered), and keep all N in the job folder so Phil can override in the UI later.

---

## 4. Storage layout

New dedicated virtual disk attached to the VM, mounted at `/srv/forge`. Model weights, outputs, and Docker named volumes all live here. Root disk stays untouched.

```
/srv/forge/
  models/           # HF cache (HF_HOME) + any manual weight downloads
  db/forge.sqlite
  profiles/         # style profiles (also committed in the repo; this is the runtime copy)
  jobs/<job-id>/
    request.json    # the exact request as received
    refs/           # reference images + seeds
    raw/            # untouched model outputs
    out/
      <name>.glb
      <name>.fbx
      <name>.rigged.glb   (if rigged)
      <name>.rigged.fbx
      <name>.sidecar.json
      thumb.png
    log.txt
```

### Sidecar JSON (one per asset)

```json
{
  "forge_version": "0.1.0",
  "job_id": "…",
  "created_at": "ISO-8601",
  "game": "meadowbots",
  "profile": "meadowbots-flat",
  "profile_hash": "sha256 of the profile file used",
  "prompt": "…",
  "negative_prompt": "…",
  "stages": [
    {"stage": "image", "model": "black-forest-labs/FLUX.1-schnell", "revision": "…", "seed": 123, "steps": 4, "license": "Apache-2.0"},
    {"stage": "3d", "model": "microsoft/TRELLIS.2-4B", "revision": "…", "seed": 456, "resolution": 1024, "license": "MIT"},
    {"stage": "post", "tool": "gltf-transform@x.y", "ops": ["normalize","bake-albedo","simplify","meshopt"], "tris_before": 0, "tris_after": 0},
    {"stage": "rig", "model": "VAST-AI/UniRig", "revision": "…", "seed": 789, "bones": 0, "license": "MIT"}
  ],
  "geometry": {"tris": 0, "verts": 0, "height_m": 0.0, "up_axis": "Y", "origin": "feet"},
  "textures": [{"name": "albedo", "size": 2048}],
  "rigged": false,
  "status": "review | approved | rejected"
}
```

---

## 5. Style profiles

YAML files in `profiles/`. Every job names exactly one. A profile is the contract that makes a set of assets look like they belong in the same game.

`profiles/meadowbots-flat.yaml` (initial):

```yaml
name: meadowbots-flat
game: meadowbots
style_prompt: "cute rounded low-detail 3D toy, soft pastel colors, simple shapes, friendly, clean silhouette, no text, plain background"
negative_prompt: "realistic, photo, gritty, sharp edges, text, watermark, busy background"
image:
  count: 4
  size: 1024
  steps: 4            # schnell
mesh:
  target_tris: 12000  # decimate target; hard max 20000
  max_texture: 2048
  material: flat-albedo   # or: pbr
  normalize: true
  target_height_m: 0.6    # override per job
  compression: meshopt    # or: draco
rig:
  default: false          # jobs opt in with --rig
formats: [glb, fbx]
```

Profiles are versioned in git; the sidecar records the hash so an asset can always be traced to the exact profile.

---

## 6. Interfaces

### REST (`forge-api`, LAN/Tailscale only)

```
POST /jobs                 {type: "creature"|"prop"|"plant"|"image", prompt, profile, seed?, rig?, count?, height_m?}
GET  /jobs                 list, filter by status/game
GET  /jobs/:id             status, stage, progress, errors
GET  /jobs/:id/assets      file list + sidecars
GET  /assets/:job/:file    download
POST /jobs/:id/approve | /reject
POST /jobs/:id/rerun       same inputs, optionally new seed
GET  /profiles
GET  /health               includes GPU state (resident service, VRAM used)
```

### CLI (`forge`, Node, thin wrapper over REST)

```
forge job creature "a round friendly garden robot with big eyes" --profile meadowbots-flat --rig
forge job batch plants.yaml          # list of prompts sharing one profile → one job per line
forge status <id> | forge watch <id>
forge list --status review
forge approve <id> | forge reject <id>
forge get <id> ./assets/             # download outputs
```

`FORGE_URL` env var points at the API. Runs from the workstation.

### Web UI (`forge-ui`, Nuxt 3 + Vuetify)

- Job list with status chips; filter by game/profile/status.
- Job detail: reference images (N), thumbnail, **inline 3D preview** (`<model-viewer>` or Three.js), sidecar summary (tris, textures, seeds, models), log tail.
- Approve / Reject / Rerun (new seed) / Download (glb, fbx, rigged variants, sidecar).
- New-job form: prompt, profile picker, type, rig toggle, height, seed.
- Exposed at `forge.gattonehq.com` via the existing Caddy proxy, LAN + Tailscale only. Provide the Caddy snippet; Phil applies it.

---

## 7. Phases and acceptance criteria

Work strictly in order. Each phase ends with a PR to `main` and a short `docs/phase-N.md` note of what was done and anything discovered.

### Phase 0 — Environment audit and data disk

1. Audit per §2; write `docs/environment.md`.
2. Add a 400 GB virtual disk to VM **102** from the Proxmox host (`qm set 102 --scsi1 <storage>:400`). Discover the storage pool with `pvesm status` and confirm the choice with Phil before running it. Inside the VM: partition, ext4, mount at `/srv/forge`, add to `/etc/fstab` by UUID.
3. Configure Docker to keep its data root on the default disk but all Forge named volumes and bind mounts under `/srv/forge`.

**Accept:** `/srv/forge` mounted, survives reboot, ≥390 GB free; Docker GPU hello-world passes.

### Phase 1 — Blackwell verification (gates every model)

Build the `comfyui` container (pinned ComfyUI commit, Blackwell-compatible torch), then verify each model **through its ComfyUI node** with a committed test workflow, in this order:

1. **ComfyUI base:** container starts, web UI reachable, `nvidia-smi` inside shows the GPU.
2. **FLUX.1 schnell** (`workflows/test-flux.json`): one 1024² image at seed 1. Accept if a non-blank image is produced in < 30 s after warm load.
3. **TRELLIS.2 node** (`workflows/test-trellis2.json`): evaluate the available community nodes; pick the one that builds its CUDA extensions for `sm_120`. Run image→3D on a sample image. **Accept only if the output GLB has > 1000 triangles and renders as a closed surface** — a known Blackwell/CUDA 12.8 failure mode produces a point cloud or voxel samples instead of a mesh. If it fails after reasonable effort (attention backend swap, torch nightly, pinned CUDA 12.4 toolchain inside the container), stop, document, and fall back to a Hunyuan3D 2.x node with the same test.
4. **UniRig node** (`workflows/test-rig.json`): rig the sample `giraffe.glb`. Accept if a skeleton with > 5 bones and skin weights merges into a valid GLB. If no community node works on Blackwell, build the standalone `svc-rig` fallback and apply the same test.
5. Stop the container; confirm VRAM returns to baseline.

**Accept:** `docs/phase-1.md` records pass/fail, versions, build flags, and timings for each model. Nothing downstream starts until the 3D model passes.

### Phase 2 — Prompt → GLB creature, end to end (first deliverable)

- `forge-api` with SQLite queue and worker loop; ComfyUI workflow submission (`image-refs.json`, `image-to-3d.json`); `svc-post`; on-demand `comfyui` start/stop; `meadowbots-flat` profile; `forge` CLI.
- Post stage: normalize, bake-to-albedo, decimate, meshopt, FBX export, sidecar, thumbnail.

**Accept:** From the workstation, `forge job creature "…" --profile meadowbots-flat` returns a job id; `forge watch` shows stages; `forge get` downloads a `.glb` + `.fbx` + sidecar; the GLB loads in the Meadowbots Vite project and stands on the ground at the requested height, facing -Z, within the tri budget. Rerun with the same seed reproduces byte-identical raw output. After the idle timeout, the `comfyui` container is stopped, VRAM is ~0, and no non-Forge container was touched.

### Phase 3 — Review UI

`forge-ui` per §6. **Accept:** Phil can create, preview in 3D, approve/reject, rerun, and download from a phone on Tailscale.

### Phase 4 — Rigging

`rig.json` workflow (or `svc-rig` fallback) + `--rig` flag + rigged outputs + named-pivot convention for props/plants (see §8). **Accept:** a rigged bot GLB loads in Three.js with a `SkinnedMesh` and bones Phil can drive procedurally; a prop with `pivot_*` nodes exposes them by name.

### Phase 5 — 2D and batch

- `image` job type: sprites/textures/tiles with transparent background where requested (FLUX schnell + background removal via `rembg`).
- Seamless texture mode (tile check in post).
- `forge job batch <yaml>` producing one job per line, sharing a profile and a base seed (`seed + index`).

**Accept:** a batch of 10 plants renders in the UI as a set, all visibly the same style.

### Phase 6 — Video (trailers / promo clips)

Purpose: short promotional clips for Meadowbots and future games — not runtime assets.

- **Model:** pick the best open-weight text-to-video / image-to-video model available at build time that has a maintained ComfyUI node (candidates at time of writing: Wan 2.x, HunyuanVideo, or their successors). Same Blackwell gate as Phase 1: `workflows/test-video.json` must produce a non-blank 5-second clip at seed 1; record VRAM peak and wall time.
- **Job type `video`:** `{prompt, profile, seed, duration_s (default 5), fps (default 24), aspect ("16:9" | "9:16"), init_image?}`. `init_image` may reference an approved Forge asset thumbnail or a rendered turntable frame so clips match the game's look.
- **Workflows:** `text-to-video.json`, `image-to-video.json`.
- **Post:** `ffmpeg` in `svc-post` → H.264 MP4 + a WebM, plus a poster frame. Sidecar records model, seed, duration, fps, resolution.
- **UI:** inline MP4 preview, approve/reject/download like any other asset.
- **Optional stitching:** `forge job trailer <yaml>` concatenates approved clips with crossfades and a title card (ffmpeg). No audio in this phase; audio stays in "Later."

**Accept:** `forge job video "…" --profile meadowbots-flat` yields a 5 s clip Phil can preview and download from the UI; three clips stitch into a trailer MP4 that plays on a phone; `comfyui` stops on idle as usual.

### Later (not v1, do not build yet)

Audio (SFX/music/TTS, including trailer soundtracks), MCP server over the REST API, runtime generation, Kubernetes deployment, multi-GPU scheduling.

---

## 8. Conventions

- **Units:** meters, Y-up, -Z forward, origin at the feet/base. Applied by the normalize step; the sidecar records what was done.
- **Naming:** `<game>-<type>-<slug>-<jobshort>.glb`, e.g. `meadowbots-creature-garden-robot-a1b2c3.glb`.
- **Named pivots (props/plants):** the post stage reserves node names `pivot_root`, `pivot_top`, `pivot_lid`, `pivot_spin`. In v1 only `pivot_root` is guaranteed (the whole mesh under one named node); others are populated when a job requests a part split (later). Three.js code animates by `getObjectByName`.
- **Rigged output:** skeleton root named `Armature`, humanoid bones named per Mixamo-style convention where UniRig's prediction maps cleanly; otherwise leave UniRig's names and list them in the sidecar.
- **Seeds:** `seed` at the job level seeds every stage deterministically (`seed`, `seed+1`, …) unless a stage seed is given explicitly.
- **Config:** `.env` on the VM (never committed): `HF_TOKEN`, `FORGE_DATA=/srv/forge`, `FORGE_GPU_IDLE_TIMEOUT`, `FORGE_PORT`. `.env.example` is committed.

---

## 9. Operational constraints

- Kubernetes must be down while Forge runs (both want the GPU). Check before `compose up`; refuse to start GPU services if `nvidia-smi` shows another process holding VRAM.
- No public exposure. Caddy route is LAN + Tailscale only; no Cloudflare tunnel.
- Logs to stdout; `docker compose logs` is the observability story for v1. Health endpoint reports GPU state.
- Backups: `/srv/forge/jobs` and `/srv/forge/db` are the only irreplaceable data. Models re-download. Document a one-line rsync.
- Idle noise: after the idle timeout, `nvidia-smi` must show no Forge process and VRAM near 0, and the only **Forge** containers still running are `forge-api` and `forge-ui`. Forge only ever starts/stops containers defined in its own `docker-compose.yml`. Any other containers on the VM (existing or future, Forge-unrelated) are out of scope: never stop, restart, or modify them, and never include them in the idle check.

---

## 10. Known risks

| Risk | Mitigation |
|---|---|
| TRELLIS.2 CUDA extensions don't build or mis-render on Blackwell (`sm_120`, CUDA 12.8) | Phase 1 gate with a real mesh assertion; documented fallback to Hunyuan3D 2.x. |
| Bake-to-albedo from TRELLIS.2's per-vertex/PBR output loses detail or produces seams | Try vertex-color → albedo bake in Blender first; if ugly, ship vertex colors directly for the flat profile (Three.js handles `COLOR_0` fine). |
| UniRig skeleton quality on stylized/rounded creatures | Keep unrigged GLB always; rigging is additive. Allow `--rig-seed` reruns. |
| Model weights + build caches exceed disk | 400 GB volume; `docs/environment.md` tracks usage after Phase 1. |
| GPU service fails to unload VRAM | Full container stop is the only unload mechanism; verify with `nvidia-smi` in the Phase 2 acceptance test. |
| ComfyUI custom nodes (TRELLIS.2, UniRig) lag Blackwell/torch support or break on update | Pin ComfyUI commit and every node's commit in the Dockerfile; disable auto-update; Phase 1 tests each node; standalone FastAPI wrapper is the documented fallback per model. |

---

## 11. Open items (ask Phil when reached)

- Proxmox storage pool name for the data disk on VM 102 (discover with `pvesm status`, confirm with Phil — Phase 0).
- Whether Hunyuan3D fallback is needed (only after Phase 1 result).
- Caddy route application (Phil applies; provide the snippet).
- Which video model to adopt (decided by the Phase 6 Blackwell gate at build time).
