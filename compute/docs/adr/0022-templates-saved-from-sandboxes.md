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
- A sandbox started from a captured disk is a new machine. The guest
  forgets the sandbox the disk was made for before anything reads what
  the disk keeps: that sandbox's agent state (instance lock, command
  spool, browser controller state) and what its create gave it (its init,
  with its environment and access token), so neither the image's command
  nor Opengeni's agent starts with them. A sandbox booted on the disk does
  this when the disk's owner is another sandbox; a template builder,
  booted with no sandbox, does it before its snapshot, so every ready
  clone starts as new; a clone told it is a sandbox does it again should
  its disk still name another.
- The store records every captured image. An image is used while a
  template, a sandbox's config or a built image names it. A replica looks
  every 10 minutes; an image unused for an hour is claimed by one
  collector, which empties its pointer, then deletes its record. A sweep
  (ADR 17) then frees its chunks.
  - Every use recorded of an image and every claim on it take turns by
    locks, and a claim looks at the uses only once it holds its lock: a
    template's insert and a claim lock the image's record, and a sandbox
    created from a template locks the template, which a claim cannot
    precede (the template is a use). A use recorded first keeps the
    image; one after finds it claimed and is refused: the capture stores
    it again once forgotten, and a create whose template was deleted
    meanwhile fails as naming no template.
  - A built image needs no such turn. A build is a new file system with a
    random UUID, so no disk can be captured with its bytes before a
    sandbox starts from it, which it does only once the build is
    recorded; recorded, it is a use that keeps a captured image of the
    same bytes.
  - A claim names its collector. Another collector takes it over only
    once it lapses (10 minutes), as when its collector stopped. A
    collector reads the pointer, then checks it still holds its claim,
    then replaces the pointer with the empty one a store begins with, on
    condition of the version it read; it then deletes the record only if
    its claim still stands. A collector held up after its check finds the
    version changed when the image was forgotten by another, or stored
    again for a capture since, so it never empties a pointer a template
    recorded after its claim lapsed needs. A sweep's fence also changes
    the version: the collector reads and checks again.
  - The pointer is emptied, never deleted: images are content-addressed,
    so no tombstone is left (the same disk may be captured again and
    published over it), and a delete carries no condition on every store,
    so one held up in flight could land on a later store. The empty
    pointer of each forgotten image stays, a few dozen bytes.
  - After recording a template the service checks the pointer is there,
    for the capture that found the image stored just as it was forgotten.

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
- A create resolves its template's image and then records its sandbox
  under its template's lock, so a template deleted in between fails the
  create rather than leave a sandbox naming an image being forgotten.
- A collector that stops holding a claim leaves that image unrecorded as
  a template for up to the claim's 10 minutes; a capture of it waits, as
  it does for any image being forgotten.
- Hosts of earlier releases answer a capture as an unknown request; the
  service tells the caller that host cannot capture.
