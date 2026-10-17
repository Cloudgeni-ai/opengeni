//! The service's store: hosts and their leases, sandboxes and their owners,
//! API keys, and the E2B lifecycle of sandboxes created through the E2B API
//! ([ADR 18](../../../docs/adr/0018-the-fleet-service-leases-and-fences.md)).
//!
//! Every write is conditional: a renewal on the registration it renews, a
//! host given up on on the renewal count the leader watched, and a sandbox
//! on the version its writer read. So a stale writer, in this replica or
//! another, changes nothing, and replicas keep no state of their own.
//!
//! [`MemoryStore`] keeps everything in memory, for tests and a single
//! host; [`PostgresStore`] is the store a fleet runs on. Both decide with
//! the same rules ([`admits`] and [`rule`]).

mod memory;
mod postgres;

use std::collections::BTreeMap;
use std::future::Future;

use compute_fleet::{Change, HostEpoch, HostId, HostState, OwnerEpoch, Ownership, Sends, Verdict};
use compute_protocol::fleet::Verdict as Wire;
use compute_protocol::fleet::{Capacity, Held, HostInfo, Register, Renew, Report, Ruling};
use compute_protocol::host::{Id, SandboxConfig};
use serde::{Deserialize, Serialize};

use crate::e2b::lifecycle::Record;

pub use memory::MemoryStore;
pub use postgres::{PostgresLead, PostgresStore};

/// What can go wrong reading or writing the store.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// The database refused or could not be reached.
    #[error("the store: {0}")]
    Database(String),
    /// A stored row does not read back as what was written.
    #[error("a stored row is malformed: {0}")]
    Corrupt(String),
}

/// A result of the store.
pub type Result<T> = std::result::Result<T, StoreError>;

/// A host as the store holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostRow {
    pub id: HostId,
    pub info: HostInfo,
    /// Its current registration.
    pub epoch: HostEpoch,
    pub state: HostState,
    /// Registrations and renewals accepted, which the leader watches.
    pub renewals: u64,
    /// The highest renewal number accepted under the registration, which
    /// stamps requests to the host.
    pub seq: u64,
    /// What it last said it can take on.
    pub capacity: Capacity,
    /// When the row last changed, by the store's change counter: replicas
    /// read the rows changed since they last looked.
    pub changed: u64,
}

/// What a sandbox was created as.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Spec {
    /// The image it starts from, by the name the fleet gives it.
    pub image: String,
    /// Its shape and sleep ladder.
    pub config: SandboxConfig,
}

/// A sandbox as the store holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxRow {
    pub id: Id,
    /// Whose it is: the team of the API key that created it.
    pub team: String,
    pub spec: Spec,
    /// Labels its creator gave it, to list it by.
    pub metadata: BTreeMap<String, String>,
    pub ownership: Ownership,
    /// The creates and adopts sent for it, to judge late answers by.
    pub sends: Sends,
    /// The class of the host it was last given to (memory profile and CPU
    /// template), where its memory image restores.
    pub class: Option<String>,
    /// When it was created, in milliseconds since the Unix epoch.
    pub created_ms: u64,
    /// Raised by every write; each write is conditional on the version its
    /// writer read.
    pub version: u64,
}

/// The answer to a registration attempt.
/// A sandbox's E2B lifecycle as the store holds it (see
/// [`crate::e2b::lifecycle`]), beside its fleet row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LifecycleRow {
    pub id: Id,
    /// Whose it is, as in its fleet row.
    pub team: String,
    pub record: Record,
    /// Raised by every write; each write is conditional on the version its
    /// writer read.
    pub version: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Admission {
    /// Registered under `epoch`, with a ruling on each sandbox it listed.
    Registered {
        host: HostId,
        epoch: HostEpoch,
        rulings: Vec<Ruling>,
    },
    /// Its previous registration may still be running VMs.
    StillLive,
}

/// What a registration attempt meets in the host's row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Admits {
    /// A new registration: the host is new, or was given up on.
    Fresh,
    /// Another copy of the attempt the stored answer answered.
    Again,
    /// Another attempt while the last registration is live.
    StillLive,
}

/// What an attempt numbered `attempt` meets, given the host's row, if it
/// has one, as its state and the attempt it last answered.
pub(crate) fn admits(row: Option<(HostState, u64)>, attempt: u64) -> Admits {
    match row {
        None | Some((HostState::Lost, _)) => Admits::Fresh,
        Some((_, answered)) if answered == attempt => Admits::Again,
        Some(_) => Admits::StillLive,
    }
}

/// The ruling on a sandbox `host` lists, given the sandbox's row, and the
/// change to the row it needs: a reclaim, which the store applies in the
/// same transaction as the registration.
pub(crate) fn rule(host: HostId, held: Held, row: Option<Ownership>) -> (Ruling, Option<Change>) {
    let (verdict, change) = match compute_fleet::reconcile(host, OwnerEpoch(held.owner_epoch), row)
    {
        Verdict::Keep { epoch } => (
            Wire::Keep {
                owner_epoch: epoch.0,
            },
            None,
        ),
        Verdict::Reclaim { change } => (
            Wire::Keep {
                owner_epoch: change.set.epoch.0,
            },
            Some(change),
        ),
        Verdict::Refetch { epoch } => (
            Wire::Refetch {
                owner_epoch: epoch.0,
            },
            None,
        ),
        Verdict::Drop => (Wire::Drop, None),
    };
    (
        Ruling {
            id: held.id,
            verdict,
        },
        change,
    )
}

/// Hosts, sandboxes and API keys, with conditional writes.
///
/// Implementations are cheap to share: the service holds one for all its
/// tasks.
pub trait Store: Send + Sync + 'static {
    /// Held while this replica leads.
    type Lead: Send;

    /// Registers a host, in one transaction: answers another copy of the
    /// attempt it last answered with the same answer, refuses while the
    /// last registration is live, and otherwise gives a new host epoch,
    /// rules on every sandbox listed (applying reclaims) and stores the
    /// answer.
    fn register(&self, register: &Register) -> impl Future<Output = Result<Admission>> + Send;

    /// Accepts a renewal while it renews the host's current registration
    /// and the host is not given up on, and records its capacity. Only a
    /// host named one of `names` may renew.
    fn renew(&self, renew: &Renew, names: &[String]) -> impl Future<Output = Result<bool>> + Send;

    /// Records a host's capacity, under the same conditions as a renewal,
    /// without counting as one.
    fn report(
        &self,
        report: &Report,
        names: &[String],
    ) -> impl Future<Output = Result<bool>> + Send;

    /// The host rows changed after `after`, oldest change first.
    fn hosts_changed(&self, after: u64) -> impl Future<Output = Result<Vec<HostRow>>> + Send;

    /// The renewal count of every host not given up on.
    fn renewals(&self) -> impl Future<Output = Result<Vec<(HostId, u64)>>> + Send;

    /// Gives up on `host` if its renewal count is still `renewals`, and in
    /// the same transaction leaves each of its sandboxes without an owner
    /// under a raised epoch. Returns how many it had, or `None` when a
    /// renewal came meanwhile or another replica gave up on it first.
    fn give_up(
        &self,
        host: HostId,
        renewals: u64,
    ) -> impl Future<Output = Result<Option<usize>>> + Send;

    /// Moves a host from `from` to `to` (live and draining), if it is in
    /// `from`.
    fn set_state(
        &self,
        host: HostId,
        from: HostState,
        to: HostState,
    ) -> impl Future<Output = Result<bool>> + Send;

    /// Becomes the leader if no other replica is, without waiting.
    fn try_lead(&self) -> impl Future<Output = Result<Option<Self::Lead>>> + Send;

    /// Whether `lead` still holds the leadership.
    fn leads(&self, lead: &mut Self::Lead) -> impl Future<Output = bool> + Send;

    /// Inserts a new sandbox, at the version it carries. False if one with
    /// its id exists. Refused if it names an owner the service has given
    /// up on; see [`Write::OwnerLost`].
    fn insert(&self, row: &SandboxRow) -> impl Future<Output = Result<Write>> + Send;

    /// One sandbox.
    fn sandbox(&self, id: Id) -> impl Future<Output = Result<Option<SandboxRow>>> + Send;

    /// Replaces a sandbox's row with `row`, raising its version by one, on
    /// condition that it is still at `row.version` and does not name an
    /// owner the service has given up on.
    fn replace(&self, row: &SandboxRow) -> impl Future<Output = Result<Write>> + Send;

    /// Deletes a sandbox's row on condition that it is at `version`.
    fn delete(&self, id: Id, version: u64) -> impl Future<Output = Result<bool>> + Send;

    /// A team's sandboxes whose metadata holds every pair in `metadata`.
    fn list(
        &self,
        team: &str,
        metadata: &BTreeMap<String, String>,
    ) -> impl Future<Output = Result<Vec<SandboxRow>>> + Send;

    /// The sandboxes `host` owns.
    fn owned_by(&self, host: HostId) -> impl Future<Output = Result<Vec<SandboxRow>>> + Send;

    /// The team an API key belongs to, by the key's digest.
    fn team_of(&self, digest: &str) -> impl Future<Output = Result<Option<String>>> + Send;

    /// Adds an API key, by its digest, for `team`.
    fn add_key(&self, digest: &str, team: &str) -> impl Future<Output = Result<()>> + Send;

    /// Inserts a sandbox's E2B lifecycle at the version it carries. False
    /// if one with its id exists.
    fn insert_lifecycle(&self, row: &LifecycleRow) -> impl Future<Output = Result<bool>> + Send;

    /// One sandbox's E2B lifecycle.
    fn lifecycle(&self, id: Id) -> impl Future<Output = Result<Option<LifecycleRow>>> + Send;

    /// Replaces a sandbox's E2B lifecycle with `row`, raising its version by
    /// one, on condition that it is still at `row.version`.
    fn replace_lifecycle(&self, row: &LifecycleRow) -> impl Future<Output = Result<bool>> + Send;

    /// Deletes a sandbox's E2B lifecycle on condition that it is at
    /// `version`.
    fn delete_lifecycle(&self, id: Id, version: u64) -> impl Future<Output = Result<bool>> + Send;

    /// A team's E2B lifecycles.
    fn lifecycles(&self, team: &str) -> impl Future<Output = Result<Vec<LifecycleRow>>> + Send;

    /// At most `limit` E2B lifecycles due by `now_ms` (see
    /// [`Record::due_ms`]), soonest first.
    fn lifecycles_due(
        &self,
        now_ms: u64,
        limit: usize,
    ) -> impl Future<Output = Result<Vec<LifecycleRow>>> + Send;
}

/// How a conditional write of a sandbox's row went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Write {
    Done,
    /// Someone wrote it since it was read, or, for an insert, it exists.
    Conflict,
    /// It names as owner a host the service has given up on. Giving up
    /// clears the owner of every sandbox the host owns in one transaction,
    /// and this check is ordered with it, so no sandbox is left owned by a
    /// host after it was given up on.
    OwnerLost,
}

impl Write {
    /// Whether it was written.
    #[must_use]
    pub fn done(self) -> bool {
        self == Self::Done
    }
}

/// Writes `row` with its version raised, if no one wrote it since it was
/// read and its owner, if any, is not given up on; when written, `row`
/// holds the version written.
pub async fn replace<S: Store>(store: &S, row: &mut SandboxRow) -> Result<Write> {
    let written = store.replace(row).await?;
    if written.done() {
        row.version += 1;
    }
    Ok(written)
}

/// Writes `row` with its version raised, if no one wrote it since it was
/// read; when written, `row` holds the version written.
pub async fn replace_lifecycle<S: Store>(store: &S, row: &mut LifecycleRow) -> Result<bool> {
    let written = store.replace_lifecycle(row).await?;
    if written {
        row.version += 1;
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use compute_protocol::fleet::Verdict as Wire;

    use super::*;

    #[test]
    fn an_attempt_is_answered_again_refused_while_live_and_fresh_once_lost() {
        assert_eq!(admits(None, 7), Admits::Fresh);
        assert_eq!(admits(Some((HostState::Lost, 7)), 7), Admits::Fresh);
        assert_eq!(admits(Some((HostState::Live, 7)), 7), Admits::Again);
        assert_eq!(admits(Some((HostState::Draining, 7)), 7), Admits::Again);
        assert_eq!(admits(Some((HostState::Live, 6)), 7), Admits::StillLive);
        assert_eq!(admits(Some((HostState::Draining, 6)), 7), Admits::StillLive);
    }

    #[test]
    fn a_listed_sandbox_nobody_took_since_is_reclaimed_under_a_raised_epoch() {
        let host = HostId(4);
        let id = Id(compute_fleet::SandboxId(9));
        let held = Held { id, owner_epoch: 2 };
        let cleared = Ownership {
            owner: None,
            epoch: OwnerEpoch(3),
            taken: OwnerEpoch(2),
        };
        let (ruling, change) = rule(host, held, Some(cleared));
        let change = change.expect("a reclaim");
        assert_eq!(change.expect, cleared);
        assert_eq!(change.set.owner, Some(host));
        assert_eq!(
            ruling.verdict,
            Wire::Keep {
                owner_epoch: change.set.epoch.0
            }
        );
        let (gone, none) = rule(host, held, None);
        assert_eq!((gone.verdict, none), (Wire::Drop, None));
        let taken_since = Ownership {
            owner: Some(HostId(5)),
            epoch: OwnerEpoch(4),
            taken: OwnerEpoch(4),
        };
        assert_eq!(rule(host, held, Some(taken_since)).0.verdict, Wire::Drop);
    }
}
