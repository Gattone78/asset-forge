# Phase 4 — Rigging

Date: 2026-09-24. Host `k8s-gpu-1` (`ssh gpu`); Proxmox untouched. Branch `phase-4`.

## What was built

- **`workflows/rig.json`** — `UniRigLoadMesh` → `UniRigLoadModel` → `UniRigAutoRig` (skeleton template from the profile, `target_face_count` 50 000) → `UniRigPreviewRiggedMesh` (the output node). Nodes addressed by title as everywhere else.
- **Rig stage in forge-api** (`worker.ts: stageRig`), opt-in per job with `rig: true` / `forge job creature … --rig`, creatures only (props/plants get `pivot_root`; the API returns 400 otherwise). After the post stage it copies the finished, normalized, textured asset (`<name>.blender.glb`) into ComfyUI's input, runs `rig.json` on the GPU (**36–42 s** warm), moves UniRig's FBX to `raw/rigged-unirig.fbx`, then runs svc-post in rig mode.
- **svc-post rig mode** (`post.mjs --mode rig`, Blender `forge_post.py rigmerge`, **2 s**): imports the FBX, names the armature `Armature` (§8), joins the mesh as `pivot_root`, re-applies the baked albedo material from the unrigged GLB (UniRig keeps the UV layout), re-normalizes (UniRig rescales to a ±1 box: feet back to y = 0, height back to the profile's 0.6 m), welds the vertices UniRig split, clears FBX sharp-edge flags and custom normals, exports **`<name>.rigged.glb`** (skins, ≤ 4 influences, meshopt; **11,875 verts, identical to the static asset**, after the weld) and **`<name>.rigged.fbx`**, renders `thumb-rigged.png`, and updates the sidecar in place: `rigged: true`, a `rig` stage with model, template, bone count, **bone names**, skeleton root, license, plus `geometry_rigged`.
- **Profile**: `rig.template: articulationxl` (any creature) — `mixamo` is the alternative for humanoids.
- **UI**: the rig switch is enabled for creatures; the job page shows Rigged GLB / Rigged FBX downloads, a `static | rigged` toggle on the 3D preview, a **"wiggle bones"** switch that drives every bone procedurally in Three.js, and the rig stage in the sidecar card. The `/viewer` page reports SkinnedMesh count, bones, `pivot_root` and `Armature`, and `&wiggle=1` does the same sway.
- **Named pivots (§8)**: the post stage has always exported the whole mesh as one node named `pivot_root`; Phase 4 verified it on a prop job. `pivot_top` / `pivot_lid` / `pivot_spin` remain reserved for a later part-split.

## Acceptance (§7)

| Criterion | Result |
|---|---|
| A rigged bot GLB loads in Three.js with a `SkinnedMesh` and bones Phil can drive procedurally | Job `fb50bee7` (`forge job creature "a round friendly garden robot with big eyes" --seed 1 --rig`, **~150 s** total incl. rig): `/viewer` reports `skinned meshes 1 · bones 14 (bone_0, bone_1, …) · pivot_root found (SkinnedMesh) · Armature found`; with `wiggle=1` (and the UI's "wiggle bones" switch) every bone's Z rotation is driven with a sine and the robot visibly sways. `getObjectByName("Armature")` and the bones by name are all reachable. |
| A prop with `pivot_*` nodes exposes them by name | Job `8d9f0a5f` (`forge job prop "a small wooden garden bucket with a rope handle" --seed 3`): `/viewer` reports `pivot_root found (Mesh)`, 7,166 tris, feet at y = 0, height 0.600 m. |

Outputs for both are in Phil's `~/forge-review/rigged-fb50be/` (rigged GLB 4.3 MB, rigged FBX 5.7 MB, sidecar with 14 bone names) and the UI.

## Things that turned out wrong in practice

1. **UniRig's mesh loader freezes its file list.** `UniRigLoadMesh.file_path` is a combo whose options come from comfy-env's cached node schema (`/srv/forge/comfy/ce/envs/unirig-nodes/.pixi/envs/default/.metadata_cache.pkl`), scanned once when the isolated env is first started and never again — not at container start, not at validation. A per-job filename can never validate. The rig stage therefore always overwrites one fixed file, `input/rig-in.glb` (safe: one job at a time), and forge-api seeds that placeholder from `giraffe.glb` and deletes the cache once so the list includes it. Recorded in `comfy.ts` (`RIG_INPUT`). If the list ever needs refreshing: delete the `.pkl` and restart comfyui.
2. **Rigging is not seed-deterministic.** `UniRigAutoRig` has no seed input (the seeded `UniRigExtractSkeletonNew` path needs loader nodes that this build does not register), and the same asset produced 16 bones on one run and 14 on the next. The sidecar records `seed: null` for the rig stage and the full bone list; `forge rerun` regenerates the skeleton. §1's "every job records seeds" holds for image and 3D; for rigging the record is the bone list itself. Propose noting this in §8.
3. **Bone names are `bone_0 … bone_N`**, not Mixamo names (the `articulationxl` template has no humanoid mapping). §8 already allows this ("otherwise leave UniRig's names and list them in the sidecar"), which is what happens. `mixamo` template exists for humanoid bots if wanted.
4. **FBX round trip triples the vertex count** unless handled: the FBX importer brings custom split normals, sharp-edge flags from smoothing groups and per-corner UV noise, and the glTF exporter then splits every corner (32 k verts for an 11 k-tri mesh). `rigmerge` clears normals and sharp edges, quantises UVs and welds: 32,562 → **11,875** vertices, the same as the static asset, and the GLB shrank from 4.7 MB to 4.3 MB.

## Numbers

| Item | Value |
|---|---|
| UniRig on the 11,480-tri asset | 36–42 s (warm model, isolated worker) |
| Blender merge + export + meshopt | 1.6–2.0 s |
| Bones (articulationxl, robot) | 14 (16 on another run) |
| Rigged GLB / FBX | 4.3 MB / 5.7 MB (texture-dominated) |
| Job wall time with `--rig` | ≈ 150 s (refs 22 s, 3D 52 s, post 38 s, rig 40 s) |

## State-changing commands run (gpu only)

svc-post image rebuilt ×5 (iterations), forge-api restarted between jobs, comfyui restarted once to rescan the UniRig file list, comfy-env metadata cache deleted once, `input/rig-in.glb` placeholder created, jobs: 5 rigged attempts (3 failed on the file-list problem, 1 on my orchestrator bug, 1 pass) and 1 prop. big-cat untouched; Proxmox untouched.

## Next (Phase 5)

2D and batch: `image` job type (FLUX + `rembg`), seamless textures, `forge job batch`.
