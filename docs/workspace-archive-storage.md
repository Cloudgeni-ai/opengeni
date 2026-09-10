# Workspace archive storage

Linux host-backed Local/Docker captures with object storage retain the SDK v1
JSON archive format but spool payload bytes to private disk files. Capture and
restore fingerprint the persistent projection in bounded chunks; publication
uses create-only streaming uploads, and restoration downloads version-pinned
ranges and validates the complete archive before changing the destination.

The canonical codec is `packages/runtime/src/sandbox/host-archive-spool.ts`;
bounded object transport is `packages/storage/src/workspace-archive-spool.ts`.
Warm capture, lease drain, worker cold restore, and API rematerialization share
this path. Metadata indexes still scale with member count, and temporary disk
space must hold the archive. Missing streaming/range storage capabilities fail
explicitly. Non-Linux hosts, inline archives without object storage, and remote
provider archive protocols retain their existing compatibility paths; this is
not a bounded-memory guarantee for those paths. Existing archive limits and
capture/publication ownership fences remain authoritative and unchanged.

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