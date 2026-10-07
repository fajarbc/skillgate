import { ClaudeCodeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import type { AgentAdapter } from "./types.js";

export type { AdapterContext, AdapterResult, AgentAdapter } from "./types.js";
export { ClaudeCodeAdapter } from "./claude.js";
export { CodexAdapter } from "./codex.js";

const ADAPTERS: Record<string, () => AgentAdapter> = {
  codex: () => new CodexAdapter(),
  claude: () => new ClaudeCodeAdapter(),
  "claude-code": () => new ClaudeCodeAdapter(),
};

export function getAdapter(name: string): AgentAdapter | undefined {
  const factory = ADAPTERS[name.toLowerCase()];
  return factory ? factory() : undefined;
}

export function listAdapters(): string[] {
  return [...new Set(Object.keys(ADAPTERS))];
}
