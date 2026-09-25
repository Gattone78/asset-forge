#!/usr/bin/env python3
"""svc-audio: text -> speech with Kokoro-82M from local files (no network), then ffmpeg -> WAV (24 kHz mono) + OGG + waveform PNG + sidecar.

    python tts.py --text "…" --out-dir out/ --name <name> [--voice af_heart] [--speed 1.0] [--lang a] [--sidecar-extra extra.json]

Model files come from $KOKORO_MODEL_DIR (kokoro-v1_0.pth, config.json, voices/*.pt) — downloaded once by models/download-audio.sh.
Exit 3 when the result is silent (mean level below -50 dBFS).
"""
import argparse, json, os, re, subprocess, sys, time
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--text", required=True)
ap.add_argument("--out-dir", required=True)
ap.add_argument("--name", required=True)
ap.add_argument("--voice", default="af_heart")
ap.add_argument("--speed", type=float, default=1.0)
ap.add_argument("--lang", default="a", help="Kokoro lang code: a = American English, b = British English")
ap.add_argument("--sidecar-extra")
a = ap.parse_args()
t0 = time.time()

mdir = Path(os.environ.get("KOKORO_MODEL_DIR", "/srv/forge/models/kokoro"))
voice = mdir / "voices" / f"{a.voice}.pt"
if not voice.exists():
    print(f"[tts] unknown voice {a.voice}; available: {', '.join(sorted(p.stem for p in (mdir / 'voices').glob('*.pt')))}", file=sys.stderr)
    sys.exit(2)

import numpy as np, soundfile as sf, torch
from kokoro import KModel, KPipeline
torch.set_num_threads(max(1, os.cpu_count() or 1))
model = KModel(config=str(mdir / "config.json"), model=str(mdir / "kokoro-v1_0.pth")).eval()
pipe = KPipeline(lang_code=a.lang, model=model)
chunks = []
for gs, ps, audio in pipe(a.text, voice=str(voice), speed=a.speed):
    chunks.append(audio.numpy() if hasattr(audio, "numpy") else np.asarray(audio))
    chunks.append(np.zeros(int(24000 * 0.25), dtype=np.float32))   # short gap between sentences
wav = np.concatenate(chunks) if chunks else np.zeros(24000, dtype=np.float32)
t_gen = time.time() - t0

out = Path(a.out_dir); out.mkdir(parents=True, exist_ok=True)
raw = out / f"{a.name}.raw.wav"
sf.write(str(raw), wav, 24000, subtype="PCM_16")

def run(*cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-2000:], file=sys.stderr); sys.exit(1)
    return r.stderr + r.stdout

wav_out, ogg, png = out / f"{a.name}.wav", out / f"{a.name}.ogg", out / f"{a.name}-waveform.png"
# Loudness-normalise speech to -16 LUFS (true peak -1.5 dBTP, EBU R128 single pass), then measure the result.
run("ffmpeg", "-y", "-v", "error", "-i", str(raw), "-af", "loudnorm=I=-16:TP=-1.5:LRA=11,aformat=sample_fmts=s16:sample_rates=24000", str(wav_out))
stats = run("ffmpeg", "-v", "info", "-i", str(wav_out), "-af", "volumedetect,ebur128=peak=true", "-f", "null", "-")
def grab(pattern, default=None):
    m = re.findall(pattern, stats); return float(m[-1]) if m else default   # last match: ebur128 prints running values, then the summary
mean_db = grab(r"mean_volume:\s*(-?[\d.]+)")
peak_db = grab(r"max_volume:\s*(-?[\d.]+)")
lufs = grab(r"\bI:\s*(-?[\d.]+) LUFS")
run("ffmpeg", "-y", "-v", "error", "-i", str(wav_out), "-c:a", "libvorbis", "-q:a", "5", str(ogg))
run("ffmpeg", "-y", "-v", "error", "-i", str(wav_out), "-filter_complex", "showwavespic=s=1024x256:colors=0x2e7d32", "-frames:v", "1", str(png))
(out / "thumb.png").write_bytes(png.read_bytes())
raw.unlink()
dur = len(wav) / 24000
non_silent = mean_db is not None and mean_db > -50 and dur >= 0.3
extra = json.load(open(a.sidecar_extra)) if a.sidecar_extra else {}
sidecar = {"forge_version": "0.1.0", "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **extra,
           "audio": {"kind": "speech", "sample_rate": 24000, "channels": 1, "duration_s": round(dur, 3), "mean_dbfs": mean_db, "peak_dbfs": peak_db, "lufs": lufs, "non_silent": non_silent,
                     "voice": a.voice, "speed": a.speed, "lang": a.lang, "text": a.text},
           "files": {"wav": wav_out.name, "ogg": ogg.name, "waveform": png.name, "thumb": "thumb.png"}, "status": extra.get("status", "review")}
(out / f"{a.name}.sidecar.json").write_text(json.dumps(sidecar, indent=1))
print(f"[tts] {dur:.2f}s of speech, voice {a.voice}, gen {t_gen:.1f}s, mean {mean_db} dBFS, LUFS {lufs}, non_silent={non_silent} ({time.time() - t0:.1f}s)")
sys.exit(0 if non_silent else 3)
