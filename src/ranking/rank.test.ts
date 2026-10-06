import { describe, expect, it } from "vitest";
import { rankSkills } from "./rank.js";

const skills = [
  {
    path: "/skills/react/SKILL.md",
    metadata: { name: "react-testing", description: "Test React components with Vitest" },
  },
  {
    path: "/skills/docker/SKILL.md",
    metadata: { name: "docker", description: "Build and inspect containers" },
  },
  {
    path: "/skills/docs/SKILL.md",
    metadata: { name: "documentation", description: "Write project documentation" },
  },
];

describe("rankSkills", () => {
  it("weights task matches and keeps reasons", () => {
    const result = rankSkills({
      task: "fix react testing",
      skills,
      signals: [],
    });

    expect(result[0]?.metadata.name).toBe("react-testing");
    expect(result[0]?.score).toBeGreaterThan(0);
    expect(result[0]?.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "name", term: "react" }),
        expect.objectContaining({ source: "name", term: "testing" }),
      ]),
    );
  });

  it("uses project signals as ranking evidence", () => {
    const result = rankSkills({
      task: "fix this component",
      skills,
      signals: [{ kind: "framework", name: "react", evidence: "package.json dependency: react" }],
    });

    expect(result[0]?.metadata.name).toBe("react-testing");
    expect(result[0]?.reasons).toContainEqual({ source: "project", term: "react", points: 3 });
  });

  it("excludes irrelevant skills and respects the limit", () => {
    const result = rankSkills({
      task: "docker build",
      skills,
      signals: [],
      limit: 1,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.metadata.name).toBe("docker");
  });

  it("uses stable tie breaking", () => {
    const result = rankSkills({
      task: "test",
      skills: [
        { path: "/z", metadata: { name: "z-test", description: "Test things" } },
        { path: "/a", metadata: { name: "a-test", description: "Test things" } },
      ],
      signals: [],
    });

    expect(result.map((skill) => skill.metadata.name)).toEqual(["a-test", "z-test"]);
  });
});
