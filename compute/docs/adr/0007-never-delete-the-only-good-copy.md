# 7. Never delete the only good copy

Status: Accepted, 2026-10-16

## Context

Losing a user's workspace is the worst failure we can have. Copies go bad in
quiet ways: a truncated upload, a corrupt chunk, an object that disappears,
same-length damage that a size check cannot see.

## Decision

- One check decides whether a copy is good. An older copy is removed only
  after a newer one has passed it.
- A copy that fails is quarantined, never deleted.
- Archives are compressed, content-addressed 256 KiB chunks. Each upload
  carries a checksum the store verifies, and that checksum is recorded with
  the chunk reference. Every read is checked against the chunk's hash.
- The local copy is evicted only after the store proves, chunk by chunk
  against the recorded checksums, that it holds exactly the archived copy.
  A re-archive repairs any chunk that fails this from the local copy.

## Consequences

- Unchanged chunks are never uploaded twice, and identical chunks are shared
  between sandboxes.
- A bad chunk is rejected instead of being spread to other sandboxes.
- Verifying before eviction costs one metadata request per chunk.
