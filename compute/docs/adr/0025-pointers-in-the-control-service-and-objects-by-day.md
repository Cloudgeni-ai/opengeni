# 25. Pointers live in the control service, and stored objects carry their day

Status: Accepted, 2026-10-29. Replaces how
[17](0017-sweeping-unnamed-chunks.md) keeps a sweep safe (pointers fenced
on condition in the store, objects stored again after a week, deletes on
condition) and where [18](0018-the-control-service-leases-and-fences.md)'s
fenced pointer writes land. The fence itself, its stamps and its rule are
unchanged.

## Context

Two things kept stored copies safe, and both rest on the object store
doing a write or a delete only on a condition:

- A pointer is replaced only if it is still the version read (ADR 7, 17,
  18). Every archive, claim, forget, delete and sweep fence depends on it.
- A sweep deletes an unnamed chunk or manifest only if nothing stored it
  again since the sweep looked (a GCS generation). An archive that reuses
  an object stored more than a week ago stores it again under the same
  name, and without that condition a sweep could delete the fresh copy.
  So only GCS sweeps delete; on S3 and Azure storage grows for ever.

Many S3 stores do neither. Garage, the object store a small fleet runs
beside its control service, ignores `If-Match` and `If-None-Match` on
every write and delete, and its design (CRDTs, no consensus) means it
never will: two "create only" writes both succeed. On such a store a
pointer write held up in flight lands over a newer copy, and a sweep
deletes what an archive just stored.

A delete that cannot be conditional is only ever safe on a name nothing
will write again. And a pointer write needs one place that decides, in
order, which write lands.

## Decision

- **The control service keeps a fleet's pointers**, in its Postgres
  (`compute_pointers`: name, owner stamp, contents, version). A write
  names the version it replaces and lands only if the row still has it;
  a version comes from a sequence, so it never repeats, and the random
  write stamp of 17 is no longer needed. Hosts read and write pointers
  through the host API with their certificates; the control service and
  the sweep use the table directly. Everything that decides a write
  (`compute_fleet::fence`, begin, claim, publish, forget, delete,
  tombstones) is unchanged: only where a pointer is kept moved.
- **A host on its own**, with no fleet, keeps its pointers in its object
  store as before, and checks once at start that the store enforces a
  conditional create; a store that does not (Garage) is refused there.
- **Chunks and manifests carry the day they were written**, in their
  name: `chunks/v2/<day>/...` and `manifests/v2/<day>/<digest>.json`, the
  day counted in UTC days since 1970. A host writes only names of its
  current day, and never stores an object again for its age:
  - An archive reuses what the copy before it names (and the image a disk
    was made from) whatever its day. Everything it reuses is named by a
    pointer it read after it began.
  - A chunk an archive makes from new bytes is written under today's
    name; if another archive wrote the same bytes today it is reused.
    An object of an earlier day with the same bytes is not looked for.
- **A sweep needs no conditional delete**, on any store. It fences every
  pointer as before (an archive begun earlier can no longer publish),
  then deletes chunks and manifests no pointer names whose day ended at
  least a whole day before the sweep began. That is safe however long a
  delete is held up in flight:
  - every pointer after the fence names only objects named at the fence
    or written after it, and nothing written after it is two days old;
  - nothing writes a name of an earlier day, so a late delete never takes
    a newer write.

- **A fleet goes by one clock**, its database's. The control service tells
  it in every answer to a host's pointer request, and a host names the day
  of what it stores by it, not by its own clock: an archive begins with a
  pointer request, so the clock is fresh whenever it names anything. A
  sweep reads it before it starts. So a host whose clock is a day out
  cannot write a name a sweep takes as old, and the hour of disagreement
  the rule allows is left to the time a request takes. A host on its own
  goes by its own clock, which its sweep reads too.
  Objects in the old layout (`chunks/v1`, `manifests/v1`) are never
  written again; one no pointer names is deleted once it was last stored
  more than a week before the sweep, as before.
- **The sweep runs from the control image**, `compute-control sweep
  --store ... --delete` with the service's database, daily as before.
  `compute-host sweep` remains for a host on its own.
- **Moving pointers into the service is automatic and safe while hosts
  upgrade.** Until a fleet's pointers are imported, the service answers
  hosts' pointer requests as unavailable (they try again), its own
  pointer changes wait, and a sweep refuses to start. The leader imports
  them once no live host is of a release that writes pointers to the
  store itself: a host says in its registration that it keeps them in the
  service. It copies every `pointers/v3` object into the table (a row
  already there wins) and records the store as imported; a store with no
  pointers is recorded at once. Nothing removes a pointer from an object
  store, so one listed that reads as not there is on a store catching up:
  it is read again for five minutes, and if still not there the import
  fails and is tried again, never leaving it out. The record is made in
  one transaction that checks again that no such host is live, and that
  none changed since the
  leader read the hosts before reading the object store, so a host of an
  earlier release that registered, renewed or wrote meanwhile is waited for
  once more. From then on a host that does not keep its pointers in the
  service is refused registration and renewal. The store's own
  `pointers/v3` objects stay as they were, read by nothing.
- **The moved store is marked.** Before it reads the object store, the
  leader writes `pointers/moved` there. A sweep by the pointers left in the
  store, which nothing updates any more, would delete objects only the
  service's pointers name, so `compute-host sweep`, and a host on its own,
  refuse a marked store. A service whose import has not happened refuses
  to sweep.
- **A sweep adopts what an import missed.** Before it fences, a sweep that
  deletes copies into the table every `pointers/v3` object the table has
  no row of, as the import would have (rows are never removed, so such a
  name was never moved in). A store that listed a pointer late during the
  import then cannot leave the copy it names to the sweep.
- **Stored copies get format 4**, whose manifest names carry their day; a
  host reads formats 3 and 4 and writes 4.
- **A read waits for a store that is catching up.** Something names every
  chunk and manifest read, and each was stored before anything named it,
  so a store saying one is not there is either catching up or has lost
  it. Not every store reads what was just written: Garage, run so that a
  write lands once one of its nodes has it, answers from a node that was
  away while the write landed until that node has caught up. A read of a
  chunk or manifest the store says is not there is tried again for five
  minutes, and only then taken as gone. A check whether an object is
  stored still answers at once: at worst the bytes are stored again.
  A read of what only saves time (a wake's profile, a working-set pack,
  the earlier copy and image an archive reuses chunks of) does not wait:
  the reader goes on without it at once.

## Consequences

- Compute runs on any S3 store, Garage included, as well as GCS and
  Azure, and sweeps delete on all of them.
- Unnamed objects go within two to three days of the last pointer naming
  them, instead of about a week, and a chunk shared by many sandboxes is
  no longer stored again every week.
- The same new bytes stored on different days are stored once per day.
- A pointer change costs a round trip to the control service instead of
  one to the store. A host that cannot reach the service already cannot
  renew its lease, and stops archiving with it.
- The table holds one row per sandbox, image and template ever stored,
  tombstones included: a few hundred bytes each.
- A fleet whose hosts are mid-upgrade archives and restores nothing on its
  upgraded hosts until the last old host is gone, normally seconds after
  it stops: upgrade all hosts promptly after the service.
  `compute_control_pointers_waiting_hosts` counts the hosts the move waits
  for.
- A control replica of an earlier release still serving after the move
  (only when no host was live during the service's own rollout) deletes or
  forgets a pointer only in the object store: what it named stays stored
  until removed by hand, never lost.
- An archive store must acknowledge a write only once it keeps it
  durably, as GCS, Azure and S3 do: a host drops its own copy once the
  store holds the chunks. Garage in its `dangerous` consistency mode
  acknowledges once one node has a write, so a node lost before it copied
  a write to another loses it, and with it the copies that name it.
- Copying a fleet's store elsewhere is a copy of its chunks and manifests:
  the pointers are already in the service.
- A chunk or manifest that is really gone takes five minutes to fail,
  where it failed at once; a sandbox reading it waits that long, with the
  store's warning in the host's log, before its read fails.
