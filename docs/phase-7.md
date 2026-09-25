# Phase 7 — Audio (SFX, music, narration, foley)

Date: 2026-09-25. Host `k8s-gpu-1` (`ssh gpu`); Proxmox not touched. Branch `phase-7`. Spec: the "Phase 7 — Audio" section added to `docs/requirements.md` this phase (audio had been "Later"); Phil confirmed the model picks and asked for clip-synchronised foley to be included.

## Models

| Job | Model | Weights on disk | Licence | Where it runs |
|---|---|---|---|---|
| `music` | **ACE-Step 1.5 Turbo** (`acestep_v1.5_turbo`, Qwen 0.6B + 1.7B text encoders, ACE 1.5 VAE) | 10.0 GB, `Comfy-Org/ace_step_1.5_ComfyUI_files` | MIT (model), Apache-2.0 (repackage) | comfyui, core nodes `TextEncodeAceStepAudio1.5` / `EmptyAceStep1.5LatentAudio`, 8 steps, cfg 1, shift 3 |
| `sfx` | **Stable Audio 3.0 Small-SFX** (+ `t5gemma_b_b_ul2` encoder) | 3.5 GB, `Comfy-Org/stable-audio-3` | Stability AI Community License (outputs are ours; commercial use under US$1M/yr) | comfyui, core `CheckpointLoaderSimple` + `CLIPLoader type=stable_audio`, 50 steps, cfg 7, lcm/simple |
| `foley` | **MMAudio large 44k v2** (fp16) + Synchformer + VAE + DFN5B CLIP + NVIDIA BigVGAN v2 | 5.6 GB, `Kijai/MMAudio_safetensors` + `nvidia/bigvgan_v2_44khz_128band_512x` | MIT (MMAudio, node, BigVGAN) | comfyui **custom node** `ComfyUI-MMAudio` @ `8eaeb72e` (new image `forge/comfyui:0.1.1`), 25 steps, cfg 4.5 |
| `speech` | **Kokoro-82M** (`kokoro-v1_0.pth`, 54 voices) | 0.34 GB, `hexgrad/Kokoro-82M` | Apache-2.0 | **`svc-audio`** container (Python 3.12, CPU torch 2.8, kokoro 0.9.4, espeak-ng, ffmpeg); never starts comfyui |

Alternatives considered: Stable Audio Open 1.0 (older, more restrictive licence), ACE-Step 1.5 XL (10 GB per model, 4B encoder; turbo is enough for 30 s loops), MMAudio-only for SFX (MIT but weaker on isolated one-shots than SA3), Chatterbox for voice cloning (MIT, GPU; not chosen — Phil went with fixed voices), Qwen3-TTS (Apache-2.0, larger). All four picks are ungated downloads; no HF token.

Downloaded by `/srv/forge/models/download-audio.sh` (19.5 GB) into `diffusion_models/`, `text_encoders/`, `vae/`, `checkpoints/`, `mmaudio/` (BigVGAN under `mmaudio/nvidia/…`, where the node looks before it would try to download) and `kokoro/`.

## Blackwell gate (`scripts/phase7-gate.sh`)

**Passed** on the second attempt (2026-09-25 16:31–16:47 UTC; `docs/phase-7/gate.log`, condensed in `gate-summary.log`). comfyui 0.36.0 on the rebuilt `forge/comfyui:0.1.1` reported every new node registered (`TextEncodeAceStepAudio1.5`, `EmptyAceStep1.5LatentAudio`, `MMAudioModelLoader`, `MMAudioSampler`, `LoadVideo`, `GetVideoComponents`, `SaveAudio`).

| Gate | Result | Wall | Peak VRAM |
|---|---|---|---|
| Music, ACE-Step 1.5 turbo, 30 s instrumental, seed 1, cold | 30.00 s FLAC, mean −14.0 dBFS, **non-silent** | **12.0 s** | **10,360 MiB** |
| Music, seed 2, warm | non-silent | **4.0 s** | 10,424 MiB |
| SFX, Stable Audio 3 Small-SFX, 5 s, seed 1 (models already resident) | 5.02 s, mean −14.5 dBFS, non-silent | **4.3 s** | 10,360 MiB (2,606 MiB on its own) |
| SFX, seed 2, warm | non-silent | **2.0 s** | 2,606 MiB |
| Foley, MMAudio large 44k v2 on the Phase 6 robot clip (16 fps as delivered) | 3.25 s (see note), −16.4 dBFS, non-silent | 16.1 s | **42,320 MiB** |
| Foley, same clip re-encoded to 25 fps | **5.02 s**, −15.8 dBFS, non-silent | **14.4 s** | 42,574 MiB |
| Narration, Kokoro in `svc-audio` (CPU, 8 threads) | 3.73 s of speech, −17 dBFS mean, non-silent | **4.2 s** generation, 6 s including container start | 0 |

**First attempt failed** at the music gate before any sampling: torch 2.14 routes a small matrix op in the Qwen encoder's rotary embeddings through its new native Triton kernels, Triton compiles a CUDA driver shim with a C compiler on first use, and the comfyui image had none (`Failed to find C compiler`). Phil chose to add `build-essential` to the image (the alternative was `TORCH_DISABLE_NATIVE_JIT=1`). The rerun then failed the same way because `nerdctl compose up -d` reused the container created from the previous image; the container had to be removed once, and forge-api and the gate scripts now start comfyui with `--force-recreate`. Two further fixes on my side: `svc-audio` needed spaCy's `en_core_web_sm` baked in (misaki tries to pip-install it at runtime, which does not work as uid 1000), and MMAudio's Synchformer assumes **25 fps** input — an 81-frame 16 fps Wan clip was read as 3.24 s — so foley jobs feed a 25 fps re-encode of the clip.

## What was built

- **Workflows:** `text-to-music.json` (ACE-Step 1.5), `text-to-sfx.json` (SA3 Small-SFX, batch = variations), `video-to-audio.json` (`LoadVideo` → `GetVideoComponents` → `MMAudioSampler`), and their gate copies `test-music.json`, `test-sfx.json`, `test-foley.json`.
- **Job types** (`forge-api` `stageAudio` / `stageSpeech`, request field `audio: {duration_s, count, loop, bpm, key, voice, speed, clip, sample_rate, channels}`):
  - `sfx` — prompt + profile `audio.sfx_style`, `count` variations (default 4) of `duration_s` (default 4) in one batch → `out/<name>-N.wav` + `.ogg` (mono, the runtime format) + `-N-waveform.png`.
  - `music` — tags = prompt + `audio.music_style`, `[instrumental]` lyrics, bpm/key from the request or profile, `duration_s` (default 30) → `.wav` + `.mp3` + `.ogg` + waveform. `loop: true` crossfades the tail into the head (2 s) so the file repeats without a click; the sidecar records the seam level difference.
  - `foley` — `audio.clip` = a finished video job; the clip is fed to MMAudio (frames + optional prompt) → `<name>.wav/.ogg` and **`<name>.mp4`: the clip with the new AAC track**; the job page plays the video.
  - `speech` — text → Kokoro voice (`audio.voice`, profile default `af_heart`) → 24 kHz mono `.wav` + `.ogg` + waveform. CPU only; queued like any job but never starts comfyui.
  - `trailer` gains `music: <music job>` (`music_db`, default −14 dB, 2 s fade-out) and `narration: [{speech: <speech job>, at_s}]`; clips may be video **or foley** jobs. svc-post builds one AAC track: clip audio (or silence) concatenated with `acrossfade` matching the video crossfades, music underneath, ducked with `sidechaincompress` while narration plays, narration on top, limiter.
- **Post** (`svc-post --mode audio`): resample/channel-fit, peak-normalise to −1 dBFS, EBU R128 loudness + true peak, `showwavespic` waveform, non-silence check (mean level > −50 dBFS), sidecar `audio {kind, count, sample_rate, channels, duration_s, lufs, peak_dbfs, non_silent}` + `audios[]` per variation + a stage record (model, seed, steps, cfg, licence). Exit 3 if every variation is silent.
- **Profile** `audio:` block: `sample_rate`, `sfx_channels`, `sfx_duration_s`, `sfx_style`, `music_duration_s`, `music_style`, `music_bpm`, `music_key`, `voice`, `voice_speed`, `music_db`.
- **CLI:** `forge job sfx|music|speech "…"` (`--duration --count --stereo | --loop --bpm --key | --voice --speed`), `forge job foley <video job id> ["hint"]`, trailer yaml `music:` and `narration: <speech id>@<seconds>, …`.
- **UI:** the four types in the new-job dialog with their fields; job pages show each variation's waveform with an `<audio controls>` player (OGG, WAV fallback), loudness and the non-silent verdict, WAV/OGG/MP3 links; foley jobs show the clip with sound.
- **Images:** `forge/comfyui:0.1.1` (= 0.1.0 + ComfyUI-MMAudio and its deps), `forge/svc-audio:0.1.0` (new), `forge/svc-post:0.1.0` rebuilt with the audio and trailer-audio modes.

## Acceptance (§7 Phase 7)

All through the CLI from the workstation against `http://192.168.1.51:8080`, batch `audio-1`:

- `forge job sfx "a small round robot beeps twice and whirs" --seed 701 --count 4` → job `fcc4adf7` in review after **6 s** (4.5 s on the GPU for the 4-variation batch, 1.9 s post): four 4.09 s mono 44.1 kHz WAV + OGG files with waveforms; the UI job page shows the four players with the non-silent verdict, WAV/OGG links; each OGG imports as a runtime sound.
- `forge job music "gentle garden morning, curious little robots" --seed 702 --duration 30 --loop` → job `89a34294` after **12 s** (10.5 s GPU): 28.0 s stereo loop (30 s minus the 2 s tail-to-head crossfade), −13.8 LUFS, **loop seam 0 dB** (tail and head levels match), WAV + MP3 + OGG. Copy: `docs/phase-7/music-gentle-garden-morning-loop.mp3`.
- `forge job speech "Welcome to Meadowbots, a garden of little robots. Plant, tinker, and make friends."` → job `39580e5e` after **6 s on the CPU** (comfyui untouched): 5.7 s, −16.5 LUFS, voice `af_heart`. Copy: `docs/phase-7/speech-welcome.ogg`.
- `forge job foley e45105f1 "a small robot watering flowers, servo whirs, water trickling, garden birds" --seed 704` → job `ea9b84ed` after **14 s** (12.5 s GPU): a 5.1 s stereo track synchronised to the Phase 6 robot clip and `…ea9b84.mp4`, the clip with that track. Copy: `docs/phase-7/foley-robot-watering.mp4`.
- `forge job trailer examples/trailer-2.yaml` (the foley clip + two Phase 6 clips, `music:` the loop above at −14 dB, `narration:` the speech job at 2.5 s) → job `21e7fb2c` after **2 s**, no GPU: 15.75 s, H.264 + **AAC 48 kHz stereo**, 1.9 MB. Plays with sound in the browser pane at a 375×812 phone viewport: title card, narration over the ducked music, the robot's foley under the first clip, music fading out at the end. Copy: `docs/phase-7/trailer-2-with-sound.mp4`.
- **comfyui idle stop:** IDLE_LINE

## Numbers

| Item | Value |
|---|---|
| ACE-Step 1.5 turbo, 30 s | 12 s cold / 4–10 s warm on the GPU; peak 10.4 GB |
| Stable Audio 3 Small-SFX, 4 × 4 s batch | 4.5 s; peak 2.6 GB alone |
| MMAudio foley, 5 s clip | 12.5–16 s; **peak 42.6 GB** (CLIP + Synchformer + MMAudio in fp16, all resident) |
| Kokoro narration, 20 words | 4–6 s on 8 CPU threads (no GPU) |
| svc-post audio mode | 1–2 s per job; trailer with sound 1.7 s |
| Audio job on disk | 0.4 MB (speech) – 8.4 MB (music: FLAC raw + WAV + MP3 + OGG) |
| Models added | 19.5 GB (`/srv/forge/models` 134 GB); root disk 70 % (two comfyui images, 0.1.0 and 0.1.1) |

## Things that turned out wrong in practice

1. **The comfyui image needs a C compiler** once torch 2.14's native Triton kernels are hit (ACE-Step's Qwen encoder was the first). `build-essential` is now in the image (+0.5 GB); Phil chose this over disabling the native JIT.
2. **`nerdctl compose up -d` reuses an existing container even when the image tag was rebuilt.** After a rebuild the old container must go, or the "new" image never runs; forge-api and the gate scripts now use `--force-recreate` (the container is stateless, all state is on the bind mounts).
3. **MMAudio assumes 25 fps input.** Wan clips are 16 fps, so a 5 s clip came out as 3.24 s of audio until the worker re-encoded it to 25 fps for the sync model. The audio is 44.1 kHz stereo and is muxed back onto the original 16 fps clip.
4. **Peak vs loudness.** SFX and music are peak-normalised to −1 dBFS (one-shots need headroom, not a loudness target) and the loudness is only measured; speech is loudness-normalised to −16 LUFS so narration sits predictably under the −14 dB music duck. ffmpeg reports these statistics on stderr, which the first svc-post build silently ignored (every job read as "silent") — fixed by capturing both streams.
5. **misaki (Kokoro's G2P) pip-installs spaCy's English model at first run**, which cannot work as uid 1000 in a read-only image; it is baked in at build time.
6. **Stable Audio 3's quality controls** (reprompting through Qwen 3.5, the `_base` checkpoints) were left out: the SFX checkpoint with a plain prompt gave clean one-shots in the gate, and the reprompt path would add a 2B LLM to every SFX job.

## Next
Nothing scheduled. Remaining "Later" items in `docs/requirements.md`: voice cloning, MCP server, runtime generation, Kubernetes, multi-GPU.
