//! A store in memory, for tests and a fleet of one service replica that
//! can afford to forget everything when it stops.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use compute_fleet::{HostEpoch, HostId, HostState};
use compute_protocol::fleet::{Register, Renew, Report, Ruling};
use compute_protocol::host::Id;

use super::{Admission, Admits, HostRow, Result, SandboxRow, Store, admits, rule};

#[derive(Debug)]
struct Host {
    row: HostRow,
    attempt: u64,
    answer: Vec<Ruling>,
}

#[derive(Debug, Default)]
struct Inner {
    hosts: BTreeMap<HostId, Host>,
    by_name: HashMap<String, HostId>,
    sandboxes: BTreeMap<Id, SandboxRow>,
    keys: HashMap<String, String>,
    next_host: u64,
    next_host_epoch: u64,
    changes: u64,
}

impl Inner {
    fn change(&mut self) -> u64 {
        self.changes += 1;
        self.changes
    }

    /// The live or draining host `id` named one of `names`, under `epoch`.
    fn current(&mut self, id: u64, epoch: u64, names: &[String]) -> Option<&mut HostRow> {
        let host = self.hosts.get_mut(&HostId(id))?;
        let row = &mut host.row;
        (row.epoch == HostEpoch(epoch)
            && row.state != HostState::Lost
            && names.contains(&row.info.name))
        .then_some(row)
    }
}

/// Everything in memory, behind one lock.
#[derive(Clone, Debug, Default)]
pub struct MemoryStore {
    inner: Arc<Mutex<Inner>>,
    leader: Arc<AtomicBool>,
}

/// The leadership of a [`MemoryStore`], given up when dropped.
#[derive(Debug)]
pub struct MemoryLead(Arc<AtomicBool>);

impl Drop for MemoryLead {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl MemoryStore {
    /// An empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // Every write completes under the lock, so one that panicked left
        // nothing half done.
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn register_now(&self, register: &Register) -> Admission {
        let mut inner = self.lock();
        let known = inner.by_name.get(&register.info.name).copied();
        let row = known
            .and_then(|id| inner.hosts.get(&id))
            .map(|host| (host.row.state, host.attempt));
        match admits(row, register.attempt) {
            Admits::Again => {
                let host = &inner.hosts[&known.expect("a row")];
                return Admission::Registered {
                    host: host.row.id,
                    epoch: host.row.epoch,
                    rulings: host.answer.clone(),
                };
            }
            Admits::StillLive => return Admission::StillLive,
            Admits::Fresh => {}
        }
        let id = known.unwrap_or_else(|| {
            inner.next_host += 1;
            HostId(inner.next_host)
        });
        inner.next_host_epoch += 1;
        let epoch = HostEpoch(inner.next_host_epoch);
        let mut rulings = Vec::with_capacity(register.held.len());
        for held in &register.held {
            let row = inner.sandboxes.get(&held.id).map(|row| row.ownership);
            let (ruling, change) = rule(id, *held, row);
            if let Some(change) = change {
                let sandbox = inner.sandboxes.get_mut(&held.id).expect("ruled on a row");
                sandbox.ownership = change.set;
                sandbox.version += 1;
            }
            rulings.push(ruling);
        }
        let renewals = inner.hosts.get(&id).map_or(0, |host| host.row.renewals) + 1;
        let changed = inner.change();
        inner.by_name.insert(register.info.name.clone(), id);
        inner.hosts.insert(
            id,
            Host {
                row: HostRow {
                    id,
                    info: register.info.clone(),
                    epoch,
                    state: HostState::Live,
                    renewals,
                    seq: 0,
                    capacity: register.capacity.clone(),
                    changed,
                },
                attempt: register.attempt,
                answer: rulings.clone(),
            },
        );
        Admission::Registered {
            host: id,
            epoch,
            rulings,
        }
    }
}

impl Store for MemoryStore {
    type Lead = MemoryLead;

    async fn register(&self, register: &Register) -> Result<Admission> {
        Ok(self.register_now(register))
    }

    async fn renew(&self, renew: &Renew, names: &[String]) -> Result<bool> {
        let mut inner = self.lock();
        let changed = inner.changes + 1;
        let Some(row) = inner.current(renew.host, renew.epoch, names) else {
            return Ok(false);
        };
        row.renewals += 1;
        row.seq = row.seq.max(renew.seq);
        row.capacity = renew.capacity.clone();
        row.changed = changed;
        inner.changes = changed;
        Ok(true)
    }

    async fn report(&self, report: &Report, names: &[String]) -> Result<bool> {
        let mut inner = self.lock();
        let changed = inner.changes + 1;
        let Some(row) = inner.current(report.host, report.epoch, names) else {
            return Ok(false);
        };
        row.capacity = report.capacity.clone();
        row.changed = changed;
        inner.changes = changed;
        Ok(true)
    }

    async fn hosts_changed(&self, after: u64) -> Result<Vec<HostRow>> {
        let inner = self.lock();
        let mut rows: Vec<HostRow> = inner
            .hosts
            .values()
            .filter(|host| host.row.changed > after)
            .map(|host| host.row.clone())
            .collect();
        rows.sort_by_key(|row| row.changed);
        Ok(rows)
    }

    async fn renewals(&self) -> Result<Vec<(HostId, u64)>> {
        let inner = self.lock();
        Ok(inner
            .hosts
            .values()
            .filter(|host| host.row.state != HostState::Lost)
            .map(|host| (host.row.id, host.row.renewals))
            .collect())
    }

    async fn give_up(&self, host: HostId, renewals: u64) -> Result<Option<usize>> {
        let mut inner = self.lock();
        let changed = inner.changes + 1;
        let Some(entry) = inner.hosts.get_mut(&host) else {
            return Ok(None);
        };
        if entry.row.state == HostState::Lost || entry.row.renewals != renewals {
            return Ok(None);
        }
        entry.row.state = HostState::Lost;
        entry.row.changed = changed;
        inner.changes = changed;
        let mut cleared = 0;
        for sandbox in inner.sandboxes.values_mut() {
            if sandbox.ownership.owner == Some(host) {
                sandbox.ownership = sandbox.ownership.clear().set;
                sandbox.version += 1;
                cleared += 1;
            }
        }
        Ok(Some(cleared))
    }

    async fn set_state(&self, host: HostId, from: HostState, to: HostState) -> Result<bool> {
        let mut inner = self.lock();
        let changed = inner.changes + 1;
        let Some(entry) = inner.hosts.get_mut(&host) else {
            return Ok(false);
        };
        if entry.row.state != from {
            return Ok(false);
        }
        entry.row.state = to;
        entry.row.changed = changed;
        inner.changes = changed;
        Ok(true)
    }

    async fn try_lead(&self) -> Result<Option<MemoryLead>> {
        let taken = self
            .leader
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok();
        Ok(taken.then(|| MemoryLead(Arc::clone(&self.leader))))
    }

    async fn leads(&self, _lead: &mut MemoryLead) -> bool {
        true
    }

    async fn insert(&self, row: &SandboxRow) -> Result<bool> {
        let mut inner = self.lock();
        if inner.sandboxes.contains_key(&row.id) {
            return Ok(false);
        }
        inner.sandboxes.insert(row.id, row.clone());
        Ok(true)
    }

    async fn sandbox(&self, id: Id) -> Result<Option<SandboxRow>> {
        Ok(self.lock().sandboxes.get(&id).cloned())
    }

    async fn replace(&self, row: &SandboxRow) -> Result<bool> {
        let mut inner = self.lock();
        let Some(stored) = inner.sandboxes.get_mut(&row.id) else {
            return Ok(false);
        };
        if stored.version != row.version {
            return Ok(false);
        }
        *stored = row.clone();
        stored.version += 1;
        Ok(true)
    }

    async fn delete(&self, id: Id, version: u64) -> Result<bool> {
        let mut inner = self.lock();
        if inner
            .sandboxes
            .get(&id)
            .is_none_or(|row| row.version != version)
        {
            return Ok(false);
        }
        inner.sandboxes.remove(&id);
        Ok(true)
    }

    async fn list(
        &self,
        team: &str,
        metadata: &BTreeMap<String, String>,
    ) -> Result<Vec<SandboxRow>> {
        let inner = self.lock();
        Ok(inner
            .sandboxes
            .values()
            .filter(|row| row.team == team)
            .filter(|row| {
                metadata
                    .iter()
                    .all(|(key, value)| row.metadata.get(key) == Some(value))
            })
            .cloned()
            .collect())
    }

    async fn owned_by(&self, host: HostId) -> Result<Vec<SandboxRow>> {
        let inner = self.lock();
        Ok(inner
            .sandboxes
            .values()
            .filter(|row| row.ownership.owner == Some(host))
            .cloned()
            .collect())
    }

    async fn team_of(&self, digest: &str) -> Result<Option<String>> {
        Ok(self.lock().keys.get(digest).cloned())
    }

    async fn add_key(&self, digest: &str, team: &str) -> Result<()> {
        self.lock().keys.insert(digest.to_owned(), team.to_owned());
        Ok(())
    }
}
