# 36. Idle memory stays in RAM

Status: Accepted, 2026-11-11. Amends
[4](0004-memory-pressure-evicts.md) (what memory pressure does to an idle
sandbox), [6](0006-memory-images-and-disks.md) (when a memory image is
made) and [14](0014-requests-limits-and-admission.md) (what a sandbox
books on disk). Follows [34](0034-a-checkpoint-copies-the-disk-alone.md).

## Context

An idle sandbox had its memory saved to its host's disk after 30 seconds
and copied to the store after two minutes, so that a wake after its VM
process ended would continue its programs. A sandbox is a computer: its
files are what lasts, and its programs last as long as it stays switched
on. Saving memory bought something only for a wake that found the VM
process gone, and it cost every idle sandbox a snapshot, an upload and a
place on disk.

Measured on a production fleet over three days: about nine wakes in ten
found the memory still in RAM, about 4% restored a memory image from the
host's disk, and a boot from the files typically took 1.1 to 1.2 seconds.
Stored memory was 161 GB of a 607 GB store, more than the sandboxes'
disks (113 GB), and every host kept room on its disk for a save of each
sandbox it held.

## Decision

- **A sandbox's memory is saved nowhere unless its rules say so**
  (`keep_memory`, off by default and in the recommended rules). Idle, it
  pauses and stays paused in host RAM; its files are archived as before,
  while it stays paused, so a wake is a resume.
- **When the host needs the memory, or a later rule ends the VM process,
  the process just ends** (the new step `end`): nothing is written, so it
  is instant, and the least recently used go first as before. The guest
  wrote its disks out as it paused. The next wake boots from the files.
- **No timer was added.** How long an idle sandbox keeps its programs is
  how long the host has room for it.
- **A request for programs still saves them:** an explicit sleep through
  the API, a template capture, the hand-off or drain of a sandbox in use,
  and a sandbox created with `keep_memory`. An idle sandbox handed off or
  drained goes with its files alone.
- **Such a sandbox books no save on disk.**
- **A guest that did not say it wrote its files out keeps its memory.**
  A pause asks the guest to write its disks out and goes ahead without
  an answer after ten seconds. That guest may hold writes in its memory
  alone, so until it has run again it is treated as one whose memory is
  kept: where its rules would end its VM process, its memory is saved
  first, and it books that save. Its record says so, for an agent that
  starts meanwhile. On the same fleet about one pause in a hundred went
  unanswered over nine days, all of them in two days of a stalling host.

## Consequences

- A sandbox pushed out of RAM loses its programs and anything it kept in
  memory alone, such as a tmpfs or a `/tmp` cleared at boot; its files
  are whole. It wakes in about a second instead of resuming at once.
- What a guest writes between its answer and the pause, milliseconds of
  a sandbox nothing uses, ends with its VM process as on a power cut. So
  does all it had not written on a host with no port to ask its guests
  on (`--restore-notice-port`), which asks none.
- Idle sandboxes cost the store and the hosts' disks their files only, and
  a host admits by memory and disk without room for memory images.
- Hosts take the release first: an older host refuses `keep_memory`, so
  the service must not send it before every host knows it. Existing
  sandboxes follow the new default from their host's upgrade, those
  created to pause through the E2B API too, and memory
  images already stored are deleted by the existing rule, up to 30 days
  after their last use.
