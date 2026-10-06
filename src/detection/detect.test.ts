import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "./detect.js";

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), "skillgate-detect-"));
}

describe("detectProject", () => {
  it("detects Node project signals from package.json", async () => {
    const dir = await root();
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        dependencies: { next: "15.0.0", react: "19.0.0" },
        devDependencies: { typescript: "5.7.0", vitest: "3.0.0" },
      }),
    );

    const signals = await detectProject({ root: dir });

    expect(signals).toEqual(
      expect.arrayContaining([
        { kind: "language", name: "javascript", evidence: "package.json" },
        { kind: "runtime", name: "node", evidence: "package.json" },
        { kind: "language", name: "typescript", evidence: "package.json dependency: typescript" },
        { kind: "framework", name: "nextjs", evidence: "package.json dependency: next" },
        { kind: "framework", name: "react", evidence: "package.json dependency: react" },
        { kind: "tool", name: "vitest", evidence: "package.json dependency: vitest" },
      ]),
    );
  });

  it("detects common manifests and tools without reading project code", async () => {
    const dir = await root();
    await writeFile(join(dir, "pyproject.toml"), "[project]\nname = \"example\"\n");
    await writeFile(join(dir, "Dockerfile"), "FROM scratch\n");
    await writeFile(join(dir, "pytest.ini"), "[pytest]\n");

    expect(await detectProject({ root: dir })).toEqual([
      { kind: "language", name: "python", evidence: "pyproject.toml" },
      { kind: "tool", name: "docker", evidence: "Dockerfile" },
      { kind: "tool", name: "pytest", evidence: "pytest.ini" },
    ]);
  });

  it("ignores malformed package.json instead of failing detection", async () => {
    const dir = await root();
    await writeFile(join(dir, "package.json"), "{");

    expect(await detectProject({ root: dir })).toEqual([
      { kind: "language", name: "javascript", evidence: "package.json" },
      { kind: "runtime", name: "node", evidence: "package.json" },
    ]);
  });

  it("returns signals in stable order", async () => {
    const dir = await root();
    await writeFile(join(dir, "go.mod"), "module example\n");
    await writeFile(join(dir, "Cargo.toml"), "[package]\nname = \"example\"\n");

    expect((await detectProject({ root: dir })).map((signal) => signal.name)).toEqual(["go", "rust"]);
  });
});
