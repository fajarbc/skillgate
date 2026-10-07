import type { BenchmarkCorpus } from "../types.js";

export const CORPUS_V1: BenchmarkCorpus = {
  version: "1.0.0",
  description: "Deterministic routing benchmark measuring recall, irrelevant exposure, and metadata token cost",
  cases: [
    {
      id: "react-vitest",
      name: "React component testing with Vitest",
      task: "write unit test for react component with vitest",
      signals: [
        { kind: "framework", name: "react", evidence: "package.json dependency: react" },
        { kind: "tool", name: "vitest", evidence: "package.json dependency: vitest" },
        { kind: "language", name: "typescript", evidence: "package.json dependency: typescript" },
      ],
      catalog: [
        {
          path: "/skills/react-testing/SKILL.md",
          metadata: { name: "react-testing", description: "Test React components using Vitest" },
        },
        {
          path: "/skills/vitest-runner/SKILL.md",
          metadata: { name: "vitest-runner", description: "Run and configure Vitest test suites" },
        },
        {
          path: "/skills/docker/SKILL.md",
          metadata: { name: "docker-deploy", description: "Docker container deployment" },
        },
        {
          path: "/skills/flask/SKILL.md",
          metadata: { name: "python-flask", description: "Build Flask web applications in Python" },
        },
        {
          path: "/skills/postgres/SKILL.md",
          metadata: { name: "postgres-db", description: "PostgreSQL database migrations and queries" },
        },
      ],
      expectedSkills: ["react-testing", "vitest-runner"],
      forbiddenSkills: ["python-flask", "postgres-db"],
    },
    {
      id: "docker-deploy",
      name: "Docker containerization and deploy",
      task: "deploy container to docker",
      signals: [{ kind: "tool", name: "docker", evidence: "Dockerfile" }],
      catalog: [
        {
          path: "/skills/docker/SKILL.md",
          metadata: { name: "docker-deploy", description: "Build and deploy Docker container images" },
        },
        {
          path: "/skills/react-testing/SKILL.md",
          metadata: { name: "react-testing", description: "Test React components using Vitest" },
        },
        {
          path: "/skills/docs/SKILL.md",
          metadata: { name: "documentation", description: "Write project markdown documentation" },
        },
      ],
      expectedSkills: ["docker-deploy"],
      forbiddenSkills: ["react-testing"],
    },
    {
      id: "python-api",
      name: "Python FastAPI backend development",
      task: "create python fastapi endpoint",
      signals: [{ kind: "language", name: "python", evidence: "pyproject.toml" }],
      catalog: [
        {
          path: "/skills/python-api/SKILL.md",
          metadata: { name: "python-api", description: "Build FastAPI endpoints in Python" },
        },
        {
          path: "/skills/go-microservice/SKILL.md",
          metadata: { name: "go-microservice", description: "Build Go microservices" },
        },
        {
          path: "/skills/react-testing/SKILL.md",
          metadata: { name: "react-testing", description: "Test React components using Vitest" },
        },
      ],
      expectedSkills: ["python-api"],
      forbiddenSkills: ["go-microservice", "react-testing"],
    },
    {
      id: "documentation",
      name: "Update project documentation",
      task: "update readme and project documentation",
      signals: [],
      catalog: [
        {
          path: "/skills/docs/SKILL.md",
          metadata: { name: "documentation", description: "Write and update markdown documentation and README" },
        },
        {
          path: "/skills/docker/SKILL.md",
          metadata: { name: "docker-deploy", description: "Build and run Docker container images" },
        },
        {
          path: "/skills/vitest-runner/SKILL.md",
          metadata: { name: "vitest-runner", description: "Run Vitest test suites" },
        },
      ],
      expectedSkills: ["documentation"],
      forbiddenSkills: ["docker-deploy", "vitest-runner"],
    },
  ],
};
