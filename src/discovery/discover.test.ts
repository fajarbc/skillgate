import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkills } from "./discover.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "skillgate-"));
}

describe("discoverSkills", () => {
  it("finds skills recursively in deterministic order", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "z"), { recursive: true });
    await mkdir(join(root, "a"), { recursive: true });
    await writeFile(join(root, "z", "SKILL.md"), "---\nname: zed\ndescription: Z skill\n---\n");
    await writeFile(join(root, "a", "SKILL.md"), "---\nname: alpha\ndescription: A skill\n---\n");

    const skills = await discoverSkills({ roots: [root] });

    expect(skills.map((skill) => skill.metadata?.name)).toEqual(["alpha", "zed"]);
  });

  it("reports malformed skills without aborting discovery", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "bad"), { recursive: true });
    await mkdir(join(root, "good"), { recursive: true });
    await writeFile(join(root, "bad", "SKILL.md"), "# no frontmatter");
    await writeFile(join(root, "good", "SKILL.md"), "---\nname: good\ndescription: Valid\n---\n");

    const skills = await discoverSkills({ roots: [root] });

    expect(skills).toHaveLength(2);
    expect(skills.find((skill) => skill.path.includes("/bad/"))?.error).toContain("frontmatter");
    expect(skills.find((skill) => skill.path.includes("/good/"))?.metadata?.name).toBe("good");
  });

  it("does not traverse default ignored directories", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "node_modules", "hidden"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "hidden", "SKILL.md"),
      "---\nname: hidden\ndescription: Hidden\n---\n",
    );

    expect(await discoverSkills({ roots: [root] })).toEqual([]);
  });
});
