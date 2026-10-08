import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export interface SkillGateConfig {
  version: 1;
  skillRoots: string[];
  candidateLimit: number;
  policyPath?: string;
  adapters: string[];
}

const keys = new Set(["version", "skillRoots", "candidateLimit", "policyPath", "adapters"]);

export function parseConfiguration(source: string, filename: string): SkillGateConfig {
  let parsed: unknown;
  try {
    parsed = filename.endsWith(".json") ? JSON.parse(source) : parseYaml(source, { uniqueKeys: true });
  } catch (error) {
    throw new ConfigurationError(`Invalid configuration in ${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigurationError(`${filename}: configuration must be an object`);
  }
  const data = parsed as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    if (!keys.has(key)) throw new ConfigurationError(`${filename}: unknown key "${key}"`);
  }
  if (data.version !== 1) throw new ConfigurationError(`${filename}: version must be 1`);
  const paths = data.skillRoots ?? ["."];
  const adapters = data.adapters ?? [];
  const limit = data.candidateLimit ?? 10;
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string" && p.trim().length > 0)) {
    throw new ConfigurationError(`${filename}: skillRoots must be an array of non-empty paths`);
  }
  if (!Array.isArray(adapters) || !adapters.every((a) => typeof a === "string" && a.trim().length > 0)) {
    throw new ConfigurationError(`${filename}: adapters must be an array of non-empty names`);
  }
  if (!Number.isSafeInteger(limit) || (limit as number) < 1) {
    throw new ConfigurationError(`${filename}: candidateLimit must be a positive integer`);
  }
  if (data.policyPath !== undefined && (typeof data.policyPath !== "string" || !data.policyPath.trim())) {
    throw new ConfigurationError(`${filename}: policyPath must be a non-empty path`);
  }
  const base = dirname(resolve(filename));
  const absolute = (p: string) => isAbsolute(p) ? p : resolve(base, p);
  return {
    version: 1,
    skillRoots: (paths as string[]).map(absolute),
    candidateLimit: limit as number,
    ...(data.policyPath === undefined ? {} : { policyPath: absolute(data.policyPath as string) }),
    adapters: adapters as string[],
  };
}

export async function loadConfiguration(filename: string): Promise<SkillGateConfig> {
  let content: string;
  try {
    content = await readFile(filename, "utf8");
  } catch (error) {
    throw new ConfigurationError(`Cannot read configuration ${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfiguration(content, filename);
}
