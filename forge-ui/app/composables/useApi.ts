// Thin client over forge-api (req §6). Same origin: the SPA is served by forge-api at /ui/.
export interface JobRequest { type: string; prompt: string; profile: string; seed: number; rig: boolean; count: number; height_m?: number; views?: string; rerun_of?: string; batch?: string; image?: { kind?: string; transparent?: boolean; seamless?: boolean; size?: number } }
export interface Job { id: string; status: string; stage: string; progress: number; error: string | null; request: JobRequest; result: any; created_at: string; updated_at: string }
export interface Health { ok: boolean; version: string; worker_busy: boolean; queue: Record<string, number>; gpu: { comfyui_up: boolean; container: string; vram_used_mib: number | null; vram_free_mib: number | null; idle_stop_at: string | null; idle_timeout_s: number } }
export interface Assets { id: string; status: string; files: { path: string; bytes: number }[]; sidecar: any }

export const ACTIVE = new Set(["queued", "running"]);
export const STATUS_COLOR: Record<string, string> = { queued: "grey", running: "blue", review: "orange", approved: "green", rejected: "red", failed: "error" };

export function useApi() {
  // Nuxt's $fetch prefixes relative URLs with app.baseURL (/ui/), which would hit the SPA fallback,
  // so the API base must be an absolute origin. Same origin unless FORGE_UI_API_BASE was baked in.
  const cfg = useRuntimeConfig().public.apiBase as string;
  const base = cfg || (typeof window !== "undefined" ? window.location.origin : "");
  const j = <T,>(path: string, opts: any = {}) => $fetch<T>(base + path, opts);
  return {
    health: () => j<Health>("/health"),
    profiles: () => j<{ name: string; game: string; file: string }[]>("/profiles"),
    jobs: (q: Record<string, string> = {}) => j<Job[]>("/jobs", { query: q }),
    job: (id: string) => j<Job>(`/jobs/${id}`),
    assets: (id: string) => j<Assets>(`/jobs/${id}/assets`),
    log: (id: string) => $fetch<string>(base + `/jobs/${id}/log`, { responseType: "text" }),
    create: (body: Partial<JobRequest>) => j<Job>("/jobs", { method: "POST", body }),
    approve: (id: string) => j<Job>(`/jobs/${id}/approve`, { method: "POST", body: {} }),
    reject: (id: string) => j<Job>(`/jobs/${id}/reject`, { method: "POST", body: {} }),
    rerun: (id: string, seed?: number) => j<Job>(`/jobs/${id}/rerun`, { method: "POST", body: seed === undefined ? {} : { seed } }),
    assetUrl: (id: string, path: string) => `${base}/assets/${id}/${path}`,
  };
}

export const short = (id: string) => id.slice(0, 8);
export const fmtBytes = (b: number) => (b >= 1e6 ? (b / 1e6).toFixed(2) + " MB" : b >= 1e3 ? (b / 1e3).toFixed(0) + " KB" : b + " B");
export const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
