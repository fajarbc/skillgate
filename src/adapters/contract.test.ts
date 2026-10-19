import { ClaudeCodeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { getAdapter, listAdapters } from "./index.js";
import { runAdapterContractSuite } from "./testing/adapter-contract.test.js";
import { describe, expect, it } from "vitest";

runAdapterContractSuite({
  label: "Codex",
  createAdapter: () => new CodexAdapter(),
  managedDirectory: ".codex",
  expectedAgent: "codex",
});

runAdapterContractSuite({
  label: "Claude Code",
  createAdapter: () => new ClaudeCodeAdapter(),
  managedDirectory: ".claude",
  expectedAgent: "claude-code",
});

describe("adapter registry contract", () => {
  it("lists canonical names and aliases", () => {
    expect(listAdapters()).toEqual(["codex", "claude", "claude-code"]);
    expect(getAdapter("codex")?.name).toBe("codex");
    expect(getAdapter("claude")?.name).toBe("claude-code");
    expect(getAdapter("CLAUDE-CODE")?.name).toBe("claude-code");
    expect(getAdapter("unknown")).toBeUndefined();
  });
});
