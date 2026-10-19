import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../cli.js";

// Policies belong to the CLI/router, not the adapter context. Exercise that
// real boundary rather than handing an already-filtered list to a mock adapter.
const targets = [
  { alias: "codex", directory: ".codex" },
  { alias: "claude", directory: ".claude" },
  { alias: "claude-code", directory: ".claude" },
];

for (const { alias, directory } of targets) {
  describe(`${alias} policy/exposure contract`, () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "skillgate-policy-contract-"));
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      // Pin the relevant settings so local user configuration cannot affect fixtures.
      await writeFile(join(root, "skillgate.yaml"),
        "version: 1\nskillRoots: [./catalog]\npolicyPath: ./policy.json\ncandidateLimit: 10\nadapters: []\n");
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      if (root) await rm(root, { recursive: true, force: true });
    });

    async function skill(name: string, capabilities?: string) {
      const path = join(root, "catalog", name);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "SKILL.md"),
        `---\nname: ${name}\ndescription: Test TypeScript contracts\n${capabilities ? `capabilities: [${capabilities}]\n` : ""}---\n# ${name}\n`);
    }

    async function recommend() {
      const exit = await run(["recommend", "test TypeScript contracts", "--root", root, "--adapter", alias, "--json"]);
      expect(exit).toBe(0);
      const log = vi.mocked(console.log);
      expect(log).toHaveBeenCalledTimes(1);
      const output = JSON.parse(String(log.mock.calls[0]?.[0]));
      return output.recommendations.map((item: { metadata: { name: string } }) => item.metadata.name);
    }

    it("exposes only approved skills, excluding denied capabilities and invalid metadata", async () => {
      await skill("allowed-testing");
      await skill("denied-testing");
      await skill("network-testing", "network");
      await mkdir(join(root, "catalog", "invalid"), { recursive: true });
      await writeFile(join(root, "catalog", "invalid", "SKILL.md"), "---\nname: invalid\n---\nMissing description");
      await writeFile(join(root, "policy.json"), JSON.stringify({
        deniedSkills: ["denied-*"], deniedCapabilities: ["network"],
      }));

      expect(await recommend()).toEqual(["allowed-testing"]);
      expect(await readdir(join(root, directory, "skills"))).toEqual(["allowed-testing"]);
      expect(await readFile(join(root, directory, "skills", "allowed-testing", "SKILL.md"), "utf8"))
        .toContain("# allowed-testing");
    });

    it("removes previously exposed skills when policy denies them", async () => {
      await skill("allowed-testing");
      await writeFile(join(root, "policy.json"), "{}");
      expect(await recommend()).toEqual(["allowed-testing"]);
      vi.mocked(console.log).mockClear();
      await writeFile(join(root, "policy.json"), JSON.stringify({ deniedSkills: ["*"] }));

      expect(await recommend()).toEqual([]);
      await expect(readFile(join(root, directory, "skills", "allowed-testing", "SKILL.md")))
        .rejects.toMatchObject({ code: "ENOENT" });
    });

    it("fails closed on invalid policy before creating adapter output", async () => {
      await skill("allowed-testing");
      await writeFile(join(root, "policy.json"), "{ invalid JSON");
      expect(await run(["recommend", "test TypeScript", "--root", root, "--adapter", alias, "--json"]))
        .toBe(1);
      expect(console.log).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Failed to parse policy JSON"));
      await expect(readdir(join(root, directory))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
}
