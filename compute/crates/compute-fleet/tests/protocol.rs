//! A seeded simulation of the whole fleet protocol.
//!
//! Hosts with drifting clocks renew leases with a store, run sandboxes,
//! archive them to a pointer store with conditional writes, and suffer
//! partitions, lost and late messages, agent restarts and power losses,
//! some for good. A service creates, wakes, moves and recovers sandboxes
//! with the crate's own decisions. Throughout, the simulation checks:
//!
//! - a sandbox never runs on two hosts: each run happens at an owner epoch
//!   no lower than any run before it, and a different host runs it only
//!   at a higher one;
//! - a host given up on stopped its VMs at least most of the margin before
//!   its sandboxes could go elsewhere;
//! - an archive pointer's stamp never goes back, so a former owner never
//!   publishes over a new one and an older save never over a newer one;
//! - a move loses nothing: the archive holds every write when the host
//!   releases the sandbox.
//!
//! At the end faults stop and every sandbox is woken: each must run on its
//! owner under the store's epoch, except those whose host died for good
//! before their first archive.
//!
//! `FLEET_SIM_SEEDS` sets how many seeds run (default 6) and
//! `FLEET_SIM_FIRST_SEED` the first.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap};
use std::time::Duration;

use compute_fleet::{
    At, Capacity, ClassId, Demand, Expiry, Fence, Fleet, Guard, GuardAction, HostEpoch, HostId,
    HostInfo, HostLease, HostState, LeaseRecord, LeaseTerms, Listed, Observed, OwnerEpoch,
    Ownership, Renewal, Rng, SandboxId, Stamp, Verdict, ZoneId, fence, reconcile,
};

const TERMS: LeaseTerms = LeaseTerms::RECOMMENDED;
const TICK_NS: u64 = 100_000_000;
const MS: u64 = 1_000_000;
const SEC: u64 = 1_000 * MS;
const HOST_MEMORY_MIB: u64 = 256 * 1024;
const SANDBOX_MIB: u64 = 1024;
/// The kernel watchdog's timeout: a host whose guard stops feeding it
/// reboots this long after the last feed.
const WATCHDOG_NS: u64 = 3 * SEC;
/// How long a host waits for an archive's answer before it starts another.
const ARCHIVE_GIVE_UP: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug)]
struct Params {
    hosts: usize,
    sandboxes: usize,
    seconds: u64,
    max_ppm: i64,
}

/// A host's boot clock: since the machine booted at true time `boot`, it
/// reads `offset + (true - boot) × (1 + ppm / 10⁶)`.
#[derive(Clone, Copy, Debug)]
struct Clock {
    boot: u64,
    offset: u64,
    ppm: i64,
}

impl Clock {
    fn read(self, true_ns: u64) -> At {
        let since = i128::from(true_ns - self.boot);
        let local = i128::from(self.offset) + since + since * i128::from(self.ppm) / 1_000_000;
        At::from_duration(Duration::from_nanos(u64::try_from(local).unwrap()))
    }

    /// True nanoseconds for `local` nanoseconds of this clock to pass.
    fn true_span(self, local: u64) -> u64 {
        u64::try_from(i128::from(local) * 1_000_000 / (1_000_000 + i128::from(self.ppm))).unwrap()
    }
}

#[derive(Clone, Debug)]
struct Local {
    epoch: OwnerEpoch,
    content: u64,
    archived: u64,
    awake: bool,
    /// When, on the host's clock, the archive under way began.
    archiving: Option<At>,
    /// Being handed off: it takes no wakes, and goes once archived.
    releasing: bool,
}

/// What the kernel does with the VMs' cgroup.
#[derive(Clone, Copy, Debug, Default)]
struct Kernel {
    frozen: bool,
    /// When a freeze asked for completes; `u64::MAX` if it never does.
    freeze_at: Option<u64>,
    /// When a kill asked for completes; `u64::MAX` if it never does.
    kill_at: Option<u64>,
}

#[derive(Clone, Debug)]
struct Host {
    id: HostId,
    clock: Clock,
    machine_up: bool,
    dead: bool,
    agent_up: bool,
    /// Changes when the agent process restarts: answers sent to an
    /// earlier one are lost.
    incarnation: u64,
    cut_until: u64,
    lease: HostLease,
    /// The lease file in /run: what the guard and a restarted agent read.
    /// A reboot clears it.
    file: LeaseRecord,
    guard: Guard,
    kernel: Kernel,
    /// When the guard last fed the watchdog, in true time.
    fed: u64,
    /// The agent and the guard get no processor time until then; VMs do.
    stalled_until: u64,
    sandboxes: BTreeMap<SandboxId, Local>,
}

impl Host {
    fn now(&self, true_ns: u64) -> At {
        self.clock.read(true_ns)
    }

    /// Whether VMs run now: the machine is up and their cgroup not frozen.
    fn vms_run(&self) -> bool {
        self.machine_up && !self.kernel.frozen
    }

    fn awake(&self) -> u64 {
        self.sandboxes.values().filter(|local| local.awake).count() as u64
    }

    fn capacity(&self) -> Capacity {
        Capacity {
            memory_mib: HOST_MEMORY_MIB,
            free_memory_mib: HOST_MEMORY_MIB.saturating_sub(self.awake() * SANDBOX_MIB),
            free_disk_mib: 1_000_000,
            ready: Vec::new(),
            sandboxes: u32::try_from(self.sandboxes.len()).unwrap(),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct HostRow {
    epoch: HostEpoch,
    state: HostState,
    /// Accepted renewals across registrations: what the leader watches.
    renewals: u64,
    /// The highest renewal number accepted under this registration:
    /// what requests are stamped with.
    seq: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Pointer {
    version: u64,
    epoch: OwnerEpoch,
    content: u64,
}

impl Pointer {
    /// The save a pointer names is numbered by its content, which only
    /// rises along a sandbox's history.
    fn stamp(self) -> Stamp {
        Stamp {
            epoch: self.epoch,
            save: self.content,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Answer {
    Ok,
    Full,
    Unavailable,
    NotFound,
    Stale,
    NoArchive,
    Busy,
    /// The request reached the host after its window.
    Expired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Op {
    Create,
    Wake,
    Adopt,
    Release,
}

#[derive(Clone, Debug)]
enum Event {
    HostTick(usize),
    Register {
        host: usize,
        incarnation: u64,
        renewal: Renewal,
        listed: Vec<Listed>,
    },
    Renew {
        host: usize,
        renewal: Renewal,
        capacity: Capacity,
        incarnation: u64,
    },
    Registered {
        host: usize,
        incarnation: u64,
        renewal: Renewal,
        epoch: HostEpoch,
        verdicts: Vec<(SandboxId, Verdict)>,
    },
    Renewed {
        host: usize,
        incarnation: u64,
        renewal: Renewal,
        accepted: bool,
    },
    Request {
        host: usize,
        host_epoch: HostEpoch,
        /// The host's highest renewal the store had accepted when sent.
        stamp: u64,
        op: Op,
        id: SandboxId,
        epoch: OwnerEpoch,
        tries: u32,
    },
    Answered {
        host: usize,
        op: Op,
        id: SandboxId,
        epoch: OwnerEpoch,
        answer: Answer,
        /// The host's last renewal when it answered.
        seq: u64,
        tries: u32,
    },
    ArchiveReads {
        host: usize,
        incarnation: u64,
        id: SandboxId,
        epoch: OwnerEpoch,
        content: u64,
    },
    PublishLands {
        host: usize,
        incarnation: u64,
        id: SandboxId,
        version: u64,
        epoch: OwnerEpoch,
        content: u64,
    },
    Published {
        host: usize,
        incarnation: u64,
        id: SandboxId,
        epoch: OwnerEpoch,
        content: u64,
        landed: bool,
    },
    Recovery,
    Client,
    Fault,
    NewLeader,
    AgentStarts(usize),
    PowerOn(usize),
}

#[derive(Debug, Default)]
struct Stats {
    recoveries: u64,
    reclaims: u64,
    adopts: u64,
    moves: u64,
    fenced: u64,
    lost_writes: u64,
    superseded: u64,
    watchdog_reboots: u64,
    kills: u64,
    min_stop_gap_ns: Option<u64>,
}

#[derive(Debug, Default)]
struct Ghost {
    /// The latest run of each sandbox: host, epoch.
    last_run: BTreeMap<SandboxId, (HostId, OwnerEpoch)>,
    /// When each host last ran anything, in true time.
    host_last_run: BTreeMap<HostId, u64>,
    /// Each sandbox's writes in its latest run; an adopt starts again from
    /// what its archive holds.
    written: BTreeMap<SandboxId, u64>,
    /// The host each sandbox was created on, for one that never ran.
    created_on: BTreeMap<SandboxId, HostId>,
}

impl Ghost {
    /// Notes a run; the first run that breaks the invariant is described.
    fn ran(
        &mut self,
        id: SandboxId,
        host: HostId,
        epoch: OwnerEpoch,
        content: u64,
        now: u64,
    ) -> Result<bool, String> {
        let mut changed = true;
        if let Some(&(last_host, last_epoch)) = self.last_run.get(&id) {
            if epoch < last_epoch {
                return Err(format!(
                    "{id:?} ran on {host:?} at epoch {epoch} after {last_host:?} at {last_epoch}"
                ));
            }
            if last_host != host && epoch == last_epoch {
                return Err(format!(
                    "{id:?} ran on {host:?} and {last_host:?} at the same epoch {epoch}"
                ));
            }
            changed = (last_host, last_epoch) != (host, epoch);
        }
        self.last_run.insert(id, (host, epoch));
        self.host_last_run.insert(host, now);
        self.written.insert(id, content);
        Ok(changed)
    }
}

struct Sim {
    seed: u64,
    params: Params,
    now: u64,
    rng: Rng,
    seq: u64,
    queue: BinaryHeap<Reverse<(u64, u64)>>,
    events: BTreeMap<u64, Event>,
    hosts: Vec<Host>,
    host_rows: BTreeMap<HostId, HostRow>,
    rows: BTreeMap<SandboxId, Ownership>,
    objects: BTreeMap<SandboxId, Pointer>,
    fleet: Fleet,
    expiry: Expiry,
    next_host_epoch: u64,
    next_sandbox: u128,
    faults: bool,
    /// Sandboxes whose create the service saw succeed.
    confirmed: BTreeSet<SandboxId>,
    /// The create or adopt last sent for each sandbox and not answered
    /// yet: its epoch and stamp.
    requested: BTreeMap<SandboxId, (OwnerEpoch, u64)>,
    ghost: Ghost,
    stats: Stats,
    /// What happened to the sandbox `FLEET_SIM_TRACE` names, and to every
    /// host, printed when an invariant breaks.
    trace: Option<SandboxId>,
    log: Vec<String>,
}

/// True time in seconds, for the trace.
fn seconds(ns: u64) -> String {
    format!("{}.{:03}s", ns / SEC, ns % SEC / MS)
}

impl Sim {
    fn note(&mut self, id: SandboxId, what: &str) {
        if self.trace == Some(id) {
            self.log.push(format!("{:>14} {what}", seconds(self.now)));
        }
    }

    fn host_note(&mut self, index: usize, what: &str) {
        if self.trace.is_some() {
            let id = self.hosts[index].id;
            let local = self.hosts[index].now(self.now);
            self.log.push(format!(
                "{:>14} {id:?} (local {local:?}, deadline {:?}, lease {:?}) {what}",
                seconds(self.now),
                self.hosts[index].file.deadline,
                self.hosts[index].lease.epoch(),
            ));
        }
    }

    fn fail(&self, id: SandboxId, broken: &str) -> ! {
        if self.trace == Some(id) {
            for line in &self.log {
                eprintln!("{line}");
            }
        }
        panic!(
            "seed {}: {broken} (rerun with FLEET_SIM_FIRST_SEED={} FLEET_SIM_SEEDS=1 FLEET_SIM_TRACE={} to trace it)",
            self.seed, self.seed, id.0
        );
    }

    fn new(seed: u64, params: Params) -> Self {
        let mut rng = Rng::new(seed);
        let hosts = (0..params.hosts)
            .map(|index| {
                let span = u64::try_from(params.max_ppm * 2 + 1).unwrap();
                let ppm = i64::try_from(rng.below(span)).unwrap() - params.max_ppm;
                Host {
                    id: HostId(index as u64),
                    clock: Clock {
                        boot: 0,
                        offset: rng.below(1_000 * SEC),
                        ppm,
                    },
                    machine_up: true,
                    dead: false,
                    agent_up: true,
                    incarnation: 0,
                    cut_until: 0,
                    lease: HostLease::new(TERMS),
                    file: LeaseRecord::NONE,
                    guard: Guard::new(),
                    kernel: Kernel::default(),
                    fed: 0,
                    stalled_until: 0,
                    sandboxes: BTreeMap::new(),
                }
            })
            .collect();
        let mut sim = Self {
            seed,
            params,
            now: 0,
            rng,
            seq: 0,
            queue: BinaryHeap::new(),
            events: BTreeMap::new(),
            hosts,
            host_rows: BTreeMap::new(),
            rows: BTreeMap::new(),
            objects: BTreeMap::new(),
            fleet: Fleet::new(),
            expiry: Expiry::new(TERMS),
            next_host_epoch: 1,
            next_sandbox: 1,
            faults: true,
            confirmed: BTreeSet::new(),
            requested: BTreeMap::new(),
            ghost: Ghost::default(),
            stats: Stats::default(),
            trace: std::env::var("FLEET_SIM_TRACE")
                .ok()
                .map(|value| SandboxId(value.parse().unwrap())),
            log: Vec::new(),
        };
        for host in 0..params.hosts {
            let start = sim.rng.below(TICK_NS);
            sim.at(start, Event::HostTick(host));
        }
        sim.at(SEC, Event::Recovery);
        sim.at(2 * SEC, Event::Client);
        sim.at(5 * SEC, Event::Fault);
        sim
    }

    fn at(&mut self, when: u64, event: Event) {
        self.seq += 1;
        self.queue.push(Reverse((when, self.seq)));
        self.events.insert(self.seq, event);
    }

    /// Sends a message between `host` and the store or service: lost while
    /// the host is cut off, sometimes lost anyway, sometimes very late.
    fn send(&mut self, host: usize, event: Event) {
        if self.hosts[host].cut_until > self.now || self.rng.chance(1, 200) {
            return;
        }
        let delay = if self.faults && self.rng.chance(1, 300) {
            2 * SEC + self.rng.below(25 * SEC)
        } else {
            MS + self.rng.below(20 * MS)
        };
        self.at(self.now + delay, event);
    }

    fn run_until(&mut self, end: u64) {
        while let Some(&Reverse((when, seq))) = self.queue.peek() {
            if when > end {
                break;
            }
            self.queue.pop();
            self.now = when;
            let event = self.events.remove(&seq).unwrap();
            self.handle(event);
        }
        self.now = end;
    }

    fn handle(&mut self, event: Event) {
        match event {
            Event::HostTick(host) => self.host_tick(host),
            Event::Register {
                host,
                incarnation,
                renewal,
                listed,
            } => self.store_register(host, incarnation, renewal, &listed),
            Event::Renew {
                host,
                renewal,
                capacity,
                incarnation,
            } => self.store_renew(host, renewal, capacity, incarnation),
            Event::Registered {
                host,
                incarnation,
                renewal,
                epoch,
                verdicts,
            } => self.host_registered(host, incarnation, renewal, epoch, &verdicts),
            Event::Renewed {
                host,
                incarnation,
                renewal,
                accepted,
            } => self.host_renewed(host, incarnation, renewal, accepted),
            Event::Request {
                host,
                host_epoch,
                stamp,
                op,
                id,
                epoch,
                tries,
            } => self.host_request(host, Some((host_epoch, stamp)), op, id, epoch, tries),
            Event::Answered {
                host,
                op,
                id,
                epoch,
                answer,
                seq,
                tries,
            } => self.service_answer(host, op, id, epoch, answer, seq, tries),
            Event::ArchiveReads {
                host,
                incarnation,
                id,
                epoch,
                content,
            } => self.archive_reads(host, incarnation, id, epoch, content),
            Event::PublishLands {
                host,
                incarnation,
                id,
                version,
                epoch,
                content,
            } => self.publish_lands(host, incarnation, id, version, epoch, content),
            Event::Published {
                host,
                incarnation,
                id,
                epoch,
                content,
                landed,
            } => self.host_published(host, incarnation, id, epoch, content, landed),
            Event::Recovery => self.recovery(),
            Event::NewLeader => self.expiry = Expiry::new(TERMS),
            Event::Client => self.client(),
            Event::Fault => self.fault(),
            Event::AgentStarts(host) => self.agent_starts(host),
            Event::PowerOn(host) => self.power_on(host),
        }
    }

    // The host: guard, VMs and agent.

    fn host_tick(&mut self, index: usize) {
        let now = self.now;
        let next = now + self.hosts[index].clock.true_span(TICK_NS);
        self.at(next, Event::HostTick(index));
        if !self.hosts[index].machine_up {
            return;
        }
        self.kernel_tick(index);
        if !self.hosts[index].machine_up {
            return;
        }
        if self.hosts[index].vms_run() {
            let host = &mut self.hosts[index];
            let id = host.id;
            let mut runs = Vec::new();
            for (sandbox, local) in &mut host.sandboxes {
                if local.awake {
                    local.content += 1;
                    runs.push((*sandbox, local.epoch, local.content));
                }
            }
            for (sandbox, epoch, content) in runs {
                match self.ghost.ran(sandbox, id, epoch, content, now) {
                    Ok(true) => self.note(sandbox, &format!("runs on {id:?} at {epoch}")),
                    Ok(false) => {}
                    Err(broken) => self.fail(sandbox, &broken),
                }
            }
        }
        if self.hosts[index].stalled_until > now {
            return;
        }
        self.guard_tick(index);
        if !self.hosts[index].agent_up {
            return;
        }
        let local_now = self.hosts[index].now(now);
        if local_now >= self.hosts[index].lease.due() {
            self.send_lease(index, local_now);
        }
        let may_run = self.hosts[index].lease.may_run(local_now);
        let ids: Vec<SandboxId> = self.hosts[index].sandboxes.keys().copied().collect();
        for id in ids {
            // Once faults end, nothing sleeps, so the final wake shows.
            let sleep = self.faults && self.rng.chance(1, 40);
            let archive = self.rng.chance(1, 15);
            let Some(local) = self.hosts[index].sandboxes.get_mut(&id) else {
                continue;
            };
            if local.awake && sleep {
                local.awake = false;
            }
            // An archive whose answer never came is given up on. It may
            // still land, over or under a later one: stamps order them.
            if local
                .archiving
                .is_some_and(|since| since + ARCHIVE_GIVE_UP < local_now)
            {
                local.archiving = None;
            }
            if local.releasing {
                if may_run && local.archiving.is_none() {
                    self.continue_release(index, id);
                }
            } else if may_run
                && archive
                && local.archiving.is_none()
                && local.content > local.archived
            {
                self.begin_archive(index, id);
            }
        }
    }

    /// The kernel: freezes and kills complete, and the watchdog fires.
    fn kernel_tick(&mut self, index: usize) {
        let now = self.now;
        let host = &mut self.hosts[index];
        if host.kernel.freeze_at.is_some_and(|at| at <= now) {
            host.kernel.freeze_at = None;
            host.kernel.frozen = true;
        }
        if host.kernel.kill_at.is_some_and(|at| at <= now) {
            host.kernel.kill_at = None;
            for local in host.sandboxes.values_mut() {
                local.awake = false;
            }
            self.stats.kills += 1;
        }
        if now.saturating_sub(host.fed) >= WATCHDOG_NS {
            self.stats.watchdog_reboots += 1;
            self.host_note(index, "watchdog reboots");
            self.power_off(index);
            let back = now + 20 * SEC + self.rng.below(40 * SEC);
            self.at(back, Event::PowerOn(index));
        }
    }

    fn guard_tick(&mut self, index: usize) {
        let now = self.now;
        let host = &mut self.hosts[index];
        let observed = Observed {
            frozen: host.kernel.frozen,
            empty: host.awake() == 0,
        };
        let step = host.guard.step(host.now(now), host.file.deadline, observed);
        if let Some(action) = step.action {
            self.host_note(index, &format!("guard {action:?}"));
        }
        let host = &mut self.hosts[index];
        match step.action {
            Some(GuardAction::Freeze) => {
                let at = if self.rng.chance(1, 50) {
                    u64::MAX
                } else {
                    now + MS + self.rng.below(100 * MS)
                };
                host.kernel.freeze_at = Some(at);
            }
            Some(GuardAction::Kill) => {
                let at = if self.rng.chance(1, 100) {
                    u64::MAX
                } else {
                    now + MS + self.rng.below(200 * MS)
                };
                host.kernel.kill_at = Some(at);
            }
            Some(GuardAction::Thaw) => {
                host.kernel.frozen = false;
                host.kernel.freeze_at = None;
            }
            None => {}
        }
        if step.feed {
            host.fed = now;
        }
    }

    fn send_lease(&mut self, index: usize, local_now: At) {
        let host = &mut self.hosts[index];
        let incarnation = host.incarnation;
        if host.lease.epoch().is_none() {
            let renewal = host.lease.send(local_now);
            let listed = host
                .sandboxes
                .iter()
                .map(|(id, local)| Listed {
                    sandbox: *id,
                    epoch: local.epoch,
                })
                .collect();
            self.send(
                index,
                Event::Register {
                    host: index,
                    incarnation,
                    renewal,
                    listed,
                },
            );
        } else {
            let renewal = host.lease.send(local_now);
            // Stored before it is sent: a restarted agent never takes a
            // request as fresher than the renewals already sent make it.
            host.file = host.lease.record();
            let capacity = host.capacity();
            self.send(
                index,
                Event::Renew {
                    host: index,
                    renewal,
                    capacity,
                    incarnation,
                },
            );
        }
    }

    /// Writes the lease file the guard reads.
    fn write_file(&mut self, index: usize) {
        self.host_note(index, "lease file written");
        let host = &mut self.hosts[index];
        host.file = host.lease.record();
    }

    fn host_registered(
        &mut self,
        index: usize,
        incarnation: u64,
        renewal: Renewal,
        epoch: HostEpoch,
        verdicts: &[(SandboxId, Verdict)],
    ) {
        let host = &mut self.hosts[index];
        if !host.agent_up || host.incarnation != incarnation || !host.lease.awaits(renewal) {
            return;
        }
        // Drop and refetch before the new deadline lets anything run, and
        // keep nothing the answer does not name.
        let mut refetch = Vec::new();
        let mut kept = BTreeMap::new();
        for (id, verdict) in verdicts {
            match verdict {
                Verdict::Keep { epoch } => {
                    kept.insert(*id, *epoch);
                }
                Verdict::Drop => {}
                Verdict::Refetch { epoch } => refetch.push((*id, *epoch)),
                Verdict::Reclaim { .. } => unreachable!("the store resolves reclaims"),
            }
        }
        host.sandboxes.retain(|id, local| {
            kept.get(id).is_some_and(|epoch| {
                local.epoch = *epoch;
                true
            })
        });
        if let Some(traced) = self.trace {
            let what = format!("registered as {epoch:?}; keeps {:?}", kept.get(&traced));
            self.host_note(index, &what);
        }
        if self.hosts[index].lease.registered(renewal, epoch) {
            self.write_file(index);
        }
        for (id, epoch) in refetch {
            self.host_request(index, None, Op::Adopt, id, epoch, 0);
        }
    }

    fn host_renewed(&mut self, index: usize, incarnation: u64, renewal: Renewal, accepted: bool) {
        let host = &mut self.hosts[index];
        if !host.agent_up || host.incarnation != incarnation {
            return;
        }
        if accepted {
            if host.lease.renewed(renewal) {
                self.write_file(index);
            }
        } else {
            host.lease.refused(renewal);
            self.host_note(index, "renewal refused");
        }
    }

    /// A request from the service, sent under the host's registration
    /// and stamped with its renewal then (`None` for work the host gives
    /// itself).
    fn host_request(
        &mut self,
        index: usize,
        sent: Option<(HostEpoch, u64)>,
        op: Op,
        id: SandboxId,
        epoch: OwnerEpoch,
        tries: u32,
    ) {
        let host = &self.hosts[index];
        if !host.agent_up || host.stalled_until > self.now {
            return;
        }
        let local_now = host.now(self.now);
        // A request sent under an earlier registration was decided before
        // the service gave up on this host: it holds nothing it asks for.
        let current = sent.is_none_or(|(epoch, _)| host.lease.epoch() == Some(epoch));
        // One held up for longer than the request window may have been
        // given up on already.
        let fresh = sent.is_none_or(|(_, stamp)| host.lease.admits(stamp));
        let answer = if !current || !host.lease.may_run(local_now) {
            Answer::Unavailable
        } else if !fresh {
            Answer::Expired
        } else {
            match op {
                Op::Create => self.host_create(index, id, epoch),
                Op::Wake => self.host_wake(index, id, epoch),
                Op::Adopt => self.host_adopt(index, id, epoch),
                Op::Release => match self.host_release(index, id, epoch) {
                    Some(answer) => answer,
                    None => return,
                },
            }
        };
        let host_id = self.hosts[index].id;
        self.note(
            id,
            &format!("{host_id:?} {op:?} at {epoch} (sent under {sent:?}): {answer:?}"),
        );
        let seq = self.hosts[index].lease.seq();
        self.send(
            index,
            Event::Answered {
                host: index,
                op,
                id,
                epoch,
                answer,
                seq,
                tries,
            },
        );
    }

    fn host_create(&mut self, index: usize, id: SandboxId, epoch: OwnerEpoch) -> Answer {
        let host = &mut self.hosts[index];
        if host.sandboxes.contains_key(&id) {
            return Answer::Ok;
        }
        if host.capacity().free_memory_mib < SANDBOX_MIB || self.rng.chance(1, 50) {
            return Answer::Full;
        }
        self.ghost.created_on.entry(id).or_insert(host.id);
        host.sandboxes.insert(
            id,
            Local {
                epoch,
                content: 0,
                archived: 0,
                awake: true,
                archiving: None,
                releasing: false,
            },
        );
        Answer::Ok
    }

    fn host_wake(&mut self, index: usize, id: SandboxId, epoch: OwnerEpoch) -> Answer {
        let host = &mut self.hosts[index];
        let free = host.capacity().free_memory_mib;
        let Some(local) = host.sandboxes.get_mut(&id) else {
            return Answer::NotFound;
        };
        if local.epoch < epoch {
            // The store says this host owns it under a later epoch it never
            // learned: its copy may be behind, so the service adopts it.
            return Answer::NotFound;
        }
        if local.epoch > epoch {
            return Answer::Stale;
        }
        if local.releasing {
            return Answer::Busy;
        }
        if !local.awake && free < SANDBOX_MIB {
            return Answer::Full;
        }
        local.awake = true;
        Answer::Ok
    }

    fn host_adopt(&mut self, index: usize, id: SandboxId, epoch: OwnerEpoch) -> Answer {
        let host = &self.hosts[index];
        match host.sandboxes.get(&id) {
            Some(local) if local.epoch == epoch => return Answer::Ok,
            Some(local) if local.epoch > epoch => return Answer::Stale,
            _ => {}
        }
        if host.capacity().free_memory_mib < SANDBOX_MIB {
            return Answer::Full;
        }
        // Claim the pointer: store it again under this epoch.
        let Some(pointer) = self.objects.get(&id).copied() else {
            return Answer::NoArchive;
        };
        if pointer.epoch > epoch {
            return Answer::Stale;
        }
        self.write_pointer(
            id,
            Pointer {
                version: pointer.version + 1,
                epoch,
                content: pointer.content,
            },
        );
        let written = self.ghost.written.insert(id, pointer.content).unwrap_or(0);
        self.stats.lost_writes += written.saturating_sub(pointer.content);
        self.stats.adopts += 1;
        self.hosts[index].sandboxes.insert(
            id,
            Local {
                epoch,
                content: pointer.content,
                archived: pointer.content,
                awake: true,
                archiving: None,
                releasing: false,
            },
        );
        Answer::Ok
    }

    /// Starts handing a sleeping sandbox off: from now it takes no wakes,
    /// and once its latest state is archived the host forgets it and
    /// answers. Answers at once only to refuse.
    fn host_release(&mut self, index: usize, id: SandboxId, epoch: OwnerEpoch) -> Option<Answer> {
        let Some(local) = self.hosts[index].sandboxes.get_mut(&id) else {
            return Some(Answer::NotFound);
        };
        if local.epoch != epoch {
            return Some(Answer::Stale);
        }
        if local.awake {
            return Some(Answer::Busy);
        }
        local.releasing = true;
        if local.archiving.is_none() {
            self.continue_release(index, id);
        }
        None
    }

    fn continue_release(&mut self, index: usize, id: SandboxId) {
        let Some(local) = self.hosts[index].sandboxes.get(&id).cloned() else {
            return;
        };
        if local.content > local.archived || !self.objects.contains_key(&id) {
            self.begin_archive(index, id);
            return;
        }
        // Only a release of the latest run must carry every write: an
        // older copy whose final archive landed before another host took
        // the sandbox may hear of it late and forget itself.
        let host_id = self.hosts[index].id;
        let current = self
            .ghost
            .last_run
            .get(&id)
            .is_none_or(|&last| last == (host_id, local.epoch));
        let latest = if current {
            self.ghost.written.get(&id).copied().unwrap_or(0)
        } else {
            local.content
        };
        if local.content != latest {
            self.fail(
                id,
                &format!(
                    "{id:?} released from a copy at {} behind its latest run at {latest}",
                    local.content
                ),
            );
        }
        if current && self.objects[&id].content != latest {
            self.fail(
                id,
                &format!(
                    "{id:?} released with writes missing: archive at {}, latest {latest}",
                    self.objects[&id].content
                ),
            );
        }
        self.hosts[index].sandboxes.remove(&id);
        self.stats.moves += 1;
        self.send(
            index,
            Event::Answered {
                host: index,
                op: Op::Release,
                id,
                epoch: local.epoch,
                answer: Answer::Ok,
                seq: self.hosts[index].lease.seq(),
                tries: 0,
            },
        );
    }

    /// Starts an archive: it reads the pointer, then publishes on the
    /// version it read. The read itself may be held up for long, past the
    /// host's deadline and a new owner's claim.
    fn begin_archive(&mut self, index: usize, id: SandboxId) {
        let host = &mut self.hosts[index];
        let local = host.sandboxes.get_mut(&id).unwrap();
        local.archiving = Some(host.clock.read(self.now));
        let (epoch, content, incarnation) = (local.epoch, local.content, host.incarnation);
        let delay = if self.rng.chance(1, 30) {
            5 * SEC + self.rng.below(25 * SEC)
        } else {
            5 * MS + self.rng.below(50 * MS)
        };
        self.at(
            self.now + delay,
            Event::ArchiveReads {
                host: index,
                incarnation,
                id,
                epoch,
                content,
            },
        );
    }

    /// The archive's pointer read: the fence is checked on the exact
    /// version the publish will be conditional on.
    fn archive_reads(
        &mut self,
        index: usize,
        incarnation: u64,
        id: SandboxId,
        epoch: OwnerEpoch,
        content: u64,
    ) {
        // The agent reads the pointer itself: one that stopped reads
        // nothing more.
        let host = &self.hosts[index];
        if !host.agent_up || host.incarnation != incarnation {
            return;
        }
        let found = self.objects.get(&id).copied();
        let own = Stamp {
            epoch,
            save: content,
        };
        match fence(own, found.map(Pointer::stamp)) {
            Fence::Superseded { .. } => {
                // Someone else owns it now.
                self.stats.fenced += 1;
                self.note(id, &format!("fenced on host {index}"));
                let host = &mut self.hosts[index];
                if host
                    .sandboxes
                    .get(&id)
                    .is_some_and(|local| local.epoch == epoch)
                {
                    host.sandboxes.remove(&id);
                }
                return;
            }
            Fence::Done => {
                // An earlier try landed, or an overlapping later save did.
                self.send(
                    index,
                    Event::Published {
                        host: index,
                        incarnation,
                        id,
                        epoch,
                        content,
                        landed: true,
                    },
                );
                return;
            }
            Fence::Publish => {}
        }
        let version = found.map_or(0, |pointer| pointer.version);
        // The upload takes a while, sometimes very long.
        let delay = if self.rng.chance(1, 50) {
            5 * SEC + self.rng.below(30 * SEC)
        } else {
            50 * MS + self.rng.below(2 * SEC)
        };
        self.at(
            self.now + delay,
            Event::PublishLands {
                host: index,
                incarnation,
                id,
                version,
                epoch,
                content,
            },
        );
    }

    /// The archive's conditional pointer write reaches object storage.
    fn publish_lands(
        &mut self,
        host: usize,
        incarnation: u64,
        id: SandboxId,
        version: u64,
        epoch: OwnerEpoch,
        content: u64,
    ) {
        let current = self.objects.get(&id).map_or(0, |pointer| pointer.version);
        let landed = current == version;
        if !landed {
            self.stats.superseded += 1;
        }
        if landed {
            self.write_pointer(
                id,
                Pointer {
                    version: version + 1,
                    epoch,
                    content,
                },
            );
        }
        self.send(
            host,
            Event::Published {
                host,
                incarnation,
                id,
                epoch,
                content,
                landed,
            },
        );
    }

    fn host_published(
        &mut self,
        index: usize,
        incarnation: u64,
        id: SandboxId,
        epoch: OwnerEpoch,
        content: u64,
        landed: bool,
    ) {
        let host = &mut self.hosts[index];
        if !host.agent_up || host.incarnation != incarnation {
            return;
        }
        if let Some(local) = host.sandboxes.get_mut(&id)
            && local.epoch == epoch
        {
            local.archiving = None;
            if landed {
                local.archived = local.archived.max(content);
            }
            if local.releasing && landed {
                self.continue_release(index, id);
            }
        }
    }

    fn set_row(&mut self, id: SandboxId, row: Ownership, why: &str) {
        self.note(id, &format!("row {row:?}: {why}"));
        self.rows.insert(id, row);
    }

    fn write_pointer(&mut self, id: SandboxId, pointer: Pointer) {
        self.note(id, &format!("pointer {pointer:?}"));
        // A pointer's stamp never goes back: no former owner publishes
        // over a new one, and no older save over a newer one.
        if let Some(old) = self.objects.get(&id).copied()
            && pointer.stamp() < old.stamp()
        {
            self.fail(
                id,
                &format!("{:?} published over {:?}", pointer.stamp(), old.stamp()),
            );
        }
        self.objects.insert(id, pointer);
    }

    fn agent_starts(&mut self, index: usize) {
        self.host_note(index, "agent starts");
        let host = &mut self.hosts[index];
        if !host.machine_up || host.agent_up {
            return;
        }
        host.agent_up = true;
        host.incarnation += 1;
        host.lease = HostLease::resume(TERMS, host.file);
        for local in host.sandboxes.values_mut() {
            local.archiving = None;
        }
    }

    fn power_off(&mut self, index: usize) {
        self.host_note(index, "power off");
        let host = &mut self.hosts[index];
        host.machine_up = false;
        host.agent_up = false;
        for local in host.sandboxes.values_mut() {
            local.awake = false;
        }
    }

    fn power_on(&mut self, index: usize) {
        let now = self.now;
        let host = &mut self.hosts[index];
        if host.machine_up || host.dead {
            return;
        }
        host.machine_up = true;
        // A reboot restarts the boot clock and empties /run.
        host.clock.boot = now;
        host.clock.offset = SEC;
        host.file = LeaseRecord::NONE;
        host.lease = HostLease::new(TERMS);
        host.guard = Guard::new();
        host.kernel = Kernel::default();
        host.fed = now;
        host.stalled_until = 0;
        host.incarnation += 1;
        host.agent_up = true;
        for local in host.sandboxes.values_mut() {
            local.awake = false;
            local.archiving = None;
        }
    }

    // The store and service.

    fn store_register(
        &mut self,
        index: usize,
        incarnation: u64,
        renewal: Renewal,
        listed: &[Listed],
    ) {
        let id = self.hosts[index].id;
        // A host registers again only once its last registration lapsed:
        // until then that one may still be running its VMs.
        if self
            .host_rows
            .get(&id)
            .is_some_and(|row| row.state == HostState::Live)
        {
            self.send(
                index,
                Event::Renewed {
                    host: index,
                    incarnation,
                    renewal,
                    accepted: false,
                },
            );
            return;
        }
        assert!(
            self.rows.values().all(|row| row.owner != Some(id)),
            "{id:?} registers while it still owns sandboxes"
        );
        let epoch = HostEpoch(self.next_host_epoch);
        self.next_host_epoch += 1;
        let renewals = self.host_rows.get(&id).map_or(0, |row| row.renewals) + 1;
        self.host_rows.insert(
            id,
            HostRow {
                epoch,
                state: HostState::Live,
                renewals,
                seq: 0,
            },
        );
        let mut verdicts = Vec::new();
        for item in listed {
            let row = self.rows.get(&item.sandbox).copied();
            let verdict = match reconcile(id, item.epoch, row) {
                Verdict::Reclaim { change } => {
                    // The only writer in this store; a real one retries.
                    assert_eq!(row, Some(change.expect));
                    self.set_row(item.sandbox, change.set, "reclaimed");
                    self.stats.reclaims += 1;
                    Verdict::Keep {
                        epoch: change.set.epoch,
                    }
                }
                verdict => verdict,
            };
            verdicts.push((item.sandbox, verdict));
        }
        let info = HostInfo {
            zone: ZoneId(u16::try_from(index % 3).unwrap()),
            class: ClassId(0),
            huge_pages: false,
        };
        self.fleet
            .upsert(id, info, HostState::Live, self.hosts[index].capacity());
        self.send(
            index,
            Event::Registered {
                host: index,
                incarnation,
                renewal,
                epoch,
                verdicts,
            },
        );
    }

    fn store_renew(
        &mut self,
        index: usize,
        renewal: Renewal,
        capacity: Capacity,
        incarnation: u64,
    ) {
        let id = self.hosts[index].id;
        let accepted = match self.host_rows.get_mut(&id) {
            Some(row) if Some(row.epoch) == renewal.epoch && row.state == HostState::Live => {
                row.renewals += 1;
                row.seq = row.seq.max(renewal.seq);
                true
            }
            _ => false,
        };
        if accepted {
            self.fleet.update(id, capacity);
        }
        self.send(
            index,
            Event::Renewed {
                host: index,
                incarnation,
                renewal,
                accepted,
            },
        );
    }

    /// The leader watches renewal counts on its own clock (true time here)
    /// and gives up on hosts whose count stood still for T plus the margin.
    fn recovery(&mut self) {
        self.at(self.now + 250 * MS, Event::Recovery);
        let now = At::from_duration(Duration::from_nanos(self.now));
        for (id, row) in &self.host_rows {
            if row.state == HostState::Live {
                self.expiry.observe(*id, row.renewals, now);
            }
        }
        let lost: Vec<(HostId, u64)> = self.expiry.expired(now).collect();
        for (host, renewals) in lost {
            self.expiry.forget(host);
            let row = self.host_rows.get_mut(&host).unwrap();
            // Conditional on the count it watched: a renewal since saves it.
            if row.state != HostState::Live || row.renewals != renewals {
                continue;
            }
            row.state = HostState::Lost;
            self.fleet.set_state(host, HostState::Lost);
            if let Some(&last) = self.ghost.host_last_run.get(&host) {
                let gap = self.now.saturating_sub(last);
                assert!(last < self.now, "{host:?} ran a VM as it was given up on");
                let min = self.stats.min_stop_gap_ns.get_or_insert(gap);
                *min = (*min).min(gap);
            }
            let owned: Vec<(SandboxId, Ownership)> = self
                .rows
                .iter()
                .filter(|(_, row)| row.owner == Some(host))
                .map(|(id, row)| (*id, *row))
                .collect();
            for (id, row) in owned {
                self.set_row(id, row.clear().set, "cleared: host lost");
            }
            self.stats.recoveries += 1;
        }
    }

    fn client(&mut self) {
        self.at(self.now + 20 * MS, Event::Client);
        let created = usize::try_from(self.next_sandbox - 1).unwrap();
        if created < self.params.sandboxes && self.rng.chance(1, 2) {
            let id = SandboxId(self.next_sandbox);
            self.next_sandbox += 1;
            self.place_and_send(id, None, Op::Create, 0);
            return;
        }
        if created == 0 {
            return;
        }
        let id = SandboxId(1 + u128::from(self.rng.below(created as u64)));
        if self.faults && self.rng.chance(1, 20) {
            self.move_one(id);
        } else {
            self.wake(id, 0);
        }
    }

    fn wake(&mut self, id: SandboxId, tries: u32) {
        let Some(row) = self.rows.get(&id).copied() else {
            return;
        };
        match row.owner {
            Some(owner) => self.request(owner, Op::Wake, id, row.epoch, tries),
            // Only an archive can come back elsewhere. Without one, the
            // only copy is on the host that lost it: wait for it to return.
            None if self.objects.contains_key(&id) => {
                self.place_and_send(id, Some(row), Op::Adopt, tries);
            }
            None => {}
        }
    }

    fn move_one(&mut self, id: SandboxId) {
        if let Some(row) = self.rows.get(&id).copied()
            && let Some(owner) = row.owner
        {
            self.request(owner, Op::Release, id, row.epoch, 0);
        }
    }

    fn request(&mut self, host: HostId, op: Op, id: SandboxId, epoch: OwnerEpoch, tries: u32) {
        let index = usize::try_from(host.0).unwrap();
        // Sent under the registration the store holds now, stamped with the
        // host's latest renewal.
        let Some((host_epoch, stamp)) = self.host_rows.get(&host).map(|row| (row.epoch, row.seq))
        else {
            return;
        };
        if matches!(op, Op::Create | Op::Adopt) {
            self.requested.insert(id, (epoch, stamp));
        }
        self.send(
            index,
            Event::Request {
                host: index,
                host_epoch,
                stamp,
                op,
                id,
                epoch,
                tries,
            },
        );
    }

    /// Places a new sandbox, or one nobody owns, and sends it there.
    fn place_and_send(&mut self, id: SandboxId, row: Option<Ownership>, op: Op, tries: u32) {
        let demand = Demand {
            memory_mib: SANDBOX_MIB,
            memory_max_mib: SANDBOX_MIB,
            disk_mib: 1,
            shape: None,
            class: None,
        };
        let Some(placement) = self.fleet.place(&demand, &[], &mut self.rng) else {
            return;
        };
        self.fleet.reserve(placement, &demand);
        let set = match row {
            None => Ownership::created(placement.host),
            Some(row) => row.give(placement.host).set,
        };
        self.set_row(id, set, "placed");
        self.request(placement.host, op, id, set.epoch, tries);
    }

    #[expect(clippy::too_many_arguments, reason = "one per field of the answer")]
    fn service_answer(
        &mut self,
        host: usize,
        op: Op,
        id: SandboxId,
        epoch: OwnerEpoch,
        answer: Answer,
        seq: u64,
        tries: u32,
    ) {
        let host_id = self.hosts[host].id;
        let Some(row) = self.rows.get(&id).copied() else {
            return;
        };
        let still = row.owner == Some(host_id) && row.epoch == epoch;
        if matches!(op, Op::Create | Op::Adopt)
            && self
                .requested
                .get(&id)
                .is_some_and(|&(sent, _)| sent == epoch)
        {
            // Answered: it can no longer land later.
            self.requested.remove(&id);
        }
        // That the host holds nothing under this epoch is final only once
        // no create or adopt for it can still reach the host.
        let settled = self
            .requested
            .get(&id)
            .is_none_or(|&(sent, stamp)| sent != epoch || TERMS.settles(stamp, seq));
        if op == Op::Create && answer == Answer::Ok {
            self.confirmed.insert(id);
        }
        match (op, answer) {
            // The host holds nothing of it: give it to another.
            (Op::Create | Op::Adopt, Answer::Full | Answer::Unavailable | Answer::Expired)
                if still && tries < 3 =>
            {
                self.place_and_send(id, Some(row), op, tries + 1);
            }
            // The host holds nothing of it under this epoch: it finished
            // a release the service has not heard of yet, or its copy is
            // behind. Adopt the archive there under a new epoch, so that
            // a late answer about the old one cannot touch the new.
            (Op::Wake, Answer::NotFound) if still && settled && self.objects.contains_key(&id) => {
                let set = row.give(host_id).set;
                self.set_row(id, set, "given back: not found");
                self.request(host_id, Op::Adopt, id, set.epoch, tries);
            }
            (Op::Release, Answer::Ok) if still => {
                self.set_row(id, row.clear().set, "cleared: released");
            }
            (Op::Release, Answer::NotFound) if still && settled => {
                self.set_row(id, row.clear().set, "cleared: not found");
            }
            _ => {}
        }
    }

    // Faults.

    fn fault(&mut self) {
        if !self.faults {
            return;
        }
        let next = self.now + SEC + self.rng.below(4 * SEC);
        self.at(next, Event::Fault);
        let index = self.rng.index(self.hosts.len());
        if self.hosts[index].dead {
            return;
        }
        match self.rng.below(12) {
            0..=4 => {
                let span = 2 * SEC + self.rng.below(40 * SEC);
                self.hosts[index].cut_until = self.now + span;
                self.host_note(index, &format!("cut off for {}s", span / SEC));
            }
            8 => {
                // The agent and the guard get no processor time; VMs run on.
                let span = SEC + self.rng.below(20 * SEC);
                self.hosts[index].stalled_until = self.now + span;
                self.host_note(index, &format!("stalled for {}s", span / SEC));
            }
            9 if self.rng.chance(1, 5) => self.at(self.now, Event::NewLeader),
            5..=7 => {
                let host = &mut self.hosts[index];
                if host.agent_up {
                    host.agent_up = false;
                    let back = self.now + SEC / 2 + self.rng.below(20 * SEC);
                    self.at(back, Event::AgentStarts(index));
                }
            }
            9 => {}
            _ => {
                if !self.hosts[index].machine_up {
                    return;
                }
                self.power_off(index);
                if self.rng.chance(15, 100) {
                    self.hosts[index].dead = true;
                } else {
                    let back = self.now + 5 * SEC + self.rng.below(60 * SEC);
                    self.at(back, Event::PowerOn(index));
                }
            }
        }
    }

    /// Ends every fault but deaths and lets the fleet settle.
    fn heal(&mut self) {
        self.faults = false;
        for index in 0..self.hosts.len() {
            let host = &mut self.hosts[index];
            host.cut_until = 0;
            host.stalled_until = 0;
            if host.dead {
                continue;
            }
            if !host.machine_up {
                self.power_on(index);
            } else if !self.hosts[index].agent_up {
                self.agent_starts(index);
            }
        }
    }
}

fn simulate(seed: u64, params: Params) -> Stats {
    let mut sim = Sim::new(seed, params);
    sim.run_until(params.seconds * SEC);
    sim.heal();
    let settle = sim.now + 60 * SEC;
    sim.run_until(settle);
    // Wake everything, more than once to ride out lost messages.
    let ids: Vec<SandboxId> = sim.rows.keys().copied().collect();
    for round in 0..4 {
        for &id in &ids {
            sim.wake(id, 0);
        }
        let until = sim.now + 5 * SEC + round * SEC;
        sim.run_until(until);
    }
    let mut gone = 0;
    for (&id, row) in &sim.rows {
        let owner = row
            .owner
            .map(|host| &sim.hosts[usize::try_from(host.0).unwrap()]);
        let runs = owner
            .and_then(|host| host.sandboxes.get(&id))
            .is_some_and(|local| local.epoch == row.epoch && local.awake);
        if runs || !sim.confirmed.contains(&id) {
            // Running, or a create the client never saw succeed.
            continue;
        }
        // Only a sandbox never archived, last run on a host that died, may
        // be gone.
        let last = sim
            .ghost
            .last_run
            .get(&id)
            .map(|(host, _)| *host)
            .or_else(|| sim.ghost.created_on.get(&id).copied());
        let died = last.is_some_and(|host| sim.hosts[usize::try_from(host.0).unwrap()].dead);
        if sim.objects.contains_key(&id) || !died {
            sim.fail(
                id,
                &format!(
                    "{id:?} did not come back: archive {:?}, row {row:?}, on its owner {:?}, last run on {last:?}",
                    sim.objects.get(&id),
                    owner.and_then(|host| host.sandboxes.get(&id)),
                ),
            );
        }
        gone += 1;
    }
    assert!(
        gone * 20 <= ids.len(),
        "seed {seed}: {gone} of {} lost",
        ids.len()
    );
    // Every surviving copy runs on one host only.
    let mut holders: BTreeMap<SandboxId, usize> = BTreeMap::new();
    for host in sim.hosts.iter().filter(|host| !host.dead) {
        for (id, local) in &host.sandboxes {
            if local.awake && host.vms_run() {
                *holders.entry(*id).or_default() += 1;
            }
        }
    }
    assert!(
        holders.values().all(|&count| count == 1),
        "seed {seed}: a sandbox runs twice"
    );
    sim.stats
}

fn seeds() -> impl Iterator<Item = u64> {
    let count = std::env::var("FLEET_SIM_SEEDS").map_or(6, |value| value.parse().unwrap());
    let first = std::env::var("FLEET_SIM_FIRST_SEED").map_or(1, |value| value.parse().unwrap());
    first..first + count
}

#[test]
fn the_protocol_keeps_every_sandbox_on_one_host_through_faults() {
    let params = Params {
        hosts: 16,
        sandboxes: 600,
        seconds: 600,
        max_ppm: 500,
    };
    let mut total = Stats::default();
    for seed in seeds() {
        let stats = simulate(seed, params);
        total.recoveries += stats.recoveries;
        total.reclaims += stats.reclaims;
        total.adopts += stats.adopts;
        total.moves += stats.moves;
        total.fenced += stats.fenced;
        total.lost_writes += stats.lost_writes;
        total.superseded += stats.superseded;
        total.watchdog_reboots += stats.watchdog_reboots;
        total.kills += stats.kills;
        if let Some(gap) = stats.min_stop_gap_ns {
            let min = total.min_stop_gap_ns.get_or_insert(gap);
            *min = (*min).min(gap);
        }
    }
    // The run exercised every path it checks.
    assert!(
        total.recoveries > 0 && total.reclaims > 0 && total.adopts > 0,
        "{total:?}"
    );
    assert!(
        total.moves > 0 && total.fenced > 0 && total.superseded > 0,
        "{total:?}"
    );
    assert!(total.watchdog_reboots > 0 && total.kills > 0, "{total:?}");
    // VMs stopped at least the margin less the watchdog's timeout before
    // recovery, even when the guard stalled or could not stop them.
    let gap = total.min_stop_gap_ns.unwrap();
    let margin = u64::try_from(TERMS.margin.as_nanos()).unwrap();
    assert!(
        gap + WATCHDOG_NS + 3 * TICK_NS >= margin,
        "a VM ran {gap} ns before its host was given up on"
    );
}

#[test]
fn even_fast_drifting_clocks_stay_safe() {
    // 0.5 % drift: far past any real clock, still inside the margin.
    let params = Params {
        hosts: 8,
        sandboxes: 200,
        seconds: 300,
        max_ppm: 5_000,
    };
    for seed in seeds().take(3) {
        simulate(seed, params);
    }
}
