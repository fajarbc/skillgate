import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("package configuration", () => {
  it("configures tsconfig.build.json to exclude tests", async () => {
    const raw = await readFile(resolve("tsconfig.build.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.exclude).toContain("src/**/*.test.ts");
    expect(parsed.compilerOptions.outDir).toBe("dist");
  });

  it("configures package.json with proper bin, engines, and files", async () => {
    const raw = await readFile(resolve("package.json"), "utf8");
    const pkg = JSON.parse(raw);
    expect(pkg.files).toEqual(["dist"]);
    expect(pkg.bin.skillgate).toBe("./dist/cli.js");
    expect(pkg.type).toBe("module");
    expect(pkg.engines.node).toBe(">=20");
    expect(pkg.scripts.build).toContain("tsconfig.build.json");
    expect(pkg.scripts.typecheck).toContain("tsconfig.json");
  });
});
