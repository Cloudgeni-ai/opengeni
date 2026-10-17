//! What the service does for its callers: create, wake, connect, move and
//! delete sandboxes, by the fleet's rules
//! ([ADR 18](../../../docs/adr/0018-the-fleet-service-leases-and-fences.md)).
//!
//! Every decision about ownership is `compute_fleet`'s; this module reads
//! the store, sends requests to hosts and writes back what the rules say,
//! each write conditional on the row's version. A write that loses to
//! another replica's decides again from the row as it is then.

mod moves;
mod reach;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use compute_fleet::{
    Demand, HostId, LeaseTerms, Next, Op, Outcome, OwnerEpoch, Ownership, Prefer, SandboxId,
    answered,
};
use compute_protocol::host::{ErrorCode, Id, Reply, Request, SandboxConfig};
use compute_storage::store::ChunkStore;

use crate::hosts::{Answered, Hosts};
use crate::store::{SandboxRow, Spec, Store, StoreError, replace};
use crate::view::{Target, View, shape_key};

pub use moves::Drained;
pub use reach::Reached;

/// How long a host may take to answer a create.
const CREATE_WAIT: Duration = Duration::from_secs(30);
/// How long a host may take to answer a remove.
const REMOVE_WAIT: Duration = Duration::from_secs(60);

/// Why a request failed.
#[derive(Debug, thiserror::Error)]
pub enum Failure {
    #[error("no such sandbox")]
    NotFound,
    #[error("{0}")]
    Invalid(String),
    #[error("no host can take it now")]
    NoCapacity,
    #[error("busy: {0}")]
    Busy(String),
    #[error("unavailable for now: {0}")]
    Unavailable(String),
    /// A host was asked and did not answer, so the request may or may not
    /// have happened.
    #[error("sandbox {id}: {why}; it may or may not have happened, so look again")]
    Unknown { id: Id, why: String },
    #[error("the host: {0}")]
    Host(String),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("the archive store: {0}")]
    Archive(String),
}

/// What a host's error answer means to a caller.
fn host_failure(answered: &Answered) -> Failure {
    match &answered.answer.reply {
        Reply::Error { message, code } => match code {
            ErrorCode::Busy => Failure::Busy(message.clone()),
            ErrorCode::Invalid => Failure::Invalid(message.clone()),
            ErrorCode::NotFound | ErrorCode::Removed => Failure::NotFound,
            ErrorCode::HostFull => Failure::NoCapacity,
            ErrorCode::Unavailable | ErrorCode::Expired | ErrorCode::Stale => {
                Failure::Unavailable(message.clone())
            }
            _ => Failure::Host(message.clone()),
        },
        other => Failure::Host(format!("unexpected answer {other:?}")),
    }
}

/// How the service runs.
#[derive(Clone, Debug)]
pub struct Settings {
    /// The lease terms hosts are told.
    pub terms: LeaseTerms,
    /// Disk in MiB each sandbox is booked for where it is placed.
    pub disk_mib: u64,
    /// How many hosts a create or adopt tries before it gives up.
    pub max_tries: u32,
    /// How long a wake or connect may take in all.
    pub wake_within: Duration,
    /// The image a create that names none starts from.
    pub image: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            terms: LeaseTerms::RECOMMENDED,
            disk_mib: 1024,
            max_tries: 3,
            wake_within: Duration::from_secs(60),
            image: "base".into(),
        }
    }
}

/// A request about one sandbox, as the rules know it: what, to which host,
/// under which owner epoch.
#[derive(Clone, Copy, Debug)]
struct Asked {
    op: Op,
    host: HostId,
    epoch: OwnerEpoch,
}

/// The fleet service.
#[derive(Debug)]
pub struct Service<S> {
    store: Arc<S>,
    view: Arc<View>,
    hosts: Hosts,
    archive: Option<ChunkStore>,
    settings: Settings,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

/// A new sandbox id: the time in milliseconds, then random bits, laid out
/// as a version 7 UUID, so ids sort by when they were made.
fn new_id() -> Result<Id, Failure> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|error| Failure::Host(error.to_string()))?;
    let random = u128::from_le_bytes(random);
    let millis = u128::from(now_ms() & ((1 << 48) - 1));
    let value = (millis << 80)
        | (0x7 << 76)
        | (random & (((1 << 12) - 1) << 64))
        | (0b10 << 62)
        | (random & ((1 << 62) - 1));
    Ok(Id(SandboxId(value)))
}

impl<S: Store> Service<S> {
    /// A service over `store`, placing with `view`, calling hosts through
    /// `hosts`, and reading archive pointers in `archive` if the fleet
    /// archives to object storage.
    #[must_use]
    pub fn new(
        store: Arc<S>,
        view: Arc<View>,
        hosts: Hosts,
        archive: Option<ChunkStore>,
        settings: Settings,
    ) -> Self {
        Self {
            store,
            view,
            hosts,
            archive,
            settings,
        }
    }

    /// The store it runs on.
    #[must_use]
    pub fn store(&self) -> &Arc<S> {
        &self.store
    }

    /// Its view of the hosts.
    #[must_use]
    pub fn view(&self) -> &Arc<View> {
        &self.view
    }

    /// How it runs.
    #[must_use]
    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    fn demand(&self, config: &SandboxConfig, prefer: Prefer) -> Demand {
        Demand {
            memory_mib: u64::from(config.memory_request()),
            memory_max_mib: u64::from(config.memory_mib),
            disk_mib: self.settings.disk_mib,
            prefer,
        }
    }

    /// Places `demand` on a host not in `exclude`.
    fn place(&self, demand: &Demand, exclude: &[HostId]) -> Result<Target, Failure> {
        let placement = self
            .view
            .place(demand, exclude)
            .ok_or(Failure::NoCapacity)?;
        self.view.target(placement.host).ok_or(Failure::NoCapacity)
    }

    /// Whether object storage holds an archive of `id`.
    async fn archived(&self, id: Id) -> Result<bool, Failure> {
        let Some(archive) = &self.archive else {
            return Ok(false);
        };
        archive
            .get_owned_pointer(&id.to_string())
            .await
            .map(|pointer| pointer.is_some())
            .map_err(|error| Failure::Archive(error.to_string()))
    }

    /// Applies the rules to `reply`, the answer to `asked`, against the
    /// sandbox's row as it is now, and writes the row if they change it.
    /// Returns what follows and the row as written, or `None` if the
    /// sandbox no longer exists.
    async fn settle(
        &self,
        id: Id,
        asked: Asked,
        reply: &Answered,
        tries: u32,
    ) -> Result<(Next, Option<SandboxRow>), Failure> {
        let outcome = reply.outcome();
        let archived = if asked.op == Op::Wake && outcome == Outcome::NotFound {
            self.archived(id).await?
        } else {
            false
        };
        loop {
            let Some(mut row) = self.store.sandbox(id).await? else {
                return Ok((Next::Nothing, None));
            };
            let before = (row.ownership, row.sends);
            let next = answered(
                &mut row.sends,
                self.settings.terms,
                (asked.op, asked.host, asked.epoch),
                outcome,
                reply.at(),
                row.ownership,
                archived,
                (tries, self.settings.max_tries),
            );
            match next {
                Next::AdoptHere(change) => {
                    // The adopt that follows goes out under the new epoch.
                    let stamp = self
                        .view
                        .target(asked.host)
                        .map_or(reply.at().seq, |target| target.seq);
                    row.ownership = change.set;
                    row.sends.send(change.set.epoch, stamp);
                }
                Next::Clear(change) => row.ownership = change.set,
                Next::Nothing | Next::PlaceElsewhere => {}
            }
            if (row.ownership, row.sends) == before || replace(&*self.store, &mut row).await? {
                return Ok((next, Some(row)));
            }
        }
    }

    /// Creates a sandbox for `team`: places it, records it with its first
    /// owner, and has that host create it, trying another host when one
    /// refuses.
    pub async fn create(
        &self,
        team: &str,
        spec: Spec,
        metadata: BTreeMap<String, String>,
    ) -> Result<SandboxRow, Failure> {
        spec.config.validate().map_err(Failure::Invalid)?;
        let id = new_id()?;
        let shape = shape_key(
            &spec.image,
            u32::from(spec.config.vcpus),
            spec.config.memory_mib,
        );
        let demand = self.demand(&spec.config, Prefer::ReadyClone(shape));
        let mut row = SandboxRow {
            id,
            team: team.to_owned(),
            spec,
            metadata,
            ownership: Ownership::created(HostId(0)),
            sends: compute_fleet::Sends::default(),
            class: None,
            created_ms: now_ms(),
            version: 0,
        };
        let mut exclude = Vec::new();
        for tries in 1..=self.settings.max_tries {
            let target = self.place(&demand, &exclude)?;
            row.ownership = if tries == 1 {
                Ownership::created(target.host)
            } else {
                // The host before it refused outright and holds nothing.
                row.ownership.give(target.host).set
            };
            row.sends.send(row.ownership.epoch, target.seq);
            row.class = Some(target.class.clone());
            let written = if tries == 1 {
                self.store.insert(&row).await?
            } else {
                replace(&*self.store, &mut row).await?
            };
            if !written {
                return Err(Failure::Unknown {
                    id,
                    why: "it changed while being created".into(),
                });
            }
            let asked = Asked {
                op: Op::Create,
                host: target.host,
                epoch: row.ownership.epoch,
            };
            let request = Request::Create {
                id,
                config: row.spec.config.clone(),
            };
            let answered = match self
                .hosts
                .call(&target, Some(asked.epoch), &request, CREATE_WAIT)
                .await
            {
                Ok(answered) => answered,
                Err(error) => {
                    return Err(Failure::Unknown {
                        id,
                        why: error.to_string(),
                    });
                }
            };
            let (next, now) = self.settle(id, asked, &answered, tries).await?;
            row = now.ok_or(Failure::NotFound)?;
            match next {
                _ if answered.outcome() == Outcome::Done => return Ok(row),
                Next::PlaceElsewhere => exclude.push(target.host),
                _ => {
                    self.forget_refused(&row, &answered).await?;
                    return Err(host_failure(&answered));
                }
            }
        }
        Err(Failure::NoCapacity)
    }

    /// Deletes the row of a sandbox whose create its owner refused
    /// outright: that host holds nothing of it, and no other create was
    /// sent under its epoch.
    async fn forget_refused(&self, row: &SandboxRow, answered: &Answered) -> Result<(), Failure> {
        if answered.outcome() == Outcome::Refused && row.sends.unanswered.is_none() {
            self.store.delete(row.id, row.version).await?;
        }
        Ok(())
    }

    /// A team's sandbox.
    pub async fn get(&self, team: &str, id: Id) -> Result<SandboxRow, Failure> {
        self.store
            .sandbox(id)
            .await?
            .filter(|row| row.team == team)
            .ok_or(Failure::NotFound)
    }

    /// A team's sandboxes whose metadata holds every pair in `metadata`.
    pub async fn list(
        &self,
        team: &str,
        metadata: &BTreeMap<String, String>,
    ) -> Result<Vec<SandboxRow>, Failure> {
        Ok(self.store.list(team, metadata).await?)
    }

    /// Deletes a team's sandbox: its owner removes it, or, with no owner,
    /// the service raises its epoch, leaves a tombstone in object storage
    /// under that epoch, so no former owner's archive lands after, and
    /// deletes the row.
    pub async fn delete(&self, team: &str, id: Id) -> Result<(), Failure> {
        loop {
            let Some(mut row) = self.store.sandbox(id).await? else {
                return Ok(());
            };
            if row.team != team {
                return Err(Failure::NotFound);
            }
            let Some(host) = row.ownership.owner else {
                let change = row.ownership.clear();
                row.ownership = change.set;
                if !replace(&*self.store, &mut row).await? {
                    continue;
                }
                if let Some(archive) = &self.archive {
                    match archive
                        .delete_pointer(&id.to_string(), row.ownership.epoch)
                        .await
                    {
                        Ok(()) => {}
                        // Adopted meanwhile: remove it from its new owner.
                        Err(compute_storage::Error::Fenced { .. }) => continue,
                        Err(error) => return Err(Failure::Archive(error.to_string())),
                    }
                }
                if self.store.delete(id, row.version).await? {
                    return Ok(());
                }
                continue;
            };
            if self.remove_from(&row, host).await? {
                return Ok(());
            }
        }
    }

    /// Has `host`, the owner, remove `row`'s sandbox, then deletes the row.
    /// False when the row should be read again.
    async fn remove_from(&self, row: &SandboxRow, host: HostId) -> Result<bool, Failure> {
        let epoch = row.ownership.epoch;
        let target = self
            .view
            .target(host)
            .ok_or_else(|| Failure::Unavailable("its host is not reachable; try again".into()))?;
        let request = Request::Remove {
            id: row.id,
            generation: None,
        };
        let answered = self
            .hosts
            .call(&target, Some(epoch), &request, REMOVE_WAIT)
            .await
            .map_err(|error| Failure::Unavailable(error.to_string()))?;
        let gone = match answered.outcome() {
            Outcome::Done => true,
            // Final only once no create or adopt sent under the epoch can
            // still land there.
            Outcome::NotFound => row.sends.settled(self.settings.terms, epoch, answered.at()),
            Outcome::Refused | Outcome::Other => match answered.code() {
                Some(ErrorCode::Stale) => return Ok(false),
                _ => return Err(host_failure(&answered)),
            },
        };
        if !gone {
            return Err(Failure::Unavailable(
                "its host may still be creating it; try again in a few seconds".into(),
            ));
        }
        Ok(self.store.delete(row.id, row.version).await?)
    }
}
