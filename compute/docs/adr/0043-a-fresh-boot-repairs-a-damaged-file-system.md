# 43. A fresh boot repairs a damaged file system

Status: Accepted, 2026-11-13. Amends
[10](0010-crash-safety-bar.md) (what a sandbox's files are trusted to).

## Context

A sandbox's root disk is an ext4 file system its guest's kernel mounts
itself, with no initramfs, so nothing ever checked or repaired it. Its
VMM offers the guest no flush (Firecracker's `Unsafe` cache), so a host
that hangs or loses power can lose the guest's newest writes in any order,
and its journal no longer guarantees a consistent file system. The kernel
notices such damage only when it meets it, records each error in the
superblock (the error state, a count, and the first and the latest
error's time, function and code) and, with ext4's default `continue`
behaviour, runs on.

Measured on a production deployment after one host hung repeatedly: one
sandbox's disk recorded 12,228 errors over a week, all `EFSCORRUPTED`: the
first in `ext4_orphan_get` as the guest mounted the disk after a hang (a
bad inode on the orphan list), every later one in `ext4_lookup` (a
directory entry naming a deleted inode), met again on every lookup. The
sandbox kept working, around a few unreadable files, and every archive
and checkpoint copied the damage to the store.

A guest cannot repair its own root while it is mounted, and the host must
not touch a disk a VM has open, or one a memory image depends on. Before
a fresh boot neither holds: the boot has already stopped vouching for any
memory image and no VMM runs.

## Decision

- **Every fresh boot reads the disk's superblock first**, one kilobyte,
  and runs `e2fsck -f -y` only when it records errors (the error state or
  a non-zero count) or fails its checksum. A healthy disk costs that read
  and nothing else. A disk that holds no ext4 file system is left alone.
- **The repair runs as the VM's own unprivileged user**, on a descriptor
  the host opened without following links (its standard input), with none
  of the agent's environment: `e2fsck` parses bytes the guest wrote, and a
  guest can set its error state at will. The disk is handed to that user
  first, as a launch hands it over.
- **The boot goes on whatever the repair did.** A guest runs with errors
  as it did before; one still damaged is tried again at its next fresh
  boot. A `compute.disk.repair` event says what happened (`repaired`,
  `unrepaired` or `failed`), with the recorded count, first and latest
  error, `e2fsck`'s exit status, how many problems it fixed, what it said
  and how long it took, beside the boot's own `compute.step` event, whose
  `compute.phase.repair_us` counts the time.
- **The guest keeps `continue`.** `remount-ro` would turn a few damaged
  files into a sandbox where nothing can be written, and `panic` would end
  its programs at the first error met; neither repairs anything, and the
  host repairs at the next fresh boot either way.
- **Saves copy a damaged disk as it is.** It is the sandbox's newest copy;
  holding it back would lose the files' newer changes too. The superblock
  carries the damage's record with the disk, so whichever host boots it
  next repairs it, and the next save after that stores the repaired disk.

## Consequences

- A damaged disk is repaired at its sandbox's next fresh boot: once its
  VM process ended (memory pressure, a restart, an eviction after idling)
  and it is woken again, also on another host after a fetch from the
  store. A sandbox nobody wakes is never repaired, which costs nothing.
- A sandbox whose memory is kept restores it instead of booting and is
  repaired only after a restart or once its memory image is forgotten.
  On the deployment measured, 92 of 126 sandboxes had a saved memory
  image, the damaged one among them, so a restart is what repairs most
  damaged disks soon.
- `e2fsck -y` may clear damaged inodes and move orphaned files to
  `lost+found`: what the files lost was lost when the writes were.
- Damage the guest's kernel has not met yet is not recorded, so it is
  found only once met and repaired at the boot after. Checking every disk
  whose host stopped uncleanly would find it sooner, at the cost of a full
  check of each; this does not.
- The repair adds `e2fsck`'s time, typically seconds, to the boots that
  need it, and runs outside the sandbox's cgroup.
- `e2fsck` reads guest-controlled data outside the VMM's jail. It runs
  as the VM's user, which a compromised VMM already is, but without the
  jail's chroot or seccomp filter.
