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
- Each image records the runtime that made it: the snapshot format of the
  VMM that wrote it and the processor model. A VMM records its runtime when
  it launches, so a VM started before an upgrade still labels its images
  with the older one. Releases that write the same format count as one
  runtime, so most upgrades keep every image. After an upgrade that changes
  the format, the host keeps the older Firecracker binary for as long as
  images are kept, and wakes each image under the binary that made it, else
  under one that reads its format (Firecracker reads its own major version
  up to its own minor one). A refusal alone proves nothing (the host may
  have run short of memory), so the sandbox gives an image up only when the
  VMM refused it and no binary the host keeps reads its format. An image
  made on another processor model is kept even when refused: it still wakes
  on a host like the one that made it.

## Consequences

- Any one image restores on its own, and an older one can be dropped without
  touching the newer.
- A crash while running loses running programs; data already written to the
  guest's disk is kept.
- A save writes only the pages that changed since the VM's base, the image
  it was restored from or the zeros it booted with, because the VMM tracks
  them from that moment. An agent restarted beside a running VM learns
  that base from `memory-base.json` in the sandbox's directory, which
  names the VM process it holds for (boot id, pid and start time) and the
  image by generation and hashes; it is written after each start, restore
  and published image. A snapshot resets the VMM's record of changed
  pages, so the file is withdrawn before every snapshot and written again
  only once the image is published. A record that is missing, names
  another process, or names an image no longer at hand, local and intact,
  means the base is unknown, and the next save writes every page. The
  file is never synced: it means anything only beside the live process it
  names, which a power loss ends.
- Reflinks make the copy nearly free on file systems that support them (XFS,
  Btrfs); elsewhere the copy costs real disk writes.
- A disk's file gives back what its guest frees. Writable drives take the
  guest's discards, which punch holes in the file, and before every pause
  (the `sync` request, so also before every save and checkpoint) the guest
  trims its root file system's free runs of 1 MiB or more. A sleeping
  sandbox's disk, its archive and its next wake then hold little more than
  its files use (free runs shorter than 1 MiB stay held), not the most they
  ever held. Discarded blocks read as zeros,
  which a memory image never needs back: the guest's file system had freed
  them. The device's snapshot state keeps the feature, so a VM keeps the
  drive it booted with across every save and wake: one booted before
  discards were turned on, or whose image has an older guest that does not
  trim, keeps holding what it freed until it boots fresh. Templates are
  rebuilt with the feature, so clones have it. A running VM's disk books
  its whole length less what it holds alone either way, so trimming changes
  admission only for disks at rest: space a running guest frees stays booked
  for it to write again. A guest may free and write at any moment, and the
  host's free space and its disks cannot be read at one instant, so the
  agent reads each running disk after the free space, and also books what
  its VMM wrote from just before the free-space reading until every write
  it had started by the disk's read has returned (one API request: the VMM
  answers it on the thread that does its drives' synchronous I/O), with
  1 MiB per write call for rounding. Space a guest freed before the
  free-space reading is then booked as its own whatever it writes after, and
  a disk that cannot be read that way books its whole length for that
  reading.
