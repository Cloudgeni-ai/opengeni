# 34. A checkpoint copies the disk alone

Status: Accepted, 2026-11-11. Amends
[18](0018-the-control-service-leases-and-fences.md) (what a checkpoint
captures, and how) and [14](0014-requests-limits-and-admission.md) (what a
sandbox that is only checkpointed books on disk).

## Context

A checkpoint copied a running sandbox to the store with its memory: it
paused the VM, had its VMM write the pages changed since the last
snapshot, cloned the disk, resumed the VM, merged the pages into a new
image and uploaded the bundle. The memory in it was never used. Since
2026-10-19 an adopt after a lost host boots the sandbox from the copy's
files ([ADR 18](0018-the-control-service-leases-and-fences.md)), because
the lost host may have run it on past the copy; a hand-off or drain, the
only adopts that restore memory, makes its own save first. So every
checkpoint stored a memory image that the next adopt set aside and
deleted.

It cost a great deal. Measured on a production fleet over 24 hours,
scheduled checkpoints were about 93% of everything the hosts wrote to
the store. Those of a single sandbox with 16 GiB of memory uploaded about
3.3 GB each, 335 GB in all. Its guest stood still for 25 seconds
on average and up to 62, while the VMM wrote the snapshot, and nine
checkpoints were cancelled after about 40 seconds of pause and taken
again. Memory changes far more than a disk does, and freed guest pages
still hold old data until the guest reuses them, so each diff carried
gigabytes the guest no longer needed.

## Decision

- **A checkpoint copies the disk and nothing else.** The step asks the
  guest to write its disks out (`sync`), clones the disk sharing every
  extent, archives the clone as the owner's next save with no memory
  image, under the same owner stamp and fences as an archive, and records
  `backed_up_ms` as the moment of the clone. The clone is a single
  `FICLONE` the filesystem makes while holding the disk file's locks, which
  also hold back the VM's own writes to it, so it holds the disk as at one
  instant, as a power cut would leave it.
- **It never pauses the VM**, nor waits for a lazily woken VM's memory to
  arrive. The guest runs and works throughout; `compute.paused_us` is gone.
- **A lost host's sandbox boots from that disk**, as it already did, and
  the adopting host raises `programs_lost`. A copy with no memory image
  needs no change in the store first.
- **Memory is still saved when it is kept:** when a sandbox goes idle
  (pause, save, archive), and when a hand-off or drain moves it, so a
  planned move still keeps its programs running.
- **A sandbox that is only checkpointed books no save.** Nothing saves its
  memory unasked, so like a CI runner's it books none, and a checkpoint
  books only what its guest may write over the clone, the disk's whole
  growth bound, until a reading measures it.

## Consequences

- Store writes fall to what the guests' disks change, typically hundreds
  of MB per checkpoint instead of gigabytes, and a working guest is no
  longer frozen every ten minutes.
- A lost host costs a sandbox what it did before: its programs, and what
  its files took on since the newest checkpoint was cloned.
- An adopt from files of a copy that never held memory, such as an idle
  archive of a sandbox that never ran, now raises `programs_lost` too.
  Nothing durable tells it apart from a checkpoint's copy, and the alarm
  is cheap and conservative.
- The next save after checkpoints is a diff over the VM's last memory
  image, as if no checkpoint had run: a checkpoint no longer moves the
  base.
