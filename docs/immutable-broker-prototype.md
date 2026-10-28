# Experimental separate-UID immutable blob broker (P0 #28)

**Status: prototype, not an accepted strict adapter backend.** The default
strict lifecycle remains fail-closed. Do not merge PR #97 or close #28 based on
this broker alone.

## Why a separate process?

A same-UID process can `chmod` and overwrite a `0400` blob and can rename a
`0700` store directory under an ancestor it owns. Content hashing detects
modified bytes but cannot prevent destruction or namespace substitution.
A different OS UID and a trusted ancestor chain are necessary to isolate
published blobs from untrusted workspace writers.

`scripts/immutable-store-broker.mjs` is an opt-in Unix-domain-socket process
that calls the **built** immutable blob backend. It does not touch legacy
workspace paths. It never exposes arbitrary path reads, renames, or deletes
through its protocol. It does **not** implement generation selection,
authorization, migration, quotas, or strict lifecycle wiring.

## Provisioning requirements

An administrator must provision a dedicated, **non-root** service UID that
is not shared with any untrusted workspace writer, and a client group with
access to the socket. The socket parent directory must be owned by the
service UID, not group/world writable, and group-searchable (for example
`0710`). The immutable store must already exist, be owned by the service
UID, and be private (`0700`). Every ancestor must be owned by root or the
service UID; writable ancestors must have sticky protection. An unrelated
UID owning even a `0755` ancestor is unsafe because its owner can rename
children. The broker validates these prerequisites before accepting clients;
the blob backend also checks the store ancestry on each operation.

Build the project first. Then launch under the service UID, with the service
group set to the intended client group:

```sh
SKILLGATE_BROKER_CLIENT_UID=<untrusted-workspace-uid> \
SKILLGATE_BROKER_CLIENT_GID=<dedicated-nonroot-client-group-gid> \
  node scripts/immutable-store-broker.mjs \
  /protected/socket-dir/skillgate.sock /protected/immutable-store
```

The client UID setting is a **deployment sanity check**, not peer-credential
authentication. The client GID must be an explicitly configured non-root
numeric group ID matching the broker's effective GID. Startup fails closed
if the socket is not owned by that group or its permissions are not exactly
`0660`. Configure the service's effective group and the socket-parent group
through the OS service manager; the environment variable does **not** change
process credentials. The process rejects root execution and a client UID equal to
the service UID, but cannot verify the UID of each connecting peer using
Node's portable socket API. The Unix socket's group permission is the access
control: **all members of that group can use both operations**. Never put
untrusted principals in the socket group if they must not read one another's
skills. Do not place the store or socket parent inside a mutable workspace.
Provision storage quotas externally; the protocol limits individual requests
but not aggregate disk usage. Stale sockets after abnormal termination require
operator-controlled recovery; the broker refuses to unlink an existing path.

## Experimental wire format

One newline-terminated JSON request per connection; one newline-terminated
JSON response. Protocol version is `1`. Request bytes and returned bytes
are canonical base64; digests are lowercase SHA-256 hex.

```json
{"v":1,"op":"put","bytes":"aGVsbG8="}
```

Success returns `{"v":1,"ok":true,"digest":"<sha256>","created":true}`
(or `created:false` for a verified existing blob).

```json
{"v":1,"op":"get","digest":"<64-lowercase-hex>"}
```

Success returns `{"v":1,"ok":true,"bytes":"<base64>"}`. Invalid requests
receive a generic error, without leaking store paths. Each blob is limited
to 32 MiB; the broker enforces bounded framing, strict UTF-8, one in-flight
request, a 15-second idle timeout, and a separate 15-second absolute
connection lifetime. The absolute deadline prevents a slow-drip peer from
holding the single connection slot indefinitely by sending periodic bytes.
An already-started disk operation is not cancelled when its socket expires. These are availability mitigations, not
per-client authorization or a comprehensive denial-of-service defense.

## Validation and acceptance blockers

An **isolated** Linux/Node 22 cross-UID smoke using a surrogate blob backend
passed: a dedicated service UID served `put`/`get` over a `0660` socket,
rejected a traversal-like digest, and an unrelated client UID could not
`chmod` the service-owned `0400` blob. This is **not** a test of the
built SkillGate implementation.

Before strict integration: run the real built broker with two distinct UIDs,
test hostile socket peers and storage ancestors, validate bounded request
handling, integrate a trusted generation-selection and consumer path, enforce
appropriate resource quotas and authorization, run full typecheck/Vitest/build,
and execute the built SIGKILL recovery smoke. Revisit the security boundary
under the actual deployment's OS, filesystem, service manager, and user/group
configuration. No strict adapter should invoke this prototype automatically.
