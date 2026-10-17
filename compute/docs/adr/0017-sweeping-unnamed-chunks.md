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
- Every other pointer change is conditional too. Forgetting a memory image
  replaces the pointer only on the version it read, and deleting a pointer
  deletes only the version it read (by GCS generation; elsewhere by
  replacing it with the empty pointer on condition). A change whose
  version moved reads again; a write held up in flight long after its
  caller gave up can never land over a newer copy and leave a pointer
  naming what a sweep took.
- Every pointer write begins with a random 16-byte stamp, so a pointer
  stored again with the same contents is a new version on every store.
  GCS generations change anyway, but an S3 entity tag follows the bytes:
  without the stamp, a delete held up in flight could land on a pointer
  a new sandbox of the same name later stored with the same contents,
  and the fence would not stop an archive whose pointer it stored again
  unchanged. A sweep that deletes is refused before it stores any pointer
  on a store without deletes on condition, which today means anything but
  GCS.
- Stamped pointers live under `pointers/v3`: after the write stamp comes
  the owner stamp ([18](0018-the-fleet-service-leases-and-fences.md)). An
  agent will not start on, and a sweep will not run over, a store that
  still holds `pointers/v1` or `pointers/v2`: their copies would look
  absent and a sweep would delete what they name. Only lab stores ever
  held them, so there is no migration; such a store is emptied or a new
  prefix used.
- Deleting a sandbox leaves a tombstone, an empty pointer under its
  owner's stamp that no later archive publishes over. A sweep never
  stores a tombstone again, and deletes one stored longer ago than the
  sweep window, on condition that it is still the same write; by then no
  archive of that sandbox is still trying.
- Forgetting a memory image also drops its working-set pack, which holds
  memory pages; a copy without memory names no pack. The forget carries a
  change number of its own, as an archive does
  ([18](0018-the-fleet-service-leases-and-fences.md)): tried again after
  its answer was lost it finds itself done, and an archive begun before it
  can no longer land over it.
- Anything a sweep cannot read stops it before it deletes anything; only a
  damaged working-set pack does not, since a wake without it is slower.
- Without `--delete` a sweep only reports what it would delete, and writes
  nothing.

## Consequences

- Storage holds what live copies name plus at most about a week of
  leftovers. Age counts from when an object was last stored, so a memory
  image forgotten 30 days after last use, its pack included, usually goes
  at the first sweep after.
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
  Regressions hold up a forgetting write and a pointer delete in flight
  past a newer copy and check that neither lands, also on a store whose
  entity tags follow the bytes.
- Only GCS deletes on condition today. On Azure and S3 a sweep reports but
  refuses to delete until their conditional deletes are wired in.
- A sweep holds every stored key in memory; one prefix of tens of millions
  of chunks needs a few gigabytes. Quarantined objects are not swept.
- Copies only move by pointer changes on the host that owns them; moving
  sandboxes between hosts (ADR 15) must keep that true or hold a pointer
  while it reads.
