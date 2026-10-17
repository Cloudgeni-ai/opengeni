//! What the service does with a host's answer to a request about one
//! sandbox.
//!
//! The service sends a sandbox's owner creates, adopts, wakes and
//! hand-offs, each under the sandbox's owner epoch. Answers can arrive
//! late and out of order, so an answer that the host holds nothing of the
//! sandbox is final only once two things hold ([ADR 18]):
//!
//! - no create or adopt sent under that epoch can still reach the host:
//!   the host refuses any request more than the request window of
//!   renewals old, so one is settled once the answer came that many
//!   renewals after its stamp ([`LeaseTerms::settles`]);
//! - the answer was given after the last create or adopt the host
//!   confirmed under that epoch: under a later registration, or after a
//!   later renewal ([`AnsweredAt::later_than`]). A hand-off that overtakes
//!   a create can otherwise answer "not found" before the create's "done"
//!   and arrive after it.
//!
//! [`Sends`] keeps what that needs per sandbox, and [`answered`] decides
//! what follows an answer. Both are what the seeded simulation of the
//! protocol runs, and the service too.
//!
//! [ADR 18]: ../../../docs/adr/0018-the-fleet-service-leases-and-fences.md

use crate::ids::{HostEpoch, HostId, OwnerEpoch};
use crate::lease::LeaseTerms;
use crate::own::{Change, Ownership};

/// When a host answered: under which registration, and the number of the
/// last renewal it had sent under it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct AnsweredAt {
    /// The registration it held, if any.
    pub host_epoch: Option<HostEpoch>,
    /// Its last renewal sent under it.
    pub seq: u64,
}

impl AnsweredAt {
    /// Whether this answer was given after `than`: under a later
    /// registration, or after a later renewal of the same one. Two answers
    /// between the same renewals do not order, and neither does one given
    /// without a registration.
    #[must_use]
    pub fn later_than(self, than: Self) -> bool {
        match (self.host_epoch, than.host_epoch) {
            (Some(epoch), Some(than_epoch)) if epoch != than_epoch => epoch > than_epoch,
            (Some(_), None) => true,
            (None, _) => false,
            _ => self.seq > than.seq,
        }
    }
}

/// A request about one sandbox.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Op {
    /// Create it on the host.
    Create,
    /// Take it on from its latest archive.
    Adopt,
    /// Wake it, or connect to it.
    Wake,
    /// Hand it off, so another host can adopt it.
    HandOff,
}

impl Op {
    /// Whether the request gives the host the sandbox.
    #[must_use]
    pub const fn takes(self) -> bool {
        matches!(self, Self::Create | Self::Adopt)
    }
}

/// What a host answered, as far as ownership goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Outcome {
    /// It did it.
    Done,
    /// It refused outright and holds nothing of the sandbox: it is full,
    /// its registration or lease is not the one the request was sent
    /// under, or the request was too old.
    Refused,
    /// It holds nothing of the sandbox under that epoch.
    NotFound,
    /// Anything else: busy, stale, broken, no archive.
    Other,
}

/// What the service keeps per sandbox of the creates and adopts it sent.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Sends {
    /// The last create or adopt sent and not answered yet: its owner epoch
    /// and the renewal stamp it carried.
    pub unanswered: Option<(OwnerEpoch, u64)>,
    /// The last create or adopt the owner confirmed, while it still owned
    /// the sandbox: its owner epoch and when it answered.
    pub landed: Option<(OwnerEpoch, AnsweredAt)>,
}

impl Sends {
    /// Notes a create or adopt about to be sent under `epoch`, stamped
    /// `stamp`.
    pub fn send(&mut self, epoch: OwnerEpoch, stamp: u64) {
        self.unanswered = Some((epoch, stamp));
    }

    /// Whether an answer given `at` that the host holds nothing under
    /// `epoch` is final: no create or adopt under it can land later.
    #[must_use]
    pub fn settled(&self, terms: LeaseTerms, epoch: OwnerEpoch, at: AnsweredAt) -> bool {
        self.unanswered
            .is_none_or(|(sent, stamp)| sent != epoch || terms.settles(stamp, at.seq))
            && self
                .landed
                .is_none_or(|(landed, when)| landed != epoch || at.later_than(when))
    }
}

/// What follows an answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Next {
    /// Nothing changes.
    Nothing,
    /// The host holds nothing of it: place it on another host and send the
    /// same request there, under a new epoch ([`Ownership::give`]).
    PlaceElsewhere,
    /// The host holds nothing of it under this epoch, but its archive
    /// does: give it to the same host again under a new epoch and adopt
    /// the archive there, so a late answer about the old epoch changes
    /// nothing.
    AdoptHere(Change),
    /// The host no longer has it: leave it without an owner under a new
    /// epoch, for the next wake to adopt elsewhere.
    Clear(Change),
}

/// The answer `outcome`, given `at`, to `op` sent to `host` under `epoch`:
/// records it in `sends` and says what follows, given the sandbox's row as
/// it is now, whether an archive of it exists, and how many hosts already
/// refused it (`tries`, of at most `max_tries`).
#[expect(clippy::too_many_arguments, reason = "one per fact the rule weighs")]
pub fn answered(
    sends: &mut Sends,
    terms: LeaseTerms,
    (op, host, epoch): (Op, HostId, OwnerEpoch),
    outcome: Outcome,
    at: AnsweredAt,
    row: Ownership,
    archived: bool,
    (tries, max_tries): (u32, u32),
) -> Next {
    let still = row.owner == Some(host) && row.epoch == epoch;
    if op.takes() {
        if sends.unanswered.is_some_and(|(sent, _)| sent == epoch) {
            // Answered: it can no longer land later.
            sends.unanswered = None;
        }
        if outcome == Outcome::Done && still {
            sends.landed = Some((epoch, at));
        }
    }
    let settled = sends.settled(terms, epoch, at);
    match (op, outcome) {
        (Op::Create | Op::Adopt, Outcome::Refused) if still && tries < max_tries => {
            Next::PlaceElsewhere
        }
        (Op::Wake, Outcome::NotFound) if still && settled && archived => {
            Next::AdoptHere(row.give(host))
        }
        (Op::HandOff, Outcome::Done) if still => Next::Clear(row.clear()),
        (Op::HandOff, Outcome::NotFound) if still && settled => Next::Clear(row.clear()),
        _ => Next::Nothing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TERMS: LeaseTerms = LeaseTerms::RECOMMENDED;
    const A: HostId = HostId(1);
    const B: HostId = HostId(2);
    const E: OwnerEpoch = OwnerEpoch(3);

    fn at(host_epoch: u64, seq: u64) -> AnsweredAt {
        AnsweredAt {
            host_epoch: Some(HostEpoch(host_epoch)),
            seq,
        }
    }

    fn owned_by(host: HostId) -> Ownership {
        Ownership {
            owner: Some(host),
            epoch: E,
            taken: E,
        }
    }

    #[test]
    fn answers_order_by_registration_then_renewal() {
        assert!(at(2, 1).later_than(at(1, 9)));
        assert!(!at(1, 9).later_than(at(2, 1)));
        assert!(at(1, 4).later_than(at(1, 3)));
        assert!(!at(1, 3).later_than(at(1, 3)), "between the same renewals");
        let unregistered = AnsweredAt {
            host_epoch: None,
            seq: 5,
        };
        assert!(at(1, 0).later_than(unregistered));
        assert!(!unregistered.later_than(unregistered));
    }

    #[test]
    fn a_refused_create_goes_elsewhere_only_while_the_row_still_names_that_host() {
        let mut sends = Sends::default();
        sends.send(E, 4);
        let refused = |sends: &mut Sends, row, tries| {
            answered(
                sends,
                TERMS,
                (Op::Create, A, E),
                Outcome::Refused,
                at(1, 4),
                row,
                false,
                (tries, 3),
            )
        };
        assert_eq!(refused(&mut sends, owned_by(A), 0), Next::PlaceElsewhere);
        assert_eq!(sends.unanswered, None, "answered");
        assert_eq!(refused(&mut sends, owned_by(B), 0), Next::Nothing);
        assert_eq!(
            refused(&mut sends, owned_by(A), 3),
            Next::Nothing,
            "tried enough"
        );
    }

    #[test]
    fn not_found_is_final_only_once_no_create_can_land_and_after_the_last_one_that_did() {
        let row = owned_by(A);
        let wake = |sends: &mut Sends, when| {
            answered(
                sends,
                TERMS,
                (Op::Wake, A, E),
                Outcome::NotFound,
                when,
                row,
                true,
                (0, 3),
            )
        };
        // A create stamped 4 is still on its way: not found means nothing
        // until the host is past the request window.
        let mut sends = Sends::default();
        sends.send(E, 4);
        assert_eq!(wake(&mut sends, at(1, 5)), Next::Nothing);
        let past = 4 + TERMS.request_window + 1;
        assert_eq!(wake(&mut sends, at(1, past)), Next::AdoptHere(row.give(A)));

        // The create landed at renewal 7: a not-found given at 7 may have
        // overtaken it, one at 8 was given after.
        let mut sends = Sends::default();
        sends.send(E, 4);
        let landed = answered(
            &mut sends,
            TERMS,
            (Op::Create, A, E),
            Outcome::Done,
            at(1, 7),
            row,
            false,
            (0, 3),
        );
        assert_eq!(landed, Next::Nothing);
        assert_eq!(sends.landed, Some((E, at(1, 7))));
        assert_eq!(wake(&mut sends, at(1, 7)), Next::Nothing);
        assert_eq!(wake(&mut sends, at(1, 8)), Next::AdoptHere(row.give(A)));

        // Without an archive there is nothing to adopt.
        let none = answered(
            &mut Sends::default(),
            TERMS,
            (Op::Wake, A, E),
            Outcome::NotFound,
            at(1, 9),
            row,
            false,
            (0, 3),
        );
        assert_eq!(none, Next::Nothing);
    }

    #[test]
    fn a_hand_off_clears_the_owner_once_done_or_finally_not_found() {
        let row = owned_by(A);
        let hand_off = |outcome, row| {
            answered(
                &mut Sends::default(),
                TERMS,
                (Op::HandOff, A, E),
                outcome,
                at(1, 9),
                row,
                true,
                (0, 3),
            )
        };
        assert_eq!(hand_off(Outcome::Done, row), Next::Clear(row.clear()));
        assert_eq!(hand_off(Outcome::NotFound, row), Next::Clear(row.clear()));
        assert_eq!(hand_off(Outcome::Other, row), Next::Nothing);
        assert_eq!(hand_off(Outcome::Done, owned_by(B)), Next::Nothing);
    }
}
