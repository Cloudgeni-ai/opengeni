# 3. Idle means no activity; a ladder of sleep levels

Status: Accepted, 2026-10-16

## Context

A timer since the last request misjudges both ways: it pauses a long build
nobody is watching, and keeps an agent's sandbox awake while it waits for a
human. Sleep also has to be cheap to undo, or nobody will let it happen early.

## Decision

A sandbox is in use while any of these holds: a caller holds it (an agent
turn; holds are named and leased, so a crashed caller cannot pin a sandbox
forever), its VM uses a quarter of a processor or moves 4 KiB/s over five
seconds, a stream into it is open, or a port saw recent traffic. Idle means
none of them.

Idle sandboxes step down a ladder: Running, Paused, Compressed (bare metal
only), Saved (local disk), Archived (local disk and object storage), Remote
(object storage only). Recommended rules: pause after 10 s, save after 30 s
while staying paused in RAM, archive after 2 minutes, delete the local copy
after 3 days and the memory image after 30. Any use wakes the sandbox.

## Consequences

- Pausing is free to undo (about 10 ms), so it happens early and idle VMs
  burn no processor.
- The early background save means ending a VM later loses nothing and takes
  milliseconds.
- After 2 idle minutes a sandbox survives losing its host.
- Connections the guest opens out through the host do not hold it awake on
  their own; only their traffic and processor use count. This is deliberate.
