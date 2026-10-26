import type { RankedSkill } from "../ranking/index.js";

export interface AdapterContext {
  task: string;
  root: string;
  skills: RankedSkill[];
  options?: Readonly<Record<string, string | number | boolean>>;
}

export interface LifecycleOptions {
  force?: boolean;
  /** Reject mutation unless strict external-writer atomicity is implemented. */
  concurrency?: "cooperative" | "strict";
}

export interface AdapterPlan {
  agent: string;
  writes: string[];
  removals: string[];
  conflicts: string[];
  skills: string[];
  summary: string;
}

export interface AdapterResult {
  agent: string;
  filesWritten: string[];
  filesRemoved?: string[];
  exposedSkills: string[];
  summary: string;
}

export interface CleanupResult {
  agent: string;
  filesRemoved: string[];
  summary: string;
}

export interface AgentAdapter {
  readonly name: string;
  format(context: AdapterContext): Promise<string> | string;
  plan(context: AdapterContext, options?: LifecycleOptions): Promise<AdapterPlan>;
  apply(context: AdapterContext, options?: LifecycleOptions): Promise<AdapterResult>;
  cleanup(context: AdapterContext, options?: LifecycleOptions): Promise<CleanupResult>;
}
