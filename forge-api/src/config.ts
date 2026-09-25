// Runtime configuration from the environment (.env is loaded by systemd via EnvironmentFile).
import { resolve } from "node:path";

const env = (k: string, d: string) => process.env[k] && process.env[k] !== "" ? (process.env[k] as string) : d;

export const config = {
  data: env("FORGE_DATA", "/srv/forge"),
  port: Number(env("FORGE_PORT", "8080")),
  host: env("FORGE_HOST", "0.0.0.0"),
  repo: env("FORGE_REPO", "/srv/forge/src/asset-forge"),
  comfyUrl: env("FORGE_COMFY_URL", "http://127.0.0.1:8188"),
  comfyOutput: env("FORGE_COMFY_OUTPUT", "/srv/forge/comfy/output"),
  comfyInput: env("FORGE_COMFY_INPUT", "/srv/forge/comfy/input"),
  idleTimeoutSec: Number(env("FORGE_GPU_IDLE_TIMEOUT", "600")),
  minFreeVramGb: Number(env("FORGE_MIN_FREE_VRAM_GB", "80")),
  nerdctl: env("FORGE_NERDCTL", "sudo nerdctl").split(" "),
  svcPostImage: env("FORGE_SVC_POST_IMAGE", "forge/svc-post:0.1.0"),
  svcAudioImage: env("FORGE_SVC_AUDIO_IMAGE", "forge/svc-audio:0.1.0"),
  version: "0.1.0",
};
export const paths = {
  compose: resolve(config.repo, "compose.yaml"),
  workflows: resolve(config.repo, "workflows"),
  profiles: resolve(config.repo, "profiles"),
  jobs: resolve(config.data, "jobs"),
  uploads: resolve(config.data, "uploads"),
  db: resolve(config.data, "db", "forge.sqlite"),
};
