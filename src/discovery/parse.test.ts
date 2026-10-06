import { describe, expect, it } from "vitest";
import { parseSkillMetadata } from "./parse.js";

describe("parseSkillMetadata", () => {
  it("reads name and description from frontmatter", () => {
    expect(
      parseSkillMetadata("---\nname: testing\ndescription: Run focused tests\n---\n# Body"),
    ).toEqual({ name: "testing", description: "Run focused tests" });
  });

  it("requires both routing fields", () => {
    expect(() => parseSkillMetadata("---\nname: testing\n---\n")).toThrow(/description/);
  });
});
