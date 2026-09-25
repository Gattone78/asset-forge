#!/usr/bin/env node
// Asset Forge post stage orchestrator (runs inside the svc-post container; also works on any host with
// gltf-transform + blender on PATH). No framework: a straight sequence of tool invocations.
//
//   node post.mjs --in raw.glb --out-dir out/ --name meadowbots-creature-robot-a1b2c3 \
//        [--profile profile.yaml] [--height 0.6] [--target-tris 12000] [--material flat-albedo|pbr|vertex] \
//        [--decimate gltf|ingraph|none] [--hires painted.glb] [--yaw-deg 0] [--sidecar-extra extra.json] [--no-fbx]
//
// Steps (each recorded in <name>.post.json and the sidecar's "post" stage):
//   1. inspect input (tri count)
//   2. decimate: gltf-transform weld -> simplify to target (or skip when --decimate ingraph|none)
//   3. Blender: normalize, bake albedo (flat), thumbnail, GLB + FBX export
//   4. gltf-transform meshopt compression -> final .glb (also copies an uncompressed .glb for inspection)
//   5. sidecar json
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const t0 = Date.now();
const log = (...m) => console.log(`[post ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);

// ---- audio mode (Phase 7): ComfyUI's FLAC/WAV -> peak-normalised WAV + OGG (+ MP3 for music) + waveform PNG + loudness + non-silence ----
//   node post.mjs --mode audio --in a.flac[,b.flac,...] --out-dir out/ --name <name> --kind sfx|music|foley [--loop] [--channels mono|stereo]
//        [--sample-rate 44100] [--sidecar-extra extra.json] [--clip clip.mp4]   (--clip: foley, mux the audio into a copy of the clip)
//   Several inputs = variations: <name>-1.wav … ; exit 3 if every variation is silent (mean level below -50 dBFS).
if (args.mode === "audio") {
  const ins = String(req("in")).split(",").map((s) => resolve(s.trim())).filter(Boolean);
  const outDir = resolve(req("out-dir")); const name = req("name"); const kind = args.kind ?? "sfx"; mkdirSync(outDir, { recursive: true });
  const sr = int(args["sample-rate"], 44100); const ch = (args.channels ?? (kind === "sfx" ? "mono" : "stereo")) === "mono" ? 1 : 2;
  const entries = [];
  ins.forEach((inp, i) => {
    const base = ins.length > 1 ? `${name}-${i + 1}` : name;
    const wav = join(outDir, `${base}.wav`), ogg = join(outDir, `${base}.ogg`), mp3 = join(outDir, `${base}.mp3`), png = join(outDir, `${base}-waveform.png`);
    const probe = JSON.parse(run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels,codec_name:format=duration", "-of", "json", inp]));
    const srcDur = Number(probe.format.duration);
    // Loop mode (music): crossfade the last `xf` seconds into the head so the file repeats without a click; the result is `xf` shorter.
    let af = `aresample=${sr},aformat=channel_layouts=${ch === 1 ? "mono" : "stereo"}`;
    let loopSeam = null;
    if (args.loop && srcDur > 4) {
      const xf = Math.min(2, srcDur / 8);
      const looped = join(outDir, `${base}.loop.wav`);
      run("ffmpeg", ["-y", "-v", "error", "-i", inp, "-filter_complex",
        `[0:a]asplit=2[a][b];[a]atrim=0:${(srcDur - xf).toFixed(3)},asetpts=PTS-STARTPTS[head];[b]atrim=${(srcDur - xf).toFixed(3)},asetpts=PTS-STARTPTS[tail];` +
        `[head]asplit=2[h1][h2];[h1]atrim=0:${xf.toFixed(3)},asetpts=PTS-STARTPTS[hstart];[h2]atrim=${xf.toFixed(3)},asetpts=PTS-STARTPTS[hrest];` +
        `[tail][hstart]acrossfade=d=${xf.toFixed(3)}:c1=tri:c2=tri[seam];[seam][hrest]concat=n=2:v=0:a=1[out]`, "-map", "[out]", looped]);
      // Seam check: level difference between the last and first 50 ms (0 = perfectly continuous).
      const tailLvl = level(looped, `atrim=start=${(srcDur - xf - 0.05).toFixed(3)}`), headLvl = level(looped, "atrim=0:0.05");
      loopSeam = Number(Math.abs(tailLvl - headLvl).toFixed(2));
      inp = looped;
    }
    // Peak-normalise to -1 dBFS: measure the source peak, apply the gain, limit for safety.
    const srcPeak = (() => { const m = /max_volume:\s*(-?[\d.]+)/.exec(runBoth("ffmpeg", ["-v", "info", "-i", inp, "-af", "volumedetect", "-f", "null", "-"])); return m ? Number(m[1]) : 0; })();
    const gainDb = Math.max(-40, Math.min(40, -1 - srcPeak));
    run("ffmpeg", ["-y", "-v", "error", "-i", inp, "-af", `${af},volume=${gainDb.toFixed(2)}dB,alimiter=limit=0.89:level=false`, "-c:a", "pcm_s16le", wav]);
    if (inp.endsWith(".loop.wav")) rmSafe(inp);
    const stats = runBoth("ffmpeg", ["-v", "info", "-i", wav, "-af", "volumedetect,ebur128=peak=true", "-f", "null", "-"]);
    const grab = (re) => { const all = [...stats.matchAll(new RegExp(re.source, "g"))]; return all.length ? Number(all[all.length - 1][1]) : null; };   // last match: ebur128 logs running values before its summary
    const meanDb = grab(/mean_volume:\s*(-?[\d.]+)/), peakDb = grab(/max_volume:\s*(-?[\d.]+)/), lufs = grab(/I:\s*(-?[\d.]+) LUFS/);
    run("ffmpeg", ["-y", "-v", "error", "-i", wav, "-c:a", "libvorbis", "-q:a", "5", ogg]);
    if (kind === "music") run("ffmpeg", ["-y", "-v", "error", "-i", wav, "-c:a", "libmp3lame", "-q:a", "2", mp3]);
    run("ffmpeg", ["-y", "-v", "error", "-i", wav, "-filter_complex", "showwavespic=s=1024x256:colors=0x2e7d32", "-frames:v", "1", png]);
    const dur = Number(JSON.parse(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", wav])).format.duration);
    const nonSilent = meanDb !== null && meanDb > -50 && dur >= 0.2;
    entries.push({ index: i + 1, wav: basename(wav), ogg: basename(ogg), mp3: kind === "music" ? basename(mp3) : undefined, waveform: basename(png),
      duration_s: Number(dur.toFixed(3)), sample_rate: sr, channels: ch, source_codec: probe.streams[0]?.codec_name, source_sample_rate: Number(probe.streams[0]?.sample_rate),
      mean_dbfs: meanDb, peak_dbfs: peakDb, lufs, non_silent: nonSilent, loop: !!args.loop, loop_seam_db: loopSeam });
  });
  if (args.clip) {  // foley: copy of the clip with the new audio track (video stream untouched)
    const clipOut = join(outDir, `${name}.mp4`);
    run("ffmpeg", ["-y", "-v", "error", "-i", resolve(args.clip), "-i", join(outDir, entries[0].wav), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", clipOut]);
    run("ffmpeg", ["-y", "-v", "error", "-ss", "1", "-i", clipOut, "-frames:v", "1", join(outDir, `${name}-poster.png`)]);
    copyFileSync(join(outDir, `${name}-poster.png`), join(outDir, "thumb.png"));
  } else copyFileSync(join(outDir, entries[0].waveform), join(outDir, "thumb.png"));
  const extra = args["sidecar-extra"] ? JSON.parse(readFileSync(resolve(args["sidecar-extra"]), "utf8")) : {};
  const anyGood = entries.some((e) => e.non_silent);
  const sidecar = { forge_version: "0.1.0", created_at: new Date().toISOString(), ...extra,
    audio: { kind, count: entries.length, sample_rate: sr, channels: ch, duration_s: entries[0].duration_s, non_silent: anyGood, lufs: entries[0].lufs, peak_dbfs: entries[0].peak_dbfs },
    audios: entries, files: { wav: entries[0].wav, ogg: entries[0].ogg, mp3: entries[0].mp3, waveform: entries[0].waveform, thumb: "thumb.png", ...(args.clip ? { mp4: `${name}.mp4`, poster: `${name}-poster.png` } : {}) },
    status: extra.status || "review" };
  writeFileSync(join(outDir, `${name}.sidecar.json`), JSON.stringify(sidecar, null, 1));
  log(`done: ${entries.length} × ${entries[0].duration_s}s ${kind} @${sr} Hz ${ch}ch, mean ${entries.map((e) => e.mean_dbfs).join("/")} dBFS, non_silent=${anyGood} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(anyGood ? 0 : 3);
}
function level(file, pre) { const s = runBoth("ffmpeg", ["-v", "info", "-i", file, "-af", `${pre},volumedetect`, "-f", "null", "-"]); const m = /mean_volume:\s*(-?[\d.]+)/.exec(s); return m ? Number(m[1]) : -99; }
function rmSafe(p) { try { unlinkSync(p); } catch {} }

// ---- video mode (Phase 6): ComfyUI's mp4 -> web-safe H.264 MP4 + WebM + poster frame + probe + non-blank check ----
//   node post.mjs --mode video --in clip.mp4 --out-dir out/ --name <name> [--sidecar-extra extra.json]
if (args.mode === "video") {
  const inp = resolve(req("in")); const outDir = resolve(req("out-dir")); const name = req("name"); mkdirSync(outDir, { recursive: true });
  const mp4 = join(outDir, `${name}.mp4`), webm = join(outDir, `${name}.webm`), poster = join(outDir, `${name}-poster.png`), thumb = join(outDir, "thumb.png");
  const probe = JSON.parse(run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,nb_frames,codec_name:format=duration", "-of", "json", inp]));
  const st = probe.streams[0]; const fps = eval(st.r_frame_rate); const duration = Number(probe.format.duration);
  run("ffmpeg", ["-y", "-v", "error", "-i", inp, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4]);
  run("ffmpeg", ["-y", "-v", "error", "-i", inp, "-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1", "-an", webm]);
  run("ffmpeg", ["-y", "-v", "error", "-ss", String(Math.max(0, duration / 3)), "-i", inp, "-frames:v", "1", poster]);
  copyFileSync(poster, thumb);
  // Non-blank + motion check: luma stddev of the first, middle and last frames, and mean |diff| first vs last.
  const stats = run("ffmpeg", ["-v", "error", "-i", inp, "-vf", "select='eq(n\\,0)+eq(n\\,%d)+eq(n\\,%d)',signalstats,metadata=print:file=-".replace("%d", String(Math.max(1, Math.floor(Number(st.nb_frames) / 2)))).replace("%d", String(Math.max(2, Number(st.nb_frames) - 1))), "-vsync", "0", "-f", "null", "-"]);
  const yavg = [...stats.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  const ydif = [...stats.matchAll(/lavfi\.signalstats\.YDIF=([\d.]+)/g)].map((m) => Number(m[1]));
  const ymin = [...stats.matchAll(/lavfi\.signalstats\.YMIN=([\d.]+)/g)].map((m) => Number(m[1]));
  const ymax = [...stats.matchAll(/lavfi\.signalstats\.YMAX=([\d.]+)/g)].map((m) => Number(m[1]));
  const contrast = ymax.map((v, i) => v - (ymin[i] ?? 0));
  const nonBlank = contrast.every((c) => c > 40) && (Math.max(...yavg) - Math.min(...yavg) > 0.5 || ydif.some((d) => d > 0.5));
  const extra = args["sidecar-extra"] ? JSON.parse(readFileSync(resolve(args["sidecar-extra"]), "utf8")) : {};
  const sidecar = {
    forge_version: "0.1.0", created_at: new Date().toISOString(), ...extra,
    video: { width: st.width, height: st.height, fps, duration_s: Number(duration.toFixed(3)), frames: Number(st.nb_frames), source_codec: st.codec_name,
             non_blank: nonBlank, frame_contrast: contrast, frame_luma_avg: yavg, frame_diff: ydif },
    files: { mp4: basename(mp4), webm: basename(webm), poster: basename(poster), thumb: "thumb.png" },
    status: extra.status || "review",
  };
  writeFileSync(join(outDir, `${name}.sidecar.json`), JSON.stringify(sidecar, null, 1));
  log(`done: ${st.width}x${st.height} ${fps} fps ${duration.toFixed(2)} s, ${(statSync(mp4).size / 1e6).toFixed(2)} MB mp4, ${(statSync(webm).size / 1e6).toFixed(2)} MB webm, non_blank=${nonBlank} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(nonBlank ? 0 : 3);
}

// ---- trailer mode (Phase 6, optional): title card + clips with crossfades -> one MP4 ----
//   node post.mjs --mode trailer --clips a.mp4,b.mp4,c.mp4 --out-dir out/ --name <name> [--title "Meadowbots"] [--subtitle "…"] [--xfade 0.5] [--card 2]
//        [--music music.wav] [--music-db -14] [--narration a.wav@1.5,b.wav@7]  (Phase 7: AAC track — clip audio if any, music ducked under narration)
if (args.mode === "trailer") {
  const clips = String(req("clips")).split(",").map((c) => resolve(c.trim())).filter(Boolean);
  const outDir = resolve(req("out-dir")); const name = req("name"); mkdirSync(outDir, { recursive: true });
  const xf = num(args.xfade, 0.5), card = num(args.card, 2.0), title = args.title ?? "", subtitle = args.subtitle ?? "";
  const music = args.music ? resolve(args.music) : null, musicDb = num(args["music-db"], -14);
  const narr = args.narration ? String(args.narration).split(",").map((s) => { const [f, at] = s.split("@"); return { file: resolve(f.trim()), at: Number(at ?? 0) }; }) : [];
  const hasAudio = (f) => { try { return JSON.parse(run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "json", f])).streams.length > 0; } catch { return false; } };
  const first = JSON.parse(run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", clips[0]])).streams[0];
  const W = first.width, H = first.height, fps = eval(first.r_frame_rate);
  const durs = clips.map((c) => Number(JSON.parse(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", c])).format.duration));
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
  const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
  // Inputs: 0 = title card (lavfi colour source), 1..n = clips, all normalised to the first clip's size/fps.
  const inputs = ["-f", "lavfi", "-t", String(card), "-i", `color=c=0x2e7d32:s=${W}x${H}:r=${fps}`];
  for (const c of clips) inputs.push("-i", c);
  let fc = title ? `[0:v]drawtext=fontfile=${font}:text='${esc(title)}':fontcolor=white:fontsize=${Math.round(H / 8)}:x=(w-text_w)/2:y=(h-text_h)/2-${Math.round(H / 20)}` +
    (subtitle ? `,drawtext=fontfile=${font}:text='${esc(subtitle)}':fontcolor=white:fontsize=${Math.round(H / 20)}:x=(w-text_w)/2:y=(h/2)+${Math.round(H / 12)}` : "") + `,format=yuv420p[v0];` : `[0:v]format=yuv420p[v0];`;
  const segs = ["[v0]"]; const segDur = [card];
  clips.forEach((_, i) => { fc += `[${i + 1}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${fps},format=yuv420p[v${i + 1}];`; segs.push(`[v${i + 1}]`); segDur.push(durs[i]); });
  // Chain xfade: offset = accumulated duration - xf each time.
  let acc = segDur[0]; let prev = segs[0];
  for (let i = 1; i < segs.length; i++) {
    const out = i === segs.length - 1 ? "[vout]" : `[x${i}]`;
    fc += `${prev}${segs[i]}xfade=transition=fade:duration=${xf}:offset=${(acc - xf).toFixed(3)}${out};`;
    acc += segDur[i] - xf; prev = out;
  }
  // ---- audio (Phase 7): clip sound (or silence) concatenated with matching crossfades, music under it, narration on top with ducking ----
  const total = segDur.reduce((a, b) => a + b, 0) - xf * (segDur.length - 1);
  const withSound = !!music || narr.length > 0 || clips.some(hasAudio);
  let maps = ["-map", "[vout]"];
  const audioArgs = withSound ? ["-c:a", "aac", "-b:a", "160k"] : ["-an"];
  if (withSound) {
    const aIn = inputs.filter((x) => x === "-i").length;   // index of the first extra audio input (card + clips so far)
    let extraInputs = [];
    let idx = aIn;
    // one audio stream per segment: the clip's own track or silence, trimmed to the segment length
    let ac = "";
    const aSegs = [];
    segDur.forEach((d, i) => {
      if (i > 0 && hasAudio(clips[i - 1])) ac += `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${d.toFixed(3)},apad=whole_dur=${d.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`;
      else ac += `anullsrc=r=48000:cl=stereo,atrim=0:${d.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`;   // one silent source per silent segment
      aSegs.push(`[a${i}]`);
    });
    let prevA = aSegs[0];
    for (let i = 1; i < aSegs.length; i++) { const o = i === aSegs.length - 1 ? "[clipmix]" : `[ax${i}]`; ac += `${prevA}${aSegs[i]}acrossfade=d=${xf}:c1=tri:c2=tri${o};`; prevA = o; }
    if (aSegs.length === 1) ac += `${aSegs[0]}acopy[clipmix];`;
    let layers = ["[clipmix]"];
    if (music) {
      extraInputs.push("-i", music); const mi = idx++;
      ac += `[${mi}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${total.toFixed(3)},apad=whole_dur=${total.toFixed(3)},volume=${musicDb}dB,afade=t=in:d=0.5,afade=t=out:st=${Math.max(0, total - 2).toFixed(3)}:d=2[music];`;
      if (narr.length) {
        // duck the music under narration: sidechain on the summed narration
        const nIdx = narr.map((n) => { extraInputs.push("-i", n.file); return idx++; });
        ac += nIdx.map((i, k) => `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(narr[k].at * 1000)}|${Math.round(narr[k].at * 1000)},apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)}[n${k}];`).join("");
        ac += nIdx.map((_, k) => `[n${k}]`).join("") + `amix=inputs=${nIdx.length}:normalize=0[narr];[narr]asplit=2[narrA][narrB];`;
        ac += `[music][narrA]sidechaincompress=threshold=0.02:ratio=8:attack=50:release=600:makeup=1[ducked];`;
        layers.push("[ducked]", "[narrB]");
      } else layers.push("[music]");
    } else if (narr.length) {
      const nIdx = narr.map((n) => { extraInputs.push("-i", n.file); return idx++; });
      ac += nIdx.map((i, k) => `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(narr[k].at * 1000)}|${Math.round(narr[k].at * 1000)},apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)}[n${k}];`).join("");
      ac += nIdx.map((_, k) => `[n${k}]`).join("") + `amix=inputs=${nIdx.length}:normalize=0[narr];`; layers.push("[narr]");
    }
    ac += layers.join("") + `amix=inputs=${layers.length}:normalize=0:dropout_transition=0,alimiter=limit=0.89:level=false[aout]`;
    inputs.push(...extraInputs);
    fc += ";" + ac;
    maps = ["-map", "[vout]", "-map", "[aout]"];
  }
  fc = fc.replace(/;;/g, ";").replace(/;$/, "");
  const out = join(outDir, `${name}.mp4`);
  run("ffmpeg", ["-y", "-v", "error", ...inputs, "-filter_complex", fc, ...maps, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", ...audioArgs, out]);
  run("ffmpeg", ["-y", "-v", "error", "-ss", String(Math.min(1, card / 2)), "-i", out, "-frames:v", "1", join(outDir, `${name}-poster.png`)]);
  copyFileSync(join(outDir, `${name}-poster.png`), join(outDir, "thumb.png"));
  const totalOut = Number(JSON.parse(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", out])).format.duration);
  const sidecar = { forge_version: "0.1.0", created_at: new Date().toISOString(), trailer: { clips: clips.map((c) => basename(c)), title, subtitle, card_s: card, xfade_s: xf, width: W, height: H, fps, duration_s: Number(totalOut.toFixed(3)),
      audio: withSound ? { music: music ? basename(music) : null, music_db: music ? musicDb : null, narration: narr.map((n) => ({ file: basename(n.file), at_s: n.at })), clip_audio: clips.map(hasAudio), codec: "aac" } : null },
    files: { mp4: basename(out), poster: `${name}-poster.png`, thumb: "thumb.png" }, status: "review" };
  writeFileSync(join(outDir, `${name}.sidecar.json`), JSON.stringify(sidecar, null, 1));
  log(`trailer: ${clips.length} clips + card -> ${basename(out)} ${W}x${H} ${totalOut.toFixed(2)} s, ${withSound ? "AAC audio (" + [music ? "music" : null, narr.length ? narr.length + " narration" : null, clips.some(hasAudio) ? "clip audio" : null].filter(Boolean).join(", ") + ")" : "no audio"} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(0);
}

// ---- rig mode: merge UniRig's FBX with the finished asset -> <name>.rigged.glb / .rigged.fbx, sidecar updated ----
//   node post.mjs --mode rig --rigged raw/rigged.fbx --textured out/<name>.blender.glb --out-dir out/ --name <name>
//        [--height 0.6] [--yaw-deg 0] [--template articulationxl] [--compression meshopt|none]
if (args.mode === "rig") {
  const outDir = resolve(req("out-dir")); const name = req("name"); mkdirSync(outDir, { recursive: true });
  const glbB = join(outDir, `${name}.rigged.blender.glb`), fbxOut = join(outDir, `${name}.rigged.fbx`), rep = join(outDir, `${name}.rig.json`);
  const bargs = ["-b", "--python-exit-code", "1", "--python", join(here, "blender", "forge_post.py"), "--", "rigmerge",
    "--rigged", resolve(req("rigged")), "--out", glbB, "--fbx", fbxOut, "--report", rep, "--thumb", join(outDir, "thumb-rigged.png"),
    "--height", String(args.height ?? 0.6), "--yaw-deg", String(args["yaw-deg"] ?? 0)];
  if (args.textured) bargs.push("--textured", resolve(args.textured));
  run("blender", bargs);
  const r = JSON.parse(readFileSync(rep, "utf8"));
  const finalGlb = join(outDir, `${name}.rigged.glb`);
  if ((args.compression ?? "meshopt") === "meshopt") run("gltf-transform", ["meshopt", glbB, finalGlb, "--level", "medium"]);
  else copyFileSync(glbB, finalGlb);
  const g = inspect(finalGlb);
  // Update the existing sidecar in place.
  const scPath = join(outDir, `${name}.sidecar.json`);
  const sc = existsSync(scPath) ? JSON.parse(readFileSync(scPath, "utf8")) : { stages: [], files: {} };
  sc.stages = [...(sc.stages || []).filter((s) => s.stage !== "rig"), {
    stage: "rig", model: "VAST-AI/UniRig", source: "ComfyUI-UniRig (comfy-env isolated) UniRigAutoRig", template: args.template ?? "articulationxl",
    seed: null, bones: r.bones, bone_names: r.bone_names, skeleton_root: "Armature", license: "MIT",
    tool: `blender@${r.blender}`, ops: r.ops.map((o) => o.op),
  }];
  sc.rigged = true;
  sc.files = { ...(sc.files || {}), rigged_glb: basename(finalGlb), rigged_fbx: basename(fbxOut), thumb_rigged: "thumb-rigged.png" };
  sc.geometry_rigged = { tris: g.tris, verts: g.verts, height_m: r.after.height_m, bbox_min: r.after.bbox_min, bbox_max: r.after.bbox_max };
  writeFileSync(scPath, JSON.stringify(sc, null, 1));
  log(`done: ${r.bones} bones, ${g.tris} tris, ${(statSync(finalGlb).size / 1e6).toFixed(2)} MB -> ${basename(finalGlb)}, ${basename(fbxOut)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(0);
}

const inp = resolve(req("in"));
const outDir = resolve(req("out-dir"));
const name = req("name");
mkdirSync(outDir, { recursive: true });

// Profile (minimal YAML reader: flat keys and one level of nesting is all we need).
const profile = args.profile ? readProfile(resolve(args.profile)) : {};
const mesh = profile.mesh || {};
const height = num(args.height, mesh.target_height_m, 0.6);
const targetTris = int(args["target-tris"], mesh.target_tris, 12000);
const maxTris = int(mesh.max_tris, 20000);
const material = args.material || mesh.material || "flat-albedo";
const maxTexture = int(args["bake-size"], mesh.max_texture, 2048);
const compression = args.compression || mesh.compression || "meshopt";
const decimate = args.decimate || "gltf";
const yaw = num(args["yaw-deg"], mesh.forward_yaw_deg, 0);
const normalizeOn = args["no-normalize"] ? false : (mesh.normalize !== false);

const report = { name, input: basename(inp), settings: { height, targetTris, maxTris, material, maxTexture, compression, decimate, yaw, normalize: normalizeOn }, steps: [] };

// 1. inspect
const before = inspect(inp);
report.steps.push({ step: "inspect", tris: before.tris, verts: before.verts, bytes: statSync(inp).size });
log(`input ${basename(inp)}: ${before.tris} tris, ${(statSync(inp).size / 1e6).toFixed(1)} MB`);

// 2. decimate (gltf-transform weld + simplify) — ratio chosen from the tri count; meshopt's simplifier is
//    error-bounded, so we loosen the error until the target is reached (a few iterations at most).
let stage = inp;
let blenderTarget = 0;
if (decimate === "gltf" && before.tris > targetTris) {
  const welded = join(outDir, `${name}.welded.glb`);
  run("gltf-transform", ["weld", inp, welded]);
  let error = num(args["simplify-error"], 0.001);
  let out = join(outDir, `${name}.simplified.glb`);
  let got = null;
  for (let i = 0; i < 6; i++) {
    const ratio = Math.max(0.0001, targetTris / before.tris);
    run("gltf-transform", ["simplify", welded, out, "--ratio", String(ratio), "--error", String(error), ...(args["lock-border"] ? ["--lock-border"] : [])]);
    got = inspect(out);
    log(`simplify ratio=${ratio.toFixed(5)} error=${error} -> ${got.tris} tris`);
    if (got.tris <= maxTris) break;
    error *= 3;
  }
  report.steps.push({ step: "simplify", tool: "gltf-transform", version: toolVersion("gltf-transform"), ratio: targetTris / before.tris, error, tris: got.tris, verts: got.verts, reached: got.tris <= maxTris });
  stage = out;
  if (got.tris > maxTris) { log(`gltf-transform simplify stalled at ${got.tris} tris; falling back to Blender collapse decimate`); blenderTarget = targetTris; }
} else if (decimate === "blender" && before.tris > targetTris) {
  blenderTarget = targetTris;
  report.steps.push({ step: "simplify", tool: "blender-collapse", target: targetTris });
} else {
  report.steps.push({ step: "simplify", skipped: true, reason: decimate === "gltf" ? "already under target" : `decimate=${decimate}` });
}

// 3. Blender
const glbBlender = join(outDir, `${name}.blender.glb`);
const fbx = args["no-fbx"] ? null : join(outDir, `${name}.fbx`);
const thumb = join(outDir, "thumb.png");
const breport = join(outDir, `${name}.blender.json`);
// --python-exit-code: without it Blender exits 0 even when the script raises.
const bargs = ["-b", "--python-exit-code", "1", "--python", join(here, "blender", "forge_post.py"), "--", "process",
  "--in", stage, "--out", glbBlender, "--thumb", thumb, "--report", breport,
  "--height", String(height), "--yaw-deg", String(yaw), "--material", material, "--bake-size", String(maxTexture)];
if (fbx) bargs.push("--fbx", fbx);
if (blenderTarget) bargs.push("--target-tris", String(blenderTarget));
if (!normalizeOn) bargs.push("--no-normalize");
if (args.hires) bargs.push("--hires", resolve(args.hires));
run("blender", bargs);
const b = JSON.parse(readFileSync(breport, "utf8"));
report.steps.push({ step: "blender", version: b.blender, ops: b.ops, after: b.after, seconds: b.seconds });

// 4. compress
const finalGlb = join(outDir, `${name}.glb`);
if (compression === "meshopt") {
  run("gltf-transform", ["meshopt", glbBlender, finalGlb, "--level", "medium"]);
} else if (compression === "draco") {
  run("gltf-transform", ["draco", glbBlender, finalGlb]);
} else {
  copyFileSync(glbBlender, finalGlb);
}
const after = inspect(finalGlb);
report.steps.push({ step: "compress", method: compression, tris: after.tris, verts: after.verts, bytes: statSync(finalGlb).size, textures: after.textures });
log(`final ${basename(finalGlb)}: ${after.tris} tris, ${(statSync(finalGlb).size / 1e6).toFixed(2)} MB, textures ${JSON.stringify(after.textures)}`);

// 5. sidecar (partial: the post + geometry blocks; forge-api merges request/model stages)
const extra = args["sidecar-extra"] ? JSON.parse(readFileSync(resolve(args["sidecar-extra"]), "utf8")) : {};
const sidecar = {
  forge_version: "0.1.0",
  created_at: new Date().toISOString(),
  ...extra,
  profile_hash: args.profile ? sha256(readFileSync(resolve(args.profile))) : undefined,
  stages: [...(extra.stages || []), {
    stage: "post", tool: `gltf-transform@${toolVersion("gltf-transform")}+blender@${b.blender}`,
    ops: [...(decimate === "gltf" && before.tris > targetTris ? ["weld", "simplify"] : []), ...b.ops.map(o => o.op), compression],
    tris_before: before.tris, tris_after: after.tris,
  }],
  geometry: { tris: after.tris, verts: after.verts, height_m: b.after.height_m, up_axis: "Y", forward: "-Z", origin: "feet",
    bbox_min: b.after.bbox_min, bbox_max: b.after.bbox_max },
  textures: after.textures,
  files: { glb: basename(finalGlb), fbx: fbx ? basename(fbx) : null, thumb: "thumb.png" },
  rigged: false,
  status: extra.status || "review",
};
writeFileSync(join(outDir, `${name}.sidecar.json`), JSON.stringify(sidecar, null, 1));
report.seconds = (Date.now() - t0) / 1000;
writeFileSync(join(outDir, `${name}.post.json`), JSON.stringify(report, null, 1));
log(`done in ${report.seconds.toFixed(1)}s`);

// ---- helpers ----
function parseArgs(a) {
  const o = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith("--")) {
      const k = a[i].slice(2);
      if (i + 1 < a.length && !a[i + 1].startsWith("--")) o[k] = a[++i]; else o[k] = true;
    }
  }
  return o;
}
function req(k) { if (!args[k]) { console.error(`missing --${k}`); process.exit(2); } return args[k]; }
function num(...v) { for (const x of v) if (x !== undefined && x !== null && x !== "") return Number(x); return undefined; }
function int(...v) { const n = num(...v); return n === undefined ? undefined : Math.round(n); }
function run(cmd, cargs) {
  const t = Date.now();
  const r = spawnSync(cmd, cargs, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 << 20 });
  const tail = (r.stdout || "").split("\n").filter(l => l.includes("[forge_post]") || l.includes("error") || l.includes("Error")).slice(-6).join("\n");
  log(`${cmd} ${cargs[0]} (${((Date.now() - t) / 1000).toFixed(1)}s)${tail ? "\n" + tail : ""}`);
  if (r.status !== 0) { console.error(r.stdout, r.stderr); throw new Error(`${cmd} ${cargs[0]} failed (${r.status})`); }
  return r.stdout;
}
// ffmpeg writes filter statistics (volumedetect, ebur128) to stderr: this variant returns both streams.
function runBoth(cmd, cargs) {
  const r = spawnSync(cmd, cargs, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) { console.error(r.stdout, r.stderr); throw new Error(`${cmd} ${cargs[0]} failed (${r.status})`); }
  return (r.stdout || "") + (r.stderr || "");
}
function inspect(glb) {
  // gltf-transform inspect --format json is not stable across versions; parse the GLB header instead.
  const buf = readFileSync(glb);
  const jsonLen = buf.readUInt32LE(12);
  const g = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
  let tris = 0, verts = 0;
  for (const m of g.meshes || []) for (const p of m.primitives || []) {
    const mode = p.mode ?? 4;
    const idx = p.indices !== undefined ? g.accessors[p.indices].count : g.accessors[p.attributes.POSITION].count;
    if (mode === 4) tris += idx / 3; else if (mode === 5 || mode === 6) tris += Math.max(0, idx - 2);
    verts += g.accessors[p.attributes.POSITION].count;
  }
  const textures = (g.images || []).map((im, i) => ({ name: im.name || `image_${i}`, mimeType: im.mimeType }));
  return { tris: Math.round(tris), verts, textures, extensions: g.extensionsUsed || [] };
}
function toolVersion(cmd) { try { return execFileSync(cmd, ["--version"], { encoding: "utf8" }).trim().split(/\s+/).pop(); } catch { return "?"; } }
function sha256(b) { return createHash("sha256").update(b).digest("hex"); }
function readProfile(p) {
  // Tiny YAML subset: `key: value`, `section:` + two-space-indented `key: value`, `[a, b]` lists, quoted strings.
  const out = {}; let section = null;
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const m = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, indent, key, rest] = m;
    if (!indent) { if (rest === "") { section = key; out[key] = {}; } else { section = null; out[key] = parseVal(rest); } }
    else if (section) out[section][key] = parseVal(rest);
  }
  return out;
}
function parseVal(s) {
  s = s.trim();
  if (/^".*"$/.test(s) || /^'.*'$/.test(s)) return s.slice(1, -1);
  if (/^\[.*\]$/.test(s)) return s.slice(1, -1).split(",").map(x => parseVal(x));
  if (s === "true") return true; if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}
