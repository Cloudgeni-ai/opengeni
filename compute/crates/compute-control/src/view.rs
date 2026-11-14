//! Each replica's view of the hosts, which placement and routing read.
//!
//! A replica reads the host rows changed since it last looked every 250
//! ms ([`follow`]). Change numbers come from a sequence, and a transaction
//! can commit after one that took a later number, so each read starts from
//! the highest number seen two seconds earlier, and every ten seconds the
//! replica reads every row, which also forgets the hosts whose rows are
//! gone (given up on, then forgotten). The view is a hint: a request sent
//! under a registration that has since changed is refused by the host and
//! sent again, and ownership is always read from the store.
//!
//! Placement passes over a host this replica has read no renewal from for
//! three renewal intervals, or its lease's term if that is shorter
//! ([`compute_fleet::LeaseTerms::silent_after`]): a host that missed three
//! is most likely cut off, though its VMs may run until its deadline, and
//! the leader gives up on it only after the term and margin, or later
//! while it holds sandboxes.
//!
//! A replica that has itself read nothing for that long cannot tell which
//! hosts renew, so it places nothing and says so ([`Unplaced::Blind`]),
//! rather than pass over every host as silent and answer that none has
//! room.
//!
//! The view numbers the names of what the hosts it holds offer sandboxes
//! to reach, up to the 64 placement can tell apart at once. A name no host
//! it holds offers any longer gives its number back, for another name; a
//! host's offers past those numbered are left out of its placement, so it
//! is not chosen for them, and logged, until a number is free when it is
//! next read. A sandbox's reach is numbered as it is placed, under the
//! same lock, so a number given back never stands for the name it had.
//!
//! A host that refuses a sandbox as full is not asked about it again
//! until what it reports could have changed ([`View::refused`]): its
//! next report that differs from the one it refused under, or
//! [`FULL_FOR`] at most, whichever comes first. Placement passes it over
//! for anything at least as large as what it refused, of the same kind,
//! meanwhile. Without this, a fleet with no room asks the same full host
//! the same thing four times a second per waiting caller, and each ask
//! writes the sandbox's row first.
//!
//! The view also tallies, for each host it holds, what its metrics report
//! ([`Tally`]): how often the host registered afresh while this replica
//! held it, which is a reboot or its lease lapsing, and
//! how often it refused a wake or a placement as full.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::{Duration, Instant};

use compute_fleet::{
    Capacity, ClassId, Demand, Fleet, HostEpoch, HostId, HostInfo, HostState, Offers, Placement,
    Rng, ShapeKey, ZoneId,
};
use compute_protocol::fleet::{Capacity as Reported, HostInfo as Described};
use compute_protocol::host::Id;

use crate::store::{HostRow, Store};

/// How often a replica reads changed host rows.
pub const FOLLOW_EVERY: Duration = Duration::from_millis(250);

/// How far back each read starts: commits that land later than this after
/// their change number was taken wait for the next full read.
const OVERLAP: Duration = Duration::from_secs(2);

/// How many reads go between two reads of every row.
const FULL_EVERY: u32 = 40;

/// How many offer names placement tells apart: one bit of
/// [`compute_fleet::Offers`] each.
const MAX_OFFERS: usize = 64;

/// The longest a host's refusal as full is believed while its reports
/// stay the same: a report need not show every reason its admission
/// refused, so the host is asked again after this anyway.
pub const FULL_FOR: Duration = Duration::from_secs(10);

/// How many refusals a host's entry keeps; the oldest go first.
const REFUSALS_KEPT: usize = 32;

/// A kind of new sandbox, for ready clones: its image and shape.
#[must_use]
pub fn shape_key(image: &str, vcpus: u32, memory_mib: u32) -> ShapeKey {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&u64::try_from(image.len()).unwrap_or(u64::MAX).to_le_bytes());
    hasher.update(image.as_bytes());
    hasher.update(&vcpus.to_le_bytes());
    hasher.update(&memory_mib.to_le_bytes());
    let digest = hasher.finalize();
    let mut first = [0; 8];
    first.copy_from_slice(&digest.as_bytes()[..8]);
    ShapeKey(u64::from_le_bytes(first))
}

/// The class a host's memory images restore on: its memory profile and CPU
/// template.
#[must_use]
pub fn class_key(info: &Described) -> String {
    format!("{}/{}", info.profile, info.cpu_template)
}

/// Where and under what a request reaches a host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub host: HostId,
    /// Its name, which its certificate must carry.
    pub name: String,
    pub address: String,
    /// The registration the request is sent under.
    pub epoch: HostEpoch,
    /// The highest renewal accepted under it: the request's stamp.
    pub seq: u64,
    /// Its class ([`class_key`]).
    pub class: String,
}

/// A host as the view last read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Known {
    pub target: Target,
    pub info: Described,
    pub state: HostState,
    pub capacity: Reported,
    /// Times its agent started again, as the store counts the runs it
    /// told of ([`HostRow::restarts`]).
    pub restarts: u64,
    /// What this replica counted of it while it held it.
    pub tally: Tally,
}

/// What a replica counted of one host since it first read it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Tally {
    /// Fresh registrations it read, each under a new host epoch: the
    /// host rebooted, or it was given up on (its lease lapsed) and
    /// registered once more; an agent restarted in place keeps its lease.
    /// The first read of a host is not counted.
    pub registrations: u64,
    /// Wakes of its sandboxes it refused as full.
    pub refused_wakes: u64,
    /// Sandboxes placed on it, created or adopted, it refused as full.
    pub refused_places: u64,
}

/// What a host refused as full ([`View::refused`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    /// A sandbox placed on it, created or adopted, needing this. It also
    /// refuses anything of the same preference that needs at least as
    /// much of everything.
    Place(Demand),
    /// A wake of this sandbox, which it owns.
    Wake(Id),
}

impl Refused {
    /// Whether a host that refused `self` would refuse `asked` too.
    fn covers(&self, asked: &Self) -> bool {
        match (self, asked) {
            (Self::Place(refused), Self::Place(asked)) => {
                refused.prefer == asked.prefer
                    && asked.memory_mib >= refused.memory_mib
                    && asked.memory_max_mib >= refused.memory_max_mib
                    && asked.cpu_millis >= refused.cpu_millis
                    && asked.disk_mib >= refused.disk_mib
            }
            (Self::Wake(refused), Self::Wake(asked)) => refused == asked,
            _ => false,
        }
    }
}

/// What a host reported as it refused: a later report that differs could
/// have room.
type Report = (HostEpoch, HostState, Capacity);

/// What a host refused as full under one report.
#[derive(Debug)]
struct Full {
    report: Report,
    /// Each refusal and when it came.
    refused: Vec<(Refused, Instant)>,
}

#[derive(Debug)]
struct Inner {
    fleet: Fleet,
    hosts: HashMap<HostId, Known>,
    /// Each host's renewal count as last read, and when this replica first
    /// read it.
    heard: HashMap<HostId, (u64, Instant)>,
    zones: HashMap<String, ZoneId>,
    classes: HashMap<String, ClassId>,
    /// Each offer name a host held makes: its number in
    /// [`compute_fleet::Offers`], and how many hosts make it.
    offers: HashMap<String, Offered>,
    /// The offer names each host is counted as making: those numbered
    /// when it was last read.
    offered_by: HashMap<HostId, Vec<String>>,
    rng: Rng,
    /// When this replica last read host rows from the store.
    read_at: Option<Instant>,
    /// What each host refused as full since its last report that changed.
    full: HashMap<HostId, Full>,
}

/// An offer name some host makes.
#[derive(Clone, Copy, Debug)]
struct Offered {
    number: u8,
    hosts: usize,
}

impl Inner {
    /// Whether host `host` refused `asked`, or something it covers, under
    /// the report the view holds now, within [`FULL_FOR`].
    fn refuses(&self, host: HostId, asked: &Refused) -> bool {
        self.full.get(&host).is_some_and(|full| {
            full.refused
                .iter()
                .any(|(refused, at)| at.elapsed() < FULL_FOR && refused.covers(asked))
        })
    }

    /// The offers named `names`, as numbered now.
    fn reach(&self, names: &[String]) -> Result<Offers, Unplaced> {
        names.iter().try_fold(Offers::NONE, |offers, name| {
            self.offers
                .get(name)
                .map(|offered| offers.with(offered.number))
                .ok_or_else(|| Unplaced::Unoffered(name.clone()))
        })
    }

    /// Counts host `host` as making the offers `names`, in place of those
    /// it was counted as making, numbering a name no host made while a
    /// number is free. Its offers, for placement.
    fn offer(&mut self, host: HostId, host_name: &str, names: &[String]) -> Offers {
        self.give_back(host);
        let mut counted = Vec::with_capacity(names.len());
        let offers = names.iter().fold(Offers::NONE, |offers, name| {
            if let Some(offered) = self.offers.get_mut(name) {
                offered.hosts += 1;
                counted.push(name.clone());
                return offers.with(offered.number);
            }
            if self.offers.len() >= MAX_OFFERS {
                tracing::warn!(
                    host = host_name,
                    offer = %name,
                    "the hosts offer more than {MAX_OFFERS} names; placement leaves this one out"
                );
                return offers;
            }
            let used = self
                .offers
                .values()
                .fold(0u64, |used, offered| used | 1 << offered.number);
            let number = u8::try_from(used.trailing_ones()).unwrap_or(u8::MAX);
            self.offers
                .insert(name.clone(), Offered { number, hosts: 1 });
            counted.push(name.clone());
            offers.with(number)
        });
        self.offered_by.insert(host, counted);
        offers
    }

    /// No longer counts host `host` as making any offer.
    fn give_back(&mut self, host: HostId) {
        for name in self.offered_by.remove(&host).unwrap_or_default() {
            if let Some(offered) = self.offers.get_mut(&name) {
                offered.hosts -= 1;
                if offered.hosts == 0 {
                    self.offers.remove(&name);
                }
            }
        }
    }
}

/// Why [`View::place`] placed nothing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Unplaced {
    /// No live host heard renewing has room for it.
    NoRoom,
    /// This replica has read no host rows for longer than its view's
    /// `silent_after`, for this long (`None`: none yet), so it cannot tell
    /// which hosts renew.
    Blind(Option<Duration>),
    /// No host this replica holds offers this, which the sandbox asks to
    /// reach.
    Unoffered(String),
}

/// The hosts, as this replica last read them.
#[derive(Debug)]
pub struct View {
    inner: RwLock<Inner>,
    /// How long a host may go without a renewal this replica reads before
    /// placement passes it over ([`compute_fleet::LeaseTerms::silent_after`]):
    /// one cut off that long would most likely only hold a create sent to
    /// it until it comes back.
    silent_after: Duration,
}

fn intern<T: Copy>(table: &mut HashMap<String, T>, key: &str, make: impl Fn(u16) -> T) -> T {
    if let Some(found) = table.get(key) {
        return *found;
    }
    let value = make(u16::try_from(table.len()).unwrap_or(u16::MAX));
    table.insert(key.to_owned(), value);
    value
}

/// What placement reads of a host's report.
fn capacity(info: &Described, reported: &Reported) -> Capacity {
    Capacity {
        memory_mib: info.memory_mib,
        free_memory_mib: reported.memory_free_mib,
        reclaimable_memory_mib: reported.memory_reclaimable_mib,
        cpu_millis: reported.cpu_millis,
        free_cpu_millis: reported.cpu_free_millis,
        // What the host frees by disk relief is room as much as what is
        // free (ADR 30).
        free_disk_mib: reported
            .disk_free_mib
            .saturating_add(reported.disk_reclaimable_mib),
        ready: reported
            .ready
            .iter()
            .map(|ready| {
                let shape = shape_key(&ready.image, ready.vcpus, ready.memory_mib);
                (shape, ready.count)
            })
            .collect(),
        sandboxes: reported.sandboxes,
    }
}

impl View {
    /// An empty view, placing with randomness from `seed` on hosts heard
    /// renewing within `silent_after`.
    #[must_use]
    pub fn new(seed: u64, silent_after: Duration) -> Self {
        Self {
            inner: RwLock::new(Inner {
                fleet: Fleet::new(),
                hosts: HashMap::new(),
                heard: HashMap::new(),
                zones: HashMap::new(),
                classes: HashMap::new(),
                offers: HashMap::new(),
                offered_by: HashMap::new(),
                rng: Rng::new(seed),
                read_at: None,
                full: HashMap::new(),
            }),
            silent_after,
        }
    }

    fn read(&self) -> RwLockReadGuard<'_, Inner> {
        // Each change completes under the lock.
        self.inner
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write(&self) -> RwLockWriteGuard<'_, Inner> {
        self.inner
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Takes in host rows as read from the store, the change rows of a
    /// read that found none included.
    pub fn apply(&self, rows: &[HostRow]) {
        let now = Instant::now();
        let mut inner = self.write();
        inner.read_at = Some(now);
        for row in rows {
            if inner
                .heard
                .get(&row.id)
                .is_none_or(|(renewals, _)| *renewals != row.renewals)
            {
                inner.heard.insert(row.id, (row.renewals, now));
            }
            let zone = intern(&mut inner.zones, &row.info.zone, ZoneId);
            let class_name = class_key(&row.info);
            let class = intern(&mut inner.classes, &class_name, ClassId);
            let offers = inner.offer(row.id, &row.info.name, &row.info.offers);
            let info = HostInfo {
                zone,
                class,
                huge_pages: row.info.profile == "nested",
                offers,
            };
            let capacity = capacity(&row.info, &row.capacity);
            // A report that changed could have room for what it refused.
            if inner
                .full
                .get(&row.id)
                .is_some_and(|full| full.report != (row.epoch, row.state, capacity.clone()))
            {
                inner.full.remove(&row.id);
            }
            inner.fleet.upsert(row.id, info, row.state, capacity);
            // A later epoch is a fresh registration: the host rebooted, or
            // its lease lapsed. The first read is not one.
            let tally = inner
                .hosts
                .get(&row.id)
                .map_or_else(Tally::default, |known| {
                    let mut tally = known.tally;
                    if row.epoch > known.target.epoch {
                        tally.registrations += 1;
                    }
                    tally
                });
            inner.hosts.insert(
                row.id,
                Known {
                    target: Target {
                        host: row.id,
                        name: row.info.name.clone(),
                        address: row.info.address.clone(),
                        epoch: row.epoch,
                        seq: row.seq,
                        class: class_name,
                    },
                    info: row.info.clone(),
                    state: row.state,
                    capacity: row.capacity.clone(),
                    restarts: row.restarts,
                    tally,
                },
            );
        }
    }

    /// As [`View::apply`], from a read of every row: a host without one is
    /// forgotten.
    pub fn apply_all(&self, rows: &[HostRow]) {
        self.apply(rows);
        let present: HashSet<HostId> = rows.iter().map(|row| row.id).collect();
        let mut inner = self.write();
        let inner = &mut *inner;
        let gone: Vec<HostId> = inner
            .hosts
            .keys()
            .filter(|host| !present.contains(host))
            .copied()
            .collect();
        for host in gone {
            inner.hosts.remove(&host);
            inner.heard.remove(&host);
            inner.full.remove(&host);
            inner.fleet.remove(host);
            inner.give_back(host);
        }
    }

    /// Notes that host `host` refused `refused` as full: placement passes
    /// it over for that, and for anything it covers, and
    /// [`Self::refuses`] says so, until the host reports anything other
    /// than what the view holds of it now, or [`FULL_FOR`] at most. Each
    /// refusal is counted in the host's [`Tally`].
    pub fn refused(&self, host: HostId, refused: Refused) {
        let mut inner = self.write();
        let inner = &mut *inner;
        let Some(known) = inner.hosts.get_mut(&host) else {
            return;
        };
        match refused {
            Refused::Wake(_) => known.tally.refused_wakes += 1,
            Refused::Place(_) => known.tally.refused_places += 1,
        }
        let report = (
            known.target.epoch,
            known.state,
            capacity(&known.info, &known.capacity),
        );
        let full = inner.full.entry(host).or_insert_with(|| Full {
            report: report.clone(),
            refused: Vec::new(),
        });
        if full.report != report {
            *full = Full {
                report,
                refused: Vec::new(),
            };
        }
        full.refused
            .retain(|(kept, at)| at.elapsed() < FULL_FOR && *kept != refused);
        if full.refused.len() >= REFUSALS_KEPT {
            full.refused.remove(0);
        }
        full.refused.push((refused, Instant::now()));
    }

    /// Whether host `host` refused `asked` as full, or something that
    /// covers it, and has reported nothing new since, within
    /// [`FULL_FOR`].
    #[must_use]
    pub fn refuses(&self, host: HostId, asked: &Refused) -> bool {
        self.read().refuses(host, asked)
    }

    /// Where a request to `host` goes, while it is not given up on.
    #[must_use]
    pub fn target(&self, host: HostId) -> Option<Target> {
        self.read()
            .hosts
            .get(&host)
            .filter(|known| known.state != HostState::Lost)
            .map(|known| known.target.clone())
    }

    /// The name of host `host`, whatever its state.
    #[must_use]
    pub fn name(&self, host: HostId) -> Option<String> {
        self.read()
            .hosts
            .get(&host)
            .map(|known| known.target.name.clone())
    }

    /// Whether host `host` is given up on, as the view last heard.
    #[must_use]
    pub fn lost(&self, host: HostId) -> bool {
        self.read()
            .hosts
            .get(&host)
            .is_some_and(|known| known.state == HostState::Lost)
    }

    /// Whether host `host` is draining ahead of its removal.
    #[must_use]
    pub fn draining(&self, host: HostId) -> bool {
        self.read()
            .hosts
            .get(&host)
            .is_some_and(|known| known.state == HostState::Draining)
    }

    /// Whether host `host` held any sandbox when it last reported.
    #[must_use]
    pub fn holds_sandboxes(&self, host: HostId) -> bool {
        self.read()
            .hosts
            .get(&host)
            .is_some_and(|known| known.capacity.sandboxes > 0)
    }

    /// The host named `name`.
    #[must_use]
    pub fn named(&self, name: &str) -> Option<Known> {
        self.read()
            .hosts
            .values()
            .find(|known| known.target.name == name)
            .cloned()
    }

    /// The interned class named `class`, if a host of it was seen.
    #[must_use]
    pub fn class(&self, class: &str) -> Option<ClassId> {
        self.read().classes.get(class).copied()
    }

    /// Places `demand`, reaching the offers named `reach` (its own
    /// `reach` is not read), on a live host not in `exclude`, and heard
    /// renewing within the view's `silent_after`, that has not just
    /// refused it as full ([`Self::refused`]), and books it there until
    /// the host next reports. Places nothing while this replica has read
    /// no host rows within `silent_after` ([`Unplaced::Blind`]). The names
    /// are numbered under the lock placement holds, as hosts' offers are.
    ///
    /// # Errors
    ///
    /// Why it placed nothing, which for a name no host it holds offers is
    /// [`Unplaced::Unoffered`].
    pub fn place(
        &self,
        demand: &Demand,
        reach: &[String],
        exclude: &HashSet<HostId>,
    ) -> Result<Placement, Unplaced> {
        let mut inner = self.write();
        let (placement, demand) =
            Self::choose(&mut inner, self.silent_after, demand, reach, exclude)?;
        inner.fleet.reserve(placement, &demand);
        Ok(placement)
    }

    /// Whether [`Self::place`] would place `demand` now, booking nothing:
    /// what a caller waiting for room checks.
    #[must_use]
    pub fn has_room(&self, demand: &Demand, reach: &[String], exclude: &HashSet<HostId>) -> bool {
        let mut inner = self.write();
        Self::choose(&mut inner, self.silent_after, demand, reach, exclude).is_ok()
    }

    /// Where [`Self::place`] would place `demand`, and the demand with its
    /// reach numbered.
    fn choose(
        inner: &mut Inner,
        silent_after: Duration,
        demand: &Demand,
        reach: &[String],
        exclude: &HashSet<HostId>,
    ) -> Result<(Placement, Demand), Unplaced> {
        match inner.read_at.map(|at| at.elapsed()) {
            Some(since) if since <= silent_after => {}
            since => return Err(Unplaced::Blind(since)),
        }
        let demand = Demand {
            reach: inner.reach(reach)?,
            ..*demand
        };
        let passed = Self::passed(inner, silent_after, &demand);
        let placement = if passed.is_empty() {
            inner.fleet.place(&demand, exclude, &mut inner.rng)
        } else {
            let mut exclude = exclude.clone();
            exclude.extend(passed);
            inner.fleet.place(&demand, &exclude, &mut inner.rng)
        }
        .ok_or(Unplaced::NoRoom)?;
        Ok((placement, demand))
    }

    /// Whether a host outside `exclude` that [`Self::place`] may choose
    /// could take `demand`, reaching `reach`, at once by what it last
    /// reported, booking nothing. Unlike [`Self::has_room`], a host whose
    /// memory could hold it only once it makes room does not count.
    #[must_use]
    pub fn has_room_now(
        &self,
        demand: &Demand,
        reach: &[String],
        exclude: &HashSet<HostId>,
    ) -> bool {
        let mut inner = self.write();
        let inner = &mut *inner;
        if inner
            .read_at
            .is_none_or(|at| at.elapsed() > self.silent_after)
        {
            return false;
        }
        let Ok(reach) = inner.reach(reach) else {
            return false;
        };
        let demand = Demand { reach, ..*demand };
        let mut exclude = exclude.clone();
        exclude.extend(Self::passed(inner, self.silent_after, &demand));
        inner.fleet.fits_now(&demand, &exclude)
    }

    /// The hosts placement passes over for `demand`: those not heard
    /// renewing within `silent_after`, and those that just refused it as
    /// full.
    fn passed(inner: &Inner, silent_after: Duration, demand: &Demand) -> Vec<HostId> {
        let refused = Refused::Place(*demand);
        inner
            .heard
            .iter()
            .filter(|(_, (_, at))| at.elapsed() > silent_after)
            .map(|(host, _)| *host)
            .chain(
                inner
                    .full
                    .keys()
                    .copied()
                    .filter(|host| inner.refuses(*host, &refused)),
            )
            .collect()
    }

    /// Every host, by name.
    #[must_use]
    pub fn hosts(&self) -> Vec<Known> {
        let mut hosts: Vec<Known> = self.read().hosts.values().cloned().collect();
        hosts.sort_by(|a, b| a.target.name.cmp(&b.target.name));
        hosts
    }

    /// The hosts whose names `member` accepts and that the service counts
    /// on (not given up on), by name, from one read: what a host group's
    /// members are counted against for autoscaling. A name has one host.
    #[must_use]
    pub fn group(&self, member: impl Fn(&str) -> bool) -> HashMap<String, GroupHost> {
        self.read()
            .hosts
            .values()
            .filter(|known| known.state != HostState::Lost && member(&known.target.name))
            .map(|known| {
                let host = GroupHost {
                    draining: known.state == HostState::Draining,
                    memory_mib: known.info.memory_mib,
                    free_memory_mib: known
                        .capacity
                        .memory_free_mib
                        .saturating_add(known.capacity.memory_reclaimable_mib),
                    cpu_millis: known.capacity.cpu_millis,
                    free_cpu_millis: known.capacity.cpu_free_millis,
                    registered_cpu_millis: known.info.cpu_millis,
                };
                (known.target.name.clone(), host)
            })
            .collect()
    }
}

/// A host as a host group's autoscaling counts it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GroupHost {
    /// Whether it is draining ahead of removal; otherwise it is live.
    pub draining: bool,
    /// Memory in MiB it has for sandboxes.
    pub memory_mib: u64,
    /// Memory in MiB it can still promise, counting what it frees at once
    /// for a wake by ending idle VM processes whose state is saved.
    pub free_memory_mib: u64,
    /// Processor time in millicores it guarantees sandboxes now.
    pub cpu_millis: u64,
    /// Processor time in millicores it can still promise.
    pub free_cpu_millis: u64,
    /// Processor time in millicores it guaranteed sandboxes when it
    /// registered, which a new host like it starts with.
    pub registered_cpu_millis: u64,
}

/// Keeps `view` following the store's host rows, for as long as it runs.
pub async fn follow<S: Store>(view: Arc<View>, store: Arc<S>) {
    let mut tick = tokio::time::interval(FOLLOW_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // The highest change number seen, by when it was seen.
    let mut seen: VecDeque<(Instant, u64)> = VecDeque::new();
    let mut reads = 0u32;
    loop {
        tick.tick().await;
        let now = Instant::now();
        while seen.len() > 1 && seen[1].0 + OVERLAP <= now {
            seen.pop_front();
        }
        // From the highest number seen at least the overlap ago; from the
        // start every so often, and until a sample is that old.
        let after = match seen.front() {
            Some(&(when, highest))
                if !reads.is_multiple_of(FULL_EVERY) && when + OVERLAP <= now =>
            {
                highest
            }
            _ => 0,
        };
        reads = reads.wrapping_add(1);
        match store.hosts_changed(after).await {
            Ok(rows) => {
                let highest = rows
                    .iter()
                    .map(|row| row.changed)
                    .max()
                    .unwrap_or(after)
                    .max(seen.back().map_or(0, |&(_, highest)| highest));
                if after == 0 {
                    view.apply_all(&rows);
                } else {
                    view.apply(&rows);
                }
                seen.push_back((now, highest));
            }
            Err(error) => tracing::warn!(%error, "reading the hosts failed"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use compute_fleet::Prefer;

    const SILENT_AFTER: Duration = Duration::from_millis(200);

    fn demand() -> Demand {
        Demand {
            memory_mib: 1024,
            memory_max_mib: 1024,
            cpu_millis: 1000,
            disk_mib: 1024,
            reach: Offers::NONE,
            prefer: Prefer::Any,
        }
    }

    fn host(renewals: u64) -> HostRow {
        HostRow {
            id: HostId(1),
            info: Described {
                name: "host-1".to_owned(),
                address: "10.0.0.1:8443".to_owned(),
                zone: "zone-a".to_owned(),
                profile: "nested".to_owned(),
                cpu_template: "none".to_owned(),
                memory_mib: 16 * 1024,
                cpu_millis: 8000,
                disk_mib: 100 * 1024,
                offers: Vec::new(),
                boot: None,
            },
            epoch: HostEpoch(1),
            state: HostState::Live,
            renewals,
            seq: renewals,
            capacity: Reported {
                memory_free_mib: 16 * 1024,
                cpu_millis: 8000,
                cpu_free_millis: 8000,
                disk_free_mib: 100 * 1024,
                ..Reported::default()
            },
            run: None,
            restarts: 0,
            changed: renewals,
        }
    }

    #[test]
    fn a_replica_that_has_read_no_hosts_yet_is_blind_not_full() {
        let view = View::new(1, SILENT_AFTER);
        assert_eq!(
            view.place(&demand(), &[], &HashSet::new()),
            Err(Unplaced::Blind(None))
        );
        // A read that finds no hosts at all is a fleet with no room.
        view.apply_all(&[]);
        assert_eq!(
            view.place(&demand(), &[], &HashSet::new()),
            Err(Unplaced::NoRoom)
        );
    }

    #[test]
    fn a_replica_whose_reads_stopped_is_blind_until_it_reads_again() {
        let view = View::new(1, SILENT_AFTER);
        view.apply_all(&[host(1)]);
        let placed = view.place(&demand(), &[], &HashSet::new()).unwrap();
        assert_eq!(placed.host, HostId(1));
        std::thread::sleep(SILENT_AFTER + Duration::from_millis(50));
        // Every host now looks silent, but only because this replica read
        // nothing: it says so rather than that no host has room.
        match view.place(&demand(), &[], &HashSet::new()) {
            Err(Unplaced::Blind(Some(since))) => assert!(since > SILENT_AFTER, "{since:?}"),
            other => panic!("expected a blind view, got {other:?}"),
        }
        // A read that shows the host renewing places on it again.
        view.apply(&[host(2)]);
        assert_eq!(
            view.place(&demand(), &[], &HashSet::new())
                .map(|placed| placed.host),
            Ok(HostId(1))
        );
    }

    /// Disk a host frees by disk relief counts as free: a host whose free
    /// disk is short of a sandbox's fits it now once relief covers the
    /// rest, ahead of a host that does not fit now.
    #[test]
    fn disk_a_host_frees_by_relief_counts_as_free() {
        let mut short = host(1);
        short.capacity.disk_free_mib = 512;
        let free = |row: &HostRow| capacity(&row.info, &row.capacity).free_disk_mib;
        assert_eq!(free(&short), 512);
        short.capacity.disk_reclaimable_mib = 512;
        assert_eq!(free(&short), 1024);
        // The other host has no memory free now, so only the host that
        // frees disk fits now.
        let mut busy = host(1);
        busy.id = HostId(2);
        busy.info.name = "host-2".to_owned();
        busy.capacity.memory_free_mib = 0;
        let view = View::new(1, SILENT_AFTER);
        view.apply_all(&[short, busy]);
        for _ in 0..16 {
            assert_eq!(
                view.place(&demand(), &[], &HashSet::new())
                    .map(|placed| placed.host),
                Ok(HostId(1))
            );
        }
    }

    #[test]
    fn a_replica_that_reads_but_hears_no_renewal_passes_the_host_over() {
        let view = View::new(1, SILENT_AFTER);
        view.apply_all(&[host(1)]);
        std::thread::sleep(SILENT_AFTER + Duration::from_millis(50));
        // The replica reads on, but the host's count stands still: the
        // host is silent, and nothing else has room.
        view.apply(&[]);
        assert_eq!(
            view.place(&demand(), &[], &HashSet::new()),
            Err(Unplaced::NoRoom)
        );
    }

    fn names(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    /// Host `id`, named `host-<id>`, offering `offers`.
    fn offering(id: u64, offers: &[&str]) -> HostRow {
        let mut row = host(1);
        row.id = HostId(id);
        row.info.name = format!("host-{id}");
        row.info.offers = names(offers);
        row
    }

    /// Offer names are numbered as hosts are read, the same name the same
    /// number on every host; a sandbox that asks for one goes only to a
    /// host that offers it, and one no host offers is said to be so.
    #[test]
    fn a_sandbox_reaching_an_offer_goes_to_a_host_that_offers_it() {
        let view = View::new(1, SILENT_AFTER);
        let previews = names(&["previews"]);
        assert_eq!(
            view.place(&demand(), &previews, &HashSet::new()),
            Err(Unplaced::Blind(None))
        );
        view.apply_all(&[offering(1, &[]), offering(2, &["builds", "previews"])]);
        assert_eq!(
            view.place(&demand(), &names(&["other"]), &HashSet::new()),
            Err(Unplaced::Unoffered("other".to_owned()))
        );
        for _ in 0..50 {
            let placed = view.place(&demand(), &previews, &HashSet::new()).unwrap();
            assert_eq!(placed.host, HostId(2));
        }
        assert_eq!(
            view.place(&demand(), &previews, &HashSet::from([HostId(2)])),
            Err(Unplaced::NoRoom)
        );
    }

    /// Past the 64 offer names placement tells apart, a host's further
    /// offers are left out, so it is never chosen for them, until a name
    /// no host offers any longer gives its number back.
    #[test]
    fn offers_past_what_placement_tells_apart_wait_for_a_free_number() {
        let view = View::new(1, SILENT_AFTER);
        let many: Vec<String> = (0..MAX_OFFERS).map(|n| format!("o{n}")).collect();
        let mut first = offering(1, &[]);
        first.info.offers.clone_from(&many);
        view.apply_all(&[first.clone(), offering(2, &["o3", "late"])]);
        let late = names(&["late"]);
        assert_eq!(
            view.place(&demand(), &late, &HashSet::new()),
            Err(Unplaced::Unoffered("late".to_owned()))
        );
        assert_eq!(
            view.place(&demand(), &names(&["o3"]), &HashSet::from([HostId(1)]))
                .map(|placed| placed.host),
            Ok(HostId(2))
        );

        // The first host stops offering o5: once the second is read
        // again, late has its number, and o5 is no longer offered.
        first.info.offers.retain(|name| name != "o5");
        view.apply(&[first]);
        view.apply(&[offering(2, &["o3", "late"])]);
        assert_eq!(
            view.place(&demand(), &late, &HashSet::new())
                .map(|placed| placed.host),
            Ok(HostId(2))
        );
        assert_eq!(
            view.place(&demand(), &names(&["o5"]), &HashSet::new()),
            Err(Unplaced::Unoffered("o5".to_owned()))
        );
    }

    /// Names only hosts gone from the store offered give their numbers
    /// back: offers retired over time never use up the 64.
    #[test]
    fn retired_offers_give_their_numbers_back() {
        let view = View::new(1, SILENT_AFTER);
        let mut retired = offering(1, &[]);
        retired.info.offers = (0..MAX_OFFERS).map(|n| format!("retired-{n}")).collect();
        view.apply_all(&[retired]);
        view.apply_all(&[]);
        view.apply_all(&[offering(2, &["previews"])]);
        assert_eq!(
            view.place(&demand(), &names(&["previews"]), &HashSet::new())
                .map(|placed| placed.host),
            Ok(HostId(2))
        );
        assert_eq!(
            view.place(&demand(), &names(&["retired-0"]), &HashSet::new()),
            Err(Unplaced::Unoffered("retired-0".to_owned()))
        );
    }

    /// A host that no longer offers a name, read again, is not counted
    /// for it: a sandbox asking for it is told no host offers it.
    #[test]
    fn an_offer_a_host_withdraws_is_no_longer_offered() {
        let view = View::new(1, SILENT_AFTER);
        view.apply_all(&[offering(1, &["previews"])]);
        view.apply(&[offering(1, &[])]);
        assert_eq!(
            view.place(&demand(), &names(&["previews"]), &HashSet::new()),
            Err(Unplaced::Unoffered("previews".to_owned()))
        );
    }

    #[test]
    fn a_host_that_refused_as_full_is_passed_over_until_its_report_changes() {
        let view = View::new(1, Duration::from_secs(60));
        view.apply_all(&[host(1)]);
        let none = HashSet::new();
        let placed = view.place(&demand(), &[], &none).unwrap();
        view.refused(placed.host, Refused::Place(demand()));
        // Passed over for as much or more, though by its report it fits.
        assert_eq!(view.place(&demand(), &[], &none), Err(Unplaced::NoRoom));
        let more = Demand {
            memory_mib: 2048,
            memory_max_mib: 2048,
            ..demand()
        };
        assert!(!view.has_room(&more, &[], &none));
        // Not for less, nor for another kind of request.
        let less = Demand {
            disk_mib: 512,
            ..demand()
        };
        assert!(view.has_room(&less, &[], &none));
        let create = Demand {
            prefer: Prefer::ReadyClone(ShapeKey(1)),
            ..demand()
        };
        assert!(view.has_room(&create, &[], &none));
        // A renewal that reports the same leaves it refused.
        view.apply(&[host(2)]);
        assert!(!view.has_room(&demand(), &[], &none));
        assert!(view.refuses(HostId(1), &Refused::Place(more)));
        // One that reports otherwise could have room.
        let mut changed = host(3);
        changed.capacity.disk_free_mib -= 1;
        view.apply(&[changed]);
        assert!(view.has_room(&demand(), &[], &none));
        assert!(!view.refuses(HostId(1), &Refused::Place(demand())));

        // A wake refused is that sandbox's alone.
        let refused = Id(compute_fleet::SandboxId(7));
        view.refused(HostId(1), Refused::Wake(refused));
        assert!(view.refuses(HostId(1), &Refused::Wake(refused)));
        assert!(!view.refuses(HostId(1), &Refused::Wake(Id(compute_fleet::SandboxId(8)))));
        assert!(view.has_room(&demand(), &[], &none));
        // A host forgotten forgets what it refused.
        view.apply_all(&[]);
        assert!(!view.refuses(HostId(1), &Refused::Wake(refused)));
    }

    fn tally(view: &View) -> Tally {
        view.hosts()
            .into_iter()
            .find(|known| known.target.host == HostId(1))
            .map(|known| known.tally)
            .unwrap()
    }

    /// A host's fresh registrations, which a rebooted host makes, are
    /// counted as the view reads them under a later epoch, renewals and
    /// reports under the same one are not, and neither is the first
    /// read; each refusal as full is counted by its kind.
    #[test]
    fn a_host_s_fresh_registrations_and_refusals_are_tallied() {
        let view = View::new(1, Duration::from_secs(60));
        // Read first under a later epoch than 1: not a registration.
        let mut first = host(1);
        first.epoch = HostEpoch(5);
        view.apply_all(&[first.clone()]);
        assert_eq!(tally(&view), Tally::default());

        // Renewals and reports under the same epoch.
        for renewals in 2..5 {
            let mut row = host(renewals);
            row.epoch = HostEpoch(5);
            view.apply(&[row]);
        }
        assert_eq!(tally(&view).registrations, 0);

        // The host registers afresh: a new epoch, twice.
        let mut again = host(5);
        again.epoch = HostEpoch(9);
        view.apply(&[again.clone()]);
        // Read again, as the next read's overlap or a full read does.
        view.apply_all(&[again]);
        let mut third = host(6);
        third.epoch = HostEpoch(12);
        view.apply(&[third]);
        assert_eq!(tally(&view).registrations, 2);

        view.refused(HostId(1), Refused::Wake(Id(compute_fleet::SandboxId(7))));
        view.refused(HostId(1), Refused::Wake(Id(compute_fleet::SandboxId(8))));
        view.refused(HostId(1), Refused::Place(demand()));
        // A host the view does not hold counts nothing.
        view.refused(HostId(2), Refused::Place(demand()));
        assert_eq!(
            tally(&view),
            Tally {
                registrations: 2,
                refused_wakes: 2,
                refused_places: 1,
            }
        );

        // A host forgotten and read again starts its tally afresh.
        view.apply_all(&[]);
        view.apply_all(&[first]);
        assert_eq!(tally(&view), Tally::default());
    }
}
