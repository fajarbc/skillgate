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
  adapterOptions: Record<string, Record<string, string | number | boolean>>;
}

const keys = new Set(["version", "skillRoots", "candidateLimit", "policyPath", "adapters", "adapterOptions"]);
// Adapter options and signed URLs may contain credentials under HTTP/auth names.
// Dotted and space-delimited keys (api.key, access key) are also sensitive.
// Keep public config output fail-closed for those keys, without mutating the
// effective configuration used internally by adapters.
const sensitiveOption = /(?:secret|token|pass(?:word|wd|phrase)|pwd|api[._\s-]?key|credential|private[._\s-]?key|access[._\s-]?key|authorization|auth|bearer|cookie|session|signature|(?:^|[._\s-])(?:sig|key)(?:$|[._\s-]))/i;

// OAuth authorization codes and SAML assertions are bearer credentials even
// when their parameter names do not include token, key, or secret.
const sensitiveUrlParameter = /^(?:code|samlresponse|client_assertion)$/i;
// These credentials are sensitive as standalone adapter settings too, while
// an ordinary option named "code" must remain visible.
const sensitiveAssertionOption = /^(?:samlresponse|client_assertion)$/i;

/** URLSearchParams decodes once, but nested encodings can conceal a
 * credential key for several more passes. Bound the work and fail closed if
 * a malformed or excessively nested escape sequence remains.
 */
function isNestedEncodedCredentialKey(key: string, urlParameter = false): boolean {
  let decoded = key;
  for (let depth = 0; depth < 8; depth++) {
    if (sensitiveOption.test(decoded) || (urlParameter && sensitiveUrlParameter.test(decoded))) return true;
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return true;
    }
    if (next === decoded) return false;
    decoded = next;
  }
  return sensitiveOption.test(decoded) || (urlParameter && sensitiveUrlParameter.test(decoded)) || decoded.includes("%");
}

/** URL values can embed credentials even under innocuous option names such as
 * endpoint or registry. Never echo URL userinfo or credential-bearing query/
 * fragment parameters in public config output. Keep ordinary URLs intact.
 */
function hasEmbeddedUrlCredentials(value: string): boolean {
  // A malformed absolute URL may still contain userinfo credentials. If URL
  // parsing rejects it, fail closed rather than returning its raw value in
  // public config output. Ordinary non-URL option values remain untouched.
  const looksLikeUrl = /^[a-z][a-z\d+.-]*:\/{1,2}/i.test(value);
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password) ||
      [...url.searchParams.keys()].some((key) => isNestedEncodedCredentialKey(key, true)) ||
      [...new URLSearchParams(url.hash.slice(1)).keys()].some((key) => isNestedEncodedCredentialKey(key, true));
  } catch {
    return looksLikeUrl;
  }
}

export function sanitizeConfiguration(config: SkillGateConfig): SkillGateConfig {
  return {
    ...config,
    adapterOptions: Object.fromEntries(Object.entries(config.adapterOptions).map(([adapter, options]) => [
      adapter,
      Object.fromEntries(Object.entries(options).map(([key, value]) => [key, ((isNestedEncodedCredentialKey(key) || sensitiveAssertionOption.test(key)) || (typeof value === "string" && hasEmbeddedUrlCredentials(value))) ? "[REDACTED]" : value])),
    ])),
  };
}

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
  const adapterOptions = data.adapterOptions;
  if (adapterOptions !== undefined && (!adapterOptions || typeof adapterOptions !== "object" || Array.isArray(adapterOptions) || Object.values(adapterOptions).some((options) => !options || typeof options !== "object" || Array.isArray(options) || Object.values(options).some((value) => typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" || typeof value === "number" && !Number.isFinite(value))))) {
    throw new ConfigurationError(`${filename}: adapterOptions must map adapter names to objects containing string, finite number, or boolean values`);
  }
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
    ...(adapterOptions === undefined ? {} : { adapterOptions: adapterOptions as SkillGateConfig["adapterOptions"] }),
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
  return layers.reduce<SkillGateConfig>((merged, layer) => ({
    ...merged,
    ...layer,
    adapterOptions: {
      ...merged.adapterOptions,
      ...Object.fromEntries(Object.entries(layer.adapterOptions ?? {}).map(([name, options]) => [
        name,
        { ...merged.adapterOptions[name], ...options },
      ])),
    },
  }), {
    version: 1,
    skillRoots: [resolve(options.root)],
    candidateLimit: 10,
    adapters: [],
    adapterOptions: {},
  });
}
