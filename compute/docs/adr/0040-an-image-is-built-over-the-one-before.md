# 40. An image is built over the one before

Status: Accepted, 2026-11-13. Amends
[19](0019-e2b-compatible-front-door-and-guest-init.md) (how a host builds
an image from an OCI image).

## Context

A followed OCI image gets a new digest with nearly every release, so each
release has its images built again (ADR 19). A build unpacks the image's
layers and writes a new ext4 file system with `mkfs.ext4 -d`, which lays
every file out anew: a release that changes a few files moves most of the
rest. Everything that shares chunks between disks by offset then shares
almost nothing between two releases' images:

- a wake whose sandbox's own image is not on the host fetches its disk
  from the store with another local image as its seed, and finds few of
  its chunks there;
- each new image is stored, and fetched by every host that creates from
  it, nearly whole.

Measured on two consecutive releases of a desktop image (3.1 GiB of
data): 86 % of the compressed OCI layers were the same, and of the files
in the layers that differed most were the same too. Yet only 20 % of the
second image's chunks matched the first's at the same offset: 2.4 GiB to
fetch. Built by changing a copy of the first image instead, 98.6 % of
its chunks matched: 42 MiB to fetch. Changing the copy took 4.5 s.

## Decision

- **A build changes a copy of the image the name starts from now.**
  `Prepare` carries that image (`before`), which the control service
  knows. A host that keeps it copies it (sharing blocks where its file
  system can), grows it if the new contents need more room, mounts it,
  copies the unpacked root over it with `rsync --checksum --delete`, which
  leaves files whose contents match where they are, discards what was
  freed, checks it with `e2fsck -n` and gives it a new random UUID. So,
  as before, no two builds are the same bytes (ADR 22).
- **Anything else builds a new file system, as before**: no `before`, a
  host that does not keep it, or any step of the change failing (too few
  inodes, no loop device). The images are equally correct either way;
  only how much they share differs.
- **The copy never shrinks.** An image is at least as large as the one it
  was built over. Untouched space costs nothing: the file is sparse, and
  stored copies skip zeros.
- **Hosts need `rsync`** besides e2fsprogs; the installer adds it.

## Consequences

- Two releases' images share all but what changed, so a host or store
  holding one needs only the changed chunks of the other: chunks the
  store holds are not uploaded again, and fetches seeded by a local image
  of the name copy the rest.
- Files deleted and written over many releases leave the file system more
  fragmented than a fresh one. That costs nothing a sandbox notices; a
  build with no `before` (a new name, or a host without it) starts the
  chain afresh.
- A host builds as root with a loop mount, as it already runs as root to
  unpack layers with their owners.
