# 27. Resizing a sandbox

Status: Accepted, 2026-11-02

## Context

A sandbox's shape (`vcpus`, `memory_mib`, its requests and `disk_mib`) is
fixed when it is created. A deployment that raises the shape it creates
sandboxes at leaves every older sandbox at the old one, and the only way
to give one more room was to make a new sandbox and copy its files over.

A host books, limits and places a sandbox by the shape in its record,
which the service sent it. A memory image restores the machine it was
saved from: Firecracker brings back the snapshot's own processors and
memory, whatever the sandbox is given now. A file system grows but does
not shrink.

## Decision

- **`POST /v1/sandboxes/{id}/resize`** takes any of the shape's fields;
  each omitted keeps its own. The result is checked as a create's would
  be, and `disk_mib` may only stay or grow. A resize to the shape a
  sandbox has changes nothing.
- **A resize is a move** ([15](0015-placement-and-moves-between-hosts.md)).
  The owner hands the sandbox off through object storage, as a move does
  (with `awake`, even while it is held awake; without, such a sandbox is
  refused as busy). The service then writes the new shape into the row
  while no host owns it, on the row's version, and takes it anew under a
  raised epoch, so a host given up on that still holds it drops its copy
  when it returns instead of getting it back at the old shape. A wake
  that takes the sandbox up in between is handed off again, a few times,
  before the resize answers that it is unavailable. The shape is never
  written while a host owns the sandbox, so no host holds it at a shape
  other than its row's, and there is no second way to change a running
  VM. Its next wake places and books it at the new shape; a host without
  room refuses it as for any adopt.
- **The memory image goes when the machine changes.** A resize of `vcpus`
  or `memory_mib` takes the sandbox anew with its stored copy no longer
  vouched for as whole, as after a lost owner, so the host that adopts it
  deletes the image from the copy as it claims it and boots it from its
  disk at the new shape, whatever the image records. As a backstop,
  memory images and the stored copy also record the processors they were
  saved with (their memory is the image's length), and a host gives up
  an image saved at another shape than the sandbox is given, even from a
  copy vouched for. New requests or a longer disk keep the image:
  requests are bookings, not the machine.
- **A longer disk** is made that long as the adopting host fetches the
  copy. Images record how long the disk was when they were saved; a
  restore whose disk is longer tells the VM its drive grew, and the
  restore notice tells the guest, which grows its file system to fill it
  before it answers. A booted guest grows it at boot.

## Consequences

- A resize of `vcpus` or `memory_mib` ends the sandbox's running
  programs, as a crash would; its files stay. Requests and a longer disk
  keep them, after a pause like a move's. Open connections end either way.
- A copy stored before this release does not say how many processors its
  image was saved with, so its adopting host cannot tell a resize of
  `vcpus` alone from a lost owner, and raises the programs-lost alarm for
  it as for one.
- A host of an earlier release reads an image recording its processors
  or disk as damaged, and gives it up; rolling hosts back costs the
  programs of sandboxes saved since.
- The guest's writes reach the disk before every save (the hand-off
  pauses through the same step as any save), so dropping the memory image
  loses no write the guest held; a guest that does not answer in ten
  seconds is saved as it is, as for any save.
