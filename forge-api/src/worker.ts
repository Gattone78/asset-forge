// Single worker loop: one job at a time, stages refs -> 3d -> post. Keeps comfyui up between jobs and
// stops it after FORGE_GPU_IDLE_TIMEOUT with nothing queued.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
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
    set("starting", 0);
    await comfy.ensureUp(log);

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
    const out = await stagePost(id, req, profile, refs, raw, name, log);
    const result = { name, files: out.files, refs: refs.files, raw: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, basename(v)])), seconds: (Date.now() - t0) / 1000 };
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
    "--in", raw["remeshed-painted"], "--hires", raw["painted"], "--out-dir", join(dir, "out"), "--name", name,
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
