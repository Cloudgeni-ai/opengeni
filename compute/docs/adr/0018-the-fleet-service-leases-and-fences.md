# 18. The fleet: one service, leases in Postgres, fences on every write

Status: Accepted, 2026-10-17. Implements [15](0015-placement-and-moves-between-hosts.md).

## Context

[ADR 15](0015-placement-and-moves-between-hosts.md) sets the shape: a
central store, ownership as a fenced lease, moves while a sandbox sleeps,
and no slow work in a request's path. This record fixes the parts, so they
can be built and tested.

## Decision

- **Two crates.** `compute-fleet` is pure, like `compute-core`: placement,
  host leases, sandbox ownership, recovery and moves, as inputs in and
  actions out, with a seeded simulation of the whole protocol and a budget
  test at 5,000 hosts.
  `compute-control` is the service around it: the store, the host API, the
  public API and the proxy to hosts.
- **Postgres is the store.** One database holds hosts (address, zone,
  memory profile, CPU template, lease epoch and state), sandboxes (owner
  key, config, metadata, owner host, owner epoch, latest archive) and API
  keys. Every change is an update conditional on an epoch, so a stale
  writer changes nothing. Postgres gives conditional writes, transactions
  and listing by metadata, and is managed on every cloud. The service keeps
  no state of its own: replicas run behind a load balancer and any of them
  serves any request.
- **Hosts renew their lease through the service.** An agent started with a
  host id and a control address registers, which gives it a host epoch,
  then renews every third of the lease time T (10 s) with its capacity:
  free memory and disk, ready clones per shape, awake sandboxes. A
  renewal is one row update, and capacity changes are sent at most once a
  second. Replicas read changed host rows every 250 ms into a view in
  memory; placement reads only that view. The host numbers its renewals
  under each registration and keeps its lease (epoch, deadline, last
  number) in a file in `/run`, written before each renewal is sent, so a
  restarted agent goes on from it.
- **The service gives up on a host by one clock only.** One replica at a
  time, holding a Postgres advisory lock, watches the hosts' renewal
  counts on its own monotonic clock, and a host is lost once its count has
  not moved for T plus a margin (5 s). Marking it lost is conditional on
  the count it watched (`… where renewals = $seen and state = 'live'`), so
  a renewal accepted meanwhile saves it. A new leader starts with nothing
  seen and so waits a whole T plus margin. No two clocks are compared;
  each needs only to run at a rate within a stated bound of true time
  (below).
- **A cut-off host stops its VMs, with or without its agent.** The host's
  deadline is the boot-clock time it sent its last accepted renewal, plus
  T; a failed or unanswered renewal never extends it. A guard process, one
  per host, steps every 100 ms on that clock, and decides each step from
  the time, the deadline and what the kernel reports alone, never from
  what an earlier step asked for: from a second before the deadline it
  asks for the cgroup that holds every VM to freeze until `cgroup.events`
  reports `frozen 1`; from the deadline, until the VMs are frozen or gone
  (`populated 0`), it writes `cgroup.kill` on every step; while the
  deadline is further off it thaws a freeze it finds. So a guard that
  restarts after one that froze the VMs and died thaws them once the
  lease is renewed, and goes on freezing if it is not. The guard also
  holds the kernel watchdog (`softdog` with `nowayout`, W = 3 s), and feeds
  it only while the deadline is ahead or the VMs are confirmed frozen or
  gone. So if the guard stalls or dies, or a freeze and a kill both hang,
  the machine reboots W after the last feed, and stops within S (1 s) of
  that. The guard is the agent's own program, in a cgroup of its own
  beside the VMs' (not inside it, or it would freeze itself, and not in
  the agent's, so it outlives the agent as the VMs do,
  [9](0009-vms-outlive-the-agent.md)); a restarted agent finds it by its
  lock and starts one only if none runs. A host without a control address
  has no deadline and never freezes.
- **One safety budget, checked when the terms are set.** With every clock
  within ρ of true time (1 %, a hundred times what NTP-disciplined or
  even free-running server clocks drift), the latest true time after a
  renewal's send that a VM can still run is (T + W) / (1 − ρ) + S, and the
  earliest the leader gives up is (T + M) / (1 + ρ). The terms are valid
  only if the second is later: `LeaseTerms::validate` refuses any margin
  below the least that makes it so (4.27 s for T = 10 s; the margin is
  5 s), any ρ of 10 % or more, a watchdog that is not whole seconds, and
  fewer than two renewals per term. The guarantee rests on stated
  assumptions: the kernel's timers run (a kernel hung hard enough to stop
  them runs no VMs either), and the machine does not sleep without the
  guard knowing. The watchdog counts on a clock that stops in a suspend
  and the lease on one that does not, so a host resumed after its
  deadline would run its VMs until the guard's next step. Hosts therefore
  hold a block-mode systemd sleep inhibitor and mask the sleep targets,
  and a system-sleep hook, if a suspend happens anyway, marks it under way
  (the guard then treats the lease as run out and freezes) and waits for
  the VMs to freeze before the machine sleeps; it lifts the mark after the
  resume, and the guard thaws them only if the lease is still valid then.
  A hypervisor that pauses the whole host VM without the guest knowing
  exposes at most one guard step, and every write the VMs' host then makes
  to object storage is still fenced. For hosts in a cloud host group, the
  leader may also stop a lost host's instance through the cloud's API
  before it hands its sandboxes on; that is an extra, not what safety
  rests on.
- **A host that comes back is fenced until it has caught up.** It
  registers again only once its last registration lapsed (the store
  refuses while that one is live, since its VMs may still run), and lists
  what it still has. The answer says, for each sandbox, to keep it, get it
  back, fetch it again from its archive, or drop it (`reconcile`: only a
  copy nobody took since it last ran is the newest). The host drops and
  confirms gone everything the answer does not keep, records the new
  owner epochs of the rest, and only then writes the new deadline that
  lets them run again; anything it does not know about stays stopped.
  A registration is one attempt with its own number (no earlier run of the
  agent used it; each run numbers on from a random start): the host sends
  the same request again until it is answered, and the service stores its
  answer and gives it to every copy of that attempt, so slow answers never
  make the host start over (which, while the service refuses a second
  registration, could go on for ever). Only the answer to the host's
  current attempt counts, and what an attempt lists may only shrink while
  it is under way.
  Renewal answers name the registration they renew and change nothing for
  another.
- **Writes to object storage are fenced too.** Each sandbox has an owner
  epoch, raised whenever it changes hands. The host learns it with the
  sandbox and keeps it in the sandbox's record. Every archive pointer
  carries a stamp: the owner epoch of the host that wrote it and a number
  for the change. A pointer is replaced only on condition that it has not
  changed since it was read
  ([7](0007-never-delete-the-only-good-copy.md)), and every change decides
  from the stamp on that very version, at every attempt and retry, by one
  rule (`compute_fleet::fence`):
  - a pointer under a later epoch supersedes every change: the host drops
    its copy;
  - an archive or a memory forget takes a number of its own, recorded in
    the sandbox's record before the store sees it, so even a try cut short
    by a crash never reuses one. Finding its own number there, it is done
    (a try whose answer was lost); finding a later one, it is moot; a
    forget that finds no pointer has nothing to do;
  - a claim (below) keeps the save number under the new epoch, and the new
    owner counts on from it; claiming nothing stores an empty pointer, so
    a former owner is fenced even before the first archive;
  - a delete leaves a tombstone, which is final: a later archive or forget
    learns the sandbox was deleted, never that it is done, nothing is
    written over it, and a sweep removes it after the sweep window.

  A new owner's first act is to claim the pointer: it stores it again,
  unchanged but under its epoch, so an archive a former owner began
  earlier fails its condition, reads the pointer again, finds the newer
  epoch and stops, and that host drops its local copy. Within one owner an
  older change never replaces a newer one, so overlapping archives are
  harmless, and an archive the agent tries again after a forget can never
  count as done without its memory. The agent starts no archive once its
  deadline has passed. Hosts never delete chunks or manifests (only a
  sweep does), so a former owner cannot take what the new one is waking
  from.
- **Requests are bounded in time.** Every request to a host carries the
  host epoch, the owner epoch, and a stamp: the highest renewal number the
  store had accepted from that host. A host refuses a request under
  another registration (`unavailable`), more than two renewals old (about
  seven seconds; `expired`), or for an older owner epoch than the one it
  holds (`stale`).
  Every answer carries when it was given: the host's registration and its
  latest renewal number. An answer that the host holds nothing of a
  sandbox is final only once it shows that no create or adopt sent earlier
  can still land (a request stamped more than two renewals before it is
  refused if it arrives later), and that it was given after the last
  create or adopt the host confirmed for that owner epoch: under a later
  registration, or after a later renewal. A release that overtakes a
  create can otherwise answer "not found" before the create's "done" and
  arrive after it. Until both hold the service waits and asks again. The
  service sends each create or adopt once per owner epoch; a retry is a
  new epoch.
- **The host API gains `adopt` and `release`.** `adopt` claims the
  sandbox's pointer under the owner epoch the service names and creates a
  record at Remote from what it names, so the next wake fetches it lazily.
  `release` hands a sleeping sandbox off in steps the record keeps, so a
  restarted agent finishes them: it marks it draining (from then wakes are
  refused as busy), archives its latest state, verifies the archive, ends
  the VM and confirms it gone, then forgets the sandbox and answers. The
  host API also listens on TCP with mutual TLS for the service; the Unix
  socket stays for local tools.
- **Requests.** A create is placed (two random hosts that fit, preferring
  one with a ready clone of the shape, then the most free memory, spread
  over zones) and recorded with owner epoch 1 while the host creates it.
  An adopt prefers a host whose memory profile and CPU template match the
  archived memory image, ahead of ready clones and free memory, since
  anywhere else the sandbox boots afresh and loses its programs. A
  host that refuses it (`host_full`, `unavailable`, `expired`) holds
  nothing of it, so the service gives it to the next candidate under a new
  epoch. A wake or connect goes straight to the owner, found in the
  replica's cache. If the owner answers, finally, that it does not have
  it, because a release finished before the service heard, or its copy is
  behind the archive, the service gives it to the same host again under a
  new epoch and adopts it there from the archive; a late answer about the
  old epoch then changes nothing. A sandbox with no owner, because its
  host was lost or it was released, is placed like a create and adopted.
- **Recovery.** When the leader marks a host lost (so a late renewal fails
  and the host must register again), it raises the owner epoch of each of
  its sandboxes and clears their owner. Each comes back on its next wake,
  from its latest archive, on another host. A sandbox never archived is
  lost with its host, so the service asks for an early archive of every
  new sandbox. A lost host that comes back gets back each sandbox nobody
  adopted since, with its local state, which is at least as new as the
  archive, and drops the rest.
- **Moves while asleep.** To drain or rebalance a host, the service sends
  `release` for its sleeping sandboxes and clears their owner with a raised
  epoch once the host answers; the next wake adopts each elsewhere. Live
  migration stays out of scope.
- **Autoscaling.** The leader compares the fleet's spare memory (free
  above each host's buffer, per memory profile) with a target, the larger
  of a fraction of the fleet and room for a few of the largest shapes, and
  sets the host group's size through the cloud's scale-set API (Azure
  virtual machine scale sets, Google managed instance groups). It scales
  in by draining a host before deleting it.
- **Checked by simulation.** `compute-fleet`'s seeded simulation runs the
  whole protocol with the crate's own decisions: hosts with boot clocks
  drifting as far as the terms allow, partitions, lost and late messages
  (up to 27 s), stalled agents and guards, agent and guard restarts,
  suspends, power losses (some for good), stuck freezes and kills,
  watchdog reboots and leader failovers. The watchdog counts on the
  host's clock and stops in a suspend, as `softdog` does. It checks that a
  sandbox never runs on two hosts or under an older epoch, that a host
  given up on stopped its VMs before, that a pointer's stamp never goes
  back, that a release loses no write, and that at the end every sandbox
  runs on its owner, except those whose only copy was on a host that died
  before their first archive. Each rule above that is not obvious was
  found missing by it: refusing a second registration while the first may
  still run, answering only the latest registration, stamping requests,
  giving a not-found sandbox a new epoch, save numbers in stamps, and
  ordering a not-found answer after the create it might have overtaken.
- **Budget.** A wake through the service adds a cache lookup and one proxy
  hop. A create adds placement and one row insert, done while the host
  works. Every decision placement, renewals, recovery and registration
  need stays well under a millisecond at 5,000 hosts and 500,000
  sandboxes; `compute-fleet`'s budget test checks it, with the numbers in
  [measurements](../measurements.md).

## Consequences

- A service and a database to run. A host without them works as before.
- A host cut off for longer than T has its VMs frozen; their programs are
  lost once their sandboxes are handed elsewhere. One whose guard cannot
  stop them reboots.
- Every host needs the `softdog` module (or a hardware watchdog) and
  cgroup v2 with `cgroup.kill` (Linux 5.14 or later).
- Losing a host costs what changed since each sandbox's last archive.
- Restoring memory on another host needs the same CPU template across a
  fleet; otherwise the sandbox boots fresh from its files.
- Open connections do not survive a move or a recovery.
