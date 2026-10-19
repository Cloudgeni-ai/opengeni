//! Sandbox ownership as compare-and-set updates.
//!
//! The store keeps, for each sandbox, its owner host (if any), its owner
//! epoch, and the epoch at which a host last took it. Every change is
//! applied only while the row still holds what the change expects, so two
//! replicas racing to place the same sandbox, or a recovery racing a
//! returning host, can never both win: the loser reads the row again and
//! decides anew.
//!
//! The epoch rises with every change, so each period of ownership has an
//! epoch of its own. A sandbox goes through these:
//!
//! - created on a host at [`OwnerEpoch::FIRST`];
//! - given to a host ([`Ownership::give`]): one that adopts it from its
//!   latest archive, or another one when the first refused it outright,
//!   holding nothing of it;
//! - left without an owner when its owner handed it off
//!   ([`Ownership::release`]), held nothing of it ([`Ownership::clear`]) or
//!   was lost ([`Ownership::lose`]);
//! - reclaimed by a host that still has the newest copy because nobody
//!   took the sandbox since that host last ran it ([`reconcile`]).
//!
//! Creating and giving are takes: they start the sandbox from somewhere
//! other than the copy its last owner kept. A host's copy is the newest
//! only while no take happened after the epoch it last ran it under.
//!
//! A host that releases a sandbox hands its latest state off first, so the
//! store's copy is the sandbox as it was. A lost host hands nothing off: the
//! store's copy is the last one it made, and the sandbox may have run on
//! past it. Its memory image is then of a past the sandbox's programs had
//! already left (and told others of), so whoever takes it next starts it
//! from the copy's files alone, as after a crash.
//!
//! So the row names the epoch under which the store's copy is known to be
//! the sandbox's whole latest state ([`Ownership::whole`]), and the copy is
//! taken up with its memory only while that is the row's own epoch
//! ([`Ownership::whole_copy`]). A hand-off sets it to the epoch it leaves;
//! a change whose owner held nothing of the sandbox (a give, or clearing an
//! owner that held nothing) carries it on to the new epoch; every other
//! change raises the epoch past it. That includes a change made by a
//! service from before the mark existed, which writes the epoch but not
//! the mark: such a service can only make a copy count as not whole, never
//! as whole.

use crate::SandboxId;
use crate::ids::{HostId, OwnerEpoch};

/// Who owns a sandbox, under which epoch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Ownership {
    /// The host that may run it; `None` while nobody may.
    pub owner: Option<HostId>,
    /// The current period of ownership.
    pub epoch: OwnerEpoch,
    /// The epoch of the last create or give.
    pub taken: OwnerEpoch,
    /// The epoch under which the store's copy is the sandbox's whole latest
    /// state, memory and all, if any: see [`Ownership::whole_copy`].
    pub whole: Option<OwnerEpoch>,
}

/// An update of a sandbox's ownership, applied only while the row still
/// holds `expect`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Change {
    /// What the row must hold for the change to apply.
    pub expect: Ownership,
    /// What it holds afterwards.
    pub set: Ownership,
}

impl Ownership {
    /// A sandbox created on `host`.
    #[must_use]
    pub const fn created(host: HostId) -> Self {
        Self {
            owner: Some(host),
            epoch: OwnerEpoch::FIRST,
            taken: OwnerEpoch::FIRST,
            whole: Some(OwnerEpoch::FIRST),
        }
    }

    /// Whether the store's copy is the sandbox's whole latest state under
    /// the current epoch, so that a host taking it up now may restore its
    /// memory. When not, the last owner may have run the sandbox past the
    /// copy (it was lost, or nothing vouched for the copy since), and the
    /// copy is taken up from its files alone.
    #[must_use]
    pub const fn whole_copy(self) -> bool {
        match self.whole {
            Some(whole) => whole.0 == self.epoch.0,
            None => false,
        }
    }

    /// The mark for `epoch`, a change from this ownership in which nobody
    /// can have run the sandbox past its stored copy.
    const fn carried(self, epoch: OwnerEpoch) -> Option<OwnerEpoch> {
        if self.whole_copy() {
            Some(epoch)
        } else {
            self.whole
        }
    }

    /// Gives the sandbox to `host` under a new epoch. Only for a sandbox
    /// nobody owns, or one whose owner answered that it holds nothing of
    /// it (it refused the create or adopt outright): an owner that might
    /// hold it must release it or be lost first.
    #[must_use]
    pub const fn give(self, host: HostId) -> Change {
        let epoch = self.epoch.next();
        Change {
            expect: self,
            set: Self {
                owner: Some(host),
                epoch,
                taken: epoch,
                whole: self.carried(epoch),
            },
        }
    }

    /// Leaves the sandbox without an owner under a new epoch, once its
    /// owner released it, handing its latest state off: the store's copy
    /// is its whole latest state.
    #[must_use]
    pub const fn release(self) -> Change {
        let epoch = self.epoch.next();
        Change {
            expect: self,
            set: Self {
                owner: None,
                epoch,
                taken: self.taken,
                whole: Some(epoch),
            },
        }
    }

    /// Leaves the sandbox without an owner under a new epoch, once its
    /// owner answered that it holds nothing of it. The store's copy is as
    /// whole as it was: that owner either never ran it or already handed
    /// it off, saving it first, under an earlier attempt whose answer was
    /// lost. Only a hand-off that answers done vouches for a copy, so the
    /// second case stays as conservative as the first.
    #[must_use]
    pub const fn clear(self) -> Change {
        let epoch = self.epoch.next();
        Change {
            expect: self,
            set: Self {
                owner: None,
                epoch,
                taken: self.taken,
                whole: self.carried(epoch),
            },
        }
    }

    /// Leaves the sandbox without an owner under a new epoch, once its
    /// owner was lost: its stored copy is no longer known to be its latest
    /// state, so the mark stays behind.
    #[must_use]
    pub const fn lose(self) -> Change {
        Change {
            expect: self,
            set: Self {
                owner: None,
                epoch: self.epoch.next(),
                taken: self.taken,
                whole: self.whole,
            },
        }
    }

    /// Returns the sandbox to `host`, which holds its newest copy, under a
    /// new epoch. That copy is the host's own, ahead of the store's, so the
    /// mark stays behind.
    const fn reclaim(self, host: HostId) -> Change {
        Change {
            expect: self,
            set: Self {
                owner: Some(host),
                epoch: self.epoch.next(),
                taken: self.taken,
                whole: self.whole,
            },
        }
    }
}

/// A sandbox a registering host still has, under the epoch it last ran it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Listed {
    /// Which sandbox.
    pub sandbox: SandboxId,
    /// The epoch in its record.
    pub epoch: OwnerEpoch,
}

/// What a host does with a sandbox it lists.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Verdict {
    /// Keep the local copy and run it under `epoch` from now on.
    Keep {
        /// Its epoch from now on.
        epoch: OwnerEpoch,
    },
    /// Keep the local copy if `change` applies, under its new epoch;
    /// otherwise decide again from the row as it is then.
    Reclaim {
        /// The update that gives it back.
        change: Change,
    },
    /// The host owns it, but its copy is older than the latest archive:
    /// drop the copy and adopt the archive under `epoch`.
    Refetch {
        /// Its epoch from now on.
        epoch: OwnerEpoch,
        /// Whether to take the archive up from its files alone, as
        /// it is when [`Ownership::whole_copy`] does not vouch for it.
        from_files: bool,
    },
    /// Drop the local copy: it belongs to someone else, or no longer
    /// exists.
    Drop,
}

/// What `host` does with a sandbox it lists under `listed`, given the
/// store's row for it (`None` once the sandbox is deleted).
///
/// Its copy is the newest there is while no host took the sandbox after
/// `listed`: then it keeps the sandbox if it still owns it, and gets it
/// back if nobody does. Anything taken later started from elsewhere, and
/// the copy is dropped, or replaced from the archive if the host owns the
/// sandbox again.
#[must_use]
pub fn reconcile(host: HostId, listed: OwnerEpoch, row: Option<Ownership>) -> Verdict {
    let Some(row) = row else {
        return Verdict::Drop;
    };
    if listed > row.epoch {
        // An epoch the store never gave: not a copy to trust.
        return Verdict::Drop;
    }
    let newest = row.taken <= listed;
    match row.owner {
        Some(owner) if owner == host && newest => Verdict::Keep { epoch: row.epoch },
        Some(owner) if owner == host => Verdict::Refetch {
            epoch: row.epoch,
            from_files: !row.whole_copy(),
        },
        None if newest => Verdict::Reclaim {
            change: row.reclaim(host),
        },
        _ => Verdict::Drop,
    }
}

#[cfg(test)]
mod tests {
    use super::{HostId, OwnerEpoch, Ownership, Verdict, reconcile};

    const A: HostId = HostId(1);
    const B: HostId = HostId(2);

    fn row(owner: Option<HostId>, epoch: u64, taken: u64) -> Ownership {
        Ownership {
            owner,
            epoch: OwnerEpoch(epoch),
            taken: OwnerEpoch(taken),
            whole: Some(OwnerEpoch(epoch)),
        }
    }

    #[test]
    fn every_change_raises_the_epoch_and_only_takes_move_taken() {
        let created = Ownership::created(A);
        let cleared = created.release();
        assert_eq!(cleared.expect, created);
        assert_eq!(cleared.set, row(None, 2, 1));
        let given = cleared.set.give(B);
        assert_eq!(given.set, row(Some(B), 3, 3));
        let reclaimed = given.set.release().set.reclaim(B).set;
        assert_eq!(
            reclaimed,
            Ownership {
                whole: Some(OwnerEpoch(4)),
                ..row(Some(B), 5, 3)
            }
        );
    }

    #[test]
    fn only_a_hand_off_or_a_create_vouches_for_the_stored_copy() {
        let lost = Ownership::created(A).lose();
        assert_eq!(lost.expect, Ownership::created(A));
        assert!(!lost.set.whole_copy());
        // Given on, refused, cleared and given again, lost again and
        // reclaimed, it still starts from files...
        let given = lost.set.give(B).set;
        assert!(!given.whole_copy());
        assert!(!given.clear().set.give(A).set.whole_copy());
        assert!(!given.lose().set.reclaim(B).set.whole_copy());
        // ...until an owner hands its latest state off.
        assert!(given.release().set.whole_copy());
        assert!(given.release().set.give(A).set.whole_copy());
    }

    #[test]
    fn a_whole_copy_stays_whole_only_through_owners_that_held_nothing() {
        let handed_off = Ownership::created(A).release().set;
        // Given to a host that refused it outright, then to another, or
        // cleared from one that never took it up: nobody ran it.
        let given = handed_off.give(A).set;
        assert!(given.give(B).set.whole_copy());
        assert!(given.clear().set.give(B).set.whole_copy());
        // Its owner lost, or a host taking its own copy back: not whole.
        assert!(!given.lose().set.whole_copy());
        assert!(!given.lose().set.give(B).set.whole_copy());
        assert!(!given.release().set.reclaim(A).set.whole_copy());
        // A service from before the mark raises the epoch and leaves the
        // mark behind.
        let older = Ownership {
            owner: None,
            epoch: given.epoch.next(),
            ..given
        };
        assert!(!older.whole_copy());
        assert!(!older.give(B).set.whole_copy());
        assert!(
            !Ownership {
                whole: None,
                ..handed_off
            }
            .whole_copy()
        );
    }

    #[test]
    fn a_host_keeps_or_gets_back_what_nobody_took_since() {
        let e = OwnerEpoch(5);
        assert_eq!(
            reconcile(A, e, Some(row(Some(A), 5, 2))),
            Verdict::Keep { epoch: e }
        );
        // Reclaimed by A, which crashed before it noted the epoch.
        assert_eq!(
            reconcile(A, e, Some(row(Some(A), 7, 5))),
            Verdict::Keep {
                epoch: OwnerEpoch(7)
            }
        );
        // Lost, reclaimed, lost again, all before A heard of any of it.
        let Verdict::Reclaim { change } = reconcile(A, e, Some(row(None, 9, 5))) else {
            panic!("a lost host does not get back what nobody took");
        };
        assert_eq!(
            change.set,
            Ownership {
                whole: Some(OwnerEpoch(9)),
                ..row(Some(A), 10, 5)
            }
        );
        assert!(
            !change.set.whole_copy(),
            "its own copy is ahead of the store's"
        );
    }

    #[test]
    fn a_host_drops_what_was_taken_since() {
        let e = OwnerEpoch(5);
        assert_eq!(reconcile(A, e, Some(row(Some(B), 7, 7))), Verdict::Drop);
        assert_eq!(reconcile(A, e, Some(row(Some(B), 5, 5))), Verdict::Drop);
        // Adopted elsewhere, then cleared again.
        assert_eq!(reconcile(A, e, Some(row(None, 8, 7))), Verdict::Drop);
        assert_eq!(reconcile(A, e, Some(row(None, 4, 1))), Verdict::Drop);
        assert_eq!(reconcile(A, e, None), Verdict::Drop);
        // A owns it again, but took it from the archive after its copy.
        assert_eq!(
            reconcile(A, e, Some(row(Some(A), 9, 9))),
            Verdict::Refetch {
                epoch: OwnerEpoch(9),
                from_files: false,
            }
        );
        // The archive a lost owner left is taken up from its files.
        let after_loss = Ownership {
            whole: Some(OwnerEpoch(7)),
            ..row(Some(A), 9, 9)
        };
        assert_eq!(
            reconcile(A, e, Some(after_loss)),
            Verdict::Refetch {
                epoch: OwnerEpoch(9),
                from_files: true,
            }
        );
    }
}
