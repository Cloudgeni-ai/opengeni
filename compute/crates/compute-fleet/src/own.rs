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
//!   lost its copy ([`Ownership::lose`]);
//! - reclaimed by a host that still has the newest copy because nobody
//!   took the sandbox since that host last ran it ([`reconcile`]).
//!
//! A host the service gives up on keeps owning its sandboxes: it may come
//! back with copies newer than the store's, so they wait for it, and it
//! keeps them when it registers again. Only once its copy is known gone
//! (it came back without it, its machine was deleted, or an operator
//! declared it gone for good) is its sandbox lost, and taken up from the
//! store's older copy. A host declared gone that comes back after all
//! sets aside, rather than drops, each copy taken since
//! ([`Verdict::SetAside`]): nothing newer is ever deleted unseen.
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
//! change raises the epoch past it.

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
    /// owner's copy is gone, or declared gone: it came back without it, its
    /// machine was deleted, or an operator gave up waiting for it. Its
    /// stored copy is no longer known to be its latest state, so the mark
    /// stays behind.
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

    /// Takes a sandbox nobody owns anew, leaving it without an owner under
    /// a new epoch, as a give would: no host that still holds a copy of an
    /// earlier epoch, such as one given up on, gets it back
    /// ([`reconcile`]), and its next owner starts from the store's copy.
    /// For a change of what the sandbox is, such as its shape, which no
    /// host may then hold as it was. Without `whole`, the copy is taken up
    /// from its files alone, as after a lost owner: for a change its memory
    /// image cannot follow, such as other processors or memory.
    #[must_use]
    pub const fn retake(self, whole: bool) -> Change {
        let epoch = self.epoch.next();
        Change {
            expect: self,
            set: Self {
                owner: None,
                epoch,
                taken: epoch,
                whole: if whole { self.carried(epoch) } else { None },
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
    /// Keep the local copy's files aside, out of the fleet's way, and
    /// forget the sandbox: the host was declared gone while it owned it,
    /// and the sandbox was taken up since from an older stored copy. The
    /// local copy may be the newer one, so it is never deleted unseen.
    SetAside,
}

/// What `host` does with a sandbox it lists under `listed`, given the
/// store's row for it (`None` once the sandbox is deleted) and, if a host
/// was declared gone while it owned the sandbox, the epoch the latest such
/// declaration raised the sandbox to (`declared`).
///
/// Its copy is the newest there is while no host took the sandbox after
/// `listed`: then it keeps the sandbox if it still owns it, and gets it
/// back if nobody does. Anything taken later started from elsewhere, and
/// the copy is dropped, or replaced from the archive if the host owns the
/// sandbox again; but a copy from before a declaration that its owner was
/// gone may be ahead of whatever was taken up since, so it is set aside.
#[must_use]
pub fn reconcile(
    host: HostId,
    listed: OwnerEpoch,
    row: Option<Ownership>,
    declared: Option<OwnerEpoch>,
) -> Verdict {
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
        _ if declared.is_some_and(|declared| listed < declared) => Verdict::SetAside,
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
        // Taken anew for a change its memory cannot follow: not whole,
        // through later gives too; for one it can, as whole as it was.
        assert!(!handed_off.retake(false).set.whole_copy());
        assert!(!handed_off.retake(false).set.give(B).set.whole_copy());
        assert!(handed_off.retake(true).set.give(B).set.whole_copy());
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
            reconcile(A, e, Some(row(Some(A), 5, 2)), None),
            Verdict::Keep { epoch: e }
        );
        // Reclaimed by A, which crashed before it noted the epoch.
        assert_eq!(
            reconcile(A, e, Some(row(Some(A), 7, 5)), None),
            Verdict::Keep {
                epoch: OwnerEpoch(7)
            }
        );
        // Lost, reclaimed, lost again, all before A heard of any of it.
        let Verdict::Reclaim { change } = reconcile(A, e, Some(row(None, 9, 5)), None) else {
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
        assert_eq!(
            reconcile(A, e, Some(row(Some(B), 7, 7)), None),
            Verdict::Drop
        );
        assert_eq!(
            reconcile(A, e, Some(row(Some(B), 5, 5)), None),
            Verdict::Drop
        );
        // Adopted elsewhere, then cleared again.
        assert_eq!(reconcile(A, e, Some(row(None, 8, 7)), None), Verdict::Drop);
        assert_eq!(reconcile(A, e, Some(row(None, 4, 1)), None), Verdict::Drop);
        assert_eq!(reconcile(A, e, None, None), Verdict::Drop);
        // Lost, then taken anew while nobody owned it: its copy stays as
        // whole as it was.
        let retaken = row(None, 6, 5).retake(true).set;
        assert_eq!(retaken, row(None, 7, 7));
        assert_eq!(reconcile(A, e, Some(retaken), None), Verdict::Drop);
        // A owns it again, but took it from the archive after its copy.
        assert_eq!(
            reconcile(A, e, Some(row(Some(A), 9, 9)), None),
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
            reconcile(A, e, Some(after_loss), None),
            Verdict::Refetch {
                epoch: OwnerEpoch(9),
                from_files: true,
            }
        );
    }

    #[test]
    fn a_host_given_up_on_keeps_what_waited_for_it() {
        // Given up on, it still owns what it held: back, it keeps it all
        // under the same epoch, newer writes included.
        let e = OwnerEpoch(5);
        assert_eq!(
            reconcile(A, e, Some(row(Some(A), 5, 3)), None),
            Verdict::Keep { epoch: e }
        );
    }

    #[test]
    fn a_host_declared_gone_sets_aside_what_was_taken_since() {
        let e = OwnerEpoch(5);
        // Declared gone: lost under epoch 6, adopted elsewhere under 7.
        let declared = row(Some(A), 5, 3).lose().set;
        assert_eq!(declared.epoch, OwnerEpoch(6));
        let adopted = declared.give(B).set;
        assert_eq!(
            reconcile(A, e, Some(adopted), Some(declared.epoch)),
            Verdict::SetAside,
            "its copy may be ahead of the one taken up since"
        );
        // Adopted and handed off again since, or nobody owns it now.
        let back = adopted.release().set;
        assert_eq!(
            reconcile(A, e, Some(back), Some(declared.epoch)),
            Verdict::SetAside
        );
        // Nobody took it since the declaration: its copy is the newest.
        assert!(matches!(
            reconcile(A, e, Some(declared), Some(declared.epoch)),
            Verdict::Reclaim { .. }
        ));
        // A copy it took up after the declaration is an ordinary one.
        assert_eq!(
            reconcile(
                A,
                OwnerEpoch(7),
                Some(adopted.lose().set.give(B).set),
                Some(OwnerEpoch(6))
            ),
            Verdict::Drop
        );
        // Deleted since: nothing to keep it for.
        assert_eq!(reconcile(A, e, None, Some(declared.epoch)), Verdict::Drop);
    }
}
