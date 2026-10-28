# P0 #28 — strict concurrent-writer safety design (Option B)

Status: **partially implemented, NOT accepted for strict lifecycle use**. The immutable generation prototype is opt-in; default strict adapter apply/cleanup remains fail-closed.

## Requirement

An unrelated process may concurrently create, replace, edit, rename, or delete managed workspace entries without acquiring a SkillGate lock. Ordinary `apply` and `cleanup` must never overwrite or unlink a user-owned entry as a result. An explicit force option does not authorize deleting a different entry that appeared after authorization.

## Existing unsafe mutation sites

- `writeManagedFile()`: final ownership check followed by `rename(temp, destination)` can replace a newly substituted entry.
- `applyFilesystemAdapterUnlocked()`: final check followed by `rm(staleFile)` can delete a newly substituted entry.
- `cleanupFilesystemAdapterUnlocked()`: final check followed by `rm(filePath)` has the same race.

The temporary-directory lock serializes only cooperating writers. `lstat`, digest checks, and an open descriptor cannot make a later pathname mutation conditional on the checked inode. `renameat2(RENAME_NOREPLACE)` can protect **absent** destinations, but does not conditionally replace an existing inode. A rename-exchange followed by checking the displaced inode is also insufficient for a no-transient-overwrite guarantee and introduces recovery complexity.

## Implementation gate

1. Define the supported operating systems/filesystems and a primitive that provides an **atomic conditional replacement/removal of the expected destination entry**. Do not claim a portable Node.js filesystem API supplies this primitive.
2. If the platform cannot provide that guarantee, fail closed **before workspace mutation**. Do not silently fall back to `rename` or `rm` under Option B.
3. Preserve ownership evidence and crash recovery across staging, commit, and cleanup. Validate directory ancestry against concurrent substitutions as well as the final entry.
4. Add adversarial tests with an independent writer racing destination substitution at the commit point, including symlinks, hard links, parent directory replacement, and interrupted operations. Verify that no user-owned content is lost.
5. Run typecheck, adapter tests, build, and integration tests on supported platforms. Review the atomicity argument before making PR #97 ready or closing #28.

**Open design risk:** mainstream path-based rename/unlink APIs, including standard Node.js fs APIs, cannot express compare-and-swap on a pathname's current inode. A safe solution may require a platform-specific native component, a filesystem transaction facility, or changing the storage/ownership model. Until a defensible primitive is selected and validated, #28 remains open.

## Interim fail-closed enforcement (2026-10-26)

The current branch now defaults mutating `apply` and `cleanup` to **strict**. Until an atomic backend exists, both reject before creating the adapter root or lock. `force: true` does not override this restriction. Explicit `{ concurrency: "cooperative" }` is retained only for legacy behavior and is **not** Option B; it must not be used to claim strict safety.

**Compatibility warning:** This is an intentional breaking safety change. Existing lifecycle integration tests and callers that previously omitted the concurrency option must be migrated to explicit cooperative mode **only when testing the old boundary**, or to the eventual atomic backend. The full suite has not been run; do not merge this branch based on static inspection.

**Not complete:** Strict mode currently rejects mutations rather than performing safe atomic replacement or cleanup. #28 acceptance remains blocked until the backend and adversarial tests exist.

## Accepted storage-layout direction (2026-10-28; implementation in progress)

The owner has authorized a **breaking managed-file storage layout change**. Strict
mode will no longer update or unlink contested adapter-visible workspace paths.
Instead, it will use a **trusted private append-only store outside the workspace**,
publish immutable generations, and make readers resolve a generation explicitly.
This avoids requiring a nonexistent Node.js pathname compare-and-swap primitive.

### Trust and platform boundary

- A non-cooperating process may mutate any legacy workspace path, including
  replacing entries and ancestor directories. Strict mode must not write to,
  rename, or unlink those paths, including during cleanup.
- The immutable store and **all of its ancestors** must be protected against
  substitution by the adversary. POSIX mode 0700 on the leaf alone does not
  establish that boundary. A same-UID adversary can modify a 0700 store;
  a distinct OS identity, sandbox/ACL boundary, or equivalently enforceable
  isolation is required if same-UID adversaries are in scope.
- Until that isolation and a protected store-location policy are implemented,
  the new `putImmutableBlob` primitive is **experimental only**. It enforces a
  private POSIX leaf directory, read-only digest entries, bounded descriptor
  verification, and create-if-absent publication, but is **not wired to strict
  apply or cleanup**.
- Unsupported platforms and unsafe store roots must fail closed before mutation.
  No fallback to path-based `rename`/`rm`, including with `force: true`.

### Publication and cleanup model

1. Preflight the entire plan and read sources before any publication. Reject
   unsafe paths, excessive sizes, malformed UTF-8, and ambiguous legacy ownership.
2. Stage each content blob under a random private name, fsync it, make it
   read-only, then hard-link into a SHA-256 content-addressed location using
   create-if-absent semantics. Verify existing digest collisions through a
   bounded descriptor read. Never overwrite an existing digest entry.
3. Publish a **new immutable generation record** that references only verified
   blob digests and explicitly lists the adapter, logical paths, and schema
   version. A generation is visible only after its complete record is
   durably published. A reader must pin and verify a generation, not follow a
   mutable workspace pointer. Concurrent publication ordering must be
   deterministic and must not silently discard updates.
4. Represent cleanup as a new **tombstone generation**, not by deleting legacy
   workspace entries. Garbage collection of unreachable blobs is separate,
   requires an independently proven safe private-store boundary, and must
   not race active readers. No GC is required to satisfy cleanup semantics.
5. Legacy adapter paths remain read-only in strict mode. Migration may import
   their bytes into the private store but must not remove or replace them.
   Any adapter requiring a fixed mutable workspace filename is unsupported in
   strict mode until its consumer can resolve immutable generations.


### Ancestor ownership is part of the isolation boundary (2026-10-28)

An isolated POSIX proof exposed another concrete preflight gap: an
**unrelated UID owning an ancestor directory with mode 0755** can rename a
broker-owned 0700 child directory. Group/world write-bit checks alone cannot
detect this, because the directory **owner** retains write permission.
A sticky ancestor owned by that unrelated UID is also unsafe: sticky mode
does not restrict the directory owner.

The experimental store now rejects any ancestor (including the filesystem
root) whose UID is neither root (0) nor the store process UID, in addition to
the existing mode and symlink checks. Tests inject foreign-owned 0755 and
01777 ancestors and assert rejection before staging. This is a necessary
**preflight policy**, not an atomic race solution: if the store process UID is
shared with an adversarial workspace writer, that writer can still mutate
the store and its broker-owned ancestors. A distinct, OS-enforced broker
identity with protected ancestry remains mandatory for Option B. The
cross-UID proof was isolated; committed Vitest and full integration checks
remain pending.

### Canonical store path consistency (2026-10-28)

A concrete preflight/write mismatch was found: a pathname containing a
symlink followed by `..` can be resolved by the kernel differently from
`path.resolve()`. Previously the ancestry validator inspected the normalized
path while blob I/O used the unnormalized caller-supplied path. The real-context
workspace-containment check also used `realpath(rawStore)`, which could
therefore inspect a different store than the blob writer.

The prototype now uses the **same normalized absolute pathname** for checked
ancestry, blob reads/writes, and directory fsync; real-context containment
checks `realpath(resolve(store))` against the workspace. Regression tests cover
redirection to another store and an alias that would bypass the in-workspace
store rejection. This removes the specific lexical/OS path disagreement, **not**
the race between preflight and I/O: same-UID adversaries or writers able to
replace ancestors after validation remain outside the proven boundary.

### Required proof before enabling strict mutation

- Adversarial tests with an independent writer mutating every legacy workspace
  entry and its ancestors at publication/cleanup boundaries: no user-owned entry
  may be replaced or deleted, even transiently.
- Tests for same-UID access to the store and for ancestor substitution. If the
  OS cannot isolate the store from the modeled adversary, strict mode must
  reject rather than promise protection.
- Concurrent generation publication, reader pinning, crash recovery after each
  staging/fsync/link boundary, idempotent apply, dry-run parity, and tombstone
  cleanup must be verified.
- Codex/Claude consumers must be migrated to generation resolution and tested
  end-to-end. Run typecheck, Vitest, build, and integration tests on each
  supported platform. Do not mark PR #97 ready or close #28 before this gate.

### Opt-in context integration (2026-10-28)

Codex and Claude expose `adapter.immutable(store)` with `planContext(context)`,
`applyContext(context)`, `planCleanup()`, `cleanup()`, and
`readFile(generationDigest, logicalPath)`. This is experimental and explicit,
not a replacement for the default `adapter.apply()` or `adapter.cleanup()`.

`planContext()` reads bounded, snapshot-verified skill sources and predicts the
exact generation digest without modifying the workspace or immutable store.
`applyContext()` re-reads the sources, validates all content before publication,
and publishes `skills.json` plus `skills/<identifier>/SKILL.md` into immutable
blobs. Unchanged source bytes produce identical plan/apply digests.
Cleanup publishes a tombstone; pinned reads authenticate the manifest and blob.

The caller must supply a pre-existing, protected POSIX store. Current
ownership, mode, and ancestor checks are preflight hardening, NOT an atomic
guarantee against same-UID adversaries or substitutable directory ancestors.
No automatic latest-generation pointer or consumer migration exists.
Consumers requiring fixed `.codex` or `.claude` workspace filenames cannot
yet use this as a drop-in replacement.

Committed regressions cover real context plan/apply parity, user-owned legacy
workspace preservation, malformed source rejection, ancestor validation, and
an independent process racing legacy workspace paths. Full Vitest, typecheck,
build, and adversarial validation remain pending.

**Current status:** Opt-in real-context immutable publication is implemented;
default strict apply/cleanup still fails closed. Protected-store isolation,
consumer selection, migration, crash-recovery fault injection, and full
validation are outstanding. Issue #28 stays open; PR #97 stays draft.

### Pinned consumer resolution and workspace-root exclusion (2026-10-28)

The experimental `PinnedImmutableAdapter.readContext(digest)` now authenticates the
entire generation, validates `skills.json` against the pinned agent and every
referenced logical skill path, rejects missing/unlisted blobs, and returns
in-memory buffers.
It also rejects pinned skill blobs without the SkillGate ownership header or
with malformed UTF-8, even when their content digests are internally valid.
These semantic checks do **not** establish store isolation, authorize an
untrusted generation digest, or make the opt-in API safe against same-UID
writers. A cleanup tombstone resolves to `null`. This is a
consumer-facing read API, **not** automatic Codex/Claude discovery or a
drop-in replacement for their fixed workspace paths.

`applyContext()` now rejects a store whose canonical path lies inside the
canonical workspace root, before any blob publication. This is a preflight
policy, **not** an atomic filesystem isolation primitive. A same-UID adversary
or attacker able to substitute an ancestor after the check still defeats the
store trust boundary; strict legacy apply/cleanup therefore remains fail-closed.
Committed regressions cover pinned context resolution, forged metadata
references, tombstones, and nested-store rejection. Full Vitest/typecheck/build
and independent adversarial isolation validation remain outstanding.

### Built process-kill recovery smoke (pending production execution)

After `npm run build` on a POSIX host, run
`npm run smoke:immutable-crash`. The script spawns a separate Node process
using the **built** `dist/adapters/immutable-generation.js` implementation.
It pauses that child after each of four filesystem sync boundaries for a
one-file generation, sends a real `SIGKILL`, then checks manifest visibility,
authenticated reads, and idempotent retry. No fault-injection hooks are added
to production code. The four checkpoints cover staging and publication of
both the content blob and the generation manifest.

This is a **process-crash** test, not a power-loss/disk-cache durability
proof. It does not demonstrate protection against same-UID writers, ancestor
substitution, or arbitrary external filesystem mutations. The script is
committed but has **not** been run against the built repository while checkout
and build are blocked. A local harness check using a surrogate implementation
does not count as production validation. PR #97 remains draft and strict
legacy apply/cleanup remains fail-closed.

### Independent same-UID adversarial proof (2026-10-28)

`src/adapters/immutable-store-same-uid.test.ts` adds independent-process
regressions for the two concrete limitations of the experimental POSIX store:

- A process with the same UID can chmod a published `0400` digest inode back
  to writable and replace its bytes. A subsequent digest-authenticated read or
  collision verification must **reject** the changed entry; detection does not
  restore the original content or prevent the destructive write.
- A process with the same UID can rename a `0700` store under a parent it
  controls and create a different `0700` directory at the original pathname.
  The original generation survives under the displaced pathname, but the
  consumer's pinned lookup no longer reaches it. Digest authentication does not
  provide namespace availability or bind a pathname to a directory inode.

Both behaviors were reproduced with independent Node.js 22 processes in an
isolated POSIX filesystem experiment. The committed Vitest tests have **not**
run against the full repository. These are intentionally *negative* security
tests: they demonstrate why the existing store must remain experimental.

**Acceptance gate:** do not wire this path-based store into strict apply/cleanup
or claim Option B until the publisher and consumer use an enforceably protected
namespace (for example, a separately privileged append-only storage service
with protected ancestry and no mutation/delete operation exposed to the
workspace UID). A same-UID process must not be able to rename store ancestors
or modify published inodes. Merely detecting a changed digest after the fact
does not satisfy the no-overwrite/no-delete guarantee.
