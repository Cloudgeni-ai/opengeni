//! The capacity view and placement.
//!
//! Hosts push their capacity with their lease renewals; each service
//! replica keeps this view of it in memory and places new and adopted
//! sandboxes from it alone, so placement costs no round trip. The view is
//! a little stale by design: a host that cannot fit what it is sent
//! refuses it, and the sandbox goes to the next candidate.
//!
//! Placement draws two random hosts that fit, from different zones when it
//! can, and takes the better: one with a ready clone of the shape first,
//! then the one with more free memory. Drawing two keeps load even without
//! herding every request onto the single emptiest host, and costs the same
//! at five thousand hosts as at five.

use std::collections::BTreeMap;

use crate::ids::{ClassId, HostId, ShapeKey, ZoneId};
use crate::rng::Rng;

/// What placement needs to know about a host that does not change while it
/// is registered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct HostInfo {
    /// Its failure domain.
    pub zone: ZoneId,
    /// Which hosts its saved memory images restore on.
    pub class: ClassId,
    /// Whether it backs guest memory with huge pages, and so reserves a
    /// sandbox's whole memory rather than what it requests.
    pub huge_pages: bool,
}

/// Whether placement may use a host.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HostState {
    /// Takes new and adopted sandboxes.
    Live,
    /// Keeps what it has but takes nothing new, ahead of removal.
    Draining,
    /// Gave up on: its lease ran out.
    Lost,
}

/// What a host can still take, as it last reported.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Capacity {
    /// Memory in MiB it has for sandboxes in all.
    pub memory_mib: u64,
    /// Memory in MiB it can still promise to sandboxes that wake, beyond
    /// what it keeps spare.
    pub free_memory_mib: u64,
    /// Disk in MiB it can still promise.
    pub free_disk_mib: u64,
    /// Ready clones it holds, by shape.
    pub ready: Vec<(ShapeKey, u32)>,
    /// Sandboxes it holds at any level.
    pub sandboxes: u32,
}

/// What a sandbox to place needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Demand {
    /// Memory in MiB it is guaranteed while awake.
    pub memory_mib: u64,
    /// All its guest memory in MiB, which a host on huge pages reserves.
    pub memory_max_mib: u64,
    /// Disk in MiB it needs.
    pub disk_mib: u64,
    /// The hosts it would rather go to.
    pub prefer: Prefer,
}

/// The hosts a sandbox to place would rather go to: one kind of preference
/// at a time, so a ready clone never outweighs the class a memory image
/// needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Prefer {
    /// Any host that fits.
    Any,
    /// For a create: one with a ready clone of this shape.
    ReadyClone(ShapeKey),
    /// For an adopt of a saved memory image: one of the class it restores
    /// on. Anywhere else the sandbox boots afresh from its files and loses
    /// its programs.
    Class(ClassId),
}

impl Demand {
    fn shape(&self) -> Option<ShapeKey> {
        match self.prefer {
            Prefer::ReadyClone(shape) => Some(shape),
            Prefer::Any | Prefer::Class(_) => None,
        }
    }

    fn class(&self) -> Option<ClassId> {
        match self.prefer {
            Prefer::Class(class) => Some(class),
            Prefer::Any | Prefer::ReadyClone(_) => None,
        }
    }

    fn memory_on(&self, info: HostInfo) -> u64 {
        if info.huge_pages {
            self.memory_max_mib
        } else {
            self.memory_mib
        }
    }
}

/// Where a sandbox goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Placement {
    /// The host.
    pub host: HostId,
    /// Whether the host had a ready clone of the shape.
    pub ready: bool,
    /// Whether the host is of the class the demand asked for, if any.
    pub same_class: bool,
}

#[derive(Clone, Debug)]
struct Slot {
    id: HostId,
    info: HostInfo,
    state: HostState,
    capacity: Capacity,
}

/// A set of slot numbers with constant-time insert, remove and random
/// choice.
#[derive(Clone, Debug, Default)]
struct Pool {
    items: Vec<u32>,
    positions: BTreeMap<u32, usize>,
}

impl Pool {
    fn insert(&mut self, slot: u32) {
        if let std::collections::btree_map::Entry::Vacant(entry) = self.positions.entry(slot) {
            entry.insert(self.items.len());
            self.items.push(slot);
        }
    }

    fn remove(&mut self, slot: u32) {
        if let Some(position) = self.positions.remove(&slot) {
            self.items.swap_remove(position);
            if let Some(&moved) = self.items.get(position) {
                self.positions.insert(moved, position);
            }
        }
    }

    fn len(&self) -> usize {
        self.items.len()
    }
}

/// How many random draws placement makes from a pool before it walks the
/// whole pool for hosts that fit.
const DRAWS: usize = 12;

/// The fleet as one replica sees it.
#[derive(Clone, Debug, Default)]
pub struct Fleet {
    slots: Vec<Option<Slot>>,
    by_id: BTreeMap<HostId, u32>,
    vacant: Vec<u32>,
    live: Pool,
    by_class: BTreeMap<ClassId, Pool>,
    ready: BTreeMap<ShapeKey, Pool>,
}

impl Fleet {
    /// An empty view.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Hosts in the view, in any state.
    #[must_use]
    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    /// Whether the view has no hosts.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }

    /// Adds a host or replaces what the view holds about it.
    ///
    /// # Panics
    ///
    /// If the view would hold four billion hosts.
    pub fn upsert(&mut self, id: HostId, info: HostInfo, state: HostState, capacity: Capacity) {
        if let Some(&slot) = self.by_id.get(&id) {
            self.unindex(slot);
            self.slots[slot as usize] = Some(Slot {
                id,
                info,
                state,
                capacity,
            });
            self.index(slot);
            return;
        }
        let slot = self.vacant.pop().unwrap_or_else(|| {
            self.slots.push(None);
            u32::try_from(self.slots.len() - 1).expect("fewer than four billion hosts")
        });
        self.slots[slot as usize] = Some(Slot {
            id,
            info,
            state,
            capacity,
        });
        self.by_id.insert(id, slot);
        self.index(slot);
    }

    /// Replaces a host's capacity; does nothing for a host not in the view.
    pub fn update(&mut self, id: HostId, capacity: Capacity) {
        if let Some(&slot) = self.by_id.get(&id) {
            self.unindex(slot);
            if let Some(entry) = self.slots[slot as usize].as_mut() {
                entry.capacity = capacity;
            }
            self.index(slot);
        }
    }

    /// Changes a host's state; does nothing for a host not in the view.
    pub fn set_state(&mut self, id: HostId, state: HostState) {
        if let Some(&slot) = self.by_id.get(&id) {
            self.unindex(slot);
            if let Some(entry) = self.slots[slot as usize].as_mut() {
                entry.state = state;
            }
            self.index(slot);
        }
    }

    /// Forgets a host.
    pub fn remove(&mut self, id: HostId) {
        if let Some(slot) = self.by_id.remove(&id) {
            self.unindex(slot);
            self.slots[slot as usize] = None;
            self.vacant.push(slot);
        }
    }

    /// A host's state and capacity, if it is in the view.
    #[must_use]
    pub fn get(&self, id: HostId) -> Option<(HostInfo, HostState, &Capacity)> {
        let slot = self.by_id.get(&id)?;
        self.slots[*slot as usize]
            .as_ref()
            .map(|entry| (entry.info, entry.state, &entry.capacity))
    }

    /// Every host in the view, in no particular order.
    pub fn hosts(&self) -> impl Iterator<Item = (HostId, HostInfo, HostState, &Capacity)> {
        self.slots
            .iter()
            .flatten()
            .map(|entry| (entry.id, entry.info, entry.state, &entry.capacity))
    }

    /// Counts what was just sent to `id` against its capacity until it next
    /// reports, so requests placed before then spread to other hosts.
    pub fn reserve(&mut self, placement: Placement, demand: &Demand) {
        let Some(&slot) = self.by_id.get(&placement.host) else {
            return;
        };
        self.unindex(slot);
        if let Some(entry) = self.slots[slot as usize].as_mut() {
            let capacity = &mut entry.capacity;
            capacity.free_memory_mib = capacity
                .free_memory_mib
                .saturating_sub(demand.memory_on(entry.info));
            capacity.free_disk_mib = capacity.free_disk_mib.saturating_sub(demand.disk_mib);
            capacity.sandboxes = capacity.sandboxes.saturating_add(1);
            if placement.ready
                && let Some(shape) = demand.shape()
                && let Some((_, count)) = capacity.ready.iter_mut().find(|(key, _)| *key == shape)
            {
                *count = count.saturating_sub(1);
            }
        }
        self.index(slot);
    }

    /// Chooses a live host for `demand`, other than those in `exclude`
    /// (hosts that already refused it). `None` when no host fits.
    pub fn place(&self, demand: &Demand, exclude: &[HostId], rng: &mut Rng) -> Option<Placement> {
        let fits = |slot: u32| {
            self.slots[slot as usize].as_ref().is_some_and(|entry| {
                entry.state == HostState::Live
                    && !exclude.contains(&entry.id)
                    && entry.capacity.free_memory_mib >= demand.memory_on(entry.info)
                    && entry.capacity.free_disk_mib >= demand.disk_mib
            })
        };
        let pools = [
            demand.shape().and_then(|shape| self.ready.get(&shape)),
            demand.class().and_then(|class| self.by_class.get(&class)),
            Some(&self.live),
        ];
        let chosen = pools
            .into_iter()
            .flatten()
            .find_map(|pool| self.best_of_two(pool, &fits, demand, rng))?;
        let entry = self.slots[chosen as usize].as_ref()?;
        Some(Placement {
            host: entry.id,
            ready: has_ready(entry, demand),
            same_class: demand
                .class()
                .is_some_and(|class| class == entry.info.class),
        })
    }

    /// The better of two hosts from `pool` that fit, from different zones
    /// when it finds such; `None` when none fits.
    fn best_of_two(
        &self,
        pool: &Pool,
        fits: &impl Fn(u32) -> bool,
        demand: &Demand,
        rng: &mut Rng,
    ) -> Option<u32> {
        if pool.len() == 0 {
            return None;
        }
        let zone = |slot: u32| {
            self.slots[slot as usize]
                .as_ref()
                .map(|entry| entry.info.zone)
        };
        let mut first = None;
        let mut second = None;
        for _ in 0..DRAWS {
            let slot = pool.items[rng.index(pool.len())];
            if !fits(slot) {
                continue;
            }
            match first {
                None => first = Some(slot),
                Some(chosen) if chosen == slot => {}
                Some(chosen) => {
                    if zone(chosen) != zone(slot) {
                        second = Some(slot);
                        break;
                    }
                    // Same zone: keep it unless one from another turns up.
                    second.get_or_insert(slot);
                }
            }
        }
        if first.is_none() {
            // Few hosts fit: walk the pool from a random place for any.
            let start = rng.index(pool.len());
            let mut found = (0..pool.len())
                .map(|step| pool.items[(start + step) % pool.len()])
                .filter(|&slot| fits(slot));
            first = found.next();
            second = found.next();
        }
        let first = first?;
        Some(match second {
            Some(second) if self.better(second, first, demand) => second,
            _ => first,
        })
    }

    /// Whether host `a` suits `demand` better than host `b`.
    fn better(&self, a: u32, b: u32, demand: &Demand) -> bool {
        let key = |slot: u32| {
            self.slots[slot as usize]
                .as_ref()
                .map(|entry| (has_ready(entry, demand), entry.capacity.free_memory_mib))
        };
        key(a) > key(b)
    }

    /// The live host matching `filter` with the fewest sandboxes, to drain
    /// first when a group shrinks.
    pub fn emptiest(&self, filter: impl Fn(&HostInfo) -> bool) -> Option<HostId> {
        self.slots
            .iter()
            .flatten()
            .filter(|entry| entry.state == HostState::Live && filter(&entry.info))
            .min_by_key(|entry| (entry.capacity.sandboxes, entry.id))
            .map(|entry| entry.id)
    }

    fn index(&mut self, slot: u32) {
        let Some(entry) = self.slots[slot as usize].as_ref() else {
            return;
        };
        if entry.state != HostState::Live {
            return;
        }
        self.live.insert(slot);
        self.by_class
            .entry(entry.info.class)
            .or_default()
            .insert(slot);
        for (shape, count) in &entry.capacity.ready {
            if *count > 0 {
                self.ready.entry(*shape).or_default().insert(slot);
            }
        }
    }

    fn unindex(&mut self, slot: u32) {
        let Some(entry) = self.slots[slot as usize].as_ref() else {
            return;
        };
        self.live.remove(slot);
        if let Some(pool) = self.by_class.get_mut(&entry.info.class) {
            pool.remove(slot);
            if pool.len() == 0 {
                self.by_class.remove(&entry.info.class);
            }
        }
        for (shape, _) in &entry.capacity.ready {
            if let Some(pool) = self.ready.get_mut(shape) {
                pool.remove(slot);
                if pool.len() == 0 {
                    self.ready.remove(shape);
                }
            }
        }
    }
}

fn has_ready(entry: &Slot, demand: &Demand) -> bool {
    demand.shape().is_some_and(|shape| {
        entry
            .capacity
            .ready
            .iter()
            .any(|(key, count)| *key == shape && *count > 0)
    })
}

#[cfg(test)]
mod tests;
