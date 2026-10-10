import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

export function parseConfiguration(source: string, filename: string): Partial<SkillGateConfig> & { version: 1 } {
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
  const paths = data.skillRoots;
  const adapters = data.adapters;
  const limit = data.candidateLimit;
  if (paths !== undefined && (!Array.isArray(paths) || !paths.every((p) => typeof p === "string" && p.trim().length > 0))) {
    throw new ConfigurationError(`${filename}: skillRoots must be an array of non-empty paths`);
  }
  if (adapters !== undefined && (!Array.isArray(adapters) || !adapters.every((a) => typeof a === "string" && a.trim().length > 0))) {
    throw new ConfigurationError(`${filename}: adapters must be an array of non-empty names`);
  }
  if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1)) {
    throw new ConfigurationError(`${filename}: candidateLimit must be a positive integer`);
  }
  if (data.policyPath !== undefined && (typeof data.policyPath !== "string" || !data.policyPath.trim())) {
    throw new ConfigurationError(`${filename}: policyPath must be a non-empty path`);
  }
  const base = dirname(resolve(filename));
  const absolute = (p: string) => isAbsolute(p) ? p : resolve(base, p);
  return {
    version: 1,
    ...(paths === undefined ? {} : { skillRoots: (paths as string[]).map(absolute) }),
    ...(limit === undefined ? {} : { candidateLimit: limit as number }),
    ...(data.policyPath === undefined ? {} : { policyPath: absolute(data.policyPath as string) }),
    ...(adapters === undefined ? {} : { adapters: adapters as string[] }),
  };
}

export async function loadConfiguration(filename: string): Promise<Partial<SkillGateConfig> & { version: 1 }> {
  let content: string;
  try {
    content = await readFile(filename, "utf8");
  } catch (error) {
    throw new ConfigurationError(`Cannot read configuration ${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfiguration(content, filename);
}

/**
 * Explicit CLI config overrides project config, which overrides user config.
 * Omitted settings inherit from lower-priority sources.
 */
export async function resolveConfiguration(options: {
  root: string;
  configFile?: string;
  userConfigFile?: string;
}): Promise<SkillGateConfig> {
  const projectFile = join(resolve(options.root), "skillgate.yaml");
  const userFile = options.userConfigFile ?? join(homedir(), ".config", "skillgate", "config.yaml");
  const layers: Array<Partial<SkillGateConfig> & { version: 1 }> = [];
  for (const filename of [userFile, projectFile]) {
    try {
      await readFile(filename, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new ConfigurationError(`Cannot read configuration ${filename}: ${String(error)}`);
    }
    layers.push(await loadConfiguration(filename));
  }
  if (options.configFile) layers.push(await loadConfiguration(options.configFile));
  return layers.reduce<SkillGateConfig>((merged, layer) => ({ ...merged, ...layer }), {
    version: 1,
    skillRoots: [resolve(options.root)],
    candidateLimit: 10,
    adapters: [],
  });
}
