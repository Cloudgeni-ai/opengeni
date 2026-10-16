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
  chunks and manifests none names that were stored more than about eight
  days before it began.
- Three rules make that safe while archives run (`compute_storage::fresh`):
  an archive that reuses an object stored more than a week ago stores it
  again; an archive publishes its pointer within a day of starting or
  starts again; and a sweep deletes an object only if it is still the
  same write it looked at (a delete conditional on the GCS generation).
  Eight days covers the week, the day and two hours of clock disagreement,
  so any pointer naming an object a sweep may delete was published before
  the sweep read pointers.
- Anything a sweep cannot read stops it before it deletes anything; only a
  damaged working-set pack does not, since a wake without it is slower.
- Without `--delete` a sweep only reports what it would delete.

## Consequences

- Storage holds what live copies name plus at most about eight days of
  leftovers. A forgotten memory image is gone about 38 days after the
  sandbox was last used.
- A chunk reused for more than a week is uploaded again once a week; a
  shared chunk costs one write a week, not one per archive.
- A seeded simulation of six concurrent archives and a sweep over a fake
  GCS checks every delete against the stored pointers; with the reuse
  rule turned off it finds the loss.
- Only GCS deletes on condition today. On Azure and S3 a sweep reports but
  refuses to delete until their conditional deletes are wired in.
- A sweep holds every stored key in memory; one prefix of tens of millions
  of chunks needs a few gigabytes. Quarantined objects are not swept.
- Copies only move by pointer changes on the host that owns them; moving
  sandboxes between hosts (ADR 15) must keep that true or hold a pointer
  while it reads.
