//! Moves while a sandbox sleeps: its owner hands it off through object
//! storage, the service clears its owner, and the next wake, or the host
//! asked for, adopts it. Draining a host moves everything nothing holds
//! awake, and asked to, what stays awake too: its owner saves it where
//! it stands, memory and all, ending its open connections. A resize is a
//! move whose sandbox gets its new shape while nobody owns it
//! ([ADR 27](../../../../docs/adr/0027-resizing-a-sandbox.md)).

use std::collections::HashSet;
use std::time::Duration;

use compute_fleet::{HostId, HostState, Next, Op, Outcome};
use compute_protocol::host::{
    ErrorCode, Id, LevelName, Reply, Request, SandboxConfig, SandboxStatus,
};
use futures::StreamExt as _;

use super::{Asked, Failure, Service, host_failure, now_ms};
use crate::store::{Forsaken, Gone, SandboxRow, Store};

/// How long a host may take to hand a sandbox off: it archives it first.
const HAND_OFF_WAIT: Duration = Duration::from_secs(300);
/// How long a host may take to restart a sandbox where it is: it ends its
/// VM, cancelling any step under way, and forgets its memory image, with
/// nothing to store first.
const RESTART_WAIT: Duration = Duration::from_secs(120);
/// How long a host may take to answer a sleep, which it answers at once.
const SLEEP_WAIT: Duration = Duration::from_secs(10);
/// How long a host may take to say how its sandboxes are.
const STATUS_WAIT: Duration = Duration::from_secs(10);
/// How many hand-offs a drain runs at once.
const DRAIN_AT_ONCE: usize = 16;
/// How many times a resize reads its sandbox's row, each time writing the
/// new shape or, while a host owns the sandbox, having it handed off,
/// before it gives up on a sandbox taken up again each time.
const RESIZE_TRIES: usize = 3;

/// A new shape for a sandbox: each field omitted keeps the one it has.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Resize {
    pub vcpus: Option<u8>,
    pub memory_mib: Option<u32>,
    pub memory_request_mib: Option<u32>,
    pub cpu_request_millis: Option<u32>,
    pub disk_mib: Option<u32>,
}

impl Resize {
    /// `config` with this shape, checked as a create's would be. Requests
    /// left unset stay unset, so they follow the new shape (all of its
    /// memory, and the default share of its processors), and a disk may
    /// only grow: a file system does not shrink.
    ///
    /// # Errors
    ///
    /// Why the shape is refused.
    pub fn apply(self, config: &SandboxConfig) -> Result<SandboxConfig, String> {
        let mut resized = config.clone();
        resized.vcpus = self.vcpus.unwrap_or(config.vcpus);
        resized.memory_mib = self.memory_mib.unwrap_or(config.memory_mib);
        resized.memory_request_mib = self.memory_request_mib.or(config.memory_request_mib);
        resized.cpu_request_millis = self.cpu_request_millis.or(config.cpu_request_millis);
        resized.disk_mib = self.disk_mib.or(config.disk_mib);
        resized.validate()?;
        if let (Some(now), Some(asked)) = (config.disk_mib, resized.disk_mib)
            && asked < now
        {
            return Err(format!(
                "disk_mib may only grow, from {now}: a file system does not shrink"
            ));
        }
        Ok(resized)
    }
}

/// What a drain did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Drained {
    /// Sandboxes handed off.
    pub moved: usize,
    /// Sandboxes still on the host: held awake (unless the drain moved
    /// those too), or their host did not answer. Draining again tries
    /// them again.
    pub left: usize,
}

impl<S: Store> Service<S> {
    /// How a team's sandbox is now, as its owner says: its host's name and
    /// what the host reports of it. A sandbox nobody owns has no host, and
    /// its state is in the store alone.
    pub async fn state(
        &self,
        team: &str,
        id: Id,
    ) -> Result<Option<(String, SandboxStatus)>, Failure> {
        let row = self.get(team, id).await?;
        let Some(host) = row.ownership.owner else {
            return Ok(None);
        };
        let target = self
            .view
            .target(host)
            .ok_or_else(|| Failure::Unavailable("its host is not reachable".into()))?;
        let answered = self
            .hosts
            .call(&target, None, &Request::Status, STATUS_WAIT)
            .await
            .map_err(|error| Failure::Unavailable(error.to_string()))?;
        let Reply::Status(status) = answered.answer.reply else {
            return Err(host_failure(&answered));
        };
        let epoch = row.ownership.epoch.0;
        status
            .sandboxes
            .into_iter()
            .find(|sandbox| sandbox.id == id && sandbox.owner_epoch == epoch)
            .map(|sandbox| Some((target.name, sandbox)))
            // Its owner took it up under another epoch, or not yet: as
            // during a move.
            .ok_or_else(|| Failure::Unavailable("its host does not hold it now".into()))
    }

    /// Puts a team's sandbox at least as deep as `level` now. A sandbox
    /// nobody owns runs nowhere already.
    pub async fn sleep(&self, team: &str, id: Id, level: LevelName) -> Result<(), Failure> {
        let row = self.get(team, id).await?;
        let Some(host) = row.ownership.owner else {
            return Ok(());
        };
        let target = self
            .view
            .target(host)
            .ok_or_else(|| Failure::Unavailable("its host is not reachable".into()))?;
        let request = Request::Sleep {
            id,
            generation: None,
            level,
        };
        let answered = self
            .hosts
            .call(&target, Some(row.ownership.epoch), &request, SLEEP_WAIT)
            .await
            .map_err(|error| Failure::Unavailable(error.to_string()))?;
        if answered.outcome() == Outcome::Done {
            Ok(())
        } else {
            Err(host_failure(&answered))
        }
    }

    /// Moves a team's sandbox off its host: the owner hands it off and the
    /// service clears its owner. With `to`, the host of that name adopts
    /// it at once, under its renewal as it stands once the hand-off is
    /// done (which can take minutes), if it offers all the sandbox
    /// reaches; otherwise its next wake places it. With `awake`, it goes
    /// even while it is awake.
    pub async fn move_to(
        &self,
        team: &str,
        id: Id,
        to: Option<&str>,
        awake: bool,
    ) -> Result<SandboxRow, Failure> {
        let named = to
            .map(|name| {
                self.view
                    .named(name)
                    .filter(|known| known.state == HostState::Live)
                    .ok_or_else(|| Failure::Invalid(format!("no live host is named {name}")))
            })
            .transpose()?;
        let row = self.get(team, id).await?;
        if let Some(known) = &named
            && let Some(name) = row
                .spec
                .config
                .reach
                .iter()
                .find(|name| !known.info.offers.contains(name))
        {
            return Err(Failure::Invalid(format!(
                "host {} does not offer {name:?}, which the sandbox reaches",
                known.target.name
            )));
        }
        let to = named.map(|known| known.target.host);
        if let Some(host) = row.ownership.owner {
            if to == Some(host) {
                return Ok(row);
            }
            self.hand_off(&row, host, awake).await?;
        }
        if let Some(to) = to {
            let row = self.get(team, id).await?;
            if row.ownership.owner.is_none() {
                self.adopt(row, Some(to), HashSet::new()).await?;
            }
        }
        self.get(team, id).await
    }

    /// Gives a team's sandbox a new shape, keeping its files: its owner
    /// hands it off as in [`Self::move_to`] (even while it is awake, with
    /// `awake`), and the service writes the new shape into its row while
    /// nobody owns it, so no host ever holds it at a shape other than the
    /// row's. Its next wake places and books it at the new shape. One
    /// nobody owns is resized at once, and one already at the shape is left
    /// as it is.
    ///
    /// A change of `vcpus` or `memory_mib` ends its running programs: the
    /// host that adopts it boots it from its disk, since a memory image
    /// restores the machine it was saved from. Requests and a longer disk
    /// keep them.
    pub async fn resize(
        &self,
        team: &str,
        id: Id,
        resize: Resize,
        awake: bool,
    ) -> Result<SandboxRow, Failure> {
        for _ in 0..RESIZE_TRIES {
            let mut row = self.get(team, id).await?;
            let config = resize.apply(&row.spec.config).map_err(Failure::Invalid)?;
            if config == row.spec.config {
                return Ok(row);
            }
            if let Some(host) = row.ownership.owner {
                self.hand_off(&row, host, awake).await?;
                continue;
            }
            // Taken anew, so a host given up on that still holds it at its
            // old shape drops its copy when it comes back. Another machine
            // leaves the copy files only, so its next owner boots it from
            // its disk whatever its memory image says it was saved at.
            let machine = config.vcpus == row.spec.config.vcpus
                && config.memory_mib == row.spec.config.memory_mib;
            row.ownership = row.ownership.retake(machine).set;
            row.spec.config = config;
            if self.store.respec(&row).await? {
                tracing::info!(%id, "sandbox resized");
                return self.get(team, id).await;
            }
        }
        Err(Failure::Unavailable(
            "it was taken up again each time it was handed off; try again".into(),
        ))
    }

    /// Boots a team's sandbox afresh from its disk, keeping its files and
    /// its shape. Its owner restarts it where it is: it ends its VM without
    /// saving it and forgets its memory image, so its next wake boots it
    /// from its files there, and nothing is stored first, so a slow store
    /// never holds a restart up. An owner from before that request hands it
    /// off instead, as in [`Self::resize`] (even while it is awake), and
    /// the service takes it anew with its copy's files only. One nobody
    /// owns is taken anew at once. Its running programs end. This recovers
    /// a machine whose running system is broken (for example its
    /// `/dev/null` was removed) or stuck while its files are fine.
    pub async fn restart(&self, team: &str, id: Id) -> Result<SandboxRow, Failure> {
        for _ in 0..RESIZE_TRIES {
            let mut row = self.get(team, id).await?;
            if let Some(host) = row.ownership.owner {
                if self.restart_in_place(&row, host).await? {
                    tracing::info!(%id, "sandbox restarted from its disk where it is");
                    return self.get(team, id).await;
                }
                self.hand_off(&row, host, true).await?;
                continue;
            }
            row.ownership = row.ownership.retake(false).set;
            if self.store.respec(&row).await? {
                tracing::info!(%id, "sandbox restarted from its disk");
                return self.get(team, id).await;
            }
        }
        Err(Failure::Unavailable(
            "it was taken up again each time it was handed off; try again".into(),
        ))
    }

    /// Has `host`, the owner, restart `row`'s sandbox where it is. False
    /// for a host from before that request, which a hand-off restarts.
    async fn restart_in_place(&self, row: &SandboxRow, host: HostId) -> Result<bool, Failure> {
        let target = self
            .view
            .target(host)
            .ok_or_else(|| Failure::Unavailable("its host is not reachable".into()))?;
        let request = Request::Restart { id: row.id };
        let answered = self
            .hosts
            .call(&target, Some(row.ownership.epoch), &request, RESTART_WAIT)
            .await
            .map_err(|error| Failure::Unavailable(error.to_string()))?;
        if answered.outcome() == Outcome::Done {
            return Ok(true);
        }
        Err(match answered.code() {
            Some(ErrorCode::Invalid) => return Ok(false),
            Some(ErrorCode::NotFound) => Failure::Unavailable(
                "its host may still be creating it; try again in a few seconds".into(),
            ),
            Some(ErrorCode::Stale) => {
                Failure::Unavailable("it changed meanwhile; try again".into())
            }
            _ => host_failure(&answered),
        })
    }

    /// Has `host`, the owner, hand `row`'s sandbox off, even while it is
    /// awake with `awake`, and clears its owner under a raised epoch once
    /// it has.
    pub(super) async fn hand_off(
        &self,
        row: &SandboxRow,
        host: HostId,
        awake: bool,
    ) -> Result<(), Failure> {
        let epoch = row.ownership.epoch;
        let target = self
            .view
            .target(host)
            .ok_or_else(|| Failure::Unavailable(self.unreachable(host)))?;
        let request = Request::HandOff {
            id: row.id,
            owner_epoch: epoch.0,
            awake,
        };
        let answered = self
            .hosts
            .call(&target, Some(epoch), &request, HAND_OFF_WAIT)
            .await
            .map_err(|error| Failure::Unavailable(error.to_string()))?;
        let asked = Asked {
            op: Op::HandOff,
            host,
            epoch,
        };
        match self.settle(row.id, asked, &answered).await?.0 {
            Next::Clear(_) => Ok(()),
            _ => Err(match answered.code() {
                Some(ErrorCode::NotFound) => Failure::Unavailable(
                    "its host may still be creating it; try again in a few seconds".into(),
                ),
                Some(ErrorCode::Stale) => {
                    Failure::Unavailable("it changed meanwhile; try again".into())
                }
                _ => host_failure(&answered),
            }),
        }
    }

    /// Drains the host named `name`: no new sandbox goes there, and each it
    /// owns that nothing holds awake is handed off; with `awake`, each it
    /// owns at all.
    pub async fn drain(&self, name: &str, awake: bool) -> Result<Drained, Failure> {
        let known = self.view.named(name).ok_or(Failure::NotFound)?;
        let host = known.target.host;
        if known.state == HostState::Lost {
            return Err(Failure::Invalid(format!("{name} was given up on")));
        }
        self.store
            .set_state(host, HostState::Live, HostState::Draining)
            .await?;
        let rows = self.store.owned_by(host).await?;
        let outcomes: Vec<Result<(), Failure>> = futures::stream::iter(rows)
            .map(|row| async move { self.hand_off(&row, host, awake).await })
            .buffer_unordered(DRAIN_AT_ONCE)
            .collect()
            .await;
        let mut drained = Drained::default();
        for outcome in outcomes {
            match outcome {
                Ok(()) => drained.moved += 1,
                Err(error) => {
                    tracing::info!(%error, host = name, "a sandbox stays on a draining host");
                    drained.left += 1;
                }
            }
        }
        Ok(drained)
    }

    /// Declares the host named `name`, given up on, gone for good: each
    /// sandbox that waits for it goes on from its newest stored copy, and
    /// notes what it went back to. For an operator who knows the host is
    /// not coming back; one that comes back after all sets its copies
    /// aside rather than dropping them.
    pub async fn declare_gone(&self, name: &str) -> Result<Vec<Forsaken>, Failure> {
        let known = self.view.named(name).ok_or(Failure::NotFound)?;
        if known.state != HostState::Lost {
            return Err(Failure::Invalid(format!(
                "{name} was not given up on: only a host that stopped answering can be declared gone"
            )));
        }
        let forsaken = self
            .store
            .declare_gone(known.target.host, Gone::Declared, now_ms())
            .await?
            .ok_or_else(|| {
                Failure::Invalid(format!(
                    "{name} registered again: it is no longer given up on"
                ))
            })?;
        tracing::warn!(
            host = name,
            sandboxes = forsaken.len(),
            "a host was declared gone: its sandboxes go on from their stored copies"
        );
        Ok(forsaken)
    }

    /// Takes the host named `name` back into placement after a drain.
    pub async fn undrain(&self, name: &str) -> Result<bool, Failure> {
        let known = self.view.named(name).ok_or(Failure::NotFound)?;
        Ok(self
            .store
            .set_state(known.target.host, HostState::Draining, HostState::Live)
            .await?)
    }
}
