//! The fence on archive pointers in object storage.
//!
//! Each sandbox's archive pointer carries a [`Stamp`]: the owner epoch of
//! the host that wrote it and that host's number for the change. Every
//! write is conditional on the version read, and [`fence`] decides from
//! that very version whether to write at all. So a write is checked at
//! every attempt and retry: one held up in flight lands only on the
//! version it checked, and after any other write it reads and checks
//! again.
//!
//! - Owners order by epoch. A new owner first claims the pointer (stores
//!   it again under its own epoch, or an empty one if there is none), and
//!   from then on every write of an earlier owner is [`Fence::Superseded`].
//! - Within one owner, each archive and each rewrite (such as forgetting a
//!   memory image) takes a new number from a counter the host records
//!   before the store sees it, so a change never lands over a later one,
//!   even when two overlap, and a retry tells its own change, already
//!   there ([`Fence::Done`]), from a later one ([`Fence::Outdated`]).
//! - A delete leaves a tombstone under the deleting owner's epoch. It is
//!   final: nothing writes over it, and every later change by that owner
//!   or an earlier one finds the sandbox [`Fence::Deleted`], not done.

use std::cmp::Ordering;

use crate::ids::OwnerEpoch;

/// What an archive pointer says about the change it names. Stamps order by
/// epoch, then by number.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Stamp {
    /// The owner epoch of the host that wrote the pointer.
    pub epoch: OwnerEpoch,
    /// That host's number for the change, rising with each archive or
    /// rewrite it makes. A host that claims a sandbox continues from the
    /// number it claims.
    pub save: u64,
}

/// What a pointer holds, as read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Found {
    /// There is none.
    Nothing,
    /// A pointer under this stamp; it may be empty, as an archive in
    /// flight or a claim of nothing leaves it.
    Copy(Stamp),
    /// The tombstone a delete by this owner left.
    Tombstone(OwnerEpoch),
}

/// A change of a pointer by its owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Mutation {
    /// Publish a new save.
    Archive(Stamp),
    /// Replace the copy with part of it, such as without its memory image.
    Rewrite(Stamp),
    /// Take the pointer over under a later epoch.
    Claim(OwnerEpoch),
    /// Delete the sandbox, leaving a tombstone.
    Delete(OwnerEpoch),
}

impl Mutation {
    /// The owner epoch it is made under.
    #[must_use]
    pub const fn epoch(self) -> OwnerEpoch {
        match self {
            Self::Archive(stamp) | Self::Rewrite(stamp) => stamp.epoch,
            Self::Claim(epoch) | Self::Delete(epoch) => epoch,
        }
    }
}

/// What to do with the pointer read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Fence {
    /// Write, on condition that it has not changed since it was read.
    Write,
    /// This very change is there already (an earlier try whose answer was
    /// lost): it counts as made.
    Done,
    /// A later change by the same owner is there: this one is moot and
    /// must not count as made.
    Outdated,
    /// The sandbox was deleted: nothing of it is written again.
    Deleted,
    /// There is nothing to rewrite.
    Nothing,
    /// A later owner holds it: the sandbox belongs to that owner now, and
    /// this host drops its copy.
    Superseded {
        /// The epoch the pointer carries.
        by: OwnerEpoch,
    },
}

/// What `mutation` does with the pointer it read as `found`.
#[must_use]
pub fn fence(mutation: Mutation, found: Found) -> Fence {
    let own = mutation.epoch();
    match found {
        Found::Copy(Stamp { epoch, .. }) | Found::Tombstone(epoch) if epoch > own => {
            Fence::Superseded { by: epoch }
        }
        Found::Tombstone(_) => match mutation {
            Mutation::Delete(_) => Fence::Done,
            _ => Fence::Deleted,
        },
        Found::Nothing => match mutation {
            Mutation::Rewrite(_) => Fence::Nothing,
            _ => Fence::Write,
        },
        Found::Copy(found) => match mutation {
            Mutation::Archive(stamp) | Mutation::Rewrite(stamp) => match found.cmp(&stamp) {
                Ordering::Equal => Fence::Done,
                Ordering::Greater => Fence::Outdated,
                Ordering::Less => Fence::Write,
            },
            Mutation::Claim(epoch) if found.epoch == epoch => Fence::Done,
            Mutation::Claim(_) | Mutation::Delete(_) => Fence::Write,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{Fence, Found, Mutation, OwnerEpoch, Stamp, fence};
    use crate::rng::Rng;

    fn stamp(epoch: u64, save: u64) -> Stamp {
        Stamp {
            epoch: OwnerEpoch(epoch),
            save,
        }
    }

    fn copy(epoch: u64, save: u64) -> Found {
        Found::Copy(stamp(epoch, save))
    }

    #[test]
    fn a_later_epoch_supersedes_every_change() {
        for mutation in [
            Mutation::Archive(stamp(4, 90)),
            Mutation::Rewrite(stamp(4, 90)),
            Mutation::Claim(OwnerEpoch(4)),
            Mutation::Delete(OwnerEpoch(4)),
        ] {
            for found in [copy(5, 1), Found::Tombstone(OwnerEpoch(5))] {
                assert_eq!(
                    fence(mutation, found),
                    Fence::Superseded { by: OwnerEpoch(5) },
                    "{mutation:?} over {found:?}"
                );
            }
        }
    }

    #[test]
    fn a_change_finds_itself_done_and_a_later_one_outdated() {
        for change in [
            Mutation::Archive(stamp(4, 7)),
            Mutation::Rewrite(stamp(4, 7)),
        ] {
            assert_eq!(fence(change, copy(4, 7)), Fence::Done);
            assert_eq!(fence(change, copy(4, 8)), Fence::Outdated);
            assert_eq!(fence(change, copy(4, 6)), Fence::Write);
            assert_eq!(fence(change, copy(3, 90)), Fence::Write);
        }
        // Forgetting memory after save 7 takes number 8: a retry of save
        // 7's archive then finds it outdated, not done with its memory.
        assert_eq!(
            fence(Mutation::Archive(stamp(4, 7)), copy(4, 8)),
            Fence::Outdated
        );
        assert_eq!(
            fence(Mutation::Archive(stamp(4, 7)), Found::Nothing),
            Fence::Write
        );
        assert_eq!(
            fence(Mutation::Rewrite(stamp(4, 7)), Found::Nothing),
            Fence::Nothing
        );
    }

    #[test]
    fn a_tombstone_is_final_and_never_counts_as_archived() {
        let tombstone = Found::Tombstone(OwnerEpoch(4));
        assert_eq!(
            fence(Mutation::Archive(stamp(4, 7)), tombstone),
            Fence::Deleted
        );
        assert_eq!(
            fence(Mutation::Rewrite(stamp(4, 9)), tombstone),
            Fence::Deleted
        );
        assert_eq!(
            fence(Mutation::Claim(OwnerEpoch(9)), tombstone),
            Fence::Deleted
        );
        assert_eq!(
            fence(Mutation::Delete(OwnerEpoch(4)), tombstone),
            Fence::Done
        );
        assert_eq!(
            fence(Mutation::Delete(OwnerEpoch(9)), tombstone),
            Fence::Done
        );
    }

    #[test]
    fn a_claim_takes_over_once_and_a_delete_over_anything() {
        assert_eq!(
            fence(Mutation::Claim(OwnerEpoch(5)), copy(4, 7)),
            Fence::Write
        );
        assert_eq!(
            fence(Mutation::Claim(OwnerEpoch(5)), copy(5, 7)),
            Fence::Done
        );
        assert_eq!(
            fence(Mutation::Claim(OwnerEpoch(5)), Found::Nothing),
            Fence::Write
        );
        assert_eq!(
            fence(Mutation::Delete(OwnerEpoch(5)), copy(4, 7)),
            Fence::Write
        );
        assert_eq!(
            fence(Mutation::Delete(OwnerEpoch(5)), Found::Nothing),
            Fence::Write
        );
    }

    /// A pointer as the model store keeps it.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Held {
        Nothing,
        /// The stamp, and whether the copy still has its memory.
        Copy(Stamp, bool),
        Tombstone(OwnerEpoch),
    }

    impl Held {
        fn found(self) -> Found {
            match self {
                Self::Nothing => Found::Nothing,
                Self::Copy(stamp, _) => Found::Copy(stamp),
                Self::Tombstone(epoch) => Found::Tombstone(epoch),
            }
        }

        /// What `mutation` stores when it writes over `self`.
        fn written(self, mutation: Mutation) -> Self {
            match (mutation, self) {
                (Mutation::Archive(stamp), _) => Self::Copy(stamp, true),
                (Mutation::Rewrite(stamp), _) => Self::Copy(stamp, false),
                (Mutation::Claim(epoch), Self::Copy(found, memory)) => Self::Copy(
                    Stamp {
                        epoch,
                        save: found.save,
                    },
                    memory,
                ),
                (Mutation::Claim(epoch), _) => Self::Copy(stamp(epoch.0, 0), false),
                (Mutation::Delete(epoch), _) => Self::Tombstone(epoch),
            }
        }

        /// Checks that `mutation` counts as made with `self` stored, and
        /// returns the number a claim lets its owner count on from.
        fn check_done(self, seed: u64, mutation: Mutation) -> Option<(OwnerEpoch, u64)> {
            match (mutation, self) {
                (Mutation::Archive(stamp), Self::Copy(found, memory)) => {
                    assert_eq!(found, stamp, "seed {seed}");
                    assert!(memory, "seed {seed}: an archive done without its memory");
                    None
                }
                (Mutation::Rewrite(stamp), Self::Copy(found, _)) => {
                    assert_eq!(found, stamp, "seed {seed}");
                    None
                }
                (Mutation::Claim(epoch), Self::Copy(found, _)) => {
                    assert_eq!(found.epoch, epoch, "seed {seed}");
                    Some((epoch, found.save))
                }
                (Mutation::Delete(_), Self::Tombstone(_)) => None,
                (mutation, held) => panic!("seed {seed}: {mutation:?} done with {held:?} stored"),
            }
        }
    }

    /// One change in flight: what it read, and at which version.
    #[derive(Clone, Copy, Debug)]
    struct Flight {
        mutation: Mutation,
        read: Option<(u64, Held)>,
    }

    /// Owners make archives, memory forgets, claims and deletes that
    /// overlap in every order, each read and its conditional write a
    /// separate step, and retry whatever lost its condition. A new owner
    /// first claims and numbers on from what it claimed; former owners go
    /// on writing until they are fenced. Whatever the order, the stored
    /// stamp never goes back, a tombstone is never written over, a change
    /// that counts as made is in the store at that moment, and an archive
    /// never counts as made once a later rewrite dropped its memory.
    #[test]
    fn overlapping_changes_in_any_order_keep_the_pointer_ordered() {
        const OWNERS: usize = 4;
        for seed in 1..=500 {
            let mut rng = Rng::new(seed);
            let mut held = Held::Nothing;
            let mut version = 0_u64;
            // Each owner's counter, once it may write.
            let mut counters: [Option<u64>; OWNERS] = [None, Some(0), None, None];
            let mut flights: Vec<Flight> = Vec::new();
            let mut current = 1_usize;
            for _ in 0..300 {
                if flights.len() < 5 && rng.chance(1, 2) {
                    if current + 1 < OWNERS && rng.chance(1, 15) {
                        current += 1;
                        let epoch = OwnerEpoch(current as u64);
                        flights.push(Flight {
                            mutation: Mutation::Claim(epoch),
                            read: None,
                        });
                        continue;
                    }
                    let owner = 1 + rng.index(current);
                    let Some(counter) = counters[owner].as_mut() else {
                        continue;
                    };
                    let epoch = owner as u64;
                    let mutation = match rng.below(10) {
                        0..=5 => {
                            *counter += 1;
                            Mutation::Archive(stamp(epoch, *counter))
                        }
                        6..=8 => {
                            *counter += 1;
                            Mutation::Rewrite(stamp(epoch, *counter))
                        }
                        _ => Mutation::Delete(OwnerEpoch(epoch)),
                    };
                    flights.push(Flight {
                        mutation,
                        read: None,
                    });
                    continue;
                }
                if flights.is_empty() {
                    continue;
                }
                let index = rng.index(flights.len());
                let flight = flights[index];
                let Some((read_version, read)) = flight.read else {
                    flights[index].read = Some((version, held));
                    continue;
                };
                let lands = read_version == version;
                match fence(flight.mutation, read.found()) {
                    Fence::Write if lands => {
                        let next = read.written(flight.mutation);
                        if let (Held::Copy(before, _), Held::Copy(after, _)) = (held, next) {
                            assert!(
                                after >= before,
                                "seed {seed}: {before:?} went back to {after:?}"
                            );
                        }
                        assert!(
                            !matches!(held, Held::Tombstone(_)),
                            "seed {seed}: {:?} wrote over a tombstone",
                            flight.mutation
                        );
                        held = next;
                        version += 1;
                        if let (Mutation::Claim(epoch), Held::Copy(claimed, _)) =
                            (flight.mutation, held)
                        {
                            counters[usize::try_from(epoch.0).unwrap()] = Some(claimed.save);
                        }
                        flights.swap_remove(index);
                    }
                    // Lost its condition: read and check again.
                    Fence::Write => flights[index].read = None,
                    // Made, by what it read; checked again if that changed.
                    Fence::Done if !lands => flights[index].read = None,
                    Fence::Done => {
                        if let Some((epoch, save)) = held.check_done(seed, flight.mutation) {
                            counters[usize::try_from(epoch.0).unwrap()] = Some(save);
                        }
                        flights.swap_remove(index);
                    }
                    Fence::Outdated
                    | Fence::Deleted
                    | Fence::Nothing
                    | Fence::Superseded { .. } => {
                        flights.swap_remove(index);
                    }
                }
            }
        }
    }
}
