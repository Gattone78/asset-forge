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

Run with the gate frame uploaded through the CLI (`forge upload docs/phase-8/gate-input.png` → upload `2a51e4f2`); Phil then reviewed the promo page in the UI ("looks good to me"). A photo of a person was deliberately not part of my run — that is Phil's own upload to make, with the `humanoid` switch for the rig.

- **promo:** `forge job promo --photo 2a51e4f2 "a friendly garden robot waters flowers and looks up at the camera, gentle camera push-in" --style pixar --script "Meet Sprout, the little robot who keeps the meadow growing." --title "Meadowbots" --seed 801` → job `acb0f4c5` in review after **165 s**: restyle 86 s → clip 42 s → foley 15.5 s → narration 3.9 s (CPU) → music 8 s → mix 1.4 s. Output 6.6 s (2 s title card + 5.06 s clip), H.264 + AAC with foley, narration at 3 s and music ducked under it; `out/styled.png` next to the uploaded photo on the job page; every intermediate kept under `out/`. Copies: `docs/phase-8/promo-pixar-with-sound.mp4`, `promo-styled-still.png`, `promo-clip-poster.png`. The first run of this job failed on a variable I had left undefined in the music stage; fixed and rerun. The narration (5.7 s) ran past the 5 s clip, so promo now holds the last frame until the sentence finishes (`--tail-hold` in the mixer) — in effect from the next run.
- **model:** `forge job model --photos 2a51e4f2 "a friendly garden robot" --style toy --seed 802` → job `964b421c` got through restyle (85 s), cut-out (2 s) and TRELLIS.2 (50 s) but the photo was a whole garden scene, so post had a 5.2 M-triangle scene to decimate and was still running when the VM was shut down for the day (marked failed on the next start). Rerun with a subject-only photo (the Phase 6 snail poster, upload `4e45dab0`): `forge job model --photos 4e45dab0 "a chubby smiling snail" --style toy --seed 812` → job `3015be5d`; its result (geometry, bones, times) is posted in the PR thread.
- **realistic:** the `realistic` style skips the restyle stage (logged as "restyle: skipped") and feeds the photo straight to Wan I2V / the cut-out.
- **comfyui idle stop:** unchanged mechanism; the stop after the last Phase 8 GPU job is recorded in the PR thread.
- **Uploads survive job deletion** by construction (separate directory, delete refused while referenced); they are in the backup set with `jobs/` and `db/`.

## Numbers

| Item | Value |
|---|---|
| Qwen-Image-Edit 2511 restyle (40 steps, 832×480 in) | 82 s cold, 68–86 s warm; peak 29.5–30 GB VRAM |
| promo job end to end (pixar, script, title, foley, music) | 165 s; output 6.6 s MP4 with AAC, 0.66 MB |
| model job end to end (toy, rigged, one photo) | restyle 85 s + cut-out 2 s + TRELLIS.2 50 s + post + rig (final numbers for job `3015be5d` in the PR thread) |
| Models added | 30.2 GB; `/srv/forge/models` ≈ 164 GB, data disk 69 % |
| Upload | 832×480 PNG stored as 0.88 MB; upload round-trip < 1 s |

## Things that turned out wrong in practice

1. **The restyle reinterprets, it does not only re-shade.** With "keep the same subject, pose and framing" in the instruction, the `pixar` pass on the robot frame produced a doll-like character with a face where the robot's visor was, while the `2d` pass stayed faithful (`docs/phase-8/gate-restyle-*.png`). Wan I2V then followed the still. Expect the same on a person: the likeness is approximate, and the instruction wording per style is the knob to tune.
2. **Restyle time dominates a promo** (≈ 85 s of 165 s). The Lightning 4-step LoRA for 2511 is the fix if it matters.
3. **A narration longer than the clip** was cut off in the first acceptance run; the mixer now holds the last frame until the sentence ends (`--tail-hold`). Longer scripts should still get a longer `duration_s` (up to 10 s) or a second clip.
4. **A photo of a whole scene becomes a whole scene in 3D**: the `model` acceptance photo (a garden with the robot in it) gave TRELLIS.2 a 5.2 M-triangle scene to decimate, which was still running after 10 minutes when the VM was shut down. Photos for `model` should be of the subject alone, or the cut-out step needs a "main subject only" pass.
5. **The job page picked the wrong MP4** for promo jobs at first (the silent intermediate clip sorts before the final file); it now prefers the final mix.
6. Uploads use the raw request body instead of multipart, so forge-api gained no dependency; the trade-off is one request per file.

## Next
Nothing scheduled. "Later" in `docs/requirements.md`: multi-view fusion, voice cloning, an LLM for scripts, MCP, runtime generation, Kubernetes, multi-GPU.
