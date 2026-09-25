// forge-api: REST per req §6. Plain Fastify, no plugins beyond what ships with it.
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { join, normalize, resolve } from "node:path";
import { config, paths } from "./config.ts";
import * as comfy from "./comfy.ts";
import { countByStatus, getJob, insertJob, listBatches, listJobs, recoverRunning, updateJob, type JobRequest } from "./db.ts";
import { listProfiles, loadProfile } from "./profiles.ts";
import { gpu, isBusy, startWorker } from "./worker.ts";
import { viewerHtml } from "./viewer.ts";

const app = Fastify({ logger: { level: "info" } });

app.get("/health", async () => {
  const [up, v, state] = await Promise.all([comfy.isUp(), comfy.vram().catch(() => null), comfy.containerState()]);
  return {
    ok: true, version: config.version, worker_busy: isBusy(), queue: countByStatus(),
    gpu: { comfyui_up: up, container: state, vram_used_mib: v?.usedMiB ?? null, vram_free_mib: v?.freeMiB ?? null,
           processes: v?.processes ?? [], idle_stop_at: gpu.idleStopAt, min_free_vram_gb: config.minFreeVramGb, idle_timeout_s: config.idleTimeoutSec },
  };
});
app.get("/profiles", async () => listProfiles());

app.post("/jobs", async (req, reply) => {
  const b = (req.body ?? {}) as Partial<JobRequest>;
  if ((!b.prompt && !["trailer", "foley"].includes(b.type)) || !b.profile) return reply.code(400).send({ error: "prompt and profile are required" });
  let profile; try { profile = loadProfile(b.profile); } catch { return reply.code(400).send({ error: `unknown profile ${b.profile}` }); }
  const type = (b.type ?? "creature") as JobRequest["type"];
  if (!["creature", "prop", "plant", "image", "video", "trailer", "sfx", "music", "speech", "foley", "promo", "model"].includes(type)) return reply.code(400).send({ error: "bad type" });
  const finished = (jid: string, types: string[]) => { const j = getJob(jid); return j && types.includes(j.request.type) && ["review", "approved"].includes(j.status) ? j : null; };
  if (type === "trailer") {
    const clips = ((b.trailer?.clips ?? []) as string[]).map(String).filter(Boolean);
    if (!clips.length) return reply.code(400).send({ error: "trailer needs trailer.clips: [job ids of finished video or foley jobs]" });
    for (const c of clips) if (!finished(c, ["video", "foley"])) return reply.code(400).send({ error: `clip ${c} is not a finished video/foley job` });
    if (b.trailer?.music && !finished(String(b.trailer.music), ["music"])) return reply.code(400).send({ error: `music ${b.trailer.music} is not a finished music job` });
    for (const n of (b.trailer?.narration ?? []) as any[]) if (!n?.speech || !finished(String(n.speech), ["speech"])) return reply.code(400).send({ error: `narration ${n?.speech} is not a finished speech job` });
  }
  if (type === "foley" && !finished(String(b.audio?.clip ?? ""), ["video"])) return reply.code(400).send({ error: "foley needs audio.clip: a finished video job id" });
  // Phase 8: photo-driven jobs need existing uploads and a known style
  const uploadOk = (ref: string) => { const id = String(ref).replace(/^upload:/, ""); return /^[0-9a-f-]{36}$/.test(id) && existsSync(join(paths.uploads, `${id}.json`)); };
  if (type === "promo") {
    if (!b.promo?.photo || !uploadOk(b.promo.photo)) return reply.code(400).send({ error: "promo needs promo.photo: an upload id (POST /uploads)" });
    if (!b.promo?.style) return reply.code(400).send({ error: "promo needs promo.style (see the profile's styles)" });
  }
  if (type === "model") {
    const photos = ((b.model?.photos ?? []) as string[]).map(String).filter(Boolean);
    if (!photos.length || !photos.every(uploadOk)) return reply.code(400).send({ error: "model needs model.photos: upload ids (POST /uploads)" });
    if (!b.model?.style) return reply.code(400).send({ error: "model needs model.style (see the profile's styles)" });
  }
  const au = (b.audio ?? {}) as NonNullable<JobRequest["audio"]>;
  const vid = (b.video ?? {}) as NonNullable<JobRequest["video"]>;
  const img = (b.image ?? {}) as NonNullable<JobRequest["image"]>;
  const kind = (["sprite", "texture", "tile"].includes(img.kind ?? "") ? img.kind : "sprite") as "sprite" | "texture" | "tile";
  const jr: JobRequest = {
    type, prompt: String(b.prompt), profile: b.profile, seed: Number.isInteger(b.seed) ? Number(b.seed) : Math.floor(Math.random() * 2 ** 31),
    rig: !!b.rig, count: Math.min(8, Math.max(1, Number(b.count ?? profile.image.count ?? 4))), height_m: b.height_m ? Number(b.height_m) : undefined,
    views: b.views === "multi" ? "multi" : b.views === "front" ? "front" : undefined,
    rerun_of: b.rerun_of, restart_comfy: !!b.restart_comfy,
    batch: b.batch ? String(b.batch).slice(0, 64) : undefined,
    image: type === "image" ? { kind, transparent: img.transparent ?? kind === "sprite", seamless: img.seamless ?? kind !== "sprite", size: img.size ? Number(img.size) : undefined } : undefined,
    video: type === "video" ? { duration_s: vid.duration_s ? Math.min(10, Math.max(1, Number(vid.duration_s))) : undefined, fps: vid.fps ? Number(vid.fps) : undefined,
      aspect: vid.aspect === "9:16" ? "9:16" : "16:9", init_image: vid.init_image ? String(vid.init_image) : undefined, fast: vid.fast ?? true } : undefined,
    trailer: type === "trailer" ? { clips: (b.trailer!.clips as string[]).map(String), title: b.trailer?.title, subtitle: b.trailer?.subtitle, xfade_s: b.trailer?.xfade_s, card_s: b.trailer?.card_s,
      music: b.trailer?.music ? String(b.trailer.music) : undefined, music_db: b.trailer?.music_db !== undefined ? Number(b.trailer.music_db) : undefined,
      narration: ((b.trailer?.narration ?? []) as any[]).map((n) => ({ speech: String(n.speech), at_s: Number(n.at_s ?? 0) })) } : undefined,
    audio: ["sfx", "music", "speech", "foley"].includes(type) ? {
      duration_s: au.duration_s !== undefined ? Math.min(type === "music" ? 300 : 30, Math.max(0.5, Number(au.duration_s))) : undefined,
      count: type === "sfx" ? Math.min(8, Math.max(1, Number(au.count ?? 4))) : 1, loop: type === "music" ? !!au.loop : undefined,
      bpm: au.bpm ? Number(au.bpm) : undefined, key: au.key, voice: au.voice, speed: au.speed ? Number(au.speed) : undefined, clip: type === "foley" ? String(au.clip) : undefined,
      sample_rate: au.sample_rate ? Number(au.sample_rate) : undefined, channels: au.channels === "stereo" ? "stereo" : au.channels === "mono" ? "mono" : undefined } : undefined,
  };
  if (type === "foley") jr.prompt = jr.prompt || "";
  if (type === "promo") jr.promo = { photo: String(b.promo.photo).replace(/^upload:/, ""), style: String(b.promo.style), duration_s: b.promo.duration_s ? Math.min(10, Math.max(1, Number(b.promo.duration_s))) : undefined,
    aspect: b.promo.aspect === "9:16" ? "9:16" : "16:9", script: b.promo.script ? String(b.promo.script) : undefined, narration_at_s: b.promo.narration_at_s !== undefined ? Number(b.promo.narration_at_s) : undefined,
    music: b.promo.music !== false, music_prompt: b.promo.music_prompt ? String(b.promo.music_prompt) : undefined, foley: b.promo.foley !== false, title: b.promo.title ? String(b.promo.title) : undefined };
  if (type === "model") jr.model = { photos: (b.model.photos as string[]).map((p) => String(p).replace(/^upload:/, "")), style: String(b.model.style), humanoid: !!b.model.humanoid };
  if (type === "trailer") jr.prompt = jr.prompt || `trailer: ${jr.trailer!.title ?? jr.trailer!.clips.length + " clips"}`;
  if (jr.rig && type !== "creature" && type !== "model") return reply.code(400).send({ error: "rigging applies to creatures and photo models only (props and plants get named pivots, req §1)" });
  if (jr.views === "multi") return reply.code(501).send({ error: "views=multi is not effective: ComfyUI core's Trellis2Conditioning treats an image batch as separate objects, so the result equals the front-only run (Phase 2 bake-off, docs/phase-2.md). Multi-view needs the Pixal3D multi-view model; not wired yet." });
  const job = insertJob(randomUUID(), jr);
  return reply.code(201).send(job);
});
app.get("/jobs", async (req) => {
  const q = req.query as Record<string, string>;
  return listJobs({ status: q.status, profile: q.profile, batch: q.batch, type: q.type, limit: q.limit ? Number(q.limit) : undefined });
});
app.get("/batches", async () => listBatches());
app.get("/jobs/:id", async (req, reply) => {
  const job = getJob((req.params as any).id);
  return job ?? reply.code(404).send({ error: "no such job" });
});
app.get("/jobs/:id/log", async (req, reply) => {
  const f = join(paths.jobs, (req.params as any).id, "log.txt");
  if (!existsSync(f)) return reply.code(404).send({ error: "no log" });
  return reply.type("text/plain").send(readFileSync(f, "utf8"));
});
app.get("/jobs/:id/assets", async (req, reply) => {
  const id = (req.params as any).id; const job = getJob(id);
  if (!job) return reply.code(404).send({ error: "no such job" });
  const dir = join(paths.jobs, id);
  const list = (sub: string) => existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).map((f) => ({ path: `${sub}/${f}`, bytes: statSync(join(dir, sub, f)).size })) : [];
  const files = [...list("out"), ...list("refs"), ...list("raw")];
  const sidecarFile = files.find((f) => f.path.endsWith(".sidecar.json"));
  const sidecar = sidecarFile ? JSON.parse(readFileSync(join(dir, sidecarFile.path), "utf8")) : null;
  return { id, status: job.status, files, sidecar };
});
app.get("/assets/:job/*", async (req, reply) => {
  const id = (req.params as any).job; const rel = normalize((req.params as any)["*"]);
  if (rel.startsWith("..") || rel.includes("../")) return reply.code(400).send({ error: "bad path" });
  const f = join(paths.jobs, id, rel);
  if (!existsSync(f) || !statSync(f).isFile()) return reply.code(404).send({ error: "no such file" });
  const type = f.endsWith(".glb") ? "model/gltf-binary" : f.endsWith(".png") ? "image/png" : f.endsWith(".json") ? "application/json" : f.endsWith(".fbx") ? "application/octet-stream" : "application/octet-stream";
  return reply.type(type).header("content-length", statSync(f).size).send(createReadStream(f));
});
// ---- uploads (Phase 8): raw image body, no multipart dependency. POST /uploads?name=photo.jpg with the file as the body. ----
app.addContentTypeParser(["image/png", "image/jpeg", "image/webp", "application/octet-stream"], { parseAs: "buffer", bodyLimit: 20 * 1024 * 1024 }, (_req, body, done) => done(null, body));
app.post("/uploads", async (req, reply) => {
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length < 100) return reply.code(400).send({ error: "send the image file as the request body (image/png, image/jpeg or image/webp)" });
  mkdirSync(paths.uploads, { recursive: true });
  let meta: sharp.Metadata;
  try { meta = await sharp(body).metadata(); } catch { return reply.code(400).send({ error: "not an image" }); }
  if (!meta.width || !meta.height || !["png", "jpeg", "webp"].includes(meta.format ?? "")) return reply.code(400).send({ error: "unsupported image format: " + meta.format });
  const id = randomUUID();
  // Stored as PNG with the EXIF orientation applied, so every later stage sees the photo the way the camera showed it.
  const png = await sharp(body).rotate().png().toBuffer();
  const info = await sharp(png).metadata();
  const rec = { id, name: String((req.query as any).name ?? "upload").slice(0, 200), bytes: png.length, original_bytes: body.length, original_format: meta.format,
    width: info.width, height: info.height, sha256: createHash("sha256").update(body).digest("hex"), uploaded_at: new Date().toISOString(), file: `${id}.png` };
  writeFileSync(join(paths.uploads, `${id}.png`), png);
  writeFileSync(join(paths.uploads, `${id}.json`), JSON.stringify(rec, null, 1));
  return reply.code(201).send(rec);
});
app.get("/uploads", async () => existsSync(paths.uploads) ? readdirSync(paths.uploads).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(paths.uploads, f), "utf8"))).sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at)) : []);
app.get("/uploads/:id", async (req, reply) => {
  const id = String((req.params as any).id).replace(/[^0-9a-f-]/g, "");
  const f = join(paths.uploads, `${id}.png`);
  if (!existsSync(f)) return reply.code(404).send({ error: "no such upload" });
  return reply.type("image/png").header("content-length", statSync(f).size).send(createReadStream(f));
});
app.delete("/uploads/:id", async (req, reply) => {
  const id = String((req.params as any).id).replace(/[^0-9a-f-]/g, "");
  if (!existsSync(join(paths.uploads, `${id}.json`))) return reply.code(404).send({ error: "no such upload" });
  const users = listJobs({ limit: 100000 }).filter((j) => JSON.stringify(j.request).includes(id));
  if (users.length) return reply.code(409).send({ error: `upload is referenced by ${users.length} job(s)`, jobs: users.map((j) => j.id) });
  rmSync(join(paths.uploads, `${id}.png`), { force: true }); rmSync(join(paths.uploads, `${id}.json`), { force: true });
  return { ok: true };
});

app.get("/viewer", async (req, reply) => {
  const q = req.query as Record<string, string>;
  const job = getJob(q.job ?? "");
  if (!job) return reply.code(404).send({ error: "no such job" });
  const outDir = join(paths.jobs, job.id, "out");
  const glb = q.file ?? (existsSync(outDir) ? readdirSync(outDir).find((f) => f.endsWith(".glb") && !f.endsWith(".blender.glb")) : undefined);
  if (!glb) return reply.code(404).send({ error: "job has no GLB yet" });
  return reply.type("text/html").send(viewerHtml(job.id, glb.includes("/") ? glb : `out/${glb}`));
});

for (const action of ["approve", "reject"] as const) {
  app.post(`/jobs/:id/${action}`, async (req, reply) => {
    const id = (req.params as any).id; const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "no such job" });
    if (!["review", "approved", "rejected"].includes(job.status)) return reply.code(409).send({ error: `job is ${job.status}` });
    const status = action === "approve" ? "approved" : "rejected";
    updateJob(id, { status });
    const outDir = join(paths.jobs, id, "out");
    if (existsSync(outDir)) for (const f of readdirSync(outDir)) if (f.endsWith(".sidecar.json")) {
      const sc = JSON.parse(readFileSync(join(outDir, f), "utf8")); sc.status = status; writeFileSync(join(outDir, f), JSON.stringify(sc, null, 1));
    }
    return getJob(id);
  });
}
app.post("/jobs/:id/rerun", async (req, reply) => {
  const id = (req.params as any).id; const job = getJob(id);
  if (!job) return reply.code(404).send({ error: "no such job" });
  const b = (req.body ?? {}) as { seed?: number };
  const sameSeed = b.seed === undefined || b.seed === job.request.seed;
  const jr: JobRequest = { ...job.request, seed: sameSeed ? job.request.seed : Number(b.seed), rerun_of: id, restart_comfy: sameSeed };
  return reply.code(201).send(insertJob(randomUUID(), jr));
});

// Review UI (forge-ui): static SPA generated into forge-ui/.output/public, served at /ui/ with an
// index.html fallback for client-side routes. Absent until it has been built; the API works without it.
const uiRoot = resolve(config.repo, "forge-ui", ".output", "public");
if (existsSync(join(uiRoot, "index.html"))) {
  app.register(fastifyStatic, { root: uiRoot, prefix: "/ui/", decorateReply: true, index: ["index.html"] });
  app.get("/", async (_req, reply) => reply.redirect("/ui/"));
  app.setNotFoundHandler(async (req, reply) => {
    if (req.method === "GET" && req.url.startsWith("/ui/")) return reply.sendFile("index.html");
    return reply.code(404).send({ error: "not found" });
  });
  app.log.info(`serving forge-ui from ${uiRoot}`);
}

const failed = recoverRunning();
if (failed) app.log.warn(`marked ${failed} job(s) left running by a previous process as failed`);
startWorker();
app.listen({ port: config.port, host: config.host }).then(() => app.log.info(`forge-api ${config.version} data=${config.data} comfy=${config.comfyUrl}`));
