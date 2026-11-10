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
  VMM that wrote it, the processor model and the host kernel (the processor
  state KVM saves depends on the kernel: an image made under a newer one can
  hold registers an older one refuses). A VMM records its runtime when
  it launches, so a VM started before an upgrade still labels its images
  with the older one. Releases that write the same format count as one
  runtime, so most upgrades keep every image. After an upgrade that changes
  the format, the host keeps the older Firecracker binary for as long as
  images are kept, and wakes each image under the binary that made it, else
  under one that reads its format (Firecracker reads its own major version
  up to its own minor one). A refusal alone proves nothing (the host may
  have run short of memory), so the sandbox gives an image up only when the
  VMM refused it and no binary the host keeps reads its format, or when it
  was made on another kind of host (another processor model or host
  kernel, or a kernel its label made before labels named one leaves open)
  and the VMM refused it several wakes in a row: the host does not
  change while it runs, and nothing sends the sandbox to a host like the
  one that made it, so retrying would never end. The sandbox then boots
  from its disk and reports that its programs were lost.
- A warm template depends on the runtime too: one saved under another, as
  after the host's kernel changed, is rebuilt, since every sandbox made from
  it would start with its image.

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
- Memory the guest frees and reports to the host reads as zeros in its
  image, as it does in the guest. The VMM discards a reported range without
  counting it as a change, so a diff leaves it out, and an image merged
  from diffs would otherwise go on holding whatever the guest last kept
  there: an idle sandbox's image would hold nearly every page it ever
  used, and each checkpoint would store again every chunk the guest
  touched, stale bytes and all. So after a diff snapshot, while the VM is
  still paused, the engine names the ranges that read as zeros
  (`Engine::freed_memory`), and the merged image holds zeros there, as a
  hole, so its chunks are the zero chunk or hold only what the guest
  wrote. Firecracker discards a range of memory mapped from an image file
  by mapping fresh anonymous memory over it, so those ranges are the
  anonymous mappings inside the file's mapping whose pages are neither
  present nor swapped, read from `/proc/<pid>/maps` and `pagemap`. Memory
  a pager served is anonymous; once the pager has put every page in place
  and let go, a page of it neither present nor swapped reads as zeros.
  Where that memory is, only the VMM's handshake with the pager says, so
  the pager writes those regions into its done file with its launch's
  tag (a starting pager first removes any done file an earlier one left),
  and the host uses them only for the launch the sandbox's paged marker
  names; until the pager has finished, nothing is named. A VM
  booted fresh is not covered: Firecracker reports nowhere where its
  memory is, and finding it by the shape of the process's mappings would
  be a guess. Its image keeps what freed pages held until the sandbox is
  next woken from an image. A full snapshot reads discarded pages as
  zeros already.
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
  1 MiB per write call for rounding. It also books 256 KiB per file page
  the VMM dirtied meanwhile: a discard over part of a block makes no write
  call, but zeroes the rest of the block in its page, and XFS writes a
  shared block's page to a new copy-on-write extent (128 KiB by default).
  Pages that write calls dirty count twice, a bound for a window of
  milliseconds. Space a guest freed before the free-space reading is then
  booked as its own whatever it writes after, and a disk that cannot be
  read that way books its whole length for that reading. A pause has the
  guest trim first and holds the VM, so no reading of its disk comes while
  it runs: from a pause's start until a reading measures the disk again,
  the sandbox books its disk's whole length. Once the pause succeeds, the
  agent can measure the quiescent file immediately, and again at local
  wake admission, without a concurrent-write allowance. Missing readings
  keep the whole bound. ADR 14's disk-book amendment counts fetching and
  guest writes against this one disk file, not two copies.
