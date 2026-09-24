# Phase 3 — Review UI

Date: 2026-09-24. Host `k8s-gpu-1` (`ssh gpu`); Proxmox untouched. Branch `phase-3`.

## What was built

`forge-ui/` — **Nuxt 4.5 + Vuetify 4.2** (the spec says "Nuxt 3"; the 3.x line is in maintenance and everything current targets 4, same code for our purposes), Three.js 0.186 for the inline preview (the version Meadowbots pins), Material Design Icons. Seven source files, ~450 lines:

| File | What |
|---|---|
| `app/pages/index.vue` | job list as cards (thumbnail or live progress ring, status chip, stage, prompt, profile, seed, age), filters by status / game / profile, **new-job dialog** (type, prompt, profile picker, seed, height, candidate count, rig toggle disabled until Phase 4; full-screen on phones) |
| `app/pages/jobs/[id].vue` | job detail: status + progress, **Approve / Reject / Rerun** (same seed or new seed dialog), **download** GLB / FBX / sidecar, **inline 3D preview**, reference images (N candidates, the picked one outlined), sidecar summary (tris, verts, height, axes, textures, image/3D/post stages with seeds, models, licenses, profile hash), file list, log tail; polls every 2.5 s while the job runs |
| `app/components/ModelViewer.client.vue` | Three.js `GLTFLoader` + `MeshoptDecoder` (identical to Meadowbots' `Assets.js`), 1 m grid at y = 0, axes, orbit controls, camera framed on the front (−Z face); reports tris / height / feet-y back to the page |
| `app/components/GpuChip.vue` | app-bar chip from `/health`: "GPU idle" / "GPU warm 14 GB" / "GPU working 14 GB" / "API offline", 5 s poll |
| `app/composables/useApi.ts` | thin client over the §6 REST API, absolute origin (see gotcha below) |
| `app/plugins/vuetify.ts`, `nuxt.config.ts` | Vuetify via `vite-plugin-vuetify` (the `vuetify-nuxt-module` is still an RC); `ssr: false`, `app.baseURL: '/ui/'`, `nitro.preset: 'static'` |

**Deployment decision (deviation from the §3 service table):** the UI is a **static SPA served by forge-api** at `/ui/` (`@fastify/static`, `index.html` fallback for client routes, `/` redirects to `/ui/`), not a second always-on Nuxt server. Same origin → no CORS, one port behind Caddy, one fewer process to keep alive at boot. `deploy/build-ui.sh` on the VM runs `npm install` + `nuxt generate` (≈ 40 s, 5.3 MB output in `forge-ui/.output/public`) and restarts forge-api, which picks the files up if present and works without them. **Do not run it while a job is running** — the restart fails the job (the API marks it failed rather than resuming).

The UI talks only to forge-api (§6). No API changes were needed beyond serving the static files; the `/viewer` debug page from Phase 2 stays.

## Acceptance (§7): create, preview in 3D, approve/reject, rerun, download from a phone

Tested in the desktop app's built-in browser at **375 × 812 (phone emulation)** against `http://192.168.1.51:8080/ui/`, console clean on a fresh tab:

| Action | Result |
|---|---|
| Create | "New job" opens a full-screen form; prompt "a tiny purple mushroom sprite holding a lantern" → job `225af19a` queued behind the running rerun, page shows `queued · 0 %` with a live log |
| Preview in 3D | detail page renders the final GLB with meshopt in Three.js, orbit works by drag; caption "16,206 tris · height 0.600 m · feet at y = 0.0000" |
| Approve / Reject | Approve on the snail job `65bfca60` → chip `approved`, sidecar status updated; Reject stays available |
| Rerun | dialog with "Same seed" / "New seed" → new seed created job `01cc295a`, navigated to it, progress from `starting · 0 %` through refs / 3d / post live |
| Download | GLB / FBX / Sidecar buttons are direct `/assets/...` links (browser download); file list shows every output with size |

**From a phone on Tailscale** is Phil's check (needs the Caddy route below). Everything above is the same UI at phone width over the LAN.

## Caddy route (Phil applies, in LXC 106 `caddy`)

Append to `/etc/caddy/Caddyfile`, then `systemctl reload caddy`, plus a DNS record for `forge.gattonehq.com` → `192.168.1.2` (LAN) as for the other hosts:

```caddyfile
forge.gattonehq.com {
    @allowed remote_ip 192.168.1.0/24 100.64.0.0/10   # LAN + Tailscale CGNAT range; no public exposure (req §9)
    handle @allowed {
        reverse_proxy 192.168.1.51:8080
    }
    respond 403
}
```

`/` redirects to `/ui/`; the REST API is on the same host under `/jobs`, `/assets`, `/health`, so the `forge` CLI can use `FORGE_URL=https://forge.gattonehq.com` too.

## Gotchas found

- **Nuxt's `$fetch` prefixes relative URLs with `app.baseURL`** (`/ui/`), so `/health` became `/ui/health` and the SPA fallback returned `index.html` as "JSON". The client now uses `window.location.origin` (or a baked-in `apiBase`).
- `clearable` Vuetify selects show a clear icon for `""`, which squeezed the labels at phone width; filter defaults are `null`.
- Wheel-scrolling over the 3D canvas orbits instead of scrolling the page (OrbitControls captures it); touch scrolling works around the canvas. Acceptable for a review tool.
- Rebuilding the UI restarts forge-api; only do it between jobs.

## Not done / next

- Phase 4: `--rig` (the switch is present but disabled), `rig.json`, rigged GLB/FBX in the file list; the viewer already handles skinned meshes.
- Nice-to-haves left out on purpose: auth (LAN/Tailscale only per §9), bulk actions, job deletion, retention of the 630 MB `raw/` folders (still Phil's call from Phase 2).

## State-changing commands run (gpu only)

`npm install` in `forge-ui` and `forge-api` (`@fastify/static`), `nuxt generate` ×3, `systemctl restart forge-api` ×3 (between jobs), UI-driven jobs: approve `65bfca60`, rerun → `01cc295a`, create → `225af19a`. big-cat untouched; Proxmox untouched.
