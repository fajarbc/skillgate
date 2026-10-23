import { JSON_PROTOCOL_VERSION } from "./cli-json-protocol.js";

/** Maximum request size, including JSON syntax and advisory context. */
export const MAX_JSON_STDIN_BYTES = 1024 * 1024;

export interface JsonStdinRequest {
  protocolVersion: typeof JSON_PROTOCOL_VERSION;
  task: string;
  context?: { paths?: string[] };
}

export class JsonStdinRequestError extends Error {
  constructor(
    public readonly code: "INVALID_REQUEST" | "UNSUPPORTED_PROTOCOL",
    message: string,
  ) {
    super(message);
    this.name = "JsonStdinRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a single v1 JSON request; never interpolate untrusted input into errors. */
export function parseJsonStdinRequest(text: string): JsonStdinRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JsonStdinRequestError("INVALID_REQUEST", "stdin must contain one valid JSON object");
  }
  if (!isRecord(parsed)) {
    throw new JsonStdinRequestError("INVALID_REQUEST", "stdin request must be a JSON object");
  }
  if (!("protocolVersion" in parsed)) {
    throw new JsonStdinRequestError("INVALID_REQUEST", "protocolVersion is required");
  }
  if (parsed.protocolVersion !== JSON_PROTOCOL_VERSION) {
    throw new JsonStdinRequestError("UNSUPPORTED_PROTOCOL", "Unsupported JSON protocol version");
  }
  if (typeof parsed.task !== "string" || !parsed.task.trim()) {
    throw new JsonStdinRequestError("INVALID_REQUEST", "task must be a nonempty string");
  }

  let context: JsonStdinRequest["context"];
  if ("context" in parsed) {
    if (!isRecord(parsed.context)) {
      throw new JsonStdinRequestError("INVALID_REQUEST", "context must be a JSON object");
    }
    if ("paths" in parsed.context) {
      const paths = parsed.context.paths;
      if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string" && path.trim())) {
        throw new JsonStdinRequestError("INVALID_REQUEST", "context.paths must be an array of nonempty strings");
      }
      context = { paths: [...paths] };
    } else {
      context = {};
    }
  }
  return { protocolVersion: JSON_PROTOCOL_VERSION, task: parsed.task, ...(context ? { context } : {}) };
}

/** Read bounded bytes before fatal UTF-8 decoding; no partial JSON is accepted. */
export async function readJsonStdinRequest(
  input: AsyncIterable<Uint8Array | string>,
  maxBytes = MAX_JSON_STDIN_BYTES,
): Promise<JsonStdinRequest> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const encoder = new TextEncoder();
  for await (const chunk of input) {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    size += bytes.byteLength;
    if (size > maxBytes) {
      throw new JsonStdinRequestError("INVALID_REQUEST", "stdin JSON request exceeds the byte limit");
    }
    chunks.push(bytes);
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    throw new JsonStdinRequestError("INVALID_REQUEST", "stdin must be valid UTF-8");
  }
  return parseJsonStdinRequest(decoded);
}
