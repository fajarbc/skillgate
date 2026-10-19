import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareSafeSkillPaths,
  resolveSafeSubpath,
  toSafeSkillIdentifier,
} from "./safe-path.js";

describe("safe-path", () => {
  it("normalizes standard names", () => {
    expect(toSafeSkillIdentifier("react-testing")).toBe("react-testing");
    expect(toSafeSkillIdentifier("React Testing")).toBe("react-testing");
    expect(toSafeSkillIdentifier("my_skill_name")).toBe("my-skill-name");
  });

  it("neutralizes traversal segments and path separators", () => {
    expect(toSafeSkillIdentifier("../foo")).toBe("foo");
    expect(toSafeSkillIdentifier("..\\foo")).toBe("foo");
    expect(toSafeSkillIdentifier("../../etc/passwd")).toBe("etc-passwd");
    expect(toSafeSkillIdentifier("%2e%2e/bar")).toBe("bar");
    expect(toSafeSkillIdentifier("trailing-dots...")).toBe("trailing-dots");
    expect(toSafeSkillIdentifier("   spaced   ")).toBe("spaced");
  });

  it.each([
    "CON", "prn", "aux.txt", "nul", "COM1", "com9.md", "LPT1", "lpt9.txt",
  ])("rejects Windows reserved device name %s on every OS", (name) => {
    expect(() => toSafeSkillIdentifier(name)).toThrow(/reserved device name/);
  });

  it("detects and rejects collisions between names normalizing to the same identifier", () => {
    const skills = [
      {
        path: "/skills/one",
        metadata: { name: "my-skill", description: "First" },
        score: 1,
        reasons: [],
      },
      {
        path: "/skills/two",
        metadata: { name: "My_Skill", description: "Second" },
        score: 2,
        reasons: [],
      },
    ];

    expect(() => prepareSafeSkillPaths(skills, join(tmpdir(), "managed"))).toThrow(
      /Skill name collision/,
    );
  });

  it("prevents subpaths from escaping the root directory", () => {
    const root = join(tmpdir(), "skillgate-safe-root");
    expect(() => resolveSafeSubpath(root, join(tmpdir(), "outside"))).toThrow(
      /absolute paths are not permitted/,
    );
    expect(() => resolveSafeSubpath(root, "../escape")).toThrow(
      /resolves outside root/,
    );
    expect(resolveSafeSubpath(root, "safe/subpath")).toBe(join(root, "safe", "subpath"));
  });

  it.each(["C:\\outside", "C:/outside", "\\\\server\\share\\skill", "\\outside"])(
    "rejects Windows absolute path %s on every OS", (subpath) => {
      expect(() => resolveSafeSubpath(join(tmpdir(), "root"), subpath)).toThrow(
        /absolute paths are not permitted/,
      );
    },
  );

  it.runIf(process.platform === "win32")("rejects backslash and mixed-separator traversal on Windows", () => {
    const root = join(tmpdir(), "skillgate-safe-root");
    for (const subpath of ["..\\escape", "safe\\..\\..\\escape", "safe/..\\..\\escape"]) {
      expect(() => resolveSafeSubpath(root, subpath)).toThrow(/resolves outside root/);
    }
  });
});
