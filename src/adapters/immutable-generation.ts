/** Immutable, content-addressed generation records for P0 #28.
 *
 * A generation is explicitly pinned by digest; there is no mutable "current"
 * pathname. This is an experimental foundation, not yet an adapter backend.
 */
import { MAX_IMMUTABLE_BLOB_BYTES, putImmutableBlob, readImmutableBlob } from "./immutable-store.js";

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
export async function publishImmutableGeneration(
  store: string,
  agent: string,
  kind: "apply" | "cleanup",
  files: Readonly<Record<string, Buffer>>,
): Promise<{ digest: string; generation: ImmutableGeneration }> {
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
    // Freeze all file bytes before the first await so the published generation
    // cannot mix different revisions of caller-owned mutable Buffers.
    snapshots.push([path, Buffer.from(bytes)]);
  }
  snapshots.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const manifestFiles: ImmutableGenerationFile[] = [];
  for (const [path, bytes] of snapshots) {
    const blob = await putImmutableBlob(store, bytes);
    manifestFiles.push({ path, digest: blob.digest, size: bytes.length });
  }
  const generation: ImmutableGeneration = { schemaVersion: "1", agent, kind, files: manifestFiles };
  const manifest = await putImmutableBlob(store, Buffer.from(JSON.stringify(generation), "utf8"));
  return { digest: manifest.digest, generation };
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
