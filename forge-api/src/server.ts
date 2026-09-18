// forge-api: REST per req §6. Plain Fastify, no plugins beyond what ships with it.
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { config, paths } from "./config.ts";
import * as comfy from "./comfy.ts";
import { countByStatus, getJob, insertJob, listJobs, recoverRunning, updateJob, type JobRequest } from "./db.ts";
import { listProfiles, loadProfile } from "./profiles.ts";
import { gpu, isBusy, startWorker } from "./worker.ts";

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
  if (!b.prompt || !b.profile) return reply.code(400).send({ error: "prompt and profile are required" });
  let profile; try { profile = loadProfile(b.profile); } catch { return reply.code(400).send({ error: `unknown profile ${b.profile}` }); }
  const type = (b.type ?? "creature") as JobRequest["type"];
  if (!["creature", "prop", "plant", "image"].includes(type)) return reply.code(400).send({ error: "bad type" });
  if (type === "image") return reply.code(501).send({ error: "image jobs arrive in Phase 5" });
  const jr: JobRequest = {
    type, prompt: String(b.prompt), profile: b.profile, seed: Number.isInteger(b.seed) ? Number(b.seed) : Math.floor(Math.random() * 2 ** 31),
    rig: !!b.rig, count: Math.min(8, Math.max(1, Number(b.count ?? profile.image.count ?? 4))), height_m: b.height_m ? Number(b.height_m) : undefined,
    views: b.views === "multi" ? "multi" : b.views === "front" ? "front" : undefined,
    rerun_of: b.rerun_of, restart_comfy: !!b.restart_comfy,
  };
  if (jr.rig) return reply.code(501).send({ error: "--rig arrives in Phase 4" });
  const job = insertJob(randomUUID(), jr);
  return reply.code(201).send(job);
});
app.get("/jobs", async (req) => {
  const q = req.query as Record<string, string>;
  return listJobs({ status: q.status, profile: q.profile, limit: q.limit ? Number(q.limit) : undefined });
});
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

const failed = recoverRunning();
if (failed) app.log.warn(`marked ${failed} job(s) left running by a previous process as failed`);
startWorker();
app.listen({ port: config.port, host: config.host }).then(() => app.log.info(`forge-api ${config.version} data=${config.data} comfy=${config.comfyUrl}`));
