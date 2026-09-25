#!/usr/bin/env node
// forge — thin CLI over forge-api (req §6). FORGE_URL points at the API (default http://192.168.1.51:8080).
//   forge job creature "prompt" [--profile meadowbots-flat] [--seed N] [--count 4] [--height 0.6] [--views front|multi] [--rig] [--batch L]
//   forge job image "prompt" [--kind sprite|texture|tile] [--transparent|--opaque] [--seamless|--no-seamless] [--size 1024] [--count 4]
//   forge job batch plants.yaml   (keys: type, profile, seed, batch, rig, count, kind, transparent, seamless, prompts: [- ...]; or one prompt per line)
//   forge status <id> | forge watch <id> | forge list [--status review] [--batch L] [--type image] | forge get <id> [dir] [--all]
//   forge approve <id> | forge reject <id> | forge rerun <id> [--seed N] | forge batches | forge health | forge profiles
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

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
const fmtJob = (j) => `${short(j.id)}  ${j.status.padEnd(8)} ${j.stage.padEnd(9)} ${(j.progress * 100).toFixed(0).padStart(3)}%  seed=${j.request.seed}  ${j.request.profile}${j.request.batch ? "  [" + j.request.batch + "]" : ""}  "${j.request.prompt}"${j.error ? "\n    error: " + j.error : ""}`;
const die = (m) => { console.error(m); process.exit(2); };

// Minimal batch-file reader: `key: value` lines plus a `prompts:` list of `- item` lines (a YAML subset),
// or a plain text file with one prompt per line. No dependencies.
function readBatch(file) {
  const text = readFileSync(file, "utf8");
  const spec = { type: "creature", profile: "meadowbots-flat", prompts: [] };
  const unquote = (v) => v.replace(/^["']|["']$/g, "");
  let inPrompts = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && inPrompts) { spec.prompts.push(unquote(item[1])); continue; }
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv) {
      const [, k, v] = kv;
      if (k === "prompts") { inPrompts = true; continue; }
      inPrompts = false;
      const u = unquote(v);
      spec[k] = u === "true" ? true : u === "false" ? false : u;
      continue;
    }
    if (!line.includes(":")) spec.prompts.push(line.trim());
  }
  if (!spec.prompts.length) die("no prompts found in " + file);
  return spec;
}

const [cmd, sub, ...rest] = pos;
switch (cmd) {
  case "job": {
    if (sub === "batch") {
      const file = rest[0]; if (!file) die("usage: forge job batch <file.yaml>");
      const spec = readBatch(file);
      const label = spec.batch ?? `${basename(file).replace(/\.[^.]+$/, "")}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
      const base = spec.seed !== undefined ? Number(spec.seed) : Math.floor(Math.random() * 2 ** 30);
      console.log(`batch ${label}: ${spec.prompts.length} job(s), profile ${spec.profile}, type ${spec.type}, seeds ${base}..${base + spec.prompts.length - 1}`);
      for (let i = 0; i < spec.prompts.length; i++) {
        const body = { type: spec.type, prompt: spec.prompts[i], profile: spec.profile, seed: base + i, batch: label, rig: !!spec.rig,
          count: spec.count ? Number(spec.count) : undefined, height_m: spec.height_m ? Number(spec.height_m) : undefined,
          image: spec.type === "image" ? { kind: spec.kind, transparent: spec.transparent, seamless: spec.seamless, size: spec.size ? Number(spec.size) : undefined } : undefined };
        const j = await api("/jobs", { method: "POST", body: JSON.stringify(body) });
        console.log(`  ${short(j.id)}  seed=${base + i}  "${spec.prompts[i]}"`);
      }
      break;
    }
    if (sub === "trailer") {
      const file = rest[0]; if (!file) die("usage: forge job trailer <file.yaml>   (keys: title, subtitle, profile, xfade_s, card_s, clips: [- job id ...])");
      const spec = readBatch(file);
      // Phase 7: `music: <music job id>` and `narration: <speech job id>@<seconds>[, …]`
      const narration = spec.narration ? String(spec.narration).split(",").map((s) => { const [speech, at] = s.trim().split("@"); return { speech, at_s: Number(at ?? 0) }; }) : undefined;
      const body = { type: "trailer", profile: spec.profile, prompt: spec.title ? `trailer: ${spec.title}` : undefined,
        trailer: { clips: spec.prompts, title: spec.title, subtitle: spec.subtitle, xfade_s: spec.xfade_s ? Number(spec.xfade_s) : undefined, card_s: spec.card_s ? Number(spec.card_s) : undefined,
          music: spec.music, music_db: spec.music_db !== undefined ? Number(spec.music_db) : undefined, narration } };
      const j = await api("/jobs", { method: "POST", body: JSON.stringify(body) });
      console.log(j.id); break;
    }
    if (sub === "foley") {
      const clip = rest[0]; if (!clip) die('usage: forge job foley <video job id> ["what it should sound like"] [--seed N] [--profile P]');
      const body = { type: "foley", prompt: rest.slice(1).join(" "), profile: flags.profile ?? "meadowbots-flat", seed: flags.seed !== undefined ? Number(flags.seed) : undefined, batch: flags.batch, audio: { clip } };
      const j = await api("/jobs", { method: "POST", body: JSON.stringify(body) });
      console.log(j.id); break;
    }
    if (!["creature", "prop", "plant", "image", "video", "sfx", "music", "speech"].includes(sub)) die('usage: forge job creature|prop|plant|image|video|sfx|music|speech "prompt" [--profile P] [--seed N] [--count N] [--height M] [--views front|multi] [--rig] [--batch L]\n       forge job image "prompt" [--kind sprite|texture|tile] [--transparent|--opaque] [--seamless|--no-seamless] [--size N]\n       forge job video "prompt" [--duration 5] [--fps 16] [--aspect 16:9|9:16] [--init <jobid[/path]>] [--slow]\n       forge job sfx "prompt" [--duration 4] [--count 4] [--stereo]      forge job music "prompt" [--duration 30] [--loop] [--bpm N] [--key "C major"]\n       forge job speech "text" [--voice af_heart] [--speed 1.0]           forge job foley <video job id> ["prompt"]\n       forge job batch <file.yaml> | forge job trailer <file.yaml>');
    const prompt = rest.join(" "); if (!prompt) die("prompt required");
    const body = { type: sub, prompt, profile: flags.profile ?? "meadowbots-flat", seed: flags.seed !== undefined ? Number(flags.seed) : undefined,
      count: flags.count ? Number(flags.count) : undefined, height_m: flags.height ? Number(flags.height) : undefined, views: flags.views, rig: !!flags.rig, batch: flags.batch };
    if (sub === "image") body.image = { kind: flags.kind, transparent: flags.transparent ? true : flags.opaque ? false : undefined,
      seamless: flags.seamless ? true : flags["no-seamless"] ? false : undefined, size: flags.size ? Number(flags.size) : undefined };
    if (sub === "video") body.video = { duration_s: flags.duration ? Number(flags.duration) : undefined, fps: flags.fps ? Number(flags.fps) : undefined,
      aspect: flags.aspect, init_image: flags.init, fast: flags.slow ? false : undefined };
    if (["sfx", "music", "speech"].includes(sub)) body.audio = { duration_s: flags.duration ? Number(flags.duration) : undefined, count: flags.count ? Number(flags.count) : undefined,
      loop: !!flags.loop, bpm: flags.bpm ? Number(flags.bpm) : undefined, key: flags.key, voice: flags.voice, speed: flags.speed ? Number(flags.speed) : undefined,
      channels: flags.stereo ? "stereo" : flags.mono ? "mono" : undefined };
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
    const q = new URLSearchParams();
    if (flags.status) q.set("status", flags.status); if (flags.profile) q.set("profile", flags.profile); if (flags.batch) q.set("batch", flags.batch); if (flags.type) q.set("type", flags.type);
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
  case "batches": for (const b of await api("/batches")) console.log(`${b.batch}  ${b.n} job(s)  ${b.first}`); break;
  case "health": console.log(JSON.stringify(await api("/health"), null, 1)); break;
  case "profiles": for (const p of await api("/profiles")) console.log(`${p.name}  (${p.game})  ${p.file}`); break;
  default: die("commands: job (creature|prop|plant|image|video|sfx|music|speech|foley|batch|trailer), status, watch, list, get, approve, reject, rerun, batches, health, profiles");
}
