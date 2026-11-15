# 41. Every host keeps each new image ahead of its creates

Status: Accepted, 2026-11-13. Amends
[19](0019-e2b-compatible-front-door-and-guest-init.md) (when a host
fetches a stored image) and [22](0022-templates-saved-from-sandboxes.md)
(where a captured image goes). Works with
[40](0040-an-image-is-built-over-the-one-before.md).

## Context

When a release's image of a name was built, or a sandbox captured as an
image, only the host that made it kept a copy. Every other host fetched
the image, and then built the template of each shape on it, the first
time a create of that name came to it, and that create waited for both.

Measured on a production fleet of two hosts over four days, 64 creates
waited for such a fetch, 9 to 140 seconds each, typically 28 to 68
depending on the host; every other create took 0.1 to 0.4 seconds.
Several creates sometimes waited for the same fetch at once.

## Decision

- **The service asks every live host to keep each image a name starts
  from, and each image captured in the last hour** (`Request::Keep`). A
  host is asked once per image while the service runs, and again after
  the service restarts; one that cannot be reached is asked again, one
  from before the request is not.
- **A host answers at once and fetches in the background** unless it has
  the image. It fetches over the image the name started from before, when
  it has that, so only the chunks that differ are downloaded; with
  [40](0040-an-image-is-built-over-the-one-before.md) that is what
  changed between releases, not the whole image.
- **Once the image is there, the host builds the template of each shape
  it keeps a template of on the image before**, and counts it used then,
  so a template no create comes for retires as any other does
  ([35](0035-built-images-nothing-uses-are-forgotten.md)).
- A host with no store has nothing to fetch and does nothing.

## Consequences

- The first create of a new image on a host starts from a template, as
  every later one does, instead of waiting for a fetch.
- Every host downloads every new image and builds its templates, used
  there or not: a few hundred megabytes per release with
  [40](0040-an-image-is-built-over-the-one-before.md), the whole image
  without it, and the memory of building each template once. Images and
  templates no create uses are removed as before.
- A captured image is spread for an hour only; a host that joins later
  fetches it on its first create, as before.
- A host whose disk relief removed a kept image is not asked again until
  the service restarts; its next create fetches it.
