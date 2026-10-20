//! What the service does for its callers: create, wake, connect, move and
//! delete sandboxes, by the fleet's rules
//! ([ADR 18](../../../docs/adr/0018-the-control-service-leases-and-fences.md)).
//!
//! Every decision about ownership is `compute_fleet`'s; this module reads
//! the store, sends requests to hosts and writes back what the rules say,
//! each write conditional on the row's version. A write that loses to
//! another replica's decides again from the row as it is then.

mod holds;
mod moves;
mod reach;
mod requests;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use compute_fleet::{
    Demand, HostId, LeaseTerms, Next, Op, Outcome, OwnerEpoch, Ownership, Prefer, SandboxId,
    answered,
};
use compute_protocol::host::{ErrorCode, Id, ImageId, Reply, Request, SandboxConfig, SleepConfig};
use compute_storage::store::ChunkStore;

use crate::hosts::{Answered, Hosts};
use crate::link::Links;
use crate::store::{SandboxRow, Spec, Store, StoreError, Write, replace};
use crate::view::{Target, View, shape_key};

pub use holds::Depth;
pub use moves::Drained;
pub use reach::Reached;
pub use requests::request_digest;

/// How a fleet sandbox sleeps when its create says nothing: the
/// recommended ladder, with a checkpoint after every ten minutes it runs,
/// counted from when the last one reached the store. That is a scheduling
/// target, not a bound on loss: losing its host costs a sandbox what it did
/// since the capture of its newest published copy, which its status reports
/// as `backed_up_ms` (ADR 18). A host whose files share no extents takes no
/// checkpoints, and says so.
pub const DEFAULT_SLEEP: SleepConfig = SleepConfig {
    checkpoint_every_ms: Some(10 * 60 * 1000),
    ..SleepConfig::RECOMMENDED
};

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
    /// A create's request id was used before for another create.
    #[error("request {0} was used for another create")]
    Mismatch(String),
    /// A create's request id made a sandbox that was deleted since.
    #[error("request {0} made a sandbox that was deleted since")]
    Gone(String),
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
    /// How a sandbox whose create says nothing sleeps.
    pub sleep: SleepConfig,
    /// The images creates may name, by the fleet's names for them: the id
    /// of each stored image (ADR 19), which hosts fetch by it, or `None`
    /// for the hosts' own base image. The default image is always known,
    /// as the base image unless named here.
    pub images: BTreeMap<String, Option<ImageId>>,
    /// The agent link's keys and each team's gateway, if sandboxes may run
    /// Opengeni's agent.
    pub links: Option<Arc<Links>>,
}

impl Settings {
    /// The image the fleet calls `name`: `Some(None)` for the hosts' base
    /// image, `None` for no image it knows.
    #[must_use]
    pub fn image_named(&self, name: &str) -> Option<Option<ImageId>> {
        match self.images.get(name) {
            Some(image) => Some(*image),
            None => (name == self.image).then_some(None),
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            terms: LeaseTerms::RECOMMENDED,
            disk_mib: 1024,
            max_tries: 3,
            wake_within: Duration::from_secs(60),
            image: "base".into(),
            sleep: DEFAULT_SLEEP,
            images: BTreeMap::new(),
            links: None,
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

/// The control service.
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
///
/// # Errors
///
/// When the system's random numbers cannot be read.
pub fn new_id() -> Result<Id, Failure> {
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
            cpu_millis: u64::from(config.cpu_request()),
            disk_mib: self.settings.disk_mib,
            prefer,
        }
    }

    /// The config `target` is sent for `row`'s sandbox, which it holds
    /// under the row's owner epoch: the spec's, and for a sandbox that runs
    /// Opengeni's agent, the ticket for that host and epoch.
    pub(crate) fn sent_config(&self, row: &SandboxRow, target: &Target) -> SandboxConfig {
        let mut config = row.spec.config.clone();
        if let Some(agent) = &row.spec.agent {
            config.link = self.settings.links.as_ref().and_then(|links| {
                links.ticket(
                    &row.team,
                    &row.id.to_string(),
                    &target.name,
                    row.ownership.epoch.0,
                    agent,
                )
            });
            if config.link.is_none() {
                tracing::warn!(
                    sandbox = %row.id,
                    team = %row.team,
                    "the sandbox runs an agent but its team has no agent link now"
                );
            }
        }
        config
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
            if (row.ownership, row.sends) == before {
                return Ok((next, Some(row)));
            }
            match replace(&*self.store, &mut row).await? {
                Write::Done => return Ok((next, Some(row))),
                // Written meanwhile, or about to be given to a host given
                // up on meanwhile: the rules run again on the row as it is.
                Write::Conflict | Write::OwnerLost => {}
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
        self.create_as(new_id()?, team, spec, metadata).await
    }

    /// Creates a sandbox for `team` as [`Self::create`] does, under `id`
    /// (from [`new_id`]), for a caller that records the id first.
    pub async fn create_as(
        &self,
        id: Id,
        team: &str,
        spec: Spec,
        metadata: BTreeMap<String, String>,
    ) -> Result<SandboxRow, Failure> {
        self.create_for(id, team, spec, metadata, None).await
    }

    /// As [`Self::create_as`], for `team`'s create request `request` when
    /// given: its row is inserted only while that request is not retired.
    pub(crate) async fn create_for(
        &self,
        id: Id,
        team: &str,
        spec: Spec,
        metadata: BTreeMap<String, String>,
        request: Option<&str>,
    ) -> Result<SandboxRow, Failure> {
        let (mut row, demand) = self.new_row(id, team, spec, metadata)?;
        let id = row.id;
        let mut exclude = Vec::new();
        let mut inserted = false;
        // The last refusal of a host that holds nothing of it.
        let mut refused = None;
        for tries in 1..=self.settings.max_tries {
            let target = match self.place(&demand, &exclude) {
                Ok(target) => target,
                Err(failure) => {
                    self.forget_if_refused(&row, refused.as_ref()).await?;
                    return Err(failure);
                }
            };
            row.ownership = if inserted {
                // The host before it refused outright and holds nothing.
                row.ownership.give(target.host).set
            } else {
                Ownership::created(target.host)
            };
            row.sends.send(row.ownership.epoch, target.seq);
            row.class = Some(target.class.clone());
            let written = if inserted {
                replace(&*self.store, &mut row).await?
            } else {
                self.insert(&row, request).await?
            };
            match written {
                Write::Done => inserted = true,
                // Given up on since it was placed: place it elsewhere,
                // from the row as stored.
                Write::OwnerLost => {
                    exclude.push(target.host);
                    if inserted {
                        row = self.store.sandbox(id).await?.ok_or(Failure::NotFound)?;
                    } else {
                        row.sends = compute_fleet::Sends::default();
                    }
                    continue;
                }
                Write::Conflict => {
                    return Err(Failure::Unknown {
                        id,
                        why: "it changed while being created".into(),
                    });
                }
            }
            let asked = Asked {
                op: Op::Create,
                host: target.host,
                epoch: row.ownership.epoch,
            };
            let request = Request::Create {
                id,
                config: self.sent_config(&row, &target),
            };
            let answered = self
                .hosts
                .call(&target, Some(asked.epoch), &request, CREATE_WAIT)
                .await
                .map_err(|error| Failure::Unknown {
                    id,
                    why: error.to_string(),
                })?;
            let (next, now) = self.settle(id, asked, &answered, tries).await?;
            row = now.ok_or(Failure::NotFound)?;
            match next {
                _ if answered.outcome() == Outcome::Done => return Ok(row),
                Next::PlaceElsewhere => {
                    exclude.push(target.host);
                    refused = Some(answered);
                }
                _ => {
                    self.forget_if_refused(&row, Some(&answered)).await?;
                    return Err(host_failure(&answered));
                }
            }
        }
        self.forget_if_refused(&row, refused.as_ref()).await?;
        Err(Failure::NoCapacity)
    }

    /// A new sandbox's row, not yet placed, and what it asks of a host.
    fn new_row(
        &self,
        id: Id,
        team: &str,
        mut spec: Spec,
        metadata: BTreeMap<String, String>,
    ) -> Result<(SandboxRow, Demand), Failure> {
        spec.config.validate().map_err(Failure::Invalid)?;
        // Only the service names a link, per host and owner epoch.
        spec.config.link = None;
        if let Some(agent) = &spec.agent {
            agent.validate().map_err(Failure::Invalid)?;
            let linked = self
                .settings
                .links
                .as_ref()
                .is_some_and(|links| links.gateway(team).is_some());
            if !linked {
                return Err(Failure::Invalid(
                    "a sandbox that runs an agent needs its team to have an agent link".into(),
                ));
            }
        }
        // The host boots the image the config names, fetching it by id;
        // a name the fleet does not know must not boot something else.
        spec.config.image = self
            .settings
            .image_named(&spec.image)
            .ok_or_else(|| Failure::Invalid(format!("no such image: {}", spec.image)))?;
        let shape = shape_key(
            &spec.image,
            u32::from(spec.config.vcpus),
            spec.config.memory_mib,
        );
        let demand = self.demand(&spec.config, Prefer::ReadyClone(shape));
        let row = SandboxRow {
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
        Ok((row, demand))
    }

    /// Inserts `row`, for create request `request` when given: refused as
    /// gone when that request's sandbox was made and deleted meanwhile.
    async fn insert(&self, row: &SandboxRow, request: Option<&str>) -> Result<Write, Failure> {
        let Some(request) = request else {
            return Ok(self.store.insert(row).await?);
        };
        self.store
            .insert_requested(row, request)
            .await?
            .ok_or_else(|| Failure::Gone(request.to_owned()))
    }

    /// Deletes the row of a sandbox whose create its owner refused
    /// outright: that host holds nothing of it, and no other create was
    /// sent under its epoch.
    async fn forget_if_refused(
        &self,
        row: &SandboxRow,
        answered: Option<&Answered>,
    ) -> Result<(), Failure> {
        let Some(answered) = answered else {
            return Ok(());
        };
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
    /// deletes the row, retiring in the same write the create requests that
    /// made it, which then answer that it is gone.
    pub async fn delete(&self, team: &str, id: Id) -> Result<(), Failure> {
        self.delete_row(team, id).await
    }

    async fn delete_row(&self, team: &str, id: Id) -> Result<(), Failure> {
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
                if !replace(&*self.store, &mut row).await?.done() {
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
                if self
                    .store
                    .delete_retiring(id, row.version, now_ms())
                    .await?
                {
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
        Ok(self
            .store
            .delete_retiring(row.id, row.version, now_ms())
            .await?)
    }
}
