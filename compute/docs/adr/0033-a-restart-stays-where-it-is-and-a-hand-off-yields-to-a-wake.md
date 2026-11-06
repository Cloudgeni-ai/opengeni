# 33. A restart stays where it is, and a hand-off yields to a wake

Status: Accepted, 2026-11-06. Amends
[18](0018-the-control-service-leases-and-fences.md) (how the service
restarts a sandbox, and how long a hand-off may keep it asleep) and
[21](0021-opengeni-runs-natively-its-agent-behind-the-hosts-link.md) (what
a `state` frame says).

## Context

The service restarted a sandbox by having its owner hand it off awake,
then taking it anew from its files. A hand-off archives the sandbox first,
memory and all, and its sandbox takes no wake until that ends. On a host
under memory pressure whose store took writes at a fraction of a MB/s, a
16 GiB memory image and a 22 GB disk would have taken many hours. Every
command found the sandbox asleep and failed; each restart the agent's
turn asked for, because its agent did not answer, joined the same
hand-off and timed out at the service; and the sandbox list said ready,
since its lease was warm. Only restarting the host agent, which drops a
hand-off in memory, ended it, and the next wake took seconds from the copy
still on the host.

A restart needs none of that: the sandbox's files are on its host already,
newer than any stored copy.

## Decision

- **A restart happens where the sandbox is.** The host request
  `Restart { id }` cancels any step under way (a boot already is one), ends
  the VM without saving it, and forgets the memory image, here and in the
  store's copy, before anything wakes it; the next wake boots it from its
  files on the same host. Nothing is stored first, so it takes as long as
  ending a VM. A wake asked meanwhile waits. A hand-off under way refuses
  it (`busy`), and it refuses a hand-off. A memory image that cannot be
  forgotten (a store out of reach) ends the restart unfinished: the sandbox
  wakes from its last save rather than not at all, and the caller hears
  why. The service asks the owner for it, with a bounded wait, and falls
  back to the hand-off only for a host that predates it.
- **A hand-off refuses wakes for a bounded time.** For its first two
  minutes (`hand_off_unwakeable`) a wake is refused as before, so a quick
  hand-off, which drains and resizes rely on, is never undone. A wake after
  that cancels the hand-off as an agent restart before its last step
  would: its waiters hear `busy` ("cancelled"), the archive under way is
  cancelled, and the sandbox runs from its local copy. The service waits
  five minutes for a hand-off, longer than the window, so it hears how one
  ended.
- **The host says when it is busy with a sandbox.** A `state` frame on the
  agent link carries `busy: "handing_off"` while a hand-off is under way,
  and omits it otherwise, as older gateways read. Opengeni records it on
  the lease. Its sandbox list then shows the sandbox `recovering` (with
  `hostBusy`) instead of ready, and a turn whose agent does not answer
  meanwhile restarts nothing and tells the agent plainly that the machine
  is being moved or saved and to try again in a couple of minutes. A
  report older than three minutes counts for nothing: by then a wake
  cancels the hand-off.

## Consequences

- No restart, hand-off or slow store keeps a sandbox from running for more
  than about two minutes, and the newest copy, its files on its host, is
  never given up: a cancelled hand-off and a restart both keep it.
- A restarted sandbox stays on its host. Moving one off a struggling host
  is a drain's or a move's job, not a restart's.
- A drain's hand-off of a sandbox someone keeps using may be cancelled by
  that use after two minutes; the drain counts it as left and asks again.
- Busy means "for now": a gateway that misses the frame that clears it
  stops trusting the flag after three minutes.
