#!/usr/bin/env node
// forge — thin CLI over forge-api (req §6). FORGE_URL points at the API (default http://192.168.1.51:8080).
//   forge job creature "prompt" [--profile meadowbots-flat] [--seed N] [--count 4] [--height 0.6] [--views front|multi] [--rig]
//   forge status <id> | forge watch <id> | forge list [--status review] | forge get <id> [dir] [--all]
//   forge approve <id> | forge reject <id> | forge rerun <id> [--seed N] | forge health | forge profiles
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const URL_ = process.env.FORGE_URL ?? "http://192.168.1.51:8080";
const argv = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) { const k = argv[i].slice(2); if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[k] = argv[++i]; else flags[k] = true; }
  else pos.push(argv[i]);
}
const api = async (path, opts = {}) => {
  const r = await fetch(URL_ + path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers ?? {}) } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) { console.error(`HTTP ${r.status}:`, typeof body === "string" ? body : JSON.stringify(body)); process.exit(1); }
  return body;
};
const short = (id) => id.slice(0, 8);
const fmtJob = (j) => `${short(j.id)}  ${j.status.padEnd(8)} ${j.stage.padEnd(9)} ${(j.progress * 100).toFixed(0).padStart(3)}%  seed=${j.request.seed}  ${j.request.profile}  "${j.request.prompt}"${j.error ? "\n    error: " + j.error : ""}`;
const die = (m) => { console.error(m); process.exit(2); };

const [cmd, sub, ...rest] = pos;
switch (cmd) {
  case "job": {
    if (!["creature", "prop", "plant"].includes(sub)) die("usage: forge job creature|prop|plant \"prompt\" [--profile P] [--seed N] [--count N] [--height M] [--views front|multi] [--rig]");
    const prompt = rest.join(" "); if (!prompt) die("prompt required");
    const body = { type: sub, prompt, profile: flags.profile ?? "meadowbots-flat", seed: flags.seed !== undefined ? Number(flags.seed) : undefined,
      count: flags.count ? Number(flags.count) : undefined, height_m: flags.height ? Number(flags.height) : undefined, views: flags.views, rig: !!flags.rig };
    const j = await api("/jobs", { method: "POST", body: JSON.stringify(body) });
    console.log(j.id); break;
  }
  case "status": { if (!sub) die("usage: forge status <id>"); console.log(fmtJob(await api(`/jobs/${sub}`))); break; }
  case "watch": {
    if (!sub) die("usage: forge watch <id>");
    let last = "";
    for (;;) {
      const j = await api(`/jobs/${sub}`);
      const line = fmtJob(j);
      if (line !== last) { console.log(new Date().toTimeString().slice(0, 8), line); last = line; }
      if (["review", "approved", "rejected", "failed"].includes(j.status)) { if (j.result?.files) console.log("files:", j.result.files.join(", ")); process.exit(j.status === "failed" ? 1 : 0); }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  case "list": {
    const q = new URLSearchParams(); if (flags.status) q.set("status", flags.status); if (flags.profile) q.set("profile", flags.profile);
    for (const j of await api(`/jobs?${q}`)) console.log(fmtJob(j)); break;
  }
  case "get": {
    if (!sub) die("usage: forge get <id> [dir] [--all]");
    const a = await api(`/jobs/${sub}/assets`);
    const dir = rest[0] ?? `./${short(sub)}`; mkdirSync(dir, { recursive: true });
    const want = a.files.filter((f) => flags.all || f.path.startsWith("out/"));
    for (const f of want) {
      const r = await fetch(`${URL_}/assets/${sub}/${f.path}`); if (!r.ok) die(`download failed: ${f.path}`);
      const dst = join(dir, f.path.replace(/^out\//, "")); mkdirSync(join(dst, ".."), { recursive: true });
      writeFileSync(dst, Buffer.from(await r.arrayBuffer())); console.log(`${dst}  ${(f.bytes / 1e6).toFixed(2)} MB`);
    }
    break;
  }
  case "approve": case "reject": { if (!sub) die(`usage: forge ${cmd} <id>`); console.log(fmtJob(await api(`/jobs/${sub}/${cmd}`, { method: "POST", body: "{}" }))); break; }
  case "rerun": { if (!sub) die("usage: forge rerun <id> [--seed N]"); const j = await api(`/jobs/${sub}/rerun`, { method: "POST", body: JSON.stringify(flags.seed !== undefined ? { seed: Number(flags.seed) } : {}) }); console.log(j.id); break; }
  case "health": console.log(JSON.stringify(await api("/health"), null, 1)); break;
  case "profiles": for (const p of await api("/profiles")) console.log(`${p.name}  (${p.game})  ${p.file}`); break;
  default: die("commands: job, status, watch, list, get, approve, reject, rerun, health, profiles");
}
