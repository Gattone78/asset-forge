import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { paths } from "./config.ts";

export interface Profile {
  name: string; game: string; style_prompt: string; negative_prompt: string;
  image: { count: number; size: number; steps: number; views?: "front" | "multi" };
  mesh: { target_tris: number; max_tris?: number; max_texture: number; material: string; normalize: boolean;
          target_height_m: number; forward_yaw_deg?: number; compression: string; resolution?: number };
  rig: { default: boolean };
  formats: string[];
  _hash: string; _path: string;
}
export function loadProfile(name: string): Profile {
  const p = join(paths.profiles, `${name}.yaml`);
  const raw = readFileSync(p);
  const y = YAML.parse(raw.toString("utf8"));
  return { ...y, _hash: createHash("sha256").update(raw).digest("hex"), _path: p };
}
export function listProfiles(): { name: string; game: string; file: string }[] {
  return readdirSync(paths.profiles).filter((f) => f.endsWith(".yaml")).map((f) => {
    const y = YAML.parse(readFileSync(join(paths.profiles, f), "utf8"));
    return { name: y.name, game: y.game, file: f };
  });
}
