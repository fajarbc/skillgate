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

  it("rejects Windows reserved device names", () => {
    expect(() => toSafeSkillIdentifier("CON")).toThrow(/reserved device name/);
    expect(() => toSafeSkillIdentifier("aux.txt")).toThrow(/reserved device name/);
    expect(() => toSafeSkillIdentifier("nul")).toThrow(/reserved device name/);
    expect(() => toSafeSkillIdentifier("com1")).toThrow(/reserved device name/);
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

    expect(() => prepareSafeSkillPaths(skills, "/tmp/managed")).toThrow(
      /Skill name collision/,
    );
  });

  it("prevents subpaths from escaping the root directory", () => {
    expect(() => resolveSafeSubpath("/tmp/root", "/etc/passwd")).toThrow(
      /absolute paths are not permitted/,
    );
    expect(() => resolveSafeSubpath("/tmp/root", "../escape")).toThrow(
      /resolves outside root/,
    );
    expect(resolveSafeSubpath("/tmp/root", "safe/subpath")).toBe("/tmp/root/safe/subpath");
  });
});
