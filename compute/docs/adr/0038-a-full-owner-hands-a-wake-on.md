# 38. A full owner hands a wake on

Status: Accepted, 2026-11-13. Amends
[18](0018-the-control-service-leases-and-fences.md) (where a wake goes,
and what it does when its owner has no room).

## Context

Every wake went to the sandbox's owner, the host that last ran it, and
only a drain, a move or a host given up on changed the owner. An owner
with no room for the wake answered `host_full`, and the wake waited for
room there until its deadline, however much room other hosts had.

A host deletes the local copy of a sandbox idle for days, so most of the
sandboxes a host owns may be held only in the store. Measured on a
production fleet of two hosts: 63 of one host's 77 sandboxes and 40 of
the other's 46 were held only in the store. Waking one downloads it
anyway, yet only its old host was ever asked. A fleet that takes in
small, spare machines fills them often, and their sandboxes would wait
each time.

## Decision

- **A wake its owner refuses as full moves, when another host has room
  for it now.** The service asks the owner to hand the sandbox off (as a
  move does: the owner stores what it has not stored yet, then lets go),
  and the wake places it like a sandbox nobody owns, on a host with room,
  passing over the host it came from while another has room.
- **"Room now" is what a host reported it could take at once**
  (`View::has_room_now`), not a host whose memory could hold the sandbox
  only once it makes room, which placement otherwise falls back to.
  Without such a host, moving would not wake it sooner: the wake waits for
  room on its owner as before.
- **One ask per owner and wake.** A hand-off the owner refuses (busy, or
  wanted awake there) is not asked again by that wake; it waits as before.
- **A sandbox held only in the store takes the same path.** It still
  wakes on its old host when that host has room, which is as good as any
  host with room, and never waits for it. Releasing ownership when a host
  deletes its local copy was considered: it needs a new report from host
  to service for each sandbox, and gains only a choice among hosts that
  all have room.

## Consequences

- No wake waits for room on a full host while another host has room.
  Each hand-off is logged by the service ("a full owner handed a sandbox
  off").
- A sandbox moved with a local copy on its old host wakes from the store
  instead: a download, typically tens of seconds for a few GB, against a
  wait with no bound. Its programs end, as they would had the host shut
  it down for room; its files are whole.
- A sandbox with changes not yet stored waits for its owner to store
  them before it moves, as for any hand-off.
- Unchanged: a sandbox whose host stops answering waits for it
  ([32](0032-a-lost-hosts-sandboxes-wait-for-it.md)), and a wake on a
  host with room goes to the owner, which wakes it from its local copy.
