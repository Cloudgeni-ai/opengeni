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
  the host's and the leader's need only run at about the same rate (within
  margin / (T + margin), a third; the simulation runs them 0.5 % apart).
- **A cut-off host stops its VMs, with or without its agent.** The host's
  deadline is the boot-clock time it sent its last accepted renewal, plus
  T. A guard process, one per host, steps every 100 ms on that clock:
  a second before the deadline it freezes the cgroup that holds every VM
  and waits for `cgroup.events` to report `frozen 1`; if that has not
  happened by the deadline it writes `cgroup.kill` instead and waits for
  `populated 0`. A renewed lease thaws them. The guard also holds the
  kernel watchdog (`softdog` with `nowayout`, 3 s), and feeds it only
  while the lease is valid, or the VMs are confirmed frozen or gone, or
  there are none. So if the guard stalls or dies, or a freeze and a kill
  both hang, the machine reboots within 3 s of the deadline, inside the
  5 s margin. The guard is the agent's own program, in a cgroup of its own
  beside the VMs' (not inside it, or it would freeze itself, and not in
  the agent's, so it outlives the agent as the VMs do,
  [9](0009-vms-outlive-the-agent.md)); a restarted agent finds it by its
  lock and starts one only if none runs. The guarantee assumes what the
  watchdog needs: a kernel whose timers run. A kernel hung hard enough to
  stop them runs no VMs either. For hosts in a cloud host group, the leader
  may also stop a lost host's instance through the cloud's API before it
  hands its sandboxes on; that is an extra, not what safety rests on. A
  host without a control address has no deadline and never freezes.
- **A host that comes back is fenced until it has caught up.** It
  registers again only once its last registration lapsed (the store
  refuses while that one is live, since its VMs may still run), and lists
  what it still has. The answer says, for each sandbox, to keep it, get it
  back, fetch it again from its archive, or drop it (`reconcile`: only a
  copy nobody took since it last ran is the newest). The host drops and
  confirms gone everything the answer does not keep, records the new
  owner epochs of the rest, and only then writes the new deadline that
  lets them run again; anything it does not know about stays stopped.
  Only the answer to the registration it sent last counts: an earlier one
  listed what it had then. Renewal answers name the registration they
  renew and change nothing for another.
- **Writes to object storage are fenced too.** Each sandbox has an owner
  epoch, raised whenever it changes hands. The host learns it with the
  sandbox and keeps it in the sandbox's record. Every archive pointer
  carries a stamp: the owner epoch of the host that wrote it and that
  host's number for the save. A pointer is replaced only on condition that
  it has not changed since it was read
  ([7](0007-never-delete-the-only-good-copy.md)), and only by a later
  stamp, checked on the very version the write is conditional on, at every
  attempt and retry: a publish, a claim, forgetting a memory image, a
  delete (which leaves a tombstone with the stamp; a tombstone is final,
  so no owner archives over it, and a sweep removes it after the sweep
  window). A new owner's first
  act is to claim the pointer: it stores it again, unchanged but under its
  epoch, so an archive a former owner began earlier fails its condition,
  reads the pointer again, finds the newer epoch and stops, and the host
  drops its local copy. Within one owner an older save never replaces a
  newer one, so overlapping archives are harmless, and one that finds its
  own save already there counts as done. The agent starts no archive once
  its deadline has passed. Hosts never delete chunks or manifests (only a
  sweep does), so a former owner cannot take what the new one is waking
  from.
- **Requests are bounded in time.** Every request to a host carries the
  host epoch, the owner epoch, and a stamp: the highest renewal number the
  store had accepted from that host. A host refuses a request under
  another registration (`unavailable`), more than two renewals old (about
  seven seconds; `expired`), or for an older owner epoch than the one it
  holds (`stale`).
  An answer that the host holds nothing of a sandbox is final only once it
  also shows that no create or adopt sent earlier can still land: the
  answer carries the host's renewal number, and a request stamped more
  than two renewals before it is refused if it arrives later. Until then
  the service waits and asks again. The service sends each create or adopt
  once per owner epoch; a retry is a new epoch.
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
  over zones) and recorded with owner epoch 1 while the host creates it; a
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
  whole protocol with the crate's own decisions: hosts with drifting boot
  clocks, partitions, lost and late messages (up to 27 s), stalled agents
  and guards, agent restarts, power losses (some for good), stuck freezes
  and kills, watchdog reboots and leader failovers. It checks that a
  sandbox never runs on two hosts or under an older epoch, that a host
  given up on stopped its VMs before, that a pointer's stamp never goes
  back, that a release loses no write, and that at the end every sandbox
  runs on its owner, except those whose only copy was on a host that died
  before their first archive. Each rule above that is not obvious was
  found missing by it: refusing a second registration while the first may
  still run, answering only the latest registration, stamping requests,
  giving a not-found sandbox a new epoch, and save numbers in stamps.
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
