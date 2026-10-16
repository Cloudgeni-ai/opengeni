# 17. Sweeping the chunks no copy names

Status: Accepted, 2026-10-16

## Context

Stored copies are content-addressed chunks and manifests, shared between
sandboxes, named by one small pointer per sandbox. Deleting a sandbox,
forgetting its memory image after about 30 days, or replacing its copy
only changes the pointer: until something deletes them, the old chunks
stay and storage grows forever.

Deleting them is the dangerous part. An archive that finds a chunk already
stored reuses it without writing it, and names it only when it publishes
its pointer at the end. A sweep that read the pointers just before that
would delete a chunk the new copy needs, after its local copy may be gone.

## Decision

- A sweep (`compute-host sweep --store gs://...`, run daily per store
  prefix, safe beside running agents) reads every pointer and deletes the
  chunks and manifests none names that were stored more than about a week
  before it began.
- Three rules make that safe while archives run (`compute_storage::fresh`):
  - An archive notes its pointer's version when it begins (storing an
    empty pointer if there is none) and publishes only on condition that
    the pointer is still that version.
  - Before deleting anything, a sweep stores every pointer again as it
    read it, on condition that it is unchanged. An archive that began
    earlier can then no longer publish and starts again; one that
    published in between changed the pointer, so the sweep reads it again.
  - An archive that reuses an object stored more than a week ago stores it
    again, and a sweep deletes an object only if it was stored more than a
    week and two hours (twice the allowed clock disagreement) before the
    sweep began, and only if it is still the same write it looked at (a
    delete conditional on the GCS generation).

  So every pointer a sweep did not account for comes from an archive that
  began after it, and everything such an archive reuses is too recent to
  delete. The store enforces the first two rules on each write: a pointer
  write held up in flight, or a host stalled for hours, is refused rather
  than landing after a sweep. An earlier design that only gave archives a
  deadline to publish could not stop a write already sent from landing
  late.
- Forgetting a memory image also drops its working-set pack, which holds
  memory pages; a copy without memory names no pack.
- Anything a sweep cannot read stops it before it deletes anything; only a
  damaged working-set pack does not, since a wake without it is slower.
- Without `--delete` a sweep only reports what it would delete, and writes
  nothing.

## Consequences

- Storage holds what live copies name plus at most about a week of
  leftovers. A forgotten memory image, its pack included, is gone about 37
  days after the sandbox was last used.
- A chunk reused for more than a week is uploaded again once a week; a
  shared chunk costs one write a week, not one per archive.
- Each deleting sweep writes every pointer once (a million sandboxes cost
  about five dollars of GCS writes per sweep), and archives in flight when
  it does start again; with a daily sweep and archives lasting minutes,
  that is rare.
- A seeded simulation of six concurrent archives, some held up for five
  minutes, and a sweep over a fake GCS, each reading its own clock off by
  up to the allowed disagreement, checks every delete against the stored
  pointers; with the reuse rule or the fence turned off it finds the loss.
- Only GCS deletes on condition today. On Azure and S3 a sweep reports but
  refuses to delete until their conditional deletes are wired in.
- A sweep holds every stored key in memory; one prefix of tens of millions
  of chunks needs a few gigabytes. Quarantined objects are not swept.
- Copies only move by pointer changes on the host that owns them; moving
  sandboxes between hosts (ADR 15) must keep that true or hold a pointer
  while it reads.
