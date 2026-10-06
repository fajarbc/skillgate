import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DetectionOptions, ProjectSignal } from "./types.js";

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function dependencies(manifest: Record<string, unknown>): Set<string> {
  const result = new Set<string>();
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    const group = manifest[key];
    if (group && typeof group === "object" && !Array.isArray(group)) {
      for (const name of Object.keys(group)) result.add(name);
    }
  }
  return result;
}

export async function detectProject(options: DetectionOptions): Promise<ProjectSignal[]> {
  const root = options.root;
  const signals: ProjectSignal[] = [];
  const add = (kind: ProjectSignal["kind"], name: string, evidence: string): void => {
    if (!signals.some((signal) => signal.kind === kind && signal.name === name)) {
      signals.push({ kind, name, evidence });
    }
  };

  const packagePath = join(root, "package.json");
  if (await isFile(packagePath)) {
    add("language", "javascript", "package.json");
    add("runtime", "node", "package.json");
    const manifest = await readJson(packagePath);
    if (manifest) {
      const deps = dependencies(manifest);
      if (deps.has("typescript")) add("language", "typescript", "package.json dependency: typescript");
      if (deps.has("next")) add("framework", "nextjs", "package.json dependency: next");
      if (deps.has("react")) add("framework", "react", "package.json dependency: react");
      if (deps.has("vitest")) add("tool", "vitest", "package.json dependency: vitest");
      if (deps.has("jest")) add("tool", "jest", "package.json dependency: jest");
    }
  }

  const simpleFiles: Array<[string, ProjectSignal["kind"], string]> = [
    ["pyproject.toml", "language", "python"],
    ["Cargo.toml", "language", "rust"],
    ["go.mod", "language", "go"],
    ["composer.json", "language", "php"],
    ["Dockerfile", "tool", "docker"],
  ];
  for (const [file, kind, name] of simpleFiles) {
    if (await isFile(join(root, file))) add(kind, name, file);
  }

  const testConfigs: Array<[string, string]> = [
    ["vitest.config.ts", "vitest"],
    ["vitest.config.js", "vitest"],
    ["jest.config.ts", "jest"],
    ["jest.config.js", "jest"],
    ["pytest.ini", "pytest"],
  ];
  for (const [file, tool] of testConfigs) {
    if (await isFile(join(root, file))) add("tool", tool, file);
  }

  return signals.sort((a, b) =>
    `${a.kind}:${a.name}:${a.evidence}`.localeCompare(`${b.kind}:${b.name}:${b.evidence}`),
  );
}
