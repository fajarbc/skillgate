import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterContext, AdapterResult, AgentAdapter } from "./types.js";

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex";

  async format(context: AdapterContext): Promise<string> {
    const lines: string[] = [
      "# Skills for OpenAI Codex",
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

  async apply(context: AdapterContext): Promise<AdapterResult> {
    const codexDir = join(context.root, ".codex");
    const skillsDir = join(codexDir, "skills");
    await mkdir(skillsDir, { recursive: true });

    const filesWritten: string[] = [];
    const exposedSkills: string[] = [];

    for (const skill of context.skills) {
      const destDir = join(skillsDir, skill.metadata.name);
      await mkdir(destDir, { recursive: true });
      const destFile = join(destDir, "SKILL.md");

      let content = "";
      try {
        content = await readFile(skill.path, "utf8");
      } catch {
        content = `---\nname: ${skill.metadata.name}\ndescription: ${skill.metadata.description}\n---\n`;
      }

      await writeFile(destFile, content, "utf8");
      filesWritten.push(destFile);
      exposedSkills.push(skill.metadata.name);
    }

    const manifestPath = join(codexDir, "skills.json");
    const manifest = {
      task: context.task,
      updatedAt: new Date().toISOString(),
      skills: context.skills.map((s) => ({
        name: s.metadata.name,
        description: s.metadata.description,
        path: s.path,
        score: s.score,
        capabilities: s.metadata.capabilities ?? [],
      })),
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    filesWritten.push(manifestPath);

    return {
      agent: this.name,
      filesWritten,
      exposedSkills,
      summary: `Exposed ${exposedSkills.length} skills to .codex/skills/`,
    };
  }
}
