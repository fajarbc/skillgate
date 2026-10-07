import { parseDocument } from "yaml";
import type { SkillMetadata } from "./types.js";

export function parseSkillMetadata(source: string): SkillMetadata {
  if (!source.startsWith("---")) {
    throw new Error("missing YAML frontmatter");
  }

  const end = source.indexOf("\n---", 3);
  if (end < 0) {
    throw new Error("unterminated YAML frontmatter");
  }

  const document = parseDocument(source.slice(3, end));
  if (document.errors.length > 0) {
    throw new Error("invalid YAML frontmatter");
  }

  const value = document.toJS() as unknown;
  if (!value || typeof value !== "object") {
    throw new Error("frontmatter must be a mapping");
  }

  const metadata = value as Record<string, unknown>;
  if (typeof metadata.name !== "string" || metadata.name.trim() === "") {
    throw new Error("frontmatter requires a non-empty name");
  }
  if (typeof metadata.description !== "string" || metadata.description.trim() === "") {
    throw new Error("frontmatter requires a non-empty description");
  }

  let capabilities: string[] | undefined;
  if (Array.isArray(metadata.capabilities)) {
    const list = metadata.capabilities
      .filter((c): c is string => typeof c === "string")
      .map((c) => c.trim())
      .filter(Boolean);
    if (list.length > 0) capabilities = list;
  }

  return {
    name: metadata.name.trim(),
    description: metadata.description.trim(),
    ...(capabilities ? { capabilities } : {}),
  };
}
