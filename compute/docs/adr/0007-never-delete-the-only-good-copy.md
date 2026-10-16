# 7. Never delete the only good copy

Status: Accepted, 2026-10-16

## Context

Losing a user's workspace is the worst failure we can have. Copies go bad in
quiet ways: a truncated upload, a corrupt chunk, an object that disappears,
same-length damage a size check cannot see.

## Decision

- One check decides whether a copy is good. An older copy is removed only
  after a newer one has passed it.
- A local copy that fails is quarantined; the last two per sandbox are kept
  for inspection.
- Archives are compressed, content-addressed 256 KiB chunks. Each upload
  carries a checksum the store verifies, and the checksum is recorded with the
  chunk reference. Every chunk read is checked against its hash.
- The local copy is evicted only after the store proves it holds exactly the
  archived copy: on GCS by comparing the stored checksums with a metadata
  request per chunk, elsewhere by reading and hashing. A re-archive repairs
  any chunk that fails this from the local copy.
- Local images are checked for completeness and structure, not hashed on
  every wake; their content is trusted to the local file system.

## Consequences

- Unchanged chunks are never uploaded twice, and identical chunks are shared
  between sandboxes.
- A bad chunk is rejected instead of spreading to other sandboxes.
- Silent same-length damage to a local image would not be caught before a
  wake. Hashing locally on every wake would cost too much wake time.
