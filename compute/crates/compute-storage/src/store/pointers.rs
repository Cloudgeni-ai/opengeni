//! Pointers: the only objects ever replaced, each naming one copy's
//! manifests under its owner's stamp. Every write is conditional on the
//! version read, and [`compute_fleet::fence`] decides from that version
//! whether to write at all, so no write a former owner or an earlier
//! change has in flight can land once a later one has.

use bytes::Bytes;
use compute_fleet::{Fence, Found, Mutation, OwnerEpoch, Stamp, fence};

use super::{ChunkStore, MAX_POINTER_BYTES};
use crate::pointer_store::{Kept, Version, check_name};
use crate::{Error, Result};

/// The save number of a deleted sandbox's tombstone, which tells it from
/// any other pointer.
const TOMBSTONE_SAVE: u64 = u64::MAX;

/// How often [`ChunkStore::begin`], [`ChunkStore::fence`] and
/// [`ChunkStore::delete_pointer`] try again when the pointer changes under
/// them; a pointer has one writer, so more means something else is wrong.
const POINTER_TRIES: usize = 4;

/// One change of a pointer between the version it started from and the
/// pointer it writes: an archive (see [`ChunkStore::begin`]) or a change
/// naming part of what the pointer named (see
/// [`ChunkStore::read_for_change`]). It lands only on that version, whose
/// owner stamp was checked when it was read.
#[derive(Clone, Debug)]
#[must_use = "a change lands through its publication"]
pub struct Publication {
    /// The pointer's name.
    name: String,
    /// The pointer's version when the change started.
    version: Version,
    /// The owner stamp the pointer gets.
    stamp: Stamp,
}

/// How an archive begins (see [`ChunkStore::begin`]).
#[derive(Debug)]
#[must_use = "an archive publishes through its publication"]
pub enum Begun {
    /// Publish the archive through this.
    Publish(Publication),
    /// The pointer names this very save already (an earlier try whose
    /// answer was lost), and holds this.
    Stored(Vec<u8>),
    /// It names a later change by the same owner: this save is moot, and
    /// not archived.
    Outdated,
    /// The sandbox was deleted: nothing of it is archived again.
    Deleted,
}

impl Begun {
    /// The publication, when there is something to publish.
    #[must_use]
    pub fn into_publication(self) -> Option<Publication> {
        match self {
            Self::Publish(publication) => Some(publication),
            Self::Stored(_) | Self::Outdated | Self::Deleted => None,
        }
    }
}

/// How a rewrite of a pointer begins (see [`ChunkStore::read_for_change`]).
#[derive(Debug)]
#[must_use = "a rewrite lands through its publication"]
pub enum Rewrite {
    /// What the pointer holds, to rewrite through the publication.
    Change(Vec<u8>, Publication),
    /// This very rewrite is there already, and the pointer holds this.
    Done(Vec<u8>),
    /// A later change by the same owner is there: the rewrite is moot.
    Outdated,
    /// There is no copy to rewrite: no pointer, an empty one, or a
    /// tombstone. Where there was no pointer or an empty one, the change
    /// is stored all the same, as an empty pointer under its number, so
    /// no change before it can land after it.
    Nothing,
}

/// The owner epoch tests write under.
#[cfg(test)]
pub(crate) const TEST_EPOCH: OwnerEpoch = OwnerEpoch::FIRST;

/// A save under [`TEST_EPOCH`] later than every one before it.
#[cfg(test)]
pub(crate) fn next_save() -> Stamp {
    use std::sync::atomic::{AtomicU64, Ordering};

    static SAVES: AtomicU64 = AtomicU64::new(1);
    Stamp {
        epoch: TEST_EPOCH,
        save: SAVES.fetch_add(1, Ordering::Relaxed),
    }
}

/// Whether `kept` is the tombstone a deleted sandbox left (see
/// [`ChunkStore::delete_pointer`]).
fn is_tombstone(kept: &Kept) -> bool {
    kept.owner.save == TOMBSTONE_SAVE && kept.pointer.is_empty()
}

/// What the fence sees of pointer `stored`.
fn found(stored: Option<&Kept>) -> Found {
    match stored {
        None => Found::Nothing,
        Some(stored) if is_tombstone(stored) => Found::Tombstone(stored.owner.epoch),
        Some(stored) => Found::Copy(stored.owner),
    }
}

/// A pointer as a sweep takes stock of it (see [`ChunkStore::fence`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Stock {
    /// There is none.
    Gone,
    /// The tombstone of a deleted sandbox: it names nothing, and no
    /// archive can publish over it, so it is not stored again.
    Tombstone,
    /// What it holds; empty for an archive in flight.
    Holds(Vec<u8>),
}

impl ChunkStore {
    /// Reads pointer `name`; `None` when there is none.
    async fn read_pointer(&self, name: &str) -> Result<Option<Kept>> {
        check_name(name)?;
        let kept = self.pointers.read(name).await?;
        if kept
            .as_ref()
            .is_some_and(|kept| kept.pointer.len() > MAX_POINTER_BYTES)
        {
            return Err(Error::Invalid("pointer too large"));
        }
        Ok(kept)
    }

    /// Keeps `pointer` under `owner` as pointer `name` on condition of
    /// `version` (`None` to create it). The version kept, or `None` when
    /// the pointer changed or appeared meanwhile.
    async fn put_pointer(
        &self,
        name: &str,
        owner: Stamp,
        pointer: &[u8],
        version: Option<Version>,
    ) -> Result<Option<Version>> {
        check_name(name)?;
        self.pointers
            .write(
                name,
                owner,
                Bytes::copy_from_slice(pointer),
                version.as_ref(),
            )
            .await
    }

    /// The owner stamp of pointer `name` and what it holds; `None` when
    /// there is none, or only the empty one of an archive in flight or of
    /// a deleted sandbox.
    pub async fn get_owned_pointer(&self, name: &str) -> Result<Option<(Stamp, Vec<u8>)>> {
        Ok(self
            .read_pointer(name)
            .await?
            .filter(|stored| !stored.pointer.is_empty())
            .map(|stored| (stored.owner, stored.pointer.to_vec())))
    }

    /// Reads pointer `name` to replace it with one naming part of what it
    /// names now, such as the same copy without its memory image, as the
    /// change `own`: its owner's epoch, and a number that owner has not
    /// used for any other change, recorded before this is called. The
    /// replacement goes through [`Self::publish`] with the publication
    /// returned, so it lands only on the version read: a write held up in
    /// flight long after its caller stopped waiting can never replace a
    /// copy stored since, and a sweep's fence sends the caller to read
    /// again. Refused with [`Error::Fenced`] once a later owner holds it.
    pub async fn read_for_change(&self, name: &str, own: Stamp) -> Result<Rewrite> {
        for _ in 0..POINTER_TRIES {
            let stored = self.read_pointer(name).await?;
            match fence(Mutation::Rewrite(own), found(stored.as_ref())) {
                Fence::Superseded { by } => return Err(Error::Fenced { by }),
                Fence::Outdated => return Ok(Rewrite::Outdated),
                Fence::Deleted => return Ok(Rewrite::Nothing),
                Fence::Done => {
                    return Ok(match stored {
                        Some(stored) if !stored.pointer.is_empty() => {
                            Rewrite::Done(stored.pointer.to_vec())
                        }
                        _ => Rewrite::Nothing,
                    });
                }
                Fence::Write => {}
            }
            match stored {
                Some(stored) if !stored.pointer.is_empty() => {
                    return Ok(Rewrite::Change(
                        stored.pointer.to_vec(),
                        Publication {
                            name: name.to_owned(),
                            version: stored.version,
                            stamp: own,
                        },
                    ));
                }
                // No copy, or only an archive's empty start: nothing to
                // rewrite, but the change is stored, so that archive, or
                // one whose start is still in flight, cannot land after it.
                stored => {
                    let version = stored.map(|stored| stored.version);
                    if self.put_pointer(name, own, &[], version).await?.is_some() {
                        return Ok(Rewrite::Nothing);
                    }
                }
            }
        }
        Err(Error::Superseded)
    }

    /// Replaces pointer `name` with no condition, as a writer without the
    /// fence would; for tests that show what the fence prevents.
    #[cfg(test)]
    pub(crate) async fn put_pointer_unfenced(
        &self,
        name: &str,
        owner: Stamp,
        bytes: Vec<u8>,
    ) -> Result<()> {
        loop {
            let version = self.read_pointer(name).await?.map(|kept| kept.version);
            if self
                .put_pointer(name, owner, &bytes, version)
                .await?
                .is_some()
            {
                return Ok(());
            }
        }
    }

    /// Starts an archive of save `own` that will replace pointer `name`:
    /// begin before looking at the store at all. `own` is its owner's
    /// epoch and a number that owner has not used for any other change,
    /// recorded before this is called. Reads the pointer and checks it on
    /// the very version the publication will be conditional on (see
    /// [`fence`]), first storing an empty one under this owner if there is
    /// none, so that a sweep can stop the archive from publishing once it
    /// has taken stock (see [`crate::fresh`]). Refused with
    /// [`Error::Fenced`] once a later owner holds the pointer: the sandbox
    /// belongs to it, and this host drops its copy. An archive whose
    /// publication is refused as [`Error::Superseded`] begins again here,
    /// so every try is checked.
    pub async fn begin(&self, name: &str, own: Stamp) -> Result<Begun> {
        for _ in 0..POINTER_TRIES {
            let stored = self.read_pointer(name).await?;
            match fence(Mutation::Archive(own), found(stored.as_ref())) {
                Fence::Superseded { by } => return Err(Error::Fenced { by }),
                Fence::Outdated => return Ok(Begun::Outdated),
                Fence::Deleted => return Ok(Begun::Deleted),
                Fence::Done => {
                    return Ok(match stored {
                        Some(stored) if !stored.pointer.is_empty() => {
                            Begun::Stored(stored.pointer.to_vec())
                        }
                        // Only an archive in flight leaves a pointer empty,
                        // under number 0, which no save takes.
                        _ => Begun::Outdated,
                    });
                }
                Fence::Write => {}
            }
            if let Some(stored) = stored {
                return Ok(Begun::Publish(Publication {
                    name: name.to_owned(),
                    version: stored.version,
                    stamp: own,
                }));
            }
            let empty = Stamp {
                epoch: own.epoch,
                save: 0,
            };
            if let Some(version) = self.put_pointer(name, empty, &[], None).await? {
                return Ok(Begun::Publish(Publication {
                    name: name.to_owned(),
                    version,
                    stamp: own,
                }));
            }
            // Made meanwhile, or by an earlier try whose answer was lost:
            // read it.
        }
        Err(Error::Superseded)
    }

    /// Reads pointer `name` for a rewrite under the next test number:
    /// what it holds and the publication, when there is a copy to rewrite.
    #[cfg(test)]
    pub(crate) async fn rewrite_test(&self, name: &str) -> Result<Option<(Vec<u8>, Publication)>> {
        Ok(match self.read_for_change(name, next_save()).await? {
            Rewrite::Change(bytes, publication) => Some((bytes, publication)),
            Rewrite::Done(_) | Rewrite::Outdated | Rewrite::Nothing => None,
        })
    }

    /// Begins an archive of the next test save, which publishes.
    #[cfg(test)]
    pub(crate) async fn begin_test(&self, name: &str) -> Result<Publication> {
        Ok(self
            .begin(name, next_save())
            .await?
            .into_publication()
            .expect("a later save publishes"))
    }

    /// Takes pointer `name` over as its owner under `own`, a later epoch
    /// than it carries: stores it again, unchanged but under `own`, or an
    /// empty one if there is none, so no archive a former owner began
    /// earlier can publish it. Returns the stamp it now carries (whose
    /// number the new owner counts on from) and what it names; `None` when
    /// there is no copy to adopt, or the sandbox was deleted. Taking over
    /// one this owner already holds changes nothing; refused with
    /// [`Error::Fenced`] once a later owner holds it.
    pub async fn claim(&self, name: &str, own: OwnerEpoch) -> Result<Option<(Stamp, Vec<u8>)>> {
        for _ in 0..POINTER_TRIES {
            let stored = self.read_pointer(name).await?;
            let (stamp, pointer, version) =
                match fence(Mutation::Claim(own), found(stored.as_ref())) {
                    Fence::Superseded { by } => return Err(Error::Fenced { by }),
                    Fence::Deleted => return Ok(None),
                    // Done only on a pointer this owner holds already.
                    Fence::Done => {
                        return Ok(stored.and_then(|stored| {
                            (!stored.pointer.is_empty())
                                .then(|| (stored.owner, stored.pointer.to_vec()))
                        }));
                    }
                    Fence::Outdated => {
                        unreachable!("a claim is never outdated, and takes over even nothing")
                    }
                    Fence::Write => match stored {
                        Some(stored) => (
                            Stamp {
                                epoch: own,
                                save: stored.owner.save,
                            },
                            stored.pointer,
                            Some(stored.version),
                        ),
                        None => (
                            Stamp {
                                epoch: own,
                                save: 0,
                            },
                            Bytes::new(),
                            None,
                        ),
                    },
                };
            if self
                .put_pointer(name, stamp, &pointer, version)
                .await?
                .is_some()
            {
                return Ok((!pointer.is_empty()).then(|| (stamp, pointer.to_vec())));
            }
        }
        Err(Error::Superseded)
    }

    /// Ends `publication` by replacing its pointer with `bytes`, on
    /// condition that the pointer is still the version the change started
    /// from. Refused with [`Error::Superseded`] otherwise: a sweep has
    /// taken stock since and may delete what an archive reused, a newer
    /// copy was stored, or a new owner took the pointer over, so the
    /// change starts again and checks the owner anew.
    pub async fn publish(&self, publication: Publication, bytes: Vec<u8>) -> Result<()> {
        if bytes.len() > MAX_POINTER_BYTES {
            return Err(Error::Invalid("pointer too large"));
        }
        let Publication {
            name,
            version,
            stamp,
        } = publication;
        if self
            .put_pointer(&name, stamp, &bytes, Some(version))
            .await?
            .is_some()
        {
            Ok(())
        } else {
            Err(Error::Superseded)
        }
    }

    /// Keeps pointer `name` again as it is, on condition that it has not
    /// changed since it was read, and returns what it holds. After this no
    /// archive that began earlier can publish it, so what it names now is
    /// all it can name until an archive begun later publishes: kept again,
    /// it has a new version on every pointer store. A tombstone is left as
    /// it is: nothing can publish over it.
    pub async fn fence(&self, name: &str) -> Result<Stock> {
        for _ in 0..POINTER_TRIES {
            let Some(stored) = self.read_pointer(name).await? else {
                return Ok(Stock::Gone);
            };
            if is_tombstone(&stored) {
                return Ok(Stock::Tombstone);
            }
            // Under the owner it had: a sweep owns nothing.
            if self
                .put_pointer(name, stored.owner, &stored.pointer, Some(stored.version))
                .await?
                .is_some()
            {
                return Ok(Stock::Holds(stored.pointer.to_vec()));
            }
            // Published meanwhile, gone, or fenced by an earlier try whose
            // answer was lost: read it again.
        }
        Err(Error::Superseded)
    }

    /// Reads pointer `name` as [`Self::fence`] would, without keeping it
    /// again: a look that stops no archive.
    pub async fn look(&self, name: &str) -> Result<Stock> {
        Ok(match self.read_pointer(name).await? {
            None => Stock::Gone,
            Some(stored) if is_tombstone(&stored) => Stock::Tombstone,
            Some(stored) => Stock::Holds(stored.pointer.to_vec()),
        })
    }

    /// Reads pointer `name`, or `None` when there is none or it is the
    /// empty one an archive in flight stored (see [`Self::begin`]) or a
    /// deleted sandbox left.
    pub async fn get_pointer(&self, name: &str) -> Result<Option<Vec<u8>>> {
        Ok(self
            .get_owned_pointer(name)
            .await?
            .map(|(_, pointer)| pointer))
    }

    /// Deletes sandbox `name`'s copy as its owner under `own`: replaces
    /// its pointer with a tombstone, an empty pointer whose owner stamp
    /// carries `own` and a number no change takes, on condition that it has
    /// not changed since read. It reads as no copy. An archive the same
    /// owner still has in flight finds the sandbox deleted, and one a
    /// former owner began can no longer publish, so no write held up in
    /// flight long after its caller stopped waiting brings the copy back. Even where
    /// there is no pointer a tombstone is stored. Refused with
    /// [`Error::Fenced`] once a later owner holds the pointer. A tombstone
    /// is final and stays for good: no owner archives over it, claiming it
    /// takes nothing, and a first archive held up in flight, however long,
    /// finds it rather than an empty place to start a copy in. What the
    /// pointer named stays until a sweep finds nothing names it.
    pub async fn delete_pointer(&self, name: &str, own: OwnerEpoch) -> Result<()> {
        let tombstone = Stamp {
            epoch: own,
            save: TOMBSTONE_SAVE,
        };
        for _ in 0..POINTER_TRIES {
            let stored = self.read_pointer(name).await?;
            match fence(Mutation::Delete(own), found(stored.as_ref())) {
                Fence::Superseded { by } => return Err(Error::Fenced { by }),
                Fence::Done => return Ok(()),
                Fence::Write => {}
                Fence::Outdated | Fence::Deleted => {
                    unreachable!("a delete writes over anything but a tombstone")
                }
            }
            let version = stored.map(|stored| stored.version);
            if self
                .put_pointer(name, tombstone, &[], version)
                .await?
                .is_some()
            {
                return Ok(());
            }
        }
        Err(Error::Superseded)
    }

    /// Starts forgetting pointer `name`, one no owner fences, such as a
    /// sandbox image's, whose name is its content (a sandbox's copy is
    /// deleted with [`Self::delete_pointer`]): reads it, and returns the
    /// change that empties it on the version read, through
    /// [`Self::forget`]. `None` when there is nothing to forget: no
    /// pointer, or a tombstone. The caller checks between the two that it
    /// may still forget it; a store of the same image since, or a sweep's
    /// fence, changes the version, so the empty one never lands on it.
    pub async fn read_to_forget(&self, name: &str) -> Result<Option<Publication>> {
        Ok(self
            .read_pointer(name)
            .await?
            .filter(|stored| !is_tombstone(stored))
            .map(|stored| Publication {
                name: name.to_owned(),
                version: stored.version,
                stamp: Stamp {
                    epoch: stored.owner.epoch,
                    save: 0,
                },
            }))
    }

    /// Ends forgetting a pointer (see [`Self::read_to_forget`]): replaces
    /// it with the empty one a store begins with, under number 0, which
    /// reads as none and names nothing, so a sweep frees what it named and
    /// a later store of the same name publishes over it. Never deleted
    /// outright: deletes carry no condition on every store, and one held
    /// up in flight could land on the pointer a later store published.
    /// Refused with [`Error::Superseded`] when the pointer changed since it
    /// was read: read it, and check, again.
    pub async fn forget(&self, publication: Publication) -> Result<()> {
        self.publish(publication, Vec::new()).await
    }
}
