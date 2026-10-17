//! Pointers: the only objects ever replaced, each naming one copy's
//! manifests under its owner's stamp. Every write is conditional on the
//! version read, and checks the owner stamp it found (see
//! [`compute_fleet::fence`]), so no write a former owner or an earlier
//! save has in flight can land once a later one has.

use std::time::SystemTime;

use bytes::Bytes;
use compute_fleet::{Fence, OwnerEpoch, Stamp, fence};
use futures::TryStreamExt as _;
use object_store::{PutMode, PutOptions, UpdateVersion, path::Path};

use super::{ChunkStore, MAX_POINTER_BYTES, Removal, Uploader};
use crate::upload::Deleted;
use crate::{Error, Result};

/// Length of the write stamp every stored pointer begins with (see
/// [`stamped`]).
const STAMP_BYTES: usize = 16;

/// Length of the whole header a stored pointer begins with: the write
/// stamp, then its owner's stamp (epoch and save, each a little-endian
/// `u64`).
const HEADER_BYTES: usize = STAMP_BYTES + 16;

/// Where pointers are stored: in this format, with an owner in the header.
pub(super) const POINTERS: &str = "pointers/v3";

/// Where pointers were stored in older formats: without a write stamp
/// (`v1`), and without an owner (`v2`).
const OLDER_POINTERS: [&str; 2] = ["pointers/v1", "pointers/v2"];

/// The save number of a deleted sandbox's tombstone: later than any save,
/// so an archive of the same owner still in flight finds it done.
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
    path: Path,
    /// The pointer's version when the change started.
    version: UpdateVersion,
    /// The owner stamp the pointer gets.
    stamp: Stamp,
}

/// How an archive begins (see [`ChunkStore::begin`]).
#[derive(Debug)]
#[must_use = "an archive publishes through its publication"]
pub enum Begun {
    /// Publish the archive through this.
    Publish(Publication),
    /// The pointer already names this save, or a later one by the same
    /// owner (or the sandbox was deleted): there is nothing to publish.
    Done,
}

impl Begun {
    /// The publication, when there is something to publish.
    #[must_use]
    pub fn into_publication(self) -> Option<Publication> {
        match self {
            Self::Publish(publication) => Some(publication),
            Self::Done => None,
        }
    }
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

/// A pointer as stored.
struct Stored {
    /// Its owner stamp.
    owner: Stamp,
    /// What it holds, without its header; empty for the pointer an archive
    /// in flight stored and for a tombstone.
    pointer: Bytes,
    /// The version it is stored as.
    version: UpdateVersion,
}

impl Stored {
    /// Whether this is the tombstone a deleted sandbox left (see
    /// [`ChunkStore::delete_pointer`]).
    fn is_tombstone(&self) -> bool {
        self.owner.save == TOMBSTONE_SAVE && self.pointer.is_empty()
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

/// `pointer` as stored: after a stamp no other write uses. Storing the
/// same pointer again, or the empty one again, then still gives a new
/// version where a store's entity tag follows the bytes (S3), so a write
/// held up in flight, on condition of a version read long ago, can never
/// land on a later write that happens to hold the same bytes.
///
/// After the write stamp comes the pointer's owner stamp: whose it is and
/// which save it names, checked by every write that replaces it.
fn stamped(owner: Stamp, pointer: &[u8]) -> Result<Bytes> {
    let mut stored = vec![0; HEADER_BYTES + pointer.len()];
    let (header, rest) = stored.split_at_mut(HEADER_BYTES);
    let (stamp, header) = header.split_at_mut(STAMP_BYTES);
    getrandom::fill(stamp).map_err(std::io::Error::from)?;
    header[..8].copy_from_slice(&owner.epoch.0.to_le_bytes());
    header[8..].copy_from_slice(&owner.save.to_le_bytes());
    rest.copy_from_slice(pointer);
    Ok(stored.into())
}

/// The owner stamp and the pointer `stored` holds, without its header
/// (see [`stamped`]).
pub(crate) fn unstamped(stored: &Bytes) -> Result<(Stamp, Bytes)> {
    let Some(header) = stored.get(STAMP_BYTES..HEADER_BYTES) else {
        return Err(Error::Invalid("pointer without a header"));
    };
    let (epoch, save) = header.split_at(8);
    let word = |bytes: &[u8]| u64::from_le_bytes(bytes.try_into().expect("eight bytes"));
    let owner = Stamp {
        epoch: OwnerEpoch(word(epoch)),
        save: word(save),
    };
    Ok((owner, stored.slice(HEADER_BYTES..)))
}

impl ChunkStore {
    fn pointer_path(&self, name: &str) -> Result<Path> {
        if name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(Error::Invalid("pointer name"));
        }
        Ok(self.path(&format!("{POINTERS}/{name}")))
    }

    /// Refuses a store that holds pointers in an older format: this
    /// release does not read them, so their copies would look absent and a
    /// sweep would delete what they name. Such a store needs migrating; a
    /// new prefix starts afresh.
    pub async fn refuse_unstamped_pointers(&self) -> Result<()> {
        for older in OLDER_POINTERS {
            let prefix = self.path(older);
            if self.backend.list(Some(&prefix)).try_next().await?.is_some() {
                return Err(Error::Unsupported(
                    "the store holds pointers in an older format (pointers/v1 or v2): \
                     migrate them or use a new prefix",
                ));
            }
        }
        Ok(())
    }

    /// Reads the pointer at `path`; `None` when there is none.
    async fn read_pointer(&self, path: &Path) -> Result<Option<Stored>> {
        let read = match self.backend.get(path).await {
            Ok(read) => read,
            Err(object_store::Error::NotFound { .. }) => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if read.meta.size > (HEADER_BYTES + MAX_POINTER_BYTES) as u64 {
            return Err(Error::Invalid("pointer too large"));
        }
        let version = UpdateVersion {
            e_tag: read.meta.e_tag.clone(),
            version: read.meta.version.clone(),
        };
        let stored = read.bytes().await?;
        let (owner, pointer) = unstamped(&stored)?;
        Ok(Some(Stored {
            owner,
            pointer,
            version,
        }))
    }

    /// Stores `pointer` under `owner` at `path` on condition (`None` to
    /// create it). The version stored, or `None` when the pointer changed
    /// or appeared meanwhile.
    async fn put_pointer(
        &self,
        path: &Path,
        owner: Stamp,
        pointer: &[u8],
        version: Option<UpdateVersion>,
    ) -> Result<Option<UpdateVersion>> {
        let mode = version.map_or(PutMode::Create, PutMode::Update);
        let options = PutOptions {
            mode,
            ..Default::default()
        };
        match self
            .backend
            .put_opts(path, stamped(owner, pointer)?.into(), options)
            .await
        {
            Ok(put) => Ok(Some(UpdateVersion {
                e_tag: put.e_tag,
                version: put.version,
            })),
            Err(
                object_store::Error::Precondition { .. }
                | object_store::Error::AlreadyExists { .. }
                | object_store::Error::NotFound { .. },
            ) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// The owner stamp of pointer `name` and what it holds; `None` when
    /// there is none, or only the empty one of an archive in flight or of
    /// a deleted sandbox.
    pub async fn get_owned_pointer(&self, name: &str) -> Result<Option<(Stamp, Vec<u8>)>> {
        let path = self.pointer_path(name)?;
        Ok(self
            .read_pointer(&path)
            .await?
            .filter(|stored| !stored.pointer.is_empty())
            .map(|stored| (stored.owner, stored.pointer.to_vec())))
    }

    /// Reads pointer `name` to replace it with one naming part of what it
    /// names now, such as the same copy without its memory image, as its
    /// owner under `own`. The replacement goes through [`Self::publish`]
    /// with the publication returned, so it lands only on the version
    /// read: a write held up in flight long after its caller stopped
    /// waiting can never replace a copy stored since, and a sweep's fence
    /// sends the caller to read again. `None` when there is no pointer, or
    /// only an empty one. Refused with [`Error::Fenced`] once a later owner
    /// holds it.
    pub async fn read_for_change(
        &self,
        name: &str,
        own: OwnerEpoch,
    ) -> Result<Option<(Vec<u8>, Publication)>> {
        let path = self.pointer_path(name)?;
        let Some(stored) = self.read_pointer(&path).await? else {
            return Ok(None);
        };
        if stored.owner.epoch > own {
            return Err(Error::Fenced {
                by: stored.owner.epoch,
            });
        }
        if stored.pointer.is_empty() {
            return Ok(None);
        }
        // The same save, now under this owner.
        let stamp = Stamp {
            epoch: own,
            save: stored.owner.save,
        };
        Ok(Some((
            stored.pointer.to_vec(),
            Publication {
                path,
                version: stored.version,
                stamp,
            },
        )))
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
        self.backend
            .put(&self.pointer_path(name)?, stamped(owner, &bytes)?.into())
            .await?;
        Ok(())
    }

    /// Starts an archive of save `own` that will replace pointer `name`:
    /// begin before looking at the store at all. Reads the pointer and
    /// checks its owner stamp on the very version the publication will be
    /// conditional on (see [`fence`]), first storing an empty one under
    /// this owner if there is none, so that a sweep can stop the archive
    /// from publishing once it has taken stock (see [`crate::fresh`]).
    /// Refused with [`Error::Fenced`] once a later owner holds the
    /// pointer: the sandbox belongs to it, and this host drops its copy.
    /// An archive whose publication is refused as [`Error::Superseded`]
    /// begins again here, so every try is checked.
    pub async fn begin(&self, name: &str, own: Stamp) -> Result<Begun> {
        let path = self.pointer_path(name)?;
        for _ in 0..POINTER_TRIES {
            if let Some(stored) = self.read_pointer(&path).await? {
                if stored.is_tombstone() && stored.owner.epoch <= own.epoch {
                    // Deleted: nothing of it is ever archived again.
                    return Ok(Begun::Done);
                }
                return match fence(own, Some(stored.owner)) {
                    Fence::Publish => Ok(Begun::Publish(Publication {
                        path,
                        version: stored.version,
                        stamp: own,
                    })),
                    Fence::Done => Ok(Begun::Done),
                    Fence::Superseded { by } => Err(Error::Fenced { by }),
                };
            }
            let empty = Stamp {
                epoch: own.epoch,
                save: 0,
            };
            if let Some(version) = self.put_pointer(&path, empty, &[], None).await? {
                return Ok(Begun::Publish(Publication {
                    path,
                    version,
                    stamp: own,
                }));
            }
            // Made meanwhile, or by an earlier try whose answer was lost:
            // read it.
        }
        Err(Error::Superseded)
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
    /// than it carries: stores it again, unchanged but under `own`, so no
    /// archive a former owner began earlier can publish it. Returns the
    /// stamp it now carries (whose save the new owner counts on from) and
    /// what it names; `None` when there is no copy to adopt, though even
    /// an empty pointer is taken over. Taking over one this owner already
    /// holds changes nothing; refused with [`Error::Fenced`] once a later
    /// owner holds it.
    pub async fn claim(&self, name: &str, own: OwnerEpoch) -> Result<Option<(Stamp, Vec<u8>)>> {
        let path = self.pointer_path(name)?;
        for _ in 0..POINTER_TRIES {
            let Some(stored) = self.read_pointer(&path).await? else {
                return Ok(None);
            };
            if stored.owner.epoch > own {
                return Err(Error::Fenced {
                    by: stored.owner.epoch,
                });
            }
            if stored.is_tombstone() {
                // Deleted: no archive can publish over it anyway.
                return Ok(None);
            }
            let stamp = Stamp {
                epoch: own,
                save: stored.owner.save,
            };
            let landed = stored.owner.epoch == own
                || self
                    .put_pointer(&path, stamp, &stored.pointer, Some(stored.version))
                    .await?
                    .is_some();
            if landed {
                return Ok((!stored.pointer.is_empty()).then(|| (stamp, stored.pointer.to_vec())));
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
            path,
            version,
            stamp,
        } = publication;
        if self
            .put_pointer(&path, stamp, &bytes, Some(version))
            .await?
            .is_some()
        {
            Ok(())
        } else {
            Err(Error::Superseded)
        }
    }

    /// Stores pointer `key` (as a listing gives it) again as it is, on
    /// condition that it has not changed since it was read, and returns
    /// what it holds. After this no archive that began earlier can publish
    /// it, so what it names now is all it can name until an archive begun
    /// later publishes: stored again under a new stamp, it has a new
    /// version on every store. A tombstone is left as it is: nothing can
    /// publish over it.
    pub async fn fence(&self, key: &str) -> Result<Stock> {
        let name = Self::pointer_name(key).ok_or(Error::Invalid("pointer key"))?;
        let path = self.pointer_path(name)?;
        for _ in 0..POINTER_TRIES {
            let Some(stored) = self.read_pointer(&path).await? else {
                return Ok(Stock::Gone);
            };
            if stored.is_tombstone() {
                return Ok(Stock::Tombstone);
            }
            // Under the owner it had: a sweep owns nothing.
            if self
                .put_pointer(&path, stored.owner, &stored.pointer, Some(stored.version))
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

    /// Reads pointer `key` (as a listing gives it) as [`Self::fence`]
    /// would, without storing it again: a look that stops no archive.
    pub async fn look(&self, key: &str) -> Result<Stock> {
        let name = Self::pointer_name(key).ok_or(Error::Invalid("pointer key"))?;
        let path = self.pointer_path(name)?;
        Ok(match self.read_pointer(&path).await? {
            None => Stock::Gone,
            Some(stored) if stored.is_tombstone() => Stock::Tombstone,
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
    /// carries `own` and a save later than any, on condition that it has
    /// not changed since read. It reads as no copy. An archive the same
    /// owner still has in flight finds it done, and one a former owner
    /// began can no longer publish, so no write held up in flight long
    /// after its caller stopped waiting brings the copy back. Even where
    /// there is no pointer a tombstone is stored. Refused with
    /// [`Error::Fenced`] once a later owner holds the pointer. A tombstone
    /// is final: no owner archives over it, and claiming it takes nothing.
    /// What the pointer named stays until a sweep finds nothing names it,
    /// and the tombstone until a sweep finds it older than the sweep
    /// window (see [`Self::delete_tombstone_if_stored_before`]).
    pub async fn delete_pointer(&self, name: &str, own: OwnerEpoch) -> Result<()> {
        let path = self.pointer_path(name)?;
        let tombstone = Stamp {
            epoch: own,
            save: TOMBSTONE_SAVE,
        };
        for _ in 0..POINTER_TRIES {
            let stored = self.read_pointer(&path).await?;
            if let Some(stored) = &stored {
                if stored.owner.epoch > own {
                    return Err(Error::Fenced {
                        by: stored.owner.epoch,
                    });
                }
                if stored.is_tombstone() {
                    return Ok(());
                }
            }
            let version = stored.map(|stored| stored.version);
            if self
                .put_pointer(&path, tombstone, &[], version)
                .await?
                .is_some()
            {
                return Ok(());
            }
        }
        Err(Error::Superseded)
    }

    /// The name of the pointer a listing of [`Area::Pointers`] shows as
    /// `key`.
    #[must_use]
    pub fn pointer_name(key: &str) -> Option<&str> {
        key.strip_prefix(POINTERS)?.strip_prefix('/')
    }

    /// Deletes the tombstone at pointer `key` (as a listing gives it) if it
    /// was stored before `before` and is still that tombstone when deleted:
    /// a pointer stored there since stays. By then no archive of the
    /// deleted sandbox is still trying, so nothing can bring it back; a
    /// request held up in flight longer than that would only store an
    /// empty pointer. Only GCS deletes on that condition; elsewhere this
    /// refuses with [`Error::Unsupported`].
    pub async fn delete_tombstone_if_stored_before(
        &self,
        key: &str,
        before: SystemTime,
    ) -> Result<Removal> {
        let Uploader::Gcs(gcs) = &self.uploader else {
            return Err(Error::Unsupported(
                "deleting stored objects needs a delete on condition (GCS)",
            ));
        };
        let name = Self::pointer_name(key).ok_or(Error::Invalid("pointer key"))?;
        let path = self.pointer_path(name)?;
        let Some(stored_at) = gcs.stored(&path).await? else {
            return Ok(Removal::Gone);
        };
        if stored_at.at.is_none_or(|at| at >= before) {
            return Ok(Removal::Kept);
        }
        let Some(stored) = self.read_pointer(&path).await? else {
            return Ok(Removal::Gone);
        };
        // The generation read, which the delete is conditional on, must be
        // the one that was old enough.
        let (true, Some(generation)) = (stored.is_tombstone(), stored.version.version) else {
            return Ok(Removal::Kept);
        };
        if stored_at.generation.as_deref() != Some(generation.as_str()) {
            return Ok(Removal::Kept);
        }
        Ok(match gcs.delete_generation(&path, &generation).await? {
            Deleted::Yes => Removal::Deleted,
            Deleted::Changed => Removal::Kept,
            Deleted::Gone => Removal::Gone,
        })
    }
}
