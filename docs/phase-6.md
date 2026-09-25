# Phase 6 — Video

Date: 2026-09-25. Host `k8s-gpu-1` (`ssh gpu`); Proxmox used only to start the VM. Branch `phase-6`.

## Model choice: Wan 2.2 14B (T2V-A14B + I2V-A14B), fp8, lightx2v 4-step LoRAs

The requirement is "the best open-weight text-to-video model with a maintained ComfyUI node, image-to-video preferred". Candidates with **native ComfyUI core nodes** in the v0.36.0 image (no custom node needed — checked against `/object_info` of the running container):

| Model | Weights | I2V | Native nodes | Why / why not |
|---|---|---|---|---|
| **Wan 2.2 A14B** (Alibaba, Apache-2.0) | T2V 2×14.3 GB fp8 + I2V 2×14.3 GB fp8 (Comfy-Org repackage), umt5 6.7 GB, VAE 0.25 GB | yes, separate I2V model | `UNETLoader`, `CLIPLoader type=wan`, `EmptyHunyuanLatentVideo`, `WanImageToVideo`, `KSamplerAdvanced` | **Chosen.** Best open-weight quality at 480p/720p in 2025–26 community comparisons, MoE high/low-noise pair, first-class Comfy-Org repackage and template, lightx2v distillation LoRAs give a **4-step, cfg 1** fast path. 16 fps native. |
| Wan 2.2 TI2V-5B | 1 × 5B, fp16 | yes (same model) | same + `Wan22ImageToVideoLatent` | Lighter and 24 fps at 720p, but visibly weaker motion/coherence than the 14B pair; the 96 GB card has no reason to take the smaller one. Kept as the fallback if the 14B pair ever misbehaves. |
| LTX-2 (Lightricks) | 19B + audio, ~40 GB | yes | `LTXV*` nodes | Fastest 4K/audio model, but the open weights are a 2026 release with a non-Apache licence tier for commercial use above a revenue cap, and the clean "toy" look is not its strength. |
| HunyuanVideo 1.5 (Tencent) | 8.3B | yes | `HunyuanVideo*` nodes | Good quality, restrictive Tencent community licence (excludes EU/UK/KR use), 24 fps. |
| Kandinsky 5 / MiniMax H3 | — | — | native nodes exist | Newer, fewer reference workflows and no distilled fast path; not evaluated on the GPU. |

Deviation from the spec: **fps 16, not 24**. Wan 2.2 14B is a 16 fps model (81 frames = 5.06 s); `video.fps` in the profile is 16 and the `fps` job field is honoured but changes the *playback* rate of the same 4k+1 frames, not the model. 24 fps output would need frame interpolation (RIFE/FILM) in post, which is a possible later addition. Resolution default is **832×480 (16:9) / 480×832 (9:16)**, the 14B model's 480p training size; 720p (1280×720) runs but takes ~3× longer and was not made the default.

Models downloaded by `/srv/forge/models/download-wan22.sh` (68 GB, Comfy-Org `Wan_2.2_ComfyUI_Repackaged`, no HF token) into `text_encoders/`, `vae/`, `diffusion_models/`, `loras/`.

## Blackwell gate (`workflows/test-video.json`)

`scripts/phase6-gate.sh` (tmux `forge-gate`, log `/srv/forge/tmp/phase6-gate.log`) — comfyui via `nerdctl compose up -d comfyui`, then `scripts/run_workflow.py` for the two workflows with host-side `nvidia-smi` sampling, then `svc-post --mode video` on each clip (non-blank + motion check, exit 3 on a blank/static clip).

**Passed** (2026-09-25 15:49–15:51 UTC; log kept at `/srv/forge/tmp/phase6-gate.log`):

| Run | Result | Wall | Peak VRAM |
|---|---|---|---|
| T2V `test-video.json`, seed 1, cold (models load from disk) | 832×480, 81 frames, 16 fps, 5.06 s, **non-blank, motion** (frame diff 11.3 / 9.2, contrast 223–236) | **42.3 s** | **39,050 MiB** |
| T2V same prompt, seed 2, warm | non-blank | **36.6 s** | 39,370 MiB |
| I2V `image-to-video.json` from the approved snail's `thumb.png`, seed 1, warm | 832×480, 81 frames, non-blank, motion (frame diff 5.7 / 5.6) | **40.1 s** | 39,082 MiB |

Resident VRAM with both Wan models loaded and idle: 34.9 GB (fp8 14B × 2 + umt5 + VAE). The Blackwell (sm_120) path needed nothing special: the fp8 scaled weights run through ComfyUI's stock loader on torch 2.14+cu130. A repeat of the seed-1 prompt returns in 2 s because ComfyUI caches identical graphs; that is not a compute time. Poster frames: `docs/phase-6/renders/gate-t2v-seed1-poster.png` (a waving robot — the prompt "garden robot with big eyes" produced a WALL-E look-alike, worth knowing before using such a clip publicly) and `gate-i2v-snail-poster.png` next to its input `gate-i2v-init.png` (style and character preserved).

## What was built

### `video` job type
`POST /jobs {type: "video", prompt, profile, seed, video: {duration_s 5, fps 16, aspect "16:9"|"9:16", init_image?, fast true}}` / `forge job video "…" [--duration 5] [--fps 16] [--aspect 16:9|9:16] [--init <jobid[/path]>] [--slow]`. `stageVideo` in `worker.ts`:

- **Text-to-video** (`workflows/text-to-video.json`): Wan 2.2 T2V high-noise model for steps 0–2, low-noise for 2–4, lightx2v 4-step LoRAs on both, `ModelSamplingSD3` shift 5, cfg 1, euler/simple, 81 frames at 832×480 (the profile's `video.*` block; 9:16 swaps width/height). Prompt = job prompt + `video.style_prompt`. `--slow` (`fast: false`) drops the LoRAs and runs the plain 20-step, cfg 3.5 schedule split 10/10.
- **Image-to-video** (`workflows/image-to-video.json`): same, I2V models and LoRAs, `init_image` = `<jobid>` (that job's `out/thumb.png`), `<jobid>/<path under the job dir>`, or an absolute path under `/srv/forge`; it is copied to `refs/init.png`, lanczos-fitted to the clip size (centre crop) and fed to `WanImageToVideo` as `start_image`.
- ComfyUI's `CreateVideo` + `SaveVideo` (h264 mp4) write `comfy/output/jobs/<id>/out/`; the file moves to `raw/clip-comfyui.mp4`.
- **Post** (`svc-post --mode video`, ffmpeg 5.1 in the rebuilt `forge/svc-post:0.1.0`): ffprobe → `<name>.mp4` (libx264 crf 20, yuv420p, faststart, no audio), `<name>.webm` (VP9 crf 32), `<name>-poster.png` (frame at ⅓) and `thumb.png`; **non-blank/motion check** with `signalstats` on the first, middle and last frames (contrast and luma/temporal difference thresholds), recorded as `video.non_blank` and fatal if false. Sidecar: `video {width,height,fps,duration_s,frames,source_codec,non_blank}`, `files {mp4,webm,poster,thumb}`, and a `video` stage (model, mode, init image, seed, steps, cfg, shift, frames, seconds, licence).
- **UI**: `video` type in the new-job dialog (16:9/9:16 toggle, seconds, fast switch, optional init image); the job page shows an inline `<video controls>` MP4 (WebM fallback, poster) with the sidecar numbers and the non-blank verdict, plus MP4/WebM download buttons. Job cards use `thumb.png` (the poster) like every other type.

### `trailer` job type
`forge job trailer examples/trailer.yaml` (`title`, `subtitle`, `xfade_s`, `card_s`, list of finished video job ids) → `POST /jobs {type: "trailer", trailer: {clips, title, subtitle, …}}`. Validated at submit time (every clip must be a video job in review/approved). `stageTrailer` needs no GPU: it never starts comfyui and runs `svc-post --mode trailer`: a 2 s title card (drawtext, DejaVu Sans Bold, Meadowbots green) then the clips scaled/padded to the first clip's size and fps, joined with `xfade` (0.5 s), libx264 + poster + sidecar `trailer {clips, clip_jobs, width, height, fps, duration_s}`. The trailer job page shows it inline like a clip.

## Acceptance (§7)

- `forge job video "a round friendly garden robot with big eyes waters a row of flowers, gentle camera push-in" --seed 601 --batch trailer-1` → job `e45105f1` in review after **31 s** (28 s on the GPU + 3 s post); the UI job page shows the clip inline with controls and poster, plus MP4 and WebM download buttons. Two more clips: `ade82872` (image-to-video from the approved snail `65bfca60`, 41 s) and `21bfdce9` (berry bush with butterflies, 40 s). A 9:16 clip (`adc64d46`, 480×832, 31 s) also passed.
- `forge job trailer trailer-1.yaml` (the three ids, title "Meadowbots", subtitle "a garden of little robots") → job `5efcf396` in review after **2 s**, no GPU: 832×480, 16 fps, **15.75 s** (2 s card + 3 × 5.06 s − 2 × 0.5 s crossfades), H.264 High@L3.0 yuv420p faststart, 1.6 MB. It plays in the browser pane at a 375×812 phone viewport (title card, then the clips crossfading), and High@L3.0 at 480p is inside every phone decoder's envelope. Copy in `docs/phase-6/renders/trailer-1.mp4`, with posters of the clips and the title card alongside.
- **comfyui idle stop:** the trailer job never touched the GPU, and forge-api's idle timer was re-armed by the UI deploy restart at 15:57:27 UTC with `idle_stop_at` 16:07:27 UTC. Confirmation of the stop (VRAM back to 2 MiB) is recorded in the PR thread; the mechanism itself is unchanged from Phase 2.

## Numbers

| Item | Value |
|---|---|
| Wan 2.2 14B T2V, 832×480 × 81 frames, 4-step | 28–37 s warm, 42 s cold; peak 39.4 GB, resident 34.9 GB |
| Wan 2.2 14B I2V, same size | 38–40 s warm; peak 39.1 GB |
| svc-post video (x264 + VP9 + poster + check) | 2.5–3.2 s; clip ≈ 0.2–0.5 MB MP4 |
| Trailer, 3 clips + card | 1.6 s, 15.75 s, 1.6 MB |
| Video job on disk | ~2.9 MB (raw ComfyUI clip + MP4 + WebM + posters) |
| Models added | 68 GB (`/srv/forge/models` now 114 GB; data disk 49 % used, 202 GB free) |

## Things that turned out wrong in practice

1. **24 fps** in the spec → 16 fps (model-native); see above.
2. **"Non-blank clip"** needs a definition: a clip can be non-blank but static (a still image for 5 s), which is the typical failure mode when the prompt is out of distribution. The check therefore also requires temporal change between the first, middle and last frames.
3. The tmux server on the VM exited once while the model download was running (the download shell got no chance to log a failure; the build session ended in the same minute). `curl -C -` resumed it; the gate script waits for the download's `DONE` line rather than assuming.

## Next
Phase 6 is the last v1 phase in `docs/requirements.md` §7. Everything under "Later" (audio, MCP server, runtime generation, Kubernetes, multi-GPU) stays unbuilt until Phil asks.
