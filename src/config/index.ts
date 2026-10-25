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

// OAuth authorization codes, PKCE verifiers, and SAML assertions are credentials even
// when their parameter names do not include token, key, or secret.
const sensitiveUrlParameter = /^(?:code|code_verifier|samlresponse|client_assertion)$/i;
// These credentials are sensitive as standalone adapter settings too, while
// an ordinary option named "code" must remain visible.
const sensitiveAssertionOption = /^(?:code_verifier|samlresponse|client_assertion)$/i;

/** URLSearchParams decodes once, but nested encodings can conceal a
 * credential key for several more passes. Bound the work and fail closed if
 * a malformed or excessively nested escape sequence remains.
 */
function isNestedEncodedCredentialKey(key: string, context: "option" | "url" = "option"): boolean {
  const isSensitive = (decoded: string): boolean =>
    sensitiveOption.test(decoded) ||
    (context === "url" ? sensitiveUrlParameter : sensitiveAssertionOption).test(decoded);
  let decoded = key;
  for (let depth = 0; depth < 8; depth++) {
    if (isSensitive(decoded)) return true;
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return true;
    }
    if (next === decoded) return false;
    decoded = next;
  }
  return isSensitive(decoded) || decoded.includes("%");
}

/** URL values can embed credentials even under innocuous option names such as
 * endpoint or registry. Never echo URL userinfo or credential-bearing query/
 * fragment parameters in public config output. Keep ordinary URLs intact.
 */
function hasEmbeddedUrlCredentials(value: string, depth = 0): boolean {
  // A malformed absolute URL may still contain userinfo credentials. If URL
  // parsing rejects it, fail closed rather than returning its raw value in
  // public config output. Ordinary non-URL option values remain untouched.
  const looksLikeUrl = /^[a-z][a-z\d+.-]*:\/{1,2}/i.test(value);
  try {
    const url = new URL(value);
    // OAuth fragments may be key/value data, hash-router queries, or both.
    // Parsing only the suffix after "?" can hide an earlier access_token or
    // authorization code when a later fragment value contains a question mark.
    const fragment = url.hash.slice(1);
    const parameters = [
      ...url.searchParams.entries(),
      ...new URLSearchParams(fragment).entries(),
      ...(fragment.includes("?")
        ? new URLSearchParams(fragment.slice(fragment.indexOf("?") + 1)).entries()
        : []),
    ];
    if (url.username || url.password ||
        parameters.some(([key]) => isNestedEncodedCredentialKey(key, "url"))) return true;
    // An innocuous outer parameter such as "redirect" may contain a URL with
    // userinfo or signed credentials. Inspect nested URL values with bounded
    // recursion and decoding, while preserving safe redirect destinations.
    if (depth >= 3) return false;
    return parameters.some(([, raw]) => {
      let candidate = raw;
      for (let encodingDepth = 0; encodingDepth < 4; encodingDepth++) {
        if ((candidate.includes("://") || candidate.startsWith("http:/") || candidate.startsWith("https:/")) &&
            hasEmbeddedUrlCredentials(candidate, depth + 1)) return true;
        if (!candidate.includes("%")) break;
        try {
          const decoded = decodeURIComponent(candidate);
          if (decoded === candidate) break;
          candidate = decoded;
        } catch {
          return true;
        }
      }
      return false;
    });
  } catch {
    return looksLikeUrl;
  }
}

export function sanitizeConfiguration(config: SkillGateConfig): SkillGateConfig {
  return {
    ...config,
    adapterOptions: Object.fromEntries(Object.entries(config.adapterOptions).map(([adapter, options]) => [
      adapter,
      Object.fromEntries(Object.entries(options).map(([key, value]) => [key, (isNestedEncodedCredentialKey(key) || (typeof value === "string" && hasEmbeddedUrlCredentials(value))) ? "[REDACTED]" : value])),
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
