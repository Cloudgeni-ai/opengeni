//! Where pointers are kept: the one thing stored copies need replaced on
//! condition (ADR 25). In a fleet the control service keeps them, in its
//! database; a host on its own keeps them in its object store
//! ([`ObjectPointers`]), which must then enforce conditional writes.
//!
//! A store here only reads a pointer with its version and writes one on
//! condition of a version. What a write may do is decided by its callers
//! ([`crate::store::ChunkStore`]'s begin, claim, publish and the rest) from
//! the owner stamp of the very version they read.

use std::fmt;
use std::sync::Arc;

use bytes::Bytes;
use compute_fleet::{OwnerEpoch, Stamp};
use futures::TryStreamExt as _;
use futures::future::BoxFuture;
use object_store::{ObjectStore, PutMode, PutOptions, PutResult, UpdateVersion, path::Path};

use crate::store::MAX_POINTER_BYTES;
use crate::{Error, Result};

/// A pointer as kept.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Kept {
    /// Its owner stamp.
    pub owner: Stamp,
    /// What it holds: empty for the pointer an archive in flight keeps and
    /// for a tombstone.
    pub pointer: Bytes,
    /// The version it is kept as, which a write replacing it names.
    pub version: Version,
}

/// Which write a kept pointer is. No version is ever given to two writes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Version {
    /// An object's entity tag and version, as its store reports them.
    Object {
        e_tag: Option<String>,
        version: Option<String>,
    },
    /// A row's change number, from a sequence.
    Row(i64),
}

/// Keeps pointers, each replaced only on condition of the version read.
pub trait PointerStore: Send + Sync + fmt::Debug {
    /// Pointer `name`, or `None` when there is none.
    fn read<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Option<Kept>>>;

    /// Keeps `pointer` under `owner` as `name`, only if it is still the
    /// version `on` (with `None`, only if there is none). The version
    /// kept, or `None` when the pointer changed or appeared meanwhile.
    fn write<'a>(
        &'a self,
        name: &'a str,
        owner: Stamp,
        pointer: Bytes,
        on: Option<&'a Version>,
    ) -> BoxFuture<'a, Result<Option<Version>>>;

    /// The name of every pointer kept, for a sweep.
    fn names(&self) -> BoxFuture<'_, Result<Vec<String>>>;

    /// Checks once, before anything is kept, that this store can keep
    /// pointers safely.
    fn check(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async { Ok(()) })
    }
}

/// Whether `name` may name a pointer: 1 to 128 ASCII letters, digits, `-`
/// and `_`.
pub fn check_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 128
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(Error::Invalid("pointer name"));
    }
    Ok(())
}

/// Length of the write stamp every pointer an object store keeps begins
/// with (see [`stamped`]).
const STAMP_BYTES: usize = 16;

/// Length of the whole header such a pointer begins with: the write stamp,
/// then its owner's stamp (epoch and save, each a little-endian `u64`).
const HEADER_BYTES: usize = STAMP_BYTES + 16;

/// Where an object store keeps pointers: in this format, with an owner in
/// the header.
pub const POINTERS: &str = "pointers/v3";

/// Where [`ObjectPointers::check`] writes, outside every pointer.
const PROBES: &str = "pointers/probes";

/// The mark a control service leaves once it keeps the pointers a store
/// kept ([`ObjectPointers::mark_moved`]), outside every pointer.
const MOVED: &str = "pointers/moved";

/// Pointers kept as objects of a store that writes on condition: GCS,
/// Azure, S3 and the S3 stores that enforce `If-Match` and
/// `If-None-Match`.
#[derive(Clone)]
pub struct ObjectPointers {
    backend: Arc<dyn ObjectStore>,
    prefix: Path,
}

impl fmt::Debug for ObjectPointers {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ObjectPointers")
            .field("prefix", &self.prefix)
            .finish_non_exhaustive()
    }
}

impl ObjectPointers {
    /// Pointers under `prefix` of `backend`.
    #[must_use]
    pub fn new(backend: Arc<dyn ObjectStore>, prefix: Path) -> Self {
        Self { backend, prefix }
    }

    fn path(&self, key: &str) -> Path {
        key.split('/')
            .fold(self.prefix.clone(), |path, part| path.child(part))
    }

    fn pointer_path(&self, name: &str) -> Result<Path> {
        check_name(name)?;
        Ok(self.path(&format!("{POINTERS}/{name}")))
    }

    /// Marks the store's pointers as moved into a control service (ADR 25),
    /// before the service records them imported: from then on the
    /// pointers here are a snapshot nothing updates, and a sweep by them
    /// would delete what the service's pointers name. So
    /// [`PointerStore::check`] refuses a marked store: no host on its own
    /// keeps pointers in it, and `compute-host sweep` does not sweep it.
    ///
    /// # Errors
    ///
    /// When the mark could not be written.
    pub async fn mark_moved(&self, at_ms: u64) -> Result<()> {
        let mark = serde_json::json!({
            "moved_at_ms": at_ms,
            "kept_by": "the fleet's control service; sweep with compute-control sweep",
        });
        self.backend
            .put(&self.path(MOVED), Bytes::from(mark.to_string()).into())
            .await?;
        Ok(())
    }

    /// Whether [`ObjectPointers::mark_moved`] marked the store.
    async fn moved(&self) -> Result<bool> {
        match self.backend.head(&self.path(MOVED)).await {
            Ok(_) => Ok(true),
            Err(object_store::Error::NotFound { .. }) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    /// Checks that the store refuses a second create of the same object
    /// and a replace naming a version that was replaced since: on a store
    /// that ignores those conditions (Garage does), a pointer write held up
    /// in flight would land over a newer copy. A store whose pointers moved
    /// into a control service is refused too.
    ///
    /// # Errors
    ///
    /// [`Error::Unsupported`] when the store wrote despite a condition or
    /// its pointers moved.
    async fn probe(&self) -> Result<()> {
        if self.moved().await? {
            return Err(Error::Unsupported(
                "this store's pointers moved into a fleet's control service, which keeps and \
                 sweeps them; a host on its own cannot use it",
            ));
        }
        let mut probe = [0_u8; 16];
        getrandom::fill(&mut probe).map_err(std::io::Error::from)?;
        let name = probe
            .iter()
            .fold(String::with_capacity(32), |mut name, byte| {
                use fmt::Write as _;
                let _ = write!(name, "{byte:02x}");
                name
            });
        let path = self.path(&format!("{PROBES}/{name}"));
        let checked = self.conditions_hold(&path).await;
        let _ = self.backend.delete(&path).await;
        if checked? {
            Ok(())
        } else {
            Err(Error::Unsupported(
                "this store ignores conditional writes; keep pointers in the control service",
            ))
        }
    }

    /// Writes the probe at `path` four times: creates it, creates it again,
    /// replaces it, and replaces the version the first create made again.
    /// Whether the second and fourth were refused and the others stored.
    async fn conditions_hold(&self, path: &Path) -> Result<bool> {
        let first = self.put_probe(path, b"one", PutMode::Create).await?;
        if !refused(self.put_probe(path, b"two", PutMode::Create).await)? {
            return Ok(false);
        }
        let first = UpdateVersion {
            e_tag: first.e_tag,
            version: first.version,
        };
        self.put_probe(path, b"three", PutMode::Update(first.clone()))
            .await?;
        refused(self.put_probe(path, b"four", PutMode::Update(first)).await)
    }

    async fn put_probe(
        &self,
        path: &Path,
        bytes: &'static [u8],
        mode: PutMode,
    ) -> object_store::Result<PutResult> {
        let options = PutOptions {
            mode,
            ..Default::default()
        };
        self.backend
            .put_opts(path, Bytes::from_static(bytes).into(), options)
            .await
    }
}

/// Whether a probe write was refused for its condition.
fn refused(written: object_store::Result<PutResult>) -> Result<bool> {
    match written {
        Err(
            object_store::Error::AlreadyExists { .. } | object_store::Error::Precondition { .. },
        ) => Ok(true),
        Ok(_) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

impl PointerStore for ObjectPointers {
    fn read<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Option<Kept>>> {
        Box::pin(async move {
            let path = self.pointer_path(name)?;
            let read = match self.backend.get(&path).await {
                Ok(read) => read,
                Err(object_store::Error::NotFound { .. }) => return Ok(None),
                Err(error) => return Err(error.into()),
            };
            if read.meta.size > (HEADER_BYTES + MAX_POINTER_BYTES) as u64 {
                return Err(Error::Invalid("pointer too large"));
            }
            let version = Version::Object {
                e_tag: read.meta.e_tag.clone(),
                version: read.meta.version.clone(),
            };
            let stored = read.bytes().await?;
            let (owner, pointer) = unstamped(&stored)?;
            Ok(Some(Kept {
                owner,
                pointer,
                version,
            }))
        })
    }

    fn write<'a>(
        &'a self,
        name: &'a str,
        owner: Stamp,
        pointer: Bytes,
        on: Option<&'a Version>,
    ) -> BoxFuture<'a, Result<Option<Version>>> {
        Box::pin(async move {
            let path = self.pointer_path(name)?;
            let mode = match on {
                None => PutMode::Create,
                Some(Version::Object { e_tag, version }) => PutMode::Update(UpdateVersion {
                    e_tag: e_tag.clone(),
                    version: version.clone(),
                }),
                Some(Version::Row(_)) => {
                    return Err(Error::Invalid("a row version names no object"));
                }
            };
            let options = PutOptions {
                mode,
                ..Default::default()
            };
            match self
                .backend
                .put_opts(&path, stamped(owner, &pointer)?.into(), options)
                .await
            {
                Ok(put) => Ok(Some(Version::Object {
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
        })
    }

    fn names(&self) -> BoxFuture<'_, Result<Vec<String>>> {
        Box::pin(async move {
            let prefix = self.path(POINTERS);
            self.backend
                .list(Some(&prefix))
                .map_err(Error::from)
                .try_filter_map(|meta| {
                    let name = meta.location.prefix_match(&prefix).map(|parts| {
                        parts
                            .map(|part| part.as_ref().to_owned())
                            .collect::<Vec<_>>()
                    });
                    async move {
                        Ok(match name.as_deref() {
                            Some([name]) if check_name(name).is_ok() => Some(name.clone()),
                            _ => None,
                        })
                    }
                })
                .try_collect()
                .await
        })
    }

    fn check(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(self.probe())
    }
}

/// `pointer` as an object store keeps it: after a stamp no other write
/// uses. Storing the same pointer again, or the empty one again, then
/// still gives a new version where a store's entity tag follows the bytes
/// (S3), so a write held up in flight, on condition of a version read
/// long ago, can never land on a later write that happens to hold the
/// same bytes.
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
