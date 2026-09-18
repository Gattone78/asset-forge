// API-format ComfyUI workflows are committed JSON; nodes are addressed by their _meta.title, never by id.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./config.ts";

export type Workflow = Record<string, { class_type: string; _meta?: { title?: string }; inputs: Record<string, unknown> }>;

export function loadWorkflow(name: string): Workflow {
  return JSON.parse(readFileSync(join(paths.workflows, name), "utf8"));
}
export function nodeByTitle(wf: Workflow, title: string): [string, Workflow[string]] {
  const hits = Object.entries(wf).filter(([, n]) => n._meta?.title === title);
  if (hits.length !== 1) throw new Error(`workflow node title "${title}": expected 1 match, found ${hits.length}`);
  return hits[0];
}
export function setInput(wf: Workflow, title: string, input: string, value: unknown): void {
  const [, node] = nodeByTitle(wf, title);
  if (!(input in node.inputs)) throw new Error(`node "${title}" has no input "${input}"`);
  node.inputs[input] = value;
}
export function setAll(wf: Workflow, titles: string[], input: string, value: unknown): void {
  for (const t of titles) setInput(wf, t, input, value);
}
export function outputNodes(wf: Workflow): string[] {
  return Object.entries(wf).filter(([, n]) => /^(SaveImage|SaveGLB|Save3DAdvanced)$/.test(n.class_type)).map(([id]) => id);
}
