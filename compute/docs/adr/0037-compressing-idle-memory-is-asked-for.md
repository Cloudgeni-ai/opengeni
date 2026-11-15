# 37. Compressing idle memory is asked for

Status: Accepted, 2026-11-13. Amends
[4](0004-memory-pressure-evicts.md) (what memory pressure does to an idle
sandbox first) and [14](0014-requests-limits-and-admission.md) (what the
buffer frees on an overdrawn budget). Follows
[36](0036-idle-memory-stays-in-ram.md).

## Context

When a host needed memory, an idle paused sandbox was first compressed in
RAM, through zswap, and its VM process was ended only if that did not free
enough. The recommended rules turned this on for every sandbox.

Measured on a production fleet over 25 hours, 69 such compressions ran to
make room. Half took over 12 seconds and the longest 212, one thread
each, and a sandbox being compressed cannot be ended meanwhile. In 42 of
the 69 the same sandbox was ended within ten seconds anyway. What was
kept came to 25 to 32% of the original, while the planning assumed 25%. Wakes
waiting for that room waited 35 to 47 seconds instead of about one.
Since [36](0036-idle-memory-stays-in-ram.md), ending an idle sandbox's
process is instant and its next wake boots from its files in a second or
two, so the compression bought little and cost those waits.

Separately, an overdrawn budget counted as merely full when the host kept
its buffer: a host booked beyond its budget freed nothing for what it was
over.

## Decision

- **An idle sandbox is compressed only if its rules ask for it**
  (`compress_paused`, off in the recommended rules). Otherwise, when the
  host needs memory, the least recently used idle ones are ended at once,
  as [36](0036-idle-memory-stays-in-ram.md) describes. The code and the
  setting stay, as for `keep_memory`.
- **The setting of earlier releases, `compress`, is read and dropped.**
  The recommended rules had it on for every sandbox, so a stored `true`
  says nothing anyone chose. Sandboxes created before therefore stop
  being compressed once their host or the service reads them, without a
  migration. A host that does not know `compress_paused` refuses it, so
  the service must not send it before every host knows it.
- **The buffer frees what an overdrawn budget is over** as well as the
  buffer itself.
- Compressing memory that busy sandboxes borrowed above their request
  ([24](0024-busy-sandboxes-are-slowed-never-frozen.md)) is unchanged: it
  has its own path and is not part of these rules.

## Consequences

- Making room takes milliseconds instead of seconds to minutes, so wakes
  waiting for room no longer wait for compression.
- An idle sandbox that compression would have kept alive loses its
  programs sooner, and its next wake boots from its files. Its files are
  never affected.
- A host with compression unavailable, on huge pages, behaves as before.
