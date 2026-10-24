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
  // A byte-bounded request must not retain an unbounded number of tiny or
  // empty producer chunks. Copy directly into one bounded receive buffer.
  const combined = new Uint8Array(maxBytes);
  let size = 0;
  const encoder = new TextEncoder();
  // String producers may split a surrogate pair across chunks. Encoding each
  // chunk separately would silently replace both halves with U+FFFD.
  let pendingHighSurrogate = "";
  const append = (chunk: Uint8Array | string): void => {
    // Reject oversized strings before allocating their encoded representation.
    const chunkBytes = typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
    if (chunkBytes > maxBytes - size) {
      throw new JsonStdinRequestError("INVALID_REQUEST", "stdin JSON request exceeds the byte limit");
    }
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    // Copy immediately: a producer may reuse or mutate its backing buffer.
    combined.set(bytes, size);
    size += chunkBytes;
  };
  for await (const chunk of input) {
    if (typeof chunk === "string") {
      let text = pendingHighSurrogate + chunk;
      pendingHighSurrogate = "";
      const last = text.charCodeAt(text.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        pendingHighSurrogate = text.slice(-1);
        text = text.slice(0, -1);
      }
      if (text) append(text);
    } else {
      // A binary chunk cannot complete a string's UTF-16 surrogate pair.
      if (pendingHighSurrogate) {
        append(pendingHighSurrogate);
        pendingHighSurrogate = "";
      }
      append(chunk);
    }
  }
  if (pendingHighSurrogate) append(pendingHighSurrogate);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(combined.subarray(0, size));
  } catch {
    throw new JsonStdinRequestError("INVALID_REQUEST", "stdin must be valid UTF-8");
  }
  return parseJsonStdinRequest(decoded);
}
