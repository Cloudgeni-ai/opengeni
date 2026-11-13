//! Waking and connecting: at the owner, or, for a sandbox nobody owns, at a
//! host that first adopts its latest archive. An owner with no room for a
//! wake hands the sandbox off when another host has room, and the wake
//! places it there ([ADR 38](../../../../docs/adr/0038-a-full-owner-hands-a-wake-on.md)).
//!
//! A wake that finds no room waits for it cheaply. A host that refuses a
//! sandbox as full is not asked about it again until what it reports
//! could have changed ([`View::refused`](crate::view::View::refused)), so
//! a try that finds nowhere to place it reads nothing from the archive,
//! writes no row and asks no host. Meanwhile the wake looks for room in
//! the view every [`AGAIN_AFTER`], which costs nothing, and reads its row
//! again every [`READ_AGAIN_AFTER`], in case another replica placed it.
//! Of the callers waking one sandbox nobody owns, one at a time on each
//! replica places it ([`Service::turn`]); the rest wait their turn, and
//! then find it placed.

use std::collections::HashSet;
use std::sync::{Arc, PoisonError};
use std::time::{Duration, Instant};

use compute_fleet::{Demand, HostId, Next, Op, Outcome, OwnerEpoch, Prefer};
use compute_protocol::host::{ErrorCode, Id, PriorityName, Request};
use tokio::sync::OwnedMutexGuard;

use super::{Asked, Failure, Service, host_failure};
use crate::hosts::Answered;
use crate::store::{SandboxRow, Store, Write, replace};
use crate::view::{Refused, Target};

/// How long a host may take to wake a sandbox and answer.
const WAKE_WAIT: Duration = Duration::from_secs(60);
/// How long a host may take to adopt a sandbox.
const ADOPT_WAIT: Duration = Duration::from_secs(30);
/// How long to wait before asking again after an answer that may change
/// soon: a host busy, or not yet past a create it may still receive.
const AGAIN_AFTER: Duration = Duration::from_millis(250);
/// How long a wake waiting for room, or for a host that refused it as
/// full, goes between reads of its row.
const READ_AGAIN_AFTER: Duration = Duration::from_secs(1);
/// How many sandboxes' turns [`Service::turn`] keeps before it forgets
/// those nobody holds.
const TURNS_KEPT: usize = 64;
/// How many refused adopts [`Service::held_nothing`] remembers before it
/// forgets them all: forgetting one costs a wake at most.
const REFUSED_ADOPTS_KEPT: usize = 4096;
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

/// What one wake learned of owners that had no room for it.
#[derive(Debug, Default)]
struct Passed {
    /// Hosts that handed it off for want of room: not where it goes next
    /// while another host has room.
    avoid: HashSet<HostId>,
    /// Owners asked to hand it off, under the epoch they owned it by: each
    /// is asked once per wake, however long it waits.
    asked: HashSet<(HostId, OwnerEpoch)>,
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
        // This caller's turn to place it while nobody owns it.
        let mut turn: Option<OwnedMutexGuard<()>> = None;
        let mut passed = Passed::default();
        while Instant::now() < deadline {
            let row = self.get(team, id).await?;
            let epoch = row.ownership.epoch;
            // An owner that refused to adopt it under this epoch holds
            // nothing of it: placed as a sandbox nobody owns is, without
            // asking it.
            let owner = (row.ownership.owner).filter(|host| !self.held_nothing(id, *host, epoch));
            let Some(host) = owner else {
                self.place_unowned(row, &mut turn, &passed.avoid, deadline, &mut waited_on)
                    .await?;
                continue;
            };
            let Some(target) = self.view.target(host) else {
                waited_on = self.unreachable(host);
                tokio::time::sleep(AGAIN_AFTER).await;
                continue;
            };
            // Another caller here is giving it to `host` now, which may not
            // hold it yet: asked once that settles, not meanwhile.
            if turn.is_none() && self.placing_now(id) {
                turn = self.turn(id, deadline).await.map(|(held, _)| held);
                continue;
            }
            turn = None;
            let full = Refused::Wake(id);
            if self.view.refuses(host, &full) {
                if waited_on.is_empty() {
                    waited_on = Failure::NoCapacity.to_string();
                }
                self.full_owner(&row, host, &mut passed, &mut waited_on, deadline)
                    .await;
                continue;
            }
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
            // It exists nowhere, and its row is gone: not asked again.
            if next == Next::Forget {
                return Err(Failure::NotFound);
            }
            if let Next::AdoptHere(_) = next {
                // Given back to the same host under a new epoch, to adopt
                // the archive there; elsewhere if it refuses outright.
                let row = now.ok_or(Failure::NotFound)?;
                let (demand, reach) = (self.placing(&row), row.spec.config.reach.clone());
                let exclude = HashSet::from([host]);
                if let Some(adopted) = self.send_adopt(&row, &target).await?
                    && let (Next::PlaceElsewhere, Some(now)) = (adopted.next, adopted.row)
                    && !self
                        .adopt_or_wait(now, exclude.clone(), &mut waited_on)
                        .await?
                {
                    self.wait_for_room(&demand, &reach, &exclude, deadline)
                        .await;
                }
                continue;
            }
            match answered.code() {
                // The row moved on: read it again.
                Some(ErrorCode::Stale) => {}
                // Asked again once what it reports could have changed.
                Some(ErrorCode::HostFull) => {
                    self.view.refused(host, full);
                    waited_on = host_failure(&answered).to_string();
                    self.full_owner(&row, host, &mut passed, &mut waited_on, deadline)
                        .await;
                }
                Some(
                    ErrorCode::NotFound
                    | ErrorCode::Busy
                    | ErrorCode::Unavailable
                    | ErrorCode::Expired,
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

    /// Deals with `host`, the owner of `row`'s sandbox, refusing a wake of
    /// it as full: has it hand the sandbox off for the wake to place
    /// elsewhere ([`Self::hand_on`]), once per owner and wake, or else
    /// waits until it could have room. The caller reads the row again
    /// after.
    async fn full_owner(
        &self,
        row: &SandboxRow,
        host: HostId,
        passed: &mut Passed,
        waited_on: &mut String,
        deadline: Instant,
    ) {
        if passed.asked.insert((host, row.ownership.epoch))
            && self.hand_on(row, host, &mut passed.avoid, waited_on).await
        {
            return;
        }
        let full = Refused::Wake(row.id);
        self.wait_while(deadline, || self.view.refuses(host, &full))
            .await;
    }

    /// Has `host`, the owner of `row`'s sandbox, which refused a wake of it
    /// as full, hand it off, if another host has room for it: the wake
    /// then places it like a sandbox nobody owns, rather than waiting for
    /// room on the host that last ran it (ADR 38). Its files go with it;
    /// the owner stores what it has not stored yet before it lets go. True
    /// once it was handed off, after adding `host` to `avoid`. False when
    /// no other host has room, so moving it would not wake it sooner, or
    /// when the owner did not hand it off, after noting why in
    /// `waited_on`: the wake waits for room where it is, as before.
    async fn hand_on(
        &self,
        row: &SandboxRow,
        host: HostId,
        avoid: &mut HashSet<HostId>,
        waited_on: &mut String,
    ) -> bool {
        let mut elsewhere = avoid.clone();
        elsewhere.insert(host);
        if !self
            .view
            .has_room_now(&self.placing(row), &row.spec.config.reach, &elsewhere)
        {
            return false;
        }
        match self.hand_off(row, host, false).await {
            Ok(()) => {
                tracing::info!(
                    sandbox = %row.id,
                    host = host.0,
                    "a full owner handed a sandbox off, to wake it where there is room"
                );
                avoid.insert(host);
                true
            }
            Err(error) => {
                *waited_on = error.to_string();
                false
            }
        }
    }

    /// Places `row`'s sandbox, which nobody owns, for a wake, outside
    /// `avoid` while there is room elsewhere, once it is this caller's
    /// `turn`, or waits for room or for the turn, until `deadline` at most.
    /// The caller reads the row again after.
    async fn place_unowned(
        &self,
        row: SandboxRow,
        turn: &mut Option<OwnedMutexGuard<()>>,
        avoid: &HashSet<HostId>,
        deadline: Instant,
        waited_on: &mut String,
    ) -> Result<(), Failure> {
        if turn.is_none() {
            let Some((held, waited)) = self.turn(row.id, deadline).await else {
                return Ok(());
            };
            *turn = Some(held);
            // Another caller had the turn: it may have placed it.
            if waited {
                return Ok(());
            }
        }
        let (demand, reach) = (self.placing(&row), row.spec.config.reach.clone());
        // A host it was handed off from for want of room is a last resort.
        let exclude = if self.view.has_room_now(&demand, &reach, avoid) {
            avoid.clone()
        } else {
            HashSet::new()
        };
        if !self.adopt_or_wait(row, exclude, waited_on).await? {
            self.wait_for_room(&demand, &reach, &HashSet::new(), deadline)
                .await;
        }
        Ok(())
    }

    /// This caller's turn to place sandbox `id`, and whether it waited for
    /// it behind another caller; `None` once `deadline` passes first. One
    /// caller at a time on this replica places a sandbox nobody owns, so
    /// callers waking it together ask no more of the store or the hosts
    /// than one does.
    async fn turn(&self, id: Id, deadline: Instant) -> Option<(OwnedMutexGuard<()>, bool)> {
        let lock = {
            let mut turns = self.turns.lock().unwrap_or_else(PoisonError::into_inner);
            if turns.len() >= TURNS_KEPT {
                turns.retain(|_, turn| turn.strong_count() > 0);
            }
            if let Some(lock) = turns.get(&id).and_then(std::sync::Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(tokio::sync::Mutex::new(()));
                turns.insert(id, Arc::downgrade(&lock));
                lock
            }
        };
        if let Ok(held) = Arc::clone(&lock).try_lock_owned() {
            return Some((held, false));
        }
        tokio::time::timeout_at(deadline.into(), lock.lock_owned())
            .await
            .ok()
            .map(|held| (held, true))
    }

    /// Whether another caller on this replica has the turn to place sandbox
    /// `id` now ([`Self::turn`]).
    fn placing_now(&self, id: Id) -> bool {
        self.turns
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&id)
            .and_then(std::sync::Weak::upgrade)
            .is_some_and(|lock| lock.try_lock().is_err())
    }

    /// Whether `host` refused to adopt sandbox `id` as full under owner
    /// epoch `epoch`, as this replica last saw: it holds nothing of it
    /// under that epoch, and never will, so asking it to wake it under
    /// that epoch only leads to adopting it there again.
    fn held_nothing(&self, id: Id, host: HostId, epoch: OwnerEpoch) -> bool {
        self.refused_adopts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&id)
            == Some(&(host, epoch))
    }

    /// What placing `row`'s sandbox asks of a host, as [`Self::adopt`]
    /// places it.
    fn placing(&self, row: &SandboxRow) -> Demand {
        let prefer = row
            .class
            .as_deref()
            .and_then(|class| self.view.class(class))
            .map_or(Prefer::Any, Prefer::Class);
        self.demand(&row.spec.config, prefer)
    }

    /// Waits until the view has room for `demand`, reaching `reach`,
    /// outside `exclude`, or [`READ_AGAIN_AFTER`] has passed, or
    /// `deadline`. Reads nothing but the view.
    async fn wait_for_room(
        &self,
        demand: &Demand,
        reach: &[String],
        exclude: &HashSet<HostId>,
        deadline: Instant,
    ) {
        self.wait_while(deadline, || !self.view.has_room(demand, reach, exclude))
            .await;
    }

    /// Waits while `waiting` holds, looking every [`AGAIN_AFTER`], for at
    /// least that long and at most [`READ_AGAIN_AFTER`], or until
    /// `deadline`.
    async fn wait_while(&self, deadline: Instant, waiting: impl Fn() -> bool) {
        let until = (Instant::now() + READ_AGAIN_AFTER).min(deadline);
        loop {
            tokio::time::sleep(AGAIN_AFTER.min(until.saturating_duration_since(Instant::now())))
                .await;
            if Instant::now() >= until || !waiting() {
                return;
            }
        }
    }

    /// Places a sandbox nobody owns, as [`Self::adopt`] does, for a wake.
    /// A fleet with no room for it now is waited on like a host that is
    /// full: room comes back as other sandboxes sleep or end, so the wake
    /// keeps trying until its deadline. Returns false when there was no
    /// room, after noting it in `waited_on`.
    async fn adopt_or_wait(
        &self,
        row: SandboxRow,
        exclude: HashSet<HostId>,
        waited_on: &mut String,
    ) -> Result<bool, Failure> {
        match self.adopt(row, None, exclude).await {
            Ok(()) => Ok(true),
            Err(Failure::NoCapacity) => {
                *waited_on = Failure::NoCapacity.to_string();
                Ok(false)
            }
            Err(other) => Err(other),
        }
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
        let demand = self.placing(&row);
        let mut archived = false;
        let mut asked = 0;
        loop {
            let target = match on {
                Some(host) => self.view.target(host).ok_or_else(|| {
                    Failure::Unavailable("the host asked for was given up on".into())
                })?,
                None => self.place(&demand, &row.spec.config.reach, &exclude)?,
            };
            // Read once there is a host to give it to: a try that finds no
            // room reads nothing.
            if !archived {
                if !self.archived(row.id).await? {
                    return Err(Failure::Unavailable(
                        "nobody owns it and it has no archive yet; it comes back if its host does"
                            .into(),
                    ));
                }
                archived = true;
            }
            row.ownership = row.ownership.give(target.host).set;
            row.sends.send(row.ownership.epoch, target.seq);
            row.class = Some(target.class.clone());
            match replace(&*self.store, &mut row).await? {
                Write::Done => {}
                // (Only an insert finds its template gone.)
                Write::Conflict | Write::TemplateGone => return Ok(()),
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
        if answered.code() == Some(ErrorCode::HostFull) {
            // Not asked to adopt it, or one like it, again until what it
            // reports could have changed.
            self.view
                .refused(target.host, Refused::Place(self.placing(row)));
            let mut refused = self
                .refused_adopts
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if refused.len() >= REFUSED_ADOPTS_KEPT {
                refused.clear();
            }
            refused.insert(row.id, (target.host, epoch));
        }
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
