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
- An archive reuses the chunks its sandbox's earlier copy holds at the same
  offsets, and for a disk made from a stored image the image's, instead of
  storing the same bytes again. It asks the store whether it still holds a
  chunk it reuses only if no copy this host confirmed within the last day
  names it: one it stored or verified itself, or an image it checked chunk
  by chunk. A failed verification drops those confirmations, so the
  re-archive after it asks about every chunk it reuses and stores again
  what is gone. What a sweep may delete never rests on this
  ([17](0017-sweeping-unnamed-chunks.md)): everything reused is named by a
  pointer read after the archive began.
- Local images are checked for completeness and structure, not hashed on
  every wake; their content is trusted to the local file system.

## Consequences

- Unchanged chunks are not uploaded again, apart from a weekly refresh of
  long-reused ones that keeps the sweep safe ([17](0017-sweeping-unnamed-chunks.md)).
  Identical chunks are shared between the sandboxes of one store prefix, so
  each sharing domain (a customer, or a trust zone) needs its own prefix
  ([operations](../operations.md)).
- A bad chunk is rejected instead of spreading to other sandboxes.
- A chunk lost from the store between two verifications can be named by
  the archives in between; the next verification finds it, and the copy is
  not evicted until an archive repairs it. Asking about every reused chunk
  on every archive instead cost a metadata request per chunk (about 12,000
  for a 3 GB disk) on every checkpoint, and half a minute of latency.
- Silent same-length damage to a local image would not be caught before a
  wake. Hashing locally on every wake would cost too much wake time.
