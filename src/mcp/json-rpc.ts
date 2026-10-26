/** MCP JSON-RPC handshake and a deliberately empty, fail-closed tool catalog.
 * No filesystem tools are enabled until their #30 authorization boundary is tested.
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

/** One instance per client connection. Notifications never produce a response. */
export class McpJsonRpcSession {
  private state: "new" | "initializing" | "ready" = "new";

  handle(value: unknown): JsonRpcResponse | null {
    if (!record(value)) return failure(null, -32600, "Invalid Request");
    const id = value.id;
    const hasId = Object.prototype.hasOwnProperty.call(value, "id");
    const validId = typeof id === "string" ||
      (typeof id === "number" && Number.isFinite(id));
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
      // Reject malformed params without replying to the notification.
      if (method === "notifications/initialized" && this.state === "initializing" &&
          (value.params === undefined || record(value.params))) {
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
      // No tool may bypass the pending skill-root and policy authorization work.
      if (value.params !== undefined && !record(value.params)) {
        return failure(requestId, -32602, "Invalid tool list parameters");
      }
      return response(requestId, { tools: [] });
    }
    return failure(requestId, -32601, "Method not found");
  }
}
