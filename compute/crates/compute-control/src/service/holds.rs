//! Holding a sandbox awake for a named reason, and asking its owner how
//! deep it sleeps: what the E2B front door needs to keep a sandbox with an
//! open stream awake, and to know a pause is complete.

use std::time::Duration;

use compute_fleet::Outcome;
use compute_protocol::host::{Id, LevelName, PriorityName, Reply, Request};

use super::{Failure, Service, host_failure};
use crate::store::{SandboxRow, Store};
use crate::view::Target;

/// How long a host may take to answer a hold, a release or a status.
pub(super) const ASK_WAIT: Duration = Duration::from_secs(10);

/// Where a sandbox is, as far as sleeping goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Depth {
    /// No host owns it: it runs nowhere, and its latest state is in object
    /// storage.
    Unowned,
    /// Its owner reports it at this level, with or without a step under
    /// way.
    At { level: LevelName, busy: bool },
    /// Its owner does not have it, or did not say.
    Unknown,
}

impl Depth {
    /// Whether it sleeps at least as deep as Saved, with no step under way
    /// that could change that: what a finished E2B pause needs.
    #[must_use]
    pub fn saved(self) -> bool {
        match self {
            Self::Unowned => true,
            Self::At { level, busy } => {
                !busy
                    && matches!(
                        level,
                        LevelName::Saved | LevelName::Archived | LevelName::Remote
                    )
            }
            Self::Unknown => false,
        }
    }
}

impl<S: Store> Service<S> {
    /// The owner of a team's sandbox and where to reach it; `None` when no
    /// host owns it.
    fn owner(&self, row: &SandboxRow) -> Result<Option<Target>, Failure> {
        let Some(host) = row.ownership.owner else {
            return Ok(None);
        };
        self.view
            .target(host)
            .map(Some)
            .ok_or_else(|| Failure::Unavailable("its host is not reachable".into()))
    }

    async fn ask(
        &self,
        row: &SandboxRow,
        target: &Target,
        request: &Request,
    ) -> Result<Reply, Failure> {
        let answered = self
            .hosts
            .call(target, Some(row.ownership.epoch), request, ASK_WAIT)
            .await
            .map_err(|error| Failure::Unavailable(error.to_string()))?;
        if answered.outcome() == Outcome::Done {
            Ok(answered.answer.reply)
        } else {
            Err(host_failure(&answered))
        }
    }

    /// Holds a team's sandbox awake for `hold` until released, or for
    /// `ttl` unless held again within it, waking it if it sleeps. A
    /// sandbox no host owns is woken first, so a hold always lands.
    pub async fn hold(
        &self,
        team: &str,
        id: Id,
        hold: &str,
        ttl: Option<Duration>,
    ) -> Result<(), Failure> {
        let mut row = self.get(team, id).await?;
        if row.ownership.owner.is_none() {
            row = self.wake(team, id, PriorityName::Interactive).await?.row;
        }
        let Some(target) = self.owner(&row)? else {
            return Err(Failure::Unavailable("no host owns it".into()));
        };
        let request = Request::Hold {
            id,
            generation: None,
            hold: hold.to_owned(),
            ttl_ms: ttl.map(|ttl| u64::try_from(ttl.as_millis()).unwrap_or(u64::MAX)),
            priority: PriorityName::Interactive,
        };
        self.ask(&row, &target, &request).await.map(|_| ())
    }

    /// Ends a team's sandbox's hold `hold`; nothing to end is fine.
    pub async fn release(&self, team: &str, id: Id, hold: &str) -> Result<(), Failure> {
        let row = self.get(team, id).await?;
        let Some(target) = self.owner(&row)? else {
            return Ok(());
        };
        let request = Request::Release {
            id,
            generation: None,
            hold: hold.to_owned(),
        };
        match self.ask(&row, &target, &request).await {
            Ok(_) | Err(Failure::NotFound) => Ok(()),
            Err(failure) => Err(failure),
        }
    }

    /// How deep a team's sandbox sleeps, as its owner reports it.
    pub async fn depth(&self, team: &str, id: Id) -> Result<Depth, Failure> {
        let row = self.get(team, id).await?;
        let Some(target) = self.owner(&row)? else {
            return Ok(Depth::Unowned);
        };
        let Reply::Status(status) = self.ask(&row, &target, &Request::Status).await? else {
            return Ok(Depth::Unknown);
        };
        Ok(status
            .sandboxes
            .iter()
            .find(|sandbox| sandbox.id == id)
            .map_or(Depth::Unknown, |sandbox| Depth::At {
                level: sandbox.level,
                busy: sandbox.step.is_some() || sandbox.holds > 0,
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pause_is_done_only_at_saved_or_deeper_with_nothing_under_way() {
        assert!(Depth::Unowned.saved());
        assert!(!Depth::Unknown.saved());
        for level in [LevelName::Saved, LevelName::Archived, LevelName::Remote] {
            assert!(Depth::At { level, busy: false }.saved(), "{level:?}");
            assert!(!Depth::At { level, busy: true }.saved(), "{level:?} busy");
        }
        for level in [LevelName::Running, LevelName::Paused, LevelName::Compressed] {
            assert!(!Depth::At { level, busy: false }.saved(), "{level:?}");
        }
    }
}
