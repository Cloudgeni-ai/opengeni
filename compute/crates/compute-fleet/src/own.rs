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
//! - cleared when its owner released it or was lost ([`Ownership::clear`]);
//! - reclaimed by a host that still has the newest copy because nobody
//!   took the sandbox since that host last ran it ([`reconcile`]).
//!
//! Creating and giving are takes: they start the sandbox from somewhere
//! other than the copy its last owner kept. A host's copy is the newest
//! only while no take happened after the epoch it last ran it under.

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
            },
        }
    }

    /// Leaves the sandbox without an owner under a new epoch, once its
    /// owner released it or was lost.
    #[must_use]
    pub const fn clear(self) -> Change {
        Change {
            expect: self,
            set: Self {
                owner: None,
                epoch: self.epoch.next(),
                taken: self.taken,
            },
        }
    }

    /// Returns the sandbox to `host`, which holds its newest copy, under a
    /// new epoch.
    const fn reclaim(self, host: HostId) -> Change {
        Change {
            expect: self,
            set: Self {
                owner: Some(host),
                epoch: self.epoch.next(),
                taken: self.taken,
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
        Some(owner) if owner == host => Verdict::Refetch { epoch: row.epoch },
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
        }
    }

    #[test]
    fn every_change_raises_the_epoch_and_only_takes_move_taken() {
        let created = Ownership::created(A);
        let cleared = created.clear();
        assert_eq!(cleared.expect, created);
        assert_eq!(cleared.set, row(None, 2, 1));
        let given = cleared.set.give(B);
        assert_eq!(given.set, row(Some(B), 3, 3));
        assert_eq!(given.set.clear().set.reclaim(B).set, row(Some(B), 5, 3));
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
        assert_eq!(change.set, row(Some(A), 10, 5));
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
                epoch: OwnerEpoch(9)
            }
        );
    }
}
