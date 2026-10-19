import { parseDocument } from "yaml";
import type { MetadataValue, SkillMetadata } from "./types.js";

const KNOWN_FIELDS = new Set([
  "name", "description", "capabilities", "license", "compatibility", "metadata", "allowed-tools",
]);

/** Copy only finite, acyclic JSON data. Bound depth and alias expansion work. */
function jsonMetadata(value: unknown): MetadataValue {
  const ancestors = new Set<object>();
  let remaining = 10_000;
  function copy(item: unknown, depth: number): MetadataValue {
    if (--remaining < 0 || depth > 32) {
      throw new Error("frontmatter metadata exceeds structural limits");
    }
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || item === null) {
      throw new Error("frontmatter metadata must contain only JSON-compatible values");
    }
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null) {
      throw new Error("frontmatter metadata must contain only JSON-compatible values");
    }
    if (ancestors.has(item)) throw new Error("frontmatter metadata cannot contain cyclic aliases");
    ancestors.add(item);
    const result = Array.isArray(item)
      ? item.map((entry) => copy(entry, depth + 1))
      : Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, copy(entry, depth + 1)]));
    ancestors.delete(item);
    return result;
  }
  return copy(value, 0);
}

export function parseSkillMetadata(source: string): SkillMetadata {
  const opening = /^---\r?\n/.exec(source);
  if (!opening) throw new Error("missing YAML frontmatter");
  const remainder = source.slice(opening[0].length);
  const closing = /^---[ \t]*\r?$/m.exec(remainder);
  if (!closing) throw new Error("unterminated YAML frontmatter");

  const document = parseDocument(remainder.slice(0, closing.index));
  if (document.errors.length > 0) throw new Error("invalid YAML frontmatter");
  const value = document.toJS({ maxAliasCount: 100 }) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("frontmatter must be a mapping");
  }
  const metadata = jsonMetadata(value) as Record<string, MetadataValue>;
  if (typeof metadata.name !== "string" || metadata.name.trim() === "") {
    throw new Error("frontmatter requires a non-empty name");
  }
  if (typeof metadata.description !== "string" || metadata.description.trim() === "") {
    throw new Error("frontmatter requires a non-empty description");
  }
  const result: SkillMetadata = {
    name: metadata.name.trim(),
    description: metadata.description.trim(),
  };

  if (Object.hasOwn(metadata, "capabilities")) {
    const capabilities = metadata.capabilities;
    if (!Array.isArray(capabilities) || capabilities.some((c) => typeof c !== "string" || c.trim() === "")) {
      throw new Error("frontmatter capabilities must be an array of non-empty strings");
    }
    result.capabilities = (capabilities as string[]).map((c) => c.trim());
  }
  for (const field of ["license", "compatibility", "allowed-tools"] as const) {
    if (!Object.hasOwn(metadata, field)) continue;
    const entry = metadata[field];
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(`frontmatter ${field} must be a non-empty string`);
    }
    result[field] = entry;
  }
  if (Object.hasOwn(metadata, "metadata")) {
    const entries = metadata.metadata;
    if (!entries || typeof entries !== "object" || Array.isArray(entries) ||
        Object.values(entries).some((entry) => typeof entry !== "string")) {
      throw new Error("frontmatter metadata must be a mapping of strings to strings");
    }
    result.metadata = entries as Record<string, string>;
  }
  const extensions = Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !KNOWN_FIELDS.has(key)),
  );
  if (Object.keys(extensions).length > 0) result.extensions = extensions;
  return result;
}
