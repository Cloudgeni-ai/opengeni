# 45. The leader removes a spare host, keeping programs

Status: Accepted, 2026-11-26. Amends
[15](0015-placement-and-moves-between-hosts.md) (who drains a host) and
[36](0036-idle-memory-stays-in-ram.md) (what a drain keeps of an idle
sandbox).

## Context

The leader grew its host group by itself but only logged that it could
shrink. On the staging fleet it logged "drain a host to shrink it" every
ten seconds for most of a day (4,452 times in 14 hours) while three hosts
ran where two would do, at about $370 a month per host. Removing a host
was an operator's drain, a wait and a delete.

A drain hands off every sandbox nothing holds awake, and since
[36](0036-idle-memory-stays-in-ram.md) an idle sandbox whose memory is only
in RAM goes with its files alone: its programs end. An explicit sleep
saves them whatever the sandbox's rules say.

## Decision

- **The leader shrinks the group itself** (`--scale-shrink-after-s`, 30
  minutes by default; 0 turns it off). Once every look has found more
  spare than the group needs (`ScaleDecision::Shrink`, unchanged: a new
  host's worth beyond the target with one host gone, nothing booting,
  draining or stalled, above `--scale-min`) for that long, and as long
  after the group last grew or lost a host, it drains the live host with
  the most memory free without ending any VM process, among equals the
  one holding the fewest sandboxes: the fewest to move, each of which
  wakes slower elsewhere. One host at a time. It does so only while every
  live host of the group says it keeps an idle sandbox's memory in a
  hand-off (`keeps_memory` in its description), so **hosts are upgraded
  before the control service**; until then it holds back and says so
  (`compute_fleet_shrink_held_back`). Shrinking is on wherever a host
  group is configured (`--gcp-group`): staging today, as production
  runs on Modal.
- **Its drain keeps programs.** Every half minute it asks the host how
  its sandboxes are: an idle one still in memory is put to sleep with
  its programs and archived (an explicit sleep), and one whose copy is
  in the store is handed off with the new `keep_memory` flag, so the host
  saves its memory if it woke and paused again since the status was
  read. One held, awake, mid-step or with no trustworthy copy stays;
  nothing is forced, so no connection ends. A host from before
  `keep_memory` ignores it; the sleep before the hand-off still keeps
  programs there, short of a wake and a new pause between the two.
- **A draining host is given no sandbox it does not own already.** The
  store refuses to make it the owner of a new sandbox or of one another
  host held or nobody held (`Write::OwnerLost`), under the same row lock
  that orders writes with a give-up, so the caller places the sandbox
  elsewhere. A move checks its target is live, then hands off for up to
  five minutes before it adopts: without this, a sandbox could land on a
  host the leader was about to delete, and go back to its last stored
  copy.
- **It removes the instance once the host owns nothing and has drained
  for a quarter of an hour since its first drain pass that held** (a
  pass that failed in the store does not start it), longer than a
  create, adopt or move placed on it before its drain landed takes to
  land, checked again right before, through the group's
  `deleteInstances`, which leaves the group one smaller. That needs only
  what resizing needs. A last pass that finds the host no longer the
  leader's drain fails, and nothing is removed.
- **It takes the host back** (undrains it) as soon as the group would
  grow, or when its sandboxes have not all left within
  `--scale-drain-within-s` (six hours), once no drain pass of it runs,
  asking again until the undrain holds; one taken back as too slow is
  not drained again for as long, so the sandboxes placed on it meanwhile
  are not moved over and over. Once its deletion was asked for it is
  never taken back. A leadership that ends stops its drain or removal.
- **The store notes the leader's drain.** `compute_hosts.drained_by`
  (`leader`) and `drained_at` (schema version 12: two nullable columns,
  ignored by earlier builds, so replicas of both run side by side) say
  who drained a host and when. A leader after the one that drained it
  (any deploy of the control service mid-drain) goes on with it as its
  own, its six hours counted from `drained_at`; its quiet quarter-hour
  counts from its own first pass. An operator's drain or undrain of the
  host clears the note and makes it theirs. During a rollout an earlier
  build's undrain leaves the note, but it counts only while the host
  drains.
- **A host someone else drains is theirs.** The leader never removes
  it unless `--scale-adopt-drained-after-s` is set (0, the default, is
  off); then it drains and removes it after that long, only while the
  group keeps `--scale-min` live hosts, and never takes it back.
- **It is watched.** `compute_fleet_shrink_outgoing{host}`,
  `_draining_seconds`, `_sandboxes_left`, `_removals_total{outcome}`,
  `_taken_back_total{reason}`, `_skipped_hosts` and `_held_back`.
  Suggested alerts: `increase(compute_fleet_shrink_removals_total{outcome="failed"}[1h]) >= 3`
  (deleteInstances keeps failing), `compute_fleet_shrink_skipped_hosts > 0`
  for 1h (a host whose sandboxes would not leave), and
  `compute_fleet_shrink_held_back == 1` for 1d (a host of an earlier
  release holds shrinking back).

## Consequences

- The group follows its load down as well as up, and a host's worth of
  spare is the most it keeps idle beyond its target for long.
- A sandbox moved this way wakes on another host with its programs, from
  its memory image in the store: slower than a resume from RAM, about as
  fast as the wake of any sandbox its host saved.
- Memory images of moved sandboxes cost the store until the existing
  rule forgets them, up to 30 days after their last use.
- A host whose sandboxes stay in use stays: a desktop kept open for
  six hours costs a drain that is taken back.
- An operator who drains a host for maintenance keeps it: the leader
  removes it only when told to adopt such hosts.
