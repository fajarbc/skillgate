/** Bounded, strict UTF-8 framing for MCP's newline-delimited JSON-RPC stdio transport.
 * This is deliberately transport-only: it does not expose filesystem tools.
 */
export const MAX_MCP_MESSAGE_BYTES = 1024 * 1024;

export class McpFramingError extends Error {
  constructor(public readonly kind: "too_large" | "invalid_utf8" | "invalid_json" | "incomplete") {
    super(`Invalid MCP stdio message: ${kind}`);
    this.name = "McpFramingError";
  }
}

/** A session must close on framing errors, rather than trying to resynchronize
 * after oversized or malformed input from an untrusted local client.
 */
export class McpJsonLineDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  // Keep one bounded reusable buffer instead of one allocation per input chunk.
  // A malicious client can send a megabyte in single-byte chunks.
  private buffer = new Uint8Array(0);
  private size = 0;
  private closed = false;

  constructor(private readonly maxBytes = MAX_MCP_MESSAGE_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError("maxBytes must be a positive safe integer");
    }
  }

  /** Compatibility helper for callers that need a collected batch. The stdio
   * transport uses decode() to avoid retaining all messages in a large chunk.
   */
  push(chunk: Uint8Array): unknown[] {
    return Array.from(this.decode(chunk));
  }

  *decode(chunk: Uint8Array): IterableIterator<unknown> {
    if (this.closed) throw new McpFramingError("incomplete");
    let start = 0;
    try {
      for (let i = 0; i < chunk.byteLength; i++) {
        if (chunk[i] !== 10) continue;
        const segment = chunk.subarray(start, i);
        this.append(segment);
        const bytes = this.buffer.subarray(0, this.size);
        // CRLF is accepted, but CR still counts toward the size bound.
        const end = bytes.length && bytes[bytes.length - 1] === 13 ? bytes.length - 1 : bytes.length;
        let text: string;
        try {
          text = this.decoder.decode(bytes.subarray(0, end));
        } catch {
          throw new McpFramingError("invalid_utf8");
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new McpFramingError("invalid_json");
        }
        // JSON-RPC messages must be objects, not arrays or JSON primitives.
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new McpFramingError("invalid_json");
        }
        this.size = 0;
        yield parsed;
        start = i + 1;
      }
      this.append(chunk.subarray(start));
    } catch (error) {
      this.closed = true;
      this.size = 0;
      throw error;
    }
  }

  finish(): void {
    this.closed = true;
    if (this.size !== 0) {
      this.size = 0;
      throw new McpFramingError("incomplete");
    }
  }

  private append(bytes: Uint8Array): void {
    if (bytes.byteLength > this.maxBytes - this.size) {
      throw new McpFramingError("too_large");
    }
    if (bytes.byteLength > 0) {
      const required = this.size + bytes.byteLength;
      if (required > this.buffer.byteLength) {
        // Geometric growth bounds allocations even for single-byte chunks,
        // while never reserving more than the configured message limit.
        const capacity = Math.min(this.maxBytes, Math.max(required, 64, this.buffer.byteLength * 2));
        const next = new Uint8Array(capacity);
        next.set(this.buffer.subarray(0, this.size));
        this.buffer = next;
      }
      this.buffer.set(bytes, this.size); // caller may reuse the input buffer
      this.size = required;
    }
  }
}
