# 6. Memory and disk are one unit; every save is self-contained

Status: Accepted, 2026-10-15

## Context

A memory snapshot includes the guest kernel's view of its disk: cached file
contents and file-system bookkeeping. Restoring memory with any other disk
state silently corrupts the file system. Chains of diff snapshots make every
restore depend on every earlier link.

## Decision

Memory and disk are saved, archived and restored together under one
generation number. Every save is merged, never under a live VM, into a new
self-contained image: a reflink copy of the previous image with the diff laid
over it. A generation is published by writing, syncing and renaming it into
place, verifying it, and only then moving the `current` pointer. If only the
disk survives, the sandbox boots fresh from it and reports that it did.

## Consequences

- Any one generation restores on its own, and an older one can be dropped
  without touching the newer.
- Reflinks make the copy nearly free on file systems that support them
  (XFS, Btrfs); elsewhere the copy costs real disk writes.
