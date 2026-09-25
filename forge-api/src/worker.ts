// Single worker loop: one job at a time, stages refs -> 3d -> post. Keeps comfyui up between jobs and
// stops it after FORGE_GPU_IDLE_TIMEOUT with nothing queued.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import sharp from "sharp";
import { config, paths } from "./config.ts";
import * as comfy from "./comfy.ts";
import { getJob, nextQueued, updateJob, type Job } from "./db.ts";
import { loadProfile, type Profile } from "./profiles.ts";
import { loadWorkflow, setAll, setInput, type Workflow } from "./workflows.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let idleTimer: NodeJS.Timeout | null = null;
let busy = false;
export const gpu = { lastStop: null as null | comfy.VramState, idleStopAt: null as null | string };

export function startWorker(): void {
  // A restart while comfyui is up must not leave it running forever: arm the idle timer at startup.
  comfy.isUp().then((up) => { if (up && !nextQueued()) { console.log("[idle] comfyui already up at startup; idle timer armed"); scheduleIdleStop(); } }).catch(() => {});
  (async () => {
    for (;;) {
      try {
        const job = nextQueued();
        if (job) { cancelIdle(); busy = true; await runJob(job); busy = false; scheduleIdleStop(); }
      } catch (e) { console.error("worker loop error", e); busy = false; }
      await sleep(2000);
    }
  })();
}
export function isBusy(): boolean { return busy; }
function cancelIdle(): void { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; gpu.idleStopAt = null; }
function scheduleIdleStop(): void {
  cancelIdle();
  gpu.idleStopAt = new Date(Date.now() + config.idleTimeoutSec * 1000).toISOString();
  idleTimer = setTimeout(async () => {
    idleTimer = null; gpu.idleStopAt = null;
    if (busy || nextQueued()) return;
    try { if (await comfy.isUp()) gpu.lastStop = await comfy.stop((m) => console.log("[idle]", m)); }
    catch (e) { console.error("idle stop failed", e); }
  }, config.idleTimeoutSec * 1000);
}

function jobDir(id: string) { return join(paths.jobs, id); }
function logger(id: string) {
  const f = join(jobDir(id), "log.txt");
  return (m: string) => { const line = `[${new Date().toISOString()}] ${m}`; appendFileSync(f, line + "\n"); console.log(`[${id.slice(0, 8)}]`, m); };
}
const STOP = new Set(["a", "an", "the", "with", "of", "and", "in", "on", "at", "to", "for", "very", "big", "small", "cute", "friendly", "round", "little"]);
/** "<game>-<type>-<slug>-<jobshort>" per req §8: up to 3 content words, e.g. "garden-robot-eyes". */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w)).slice(0, 3).join("-") || "asset";

async function runJob(job0: Job): Promise<void> {
  const id = job0.id; const req = job0.request;
  const dir = jobDir(id);
  for (const d of ["refs", "raw", "out"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "request.json"), JSON.stringify(req, null, 1));
  const log = logger(id);
  const t0 = Date.now();
  const set = (stage: string, progress: number) => updateJob(id, { status: "running", stage, progress });
  try {
    const profile = loadProfile(req.profile);
    log(`start: ${req.type} "${req.prompt}" profile=${profile.name} seed=${req.seed} views=${req.views ?? profile.image.views ?? "front"}`);
    if (req.restart_comfy && await comfy.isUp()) { log("rerun with the same seed: restarting comfyui for a cold, reproducible run"); await comfy.stop(log); }
    if (req.type === "trailer") {
      // ---- trailer (Phase 6): CPU only, no GPU; stitches finished video jobs ----
      set("trailer", 0.2);
      const name = `${profile.game}-trailer-${slug(req.trailer?.title ?? "trailer")}-${id.slice(0, 6)}`;
      const files = await stageTrailer(id, req, profile, name, log);
      updateJob(id, { status: "review", stage: "review", progress: 1, result: { name, files, seconds: (Date.now() - t0) / 1000 } });
      log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${name}`);
      return;
    }

    if (req.type === "speech") {
      // ---- speech (Phase 7): Kokoro in svc-audio, CPU only, never starts comfyui ----
      set("speech", 0.2);
      const name = `${profile.game}-speech-${slug(req.prompt)}-${id.slice(0, 6)}`;
      const res = await stageSpeech(id, req, profile, name, log);
      updateJob(id, { status: "review", stage: "review", progress: 1, result: { name, files: res.files, audio: res.audio, seconds: (Date.now() - t0) / 1000 } });
      log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${name}`);
      return;
    }

    set("starting", 0);
    await comfy.ensureUp(log);

    if (req.type === "sfx" || req.type === "music" || req.type === "foley") {
      // ---- audio (Phase 7): Stable Audio 3 (sfx), ACE-Step 1.5 (music) or MMAudio (foley from a clip), then ffmpeg post ----
      set(req.type, 0.1);
      const name = `${profile.game}-${req.type}-${slug(req.prompt || "clip")}-${id.slice(0, 6)}`;
      const res = await stageAudio(id, req, profile, name, log, (p) => set(req.type, 0.1 + 0.8 * p));
      updateJob(id, { status: "review", stage: "review", progress: 1, result: { name, files: res.files, audio: res.audio, seconds: (Date.now() - t0) / 1000 } });
      log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${name}`);
      return;
    }

    if (req.type === "video") {
      // ---- video (Phase 6): Wan 2.2 text-to-video or image-to-video, then ffmpeg post ----
      set("video", 0.1);
      const name = `${profile.game}-video-${slug(req.prompt)}-${id.slice(0, 6)}`;
      const res = await stageVideo(id, req, profile, name, log, (p) => set("video", 0.1 + 0.8 * p));
      updateJob(id, { status: "review", stage: "review", progress: 1, result: { name, files: res.files, video: res.video, seconds: (Date.now() - t0) / 1000 } });
      log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${name}`);
      return;
    }

    if (req.type === "image") {
      // ---- 2D job (Phase 5): sprites / textures / tiles, no 3D stages ----
      set("image", 0.1);
      const name = `${profile.game}-image-${slug(req.prompt)}-${id.slice(0, 6)}`;
      const res = await stageImage(id, req, profile, name, log);
      updateJob(id, { status: "review", stage: "review", progress: 1, result: { name, files: res.files, images: res.images, seconds: (Date.now() - t0) / 1000 } });
      log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${name}`);
      return;
    }

    // ---- stage 1: reference images ----
    set("refs", 0.05);
    const views = req.views ?? profile.image.views ?? "front";
    const refs = await stageRefs(id, req, profile, views, log);
    set("refs", 0.3);

    // ---- stage 2: image -> 3D ----
    const raw = await stage3d(id, req, profile, refs, log, (p) => set("3d", 0.3 + 0.5 * p));
    set("post", 0.8);

    // ---- stage 3: post ----
    const name = `${profile.game}-${req.type}-${slug(req.prompt)}-${id.slice(0, 6)}`;
    let out = await stagePost(id, req, profile, refs, raw, name, log);
    // ---- stage 4 (opt-in): auto-rig ----
    if (req.rig) {
      set("rig", 0.9);
      out = await stageRig(id, req, profile, name, log);
    }
    const result = { name, files: out.files, refs: refs.files, raw: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, basename(v)])), rigged: !!req.rig, seconds: (Date.now() - t0) / 1000 };
    updateJob(id, { status: "review", stage: "review", progress: 1, result });
    log(`done in ${result.seconds.toFixed(0)}s -> ${name}`);
  } catch (e: any) {
    log("FAILED: " + (e?.stack ?? e));
    updateJob(id, { status: "failed", stage: "failed", error: String(e?.message ?? e) });
  }
}

interface Refs { front: string; side?: string; back?: string; files: string[]; candidates: any[] }

async function stageRefs(id: string, req: Job["request"], profile: Profile, views: string, log: (m: string) => void): Promise<Refs> {
  const wf = loadWorkflow("image-refs.json");
  const basePrompt = `${req.prompt}, ${profile.style_prompt}`;
  const genView = async (view: string, count: number, seed: number): Promise<string[]> => {
    const w: Workflow = structuredClone(wf);
    const viewText = view === "front" ? "front view, facing the camera" : view === "side" ? "side view, profile, facing left" : "back view, seen from behind";
    setInput(w, "Prompt", "text", `${basePrompt}, ${viewText}`);
    setInput(w, "Latent", "width", profile.image.size); setInput(w, "Latent", "height", profile.image.size); setInput(w, "Latent", "batch_size", count);
    setInput(w, "Sampler", "seed", seed); setInput(w, "Sampler", "steps", profile.image.steps);
    setInput(w, "Save", "filename_prefix", `jobs/${id}/refs/${view}`);
    const r = await comfy.run(w, () => {});
    const imgs = Object.values(r.outputs).flatMap((o) => o.images ?? []).map((i: any) => join(config.comfyOutput, i.subfolder, i.filename));
    log(`refs/${view}: ${imgs.length} image(s) in ${r.seconds.toFixed(1)}s (seed ${seed})`);
    return imgs;
  };
  const fronts = await genView("front", req.count, req.seed);
  // Pick by heuristic (req §3): largest subject bounding box, most centred.
  const candidates = [] as any[];
  for (const f of fronts) {
    const s = await subjectScore(f);
    candidates.push({ file: basename(f), ...s });
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = join(config.comfyOutput, `jobs/${id}/refs`, candidates[0].file);
  log(`picked ${candidates[0].file} (score ${candidates[0].score.toFixed(3)}, bbox ${candidates[0].bboxFrac.toFixed(2)}, centre offset ${candidates[0].centreOffset.toFixed(3)})`);
  const refs: Refs = { front: best, files: [], candidates };
  if (views === "multi") {
    refs.side = (await genView("side", 1, req.seed))[0];
    refs.back = (await genView("back", 1, req.seed))[0];
  }
  // Move everything into the job folder and stage the chosen refs for LoadImage.
  const refDir = join(jobDir(id), "refs");
  const inDir = join(config.comfyInput, "jobs", id); mkdirSync(inDir, { recursive: true });
  const srcDir = join(config.comfyOutput, `jobs/${id}/refs`);
  for (const f of readdirSync(srcDir)) { renameSync(join(srcDir, f), join(refDir, f)); refs.files.push(f); }
  const stagePath = (p: string | undefined, view: string) => { if (!p) return undefined; const dst = join(inDir, `ref-${view}.png`); copyFileSync(join(refDir, basename(p)), dst); return `jobs/${id}/ref-${view}.png`; };
  refs.front = stagePath(refs.front, "front") as string;
  refs.side = stagePath(refs.side, "side"); refs.back = stagePath(refs.back, "back");
  writeFileSync(join(refDir, "candidates.json"), JSON.stringify({ seed: req.seed, views, picked: candidates[0].file, candidates }, null, 1));
  return refs;
}

/** Subject bounding box against the plain background (estimated from the image border, since FLUX's
 *  "white" is not pure white); score = bbox area * (1 - centre offset). Rows/columns count as subject
 *  only when enough pixels differ, so film grain and soft shadows do not inflate the box. */
async function subjectScore(file: string): Promise<{ score: number; bboxFrac: number; centreOffset: number }> {
  const img = sharp(file).removeAlpha().resize(256, 256, { fit: "fill" });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  const px = (x: number, y: number) => [data[(y * w + x) * ch], data[(y * w + x) * ch + 1], data[(y * w + x) * ch + 2]];
  const border: number[][] = [];
  for (let i = 0; i < w; i += 4) { border.push(px(i, 0), px(i, h - 1)); }
  for (let i = 0; i < h; i += 4) { border.push(px(0, i), px(w - 1, i)); }
  const med = (k: number) => border.map((p) => p[k]).sort((a, b) => a - b)[Math.floor(border.length / 2)];
  const bg = [med(0), med(1), med(2)];
  const isSubject = (x: number, y: number) => { const p = px(x, y); return Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 60; };
  const rows = new Array(h).fill(0), cols = new Array(w).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (isSubject(x, y)) { rows[y]++; cols[x]++; }
  const minC = 3;
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let x = 0; x < w; x++) if (cols[x] >= minC) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
  for (let y = 0; y < h; y++) if (rows[y] >= minC) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (maxX < 0) return { score: 0, bboxFrac: 0, centreOffset: 1 };
  const bw = (maxX - minX + 1) / w, bh = (maxY - minY + 1) / h;
  const cx = (minX + maxX) / 2 / w - 0.5, cy = (minY + maxY) / 2 / h - 0.5;
  const centreOffset = Math.hypot(cx, cy);
  const bboxFrac = bw * bh;
  return { score: bboxFrac * (1 - centreOffset), bboxFrac, centreOffset };
}

async function stage3d(id: string, req: Job["request"], profile: Profile, refs: Refs, log: (m: string) => void, onP: (p: number) => void): Promise<Record<string, string>> {
  const multi = !!(refs.side && refs.back);
  const wf = loadWorkflow(multi ? "image-to-3d-multi.json" : "image-to-3d.json");
  const seed = req.seed + 1;
  if (multi) { setInput(wf, "Reference image front", "image", refs.front); setInput(wf, "Reference image side", "image", refs.side); setInput(wf, "Reference image back", "image", refs.back); }
  else setInput(wf, "Reference image", "image", refs.front);
  setAll(wf, ["Structure sampler", "Shape sampler", "Upsampled shape sampler", "Texture sampler"], "seed", seed);
  setInput(wf, "Upsample stage", "target_resolution", profile.mesh.resolution ?? 1024);
  setInput(wf, "Save raw", "filename_prefix", `jobs/${id}/raw/raw`);
  setInput(wf, "Save painted", "filename_prefix", `jobs/${id}/raw/painted`);
  setInput(wf, "Save remeshed painted", "filename_prefix", `jobs/${id}/raw/remeshed-painted`);
  const samplers = ["Structure sampler", "Shape sampler", "Upsampled shape sampler", "Texture sampler"];
  let lastTitle = "";
  const r = await comfy.run(wf, (e) => {
    if (e.title && e.title !== lastTitle) { lastTitle = e.title; const i = samplers.indexOf(e.title); if (i >= 0) onP(i / samplers.length); }
    if (e.value !== undefined && e.max && samplers.includes(e.title ?? "")) onP((samplers.indexOf(e.title as string) + e.value / e.max) / samplers.length);
  });
  log(`3d: done in ${r.seconds.toFixed(1)}s (seed ${seed}, resolution ${profile.mesh.resolution ?? 1024}, ${multi ? "multi-view" : "single view"})`);
  const rawDir = join(jobDir(id), "raw");
  const out: Record<string, string> = {};
  for (const o of Object.values(r.outputs)) for (const f of o["3d"] ?? []) {
    const src = join(config.comfyOutput, f.subfolder, f.filename); const dst = join(rawDir, f.filename);
    renameSync(src, dst);
    const key = f.filename.replace(/_\d+_\.glb$/, "");
    out[key] = dst;
  }
  rmSync(join(config.comfyOutput, "jobs", id), { recursive: true, force: true });
  if (!out["remeshed-painted"] || !out["painted"] || !out["raw"]) throw new Error("3d stage did not produce raw/painted/remeshed-painted GLBs: " + Object.keys(out).join(","));
  onP(1);
  return out;
}

/** Resolve an init_image reference: "<jobid>" (its thumb), "<jobid>/<relative path>" or an absolute path under FORGE_DATA. */
function resolveInitImage(ref: string): string {
  if (ref.startsWith("/")) { const p = resolve(ref); if (!p.startsWith(config.data) || !existsSync(p)) throw new Error("init_image path not found or outside " + config.data); return p; }
  const [jid, ...rest] = ref.split("/");
  const src = getJob(jid);
  if (!src) throw new Error("init_image job not found: " + jid);
  const rel = rest.length ? rest.join("/") : "out/thumb.png";
  const p = join(jobDir(src.id), rel);
  if (!existsSync(p)) throw new Error("init_image file not found: " + ref);
  return p;
}

/** Video stage (Phase 6): Wan 2.2 14B via text-to-video.json or image-to-video.json, then svc-post video mode. */
async function stageVideo(id: string, req: Job["request"], profile: Profile, name: string, log: (m: string) => void, onP: (p: number) => void): Promise<{ files: string[]; video: any }> {
  const dir = jobDir(id);
  const v = req.video ?? {};
  const pv = ((profile as any).video ?? {}) as Record<string, any>;
  const fps = v.fps ?? pv.fps ?? 16;
  const duration = v.duration_s ?? pv.duration_s ?? 5;
  const frames = Math.max(9, Math.round(duration * fps / 4) * 4 + 1);   // Wan needs 4k+1 frames
  const aspect = v.aspect ?? "16:9";
  const width = aspect === "9:16" ? pv.width_9x16 ?? 480 : pv.width_16x9 ?? 832;
  const height = aspect === "9:16" ? pv.height_9x16 ?? 832 : pv.height_16x9 ?? 480;
  const fast = v.fast ?? pv.fast ?? true;
  const init = v.init_image ? resolveInitImage(v.init_image) : null;
  const wf = loadWorkflow(init ? "image-to-video.json" : "text-to-video.json");
  setInput(wf, "Prompt", "text", `${req.prompt}, ${pv.style_prompt ?? profile.style_prompt}`);
  setInput(wf, "Latent", "width", width); setInput(wf, "Latent", "height", height); setInput(wf, "Latent", "length", frames);
  setAll(wf, ["Sampler high", "Sampler low"], "noise_seed", req.seed);
  if (!fast) {
    // Plain 20-step schedule without the lightx2v LoRAs (template defaults): split at 10, cfg 3.5.
    setAll(wf, ["LoRA high (lightx2v 4-step)", "LoRA low (lightx2v 4-step)"], "strength_model", 0.0);
    setAll(wf, ["Sampler high", "Sampler low"], "steps", 20); setAll(wf, ["Sampler high", "Sampler low"], "cfg", 3.5);
    setInput(wf, "Sampler high", "end_at_step", 10); setInput(wf, "Sampler low", "start_at_step", 10);
  }
  setInput(wf, "Create video", "fps", fps);
  setInput(wf, "Save video", "filename_prefix", `jobs/${id}/out/clip`);
  if (init) {
    const inDir = join(config.comfyInput, "jobs", id); mkdirSync(inDir, { recursive: true });
    copyFileSync(init, join(inDir, "init.png")); copyFileSync(init, join(dir, "refs", "init.png"));
    setInput(wf, "Init image", "image", `jobs/${id}/init.png`);
    setInput(wf, "Fit init image", "width", width); setInput(wf, "Fit init image", "height", height);
  }
  const t0 = Date.now();
  let lastTitle = "";
  const r = await comfy.run(wf, (e) => {
    if (e.title && e.title !== lastTitle) { lastTitle = e.title; onP(e.title === "Sampler high" ? 0.1 : e.title === "Sampler low" ? 0.5 : e.title === "Decode" ? 0.85 : 0.05); }
    if (e.value !== undefined && e.max && (e.title === "Sampler high" || e.title === "Sampler low")) onP((e.title === "Sampler high" ? 0.1 : 0.5) + 0.4 * e.value / e.max);
  });
  log(`video: ${init ? "image-to-video" : "text-to-video"} ${width}x${height} ${frames} frames @${fps} fps, ${fast ? "4-step lightx2v" : "20-step"}, seed ${req.seed}: ${r.seconds.toFixed(1)}s`);
  const srcOut = join(config.comfyOutput, "jobs", id, "out");
  const produced = existsSync(srcOut) ? readdirSync(srcOut).filter((f) => /\.(mp4|mkv|webm)$/.test(f)) : [];
  if (!produced.length) throw new Error("video stage produced no file");
  const rawClip = join(dir, "raw", "clip-comfyui.mp4");
  renameSync(join(srcOut, produced[0]), rawClip);
  rmSync(join(config.comfyOutput, "jobs", id), { recursive: true, force: true });
  const extra = {
    job_id: id, game: profile.game, profile: profile.name, profile_hash: profile._hash, prompt: req.prompt, request: req, batch: req.batch ?? null,
    stages: [{ stage: "video", model: "Wan-AI/Wan2.2-" + (init ? "I2V" : "T2V") + "-A14B", source: "Comfy-Org/Wan_2.2_ComfyUI_Repackaged fp8_scaled + lightx2v 4-step LoRA, ComfyUI core", seed: req.seed,
               mode: init ? "image-to-video" : "text-to-video", init_image: v.init_image ?? null, width, height, frames, fps, duration_s: duration, steps: fast ? 4 : 20, cfg: fast ? 1.0 : 3.5, shift: 5.0,
               license: "Apache-2.0", seconds: Number(r.seconds.toFixed(1)) }],
  };
  writeFileSync(join(dir, "out", "sidecar-extra.json"), JSON.stringify(extra, null, 1));
  const args = [...config.nerdctl.slice(1), "run", "--rm", "--user", "1000:1000", "-v", `${config.data}:${config.data}`, config.svcPostImage,
    "--mode", "video", "--in", rawClip, "--out-dir", join(dir, "out"), "--name", name, "--sidecar-extra", join(dir, "out", "sidecar-extra.json")];
  const t1 = Date.now();
  await runContainer(args, join(dir, "log.txt"), "svc-post video");
  rmSync(join(dir, "out", "sidecar-extra.json"), { force: true });
  const sc = JSON.parse(readFileSync(join(dir, "out", `${name}.sidecar.json`), "utf8"));
  log(`video: post done in ${((Date.now() - t1) / 1000).toFixed(1)}s, ${sc.video.width}x${sc.video.height} ${sc.video.duration_s}s non_blank=${sc.video.non_blank}`);
  onP(1);
  return { files: readdirSync(join(dir, "out")), video: sc.video };
}

const jobOut = (jid: string, pred: (f: string) => boolean): string => {
  const j = getJob(jid); if (!j) throw new Error("job not found: " + jid);
  const out = join(jobDir(j.id), "out");
  const f = existsSync(out) ? readdirSync(out).find(pred) : undefined;
  if (!f) throw new Error("job has no matching output: " + jid);
  return join(out, f);
};

/** Audio stage (Phase 7): sfx = Stable Audio 3 Small-SFX, music = ACE-Step 1.5 turbo, foley = MMAudio over a finished clip; then svc-post audio mode. */
async function stageAudio(id: string, req: Job["request"], profile: Profile, name: string, log: (m: string) => void, onP: (p: number) => void): Promise<{ files: string[]; audio: any }> {
  const dir = jobDir(id);
  const a = req.audio ?? {};
  const pa = ((profile as any).audio ?? {}) as Record<string, any>;
  const kind = req.type as "sfx" | "music" | "foley";
  let wf: Workflow; let duration: number; let stage: Record<string, any>; let clipRaw: string | null = null;
  if (kind === "sfx") {
    duration = a.duration_s ?? pa.sfx_duration_s ?? 4;
    wf = loadWorkflow("text-to-sfx.json");
    setInput(wf, "Prompt", "text", `${req.prompt}, ${pa.sfx_style ?? ""}`.replace(/, $/, ""));
    setInput(wf, "Latent", "seconds", duration); setInput(wf, "Latent", "batch_size", a.count ?? 4);
    setInput(wf, "Sampler", "seed", req.seed);
    setInput(wf, "Save audio", "filename_prefix", `jobs/${id}/out/sfx`);
    stage = { stage: "audio", kind, model: "stabilityai/stable-audio-3-small-sfx", source: "Comfy-Org/stable-audio-3 (ComfyUI core)", steps: 50, cfg: 7.0, sampler: "lcm/simple", license: "Stability AI Community License" };
  } else if (kind === "music") {
    duration = a.duration_s ?? pa.music_duration_s ?? 30;
    wf = loadWorkflow("text-to-music.json");
    setInput(wf, "Prompt", "tags", `${req.prompt}, ${pa.music_style ?? ""}`.replace(/, $/, ""));
    setInput(wf, "Prompt", "lyrics", "[instrumental]");
    setInput(wf, "Prompt", "bpm", a.bpm ?? pa.music_bpm ?? 120); setInput(wf, "Prompt", "keyscale", a.key ?? pa.music_key ?? "C major");
    setInput(wf, "Prompt", "duration", duration); setInput(wf, "Prompt", "seed", req.seed);
    setInput(wf, "Latent", "seconds", duration); setInput(wf, "Sampler", "seed", req.seed);
    setInput(wf, "Save audio", "filename_prefix", `jobs/${id}/out/music`);
    stage = { stage: "audio", kind, model: "ACE-Step/ACE-Step-v1.5 turbo", source: "Comfy-Org/ace_step_1.5_ComfyUI_files (ComfyUI core)", steps: 8, cfg: 1.0, shift: 3.0, bpm: a.bpm ?? pa.music_bpm ?? 120, key: a.key ?? pa.music_key ?? "C major", lyrics: "[instrumental]", loop: !!a.loop, license: "MIT" };
  } else {
    const clip = jobOut(a.clip!, (f) => f.endsWith(".mp4") && !f.includes("poster"));
    const srcJob = getJob(a.clip!)!;
    duration = a.duration_s ?? srcJob.result?.video?.duration_s ?? 5;
    const inDir = join(config.comfyInput, "jobs", id); mkdirSync(inDir, { recursive: true });
    clipRaw = join(dir, "raw", "clip.mp4"); copyFileSync(clip, clipRaw);
    // MMAudio's synchformer assumes 25 fps input (an 81-frame 16 fps clip is read as 3.24 s), so feed it a 25 fps copy.
    await runContainer([...config.nerdctl.slice(1), "run", "--rm", "--user", "1000:1000", "-v", `${config.data}:${config.data}`, "--entrypoint", "ffmpeg", config.svcPostImage,
      "-y", "-v", "error", "-i", clipRaw, "-r", "25", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-an", join(inDir, "clip.mp4")], join(dir, "log.txt"), "ffmpeg 25fps");
    wf = loadWorkflow("video-to-audio.json");
    setInput(wf, "Load clip", "file", `jobs/${id}/clip.mp4`);
    setInput(wf, "Sampler", "prompt", req.prompt ?? ""); setInput(wf, "Sampler", "duration", duration); setInput(wf, "Sampler", "seed", req.seed);
    setInput(wf, "Save audio", "filename_prefix", `jobs/${id}/out/foley`);
    stage = { stage: "audio", kind, model: "hkchengrex/MMAudio large_44k_v2", source: "Kijai/MMAudio_safetensors via ComfyUI-MMAudio (custom node, pinned)", steps: 25, cfg: 4.5, clip_job: a.clip, license: "MIT" };
  }
  const t0 = Date.now();
  const r = await comfy.run(wf, (e) => { if (e.value !== undefined && e.max) onP(0.1 + 0.8 * e.value / e.max); });
  log(`${kind}: ${duration}s seed ${req.seed}: ${r.seconds.toFixed(1)}s on the GPU`);
  const srcOut = join(config.comfyOutput, "jobs", id, "out");
  const produced = existsSync(srcOut) ? readdirSync(srcOut).filter((f) => /\.(flac|wav|mp3|opus)$/.test(f)).sort() : [];
  if (!produced.length) throw new Error(`${kind} stage produced no audio file`);
  const raws = produced.map((f, i) => { const p = join(dir, "raw", `${kind}-comfyui-${i + 1}${f.slice(f.lastIndexOf("."))}`); renameSync(join(srcOut, f), p); return p; });
  rmSync(join(config.comfyOutput, "jobs", id), { recursive: true, force: true });
  rmSync(join(config.comfyInput, "jobs", id), { recursive: true, force: true });
  const extra = { job_id: id, game: profile.game, profile: profile.name, profile_hash: profile._hash, prompt: req.prompt, request: req, batch: req.batch ?? null,
    stages: [{ ...stage, seed: req.seed, duration_s: duration, count: raws.length, seconds: Number(r.seconds.toFixed(1)) }] };
  writeFileSync(join(dir, "out", "sidecar-extra.json"), JSON.stringify(extra, null, 1));
  const args = [...config.nerdctl.slice(1), "run", "--rm", "--user", "1000:1000", "-v", `${config.data}:${config.data}`, config.svcPostImage,
    "--mode", "audio", "--in", raws.join(","), "--out-dir", join(dir, "out"), "--name", name, "--kind", kind,
    "--sample-rate", String(a.sample_rate ?? pa.sample_rate ?? 44100), "--channels", a.channels ?? (kind === "sfx" ? pa.sfx_channels ?? "mono" : "stereo"),
    ...(a.loop ? ["--loop"] : []), ...(clipRaw ? ["--clip", clipRaw] : []), "--sidecar-extra", join(dir, "out", "sidecar-extra.json")];
  const t1 = Date.now();
  await runContainer(args, join(dir, "log.txt"), "svc-post audio");
  rmSync(join(dir, "out", "sidecar-extra.json"), { force: true });
  const sc = JSON.parse(readFileSync(join(dir, "out", `${name}.sidecar.json`), "utf8"));
  log(`${kind}: post done in ${((Date.now() - t1) / 1000).toFixed(1)}s, ${sc.audio.count} × ${sc.audio.duration_s}s non_silent=${sc.audio.non_silent}${sc.audios?.[0]?.loop_seam_db != null ? " loop seam " + sc.audios[0].loop_seam_db + " dB" : ""}`);
  onP(1);
  return { files: readdirSync(join(dir, "out")), audio: sc.audio };
}

/** Speech (Phase 7): Kokoro-82M in the svc-audio container. CPU only. */
async function stageSpeech(id: string, req: Job["request"], profile: Profile, name: string, log: (m: string) => void): Promise<{ files: string[]; audio: any }> {
  const dir = jobDir(id);
  const a = req.audio ?? {}; const pa = ((profile as any).audio ?? {}) as Record<string, any>;
  const voice = a.voice ?? pa.voice ?? "af_heart", speed = a.speed ?? pa.voice_speed ?? 1.0;
  const extra = { job_id: id, game: profile.game, profile: profile.name, profile_hash: profile._hash, prompt: req.prompt, request: req, batch: req.batch ?? null,
    stages: [{ stage: "speech", model: "hexgrad/Kokoro-82M", source: "kokoro 0.9.4 in svc-audio (CPU)", voice, speed, seed: null, license: "Apache-2.0" }] };
  writeFileSync(join(dir, "out", "sidecar-extra.json"), JSON.stringify(extra, null, 1));
  const args = [...config.nerdctl.slice(1), "run", "--rm", "--user", "1000:1000", "-v", `${config.data}:${config.data}`, config.svcAudioImage,
    "--text", req.prompt, "--voice", voice, "--speed", String(speed), "--out-dir", join(dir, "out"), "--name", name, "--sidecar-extra", join(dir, "out", "sidecar-extra.json")];
  const t0 = Date.now();
  await runContainer(args, join(dir, "log.txt"), "svc-audio");
  rmSync(join(dir, "out", "sidecar-extra.json"), { force: true });
  const sc = JSON.parse(readFileSync(join(dir, "out", `${name}.sidecar.json`), "utf8"));
  log(`speech: ${sc.audio.duration_s}s voice ${voice} in ${((Date.now() - t0) / 1000).toFixed(1)}s, non_silent=${sc.audio.non_silent}`);
  return { files: readdirSync(join(dir, "out")), audio: sc.audio };
}

/** Trailer (Phase 6): concatenate finished video jobs' MP4s with crossfades behind a title card. CPU only. */
async function stageTrailer(id: string, req: Job["request"], profile: Profile, name: string, log: (m: string) => void): Promise<string[]> {
  const dir = jobDir(id);
  const t = req.trailer!;
  const clips: string[] = [];
  for (const cid of t.clips) {
    const j = getJob(cid); if (!j) throw new Error("clip job not found: " + cid);
    const out = join(jobDir(j.id), "out");
    const mp4 = readdirSync(out).find((f) => f.endsWith(".mp4") && !f.includes("poster"));
    if (!mp4) throw new Error("clip job has no mp4: " + cid);
    clips.push(join(out, mp4));
  }
  // Phase 7: optional music (a finished music job's WAV) and narration (speech jobs at offsets)
  const pa = ((profile as any).audio ?? {}) as Record<string, any>;
  const music = t.music ? jobOut(t.music, (f) => f.endsWith(".wav")) : null;
  const narration = (t.narration ?? []).map((n) => `${jobOut(n.speech, (f) => f.endsWith(".wav"))}@${n.at_s}`);
  const args = [...config.nerdctl.slice(1), "run", "--rm", "--user", "1000:1000", "-v", `${config.data}:${config.data}`, config.svcPostImage,
    "--mode", "trailer", "--clips", clips.join(","), "--out-dir", join(dir, "out"), "--name", name,
    ...(t.title ? ["--title", t.title] : []), ...(t.subtitle ? ["--subtitle", t.subtitle] : []),
    ...(t.xfade_s ? ["--xfade", String(t.xfade_s)] : []), ...(t.card_s ? ["--card", String(t.card_s)] : []),
    ...(music ? ["--music", music, "--music-db", String(t.music_db ?? pa.music_db ?? -14)] : []), ...(narration.length ? ["--narration", narration.join(",")] : [])];
  const t0 = Date.now();
  await runContainer(args, join(dir, "log.txt"), "svc-post trailer");
  const sc = JSON.parse(readFileSync(join(dir, "out", `${name}.sidecar.json`), "utf8"));
  sc.job_id = id; sc.game = profile.game; sc.profile = profile.name; sc.request = req; sc.trailer.clip_jobs = t.clips;
  if (t.music) sc.trailer.music_job = t.music; if (t.narration?.length) sc.trailer.narration_jobs = t.narration;
  writeFileSync(join(dir, "out", `${name}.sidecar.json`), JSON.stringify(sc, null, 1));
  log(`trailer: ${t.clips.length} clips -> ${sc.trailer.duration_s}s in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return readdirSync(join(dir, "out"));
}

function runContainer(args: string[], logFile: string, what: string): Promise<void> {
  return new Promise<void>((res, rej) => {
    const p = spawn(config.nerdctl[0], args, { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d) => appendFileSync(logFile, d));
    p.stderr.on("data", (d) => appendFileSync(logFile, d));
    p.on("error", rej);
    p.on("close", (code) => code === 0 ? res() : rej(new Error(`${what} exited ${code}`)));
  });
}

/** 2D stage (Phase 5): N FLUX images, cut out with BiRefNet when transparent, tile-checked when seamless. */
async function stageImage(id: string, req: Job["request"], profile: Profile, name: string, log: (m: string) => void): Promise<{ files: string[]; images: any[] }> {
  const dir = jobDir(id);
  const opts = req.image ?? { kind: "sprite", transparent: true, seamless: false };
  const kind = opts.kind ?? "sprite";
  const transparent = !!opts.transparent, seamless = !!opts.seamless;
  const size = opts.size ?? profile.image.size;
  // Sprites share the profile's style prompt; textures/tiles use texture_style instead — the creature-flavoured
  // style prompt ("friendly, clean silhouette") makes FLUX put a character into a ground texture.
  const im = profile.image as any;
  const text = kind === "sprite"
    ? `${req.prompt}, ${profile.style_prompt}, ${im.sprite_prompt ?? ""}`
    : `${req.prompt}, ${im.texture_style ?? profile.style_prompt}, ${im.texture_prompt ?? ""}`;
  const wf = loadWorkflow(transparent ? "image-cutout.json" : "image-refs.json");
  setInput(wf, "Prompt", "text", text);
  setInput(wf, "Latent", "width", size); setInput(wf, "Latent", "height", size); setInput(wf, "Latent", "batch_size", req.count);
  setInput(wf, "Sampler", "seed", req.seed); setInput(wf, "Sampler", "steps", profile.image.steps);
  setInput(wf, "Save", "filename_prefix", `jobs/${id}/out/${kind}`);
  if (transparent) setInput(wf, "Save original", "filename_prefix", `jobs/${id}/refs/original`);
  const r = await comfy.run(wf, () => {});
  log(`image/${kind}: ${req.count} image(s) in ${r.seconds.toFixed(1)}s (seed ${req.seed}, ${size}px, transparent=${transparent}, seamless=${seamless})`);
  // Collect outputs: cut-outs (or plain images) -> out/<name>-N.png, originals -> refs/.
  const outDir = join(dir, "out"), refDir = join(dir, "refs");
  const srcOut = join(config.comfyOutput, "jobs", id, "out"), srcRefs = join(config.comfyOutput, "jobs", id, "refs");
  const images: any[] = [];
  let n = 0;
  for (const f of readdirSync(srcOut).sort()) {
    n++;
    const dst = join(outDir, `${name}-${n}.png`);
    renameSync(join(srcOut, f), dst);
    const meta = await sharp(dst).metadata();
    const entry: any = { file: basename(dst), width: meta.width, height: meta.height, alpha: !!meta.hasAlpha };
    if (seamless) {
      // FLUX does not tile on its own (raw seam scores 0.25-0.35), so make it tileable: keep the raw image in
      // refs/, then crossfade the borders into the half-offset copy, whose wrap edges are continuous.
      const rawCopy = join(refDir, `${name}-${n}-raw.png`);
      copyFileSync(dst, rawCopy);
      const before = await tileCheck(rawCopy, join(refDir, `${name}-${n}-raw-tiled.png`));
      await makeSeamless(rawCopy, dst);
      const t = await tileCheck(dst, join(outDir, `${name}-${n}-tiled.png`));
      entry.seam_score = t.score; entry.seam_h = t.h; entry.seam_v = t.v; entry.tiled = basename(t.tiled);
      entry.seam_score_raw = before.score; entry.raw = basename(rawCopy);
    }
    images.push(entry);
  }
  if (existsSync(srcRefs)) for (const f of readdirSync(srcRefs)) renameSync(join(srcRefs, f), join(refDir, f));
  rmSync(join(config.comfyOutput, "jobs", id), { recursive: true, force: true });
  if (!images.length) throw new Error("image stage produced no files");
  await sharp(join(outDir, images[0].file)).resize(512, 512, { fit: "inside" }).png().toFile(join(outDir, "thumb.png"));
  const sidecar = {
    forge_version: "0.1.0", job_id: id, created_at: new Date().toISOString(), game: profile.game, profile: profile.name,
    profile_hash: profile._hash, prompt: req.prompt, negative_prompt: profile.negative_prompt, request: req, batch: req.batch ?? null,
    stages: [{ stage: "image", model: "black-forest-labs/FLUX.1-schnell", source: "Comfy-Org/flux1-schnell (bf16)", seed: req.seed, steps: profile.image.steps,
               count: req.count, size, kind, transparent, seamless, background_removal: transparent ? "BiRefNet (ComfyUI core RemoveBackground)" : null, license: "Apache-2.0" }],
    images, files: { thumb: "thumb.png" }, status: "review",
  };
  writeFileSync(join(outDir, `${name}.sidecar.json`), JSON.stringify(sidecar, null, 1));
  const seams = images.filter((i) => i.seam_score !== undefined).map((i) => i.seam_score.toFixed(3));
  log(`image: ${images.length} file(s)${seams.length ? ", seam scores " + seams.join(", ") : ""}`);
  return { files: readdirSync(outDir), images };
}

/** Offset-and-crossfade: out = original in the centre, the half-shifted copy at the borders, feathered
 *  over `margin` of the size. The shifted copy's border is the original's centre, so the result wraps. */
async function makeSeamless(src: string, dst: string, margin = 0.22): Promise<void> {
  const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  const out = Buffer.alloc(w * h * ch);
  const mx = Math.round(w * margin), my = Math.round(h * margin);
  const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  for (let y = 0; y < h; y++) {
    const fy = smooth(Math.min(y, h - 1 - y) / my);
    const sy = (y + (h >> 1)) % h;
    for (let x = 0; x < w; x++) {
      const m = Math.min(fy, smooth(Math.min(x, w - 1 - x) / mx));   // 1 in the centre, 0 at the edges
      const sx = (x + (w >> 1)) % w;
      const o = (y * w + x) * ch, s = (sy * w + sx) * ch;
      for (let c = 0; c < ch; c++) out[o + c] = Math.round(data[o + c] * m + data[s + c] * (1 - m));
    }
  }
  await sharp(out, { raw: { width: w, height: h, channels: ch as 3 } }).png().toFile(dst);
}

/** Seamless tile check: mean absolute difference between the left/right edge columns and top/bottom
 *  rows (0 = wraps perfectly, ~0.3 = clearly not tileable), plus a 2x2 tiled preview for the eye. */
async function tileCheck(file: string, tiledOut: string): Promise<{ score: number; h: number; v: number; tiled: string }> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  let dh = 0, dv = 0;
  for (let y = 0; y < h; y++) for (let c = 0; c < 3; c++) dh += Math.abs(data[(y * w) * ch + c] - data[(y * w + w - 1) * ch + c]);
  for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) dv += Math.abs(data[x * ch + c] - data[((h - 1) * w + x) * ch + c]);
  const hs = dh / (h * 3 * 255), vs = dv / (w * 3 * 255);
  const half = Math.round(w / 2);
  const small = await sharp(file).resize(half, half).png().toBuffer();
  await sharp({ create: { width: half * 2, height: half * 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: small, left: 0, top: 0 }, { input: small, left: half, top: 0 }, { input: small, left: 0, top: half }, { input: small, left: half, top: half }])
    .png().toFile(tiledOut);
  return { score: Math.max(hs, vs), h: hs, v: vs, tiled: tiledOut };
}

/** Rig stage (Phase 4): UniRig on the finished, normalized asset (rig.json), then a Blender merge that
 *  re-applies the baked material, re-normalizes, and exports <name>.rigged.glb / .fbx. */
async function stageRig(id: string, req: Job["request"], profile: Profile, name: string, log: (m: string) => void): Promise<{ files: string[] }> {
  const dir = jobDir(id);
  const textured = join(dir, "out", `${name}.blender.glb`);
  if (!existsSync(textured)) throw new Error("rig stage needs the uncompressed post output (" + basename(textured) + ")");
  // UniRigLoadMesh's file list is frozen at container start (see comfy.RIG_INPUT): always overwrite the
  // fixed placeholder. Safe because the worker runs one job at a time.
  await comfy.ensureUp(log);
  copyFileSync(textured, join(config.comfyInput, comfy.RIG_INPUT));
  const wf = loadWorkflow("rig.json");
  const template = (profile.rig as any)?.template ?? "articulationxl";
  setInput(wf, "Rig input mesh", "file_path", comfy.RIG_INPUT);
  setInput(wf, "Auto rig", "skeleton_template", template);
  setInput(wf, "Auto rig", "fbx_name", `rig-${id.slice(0, 8)}`);
  const t0 = Date.now();
  await comfy.run(wf, () => {});
  // UniRigAutoRig writes <fbx_name>_<template>.fbx into ComfyUI's output root.
  const produced = readdirSync(config.comfyOutput).filter((f) => f.startsWith(`rig-${id.slice(0, 8)}`) && f.endsWith(".fbx"));
  if (!produced.length) throw new Error("UniRig produced no FBX");
  const rawFbx = join(dir, "raw", "rigged-unirig.fbx");
  renameSync(join(config.comfyOutput, produced[0]), rawFbx);
  log(`rig: UniRig (${template}) done in ${((Date.now() - t0) / 1000).toFixed(1)}s -> raw/rigged-unirig.fbx`);
  const args = [...config.nerdctl.slice(1), "run", "--rm", "--user", "1000:1000", "-v", `${config.data}:${config.data}`, config.svcPostImage,
    "--mode", "rig", "--rigged", rawFbx, "--textured", textured, "--out-dir", join(dir, "out"), "--name", name,
    "--height", String(req.height_m ?? profile.mesh.target_height_m), "--template", template];
  const t1 = Date.now();
  await new Promise<void>((res, rej) => {
    const p = spawn(config.nerdctl[0], args, { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d) => appendFileSync(join(dir, "log.txt"), d));
    p.stderr.on("data", (d) => appendFileSync(join(dir, "log.txt"), d));
    p.on("error", rej);
    p.on("close", (code) => code === 0 ? res() : rej(new Error(`svc-post rig exited ${code}`)));
  });
  for (const f of readdirSync(join(dir, "out"))) if (/\.rigged\.blender\.glb$/.test(f)) rmSync(join(dir, "out", f));
  const files = readdirSync(join(dir, "out"));
  log(`rig: merge done in ${((Date.now() - t1) / 1000).toFixed(1)}s -> ${files.filter((f) => f.includes("rig")).join(", ")}`);
  return { files };
}

async function stagePost(id: string, req: Job["request"], profile: Profile, refs: Refs, raw: Record<string, string>, name: string, log: (m: string) => void): Promise<{ files: string[] }> {
  const dir = jobDir(id);
  const extra = {
    job_id: id, game: profile.game, profile: profile.name, prompt: req.prompt, negative_prompt: profile.negative_prompt,
    request: req, refs: { picked: basename(refs.front), views: refs.side ? "multi" : "front" },
    stages: [
      { stage: "image", model: "black-forest-labs/FLUX.1-schnell", source: "Comfy-Org/flux1-schnell (bf16)", seed: req.seed, steps: profile.image.steps, count: req.count, license: "Apache-2.0" },
      { stage: "3d", model: "microsoft/TRELLIS.2-4B", source: "Comfy-Org/TRELLIS.2 trellis_2_bf16 via ComfyUI core", seed: req.seed + 1, resolution: profile.mesh.resolution ?? 1024, license: "MIT" },
    ],
  };
  writeFileSync(join(dir, "out", "sidecar-extra.json"), JSON.stringify(extra, null, 1));
  const args = [...config.nerdctl.slice(1), "run", "--rm", "--user", "1000:1000", "-v", `${config.data}:${config.data}`, config.svcPostImage,
    // Bake source is the closed DC-remeshed mesh, not the raw decoder output: the raw mesh has small holes
    // and interior faces, and bake rays that fall through them paint the inside colour onto the albedo.
    "--in", raw["remeshed-painted"], "--hires", raw["remeshed-painted"], "--out-dir", join(dir, "out"), "--name", name,
    "--profile", profile._path, "--sidecar-extra", join(dir, "out", "sidecar-extra.json"),
    "--decimate", "gltf", "--material", profile.mesh.material, "--height", String(req.height_m ?? profile.mesh.target_height_m)];
  log("post: " + [config.nerdctl[0], ...args].join(" "));
  const t0 = Date.now();
  await new Promise<void>((res, rej) => {
    const p = spawn(config.nerdctl[0], args, { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d) => appendFileSync(join(dir, "log.txt"), d));
    p.stderr.on("data", (d) => appendFileSync(join(dir, "log.txt"), d));
    p.on("error", rej);
    p.on("close", (code) => code === 0 ? res() : rej(new Error(`svc-post exited ${code}`)));
  });
  // Tidy intermediates; keep the final glb/fbx/sidecar/thumb (+ post report) and the uncompressed
  // <name>.blender.glb (Blender / tools without a meshopt decoder need it; ~4 MB).
  for (const f of readdirSync(join(dir, "out"))) if (/\.(welded|simplified)\.glb$|sidecar-extra\.json$/.test(f)) rmSync(join(dir, "out", f));
  const files = readdirSync(join(dir, "out"));
  log(`post: done in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${files.join(", ")}`);
  return { files };
}
