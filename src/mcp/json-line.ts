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
  private readonly parts: Uint8Array[] = [];
  private size = 0;
  private closed = false;

  constructor(private readonly maxBytes = MAX_MCP_MESSAGE_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError("maxBytes must be a positive safe integer");
    }
  }

  push(chunk: Uint8Array): unknown[] {
    if (this.closed) throw new McpFramingError("incomplete");
    const messages: unknown[] = [];
    let start = 0;
    try {
      for (let i = 0; i < chunk.byteLength; i++) {
        if (chunk[i] !== 10) continue;
        const segment = chunk.subarray(start, i);
        this.append(segment);
        const bytes = new Uint8Array(this.size);
        let offset = 0;
        for (const part of this.parts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
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
        messages.push(parsed);
        this.parts.length = 0;
        this.size = 0;
        start = i + 1;
      }
      this.append(chunk.subarray(start));
      return messages;
    } catch (error) {
      this.closed = true;
      this.parts.length = 0;
      this.size = 0;
      throw error;
    }
  }

  finish(): void {
    this.closed = true;
    if (this.size !== 0) {
      this.parts.length = 0;
      this.size = 0;
      throw new McpFramingError("incomplete");
    }
  }

  private append(bytes: Uint8Array): void {
    if (bytes.byteLength > this.maxBytes - this.size) {
      throw new McpFramingError("too_large");
    }
    if (bytes.byteLength > 0) {
      this.parts.push(bytes.slice()); // caller may reuse the input buffer
      this.size += bytes.byteLength;
    }
  }
}
