# 6. A memory image is valid only with its disk; images are self-contained

Status: Accepted, 2026-10-15

## Context

A memory image includes the guest kernel's view of its disk: cached file
contents and file-system bookkeeping. Restoring it with any other disk state
silently corrupts the file system. Chains of diff snapshots make every
restore depend on every earlier link.

## Decision

- The record pairs each memory image with the disk state it was taken with.
  When the sandbox runs again, its disk moves on, so the record marks the
  image invalid before the guest resumes. The next save makes a new one.
- Every save is merged, never under a live VM, into a self-contained image: a
  reflink copy of the previous image with the changed pages laid over it.
  Publishing is write, sync, rename, verify, then move the `current` pointer.
- An archive publishes the disk's and the memory image's manifests together,
  named by one receipt; a wake fetches the pair it names.
- With no valid image, the sandbox boots fresh from its disk and reports that
  it did. This is what happens when a running VM's process dies.

## Consequences

- Any one image restores on its own, and an older one can be dropped without
  touching the newer.
- A crash while running loses running programs; data already written to the
  guest's disk is kept.
- Reflinks make the copy nearly free on file systems that support them (XFS,
  Btrfs); elsewhere the copy costs real disk writes.
