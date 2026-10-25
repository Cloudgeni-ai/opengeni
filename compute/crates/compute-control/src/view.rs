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

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::{Duration, Instant};

use compute_fleet::{
    Capacity, ClassId, Demand, Fleet, HostEpoch, HostId, HostInfo, HostState, Placement, Rng,
    ShapeKey, ZoneId,
};
use compute_protocol::fleet::{Capacity as Reported, HostInfo as Described};

use crate::store::{HostRow, Store};

/// How often a replica reads changed host rows.
pub const FOLLOW_EVERY: Duration = Duration::from_millis(250);

/// How far back each read starts: commits that land later than this after
/// their change number was taken wait for the next full read.
const OVERLAP: Duration = Duration::from_secs(2);

/// How many reads go between two reads of every row.
const FULL_EVERY: u32 = 40;

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
}

#[derive(Debug)]
struct Inner {
    fleet: Fleet,
    hosts: HashMap<HostId, Known>,
    zones: HashMap<String, ZoneId>,
    classes: HashMap<String, ClassId>,
    rng: Rng,
}

/// The hosts, as this replica last read them.
#[derive(Debug)]
pub struct View {
    inner: RwLock<Inner>,
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
        free_cpu_millis: reported.cpu_free_millis,
        free_disk_mib: reported.disk_free_mib,
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
    /// An empty view, placing with randomness from `seed`.
    #[must_use]
    pub fn new(seed: u64) -> Self {
        Self {
            inner: RwLock::new(Inner {
                fleet: Fleet::new(),
                hosts: HashMap::new(),
                zones: HashMap::new(),
                classes: HashMap::new(),
                rng: Rng::new(seed),
            }),
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

    /// Takes in host rows as read from the store.
    pub fn apply(&self, rows: &[HostRow]) {
        let mut inner = self.write();
        for row in rows {
            let zone = intern(&mut inner.zones, &row.info.zone, ZoneId);
            let class_name = class_key(&row.info);
            let class = intern(&mut inner.classes, &class_name, ClassId);
            let info = HostInfo {
                zone,
                class,
                huge_pages: row.info.profile == "nested",
            };
            inner
                .fleet
                .upsert(row.id, info, row.state, capacity(&row.info, &row.capacity));
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
            inner.fleet.remove(host);
        }
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

    /// Places `demand` on a live host not in `exclude` and books it there
    /// until the host next reports.
    pub fn place(&self, demand: &Demand, exclude: &HashSet<HostId>) -> Option<Placement> {
        let mut inner = self.write();
        let inner = &mut *inner;
        let placement = inner.fleet.place(demand, exclude, &mut inner.rng)?;
        inner.fleet.reserve(placement, demand);
        Some(placement)
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
