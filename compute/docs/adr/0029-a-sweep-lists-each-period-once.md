# 29. A sweep lists each period once

Status: Accepted, 2026-11-03. Amends
[28](0028-stored-objects-carry-their-hour.md): how a sweep finds what to
delete. What it may delete is unchanged.

## Context

ADR 28's hourly sweep reads every pointer, lists every stored object, and
only then deletes. A fleet of three storage nodes came to hold 2.85
million objects (220 GB). A listing page of 1,000 keys took 2 to 6
seconds there, so a listing alone took hours, one page after another.
From one morning on, every sweep failed or ran for over three hours. One
read that failed after its retries threw away all the run had done, so
nothing was deleted, while the store grew about 4 GB an hour. The log
said nothing about where a run was.

Most of what a sweep listed, the sweep before had listed too. Nothing
writes a name of a period a sweep may delete from (ADR 28). So once a
sweep has listed such a period, an object in it can become garbage only
by a pointer ceasing to name it.

## Decision

- **A sweep lists a period once it may delete from it.** It lists the
  periods no sweep has listed since they became old enough to delete
  from: about one hour each time, two listings (its manifests and its
  chunks). Newest first, eight at a time.
- **It deletes, of what the pointers named at the last sweep, what none
  names now.** A sweep keeps what each pointer held in its record. The
  next one compares, and for each pointer replaced or gone reads what the
  earlier version named (its manifests are still stored). Each such key no
  pointer names now goes, if its period is old enough. One whose period is
  not is left to that period's listing.
- **Every delete is judged as before**: against what every pointer names
  after this sweep's fence, and by ADR 28's period rule. The record only
  picks which objects to judge. A record lost, stale, or written by
  another sweep running at the same time can leave garbage, never take a
  named object.
- **What a manifest names is read once.** A manifest is named by its
  digest, and a working-set pack by its index's hash, so what one names
  never changes. A sweep that reads one keeps a record of it: the first
  eight bytes of the BLAKE3 hash of each key it names, and a BLAKE3 check
  over its own key and the record. A record is believed only whole and
  under the key it was kept for; otherwise the sweep reads the object
  again. Two keys that share those eight bytes only keep garbage longer.
- **Once a day a sweep lists every period again**, found with one listing
  by delimiter per area, and the old layout, and drops the records of
  objects no pointer names now. That finds what a write held up in flight
  left in a period already listed, and what a lost record missed.
- **A period is judged and deleted a page at a time**, a thousand objects
  each, so a period of a million objects shows its progress, and a
  listing the store drops partway is listed again from after the last
  page done, not from the start.
- **A piece that fails is left to the next sweep.** Each read and listing
  is tried three times. A period that cannot be listed, or some of whose
  deletes fail, stays on the list. A failed delete of a key found the
  other way is tried again. Only a pointer, or an object one names, that
  cannot be read stops a sweep before it deletes anything, as before; the
  records it kept by then save the next one those reads.
- **A sweep starts listing for at most 40 minutes** and leaves the rest
  to the next, so hourly sweeps do not run into each other. It keeps its
  record every two minutes and at the end.
- **Each delete is a request of its own**, sixteen at a time, each retried
  as any request is. Not in bulk: a store may work through a bulk
  request's keys one after another, as Garage does with S3's
  DeleteObjects. On a slow store a request of a thousand keys then
  outlasts the request timeout and deletes nothing, however often it is
  tried. A request of one key fits. Deletes cost nothing on S3 or Cloud
  Storage. A key whose delete fails stays pending, and one already gone
  counts as deleted.
- **A sweep logs its progress**: when it has kept every pointer, when it
  has found what pointers no longer name, each period it lists, and when
  it is done.

## Why it is safe

Every object a sweep deletes is one no pointer names after its fence,
whose period ended `CLOCK_SKEW` before it began. That is ADR 28's rule,
so ADR 25 and 28's argument covers it unchanged. The fence is unchanged.

Only which objects a sweep judges is new, and that decides only whether
garbage is found. Take an object of a period already listed that no
pointer names now. If no pointer named it when its period was listed, that
listing deleted it, or its period stayed on the list. If one did, and none
does now, a pointer that named it at the last sweep was replaced or went,
so it is judged now. An archive that began after a fence reuses only what
the pointers it reads name, so it cannot name an object of such a period
that no pointer named at the last sweep. The one exception is a write
held up in flight that lands after its period was listed; the fence
stopped its archive, so it is garbage, and the daily listing finds it.

## Consequences

- A sweep's work grows with what changed since the last: one hour's
  objects listed, and the manifests of copies replaced since then read.
  Every pointer is still kept and fenced, and each manifest a pointer
  names costs one small read of its record. On the store above, an hourly
  sweep lists one hour's objects instead of 2.85 million.
- The daily listing costs what every sweep did under ADR 28, in pieces
  that a failure does not throw away, spread over sweeps by the 40 minute
  limit.
- The records live under `sweep/` in the store: about 44 bytes and 8 a
  key named for each manifest or pack named, and one record of the
  sweep's state, about the size of all the pointers. A sweep's memory is
  8 bytes a key named and the pointers, where it was every key stored.
- What is unnamed of the old layout goes when the old layout is listed:
  daily, and by every sweep while some of it is too recent to delete.
- The report adds `audit`, `candidates`, `retired`, `listed`, `failed`,
  `left`, `read` and `remembered`. `stored` counts the objects in the
  periods listed, not the whole store.
- Mixed releases need no ordering. A sweep of an earlier release lists
  everything as before and leaves `sweep/` alone, a layout it does not
  know. What it deletes was unnamed after its own fence. A sweep of this
  release after it only finds some candidates gone.
- A store not swept for over a month is listed whole again, not hour by
  hour.
