//! Waking and connecting: at the owner, or, for a sandbox nobody owns, at a
//! host that first adopts its latest archive.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use compute_fleet::{HostId, Next, Op, Outcome, Prefer};
use compute_protocol::host::{ErrorCode, Id, PriorityName, Request};

use super::{Asked, Failure, Service, host_failure};
use crate::hosts::Answered;
use crate::store::{SandboxRow, Store, Write, replace};
use crate::view::Target;

/// How long a host may take to wake a sandbox and answer.
const WAKE_WAIT: Duration = Duration::from_secs(60);
/// How long a host may take to adopt a sandbox.
const ADOPT_WAIT: Duration = Duration::from_secs(30);
/// How long to wait before asking again after an answer that may change
/// soon: a host busy, or not yet past a create it may still receive.
const AGAIN_AFTER: Duration = Duration::from_millis(250);
/// How many times an adopt asks the host it names before giving up, while
/// that host refuses it for when it was sent.
const ASKS_OF_A_NAMED_HOST: u32 = 3;

/// What a caller wants of a sandbox.
#[derive(Clone, Copy, Debug)]
enum Want {
    Wake(PriorityName),
    Connect(u32, PriorityName),
}

impl Want {
    fn request(self, id: Id) -> Request {
        match self {
            Self::Wake(priority) => Request::Wake {
                id,
                generation: None,
                priority,
            },
            Self::Connect(port, priority) => Request::Connect {
                id,
                generation: None,
                port,
                priority,
            },
        }
    }
}

/// An adopt's answer, what follows it, and the row as it was written.
#[derive(Debug)]
pub(super) struct Adopted {
    pub(super) next: Next,
    pub(super) answered: Answered,
    pub(super) row: Option<SandboxRow>,
}

/// A sandbox reached: its row and its owner's answer, whose stream, for a
/// connect, leads to the guest port.
#[derive(Debug)]
pub struct Reached {
    pub row: SandboxRow,
    pub answered: Answered,
}

impl<S: Store> Service<S> {
    /// Wakes a team's sandbox and answers once it runs.
    pub async fn wake(
        &self,
        team: &str,
        id: Id,
        priority: PriorityName,
    ) -> Result<Reached, Failure> {
        self.reach(team, id, Want::Wake(priority)).await
    }

    /// Wakes a team's sandbox and opens a byte stream to `port` in it.
    pub async fn connect(
        &self,
        team: &str,
        id: Id,
        port: u32,
        priority: PriorityName,
    ) -> Result<Reached, Failure> {
        self.reach(team, id, Want::Connect(port, priority)).await
    }

    async fn reach(&self, team: &str, id: Id, want: Want) -> Result<Reached, Failure> {
        let deadline = Instant::now() + self.settings.wake_within;
        let mut waited_on = String::new();
        while Instant::now() < deadline {
            let row = self.get(team, id).await?;
            let Some(host) = row.ownership.owner else {
                self.adopt(row, None, HashSet::new()).await?;
                continue;
            };
            let epoch = row.ownership.epoch;
            let Some(target) = self.view.target(host) else {
                "its host is not reachable".clone_into(&mut waited_on);
                tokio::time::sleep(AGAIN_AFTER).await;
                continue;
            };
            let answered = match self
                .hosts
                .call(&target, Some(epoch), &want.request(id), WAKE_WAIT)
                .await
            {
                Ok(answered) => answered,
                Err(error) => {
                    waited_on = error.to_string();
                    tokio::time::sleep(AGAIN_AFTER).await;
                    continue;
                }
            };
            if answered.outcome() == Outcome::Done {
                return Ok(Reached { row, answered });
            }
            let asked = Asked {
                op: Op::Wake,
                host,
                epoch,
            };
            let (next, now) = self.settle(id, asked, &answered).await?;
            if let Next::AdoptHere(_) = next {
                // Given back to the same host under a new epoch, to adopt
                // the archive there; elsewhere if it refuses outright.
                let row = now.ok_or(Failure::NotFound)?;
                if let Some(adopted) = self.send_adopt(&row, &target).await?
                    && let (Next::PlaceElsewhere, Some(now)) = (adopted.next, adopted.row)
                {
                    self.adopt(now, None, HashSet::from([host])).await?;
                }
                continue;
            }
            match answered.code() {
                // The row moved on: read it again.
                Some(ErrorCode::Stale) => {}
                Some(
                    ErrorCode::NotFound
                    | ErrorCode::Busy
                    | ErrorCode::Unavailable
                    | ErrorCode::Expired
                    | ErrorCode::HostFull,
                ) => {
                    waited_on = host_failure(&answered).to_string();
                    tokio::time::sleep(AGAIN_AFTER).await;
                }
                _ => return Err(host_failure(&answered)),
            }
        }
        Err(Failure::Unavailable(format!(
            "not reached within {:?}: {waited_on}",
            self.settings.wake_within
        )))
    }

    /// Gives a sandbox nobody owns, or whose owner refused it outright, to
    /// host `on`, or to a host placement picks outside `exclude`, and has
    /// it adopt the latest archive. Each try takes its host's target from
    /// the view as it is then, so the request carries that host's latest
    /// renewal. Every host placement can find is tried once; a host named
    /// by `on` that refuses a request as too old or under another
    /// registration is asked again, up to [`ASKS_OF_A_NAMED_HOST`] times in
    /// all. Returns once one adopted it, or once the row changed under it,
    /// for the caller to read again.
    pub(super) async fn adopt(
        &self,
        mut row: SandboxRow,
        on: Option<HostId>,
        mut exclude: HashSet<HostId>,
    ) -> Result<(), Failure> {
        if !self.archived(row.id).await? {
            return Err(Failure::Unavailable(
                "nobody owns it and it has no archive yet; it comes back if its host does".into(),
            ));
        }
        let prefer = row
            .class
            .as_deref()
            .and_then(|class| self.view.class(class))
            .map_or(Prefer::Any, Prefer::Class);
        let demand = self.demand(&row.spec.config, prefer)?;
        let mut asked = 0;
        loop {
            let target = match on {
                Some(host) => self.view.target(host).ok_or_else(|| {
                    Failure::Unavailable("the host asked for was given up on".into())
                })?,
                None => self.place(&demand, &exclude)?,
            };
            row.ownership = row.ownership.give(target.host).set;
            row.sends.send(row.ownership.epoch, target.seq);
            row.class = Some(target.class.clone());
            match replace(&*self.store, &mut row).await? {
                Write::Done => {}
                Write::Conflict => return Ok(()),
                // Given up on since it was placed: elsewhere, unless it
                // was asked for there.
                Write::OwnerLost if on.is_none() => {
                    exclude.insert(target.host);
                    match self.store.sandbox(row.id).await? {
                        Some(now) => row = now,
                        None => return Ok(()),
                    }
                    continue;
                }
                Write::OwnerLost => {
                    return Err(Failure::Unavailable(
                        "the host asked for was given up on".into(),
                    ));
                }
            }
            let Some(adopted) = self.send_adopt(&row, &target).await? else {
                return Ok(());
            };
            if adopted.answered.outcome() == Outcome::Done {
                return Ok(());
            }
            match (adopted.next, adopted.row) {
                // The host holds nothing of it: give it on from the row as
                // it is now.
                (Next::PlaceElsewhere, Some(now)) if on.is_none() => {
                    exclude.insert(target.host);
                    row = now;
                }
                // The host asked for refused it for when it was sent, so it
                // holds nothing of it either: try it there again.
                (Next::PlaceElsewhere, Some(now))
                    if matches!(
                        adopted.answered.code(),
                        Some(ErrorCode::Expired | ErrorCode::Unavailable)
                    ) =>
                {
                    asked += 1;
                    if asked == ASKS_OF_A_NAMED_HOST {
                        return Err(host_failure(&adopted.answered));
                    }
                    row = now;
                    tokio::time::sleep(AGAIN_AFTER).await;
                }
                _ if adopted.answered.code() == Some(ErrorCode::Stale) => return Ok(()),
                _ => return Err(host_failure(&adopted.answered)),
            }
        }
    }

    /// Sends the adopt `row`'s current owner epoch names to `target` and
    /// applies the answer; `None` if no answer came.
    pub(super) async fn send_adopt(
        &self,
        row: &SandboxRow,
        target: &Target,
    ) -> Result<Option<Adopted>, Failure> {
        let epoch = row.ownership.epoch;
        let request = Request::Adopt {
            id: row.id,
            config: self.sent_config(row, target),
            owner_epoch: epoch.0,
            whole: row.ownership.whole_copy(),
        };
        let answered = match self
            .hosts
            .call(target, Some(epoch), &request, ADOPT_WAIT)
            .await
        {
            Ok(answered) => answered,
            Err(error) => {
                tracing::warn!(%error, sandbox = %row.id, "an adopt got no answer");
                return Ok(None);
            }
        };
        let asked = Asked {
            op: Op::Adopt,
            host: target.host,
            epoch,
        };
        let (next, row) = self.settle(row.id, asked, &answered).await?;
        Ok(Some(Adopted {
            next,
            answered,
            row,
        }))
    }
}
