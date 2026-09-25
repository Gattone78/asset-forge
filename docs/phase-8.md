# Phase 8 — Photo-driven creation (promo clips and rigged models from photos)

Date: 2026-09-25. Host `k8s-gpu-1` (`ssh gpu`); Proxmox not touched. Branch `phase-8`. Spec: the "Phase 8" section in `docs/requirements.md` (proposed, confirmed by Phil with the recommended choices: Qwen-Image-Edit as the restyle model, several photos = several candidates, typed narration scripts, styles `realistic` / `pixar` / `2d` / `toy`).

## Model

| Role | Model | Weights | Licence | Nodes |
|---|---|---|---|---|
| Restyle a photo into the chosen look | **Qwen-Image-Edit 2511** (fp8 mixed) + Qwen2.5-VL 7B fp8 text encoder + Qwen-Image VAE | 30.2 GB, `Comfy-Org/Qwen-Image-Edit_ComfyUI` + `Comfy-Org/Qwen-Image_ComfyUI` (ungated) | Apache-2.0 | ComfyUI core: `TextEncodeQwenImageEditPlus`, `FluxKontextImageScale`, `FluxKontextMultiReferenceLatentMethod`, `CFGNorm`, `ModelSamplingAuraFlow` (40 steps, cfg 3, shift 3.1, euler/simple — the Comfy-Org 2511 template without its optional Lightning LoRA) |

Everything else in this phase reuses Phase 2–7 stages: BiRefNet cut-out, TRELLIS.2, svc-post, UniRig, Wan 2.2 I2V, MMAudio, Kokoro, ACE-Step, the trailer mixer. FLUX.1 Kontext dev was not used (non-commercial licence).

## Blackwell gate (`scripts/phase8-gate.sh`)

**Passed** first time (2026-09-25 17:22–17:25 UTC; `docs/phase-8/gate.log`). Input: the Phase 6 robot poster frame (`gate-input.png`, a photoreal-looking render we own — no photo of a person was fetched for the gate).

| Run | Result | Wall | Peak VRAM |
|---|---|---|---|
| `pixar` instruction, seed 1, cold (models load from disk) | 1.2 MB PNG, **SSIM vs input 0.31** (changed, composition kept) — `gate-restyle-pixar.png` | **82.1 s** | **29,500 MiB** |
| `2d` instruction, seed 2, warm | `gate-restyle-2d.png` | **68.1 s** | 30,044 MiB |

40 steps of the 20B model at cfg 3 is the slow part (≈1.7 s per step). The Comfy-Org template's optional Lightning 4-step LoRA would bring a restyle down to ~10 s; it was not downloaded for the gate, and is the first thing to add if restyle time matters.

## What was built

- **Uploads:** `POST /uploads?name=…` with the image as the raw request body (PNG/JPEG/WebP, ≤ 20 MB; no multipart dependency — the file is the body), stored as `/srv/forge/uploads/<uuid>.png` with the EXIF orientation applied plus `<uuid>.json` (name, sizes, sha256, pixel size, time). `GET /uploads`, `GET /uploads/<id>` (the PNG), `DELETE /uploads/<id>` (409 while any job references it). Jobs reference uploads by id (`upload:<id>` also accepted, including for `video.init_image`). CLI `forge upload <files…>` / `forge uploads`; UI **Uploads** page (drop photos, thumbnails, copy id, delete) and an "Add photo" picker inside the new-job dialog.
- **Styles:** `styles:` block in the profile — `realistic` (no restyle), `pixar`, `2d`, `toy` — each with a restyle instruction, video / 3D prompt suffixes and music / sfx hints.
- **`promo` job** (`forge job promo --photo <id> "prompt" --style pixar [--script "…"] [--title "…"] [--no-music] [--no-foley] [--duration 5] [--aspect 9:16]`): one job runs **restyle** (skipped for `realistic`) → **video** (Wan 2.2 I2V from the styled still) → **foley** (MMAudio on the clip, 25 fps re-encode) → **speech** (Kokoro, if a script was given) → **music** (ACE-Step, long enough for the clip) → **mix** (svc-post trailer mode: optional 2 s title card, the clip with its foley, music at −14 dB ducked under the narration). Outputs: `out/<name>.mp4` (+ poster), `out/styled.png`, the silent clip and its WebM, and `foley/`, `speech/`, `music/` subfolders with every intermediate; one sidecar listing all stages (restyle, video, foley, speech, music, mix). The job page shows the uploaded photo next to the styled still, then the final MP4.
- **`model` job** (`forge job model --photos <id>[,…] "prompt" --style pixar [--no-rig]`): the 3D pipeline with the references replaced by the photos — each photo is restyled (unless `realistic`), cut out with BiRefNet (`workflows/photo-cutout.json`) and scored like a FLUX candidate; the best one goes to TRELLIS.2 → post → UniRig, exactly as a creature job. Several photos = several candidates (`refs/candidates.json` records which photo won), not a fused multi-view model.
- **svc-post trailer mode** gained `--card 0` (no title card, single-clip mixes) for the promo mix.
- **UI:** `promo` and `model` types in the dialog with style, photo picker (or multi-select of uploads), script, aspect/seconds, music/foley switches, title; Uploads page and app-bar link.

## Acceptance (§7 Phase 8)

ACCEPTANCE_RESULTS

## Numbers

NUMBERS

## Things that turned out wrong in practice

NOTES

## Next
Nothing scheduled. "Later" in `docs/requirements.md`: multi-view fusion, voice cloning, an LLM for scripts, MCP, runtime generation, Kubernetes, multi-GPU.
