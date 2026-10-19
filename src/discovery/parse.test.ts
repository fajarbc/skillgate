import { describe, expect, it } from "vitest";
import { parseSkillMetadata } from "./parse.js";

const skill = (fields = "") => `---\nname: testing\ndescription: Run focused tests\n${fields}---\n# Body`;

describe("parseSkillMetadata", () => {
  it("reads name and description from frontmatter", () => {
    expect(parseSkillMetadata(skill())).toEqual({ name: "testing", description: "Run focused tests" });
  });

  it("requires both routing fields", () => {
    expect(() => parseSkillMetadata("---\nname: testing\n---\n")).toThrow(/description/);
  });

  it("preserves portable fields and nested extension values through JSON", () => {
    const metadata = parseSkillMetadata(skill([
      "license: Apache-2.0", "compatibility: Requires Node.js 20+", "allowed-tools: Read Bash(node:*)",
      "metadata:", "  author: example", "  version: '1.0'", "capabilities: [filesystem.read]",
      "host-settings:", "  enabled: true", "  retries: 2", "  extra: [null, text]", "",
    ].join("\n")));
    expect(JSON.parse(JSON.stringify(metadata))).toEqual({
      name: "testing", description: "Run focused tests", license: "Apache-2.0",
      compatibility: "Requires Node.js 20+", "allowed-tools": "Read Bash(node:*)",
      metadata: { author: "example", version: "1.0" }, capabilities: ["filesystem.read"],
      extensions: { "host-settings": { enabled: true, retries: 2, extra: [null, "text"] } },
    });
  });

  it.each(["license: 123", "license: null", "compatibility: []", "allowed-tools: [Read]",
    "metadata: []", "metadata: {version: 1}", "metadata: null", "capabilities: shell",
    "capabilities: null", "capabilities: [shell, 7]", "capabilities: ['']"])(
    "rejects malformed known field %s", (fields) => {
      expect(() => parseSkillMetadata(skill(`${fields}\n`))).toThrow(/frontmatter/);
    },
  );

  it("normalizes valid capabilities and preserves an explicitly empty list", () => {
    expect(parseSkillMetadata(skill("capabilities: [' shell ', files]\n")).capabilities).toEqual(["shell", "files"]);
    expect(parseSkillMetadata(skill("capabilities: []\n")).capabilities).toEqual([]);
  });

  it("keeps reserved extension keys as inert own properties", () => {
    const parsed = parseSkillMetadata(skill("__proto__: {polluted: true}\nconstructor: custom\nextensions: {capabilities: [admin]}\n"));
    expect(Object.hasOwn(parsed.extensions ?? {}, "__proto__")).toBe(true);
    expect(parsed.extensions?.constructor).toBe("custom");
    expect(parsed.extensions?.extensions).toEqual({ capabilities: ["admin"] });
    expect(parsed.capabilities).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each(["extra: .inf\n", "extra: .nan\n", "extra: &self [*self]\n", "extra: !!set {a, b}\n"])(
    "rejects non-JSON metadata %s", (fields) => {
      expect(() => parseSkillMetadata(skill(fields))).toThrow();
    },
  );

  it("bounds deeply nested extensions", () => {
    expect(() => parseSkillMetadata(skill(`extra: ${"[".repeat(40)}null${"]".repeat(40)}\n`))).toThrow(/structural limits/);
  });

  it("bounds the total number of copied metadata values", () => {
    expect(() => parseSkillMetadata(skill(`extra: [${Array(10_000).fill("null").join(",")} ]\n`))).toThrow(/structural limits/);
  });

  it("accepts shared noncyclic aliases without preserving object identity", () => {
    const parsed = parseSkillMetadata(skill("first: &value {nested: true}\nsecond: *value\n"));
    expect(parsed.extensions?.first).toEqual(parsed.extensions?.second);
    expect(parsed.extensions?.first).not.toBe(parsed.extensions?.second);
  });

  it("accepts CRLF frontmatter with an exact closing fence", () => {
    expect(parseSkillMetadata(skill().replaceAll("\n", "\r\n")).name).toBe("testing");
  });

  it.each(["---oops\nname: testing\ndescription: test\n---", "---\nname: testing\ndescription: test\n---oops", "---\n- a\n---", "---\nname: a\nname: b\ndescription: test\n---"])(
    "rejects malformed delimiters or mapping %s", (source) => {
      expect(() => parseSkillMetadata(source)).toThrow();
    },
  );
});
