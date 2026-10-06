import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseSkillMetadata } from "./parse.js";
import type { DiscoveredSkill, DiscoveryOptions } from "./types.js";

const DEFAULT_IGNORES = new Set([".git", "node_modules"]);

export async function discoverSkills(options: DiscoveryOptions): Promise<DiscoveredSkill[]> {
  const ignored = new Set([...DEFAULT_IGNORES, ...(options.ignoredDirectories ?? [])]);
  const paths: string[] = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await walk(path);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        paths.push(resolve(path));
      }
    }
  }

  for (const root of [...new Set(options.roots.map(resolve))].sort()) {
    await walk(root);
  }

  const results = await Promise.all(
    [...new Set(paths)].sort().map(async (path): Promise<DiscoveredSkill> => {
      try {
        const source = await readFile(path, "utf8");
        return { path, metadata: parseSkillMetadata(source) };
      } catch (error) {
        return {
          path,
          error: error instanceof Error ? error.message : "unable to read skill",
        };
      }
    }),
  );

  return results;
}
