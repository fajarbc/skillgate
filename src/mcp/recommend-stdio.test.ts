import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runMcpStdio } from "./stdio.js";

const publicSkill = { id: "public", name: "React Public", description: "React UI" };
const deniedSkill = { id: "private", name: "Private React", description: "React secrets" };
const args = {
  task: "react",
  skills: [publicSkill, deniedSkill],
  policy: { deniedSkills: ["Private React"] },
};
const request = (id: number, name: string, value: unknown) => ({
  jsonrpc: "2.0", id, method: "tools/call",
  params: { name, arguments: value },
});

describe("MCP recommendation JSON-RPC stdio integration", () => {
  it("advertises the tool, filters denied metadata, rejects selectors and stays usable", async () => {
    const lines: string[] = [];
    const output = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString("utf8"));
        done();
      },
    });
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-06-18", capabilities: {},
        clientInfo: { name: "client", version: "1" },
      } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      request(3, "skillgate/recommend-metadata", args),
      request(4, "skillgate/recommend-metadata", { ...args, root: "/etc" }),
      request(5, "skillgate/recommend-metadata", {
        ...args,
        skills: [publicSkill, { ...deniedSkill, name: "Private React\u001b[31m" }],
      }),
      request(6, "skillgate/recommend-metadata", args),
    ];
    await runMcpStdio(Readable.from(messages.map((message) =>
      Buffer.from(JSON.stringify(message) + "\n"))), output);
    expect(lines).toHaveLength(6);
    const responses = lines.map((line) => JSON.parse(line));
    expect(responses[0]).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18" } });
    const catalog = responses[1].result.tools as Array<{ name: string }>;
    expect(catalog.map((tool) => tool.name)).toEqual([
      "skillgate/status", "skillgate/rank-metadata",
      "skillgate/evaluate-metadata-policy", "skillgate/recommend-metadata",
    ]);
    for (const index of [2, 5]) {
      const response = responses[index];
      expect(response.id).toBe(index === 2 ? 3 : 6);
      expect(response.result.structuredContent).toMatchObject({
        schemaVersion: "1", policySource: "client-supplied",
        authorizationGranted: false, filesystemAccess: "disabled",
        ranked: [{ id: "public", name: "React Public", score: 5 }],
      });
      expect(response.result.structuredContent.ranked).toHaveLength(1);
      expect(JSON.parse(response.result.content[0].text))
        .toEqual(response.result.structuredContent);
    }
    expect(responses[3]).toMatchObject({ id: 4, error: { code: -32602 } });
    expect(responses[4]).toMatchObject({ id: 5, error: { code: -32602 } });
    expect(lines.join("")).not.toContain("/etc");
    expect(lines.join("")).not.toContain("\u001b");
    expect(lines.every((line) => line.endsWith("\n") &&
      !line.slice(0, -1).includes("\n"))).toBe(true);
  });
});
