import type { RankedSkill } from "../ranking/index.js";

export interface AdapterContext {
  task: string;
  root: string;
  skills: RankedSkill[];
}

export interface AdapterResult {
  agent: string;
  filesWritten: string[];
  exposedSkills: string[];
  summary: string;
}

export interface AgentAdapter {
  readonly name: string;
  format(context: AdapterContext): Promise<string> | string;
  apply(context: AdapterContext): Promise<AdapterResult>;
}
