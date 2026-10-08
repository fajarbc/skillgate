import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatDoctorReport, runDiagnostics } from "./index.js";

describe("doctor diagnostics", () => {
  it("reports healthy setup for valid workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-doc-"));
    const report = await runDiagnostics({ root, nodeVersion: "v20.10.0" });

    expect(report.status).toBe("ok");
    expect(report.summary.failures).toBe(0);
    expect(report.checks.find((c) => c.name === "node-runtime")?.status).toBe("ok");
    expect(report.checks.find((c) => c.name === "filesystem-permissions")?.status).toBe("ok");

    const formatted = formatDoctorReport(report);
    expect(formatted).toContain("Status: OK");
    expect(formatted).toContain("Node.js v20.10.0");

    await rm(root, { recursive: true, force: true });
  });

  it("fails when node version is unsupported", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-doc-"));
    const report = await runDiagnostics({ root, nodeVersion: "v18.19.0" });

    expect(report.status).toBe("fail");
    expect(report.summary.failures).toBeGreaterThan(0);
    expect(report.checks.find((c) => c.name === "node-runtime")?.status).toBe("fail");

    await rm(root, { recursive: true, force: true });
  });

  it("warns when invalid skills are found", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-doc-"));
    await mkdir(join(root, "bad-skill"), { recursive: true });
    await writeFile(join(root, "bad-skill", "SKILL.md"), "invalid frontmatter");

    const report = await runDiagnostics({ root, nodeVersion: "v20.0.0" });
    expect(report.status).toBe("warn");
    expect(report.summary.warnings).toBeGreaterThan(0);
    expect(report.checks.find((c) => c.name === "skill-discovery")?.status).toBe("warn");

    await rm(root, { recursive: true, force: true });
  });

  it("fails when policy configuration is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-doc-"));
    await writeFile(join(root, "skillgate.policy.json"), "{ broken json");

    const report = await runDiagnostics({ root, nodeVersion: "v20.0.0" });
    expect(report.status).toBe("fail");
    expect(report.checks.find((c) => c.name === "policy-configuration")?.status).toBe("fail");

    await rm(root, { recursive: true, force: true });
  });
});
