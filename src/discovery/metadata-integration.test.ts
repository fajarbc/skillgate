import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../adapters/claude.js";
import { OWNERSHIP_HEADER } from "../adapters/filesystem-lifecycle.js";
import { CodexAdapter } from "../adapters/codex.js";
import { evaluateSkillPolicy } from "../policy/index.js";
import { rankSkills } from "../ranking/index.js";
import { discoverSkills } from "./discover.js";

const portableSkill = `---\nname: portable-testing\ndescription: Run focused tests\ncapabilities:\n  - network\nlicense: Apache-2.0\ncompatibility: linux\nmetadata:\n  author: Example\n  channel: stable\nallowed-tools: Bash\nx-vendor:\n  nested:\n    enabled: true\n    values: [1, null, text]\n---\n# Instructions\nRun the focused tests.\n`;

describe("metadata integration", () => {
  it("preserves portable metadata while ranking and policy use only their own inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-metadata-integration-"));
    try {
      await mkdir(join(root, "portable"), { recursive: true });
      await writeFile(join(root, "portable", "SKILL.md"), portableSkill);

      const discovered = await discoverSkills({ roots: [root] });
      expect(discovered).toHaveLength(1);
      const skill = discovered[0];
      expect(skill?.metadata).toMatchObject({
        name: "portable-testing",
        description: "Run focused tests",
        capabilities: ["network"],
        license: "Apache-2.0",
        compatibility: "linux",
        metadata: { author: "Example", channel: "stable" },
        "allowed-tools": "Bash",
        extensions: {
          "x-vendor": { nested: { enabled: true, values: [1, null, "text"] } },
        },
      });

      const ranked = rankSkills({
        task: "focused tests",
        skills: [{ path: skill!.path, metadata: skill!.metadata! }],
        signals: [],
      });
      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.score).toBe(4);
      expect(ranked[0]?.reasons).toEqual([
        { source: "description", term: "focused", points: 2 },
        { source: "description", term: "tests", points: 2 },
      ]);
      expect(ranked[0]?.metadata).toEqual(skill?.metadata);

      const denied = evaluateSkillPolicy(
        { path: skill!.path, metadata: skill!.metadata! },
        { deniedCapabilities: ["network"] },
      );
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toContain("denied capability 'network'");

      const allowedByCapability = evaluateSkillPolicy(
        {
          path: skill!.path,
          metadata: { ...skill!.metadata!, "allowed-tools": "not-network" },
        },
        { allowedCapabilities: ["network"] },
      );
      expect(allowedByCapability.decision).toBe("allow");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["scalar", "network"],
    ["mixed array", "[network, 7]"],
    ["null", "null"],
  ])("fails closed for malformed %s capability declarations", async (_kind, declaration) => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-malformed-capabilities-"));
    try {
      await mkdir(join(root, "bad"), { recursive: true });
      await writeFile(
        join(root, "bad", "SKILL.md"),
        `---\nname: malformed\ndescription: Invalid declaration\ncapabilities: ${declaration}\n---\n`,
      );
      const discovered = await discoverSkills({ roots: [root] });
      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.metadata).toBeUndefined();
      expect(discovered[0]?.error).toMatch(/capabilities/);
      const candidates = discovered.flatMap((entry) =>
        entry.metadata ? [{ path: entry.path, metadata: entry.metadata }] : [],
      );
      expect(
        rankSkills({ task: "invalid declaration", skills: candidates, signals: [] }),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("copies complete original SKILL.md bytes, including portable and host fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-adapter-metadata-"));
    try {
      const source = join(root, "SKILL.md");
      await writeFile(source, portableSkill);
      const discovered = await discoverSkills({ roots: [root] });
      const metadata = discovered[0]?.metadata;
      expect(metadata).toBeDefined();
      const selected = {
        path: source,
        metadata: metadata!,
        score: 1,
        reasons: [],
      };

      await new ClaudeCodeAdapter().apply({ task: "test", root, skills: [selected] });
      await new CodexAdapter().apply({ task: "test", root, skills: [selected] });

      expect(await readFile(join(root, ".claude", "skills", "portable-testing", "SKILL.md"), "utf8"))
        .toBe(`${OWNERSHIP_HEADER}${portableSkill}`);
      expect(await readFile(join(root, ".codex", "skills", "portable-testing", "SKILL.md"), "utf8"))
        .toBe(`${OWNERSHIP_HEADER}${portableSkill}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
