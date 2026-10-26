/** MCP JSON-RPC handshake with one filesystem-free status tool.
 * Skill discovery and file reads remain disabled until #30 authorization tests.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18" as const;

type JsonId = string | number | null;
type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonId;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function response(id: JsonId, result: Record<string, unknown>): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: JsonId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** The status tool is filesystem-free and has a stable, versioned result schema. */
export const MCP_STATUS_SCHEMA_VERSION = "1" as const;

const STATUS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { const: MCP_STATUS_SCHEMA_VERSION },
    protocolVersion: { const: MCP_PROTOCOL_VERSION },
    skillToolsAvailable: { const: false },
    filesystemAccess: { const: "disabled" },
  },
  required: ["schemaVersion", "protocolVersion", "skillToolsAvailable", "filesystemAccess"],
  additionalProperties: false,
} as const;

/** One instance per client connection. Notifications never produce a response. */
const STATUS_TOOL = {
  name: "skillgate/status",
  description: "Report this local SkillGate MCP preview's safe capabilities without reading workspace files.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: STATUS_OUTPUT_SCHEMA,
} as const;

/** A static, non-sensitive response: this tool does not read config or files. */
function statusResult(): Record<string, unknown> {
  const payload = {
    schemaVersion: MCP_STATUS_SCHEMA_VERSION,
    protocolVersion: MCP_PROTOCOL_VERSION,
    skillToolsAvailable: false,
    filesystemAccess: "disabled",
  } as const;
  return {
    structuredContent: payload,
    // Keep text for MCP clients that have not adopted structured tool output.
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

export class McpJsonRpcSession {
  private state: "new" | "initializing" | "ready" = "new";

  handle(value: unknown): JsonRpcResponse | null {
    if (!record(value)) return failure(null, -32600, "Invalid Request");
    const id = value.id;
    const hasId = Object.prototype.hasOwnProperty.call(value, "id");
    // JSON-RPC numeric IDs must round-trip without fractional, precision, or\n    // signed-zero loss: JSON.stringify(-0) serializes as 0.
    const validId = typeof id === "string" ||
      (typeof id === "number" && Number.isSafeInteger(id) && !Object.is(id, -0));
    if (value.jsonrpc !== "2.0" || typeof value.method !== "string" ||
        (hasId && !validId)) {
      return failure(null, -32600, "Invalid Request");
    }
    const method = value.method;
    // MCP methods take object parameters. Reject primitive and array values
    // rather than silently accepting malformed JSON-RPC requests.
    if (hasId && value.params !== undefined && !record(value.params)) {
      return failure(id as string | number, -32602, "Invalid params");
    }
    if (!hasId) {
      // Only a well-formed initialized notification may complete the handshake.
      // Its optional params contain only MCP _meta; arbitrary fields must not
      // silently become authorization inputs when filesystem tools are added.
      const params = value.params;
      if (method === "notifications/initialized" && this.state === "initializing" &&
          (params === undefined || (record(params) &&
            Object.keys(params).every((key) => key === "_meta") &&
            (params._meta === undefined || record(params._meta))))) {
        this.state = "ready";
      }
      // JSON-RPC notifications cannot be acknowledged, including invalid ones.
      return null;
    }
    const requestId = id as string | number;
    if (method === "initialize") {
      if (this.state !== "new") return failure(requestId, -32600, "Already initialized");
      if (!record(value.params) || typeof value.params.protocolVersion !== "string" ||
          value.params.protocolVersion.length === 0 ||
          !record(value.params.capabilities) || !record(value.params.clientInfo) ||
          typeof value.params.clientInfo.name !== "string" ||
          typeof value.params.clientInfo.version !== "string" ||
          value.params.clientInfo.name.length === 0 ||
          value.params.clientInfo.version.length === 0) {
        return failure(requestId, -32602, "Invalid initialize parameters");
      }
      this.state = "initializing";
      return response(requestId, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "skillgate", version: "0.0.0" },
      });
    }
    if (method === "ping") return response(requestId, {});
    if (this.state !== "ready") return failure(requestId, -32002, "Server not initialized");
    if (method === "tools/list") {
      // No skill or filesystem tool may bypass pending root/policy authorization.
      // The static status-only catalog has no next page. Reject a caller's
      // stale or invented cursor as if it had been successfully paginated.
      if (record(value.params) && Object.prototype.hasOwnProperty.call(value.params, "cursor")) {
        return failure(requestId, -32602, "Invalid tool list cursor");
      }
      // Accept only MCP's optional request metadata. Unknown fields must not
      // silently acquire meaning when additional tools are implemented.
      if (record(value.params) && (Object.keys(value.params).some((key) => key !== "_meta") ||
          (value.params._meta !== undefined && !record(value.params._meta)))) {
        return failure(requestId, -32602, "Invalid tool list parameters");
      }
      return response(requestId, { tools: [STATUS_TOOL] });
    }
    if (method === "tools/call") {
      if (!record(value.params) || typeof value.params.name !== "string" ||
          (value.params.arguments !== undefined && !record(value.params.arguments))) {
        return failure(requestId, -32602, "Invalid tool call parameters");
      }
      // Closed parameter shape: reject extraneous fields, while permitting
      // the standard MCP _meta extension for compatible clients.
      if (Object.keys(value.params).some((key) => !["name", "arguments", "_meta"].includes(key)) ||
          (value.params._meta !== undefined && !record(value.params._meta))) {
        return failure(requestId, -32602, "Invalid tool call parameters");
      }
      if (value.params.name !== STATUS_TOOL.name) {
        return failure(requestId, -32602, "Unknown tool");
      }
      if (record(value.params.arguments) && Object.keys(value.params.arguments).length !== 0) {
        return failure(requestId, -32602, "Invalid status arguments");
      }
      return response(requestId, statusResult());
    }
    return failure(requestId, -32601, "Method not found");
  }
}
