# 32. A lost host's sandboxes wait for it

Status: Accepted, 2026-11-06. Amends
[18](0018-the-control-service-leases-and-fences.md) (recovery after a host
is given up on).

## Context

Giving up on a host used to clear the owner of each of its sandboxes under
a raised epoch, so the next wake adopted it on another host from its latest
archive. A host that hangs for a few minutes and is power-cycled is given
up on two minutes after its last renewal. Its sandboxes are still on its
disk, newer than their archives, which lag behind when archiving is slow.
Wakes during the outage took some of them elsewhere. When the host came
back, the service ruled those copies dropped, since a later owner had
taken them, and the host deleted them. The sandboxes went on from archives
over an hour old. Their unpushed work was gone, and nobody was told.

Losing the host's machine with its disks is rare. A short outage is common.
An outage cannot be told apart from a loss until the host comes back or
its machine is found deleted.

## Decision

- **Giving up keeps ownership.** Giving up on a host marks it lost, so its
  late renewals fail and it must register again, and that is all. Its
  sandboxes stay its own. A wake, connect, move or resize of one waits for
  the host and then fails with `unavailable`, saying in plain words that the
  host stopped answering and the sandbox waits for it rather than going
  back to its older stored copy. `GET /v1/sandboxes/<id>` shows the host it
  waits for in `waiting_for`. A sandbox that waits can still be deleted. A
  host is not forgotten while a sandbox waits for it.
- **A host back from an outage keeps everything.** It registers again and
  keeps each sandbox it lists under the same epoch. Each one it no longer
  lists goes on from its stored copy.
- **Only proof or an operator lets a sandbox go on without its host.** The
  host is declared gone when its group finds its instance deleted, disks
  and all, or when an operator calls `POST /v1/hosts/<name>/gone` (only for
  a host already given up on). Then each sandbox it owns is left without an
  owner under a raised epoch, as giving up did before. Its row notes the
  loss: the host, why, when, the epoch it raised, and when its stored copy
  was saved (`saved_ms`, from the pointer's last change). The declaration
  answers which sandboxes went on, and from which copy.
- **The restored point in time is told.** The row's note is shown as
  `restored` on the sandbox and on the wake's answer. It holds the same
  facts plus a `notice` in plain words, for the agent and the person using
  the sandbox. It says what the sandbox went back to and that later writes
  and running programs were lost with the host. The note is cleared once
  the host takes the sandbox back.
- **A copy is never dropped unseen after a declaration.** A declared host
  that comes back after all, and lists a copy from before the declaration
  that it would otherwise drop, is ruled `set_aside`. It moves that copy's
  directory, whole, to `vm/aside/<id>-e<epoch>-<ms>` under its state root
  and logs an error naming it, and the note records `set_aside_ms`. Nothing
  deletes an aside copy: an operator recovers what is needed from it, then
  deletes it. A copy nobody took meanwhile is simply taken back. A host of
  an earlier release, which cannot set aside, is ruled `drop` as before,
  and the service logs an error.

## Consequences

- A short outage costs the waiting agents a few minutes and no writes.
- A host that never comes back, outside any group that can prove it
  deleted, holds its sandboxes until an operator declares it gone. That is
  the price of never serving a stale copy on a guess. Alert on hosts that
  stay `lost` while sandboxes wait for them.
- Declaring a host gone trades staleness for availability on purpose. The
  trade is visible: the API answers what went back, and every view of the
  sandbox says to when.
- Migration 9 adds `compute_sandboxes.lost` and `compute_pointers.saved_ms`.
  During a rollout a replica of the earlier release still clears owners as
  it gives up on a host, as before.
