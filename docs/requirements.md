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
| Host | Existing `k8s-gpu-1` VM (Ubuntu 24.04, RTX PRO 6000 Blackwell Max-Q via PCIe passthrough). **containerd + nerdctl compose** — the runtime already on the VM. Docker CE is **not** to be installed (its `containerd.io` package can conflict with the existing containerd and take down the other workloads on the box). Kubernetes stays shut down while Forge runs. |
| Noise | GPU fan noise during jobs is fine. **Idle must be quiet:** the `comfyui` container stops after an idle timeout; nothing of Forge's holds the GPU at rest. (The unrelated `big-cat` stack on the same VM is Phil's to start/stop and is outside Forge's control.) |
| Tooling | Plain scripts + `nerdctl compose`. Idempotent where cheap, but do not build a framework. |
| Repo | `github.com/Gattone78/asset-forge` (personal account, SSH alias per existing multi-account config). |
| Interfaces | CLI, REST API, web review UI. Async job queue with status. MCP server is a later phase. |
| Models | Open-weight, all local. TRELLIS.2 (image→3D, **via ComfyUI core** — merged upstream Aug 2026 as pure PyTorch, no CUDA extensions; community wrappers rejected, see phase-1.md), FLUX.1 schnell (text→image, via the Comfy-Org mirror since the BFL repo is HF-gated), UniRig (auto-rig, via comfy-env isolated env at `/srv/forge/comfy/ce`). All three passed the Blackwell gates in Phase 1. Hunyuan3D fallback no longer needed. |
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
| `k8s-gpu-1` VM | GPU worker | Everything else: containers (nerdctl), models, services, storage. |

**Discover, don't assume.** Before any change, verify and record in `docs/environment.md`:

- SSH targets: the GPU VM is `ssh gpu`, the Proxmox host is `ssh pve` (aliases in Phil's `~/.ssh/config`, key-based, both verified). The GPU VM's Proxmox VMID is **102** (verify with `qm list` on the host before any `qm` command).
- `nvidia-smi` driver version, CUDA version reported, GPU name. Known as of Phase 0: driver 580.126.09, CUDA 13.0. **GPU passthrough to VM 102 is already verified working (Phil, Sep 2026)** — do not troubleshoot passthrough or touch Proxmox PCI config; only verify the driver/CUDA/container layers inside the VM.
- Container runtime: containerd 2.3.3 + nerdctl 2.3.5 + NVIDIA Container Toolkit 1.19.0 (known as of Phase 0). Verify with `sudo nerdctl run --rm --gpus all nvidia/cuda:12.8.0-base-ubuntu24.04 nvidia-smi`. Use rootful nerdctl (sudo); `hqadmin` has passwordless sudo.
- Other workloads on the VM: the `big-cat` voice stack (vLLM, speaches STT, Chatterbox TTS) runs as nerdctl containers with restart-unless-stopped and holds a large VRAM share while up. It is **out of scope** — never stop, restart, or modify it. **Phil stops big-cat himself before Forge sessions and restarts it after.** If a Forge job is requested while big-cat is holding VRAM, `forge-api` refuses and reports it (see §9); it does not stop big-cat.
- Existing disks and mounts (`lsblk`, `df -h`), free space on root.
- Whether Kubernetes services (kubelet, containerd workloads) are running. If they are, stop and ask — do not stop them unilaterally.
- Existing Caddy config location and how hostnames are added (Caddy runs in an LXC outside k8s; Phil adds routes there).

**Command hygiene:** every command you run or propose must say which machine it targets. Explain impact before anything destructive (disk ops, deleting containers/volumes, stopping services).

**Visibility:** any remote command expected to run longer than ~30 seconds (image builds, model downloads, Phase 1 smoke tests, batch jobs) runs inside a named tmux session on the VM — `tmux new -d -s forge '<command>'` — so Phil can attach from a second terminal or phone (`ssh gpu`, then `tmux attach -t forge`) and so the job survives a dropped SSH connection. When you start one, tell Phil the attach command. Poll `tmux capture-pane -pt forge` or a log file for progress rather than blocking on the session.

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

### Services (nerdctl compose)

| Service | Stack | GPU | Notes |
|---|---|---|---|
| `forge-api` | Node 22 / TypeScript / Fastify / better-sqlite3 | no | REST API, job queue, worker loop, static file serving for assets. Always on. |
| `forge-ui` | Nuxt 3 + Vuetify | no | Review/approve/download UI. Talks only to `forge-api`. Always on. |
| `comfyui` | ComfyUI (pinned commit) + custom nodes, torch CUDA 12.8+ wheel, TRELLIS.2 CUDA extensions built for `sm_120` | yes | Single GPU workflow host. Nodes: FLUX (core), TRELLIS.2 (community node), UniRig (community node if it builds; see fallback). Models mounted from `/srv/forge/models`. ComfyUI's own web UI stays reachable on the LAN for workflow authoring. |
| `svc-post` | Node 22 + `@gltf-transform/cli`, Blender 4.x headless | no | Normalize, decimate, compress, FBX export, texture bake-down to albedo. CPU only, runs per job then exits. |
| `svc-rig` (fallback only) | Python 3.11, FastAPI, UniRig | yes | Built **only** if no ComfyUI UniRig node passes Phase 1 on Blackwell. Same on-demand rules as `comfyui`. |

**Workflows are code.** `workflows/` in the repo holds one API-format JSON per stage: `image-refs.json`, `image-to-3d.json`, `rig.json`, plus sprite/texture variants in Phase 5. `forge-api` loads the JSON, patches the input nodes (prompt, seed, image path, profile values), submits to `POST /prompt`, tracks progress on the WebSocket, and collects outputs from ComfyUI's output dir (bind-mounted under `/srv/forge/jobs/<id>/raw/`). Workflows are authored/tuned in ComfyUI's web UI, exported as API format, and committed. Never hand-edit node IDs in code; look nodes up by title.

**GPU is on-demand.** `forge-api` starts the `comfyui` container when a job needs it and stops it after `FORGE_GPU_IDLE_TIMEOUT` (default 10 min) with no queued or running jobs, by shelling out to `sudo nerdctl compose -f <compose file> up -d comfyui` / `stop comfyui` (no Docker socket exists on this VM; `forge-api` runs with a sudoers entry scoped to exactly those nerdctl commands, or runs as root — pick the simpler one and document it). Stopping the container is the unload mechanism — do not rely on in-process VRAM freeing. `comfyui` is never `restart: always`. Custom-node auto-updating is disabled; node versions are pinned in the Dockerfile.

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

New dedicated virtual disk attached to the VM, mounted at `/srv/forge`. Model weights, outputs, and all Forge container volumes (bind mounts) live here. Root disk stays untouched.

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
3. Keep containerd's data root where it is; all Forge named volumes and bind mounts go under `/srv/forge`.

**Accept:** `/srv/forge` mounted, survives reboot, ≥390 GB free; the nerdctl GPU check from §2 passes; big-cat containers are still running afterward.

### Phase 1 — Blackwell verification (gates every model)

Build the `comfyui` container (pinned ComfyUI commit, Blackwell-compatible torch), then verify each model **through its ComfyUI node** with a committed test workflow, in this order:

1. **ComfyUI base:** container starts, web UI reachable, `nvidia-smi` inside shows the GPU.
2. **FLUX.1 schnell** (`workflows/test-flux.json`): one 1024² image at seed 1. Accept if a non-blank image is produced in < 30 s after warm load.
3. **TRELLIS.2 node** (`workflows/test-trellis2.json`): evaluate the available community nodes; pick the one that builds its CUDA extensions for `sm_120`. Run image→3D on a sample image. **Accept only if the output GLB has > 1000 triangles and renders as a closed surface** — a known Blackwell/CUDA 12.8 failure mode produces a point cloud or voxel samples instead of a mesh. If it fails after reasonable effort (attention backend swap, torch nightly, pinned CUDA 12.4 toolchain inside the container), stop, document, and fall back to a Hunyuan3D 2.x node with the same test.
4. **UniRig node** (`workflows/test-rig.json`): rig the sample `giraffe.glb`. Accept if a skeleton with > 5 bones and skin weights merges into a valid GLB. If no community node works on Blackwell, build the standalone `svc-rig` fallback and apply the same test.
5. Stop the container; confirm VRAM returns to baseline.

**Accept:** `docs/phase-1.md` records pass/fail, versions, build flags, and timings for each model. Nothing downstream starts until the 3D model passes.

### Phase 2 — Prompt → GLB creature, end to end (first deliverable)

Facts from Phase 1 that Phase 2 must build on (details in `docs/phase-1.md`):
- Warm timings: FLUX ~2 s/image, TRELLIS.2 ~26 s at 1024, UniRig ~16 s; cold starts 14–62 s. Peak VRAM: FLUX 35.8 GB, TRELLIS.2 ~19 GB, UniRig 5.4 GB.
- `comfyui` needs ~10 s to stop (SIGKILL after grace); `forge-api` budgets for it and treats a stop as complete only when `nvidia-smi` shows Forge VRAM at ~0.
- Raw TRELLIS.2 output is ~14 M tris; the in-graph DC remesh gives ~5.7 M with few boundary edges, but the in-graph midpoint decimator opens ~2% boundary edges. The post stage must compare in-graph decimation vs `gltf-transform simplify` (weld → simplify → check boundary edges and visual result) on 3 sample meshes and pick the pipeline that reaches the profile budget with the fewest holes. Record the choice.
- Verify `forge-buildkit.service` keeps its cache under `/srv/forge`; the Phase 1 root-disk swing (46→104 GB) suggests it may not.

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

### Phase 7 — Audio (SFX, music, narration) — PROPOSED 2026-09-25, Phil to confirm before any download

Purpose: sound for Meadowbots and its promo clips — runtime sound effects, trailer/menu music, and spoken narration — all local, ComfyUI core nodes wherever they exist (the `forge/comfyui:0.1.0` image already ships ACE-Step 1.5 and Stable Audio 3 support and the audio save/mix nodes).

- **Models (proposed; each passes a Blackwell gate before its job type is built):**
  - **Music: ACE-Step 1.5 Turbo** (MIT, Comfy-Org repackage: turbo AIO checkpoint or split diffusion + Qwen text encoder + VAE; core nodes `TextEncodeAceStepAudio15` / `EmptyAceStep15LatentAudio`). Tags + optional lyrics, bpm/key/time-signature controls, seconds-scale generation for minutes of audio. Instrumental by default.
  - **SFX: Stable Audio 3.0 Small-SFX** (Stability AI Community License: outputs are the user's and commercial use is allowed under US$1M annual revenue; Comfy-Org repackage + `t5gemma` text encoder; core `StableAudio3` support). Up to 2 min, 44.1 kHz stereo. Alternative if the licence is unwanted: MMAudio (MIT, kijai custom node, text- or video-to-audio) — also the candidate for clip-synchronised foley later.
  - **Narration: Kokoro-82M** (Apache-2.0, CPU, fixed voice set, no cloning) in a new **`svc-audio`** container (Python + kokoro + ffmpeg); never touches ComfyUI or the GPU. Option: **Chatterbox** (MIT, GPU, voice cloning from ~5 s of Phil's voice) as a second engine in the same container — decide at spec confirmation. big-cat's own Chatterbox stays untouched.
- **Gates:** `workflows/test-music.json` (30 s instrumental at seed 1) and `workflows/test-sfx.json` (5 s effect at seed 1) must produce **non-silent** audio (mean level above −50 dBFS and spectral content, checked in post); record wall time and VRAM peak. `svc-audio` gate: one sentence → non-silent WAV of plausible length.
- **Job types:**
  - `sfx {prompt, profile, seed, duration_s (default 4), count (default 4 variations)}` → `out/<name>-N.wav` + `.ogg` (Vorbis, the runtime format) + waveform PNG per variation, `thumb.png` = waveform of #1.
  - `music {prompt (tags), lyrics?, profile, seed, duration_s (default 30), bpm?, key?, loop (default false)}` → `.wav` + `.mp3` + `.ogg` + waveform. `loop: true` crossfades the tail into the head (like seamless textures) and reports the seam level.
  - `speech {text, profile, voice?, speed?}` → `.wav` + `.ogg` + waveform; CPU only, never starts comfyui.
  - `trailer` gains `music: <music job id>`, `narration: [{speech: <job id>, at_s}]`: ffmpeg mixes music (fade-out, ducked under narration with `sidechaincompress`) and encodes AAC into the MP4 → a trailer **with sound** that plays on a phone.
- **Post (svc-post, ffmpeg):** peak-normalise to −1 dBFS, measure integrated loudness (EBU R128) and true peak, non-silence check, waveform PNG (`showwavespic`), sidecar `audio {sample_rate, channels, duration_s, lufs, peak_dbfs, non_silent}` + stage (model, seed, steps, licence).
- **Profile:** `audio:` block — `sfx_style` and `music_style` prompt suffixes, `sample_rate 44100`, `sfx_channels mono|stereo`, `voice`, loudness targets.
- **UI:** `sfx`/`music`/`speech` in the new-job dialog; job page shows `<audio controls>` per file with its waveform; trailer dialog/yaml accepts music + narration.
- **CLI:** `forge job sfx|music|speech "…"`, trailer yaml keys `music:` / `narration:`.

**Accept:** `forge job sfx "…"` yields 4 variations Phil can audition and download as OGG from the UI; `forge job music "…" --duration 30 --loop` yields a loop that plays seamlessly; a trailer built from three clips + a music job + a speech job plays on a phone with sound; comfyui stops on idle; speech jobs never start comfyui.

### Later (not v1, do not build yet)

Clip-synchronised foley (MMAudio video-to-audio), voice cloning if not chosen in Phase 7, MCP server over the REST API, runtime generation, Kubernetes deployment, multi-GPU scheduling.

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

- Kubernetes must be down and big-cat stopped (by Phil) while Forge runs; Forge expects the GPU to itself. As a guard, before starting `comfyui`, `forge-api` checks free VRAM via `nvidia-smi --query-gpu=memory.free` and refuses to start a job if it is below `FORGE_MIN_FREE_VRAM_GB` (default **80**), naming the processes holding the rest so Phil knows what to stop. Phase 1 records each model's peak VRAM so the threshold can be lowered later if sharing ever becomes desirable.
- Boot: `forge-api` and `forge-ui` may start at boot (systemd unit running `nerdctl compose up -d forge-api forge-ui`); **`comfyui` is never started at boot** — the host driver and CDI spec are not ready for the first seconds after boot, and `comfyui` is on-demand anyway.
- Disk: containerd keeps images on the root disk (do not move its root — other workloads depend on it). Everything else Forge writes — HF cache, BuildKit cache, model weights, outputs — goes under `/srv/forge`. If root free space drops below **30 GB** during a build, stop and ask Phil before continuing; prune dangling images (`sudo nerdctl image prune`) only after the build succeeds.
- No public exposure. Caddy route is LAN + Tailscale only; no Cloudflare tunnel.
- Logs to stdout; `nerdctl compose logs` is the observability story for v1. Health endpoint reports GPU state (free VRAM, whether `comfyui` is up).
- Backups: `/srv/forge/jobs` and `/srv/forge/db` are the only irreplaceable data. Models re-download. Document a one-line rsync.
- Idle noise: after the idle timeout, `nvidia-smi` must show no Forge process and Forge's VRAM contribution at 0, and the only **Forge** containers still running are `forge-api` and `forge-ui`. Forge only ever starts/stops containers defined in its own `compose.yaml`. Any other containers on the VM (`big-cat`, or anything future and Forge-unrelated) are out of scope: never stop, restart, or modify them, and never include them in the idle check.

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
