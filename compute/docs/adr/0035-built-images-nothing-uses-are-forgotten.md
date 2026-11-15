# 35. Built images nothing uses are forgotten

Status: Accepted, 2026-11-11. Amends
[19](0019-e2b-compatible-front-door-and-guest-init.md) (how long an image
built from an OCI image is kept) and
[22](0022-templates-saved-from-sandboxes.md) (what counts as a use of a
stored image).

## Context

Every release names new OCI images, and every change of the hosts' guest
programs has each followed image built again (ADR 19). Each build is
stored and recorded, and the record alone kept the image for ever: ADR 22
forgets captured images nothing uses, but counted any recorded build as a
use. Measured on a production fleet after five weeks: 253 stored images,
about 200 of them named by no template, no sandbox and no name's current
release, 80 GB of a 550 GB store, growing by about nine images a day.

A built image is a copy of what its OCI image builds again in a few
minutes. Only three things need one kept: a sandbox whose config names it,
a template that names it, and a name that starts new sandboxes from it.

## Decision

- **A built image is used while it is the latest build some name uses**,
  or a template or a sandbox's config names it. Any other is forgotten as
  a captured image nothing uses is (ADR 22): unused for an hour, it is
  claimed by one collector, which empties its pointer and deletes its
  record; a sweep then frees its chunks.
- **Every stored image has the record the collector reads.** A build is
  recorded beside the captured images, as is a second host's build of an
  OCI image another host's build was recorded for first, which nothing
  ever uses. A database from before gets a record for each build and for
  each image a pointer still names.
- **The record of its builds goes with the image.** A name that uses its
  OCI image again, as a rollback does, finds nothing built: it starts from
  the image it used last while a host builds a new one.
- **Recording a build takes turns with a claim** by the image's record,
  as a template's insert does. While an image is claimed it is no OCI
  image's build, and no use of it is recorded.
- **A host stands by an image it stored for 30 minutes.** The service
  asks a host only for an image it has no record of, and forgets one no
  sooner than an hour after it was last recorded. A host asked long after
  it stored an image can no longer say the store holds it, so it builds
  again: a new image, stored anew, never the id of one forgotten.
- **The images the service was started with are never forgotten**
  (`--stored-image`): a name starts from its own each time the service
  starts, until it has read what was built since.

## Consequences

- The store keeps one image per name and release in use, plus those
  sandboxes and templates still name, instead of every build ever made.
- A rollback to a release whose image was forgotten costs one build
  (minutes) before new sandboxes get that release's image; meanwhile they
  start from the newer one. Within the hour a rollback is free, as before.
- A host asked again more than 30 minutes after storing an image builds
  it once more, though its own copy may still be whole. That happens only
  after the service lost the record, which forgetting is the one way to.
- The two times depend on each other: a host must stand by an image for
  less time than the service keeps one unused (`TOLD_FOR` in the host,
  `UNUSED_FOR` in the service).
