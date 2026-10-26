# 22. Templates saved from sandboxes

Status: Accepted, 2026-10-26

## Context

Images come only from OCI images (ADR 19). Work such as CI wants to start
from a sandbox someone prepared: a repository checked out, dependencies
installed, caches warm. E2B offers this as snapshots. A template must be
exactly the disk its sandbox had, must not hold up the host while a large
disk is stored, and the images nobody uses any more must be forgotten
without ever forgetting one a template or a create still needs.

## Decision

- `POST /v1/sandboxes/{id}/templates` (optional `name`, unique in the
  team) captures a sandbox's disk as a stored image and records a
  template naming it, with the sandbox's shape and disk length. A create
  names it with `template`, by id or name; its sandbox boots afresh on a
  copy of that disk. `GET /v1/templates`, `GET` and `DELETE
  /v1/templates/{id or name}`. The sandbox is saved for the capture and
  woken again after if it was running.
- The host copies the disk only while the sandbox is saved (or archived)
  and idle on it, in the agent's own loop, so no wake can begin during the
  copy. The guest writes its disks out before every save, so the copy is
  whole without the memory saved beside it. The copy shares the disk's
  blocks: it takes milliseconds whatever the size. A host whose files
  cannot share blocks refuses captures rather than copy bytes while every
  other sandbox waits.
- The host stores the copy as an ordinary image (named by its BLAKE3
  digest) in the background. Asks carry a key: the first copies and starts
  the store, later ones learn how it stands, so no call stays open while
  gigabytes upload. A failed store is told once; the next ask copies again.
- Only the filesystem is kept. A memory snapshot would carry the source's
  processes, identity and random state into every sandbox started from it,
  which needs forking (not built). E2B snapshots are offered for
  `memory: false` only; one with memory is refused, never quietly made
  without it. E2B's `POST /sandboxes/{id}/snapshots`, `GET /snapshots` and
  `DELETE /templates/{id}` map onto templates, and an E2B create names one
  as its `templateID`.
- A sandbox started from a captured disk is a new machine: the guest
  clears the agent state an earlier sandbox left on it when the disk's
  owner is not this sandbox, so Opengeni's agent enrolls afresh.
- The store records every captured image. An image is used while a
  template, a sandbox's config or a built image names it. A replica looks
  every 10 minutes; an image unused for an hour is marked as being
  collected, its pointer deleted outright (images are content-addressed,
  so no tombstone: the same disk may be captured again), then its record.
  A sweep (ADR 17) then frees its chunks. Inserting a template and marking
  its image both lock the image's record first, so a template is never
  recorded over an image being collected; that capture stores it again.
  After recording a template the service checks the pointer is there, for
  the capture that found it stored just as it was forgotten.

## Consequences

- A capture costs one save of the sandbox and the upload of the blocks
  object storage does not have; an unchanged dependency tree is mostly
  chunks already stored.
- A template keeps the guest version of the sandbox it came from; it does
  not follow guest upgrades as images built from OCI images do. Capturing
  again from a sandbox of a newer image refreshes it.
- Sandboxes from a template boot cold: host templates and ready clones
  (ADR 12) are per image and shape, and a captured image gets them like
  any other once creates use it.
- If the control service stops between a host storing a capture and the
  template being recorded, the image has no record and is never forgotten.
  Capturing the same unchanged sandbox again finds the same image and
  records it; a changed one leaves the old image behind.
- A create resolves its template's image and then records its sandbox;
  the hour's grace covers that gap many times over.
- Hosts of earlier releases answer a capture as an unknown request; the
  service tells the caller that host cannot capture.
