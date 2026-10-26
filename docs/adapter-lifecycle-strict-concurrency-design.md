# P0 #28 — strict concurrent-writer safety design (Option B)

Status: **design only; NOT implemented or accepted**. This document records the required boundary and blocks merging #97 until implementation and verification are complete.

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
