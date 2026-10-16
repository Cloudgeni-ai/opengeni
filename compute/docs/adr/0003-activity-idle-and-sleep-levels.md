# 3. Idle means no activity; a ladder of sleep levels

Status: Accepted, 2026-10-16

## Context

A timer since the last request misjudges both ways: it pauses a long build
nobody is watching, and keeps an agent's sandbox awake while it waits for a
human. Sleep also has to be cheap to undo, or nobody will let it happen early.

## Decision

A sandbox is in use while any of these holds: a caller holds it (an agent
turn), its VM uses a quarter of a processor or moves 4 KiB/s over five
seconds, a stream into it is open, or a port saw recent traffic. Idle means
none of them. Holds carry a name and a lease the caller renews, so a crashed
caller cannot pin a sandbox; the API still accepts a hold without a lease,
which lasts until released, and that will be removed.

Idle sandboxes step down a ladder: Running, Paused, Compressed (bare metal
only), Saved (local disk), Archived (local disk and object storage), Remote
(object storage only). Where memory is and which copies exist are separate:
a Paused sandbox may already be saved and archived. Recommended rules: pause
after 10 s, save after 30 s while staying paused in RAM, archive after 2
minutes, delete the local copy after 3 days and the memory image after 30.
Any use wakes the sandbox. `sleep` asks for a minimum depth once holds allow
it; a later wake cancels it.

## Consequences

- Pausing is cheap to undo (about 10 ms), so it happens early and idle VMs
  burn no processor.
- The early background save means ending a VM later loses nothing.
- Once its archive completes (due 2 idle minutes in), a sandbox survives
  losing its host.
- Connections the guest opens out through the host do not hold it awake on
  their own; only their traffic and processor use count. This is deliberate.
- Time keeps passing for a sleeping guest: its monotonic and wall clocks
  include the sleep, so a timer that came due while it slept fires right
  after it wakes (within 0.1 s in the engine test, after a pause and after a
  save) and later ones fire on time. A sixty-second timer set before a week's
  sleep fires once, on waking; nothing replays the timers it missed.
