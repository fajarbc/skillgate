import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { prepareSafeSkillPaths, resolveSafeSubpath } from "./safe-path.js";
import type { AdapterContext, AdapterPlan, AdapterResult, AgentAdapter } from "./types.js";

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

  async plan(context: AdapterContext): Promise<AdapterPlan> {
    const agentDir = resolveSafeSubpath(context.root, ".claude");
    const skillsDir = resolveSafeSubpath(agentDir, "skills");
    const prepared = prepareSafeSkillPaths(context.skills, skillsDir);
    const filesToWrite = prepared.map(({ dirPath }) => resolveSafeSubpath(dirPath, "SKILL.md"));
    filesToWrite.push(resolveSafeSubpath(agentDir, "skills.json"));
    const conflicts: string[] = [];
    for (const path of filesToWrite) {
      try {
        await lstat(path);
        conflicts.push(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return { agent: "claude-code", filesToWrite, filesToRemove: [], conflicts };
  }

  async apply(context: AdapterContext): Promise<AdapterResult> {
    const plan = await this.plan(context);
    if (plan.conflicts.length > 0) {
      throw new Error(`Refusing to overwrite existing adapter files: ${plan.conflicts.join(", ")}`);
    }
    const claudeDir = resolveSafeSubpath(context.root, ".claude");
    const skillsDir = resolveSafeSubpath(claudeDir, "skills");
    await mkdir(skillsDir, { recursive: true });

    const preparedSkills = prepareSafeSkillPaths(context.skills, skillsDir);
    const filesWritten: string[] = [];
    const exposedSkills: string[] = [];

    for (const { skill, safeId, dirPath } of preparedSkills) {
      await mkdir(dirPath, { recursive: true });
      const destFile = resolveSafeSubpath(dirPath, "SKILL.md");

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

    const manifestPath = resolveSafeSubpath(claudeDir, "skills.json");
    const manifest = {
      task: context.task,
      updatedAt: new Date().toISOString(),
      skills: preparedSkills.map(({ skill, safeId }) => ({
        name: skill.metadata.name,
        identifier: safeId,
        description: skill.metadata.description,
        path: skill.path,
        score: skill.score,
        capabilities: skill.metadata.capabilities ?? [],
      })),
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    filesWritten.push(manifestPath);

    return {
      agent: this.name,
      filesWritten,
      exposedSkills,
      summary: `Exposed ${exposedSkills.length} skills to .claude/skills/`,
    };
  }
}
