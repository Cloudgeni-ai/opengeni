//! Moves while a sandbox sleeps: its owner hands it off through object
//! storage, the service clears its owner, and the next wake, or the host
//! asked for, adopts it. Draining a host moves everything nothing holds
//! awake.

use std::time::Duration;

use compute_fleet::{HostId, HostState, Next, Op, Outcome};
use compute_protocol::host::{ErrorCode, Id, LevelName, Reply, Request, SandboxStatus};
use futures::StreamExt as _;

use super::{Asked, Failure, Service, host_failure};
use crate::store::{SandboxRow, Store};

/// How long a host may take to hand a sandbox off: it archives it first.
const HAND_OFF_WAIT: Duration = Duration::from_secs(300);
/// How long a host may take to answer a sleep, which it answers at once.
const SLEEP_WAIT: Duration = Duration::from_secs(10);
/// How long a host may take to say how its sandboxes are.
const STATUS_WAIT: Duration = Duration::from_secs(10);
/// How many hand-offs a drain runs at once.
const DRAIN_AT_ONCE: usize = 16;

/// What a drain did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Drained {
    /// Sandboxes handed off.
    pub moved: usize,
    /// Sandboxes still on the host: held awake, or their host did not
    /// answer. Draining again tries them again.
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
    /// done (which can take minutes); otherwise its next wake places it.
    pub async fn move_to(
        &self,
        team: &str,
        id: Id,
        to: Option<&str>,
    ) -> Result<SandboxRow, Failure> {
        let to = to
            .map(|name| {
                self.view
                    .named(name)
                    .filter(|known| known.state == HostState::Live)
                    .map(|known| known.target.host)
                    .ok_or_else(|| Failure::Invalid(format!("no live host is named {name}")))
            })
            .transpose()?;
        let row = self.get(team, id).await?;
        if let Some(host) = row.ownership.owner {
            if to == Some(host) {
                return Ok(row);
            }
            self.hand_off(&row, host).await?;
        }
        if let Some(to) = to {
            let row = self.get(team, id).await?;
            if row.ownership.owner.is_none() {
                self.adopt(row, Some(to), Vec::new()).await?;
            }
        }
        self.get(team, id).await
    }

    /// Has `host`, the owner, hand `row`'s sandbox off, and clears its
    /// owner under a raised epoch once it has.
    async fn hand_off(&self, row: &SandboxRow, host: HostId) -> Result<(), Failure> {
        let epoch = row.ownership.epoch;
        let target = self
            .view
            .target(host)
            .ok_or_else(|| Failure::Unavailable("its host is not reachable".into()))?;
        let request = Request::HandOff {
            id: row.id,
            owner_epoch: epoch.0,
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
    /// owns that nothing holds awake is handed off.
    pub async fn drain(&self, name: &str) -> Result<Drained, Failure> {
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
            .map(|row| async move { self.hand_off(&row, host).await })
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

    /// Takes the host named `name` back into placement after a drain.
    pub async fn undrain(&self, name: &str) -> Result<bool, Failure> {
        let known = self.view.named(name).ok_or(Failure::NotFound)?;
        Ok(self
            .store
            .set_state(known.target.host, HostState::Draining, HostState::Live)
            .await?)
    }
}
