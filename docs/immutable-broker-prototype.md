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
process credentials. The process rejects root execution, a client UID equal to the service UID,
real/effective UID or GID mismatches, and **any supplementary group other
than the effective service GID**. Node includes the effective GID in
`process.getgroups()`, so the broker requires that array to contain exactly
one entry equal to its effective GID. Merely rejecting supplementary GID 0
is insufficient: a retained non-root group such as `docker` can still grant
privileged socket or file access. Provision with `--clear-groups` or an
equivalent service-manager configuration; do not retain auxiliary groups.
These checks prevent inheriting unintended filesystem privileges while
appearing to run under a dedicated non-root identity. **The prototype broker now requires Linux**, with a genuine
`/proc` filesystem and zero `CapInh`, `CapPrm`, `CapEff`, `CapBnd`, and
`CapAmb` capability masks, plus `NoNewPrivs: 1` in `/proc/self/status`.
The startup guard also verifies all four kernel `Uid` and `Gid` fields
(real, effective, saved-set, and filesystem IDs) against the Node process
credentials. This matters even when every capability mask is zero and
`NoNewPrivs: 1`: an isolated Linux process with real/effective UID 12001,
saved UID 0, and empty capabilities could still call `seteuid(0)` and regain
effective root. Merely checking `getuid()` and `geteuid()` misses that state.
Provisioning must irreversibly drop **saved** root IDs as well as capabilities;
missing, duplicate, or inconsistent kernel identity fields fail closed.
This fails closed on macOS, other POSIX systems, missing procfs, retained
capabilities, or a process able to regain privilege through a setuid exec.
A deployment must drop real/effective credentials and root groups before
launch, and configure its service manager with `NoNewPrivileges=yes`,
`CapabilityBoundingSet=` (empty), and `AmbientCapabilities=` (empty).
For a Linux isolated test, a privileged operator can use
`setpriv --no-new-privs --bounding-set=-all --reuid <broker-uid> --regid <client-gid> --clear-groups`
**before** invoking Node; do not grant the broker elevated capabilities.
Run the dependency-free startup regressions with
`node --test scripts/immutable-broker-identity.test.mjs scripts/immutable-broker-capabilities.test.mjs`
(these test startup guards, not the built broker). The broker cannot verify the
UID of each connecting peer using Node's portable socket API. The Unix socket's group permission is the access
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

## Experimental authenticated client

`scripts/immutable-broker-client.mjs` provides `putBrokerBlob(socketPath, bytes, options)`
and `getBrokerBlob(socketPath, digest, options)` for an **explicitly configured** Unix
socket. Both operations now require `options.expectedBrokerUid` and
`options.expectedBrokerGid` (positive numeric Linux IDs provisioned by an
administrator), and fail closed before sending any request if these are absent.
The client checks that the socket is owned by the pinned broker UID and GID,
uses mode `0660`, and resides under root- or broker-owned, non-substitutable
ancestry. The immediate socket parent must be broker-owned and not group/world
writable. This prevents an untrusted workspace writer from impersonating the
broker and receiving private `put` payloads through an attacker-owned socket.
These are pathname preflight checks, not kernel peer-credential authentication;
they rely on the separate broker UID, trusted root, and protected ancestors.
The expected broker UID must differ from untrusted client UIDs in production.
Both operations use one newline-delimited JSON request per connection, bounded
responses, a 15-second maximum deadline, and exact versioned response shapes.
The client snapshots outgoing buffers and independently verifies SHA-256 on
both publication acknowledgments and retrieved bytes. It rejects malformed
framing, noncanonical base64, mismatched digests, unexpected response fields,
and timeouts. It writes a newline without half-closing the connection, because
the broker performs asynchronous filesystem operations before replying.

Run its dependency-free socket protocol tests with:

```sh
node --test scripts/immutable-broker-client.test.mjs
```

These tests use an in-process protocol fixture; they do **not** prove the
actual built broker, cross-UID isolation, or deployment configuration. A
digest authenticates content but does not establish which generation a consumer
is allowed to select. Socket ownership and ancestry checks reduce endpoint
impersonation by unrelated UIDs, but do not authenticate individual peers or
guarantee availability. The socket path and its directory ancestry must be provisioned
and protected by an administrator. All authorized socket-group members can
still publish and retrieve any digest they know. The client is **not** wired
into strict lifecycle apply/cleanup or trusted generation selection.

## Real built-broker integration smoke (explicit, privileged)

After `npm run build`, an administrator can run the **actual built**
immutable-store backend and broker across separate Linux UIDs:

```sh
sudo npm run smoke:immutable-broker-real
```

This opt-in test requires Linux, root privileges, Node.js, and util-linux
`setpriv`. It copies the built blob module and broker/client scripts into a
disposable root-owned directory under `/tmp`, selects three currently unused
numeric UID/GID values without creating host accounts, and launches the broker
with an empty capability bounding set and `NoNewPrivs=1`. The untrusted
client connects through a group-restricted socket, verifies real put/get,
deduplication and digest authentication, and attempts prohibited `chmod`,
`rename`, and file creation against the protected store. The test removes
its sandbox even when an assertion fails. **Do not run it on an untrusted
multi-user host:** numeric identities can be allocated concurrently by an
administrator, and the test does not lock the host account database.

The smoke is intentionally excluded from ordinary `npm test` and CI because
it requires elevated setup privileges. Passing it does not establish peer
identity authentication, persistent disk quotas, crash recovery, safe
concurrent generation selection, or the full Option B security guarantee.
Run `npm run smoke:immutable-crash` separately after the build, then complete
full typecheck, Vitest, adversarial testing, and consumer migration.

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


## Optional Linux kernel-authenticated broker proxy (2026-10-29)

The raw Node broker socket **does not authenticate individual peers**: any
process able to connect can issue both put and get. The opt-in
`scripts/immutable-broker-auth-proxy.py` introduces a separate, Linux-only
`SO_PEERCRED` gate in front of that socket. The Python 3 standard-library
proxy checks the connecting process's **kernel-reported UID and primary GID**
before forwarding any request bytes. It rejects callers sharing the permitted
socket group but not the explicitly configured client UID. No Node-internal
socket APIs or third-party Python packages are required.

The administrator must create **two distinct broker-owned directories** under
root- or broker-owned protected ancestors:

- **Private backend socket directory**: broker UID, mode `0700`. Start the
  existing Node broker here, pointing to its separate broker-owned `0700`
  immutable store. Clients cannot traverse this directory and must never be
  given its socket path.
- **Public proxy socket directory**: broker UID, mode `0750`, group set to
  the dedicated client GID. The proxy binds a `0660` socket here. Clients
  use **only this public socket**, with their pinned expected broker UID/GID.

Launch the Node broker first, then launch the Python proxy with the same
dedicated broker UID and primary GID. Both must have real/effective/saved
credentials set to that non-root UID/GID, no supplementary groups, zero Linux
capabilities, and `NoNewPrivs=1`. Example after an administrator has created
the directories and provisioned distinct identities:

~~~sh
# Broker: private socket is inaccessible to the untrusted client UID.
SKILLGATE_BROKER_CLIENT_UID=<client-uid> \
SKILLGATE_BROKER_CLIENT_GID=<client-gid> \
  node scripts/immutable-store-broker.mjs \
  /protected/private/immutable.sock /protected/immutable-store

# Proxy: run under the SAME dedicated broker UID/GID, with capabilities
# cleared and NoNewPrivs enabled, using the same environment variables.
SKILLGATE_BROKER_CLIENT_UID=<client-uid> \
SKILLGATE_BROKER_CLIENT_GID=<client-gid> \
  python3 scripts/immutable-broker-auth-proxy.py \
  /protected/public/immutable.sock /protected/private/immutable.sock
~~~

The commands above assume the process manager has already dropped privileges;
setting environment variables **does not** change credentials. For an isolated
Linux test, a privileged operator can launch each service with
`setpriv --reuid <broker-uid> --regid <client-gid> --clear-groups
--no-new-privs --bounding-set=-all`. Never run either process as root.
The proxy fails closed if its private backend is absent, its socket or parent
has unexpected ownership/mode, the public parent is attacker-owned, Linux
peer credentials are unavailable, or saved IDs/capabilities remain elevated.
It never removes a pre-existing socket; stale sockets require operator
recovery in the protected namespace.

Each connection permits one newline-framed request and response. The proxy
enforces a 15-second absolute deadline, one active connection, a 32 MiB
payload framing limit, **64 requests per rolling minute**, and **256 MiB of
request bytes per rolling minute** for its single configured client UID.
These are in-memory best-effort throughput controls, **not** persistent
per-client storage quotas or a disk-space guarantee. Additional UIDs require
separately isolated proxy/backend instances or a reviewed multi-tenant design;
do not share one group-accessible raw broker endpoint between principals.

**Validation boundary:** An isolated real Linux cross-UID test with the exact
committed Python source verified that an authorized UID/GID received a backend
response; a different UID sharing the same socket group was rejected by
`SO_PEERCRED`; an incorrect primary GID and direct backend access were
denied by the kernel. Four negative startup checks rejected retained
supplementary groups, a same-UID client, a missing private backend, and an
attacker-owned public parent. This test used a minimal mock backend, **not**
the built SkillGate Node broker. The full repository build, committed broker
smoke, and SIGKILL generation recovery remain unexecuted. This proxy is
experimental; it does **not** implement generation authorization, consumer
migration, or strict adapter lifecycle integration. Keep #28 open and PR #97
draft until those boundaries and full validation are complete.
