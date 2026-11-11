//! The content hash of each file templates depend on, with the metadata
//! it was read under, kept in a directory of their own beside the
//! templates: neither a later template nor a later agent reads a file
//! again unless its metadata says it may have changed. A base image is
//! gigabytes, and every agent start checks each template it finds
//! against today's files, so without them a restart would read it whole
//! before it serves.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// The directory, under the templates directory, that keeps the hashes
/// for the next agent.
pub(super) const INPUTS: &str = "inputs";
/// The file there that keeps them.
const HASHES: &str = "hashes.json";
/// Where it is written before it replaces the last one.
const HASHES_PART: &str = "hashes.json.part";

/// What a file's metadata says about its content. Every write to a file,
/// and every replacement of it, changes one of these: the kernel moves a
/// file's change time on each, and nothing can set it back.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Stamp {
    device: u64,
    inode: u64,
    len: u64,
    modified_ns: i128,
    changed_ns: i128,
}

impl Stamp {
    fn of(metadata: &fs::Metadata) -> Self {
        let ns = |secs: i64, nanos: i64| i128::from(secs) * 1_000_000_000 + i128::from(nanos);
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            len: metadata.len(),
            modified_ns: ns(metadata.mtime(), metadata.mtime_nsec()),
            changed_ns: ns(metadata.ctime(), metadata.ctime_nsec()),
        }
    }
}

/// One file's hash as the file keeps it.
#[derive(Serialize, Deserialize)]
struct Known {
    path: PathBuf,
    stamp: Stamp,
    blake3: String,
}

/// The hashes known, and where they are kept.
#[derive(Debug, Default)]
pub(crate) struct Hashes {
    /// The directory whose file keeps them; none keeps them in memory
    /// only.
    dir: Option<PathBuf>,
    known: Mutex<HashMap<PathBuf, (Stamp, String)>>,
}

impl Hashes {
    /// The hashes an earlier agent kept under `templates`, the templates
    /// directory, less those of files changed since. A list that cannot be
    /// read or does not parse keeps none: every file is read again.
    /// Blocks.
    pub(crate) fn load(templates: &Path) -> Self {
        let dir = templates.join(INPUTS);
        let kept: Vec<Known> = fs::read(dir.join(HASHES))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let known = kept
            .into_iter()
            .filter(|known| {
                fs::metadata(&known.path).is_ok_and(|now| Stamp::of(&now) == known.stamp)
            })
            .map(|known| (known.path, (known.stamp, known.blake3)))
            .collect();
        Self {
            dir: Some(dir),
            known: Mutex::new(known),
        }
    }

    /// The file that keeps them, if any.
    #[cfg(test)]
    pub(super) fn file(&self) -> Option<PathBuf> {
        self.dir.as_ref().map(|dir| dir.join(HASHES))
    }

    /// The length and content hash of the file at `path`, read whole only
    /// when its metadata says it may have changed. Blocks.
    pub(super) fn of(&self, path: &Path) -> io::Result<(u64, String)> {
        let stamp = Stamp::of(&fs::metadata(path)?);
        if let Some(hash) = self.known(path, stamp)? {
            return Ok((stamp.len, hash));
        }
        let mut hasher = blake3::Hasher::new();
        hasher.update_reader(fs::File::open(path)?)?;
        // A file written to while it was read has no one content.
        if Stamp::of(&fs::metadata(path)?) != stamp {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                format!("{} changed while it was read", path.display()),
            ));
        }
        let hash = hasher.finalize().to_hex().to_string();
        let mut known = self.lock()?;
        known.insert(path.to_owned(), (stamp, hash.clone()));
        // Under the lock, so an older list never replaces a newer one. A
        // list that is lost costs the next agent a read, nothing more.
        if let Some(dir) = &self.dir
            && let Err(error) = keep(dir, &known)
        {
            tracing::warn!(%error, "could not keep the template inputs' hashes");
        }
        Ok((stamp.len, hash))
    }

    /// The hash known for `path` while its metadata is `stamp`.
    fn known(&self, path: &Path, stamp: Stamp) -> io::Result<Option<String>> {
        Ok(self
            .lock()?
            .get(path)
            .filter(|(seen, _)| *seen == stamp)
            .map(|(_, hash)| hash.clone()))
    }

    /// Whether any hash is known for `path`.
    #[cfg(test)]
    pub(super) fn knows(&self, path: &Path) -> bool {
        self.lock().is_ok_and(|known| known.contains_key(path))
    }

    fn lock(&self) -> io::Result<std::sync::MutexGuard<'_, HashMap<PathBuf, (Stamp, String)>>> {
        self.known
            .lock()
            .map_err(|_| io::Error::other("template input hashes poisoned"))
    }
}

/// Writes `known` to `dir`'s file whole, replacing the last one in one
/// rename.
fn keep(dir: &Path, known: &HashMap<PathBuf, (Stamp, String)>) -> io::Result<()> {
    let list: Vec<Known> = known
        .iter()
        .map(|(path, (stamp, hash))| Known {
            path: path.clone(),
            stamp: *stamp,
            blake3: hash.clone(),
        })
        .collect();
    let part = dir.join(HASHES_PART);
    fs::create_dir_all(dir)?;
    fs::write(&part, serde_json::to_vec(&list).map_err(io::Error::other)?)?;
    fs::rename(&part, dir.join(HASHES))
}
