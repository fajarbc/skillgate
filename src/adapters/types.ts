import type { RankedSkill } from "../ranking/index.js";

export interface AdapterContext {
  task: string;
  root: string;
  skills: RankedSkill[];
  options?: Readonly<Record<string, string | number | boolean>>;
}

export interface AdapterResult {
  agent: string;
  filesWritten: string[];
  exposedSkills: string[];
  summary: string;
}

/** A read-only preview of an adapter's intended workspace changes. */
export interface AdapterPlan {
  agent: string;
  filesToWrite: string[];
  filesToRemove: string[];
  conflicts: string[];
}

export interface AgentAdapter {
  readonly name: string;
  format(context: AdapterContext): Promise<string> | string;
  plan?(context: AdapterContext): Promise<AdapterPlan>;
  apply(context: AdapterContext): Promise<AdapterResult>;
  cleanup?(context: AdapterContext): Promise<AdapterResult>;
}
