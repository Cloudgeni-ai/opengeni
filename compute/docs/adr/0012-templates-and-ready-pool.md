# 12. Templates and a ready pool for new sandboxes

Status: Accepted, 2026-10-16. Templates and the ready pool are in review.

## Context

A cold boot runs the guest's whole startup before the first command. Many
sandboxes created at once all pay it at the same time.

## Decision

- For each shape (processors and memory) the host keeps a template: a guest
  booted once, left until it accepts connections, then paused and saved.
  Without a valid template, a create boots cold. A template found on disk
  when the agent starts is checked chunk by chunk once before use; one that
  fails is built again.
- A new sandbox gets a copy-on-write copy of the template's disk and the
  template's memory image by hard link, so all clones read one file through
  one page cache. Its first wake is an ordinary restore.
- Clones share the template's memory, so each must learn its own identity
  and stop sharing random numbers before use: the restore notice carries the
  sandbox id and a fresh random seed; the guest stores the id, mixes in the
  seed, reseeds, and answers `ok seeded`. Until that answer the record says
  the identity is pending. A clone that does not give it in time is ended and
  its sandbox boots from its disk; no command runs in a clone before it.
- Safe to clone: a template guest holds nothing per instance (no secrets,
  keys, sessions or ids derived from its boot). The guest keeps, beside its
  machine id, the sandbox it was made for. A notice naming another sandbox
  (a clone's) first gives the guest a machine id (derived from the seed and
  the id, so a retried notice writes the same one) and the sandbox id as
  hostname; a guest that cannot answers `ok`, and the host does not use it.
  A guest booted from a disk whose machine id was made for another sandbox
  (the base image's, or a template's when a clone fell back to booting)
  makes its own at startup, and a clone's fallback boot is used only after
  the same `ok seeded`. Notices apply one at a time and carry an order, the
  sandbox record's generation and revision, which a durable write raises
  before every new notice; one ordered below the latest applied is ignored,
  so a late attempt never takes back a newer identity, whatever the host's
  clock did. The notice's time only sets the guest's clock.
- The guest helper that answers notices and runs commands must outlast the
  user's programs when the guest runs out of memory: it sets its own
  `oom_score_adj` to -1000, and each command it starts resets it to 0 (the
  setting is inherited). The balloon already gives memory back on a guest
  OOM (`deflate_on_oom`). The reference smoke guest and the lab guest do
  both.
- A ready pool (`--template SHAPE:COUNT`) keeps COUNT clones per shape
  restored, warmed until the guest accepts connections, and paused, outside
  the decision core. A create takes the oldest with one compare-and-set
  record write giving it the sandbox's id and settings, a generation above
  any that id has had, so a claim never reuses one, and the claim's time as
  its last use, so its idle time starts there. Its host-side names
  (directory, jail, cgroup, network namespace, user) stay as filled, since
  cgroups and namespaces cannot be renamed; the record keeps both names. Its
  first wake is a resume that sends the notice.
- Ready clones are disposable: never saved, and removed when their template
  goes stale, when memory runs low (before any sandbox is evicted), and when
  the agent starts. Being the cheapest memory to give back, they go first,
  ahead of any idle sandbox. They and template builds share the host's one
  memory book with sandboxes
  ([14](0014-requests-limits-and-admission.md)): the decision core counts
  each against the admission budget, and a fill or build starts only in
  room the core says no wake wants, so a fill and a wake never take the
  same memory. When a wake, the buffer or memory pressure needs room, the
  core ends ready clones first, oldest first. They fill a few at a time and
  stop when sandbox users run out. Status shows their count and resident
  memory per shape.
- A fill is booked by what it will hold, not its whole shape: the bytes of
  the template's memory image that are not zeros (counted in whole 256 KiB
  chunks when the template is built or found), plus 64 MiB for the VMM and
  for what the guest touches between its restore and answering, never more
  than the shape. That bounds a fill because the template was saved right
  after its guest answered on the same port, so a fill's guest only resumes
  where it left off; once ready it is measured, and from then on counts at
  what it holds. Should a guest touch more meanwhile, the core's memory
  readings show it within a sample. On huge-page hosts, where no guest
  gives memory back and every sandbox reserves its whole shape, a fill does
  too. A fill also books disk until it is ready: its copy of the template's
  disk and what its guest writes to it, together at most the disk's full
  length in allocation units. A ready clone writes nothing while paused and
  books no disk.
- A template build is booked at its shape's full memory: its guest boots
  cold, so nothing tells what it will touch before it answers, and builds
  are rare (one per shape and base image). Its disk is booked at its full
  length, since its guest writes to its copy while it boots, with its kernel
  copy and snapshot.
- A create claims a ready clone whenever it asks for the clone's processors
  and memory, whatever its request: before the claim is recorded, the
  clone's VM is given the request's guarantees (`cpu.weight` at once,
  `memory.low` from its first resume, which is when a VM gets it). These
  are the only VM settings a request changes; sleep settings and the rest
  live in the record, and the identity and reseed contract is unchanged,
  since the guest still learns who it is at that resume. A clone whose VM
  cannot take them is removed, and the create starts without a ready clone.
  The claimed VM leaves the pool's book and enters the sandbox's in the same
  decision, counted once.
- Every clone the agent ends on purpose (a discarded or failed ready clone,
  a claim it takes back, a clone whose guest never answered) first tells its
  pager the VM is ending, so the pager going with it is not reported as lost
  memory. Template builds boot without a pager.
- A shape with no create for a while (`--template-unused-secs`, a week by
  default) retires: its template and ready clones go, and nothing is built
  or filled for it until its next create, which boots cold. The last use is
  kept on disk, so a restart neither revives nor retires a shape early.

## Consequences

- Creating from a template is a restore, not a boot. From the ready pool it
  is a resume.
- Ready clones cost memory while unused; the pool size is a per-host setting.
  On huge-page hosts the free huge-page pool is what counts as available.
- When the base image changes, the template and its ready clones are rebuilt.
  Sandboxes already created keep their own copy.
