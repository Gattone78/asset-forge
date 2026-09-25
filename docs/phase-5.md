# Phase 5 — 2D and batch

Date: 2026-09-25. Host `k8s-gpu-1` (`ssh gpu`); Proxmox used only to start the VM. Branch `phase-5`.

## What was built

### `image` job type (sprites, textures, tiles)
`POST /jobs {type: "image", prompt, profile, seed, count, image: {kind: sprite|texture|tile, transparent, seamless, size}}` / `forge job image "…" --kind … [--transparent|--opaque] [--seamless|--no-seamless]`. No 3D stages; `stageImage` in `worker.ts`:

- **Generation**: FLUX.1 schnell, `count` candidates at `seed`, profile `image.size` (1024). Prompt = prompt + profile style + a kind-specific suffix: `image.sprite_prompt` for sprites (isolated on white, centered, no shadow); `image.texture_style` + `image.texture_prompt` for textures/tiles (top-down, even lighting, repeating, *no characters/animals/objects* — the creature-flavoured profile style prompt otherwise puts a little animal in a moss texture, which it did on the first try).
- **Transparent background** (default for sprites): `workflows/image-cutout.json` = FLUX → `RemoveBackground` (**BiRefNet, ComfyUI core**) → `InvertMask` → `JoinImageWithAlpha` → RGBA PNG; the uncut original is kept in `refs/`. The spec names `rembg`; BiRefNet is the same job, already on the GPU, and needs no new dependency — deviation noted. Checked on the strawberry sprite: corner alpha 0, centre 255, 23 % opaque pixels, clean edges.
- **Seamless mode** (default for textures and tiles): a **tile check** in post (mean |left − right| and |top − bottom| edge difference, 0 = wraps perfectly) plus a 2×2 tiled preview PNG. FLUX does not tile on its own (raw scores 0.25–0.35), so seamless mode also **makes** the texture tileable with the classic offset-and-crossfade: the border 22 % of the image is faded into the half-offset copy, whose wrap edges are continuous. The raw image and its raw tiled preview stay in `refs/`; the sidecar records both scores.
- Outputs: `out/<name>-N.png` (+ `-N-tiled.png`), `thumb.png`, sidecar with an `image` stage (model, seed, steps, count, size, kind, flags, background-removal method, license) and an `images` list (size, alpha, seam scores).
- **UI**: `image` type in the new-job dialog with a sprite/texture/tile toggle and the two switches; the job page shows the images on a checkerboard (alpha visible), seam scores with a green/orange verdict, and the tiled previews.

### `forge job batch`
`forge job batch examples/plants.yaml` (or a plain text file, one prompt per line) → one job per prompt, all with the same `type`/`profile`, seeds `seed + index`, and a shared **batch label** (from the file or `<file>-<timestamp>`). The label is a column in SQLite; `GET /jobs?batch=` and `GET /batches` (label, count, first created) expose it; `forge list --batch L` and `forge batches` use it. The UI shows a batch chip on each card (click = filter), a Batch filter, and a **set view**: with a batch selected the list becomes a tight grid of thumbnails so the set can be judged as one style.

## Acceptance (§7): a batch of 10 plants renders in the UI as a set, all visibly the same style

`examples/plants.yaml` — 10 plant prompts, profile `meadowbots-flat`, seeds 500–509, label `plants-set-1`, submitted with one `forge job batch` command. **All 10 reached review** (no failures) in 19 min of wall time; the UI at `/ui/?batch=plants-set-1` shows them as a 5-column thumbnail grid and they read as one set: the same pastel toy palette, rounded shapes, flat shading, each on the ground at 0.6 m. Contact sheet: `docs/phase-5/renders/plants-set-1.png` (also in Phil's `~/forge-review/`). Per-plant wall time ranged from 53 s (sunflower) to 261 s (berry bush, whose many small components cost 166 s in the 3D stage and 88 s in post). **Honest caveat:** 9 of the 10 are good; the lily pad (seed 508) is a washed-out, faint mesh — a flat, near-white subject on a white reference background gives BiRefNet and TRELLIS.2 little to work with. It is in review like the others; Phil can reject and rerun it with a new seed from the UI, which is what the review step is for. The crossfade on the seamless moss texture leaves faintly ghosted pebbles in the border band; the tiling itself is clean.

Other Phase 5 evidence in `docs/phase-5/renders/`: `sprite-strawberry.png` (RGBA cut-out), `texture-moss-raw-tiled.png` vs `texture-moss-seamless-tiled.png` (the 2×2 previews before and after the crossfade).

## Numbers

| Item | Value |
|---|---|
| Sprite job, 2 candidates, cut-out | ~30 s warm (FLUX 2 s/image + BiRefNet); alpha corner 0 / centre 255, 23 % opaque |
| Texture job, 2 candidates, tile check + make-seamless | ~30 s; seam score **0.247 → 0.031** and **0.173 → 0.035** (raw → fixed) |
| Plant batch, 10 jobs | 10/10 review, 19 min total, 53–261 s per job |

## Things that turned out wrong in practice

1. **"Seamless texture mode (tile check in post)"** — a check alone is not a mode. FLUX schnell output scores 0.25–0.35 on the edge test, so seamless mode now also *makes* the image tileable (offset + crossfade), and the sidecar keeps both the raw and the fixed score. The crossfade softens the border band; for tiles that must stay crisp, the alternative is generating with circular padding in the diffusion model, which needs a custom ComfyUI node — not done.
2. **`rembg`** → BiRefNet in ComfyUI core (same purpose, no new dependency, better matting on soft edges).
3. The profile's creature style prompt must not be applied to textures; `image.texture_style` was added.

## Next (Phase 6)
Video: pick a text-to-video model with a maintained ComfyUI node, Blackwell gate with `workflows/test-video.json`, `video` job type, ffmpeg in svc-post.
