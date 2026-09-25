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

GATE_RESULTS

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

ACCEPTANCE_RESULTS

## Numbers

NUMBERS

## Things that turned out wrong in practice

NOTES

## Next
Nothing scheduled. Remaining "Later" items in `docs/requirements.md`: voice cloning, MCP server, runtime generation, Kubernetes, multi-GPU.
