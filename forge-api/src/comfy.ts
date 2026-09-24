// ComfyUI client + container lifecycle. The container is the unload mechanism (req §3):
// start on demand, stop after idle, and a stop only counts once nvidia-smi shows VRAM back at baseline.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { config, paths } from "./config.ts";
import type { Workflow } from "./workflows.ts";

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface VramState { usedMiB: number; freeMiB: number; totalMiB: number; processes: { pid: number; name: string; usedMiB: number }[] }
export interface ProgressEvent { node?: string; title?: string; value?: number; max?: number; message?: string }
export type OnProgress = (e: ProgressEvent) => void;

export async function vram(): Promise<VramState> {
  const q = await execFileP("nvidia-smi", ["--query-gpu=memory.used,memory.free,memory.total", "--format=csv,noheader,nounits"]);
  const [used, free, total] = q.stdout.trim().split(",").map((s) => Number(s.trim()));
  const p = await execFileP("nvidia-smi", ["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"]);
  const processes = p.stdout.trim().split("\n").filter(Boolean).map((l) => {
    const [pid, name, mem] = l.split(",").map((s) => s.trim());
    return { pid: Number(pid), name, usedMiB: Number(mem) };
  });
  return { usedMiB: used, freeMiB: free, totalMiB: total, processes };
}

async function nerdctl(args: string[], timeoutMs = 120_000): Promise<string> {
  const [cmd, ...pre] = config.nerdctl;
  const r = await execFileP(cmd, [...pre, ...args], { timeout: timeoutMs, maxBuffer: 8 << 20 });
  return r.stdout + r.stderr;
}
const composeArgs = (...a: string[]) => ["compose", "-f", paths.compose, ...a];

export async function isUp(): Promise<boolean> {
  try {
    const r = await fetch(`${config.comfyUrl}/system_stats`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}
export async function containerState(): Promise<string> {
  try {
    const out = await nerdctl(["ps", "-a", "--filter", "name=forge-comfyui-1", "--format", "{{.Status}}"]);
    return out.trim() || "absent";
  } catch { return "unknown"; }
}

/** Free-VRAM guard (req §9): refuse to start when something else holds the GPU, naming it. */
export async function guardFreeVram(): Promise<void> {
  const v = await vram();
  const freeGb = v.freeMiB / 1024;
  if (freeGb < config.minFreeVramGb) {
    const holders = v.processes.map((p) => `${p.name} (pid ${p.pid}, ${(p.usedMiB / 1024).toFixed(1)} GB)`).join(", ") || "no listed processes";
    throw new Error(`GPU has ${freeGb.toFixed(1)} GB free, below FORGE_MIN_FREE_VRAM_GB=${config.minFreeVramGb}; held by: ${holders}. Stop them and retry.`);
  }
}

/** Host readiness gate (req §9): right after boot the driver and the CDI spec lag; never start comfyui
 *  until nvidia-smi answers and /var/run/cdi/nvidia.yaml exists. */
export async function waitForGpuHost(log: (m: string) => void, maxMs = 180_000): Promise<void> {
  const t0 = Date.now();
  let warned = false;
  for (;;) {
    let ok = false;
    try { await execFileP("nvidia-smi", ["-L"], { timeout: 10_000 }); ok = existsSync("/var/run/cdi/nvidia.yaml"); } catch { ok = false; }
    if (ok) { if (warned) log("GPU host ready"); return; }
    if (Date.now() - t0 > maxMs) throw new Error("GPU host not ready (nvidia-smi / CDI spec) after " + maxMs / 1000 + "s");
    if (!warned) { log("waiting for the host GPU driver and CDI spec (boot lag)"); warned = true; }
    await sleep(3000);
  }
}

/** UniRigLoadMesh's file list is scanned once when the container starts (comfy-env caches the isolated
 *  node's schema), so the rig stage always writes to a fixed input/rig-in.glb that must already exist at
 *  container start. Seed it with any valid GLB (the Phase 1 giraffe sample) if missing. */
export const RIG_INPUT = "rig-in.glb";
function ensureRigPlaceholder(log: (m: string) => void): void {
  const dst = join(config.comfyInput, RIG_INPUT);
  if (existsSync(dst)) return;
  const seed = join(config.comfyInput, "giraffe.glb");
  if (existsSync(seed)) {
    copyFileSync(seed, dst); log("seeded input/" + RIG_INPUT + " placeholder for the rig stage");
    // comfy-env caches the isolated node's schema (including UniRigLoadMesh's file list) in the persistent
    // env; drop it once so the next container start rescans and sees the placeholder.
    const cache = join(config.data, "comfy", "ce", "envs", "unirig-nodes", ".pixi", "envs", "default", ".metadata_cache.pkl");
    if (existsSync(cache)) { rmSync(cache); log("cleared comfy-env node metadata cache so the file list rescans"); }
  }
  else log("warning: no giraffe.glb to seed input/" + RIG_INPUT + "; rig jobs will fail validation until it exists at container start");
}

export async function ensureUp(log: (m: string) => void): Promise<void> {
  if (await isUp()) return;
  await waitForGpuHost(log);
  await guardFreeVram();
  ensureRigPlaceholder(log);
  log("starting comfyui container");
  const t0 = Date.now();
  await nerdctl(composeArgs("up", "-d", "comfyui"));
  for (let i = 0; i < 120; i++) {
    if (await isUp()) { log(`comfyui ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`); return; }
    await sleep(2000);
  }
  throw new Error("comfyui did not become ready within 240s");
}

/** Stop and wait for VRAM to drop back to baseline; ~10 s stop (SIGKILL after grace) + a short settle. */
export async function stop(log: (m: string) => void): Promise<VramState> {
  const t0 = Date.now();
  await nerdctl(composeArgs("stop", "comfyui"), 60_000);
  let v = await vram();
  for (let i = 0; i < 15 && v.usedMiB > 1024; i++) { await sleep(2000); v = await vram(); }
  log(`comfyui stopped in ${((Date.now() - t0) / 1000).toFixed(0)}s; VRAM used ${v.usedMiB} MiB`);
  return v;
}

export interface RunResult { promptId: string; outputs: Record<string, { images?: any[]; ["3d"]?: any[] }>; seconds: number }

/** Submit a workflow and follow it on the WebSocket until the history entry appears. */
export async function run(wf: Workflow, onProgress: OnProgress, timeoutMs = 3_600_000): Promise<RunResult> {
  const clientId = randomUUID();
  const titles: Record<string, string> = {};
  for (const [id, n] of Object.entries(wf)) titles[id] = n._meta?.title ?? n.class_type;
  const wsUrl = config.comfyUrl.replace(/^http/, "ws") + `/ws?clientId=${clientId}`;
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });

  const t0 = Date.now();
  const resp = await fetch(`${config.comfyUrl}/prompt`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: wf, client_id: clientId }),
  });
  const body: any = await resp.json();
  if (!resp.ok || body.error || (body.node_errors && Object.keys(body.node_errors).length)) {
    ws.close();
    const details = Object.entries(body.node_errors ?? {}).map(([id, e]: [string, any]) =>
      `${titles[id] ?? id}: ${(e.errors ?? []).map((x: any) => `${x.message} (${x.details})`).join("; ")}`).join(" | ");
    throw new Error(("ComfyUI rejected the workflow: " + (body.error?.message ?? JSON.stringify(body.error)) + (details ? " — " + details : "")).slice(0, 2000));
  }
  const promptId: string = body.prompt_id;

  let execError: string | null = null;
  let done = false;
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let m: any; try { m = JSON.parse(data.toString()); } catch { return; }
    const d = m.data ?? {};
    if (d.prompt_id && d.prompt_id !== promptId) return;
    if (m.type === "executing") {
      if (d.node === null && d.prompt_id === promptId) done = true;
      else if (d.node) onProgress({ node: d.node, title: titles[d.node] });
    } else if (m.type === "progress") {
      onProgress({ node: d.node, title: titles[d.node], value: d.value, max: d.max });
    } else if (m.type === "execution_error") {
      execError = `${d.node_type ?? ""} (${titles[d.node_id] ?? d.node_id}): ${d.exception_message ?? "error"}`;
      done = true;
    } else if (m.type === "execution_interrupted") { execError = "interrupted"; done = true; }
  });

  try {
    while (!done) {
      if (Date.now() - t0 > timeoutMs) throw new Error("workflow timed out");
      await sleep(500);
    }
    if (execError) throw new Error("workflow failed at " + execError);
    // History may lag the WS "executing:null" event by a moment.
    for (let i = 0; i < 20; i++) {
      const h: any = await (await fetch(`${config.comfyUrl}/history/${promptId}`)).json();
      if (h[promptId]) {
        const st = h[promptId].status ?? {};
        if (st.status_str === "error") throw new Error("workflow failed: " + JSON.stringify(st.messages).slice(0, 1000));
        return { promptId, outputs: h[promptId].outputs ?? {}, seconds: (Date.now() - t0) / 1000 };
      }
      await sleep(500);
    }
    throw new Error("workflow finished but no history entry appeared");
  } finally { ws.close(); }
}
