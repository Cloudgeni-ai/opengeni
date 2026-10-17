//! A store in memory, for tests and a fleet of one service replica that
//! can afford to forget everything when it stops.

use std::collections::{BTreeMap, HashMap};
use std::future::{Future, ready};
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

/// The store's operations, done at once.
impl MemoryStore {
    fn renew_now(&self, renew: &Renew, names: &[String]) -> bool {
        let mut inner = self.lock();
        let changed = inner.changes + 1;
        let Some(row) = inner.current(renew.host, renew.epoch, names) else {
            return false;
        };
        row.renewals += 1;
        row.seq = row.seq.max(renew.seq);
        row.capacity = renew.capacity.clone();
        row.changed = changed;
        inner.changes = changed;
        true
    }

    fn report_now(&self, report: &Report, names: &[String]) -> bool {
        let mut inner = self.lock();
        let changed = inner.changes + 1;
        let Some(row) = inner.current(report.host, report.epoch, names) else {
            return false;
        };
        row.capacity = report.capacity.clone();
        row.changed = changed;
        inner.changes = changed;
        true
    }

    fn hosts_changed_now(&self, after: u64) -> Vec<HostRow> {
        let inner = self.lock();
        let mut rows: Vec<HostRow> = inner
            .hosts
            .values()
            .filter(|host| host.row.changed > after)
            .map(|host| host.row.clone())
            .collect();
        rows.sort_by_key(|row| row.changed);
        rows
    }

    fn renewals_now(&self) -> Vec<(HostId, u64)> {
        let inner = self.lock();
        inner
            .hosts
            .values()
            .filter(|host| host.row.state != HostState::Lost)
            .map(|host| (host.row.id, host.row.renewals))
            .collect()
    }

    fn give_up_now(&self, host: HostId, renewals: u64) -> Option<usize> {
        let mut inner = self.lock();
        let changed = inner.changes + 1;
        let entry = inner.hosts.get_mut(&host)?;
        if entry.row.state == HostState::Lost || entry.row.renewals != renewals {
            return None;
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
        Some(cleared)
    }

    fn set_state_now(&self, host: HostId, from: HostState, to: HostState) -> bool {
        let mut inner = self.lock();
        let changed = inner.changes + 1;
        let Some(entry) = inner.hosts.get_mut(&host) else {
            return false;
        };
        if entry.row.state != from {
            return false;
        }
        entry.row.state = to;
        entry.row.changed = changed;
        inner.changes = changed;
        true
    }

    fn try_lead_now(&self) -> Option<MemoryLead> {
        let taken = self
            .leader
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok();
        taken.then(|| MemoryLead(Arc::clone(&self.leader)))
    }

    fn insert_now(&self, row: &SandboxRow) -> bool {
        let mut inner = self.lock();
        if inner.sandboxes.contains_key(&row.id) {
            return false;
        }
        inner.sandboxes.insert(row.id, row.clone());
        true
    }

    fn sandbox_now(&self, id: Id) -> Option<SandboxRow> {
        self.lock().sandboxes.get(&id).cloned()
    }

    fn replace_now(&self, row: &SandboxRow) -> bool {
        let mut inner = self.lock();
        let Some(stored) = inner.sandboxes.get_mut(&row.id) else {
            return false;
        };
        if stored.version != row.version {
            return false;
        }
        *stored = row.clone();
        stored.version += 1;
        true
    }

    fn delete_now(&self, id: Id, version: u64) -> bool {
        let mut inner = self.lock();
        if inner
            .sandboxes
            .get(&id)
            .is_none_or(|row| row.version != version)
        {
            return false;
        }
        inner.sandboxes.remove(&id);
        true
    }

    fn list_now(&self, team: &str, metadata: &BTreeMap<String, String>) -> Vec<SandboxRow> {
        let inner = self.lock();
        inner
            .sandboxes
            .values()
            .filter(|row| row.team == team)
            .filter(|row| {
                metadata
                    .iter()
                    .all(|(key, value)| row.metadata.get(key) == Some(value))
            })
            .cloned()
            .collect()
    }

    fn owned_by_now(&self, host: HostId) -> Vec<SandboxRow> {
        let inner = self.lock();
        inner
            .sandboxes
            .values()
            .filter(|row| row.ownership.owner == Some(host))
            .cloned()
            .collect()
    }

    fn team_of_now(&self, digest: &str) -> Option<String> {
        self.lock().keys.get(digest).cloned()
    }

    fn add_key_now(&self, digest: &str, team: &str) {
        self.lock().keys.insert(digest.to_owned(), team.to_owned());
    }
}

impl Store for MemoryStore {
    type Lead = MemoryLead;

    fn register(&self, register: &Register) -> impl Future<Output = Result<Admission>> + Send {
        ready(Ok(self.register_now(register)))
    }

    fn renew(&self, renew: &Renew, names: &[String]) -> impl Future<Output = Result<bool>> + Send {
        ready(Ok(self.renew_now(renew, names)))
    }

    fn report(
        &self,
        report: &Report,
        names: &[String],
    ) -> impl Future<Output = Result<bool>> + Send {
        ready(Ok(self.report_now(report, names)))
    }

    fn hosts_changed(&self, after: u64) -> impl Future<Output = Result<Vec<HostRow>>> + Send {
        ready(Ok(self.hosts_changed_now(after)))
    }

    fn renewals(&self) -> impl Future<Output = Result<Vec<(HostId, u64)>>> + Send {
        ready(Ok(self.renewals_now()))
    }

    fn give_up(
        &self,
        host: HostId,
        renewals: u64,
    ) -> impl Future<Output = Result<Option<usize>>> + Send {
        ready(Ok(self.give_up_now(host, renewals)))
    }

    fn set_state(
        &self,
        host: HostId,
        from: HostState,
        to: HostState,
    ) -> impl Future<Output = Result<bool>> + Send {
        ready(Ok(self.set_state_now(host, from, to)))
    }

    fn try_lead(&self) -> impl Future<Output = Result<Option<MemoryLead>>> + Send {
        ready(Ok(self.try_lead_now()))
    }

    fn leads(&self, _lead: &mut MemoryLead) -> impl Future<Output = bool> + Send {
        ready(true)
    }

    fn insert(&self, row: &SandboxRow) -> impl Future<Output = Result<bool>> + Send {
        ready(Ok(self.insert_now(row)))
    }

    fn sandbox(&self, id: Id) -> impl Future<Output = Result<Option<SandboxRow>>> + Send {
        ready(Ok(self.sandbox_now(id)))
    }

    fn replace(&self, row: &SandboxRow) -> impl Future<Output = Result<bool>> + Send {
        ready(Ok(self.replace_now(row)))
    }

    fn delete(&self, id: Id, version: u64) -> impl Future<Output = Result<bool>> + Send {
        ready(Ok(self.delete_now(id, version)))
    }

    fn list(
        &self,
        team: &str,
        metadata: &BTreeMap<String, String>,
    ) -> impl Future<Output = Result<Vec<SandboxRow>>> + Send {
        ready(Ok(self.list_now(team, metadata)))
    }

    fn owned_by(&self, host: HostId) -> impl Future<Output = Result<Vec<SandboxRow>>> + Send {
        ready(Ok(self.owned_by_now(host)))
    }

    fn team_of(&self, digest: &str) -> impl Future<Output = Result<Option<String>>> + Send {
        ready(Ok(self.team_of_now(digest)))
    }

    fn add_key(&self, digest: &str, team: &str) -> impl Future<Output = Result<()>> + Send {
        self.add_key_now(digest, team);
        ready(Ok(()))
    }
}
