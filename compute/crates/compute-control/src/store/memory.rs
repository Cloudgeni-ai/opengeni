//! A store in memory, for tests and a fleet of one service replica that
//! can afford to forget everything when it stops.

use std::collections::{BTreeMap, HashMap};
use std::future::{Future, ready};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use compute_fleet::{HostEpoch, HostId, HostState};
use compute_protocol::fleet::{Register, Renew, Report, Ruling};
use compute_protocol::host::Id;

use super::{
    Admission, Admits, HostRow, LifecycleRow, Linked, RequestRow, Result, SandboxRow, Store, Write,
    admits, rule,
};

#[derive(Debug)]
struct Host {
    row: HostRow,
    attempt: u64,
    answer: Vec<Ruling>,
    /// When it was given up on, while it is.
    gone_ms: Option<u64>,
}

#[derive(Debug, Default)]
struct Inner {
    hosts: BTreeMap<HostId, Host>,
    by_name: HashMap<String, HostId>,
    sandboxes: BTreeMap<Id, SandboxRow>,
    keys: HashMap<String, String>,
    lifecycles: BTreeMap<Id, LifecycleRow>,
    /// By team, then request id.
    requests: BTreeMap<(String, String), RequestRow>,
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

    /// Whether `row` names as owner a host given up on, or one this store
    /// does not have.
    fn owner_lost(&self, row: &SandboxRow) -> bool {
        row.ownership.owner.is_some_and(|owner| {
            self.hosts
                .get(&owner)
                .is_none_or(|host| host.row.state == HostState::Lost)
        })
    }

    fn insert(&mut self, row: &SandboxRow) -> Write {
        if self.owner_lost(row) {
            return Write::OwnerLost;
        }
        if self.sandboxes.contains_key(&row.id) {
            return Write::Conflict;
        }
        self.sandboxes.insert(row.id, row.clone());
        Write::Done
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
                gone_ms: None,
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
        // A renewal without a capacity keeps the one last heard.
        if let Some(capacity) = &renew.capacity {
            row.capacity = capacity.clone();
        }
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

    fn give_up_now(&self, host: HostId, renewals: u64, at_ms: u64) -> Option<usize> {
        let mut inner = self.lock();
        let changed = inner.changes + 1;
        let entry = inner.hosts.get_mut(&host)?;
        if entry.row.state == HostState::Lost || entry.row.renewals != renewals {
            return None;
        }
        entry.row.state = HostState::Lost;
        entry.row.changed = changed;
        entry.gone_ms = Some(at_ms);
        inner.changes = changed;
        let mut cleared = 0;
        for sandbox in inner.sandboxes.values_mut() {
            if sandbox.ownership.owner == Some(host) {
                sandbox.ownership = sandbox.ownership.lose().set;
                sandbox.version += 1;
                cleared += 1;
            }
        }
        Some(cleared)
    }

    fn prune_hosts_now(&self, before_ms: u64) -> u64 {
        let mut inner = self.lock();
        let inner = &mut *inner;
        let before = inner.hosts.len();
        inner
            .hosts
            .retain(|_, host| host.gone_ms.is_none_or(|at| at >= before_ms));
        let hosts = &inner.hosts;
        inner.by_name.retain(|_, id| hosts.contains_key(id));
        u64::try_from(before - inner.hosts.len()).unwrap_or(u64::MAX)
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

    fn insert_now(&self, row: &SandboxRow) -> Write {
        let mut inner = self.lock();
        inner.insert(row)
    }

    fn insert_requested_now(&self, row: &SandboxRow, request_id: &str) -> Option<Write> {
        let mut inner = self.lock();
        let key = (row.team.clone(), request_id.to_owned());
        if inner.requests.get(&key).is_none_or(RequestRow::gone) {
            return None;
        }
        Some(inner.insert(row))
    }

    fn sandbox_now(&self, id: Id) -> Option<SandboxRow> {
        self.lock().sandboxes.get(&id).cloned()
    }

    fn replace_now(&self, row: &SandboxRow) -> Write {
        let mut inner = self.lock();
        if inner.owner_lost(row) {
            return Write::OwnerLost;
        }
        let Some(stored) = inner.sandboxes.get_mut(&row.id) else {
            return Write::Conflict;
        };
        if stored.version != row.version {
            return Write::Conflict;
        }
        *stored = row.clone();
        stored.version += 1;
        Write::Done
    }

    fn delete_now(&self, id: Id, version: u64, retire_at: Option<u64>) -> bool {
        let mut inner = self.lock();
        let Some(row) = inner.sandboxes.get(&id) else {
            return false;
        };
        if row.version != version {
            return false;
        }
        let team = row.team.clone();
        inner.sandboxes.remove(&id);
        if let Some(at) = retire_at {
            for request in inner.requests.values_mut() {
                if request.id == id && request.team == team && request.gone_ms.is_none() {
                    request.gone_ms = Some(at);
                }
            }
        }
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

    fn claim_request_now(&self, row: &RequestRow) -> RequestRow {
        self.lock()
            .requests
            .entry((row.team.clone(), row.request_id.clone()))
            .or_insert_with(|| row.clone())
            .clone()
    }

    fn prune_requests_now(&self, before_ms: u64) -> u64 {
        let mut inner = self.lock();
        let before = inner.requests.len();
        inner
            .requests
            .retain(|_, request| request.gone_ms.is_none_or(|at| at >= before_ms));
        u64::try_from(before - inner.requests.len()).unwrap_or(u64::MAX)
    }

    fn insert_lifecycle_now(&self, row: &LifecycleRow) -> bool {
        let mut inner = self.lock();
        if inner.lifecycles.contains_key(&row.id) {
            return false;
        }
        inner.lifecycles.insert(row.id, row.clone());
        true
    }

    fn replace_lifecycle_now(&self, row: &LifecycleRow) -> bool {
        let mut inner = self.lock();
        let Some(stored) = inner.lifecycles.get_mut(&row.id) else {
            return false;
        };
        if stored.version != row.version {
            return false;
        }
        *stored = row.clone();
        stored.version += 1;
        true
    }

    fn delete_lifecycle_now(&self, id: Id, version: u64) -> bool {
        let mut inner = self.lock();
        if inner
            .lifecycles
            .get(&id)
            .is_none_or(|row| row.version != version)
        {
            return false;
        }
        inner.lifecycles.remove(&id);
        true
    }

    fn lifecycles_now(&self, team: &str) -> Vec<LifecycleRow> {
        self.lock()
            .lifecycles
            .values()
            .filter(|row| row.team == team)
            .cloned()
            .collect()
    }

    fn lifecycles_due_now(
        &self,
        now_ms: u64,
        after: Option<(u64, Id)>,
        limit: usize,
    ) -> Vec<LifecycleRow> {
        // Ids compare as the database compares them: as text.
        let after = after.map(|(due, id)| (due, id.to_string()));
        let key = |row: &LifecycleRow| (row.record.due_ms(), row.id.to_string());
        let mut due: Vec<LifecycleRow> = self
            .lock()
            .lifecycles
            .values()
            .filter(|row| row.record.due_ms() <= now_ms)
            .filter(|row| after.as_ref().is_none_or(|after| key(row) > *after))
            .cloned()
            .collect();
        due.sort_by_cached_key(key);
        due.truncate(limit);
        due
    }

    fn lifecycles_paused_now(&self, after: Option<Id>, limit: usize) -> Vec<LifecycleRow> {
        // Ids compare as the database compares them: as text.
        let after = after.map(|id| id.to_string());
        let mut paused: Vec<LifecycleRow> = self
            .lock()
            .lifecycles
            .values()
            .filter(|row| row.record.due_ms() == u64::MAX)
            .filter(|row| {
                after
                    .as_ref()
                    .is_none_or(|after| row.id.to_string() > *after)
            })
            .cloned()
            .collect();
        paused.sort_by_cached_key(|row| row.id.to_string());
        paused.truncate(limit);
        paused
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
        at_ms: u64,
    ) -> impl Future<Output = Result<Option<usize>>> + Send {
        ready(Ok(self.give_up_now(host, renewals, at_ms)))
    }

    fn prune_hosts(&self, before_ms: u64) -> impl Future<Output = Result<u64>> + Send {
        ready(Ok(self.prune_hosts_now(before_ms)))
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

    fn insert(&self, row: &SandboxRow) -> impl Future<Output = Result<Write>> + Send {
        ready(Ok(self.insert_now(row)))
    }

    fn sandbox(&self, id: Id) -> impl Future<Output = Result<Option<SandboxRow>>> + Send {
        ready(Ok(self.sandbox_now(id)))
    }

    fn insert_requested(
        &self,
        row: &SandboxRow,
        request_id: &str,
    ) -> impl Future<Output = Result<Option<Write>>> + Send {
        ready(Ok(self.insert_requested_now(row, request_id)))
    }

    fn agents(&self, ids: &[Id]) -> impl Future<Output = Result<Vec<Linked>>> + Send {
        let inner = self.lock();
        let found = ids
            .iter()
            .filter_map(|id| {
                let row = inner.sandboxes.get(id)?;
                Some(Linked {
                    id: *id,
                    team: row.team.clone(),
                    agent: row.spec.agent.clone()?,
                })
            })
            .collect();
        ready(Ok(found))
    }

    fn replace(&self, row: &SandboxRow) -> impl Future<Output = Result<Write>> + Send {
        ready(Ok(self.replace_now(row)))
    }

    fn delete(&self, id: Id, version: u64) -> impl Future<Output = Result<bool>> + Send {
        ready(Ok(self.delete_now(id, version, None)))
    }

    fn delete_retiring(
        &self,
        id: Id,
        version: u64,
        at_ms: u64,
    ) -> impl Future<Output = Result<bool>> + Send {
        ready(Ok(self.delete_now(id, version, Some(at_ms))))
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

    fn claim_request(&self, row: &RequestRow) -> impl Future<Output = Result<RequestRow>> + Send {
        ready(Ok(self.claim_request_now(row)))
    }

    fn request(
        &self,
        team: &str,
        request_id: &str,
    ) -> impl Future<Output = Result<Option<RequestRow>>> + Send {
        let key = (team.to_owned(), request_id.to_owned());
        ready(Ok(self.lock().requests.get(&key).cloned()))
    }

    fn prune_requests(&self, before_ms: u64) -> impl Future<Output = Result<u64>> + Send {
        ready(Ok(self.prune_requests_now(before_ms)))
    }

    fn insert_lifecycle(&self, row: &LifecycleRow) -> impl Future<Output = Result<bool>> + Send {
        ready(Ok(self.insert_lifecycle_now(row)))
    }

    fn lifecycle(&self, id: Id) -> impl Future<Output = Result<Option<LifecycleRow>>> + Send {
        ready(Ok(self.lock().lifecycles.get(&id).cloned()))
    }

    fn replace_lifecycle(&self, row: &LifecycleRow) -> impl Future<Output = Result<bool>> + Send {
        ready(Ok(self.replace_lifecycle_now(row)))
    }

    fn delete_lifecycle(&self, id: Id, version: u64) -> impl Future<Output = Result<bool>> + Send {
        ready(Ok(self.delete_lifecycle_now(id, version)))
    }

    fn lifecycles(&self, team: &str) -> impl Future<Output = Result<Vec<LifecycleRow>>> + Send {
        ready(Ok(self.lifecycles_now(team)))
    }

    fn lifecycles_due(
        &self,
        now_ms: u64,
        after: Option<(u64, Id)>,
        limit: usize,
    ) -> impl Future<Output = Result<Vec<LifecycleRow>>> + Send {
        ready(Ok(self.lifecycles_due_now(now_ms, after, limit)))
    }

    fn lifecycles_paused(
        &self,
        after: Option<Id>,
        limit: usize,
    ) -> impl Future<Output = Result<Vec<LifecycleRow>>> + Send {
        ready(Ok(self.lifecycles_paused_now(after, limit)))
    }
}
