//! How the leader shrinks its host group by itself: one host at a time,
//! without costing any sandbox its programs or files.
//!
//! The group's policy says when it has more spare than it needs
//! ([`ScaleDecision::Shrink`]: a whole new host's worth beyond its target
//! even with one host gone, nothing booting, draining or stalled, and
//! more hosts than its minimum). The leader acts on that only once every
//! look has said so for [`Shrinking::after`], and as long after the group
//! last grew or lost a host, so a burst that comes and goes moves nothing;
//! and only while every host of the group keeps an idle sandbox's memory
//! in a hand-off ([`GroupHost::keeps_memory`]), so hosts are upgraded
//! before the service. It then drains the live host with the most memory
//! free without ending any VM process, the one holding the fewest
//! sandboxes among equals, so the fewest sandboxes move. Each pass,
//! [`crate::service::Service::drain_keeping_programs`] every
//! [`Shrinking::drain_every`], puts idle sandboxes to sleep with their
//! memory and hands them off through the store, so they wake elsewhere
//! with their programs; one in use is left until it is idle, never forced.
//! The store gives a draining host no sandbox it does not own already. A
//! pass finds it owning none; once it has drained for [`Shrinking::quiet`]
//! since its first pass that held, so that a create, adopt or move placed
//! on it before its drain landed has landed too, the leader checks once
//! more and deletes its instance from the group, which leaves the group
//! one smaller.
//!
//! The store notes that the leader drained it, and when, so a leader after
//! this one goes on with the drain as its own. The host is taken back
//! (undrained) as soon as the group would grow, or if its sandboxes have
//! not all left within [`Shrinking::drain_within`] (then it is not drained
//! again for as long): once no drain pass is under way, and never once its
//! deletion was asked for. A take-back that fails is asked again until it
//! holds. A host someone else drains, such as an operator, is theirs: it
//! is removed only with [`Shrinking::adopt_after`], once it has drained
//! that long, never taken back, and left draining if its sandboxes do not
//! leave in time.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use compute_fleet::ScaleDecision;
use tokio::time::Instant;

use crate::group::Member;
use crate::service::Drained;
use crate::view::GroupHost;

/// How the leader shrinks a host group by itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Shrinking {
    /// How long the group must keep more spare than it needs, and how
    /// long after it last grew or lost a host, before a host is drained.
    pub after: Duration,
    /// How often a host on its way out is drained again.
    pub drain_every: Duration,
    /// How long the leader's own drain may take before the host is taken
    /// back, and how long it is then left alone.
    pub drain_within: Duration,
    /// How long a host someone else drains is left to them before the
    /// leader removes it; never without.
    pub adopt_after: Option<Duration>,
    /// How long a host must have drained, since its first pass that held,
    /// before it is removed: longer than a create, adopt or move placed on
    /// it before its drain landed takes to land.
    pub quiet: Duration,
}

impl Shrinking {
    /// Half an hour of plenty, a pass every half minute, six hours to
    /// drain, never a host someone else drains, and a quarter of an hour
    /// draining before removal.
    pub const RECOMMENDED: Self = Self {
        after: Duration::from_secs(30 * 60),
        drain_every: Duration::from_secs(30),
        drain_within: Duration::from_secs(6 * 3600),
        adopt_after: None,
        quiet: Duration::from_secs(15 * 60),
    };
}

/// What the leader does next to shrink the group.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// Nothing now.
    Hold,
    /// Drain the host of this name (again), keeping programs.
    Drain(String),
    /// Delete the instance of this name from the group: its host owns no
    /// sandbox.
    Remove(String),
    /// Undrain the host of this name, which takes sandboxes again.
    TakeBack(String),
}

/// Why a host on its way out is taken back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Back {
    /// The group would grow.
    Grow,
    /// Its sandboxes did not all leave within [`Shrinking::drain_within`].
    Slow,
}

impl Back {
    pub const ALL: [Self; 2] = [Self::Grow, Self::Slow];

    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Grow => "grow",
            Self::Slow => "slow",
        }
    }
}

/// One look at the group, for [`Shrinker::plan`].
#[derive(Clone, Copy, Debug)]
pub struct Look<'a> {
    pub now: Instant,
    /// The service's clock now, in milliseconds, which the store notes a
    /// drain's start by ([`GroupHost::leader_drained_ms`]).
    pub now_ms: u64,
    /// What the group's policy decided.
    pub decision: ScaleDecision,
    /// The group's members, as its manager lists them.
    pub members: &'a [Member],
    /// Its registered hosts, by name.
    pub hosts: &'a HashMap<String, GroupHost>,
    /// The fewest live hosts it keeps.
    pub min_hosts: u32,
}

/// The host on its way out.
#[derive(Clone, Debug)]
struct Outgoing {
    name: String,
    /// When this leadership took it on, and how long its way out had
    /// already lasted then: a drain a leader before it began.
    since: Instant,
    head_start: Duration,
    /// Whether the leader drained it, rather than adopting it.
    ours: bool,
    /// When it was last asked to drain or be removed.
    asked: Option<Instant>,
    /// When a pass of this leadership first held: its quiet period counts
    /// from then.
    drained_since: Option<Instant>,
    /// What its last pass found; `None` before one, or if it failed.
    last: Option<Drained>,
    /// Whether the leader has seen it draining as it should.
    seen_draining: bool,
    /// Where its way out stands.
    way: Way,
}

impl Outgoing {
    fn age(&self, now: Instant) -> Duration {
        now.duration_since(self.since) + self.head_start
    }

    fn empty(&self) -> bool {
        self.last == Some(Drained::default())
    }
}

/// Where the way out of a host stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Way {
    /// On its way out.
    Out,
    /// To be taken back: asked until that holds.
    Back(Back),
    /// Its deletion was asked for, which the group may have accepted: it is
    /// never taken back.
    Removing,
}

/// What the leader's shrinking of its group is doing, for its metrics.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ShrinkSeen {
    /// The host on its way out.
    pub outgoing: Option<String>,
    /// How long its way out has lasted.
    pub draining_for: Duration,
    /// The sandboxes it still owned at its last pass.
    pub left: Option<usize>,
    /// Hosts the leader leaves draining or will not drain for now: ones
    /// whose sandboxes did not leave in time.
    pub skipped: usize,
    /// Whether shrinking waits for every host of the group to keep an idle
    /// sandbox's memory in a hand-off.
    pub held_back: bool,
    /// Removals asked of the group that it took, and that failed.
    pub removals: u64,
    pub removal_failures: u64,
    /// Take-backs that held, by [`Back`].
    pub taken_back: [u64; 2],
}

/// What one leadership remembers of shrinking its group.
#[derive(Debug, Default)]
pub struct Shrinker {
    /// Since when every look has found more spare than the group needs.
    wanted_since: Option<Instant>,
    /// When the group last grew or lost a host.
    changed: Option<Instant>,
    outgoing: Option<Outgoing>,
    /// Members someone else drains, by when it first saw each.
    draining_since: HashMap<String, Instant>,
    /// Members someone else drains whose removal it gave up on: left to
    /// whoever drained them.
    passed_over: HashSet<String>,
    /// Members it took back as too slow to drain, by until when it leaves
    /// them be.
    cooling: HashMap<String, Instant>,
    /// Whether some host of the group does not keep memory in a hand-off.
    held_back: bool,
    removals: u64,
    removal_failures: u64,
    taken_back: [u64; 2],
}

impl Shrinker {
    /// The name of the host on its way out, if one is.
    #[must_use]
    pub fn outgoing(&self) -> Option<&str> {
        self.outgoing
            .as_ref()
            .map(|outgoing| outgoing.name.as_str())
    }

    /// Whether host `name` is on its way out as one the leader drained,
    /// rather than one it adopted from someone else.
    #[must_use]
    pub fn ours(&self, name: &str) -> bool {
        self.outgoing
            .as_ref()
            .is_some_and(|outgoing| outgoing.name == name && outgoing.ours)
    }

    /// What it is doing at `now`, for the metrics.
    #[must_use]
    pub fn seen(&self, now: Instant) -> ShrinkSeen {
        ShrinkSeen {
            outgoing: self.outgoing.as_ref().map(|outgoing| outgoing.name.clone()),
            draining_for: self
                .outgoing
                .as_ref()
                .map_or(Duration::ZERO, |outgoing| outgoing.age(now)),
            left: self
                .outgoing
                .as_ref()
                .and_then(|outgoing| outgoing.last)
                .map(|last| last.left),
            skipped: self.cooling.len() + self.passed_over.len(),
            held_back: self.held_back,
            removals: self.removals,
            removal_failures: self.removal_failures,
            taken_back: self.taken_back,
        }
    }

    /// What to do now, with the group as `look` saw it.
    pub fn plan(&mut self, rules: &Shrinking, look: &Look<'_>) -> Step {
        let now = look.now;
        match look.decision {
            ScaleDecision::Grow { .. } => {
                self.wanted_since = None;
                self.changed = Some(now);
                if let Some(outgoing) = self
                    .outgoing
                    .as_mut()
                    .filter(|outgoing| outgoing.ours && outgoing.way == Way::Out)
                {
                    outgoing.way = Way::Back(Back::Grow);
                }
            }
            ScaleDecision::Shrink => {
                self.wanted_since.get_or_insert(now);
            }
            ScaleDecision::Hold => {
                if self.outgoing.is_none() {
                    self.wanted_since = None;
                }
            }
        }
        self.cooling.retain(|_, until| *until > now);
        let capable = self.capable(look);
        if let Some(step) = self.outgoing_step(rules, look, capable) {
            return step;
        }
        if let Some((name, at_ms)) = resumable(look) {
            // A drain a leader before this one began goes on as this one's.
            tracing::info!(
                host = name,
                "going on with a leader's drain of a host to remove it"
            );
            let head_start = Duration::from_millis(look.now_ms.saturating_sub(at_ms));
            self.start(name, now, true, head_start);
            if let (ScaleDecision::Grow { .. }, Some(outgoing)) =
                (look.decision, self.outgoing.as_mut())
            {
                outgoing.way = Way::Back(Back::Grow);
            }
            return self
                .outgoing_step(rules, look, capable)
                .unwrap_or(Step::Hold);
        }
        if let Some(name) = self.adoptable(rules, look) {
            tracing::info!(host = %name, "removing a host of the group that someone else drained");
            self.start(&name, now, false, Duration::ZERO);
            return self
                .outgoing_step(rules, look, capable)
                .unwrap_or(Step::Hold);
        }
        let settled = |since: Option<Instant>| {
            since.is_none_or(|since| now.duration_since(since) >= rules.after)
        };
        if look.decision != ScaleDecision::Shrink
            || self.wanted_since.is_none()
            || !settled(self.wanted_since)
            || !settled(self.changed)
            || !capable
            || live_hosts(look) <= look.min_hosts
        {
            return Step::Hold;
        }
        let Some(name) = self.roomiest(look) else {
            return Step::Hold;
        };
        tracing::info!(
            host = %name,
            "the host group has more spare than it needs; draining a host to remove it"
        );
        self.start(&name, now, true, Duration::ZERO);
        self.outgoing_step(rules, look, capable)
            .unwrap_or(Step::Hold)
    }

    /// The member someone else drains that is due to be adopted, if
    /// adopting is on, one is, and the group keeps its minimum without it.
    fn adoptable(&mut self, rules: &Shrinking, look: &Look<'_>) -> Option<String> {
        let others: Vec<&str> = look
            .members
            .iter()
            .filter(|member| !member.leaving)
            .filter(|member| {
                look.hosts
                    .get(&member.name)
                    .is_some_and(|host| host.draining && host.leader_drained_ms.is_none())
            })
            .map(|member| member.name.as_str())
            .collect();
        self.draining_since
            .retain(|name, _| others.contains(&name.as_str()));
        self.passed_over
            .retain(|name| others.contains(&name.as_str()));
        let listed = look.members.iter().filter(|member| !member.leaving).count();
        let room = live_hosts(look) >= look.min_hosts
            && u32::try_from(listed).unwrap_or(u32::MAX) > look.min_hosts;
        let mut due = None;
        for name in others {
            let since = *self
                .draining_since
                .entry(name.to_owned())
                .or_insert(look.now);
            if due.is_none()
                && room
                && !self.passed_over.contains(name)
                && rules
                    .adopt_after
                    .is_some_and(|after| look.now.duration_since(since) >= after)
            {
                due = Some(name.to_owned());
            }
        }
        due
    }

    /// The live host to drain: the most memory free without ending any VM
    /// process, then the fewest sandboxes, so the fewest move and the group
    /// loses the least; ties go by name. Never one it left be.
    fn roomiest(&self, look: &Look<'_>) -> Option<String> {
        look.members
            .iter()
            .filter(|member| !member.leaving && !member.stopped && member.idle)
            .filter(|member| !self.cooling.contains_key(&member.name))
            .filter_map(|member| {
                look.hosts
                    .get(&member.name)
                    .filter(|host| !host.draining)
                    .map(|host| (member.name.as_str(), host))
            })
            .max_by(|(a, a_host), (b, b_host)| {
                a_host
                    .unreclaimed_free_mib
                    .cmp(&b_host.unreclaimed_free_mib)
                    .then_with(|| b_host.sandboxes.cmp(&a_host.sandboxes))
                    .then_with(|| b.cmp(a))
            })
            .map(|(name, _)| name.to_owned())
    }

    /// Whether every host of the group keeps an idle sandbox's memory in a
    /// hand-off; says so once each time that changes.
    fn capable(&mut self, look: &Look<'_>) -> bool {
        let lacking: Vec<&str> = look
            .members
            .iter()
            .filter(|member| !member.leaving)
            .filter(|member| {
                look.hosts
                    .get(&member.name)
                    .is_some_and(|host| !host.keeps_memory)
            })
            .map(|member| member.name.as_str())
            .collect();
        let held_back = !lacking.is_empty();
        if held_back && !self.held_back {
            tracing::info!(
                hosts = ?lacking,
                "not shrinking the host group: hosts of an earlier release would end idle sandboxes' programs on the way out"
            );
        }
        self.held_back = held_back;
        !held_back
    }

    /// What to do with the host on its way out, if one is and anything
    /// follows for it. With `capable` false, it is neither drained nor
    /// removed meanwhile.
    fn outgoing_step(&mut self, rules: &Shrinking, look: &Look<'_>, capable: bool) -> Option<Step> {
        let now = look.now;
        let outgoing = self.outgoing.as_mut()?;
        let name = outgoing.name.clone();
        if !look
            .members
            .iter()
            .any(|member| member.name == name && !member.leaving)
        {
            // The group has removed it, or is removing it.
            tracing::info!(host = %name, "a host left the group");
            self.outgoing = None;
            self.wanted_since = None;
            self.changed = Some(now);
            return Some(Step::Hold);
        }
        // Drained as it should be: by the leader, if the leader drained it.
        let draining = look.hosts.get(&name).is_some_and(|host| {
            host.draining && (!outgoing.ours || host.leader_drained_ms.is_some())
        });
        if draining {
            outgoing.seen_draining = true;
        } else if outgoing.seen_draining {
            // Taken back, or drained anew, by someone else, or given up on:
            // nothing of it is the leader's to finish. Until it is first
            // seen draining, its drain may not have landed yet.
            tracing::info!(host = %name, "a host on its way out is no longer the leader's drain; leaving it");
            self.outgoing = None;
            return Some(Step::Hold);
        }
        if let Way::Back(_) = outgoing.way {
            // Asked again until it holds ([`Self::taken_back`]).
            return Some(Step::TakeBack(name));
        }
        let due = outgoing
            .asked
            .is_none_or(|asked| now.duration_since(asked) >= rules.drain_every);
        if outgoing.empty() {
            let quiet = outgoing
                .drained_since
                .is_some_and(|since| now.duration_since(since) >= rules.quiet);
            return Some(if due && quiet && capable {
                outgoing.asked = Some(now);
                Step::Remove(name)
            } else {
                Step::Hold
            });
        }
        if outgoing.age(now) >= rules.drain_within && outgoing.way != Way::Removing {
            if outgoing.ours {
                tracing::warn!(host = %name, within = ?rules.drain_within, "a host's sandboxes did not all leave in time; taking it back, and leaving it be as long");
                outgoing.way = Way::Back(Back::Slow);
                self.cooling.insert(name.clone(), now + rules.drain_within);
                return Some(Step::TakeBack(name));
            }
            self.outgoing = None;
            tracing::warn!(host = %name, within = ?rules.drain_within, "a drained host's sandboxes did not all leave in time; leaving it draining");
            self.passed_over.insert(name);
            return Some(Step::Hold);
        }
        Some(if due && capable {
            outgoing.asked = Some(now);
            Step::Drain(name)
        } else {
            Step::Hold
        })
    }

    fn start(&mut self, name: &str, now: Instant, ours: bool, head_start: Duration) {
        self.wanted_since = None;
        self.outgoing = Some(Outgoing {
            name: name.to_owned(),
            since: now,
            head_start,
            ours,
            asked: None,
            drained_since: None,
            last: None,
            seen_draining: false,
            way: Way::Out,
        });
    }

    /// Takes in what a drain pass of host `name` that ended at `now` came
    /// to: the first that held starts its quiet period, and one that found
    /// it owning no sandbox lets it be removed after that.
    pub fn drained(&mut self, name: &str, now: Instant, drained: Result<Drained, String>) {
        let Some(outgoing) = self
            .outgoing
            .as_mut()
            .filter(|outgoing| outgoing.name == name)
        else {
            return;
        };
        match drained {
            Ok(drained) => {
                outgoing.drained_since.get_or_insert(now);
                let before = outgoing.last.replace(drained).map(|last| last.left);
                if before != Some(drained.left) {
                    tracing::info!(
                        host = name,
                        moved = drained.moved,
                        left = drained.left,
                        "draining a host to remove it"
                    );
                }
            }
            Err(error) => {
                outgoing.last = None;
                tracing::warn!(%error, host = name, "draining a host to remove it failed");
            }
        }
    }

    /// Takes in what asking the group to delete host `name`'s instance
    /// came to. The host stays outgoing until the group no longer lists
    /// it; a failure is asked again. Asked once, it is never taken back:
    /// the group may have accepted it whatever the answer.
    pub fn removed(&mut self, name: &str, removed: Result<(), String>) {
        if let Some(outgoing) = self
            .outgoing
            .as_mut()
            .filter(|outgoing| outgoing.name == name)
        {
            outgoing.way = Way::Removing;
        }
        match removed {
            Ok(()) => {
                self.removals += 1;
                tracing::info!(host = name, "removed a drained host from the group");
            }
            Err(error) => {
                self.removal_failures += 1;
                tracing::warn!(%error, host = name, "removing a drained host from the group failed");
            }
        }
    }

    /// Takes in what taking host `name` back came to: it is forgotten once
    /// that holds, and asked again otherwise.
    pub fn taken_back(&mut self, name: &str, taken: Result<(), String>) {
        let Some(Way::Back(why)) = self
            .outgoing
            .as_ref()
            .filter(|outgoing| outgoing.name == name)
            .map(|outgoing| outgoing.way)
        else {
            return;
        };
        match taken {
            Ok(()) => {
                tracing::info!(
                    host = name,
                    why = why.label(),
                    "took back a host on its way out"
                );
                self.taken_back[why as usize] += 1;
                self.outgoing = None;
            }
            Err(error) => {
                tracing::warn!(%error, host = name, "taking back a host on its way out failed; asking again");
            }
        }
    }
}

/// The member the leader drained that it is not draining now (a leader
/// before it began the drain), with when its drain began: the earliest.
fn resumable<'a>(look: &Look<'a>) -> Option<(&'a str, u64)> {
    look.members
        .iter()
        .filter(|member| !member.leaving)
        .filter_map(|member| {
            look.hosts
                .get(&member.name)
                .filter(|host| host.draining)
                .and_then(|host| host.leader_drained_ms)
                .map(|at_ms| (member.name.as_str(), at_ms))
        })
        .min_by_key(|(name, at_ms)| (*at_ms, *name))
}

/// How many of the group's members have a live host, which takes
/// sandboxes.
fn live_hosts(look: &Look<'_>) -> u32 {
    let live = look
        .members
        .iter()
        .filter(|member| !member.leaving)
        .filter(|member| {
            look.hosts
                .get(&member.name)
                .is_some_and(|host| !host.draining)
        })
        .count();
    u32::try_from(live).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests;
