# Workspace archive storage

Linux host-backed Local/Docker captures with object storage retain the SDK v1
JSON archive format but spool payload bytes to private disk files. Capture and
restore fingerprint the persistent projection in bounded chunks; publication
allocates a fresh physical object key for every upload, validates the outgoing
stream, and reads back every stored byte through version-pinned ranges before
publishing a locator. Restoration validates the complete archive before changing
the destination. This does not rely on conditional PUT support.

The canonical codec is `packages/runtime/src/sandbox/host-archive-spool.ts`;
bounded object transport is `packages/storage/src/workspace-archive-spool.ts`.
Warm capture, lease drain, worker cold restore, and API rematerialization share
this path. Metadata indexes still scale with member count, and temporary disk
space must hold the archive. Missing streaming/range storage capabilities fail
explicitly. Non-Linux hosts, inline archives without object storage, and remote
provider archive protocols retain their existing compatibility paths; this is
not a bounded-memory guarantee for those paths. Existing archive limits and
capture/publication ownership fences remain authoritative and unchanged.

The logical revision stays unchanged; physical locators append a random upload
UUID before `.tar`. Application-owned unique keys isolate simultaneous attempts
and malformed producers from existing checkpoints. This is not provider-enforced
immutability against arbitrary holders of storage credentials. A candidate is
publishable only after complete stream and stored-content verification.
Database publication binds the exact locator to its account, workspace, group,
revision, digest, and size. An exception or lost acknowledgement is an unknown
publication outcome, never permission to delete the candidate. Cleanup follows
transaction-derived ownership outcomes, not a separate before/after lease read.
Only a definitively unused fresh candidate is deleted automatically here.
Superseded locators and unknown publication outcomes are retained until a durable
retirement/garbage-collection mechanism can prove they cannot be reattached.
Storage retention can therefore grow; this correction does not introduce an
age-based deletion policy or a resource cap.

New readers accept both legacy unsuffixed and new suffixed locators. Old readers
reject suffixed locators: deploy compatible API/worker readers before enabling
new writers, and retain suffix-aware readers on rollback. Existing objects are
not renamed or rewritten. Restore always follows the stored exact key.

The streaming reader supports canonical SDK-produced v1 archives; it rejects
malformed/noncanonical base64 and duplicate logical entries rather than adopting
the SDK reader's permissive base64 decoding. Hydration requires an exclusively
owned destination with trusted ancestors (the unpublished newly created
sandbox). Descriptor-relative access prevents symlink redirection but cannot
prevent an external actor from moving an already-open directory elsewhere.
Restoration is validated before mutation, not transactional against subsequent
disk I/O failures or concurrent writers.

The opt-in synthetic acceptance test exercises capture, object publication,
cold restore, and final file hashes with three 512 MiB files:

```sh
OPENGENI_TEST_LARGE_WORKSPACE_ARCHIVE=1 bun test apps/worker/test/workspace-archive-spool-roundtrip.test.ts
```

It records phase-level memory measurements, checks capture's raw heap growth,
and bounds VM heap capacity and total resident memory end-to-end. It does not
force garbage collection. Streaming chunks retain independent ownership so
downstream consumers cannot observe a reused buffer changing beneath them.