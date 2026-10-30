/** Immutable, content-addressed generation records for P0 #28.
 *
 * A generation is explicitly pinned by digest; there is no mutable "current"
 * pathname. This is an experimental foundation, not yet an adapter backend.
 */
import { MAX_IMMUTABLE_BLOB_BYTES, assertPrivateStore, putImmutableBlob, readImmutableBlob } from "./immutable-store.js";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { prepareImmutableAdapterContext, wellFormedImmutableText } from "./immutable-context.js";
import { toSafeSkillIdentifier } from "./safe-path.js";
import { OWNERSHIP_HEADER } from "./filesystem-lifecycle.js";
import type { AdapterContext } from "./types.js";

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

/** Plan and apply must reject the same unsafe store placement before reading
 * skill sources. This preflight does not establish protection against a
 * non-cooperating writer; the store must still have trusted OS ownership.
 */
async function assertStoreOutsideWorkspace(workspaceRoot: string, storePath: string): Promise<void> {
  // Plan and apply must enforce the same store ownership, ancestry and kernel
  // flag preflight before reading skill sources. The check is read-only.
  await assertPrivateStore(storePath);
  // Match the canonical pathname used by immutable-store I/O. Resolving the
  // raw symlink/../ path instead can disagree with its lexical normalization.
  const [workspace, store] = await Promise.all([realpath(workspaceRoot), realpath(resolve(storePath))]);
  const fromWorkspace = relative(workspace, store);
  if (fromWorkspace === "" || (fromWorkspace !== ".." &&
      !fromWorkspace.startsWith(`..${sep}`) && !isAbsolute(fromWorkspace))) {
    throw new Error("Immutable SkillGate store must be outside the workspace");
  }
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

  /** Predict the exact digest of a proposed generation without filesystem I/O. */
  plan(files: Readonly<Record<string, Buffer>>): { digest: string; generation: ImmutableGeneration } {
    return previewImmutableGeneration(this.agent, "apply", files);
  }

  /** Read and validate real skill sources, then preview without any mutation. */
  async planContext(context: AdapterContext): Promise<{ digest: string; generation: ImmutableGeneration }> {
    await assertStoreOutsideWorkspace(context.root, this.store);
    const files = await prepareImmutableAdapterContext(this.agent, context);
    return this.plan(files);
  }

  /** Read real skill sources and publish them only into the immutable store. */
  async applyContext(context: AdapterContext): Promise<{ digest: string; generation: ImmutableGeneration }> {
    await assertStoreOutsideWorkspace(context.root, this.store);
    const files = await prepareImmutableAdapterContext(this.agent, context);
    return this.apply(files);
  }

  planCleanup(): { digest: string; generation: ImmutableGeneration } {
    return previewImmutableGeneration(this.agent, "cleanup", {});
  }

  cleanup(): Promise<{ digest: string; generation: ImmutableGeneration }> {
    return publishImmutableGeneration(this.store, this.agent, "cleanup", {});
  }

  readContext(generationDigest: string): ReturnType<typeof readPinnedAdapterContext> {
    return readPinnedAdapterContext(this.store, generationDigest, this.agent);
  }

  readFile(generationDigest: string, logicalPath: string): Promise<Buffer | null> {
    return readPinnedGenerationFile(this.store, generationDigest, logicalPath, this.agent);
  }
}

/** Consumer-facing resolution of a pinned real-context generation.
 * The complete generation is authenticated before metadata is exposed.
 * Logical paths are returned as in-memory buffers, never materialized into
 * the caller's mutable workspace. Cleanup tombstones resolve to null.
 */
export async function readPinnedAdapterContext(
  store: string,
  generationDigest: string,
  expectedAgent: string,
): Promise<{ task: string; skills: Array<{
  name: string; identifier: string; description: string; path: string;
  sourcePath: string; score: number; capabilities: string[];
}>; files: Map<string, Buffer> } | null> {
  if (!validAgent(expectedAgent)) throw new Error("Invalid immutable generation identity");
  const { generation, files } = await readImmutableGeneration(store, generationDigest);
  if (generation.agent !== expectedAgent) {
    throw new Error("Immutable generation belongs to another agent");
  }
  if (generation.kind === "cleanup") return null;
  const raw = files.get("skills.json");
  if (!raw) throw new Error("Missing immutable adapter context metadata");
  let metadata: unknown;
  try {
    metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new Error("Invalid immutable adapter context metadata");
  }
  if (!isRecord(metadata) || metadata.schemaVersion !== "1" ||
      metadata.agent !== expectedAgent || typeof metadata.task !== "string" ||
      !wellFormedImmutableText(metadata.task) ||
      !Array.isArray(metadata.skills) || metadata.skills.length > MAX_GENERATION_FILES - 1 ||
      Object.keys(metadata).some((key) => !["schemaVersion", "agent", "task", "skills"].includes(key))) {
    throw new Error("Invalid immutable adapter context metadata");
  }
  const paths = new Set<string>(["skills.json"]);
  const validated: Array<{
    name: string; identifier: string; description: string; path: string;
    sourcePath: string; score: number; capabilities: string[];
  }> = [];
  for (const entry of metadata.skills) {
    if (!isRecord(entry) || typeof entry.name !== "string" ||
        !wellFormedImmutableText(entry.name) ||
        typeof entry.identifier !== "string" || !wellFormedImmutableText(entry.identifier) ||
        typeof entry.description !== "string" || !wellFormedImmutableText(entry.description) ||
        typeof entry.sourcePath !== "string" || !wellFormedImmutableText(entry.sourcePath) ||
        typeof entry.path !== "string" || !wellFormedImmutableText(entry.path) ||
        typeof entry.score !== "number" || !Number.isFinite(entry.score) ||
        !Array.isArray(entry.capabilities) ||
        !entry.capabilities.every((capability: unknown) =>
          typeof capability === "string" && wellFormedImmutableText(capability)) ||
        Object.keys(entry).some((key) => !["name", "identifier", "description", "path", "sourcePath", "score", "capabilities"].includes(key))) {
      throw new Error("Invalid immutable adapter skill metadata");
    }
    assertLogicalPath(entry.path);
    // A digest authenticates bytes, not their semantic identity. Reject
    // handcrafted metadata whose identifier differs from the canonical
    // identifier derived from its skill name.
    let canonicalId: string;
    try {
      canonicalId = toSafeSkillIdentifier(entry.name);
    } catch {
      throw new Error("Invalid immutable adapter skill identifier");
    }
    if (entry.identifier !== canonicalId ||
        entry.path !== `skills/${entry.identifier}/SKILL.md` ||
        paths.has(entry.path) || !files.has(entry.path)) {
      throw new Error("Immutable adapter context references an invalid skill file");
    }
    // A digest authenticates stored bytes but does not prove that a pinned
    // generation contains a valid SkillGate-managed skill document. The
    // real-context publisher always prefixes the ownership header and reads
    // strict UTF-8; consumers must enforce those same invariants on reads.
    const skillBytes = files.get(entry.path)!;
    const headerBytes = Buffer.from(OWNERSHIP_HEADER, "utf8");
    if (skillBytes.length < headerBytes.length ||
        !skillBytes.subarray(0, headerBytes.length).equals(headerBytes)) {
      throw new Error("Invalid immutable adapter skill content");
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(skillBytes.subarray(headerBytes.length));
    } catch {
      throw new Error("Invalid immutable adapter skill content");
    }
    paths.add(entry.path);
    validated.push({
      name: entry.name, identifier: entry.identifier,
      description: entry.description, path: entry.path,
      sourcePath: entry.sourcePath, score: entry.score,
      capabilities: entry.capabilities as string[],
    });
  }
  if (paths.size !== files.size) {
    throw new Error("Immutable adapter context contains unreferenced files");
  }
  return { task: metadata.task, skills: validated, files };
}
