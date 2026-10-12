import {
  applyFilesystemAdapter,
  cleanupFilesystemAdapter,
  planFilesystemAdapter,
} from "./filesystem-lifecycle.js";
import type {
  AdapterContext,
  AdapterPlan,
  AdapterResult,
  AgentAdapter,
  CleanupResult,
  LifecycleOptions,
} from "./types.js";

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude-code";

  async format(context: AdapterContext): Promise<string> {
    const lines: string[] = [
      "# Skills for Claude Code",
      "",
      `Task: ${context.task}`,
      "",
      `Available Skills (${context.skills.length}):`,
    ];

    for (const skill of context.skills) {
      lines.push("");
      lines.push(`## ${skill.metadata.name}`);
      lines.push(`Description: ${skill.metadata.description}`);
      lines.push(`Path: ${skill.path}`);
      if (skill.metadata.capabilities && skill.metadata.capabilities.length > 0) {
        lines.push(`Capabilities: ${skill.metadata.capabilities.join(", ")}`);
      }
    }

    return lines.join("\n");
  }

  async plan(context: AdapterContext, options?: LifecycleOptions): Promise<AdapterPlan> {
    return planFilesystemAdapter(this.name, ".claude", context, options);
  }

  async apply(context: AdapterContext, options?: LifecycleOptions): Promise<AdapterResult> {
    return applyFilesystemAdapter(this.name, ".claude", context, options);
  }

  async cleanup(context: AdapterContext, options?: LifecycleOptions): Promise<CleanupResult> {
    return cleanupFilesystemAdapter(this.name, ".claude", context, options);
  }
}
