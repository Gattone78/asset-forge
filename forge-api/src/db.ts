// SQLite job table. One process owns the file; WAL so the API can read while the worker writes.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "./config.ts";

export type JobStatus = "queued" | "running" | "review" | "approved" | "rejected" | "failed";
export interface JobRequest {
  type: "creature" | "prop" | "plant" | "image";
  prompt: string;
  profile: string;
  seed: number;
  rig: boolean;
  count: number;
  height_m?: number;
  views?: "front" | "multi";
  rerun_of?: string;
  restart_comfy?: boolean;
  batch?: string;
  image?: { kind?: "sprite" | "texture" | "tile"; transparent?: boolean; seamless?: boolean; size?: number };
}
export interface Job {
  id: string;
  status: JobStatus;
  stage: string;
  progress: number;
  error: string | null;
  request: JobRequest;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

mkdirSync(dirname(paths.db), { recursive: true });
const db = new Database(paths.db);
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT '',
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  request TEXT NOT NULL,
  result TEXT,
  type TEXT NOT NULL,
  profile TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at);`);
// Phase 5: batch label column (older databases get it added in place).
if (!(db.prepare("PRAGMA table_info(jobs)").all() as any[]).some((c) => c.name === "batch")) db.exec("ALTER TABLE jobs ADD COLUMN batch TEXT");
db.exec("CREATE INDEX IF NOT EXISTS jobs_batch ON jobs(batch)");

const row2job = (r: any): Job => ({
  id: r.id, status: r.status, stage: r.stage, progress: r.progress, error: r.error,
  request: JSON.parse(r.request), result: r.result ? JSON.parse(r.result) : null,
  created_at: r.created_at, updated_at: r.updated_at,
});

export function insertJob(id: string, req: JobRequest): Job {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO jobs (id,status,stage,progress,request,type,profile,batch,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, "queued", "queued", 0, JSON.stringify(req), req.type, req.profile, req.batch ?? null, now, now);
  return getJob(id) as Job;
}
export function getJob(id: string): Job | null {
  const r = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  return r ? row2job(r) : null;
}
export function updateJob(id: string, patch: Partial<Pick<Job, "status" | "stage" | "progress" | "error" | "result">>): void {
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`); vals.push(k === "result" ? JSON.stringify(v) : v);
  }
  sets.push("updated_at = ?"); vals.push(new Date().toISOString()); vals.push(id);
  db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}
export function listJobs(filter: { status?: string; game?: string; profile?: string; batch?: string; type?: string; limit?: number }): Job[] {
  const where: string[] = []; const vals: unknown[] = [];
  if (filter.status) { where.push("status = ?"); vals.push(filter.status); }
  if (filter.profile) { where.push("profile = ?"); vals.push(filter.profile); }
  if (filter.batch) { where.push("batch = ?"); vals.push(filter.batch); }
  if (filter.type) { where.push("type = ?"); vals.push(filter.type); }
  const sql = `SELECT * FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
  vals.push(filter.limit ?? 100);
  return db.prepare(sql).all(...vals).map(row2job);
}
export function nextQueued(): Job | null {
  const r = db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1").get();
  return r ? row2job(r) : null;
}
export function listBatches(): { batch: string; n: number; first: string }[] {
  return db.prepare("SELECT batch, COUNT(*) n, MIN(created_at) first FROM jobs WHERE batch IS NOT NULL GROUP BY batch ORDER BY first DESC").all() as any[];
}
export function countByStatus(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db.prepare("SELECT status, COUNT(*) n FROM jobs GROUP BY status").all() as any[]) out[r.status] = r.n;
  return out;
}
export function recoverRunning(): number {
  // Jobs left "running" by a crash are failed, not resumed: stages are cheap and idempotent enough to rerun.
  return db.prepare("UPDATE jobs SET status='failed', error='forge-api restarted mid-job', updated_at=? WHERE status='running'").run(new Date().toISOString()).changes;
}
