/** Immutable, content-addressed generation records for P0 #28.
 *
 * A generation is explicitly pinned by digest; there is no mutable "current"
 * pathname. This is an experimental foundation, not yet an adapter backend.
 */
import { MAX_IMMUTABLE_BLOB_BYTES, putImmutableBlob, readImmutableBlob } from "./immutable-store.js";
import { createHash } from "node:crypto";

export const MAX_GENERATION_FILES = 256;

export interface ImmutableGenerationFile {
  path: string;
  digest: string;
  size: number;
}

export interface ImmutableGeneration {
  schemaVersion: "1";
  agent: string;
  kind: "apply" | "cleanup";
  files: ImmutableGenerationFile[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validAgent(agent: unknown): agent is string {
  return typeof agent === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(agent);
}

function assertLogicalPath(path: string): void {
  if (typeof path !== "string" || path.length === 0 ||
      Buffer.byteLength(path, "utf8") > 512 || path.includes("\\") ||
      path.includes("\0") || path.includes(":") || path.startsWith("/")) {
    throw new Error("Unsafe immutable generation logical path");
  }
  const segments = path.split("/");
  if (segments.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Unsafe immutable generation logical path");
  }
  for (const character of path) {
    const codepoint = character.codePointAt(0)!;
    if (codepoint >= 0xd800 && codepoint <= 0xdfff ||
        codepoint < 0x20 || codepoint === 0x7f) {
      throw new Error("Unsafe immutable generation logical path");
    }
  }
}

function assertGeneration(value: unknown): asserts value is ImmutableGeneration {
  if (!isRecord(value) || value.schemaVersion !== "1" ||
      !validAgent(value.agent) ||
      (value.kind !== "apply" && value.kind !== "cleanup") ||
      !Array.isArray(value.files) || value.files.length > MAX_GENERATION_FILES ||
      Object.keys(value).some((key) => !["schemaVersion", "agent", "kind", "files"].includes(key))) {
    throw new Error("Invalid immutable generation manifest");
  }
  if (value.kind === "cleanup" && value.files.length !== 0) {
    throw new Error("Invalid immutable generation cleanup manifest");
  }
  let previous = "";
  let total = 0;
  for (const item of value.files) {
    if (!isRecord(item) || typeof item.path !== "string" ||
        typeof item.digest !== "string" || !/^[a-f0-9]{64}$/.test(item.digest) ||
        typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0 ||
        item.size > MAX_IMMUTABLE_BLOB_BYTES ||
        Object.keys(item).some((key) => !["path", "digest", "size"].includes(key))) {
      throw new Error("Invalid immutable generation file entry");
    }
    assertLogicalPath(item.path);
    if (previous && previous >= item.path) {
      throw new Error("Immutable generation paths must be sorted and unique");
    }
    previous = item.path;
    total += item.size;
    if (total > MAX_IMMUTABLE_BLOB_BYTES) {
      throw new Error("Immutable generation exceeds total byte limit");
    }
  }
}

/** Publish blobs first, then a complete immutable generation record last.
 * A failed operation may leave unreachable blobs but never a partial record.
 * Caller must retain the returned digest; there is no mutable latest pointer.
 */
function prepareImmutableGeneration(
  agent: string,
  kind: "apply" | "cleanup",
  files: Readonly<Record<string, Buffer>>,
): {
  digest: string;
  generation: ImmutableGeneration;
  manifestBytes: Buffer;
  snapshots: Array<[string, Buffer]>;
} {
  if (!validAgent(agent) || (kind !== "apply" && kind !== "cleanup")) {
    throw new Error("Invalid immutable generation identity");
  }
  const entries = Object.entries(files);
  if (entries.length > MAX_GENERATION_FILES || (kind === "cleanup" && entries.length !== 0)) {
    throw new Error("Invalid immutable generation file count");
  }
  let total = 0;
  const snapshots: Array<[string, Buffer]> = [];
  for (const [path, bytes] of entries) {
    assertLogicalPath(path);
    if (!Buffer.isBuffer(bytes)) throw new Error("Immutable generation file must be a Buffer");
    total += bytes.length;
    if (total > MAX_IMMUTABLE_BLOB_BYTES) {
      throw new Error("Immutable generation exceeds total byte limit");
    }
    snapshots.push([path, Buffer.from(bytes)]);
  }
  snapshots.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const manifestFiles: ImmutableGenerationFile[] = snapshots.map(([path, bytes]) => ({
    path, digest: createHash("sha256").update(bytes).digest("hex"), size: bytes.length,
  }));
  const generation: ImmutableGeneration = { schemaVersion: "1", agent, kind, files: manifestFiles };
  const manifestBytes = Buffer.from(JSON.stringify(generation), "utf8");
  if (manifestBytes.length > MAX_IMMUTABLE_BLOB_BYTES) {
    throw new Error("Immutable generation manifest exceeds byte limit");
  }
  return {
    digest: createHash("sha256").update(manifestBytes).digest("hex"),
    generation, manifestBytes, snapshots,
  };
}

/** Pure, non-mutating preview of the exact generation bytes that apply publishes.
 * No workspace or store path is read or written.
 */
export function previewImmutableGeneration(
  agent: string,
  kind: "apply" | "cleanup",
  files: Readonly<Record<string, Buffer>>,
): { digest: string; generation: ImmutableGeneration } {
  const { digest, generation } = prepareImmutableGeneration(agent, kind, files);
  return { digest, generation };
}

/** Publish blobs first, then a complete immutable generation record last.
 * Every input is snapshotted and validated before the first filesystem write.
 * A failed operation may leave unreachable blobs but never a partial record.
 */
export async function publishImmutableGeneration(
  store: string,
  agent: string,
  kind: "apply" | "cleanup",
  files: Readonly<Record<string, Buffer>>,
): Promise<{ digest: string; generation: ImmutableGeneration }> {
  const prepared = prepareImmutableGeneration(agent, kind, files);
  for (const [index, [, bytes]] of prepared.snapshots.entries()) {
    const blob = await putImmutableBlob(store, bytes);
    if (blob.digest !== prepared.generation.files[index]!.digest) {
      throw new Error("Immutable generation content digest changed during publication");
    }
  }
  const manifest = await putImmutableBlob(store, prepared.manifestBytes);
  if (manifest.digest !== prepared.digest) {
    throw new Error("Immutable generation digest changed during publication");
  }
  return { digest: prepared.digest, generation: prepared.generation };
}

/** Resolve a pinned generation and authenticate every referenced content blob. */
export async function readImmutableGeneration(
  store: string,
  digest: string,
): Promise<{ generation: ImmutableGeneration; files: Map<string, Buffer> }> {
  const raw = await readImmutableBlob(store, digest);
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new Error("Invalid immutable generation manifest");
  }
  assertGeneration(decoded);
  const files = new Map<string, Buffer>();
  for (const entry of decoded.files) {
    const bytes = await readImmutableBlob(store, entry.digest);
    if (bytes.length !== entry.size) {
      throw new Error("Immutable generation file size mismatch");
    }
    files.set(entry.path, bytes);
  }
  return { generation: decoded, files };
}

/** Resolve one logical file from an explicitly pinned generation.
 * This never materializes a workspace pathname, mutates a managed destination,
 * or follows a caller-supplied path. The manifest and blob are authenticated.
 * A cleanup generation intentionally exposes no files.
 */
export async function readPinnedGenerationFile(
  store: string,
  generationDigest: string,
  logicalPath: string,
  expectedAgent: string,
): Promise<Buffer | null> {
  assertLogicalPath(logicalPath);
  if (!validAgent(expectedAgent)) throw new Error("Invalid immutable generation identity");
  const raw = await readImmutableBlob(store, generationDigest);
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new Error("Invalid immutable generation manifest");
  }
  assertGeneration(decoded);
  if (decoded.agent !== expectedAgent) {
    throw new Error("Immutable generation belongs to another agent");
  }
  if (decoded.kind === "cleanup") return null;
  const entry = decoded.files.find((file) => file.path === logicalPath);
  if (!entry) return null;
  const bytes = await readImmutableBlob(store, entry.digest);
  if (bytes.length !== entry.size) {
    throw new Error("Immutable generation file size mismatch");
  }
  return bytes;
}

/** Explicit adapter-facing immutable lifecycle. The caller supplies a protected
 * store and retains returned digests; no workspace path is published or removed.
 * This deliberately does not pretend to satisfy legacy apply()/cleanup().
 */
export class PinnedImmutableAdapter {
  constructor(public readonly agent: string, private readonly store: string) {
    if (!validAgent(agent)) throw new Error("Invalid immutable generation identity");
  }

  apply(files: Readonly<Record<string, Buffer>>): Promise<{ digest: string; generation: ImmutableGeneration }> {
    return publishImmutableGeneration(this.store, this.agent, "apply", files);
  }

  cleanup(): Promise<{ digest: string; generation: ImmutableGeneration }> {
    return publishImmutableGeneration(this.store, this.agent, "cleanup", {});
  }

  readFile(generationDigest: string, logicalPath: string): Promise<Buffer | null> {
    return readPinnedGenerationFile(this.store, generationDigest, logicalPath, this.agent);
  }
}
