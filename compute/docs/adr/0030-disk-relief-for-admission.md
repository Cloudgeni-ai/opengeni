# 30. Disk relief counts as room

Status: Accepted, 2026-11-02. Amends
[14](0014-requests-limits-and-admission.md): what local disk a create,
adopt or wake may count as free.

## Context

A host books its local disk for everything that may write to it (saves,
disks that grow, first files, fetches) and refuses a create, adopt or wake
the book cannot take as host full. Three kinds of files sit on that disk
only to go faster: the local copies of idle sandboxes whose copy object
storage already holds, templates with their ready sandboxes, and cached
images. Removing any of them loses nothing; the next use fetches or builds
it again.

The host gave them up only late. Idle copies went only while the disk
could not book what was booked already, never for a create it refused,
and templates and images only after a week unused. Hosts with a few
hundred GB of templates and images built for images superseded the same
day refused creates as host full, and the fleet left work waiting for
capacity, while that disk could have been freed in seconds. Memory has
had the equivalent for long: idle saved VMs a wake may end count as room
(ADR 4).

## Decision

- **What counts.** Disk relief is what the host frees without losing
  anything: the local copies of idle sandboxes whose copy object storage
  holds (archived, nothing holding or waking them), and templates with
  their ready sandboxes and cached images that no create, adopt, fetch,
  fill or build uses. Each counts at what removing it frees at least,
  measured every half minute: only the blocks a file holds alone, nothing
  of a file with another link. Copies only saved locally, awake sandboxes,
  anything in use and what has not been measured count for nothing, so
  nothing is promised twice.
- **Admission counts it.** A create, adopt or wake that fits only with
  relief is taken as one that fits after the next reading is: it books
  what it needs (`Wants`), so nothing else takes that room, and waits.
  Booked, the disk cannot hold what is booked, so the core frees relief,
  least recently used first across copies and caches, but only when what
  is measured covers the shortfall; otherwise the earlier count-based
  eviction of copies runs. The work goes on once a reading shows the room,
  and is refused when relief is gone and it still does not fit.
- **What is removed is checked again.** The agent removes a template or
  image only if nothing uses it at that moment; one in use stays and is
  forgotten until measured free. A removed template is built again by the
  next create of its shape.
- **The fleet sees it.** A host reports what relief could free for a new
  sandbox (`disk_reclaimable_mib`, missing and so zero from earlier
  hosts), and placement counts it as free disk. Every removal is an event,
  `compute.disk.freed`, with its kind, the bytes measured and why.
- **The week rule stays** for templates and images nothing needed room
  from.

## Consequences

- Hosts stop refusing creates for disk they could free, and placement no
  longer passes over them for it.
- A create that needs relief waits a few seconds, for evictions and
  removals and the reading after them. A sandbox whose copy went wakes
  from object storage; a create whose template went boots cold or waits
  for the build.
- Sizes are lower bounds: blocks a template shares with its sandboxes, or
  a compressed extent, count for nothing. Relief may therefore free more
  than it counted, never less.
- Host groups judge hosts by memory and processors only, so disk relief
  does not change how a group scales.
