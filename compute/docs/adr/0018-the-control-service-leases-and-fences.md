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
  a renewal accepted meanwhile saves it. The leader times a count from
  when the read that showed it returned, never from when it was sent, so
  a slow read cannot make a renewal look older than it is. A new leader
  starts with nothing seen and so waits a whole T plus margin. No two
  clocks are compared;
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
  that. The guard is the agent's own program run as a service of its own
  (`compute-host guard`), in a cgroup beside the VMs' (not inside it, or
  it would freeze itself, and not in the agent's, so it outlives the agent
  as the VMs do, [9](0009-vms-outlive-the-agent.md)). It holds a lock
  while it runs, and an agent refuses to join a fleet unless it finds the
  lock held. A host without a control address has no deadline and never
  freezes.
- **While its lease has run out the agent decides nothing.** It takes no
  decision of its own (no sampling, no idle sleep, no eviction, no ready
  clones), its store starts no archive, and the host's own tools get its
  status only. It still carries out a registering host's rulings: dropping
  a copy, deleting, and stopping a VM need no lease.
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
  A hypervisor that pauses the whole host VM without the guest knowing is
  outside the guarantee: once it resumes, the old VMs can run before the
  guard is scheduled, while another host already has their sandboxes.
  Their writes to object storage are still fenced, but what they run and
  send over the network is not. Cloud live migration pauses a VM for well
  under a second, far inside the margin, so only an abnormally long pause
  matters. For hosts in a cloud host group the leader excludes even that:
  before it gives up on a lapsed host it fences the instance through the
  cloud's API and waits for the cloud to confirm it. A running instance is
  reset, a hard power cycle with no guest shutdown, so its VMs are gone
  the moment the reset is done, while its local disk, and the sandboxes
  on it that were never archived, stay for the host to offer back when it
  registers again. One already stopped or deleted needs nothing; one being
  created, started or resumed is waited for and reset once it runs (a
  resuming instance passes through the same states as a starting one,
  with its memory kept, so neither is taken as fenced); a suspended one is
  stopped. A
  fence the cloud does not confirm in two minutes, or that fails, keeps
  the host live and is tried again five seconds later, so nothing is
  handed on from a host whose VMs might still run. Once given up on, a
  stopped instance is started again, and the scaling step starts any
  stopped member whose host is lost or never registered, so the group
  keeps its size. A member the group is itself acting on (recreating it,
  as its autohealing does, or deleting or starting it) is left to the
  group, an instance already deleted is nothing to start, and one that
  fails to start is tried at the next look without holding up the rest
  of the step. A member without a registered host counts as booting for
  a boot allowance (ten minutes by default); one past it keeps its place
  but no longer stands in for capacity, so the group grows around a
  member the cloud never gets running. Each place in the group's size
  counts once, from one look at the group and one read of the hosts: a
  member brings its host, live or draining; a host the listing does not
  name takes one of the places asked for and not listed, and brings
  nothing once none is left (the group has let it go); a member the
  group is removing holds none; growth adds the usable hosts it is short on top
  of the places draining and stalled hosts hold; and no shrink is
  suggested while a member is stalled. Only zonal groups are supported,
  since a fence must name the instance's zone. Hosts outside a group rely
  on their deadline, guard and watchdog alone.
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
    (a try whose answer was lost); finding a later one, it is moot. A
    forget always stores its number: over a copy it stores the copy
    without memory, even when there was none to drop; over no pointer, or
    only an archive's empty start, it stores an empty pointer. So an
    archive begun before it, even one whose first write is still in
    flight, cannot land after it;
  - a claim (below) keeps the save number under the new epoch, and the new
    owner counts on from it; claiming nothing stores an empty pointer, so
    a former owner is fenced even before the first archive;
  - a delete leaves a tombstone, which is final and stays for good: a
    later archive or forget learns the sandbox was deleted, never that it
    is done, and nothing is written over it. Only the tombstone tells a
    first archive whose write was held up in flight, however long, that
    the sandbox is gone; with it removed that write would find an empty
    place and start a copy of a deleted sandbox. A tombstone is a few
    hundred bytes, so a million of them cost well under a cent a month.

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
  Every answer carries when it was given: the host's registration and the
  number of the last renewal it sent, which it stored before sending, so
  the number never goes back and is at least the last the service
  accepted. An answer that the host holds nothing of a
  sandbox is final only once it shows that no create or adopt sent earlier
  can still land (a request stamped more than two renewals before it is
  refused if it arrives later), and that it was given after the last
  create or adopt the host confirmed for that owner epoch: under a later
  registration, or after a later renewal. A hand-off that overtakes a
  create can otherwise answer "not found" before the create's "done" and
  arrive after it. Until both hold the service waits and asks again. The
  service sends each create or adopt once per owner epoch; a retry is a
  new epoch.
- **The host API gains `adopt` and `hand_off`.** `adopt` claims the
  sandbox's pointer under the owner epoch the service names and creates a
  record at Remote from what it names, so the next wake fetches it lazily.
  `hand_off` hands a sleeping sandbox off: the agent marks it draining
  (from then wakes are refused as busy), archives its latest state, ends
  the VM and confirms it gone, then forgets the sandbox, keeping the
  store's copy, and answers. Only the last step is recorded, so a
  restarted agent finishes a hand-off that reached it; one cut short
  before leaves the sandbox on the host, and the service, which had no
  answer and cleared no owner, sends it again. Every request about a
  sandbox names its owner epoch, which the agent checks against the
  record before it acts: an earlier one is refused as stale, a later one
  the host never held as not found, and a create or adopt under a later
  epoch first drops the copy held under the earlier one. The host API
  also listens on TCP with mutual TLS for the service, both sides trusting
  only the hosts' authority, which the service is: it issues hosts their
  certificates and itself its own (operations.md, Keys and certificates);
  the Unix socket stays for local tools, which
  on a host in a fleet never create, adopt, hand off or remove sandboxes.
  A host with sandboxes it cannot read (blocked) does not register until
  they are readable or removed, since it cannot rule on them.
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
  it, because a hand-off finished before the service heard, or its copy is
  behind the archive, the service gives it to the same host again under a
  new epoch and adopts it there from the archive; a late answer about the
  old epoch then changes nothing. A sandbox with no owner, because its
  host was lost or it was released, is placed like a create and adopted.
  A row is never written naming an owner the leader gave up on: the
  write checks the owner host's state in the same statement, under a
  share lock on its row, so it is refused (`owner lost`) if the leader
  marked the host lost after the view placed on it, and the service
  places the sandbox again elsewhere.
- **Recovery.** When the leader marks a host lost (so a late renewal fails
  and the host must register again), it raises the owner epoch of each of
  its sandboxes and clears their owner. Each comes back on its next wake,
  from its latest
  archive, on another host. A sandbox never archived is lost with its
  host; checkpoints, below, keep that window short. A lost host that
  comes back gets back each sandbox nobody adopted since, with its local
  state, which is at least as new as the archive, and drops the rest.
- **A lost owner's copy comes back from its files.** A host that releases
  a sandbox hands its latest state off first, so its archive is the
  sandbox as it was. A lost host hands nothing off: the archive is the
  last copy it made, and the sandbox may have run on past it, its
  programs answering requests and telling others what they did. A guest
  restored from that copy's memory would run that stretch again, with
  the same identity and connections, as if it had not happened (an
  agent that deduplicates requests in memory would take a request it
  already carried out for a new one). So the adopt that follows a loss
  does not say `whole`: a host restores a copy's memory only when the
  adopt (or a refetch verdict) says the copy is whole, and otherwise
  deletes the memory image from the store's copy as it claims it, under
  the claim's next save, and the next wake boots the copy's disk, as
  after a crash. Programs end; files are as the copy left them; a new
  guest agent starts and connects afresh. Vouching rather than warning
  keeps a service from before the field safe on new hosts: its adopts
  never say `whole`, so they always boot from files.

  The row says which copy it may restore whole: `whole_epoch`, the owner
  epoch under which the store's copy is the sandbox's whole latest state.
  An adopt or refetch says `whole` only under that very epoch. A create
  sets it to the first epoch
  and a hand-off to the epoch it leaves. A change whose owner held
  nothing of the sandbox carries it on to the change's new epoch: a give
  (to a host that adopts it, or to another after one refused it outright)
  and clearing an owner that answered it holds nothing. Every other change
  raises the epoch past it: a give-up, a reclaim, and any change by a
  replica from before the column, which writes epochs but not the mark.
  So a stale copy can never count as whole, while needless boots from
  files are confined to rare paths: a hand-off whose answer was lost, of
  a sandbox whose copy was not whole when it was given, and rows from
  before the column, which start with no mark. The mark cannot
  be a "lost" flag that a give-up sets, because a replica of the earlier
  release, still serving during a rolling upgrade or after a rollback,
  gives up on hosts without setting it; nor can a clear vouch for a copy
  unless the owner proved it handed the state off, because an owner that
  held nothing may itself have been given a lost owner's copy. The fleet
  simulation checks the rule: every adopt that restores memory finds the
  archive holding every write of the sandbox's latest run.

  An earlier host ignores `whole` and always restores the memory image,
  so every host must run this release before the service does
  (operations.md, Upgrades); a replica of the earlier service still
  serving during the rollout, or after a rollback, then only ever has
  copies booted from their files. Before the host pauses a guest to
  save or checkpoint it, it asks the guest to write what it holds for
  its disks to them (`sync` on the notice port), so a disk copied while
  its guest ran holds what the guest had written. A sandbox asleep in
  object storage when its host was lost had not run past its copy, but
  nothing durable says so, and it boots from its files too: telling
  the two apart would take a mark in the stored copy that every eviction
  sets and every wake from it clears before the guest runs, one more
  store write on each.
- **Checkpoints.** A sandbox whose sleep rules set `checkpoint_every_ms`
  is copied to object storage while it runs, so losing its host costs
  only what its files took on since, and its running programs (see the
  previous item). The fleet sets it to 10 minutes for every
  sandbox whose create names no sleep rules. Protection starts once a
  copy is in the store, not when it was captured, and the period counts
  running time from the later of when its newest copy got there and its
  last wake, so a sandbox that sleeps and is archived anyway takes none.
  The period is a scheduling target, not a bound on what a lost host
  costs. A checkpoint is due once the sandbox has run for the period, and
  one with no copy yet is due after a minute of running; it protects only
  once it is published, and on its way it may wait for disk admission and
  the step limit, for a lazily woken VM to settle, and for its capture,
  merge and upload, and fail and be tried again later. None of those
  waits has a bound. Losing its host costs a sandbox everything since
  the capture of its newest published copy, so that capture's age is its
  recovery point: the sandbox's status reports it as `backed_up_ms`, and
  that, not the period, is what to watch and alert on.
  One created and never run is archived at once, so it survives
  its host from then on; a wake meanwhile comes first and cancels that
  archive, and the sandbox is then protected only once its first
  checkpoint is in the store.
  - *A coherent bundle.* The step settles a lazily woken VM first (its
    image whole, its pager holding all of it), then pauses the VM, has
    its VMM write the pages changed since its last snapshot, and clones
    the disk sharing every extent once the snapshot has made it durable.
    The VM then runs again while those pages are merged over its last
    image into a new self-contained one, and the bundle, which nothing
    changes any more, is uploaded as the owner's next save under the
    same owner stamp and fences as an archive. The guest stands still
    only from the pause to the resume (`compute.paused_us`): the merge
    and the upload run while it works. A resume the VMM refuses having
    changed nothing is tried again for as long as the VM lives,
    cancelled or not, with an error logged once it has failed for
    30 seconds; giving up would end a VM that may yet run. Only a VM
    whose resume may have changed something, or that ends while paused,
    ends the step that way, and the sandbox goes back to its last saved
    copy.
  - *Admitted for its disk.* While the clone shares the disk's blocks,
    any guest write may take a new one, so a running checkpoint books
    the disk's whole growth bound. A checkpoint starts only when the
    host's disk can book that on top of everything else; one that
    cannot waits, without holding up others, while the host makes room
    as it does for a refused wake, by evicting idle copies already in
    object storage.
  - *Still volatile.* The record goes on vouching for no local copy, since
    the VM moves on: the sandbox stays `Running` and `Volatile`. Only its
    `backed_up_ms` moves, to when the bundle was captured, and only once
    the store holds it; protection starts at publication, not when the
    step began.
  - *The base moves even if the upload fails.* The new image becomes the
    VM's base as soon as it is made, so its next save is a diff over it
    whether or not this upload succeeded; a failed upload is retried
    after the usual backoff from a fresh bundle, never from the old one.
    From the snapshot until the image is made the VM's base is unknown,
    so a merge that fails makes its next save a full one.
  - *Ordered by the step.* The step runs in the sandbox's single step
    slot and reserves its save number there, so no later save,
    retirement or forgetting can touch the bundle while it uploads, and a
    save captured after it always carries a higher number.
  - *Use goes on, memory pressure wins.* A request during a checkpoint
    neither waits for it nor cancels it: the guest is paused only while
    its state is captured. The guest's own work counts as use from the
    resume on: the step reads the VM's processor time and traffic for the
    host agent, which cannot while the step holds the VM, so a guest busy
    through a long upload is not taken for idle when it ends, and the
    capture's own work never counts. A host that needs the memory cancels
    it, as it cancels an archive, and the sandbox is checkpointed again
    once it runs.
  - *Fenced like an archive.* A checkpoint that finds a later owner in the
    store is refused and drops this host's copy, ending its VM.
  - *Only where extents are shared.* The disk clone needs a state root on
    a filesystem whose files share extents (XFS, btrfs). A host on any
    other says so in its status (`about.checkpoints` false) and takes
    none; a host without a store refuses a sandbox that asks for them, as
    it refuses an archive. The sleep ladder is unchanged: an idle sandbox
    pauses, saves and archives as before, and checkpoints never skip it.
- **Moves while asleep.** To drain or rebalance a host, the service sends
  `hand_off` for its sleeping sandboxes and clears their owner with a raised
  epoch once the host answers; the next wake adopts each elsewhere. Live
  migration stays out of scope.
- **Autoscaling.** The leader compares the fleet's spare memory (free
  above each host's buffer, per memory profile) with a target, the larger
  of a fraction of the fleet and room for a few of the largest shapes, and
  keeps rooms for those shapes counted host by host, since one lands
  whole on one host; it sets the host group's size through the cloud's
  scale-set API (Azure
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
  back, that a hand-off loses no write, and that at the end every sandbox
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
