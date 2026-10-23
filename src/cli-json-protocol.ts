/** Stable machine-readable CLI envelope. Progresses #31.
 *
 * Keep this module independent of command execution so a JSON error can be
 * emitted even when argument parsing or configuration resolution fails.
 */
export const JSON_PROTOCOL_VERSION = 1 as const;

export type JsonProtocolCommand =
  | "scan"
  | "recommend"
  | "trace"
  | "doctor"
  | "config";

export type JsonProtocolErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED_PROTOCOL"
  | "CONFIGURATION_ERROR"
  | "POLICY_ERROR"
  | "ADAPTER_CONFLICT"
  | "INTERNAL_ERROR";

export interface JsonProtocolSuccess<T> {
  protocolVersion: typeof JSON_PROTOCOL_VERSION;
  command: JsonProtocolCommand;
  ok: true;
  data: T;
}

export interface JsonProtocolFailure {
  protocolVersion: typeof JSON_PROTOCOL_VERSION;
  command: string | null;
  ok: false;
  /** Optional structured diagnostics (doctor failures only in v1). */
  data?: { report: unknown };
  error: {
    code: JsonProtocolErrorCode;
    message: string;
  };
}

export type JsonProtocolEnvelope<T> = JsonProtocolSuccess<T> | JsonProtocolFailure;

export function jsonSuccess<T>(command: JsonProtocolCommand, data: T): JsonProtocolSuccess<T> {
  return { protocolVersion: JSON_PROTOCOL_VERSION, command, ok: true, data };
}

/** Pass only display-safe messages; never include stack traces or credentials. */
export function jsonFailure(
  command: string | null,
  code: JsonProtocolErrorCode,
  message: string,
): JsonProtocolFailure {
  return {
    protocolVersion: JSON_PROTOCOL_VERSION,
    command,
    ok: false,
    error: { code, message },
  };
}

/** Exactly one compact UTF-8 JSON document and a terminating newline. */
export function jsonLine<T>(envelope: JsonProtocolEnvelope<T>): string {
  return JSON.stringify(envelope) + "\n";
}
