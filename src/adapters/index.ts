import { CodexAdapter } from "./codex.js";
import type { AgentAdapter } from "./types.js";

export type { AdapterContext, AdapterResult, AgentAdapter } from "./types.js";
export { CodexAdapter } from "./codex.js";

const ADAPTERS: Record<string, () => AgentAdapter> = {
  codex: () => new CodexAdapter(),
};

export function getAdapter(name: string): AgentAdapter | undefined {
  const factory = ADAPTERS[name.toLowerCase()];
  return factory ? factory() : undefined;
}

export function listAdapters(): string[] {
  return Object.keys(ADAPTERS);
}
