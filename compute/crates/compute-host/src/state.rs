//! The host's durable record of every sandbox, changed only by
//! compare-and-set.
//!
//! Each sandbox directory holds one [`Record`] in `sandbox.json`: the
//! sandbox's shape, its number on this host, where its disk is and which of
//! its saved files are valid. The record is the only place that says so;
//! files on disk are never taken as evidence on their own.
//!
//! Every record carries a [`Fence`]:
//!
//! - its **generation** names the sandbox's execution: the programs running
//!   in it. It rises each time they start over, at every boot from the
//!   disk; a restore continues the execution its memory image saved and
//!   keeps it. A request can name the execution it was issued under and is
//!   refused once that execution has been replaced. Generations never
//!   repeat on a host, even across removing and recreating an id: the root
//!   keeps the lowest generation not yet used, and a new record starts
//!   there.
//! - its **revision** counts committed writes.
//!
//! Every write names the fence it expects to replace and fails with
//! [`StateError::Stale`] when the record has moved on, so an operation
//! issued against an older state can never overwrite a newer one. The
//! decision is the pure [`apply`]; [`Records`] adds the disk and ordering.
//!
//! The cache always says what the record's file says. A write whose fate is
//! unknown (the file was replaced, then syncing its directory failed) makes
//! the cache read the file back and marks the record unsure; the next write
//! first makes the file durable, or fails without effect.
//!
//! Keeping VMs alive across agent restarts and taking them back from
//! durable per-VM records follows the design of SPACE
//! (<https://github.com/perplexityai/SPACE>, Apache-2.0); see `NOTICE`.
//!
//! One agent owns a state root at a time: [`Records::open`] takes an
//! exclusive lock on `<root>/agent.lock`, which the kernel releases when the
//! agent's process ends, however it ends. A write in flight holds both its
//! record's lock and the root's lock until it is on disk, even if whoever
//! asked for it gives up, so writes never interleave and the next owner
//! never sees one land after it took over.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use compute_core::SandboxId;
use serde::{Deserialize, Serialize};
use tokio::sync::OwnedMutexGuard;

use crate::layout::{Paths, remove_durably, sandboxes_dir, sync_parent, write_atomic};
use crate::net::LinkAddresses;
use crate::protocol::{Id, SandboxConfig};

/// Name of the lock file in the state root.
const LOCK: &str = "agent.lock";

/// Name of the file in the state root holding the lowest generation no
/// record has used.
const GENERATIONS: &str = "generations";

/// Where a sandbox's disk is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Disk {
    /// On this host, in the sandbox's jail.
    Local,
    /// Only in the store's copy.
    Remote,
}

/// What the host gave a sandbox when it was created, fixed for its life.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Allocation {
    /// The user its VMM runs as.
    pub uid: u32,
    /// The group its VMM runs as.
    pub gid: u32,
    /// Its link to the host, when it is networked.
    pub link: Option<LinkAddresses>,
}

/// Everything the host keeps about one sandbox across restarts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Record {
    pub id: Id,
    /// The execution: raised by every boot.
    pub generation: u64,
    /// Committed writes so far.
    pub revision: u64,
    /// The sandbox's number on this host, unique among its sandboxes. It
    /// names its host-side network link.
    pub ordinal: u32,
    pub allocation: Allocation,
    pub config: SandboxConfig,
    pub disk: Disk,
    /// A complete memory image exists that matches the disk: locally while
    /// the disk is local, in the store's copy once it is remote.
    pub image: bool,
    /// The store holds a copy matching the local files.
    pub archived: bool,
    /// Removal has begun; it finishes even across a restart.
    #[serde(default)]
    pub removing: bool,
}

impl Record {
    /// A new sandbox: a local disk, nothing saved, no execution yet. Its
    /// generation is set when it is inserted.
    pub fn new(id: Id, ordinal: u32, allocation: Allocation, config: SandboxConfig) -> Self {
        Self {
            id,
            generation: 0,
            revision: 1,
            ordinal,
            allocation,
            config,
            disk: Disk::Local,
            image: false,
            archived: false,
            removing: false,
        }
    }

    /// The fence a write must name to replace this record.
    pub fn fence(&self) -> Fence {
        Fence {
            generation: self.generation,
            revision: self.revision,
        }
    }
}

/// Which version of a record an operation was issued against.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Fence {
    /// The sandbox's execution.
    pub generation: u64,
    /// The record's write count.
    pub revision: u64,
}

impl std::fmt::Display for Fence {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "generation {} revision {}",
            self.generation, self.revision
        )
    }
}

/// What one write changes. Anything not set keeps its value.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Change {
    disk: Option<Disk>,
    image: Option<bool>,
    archived: Option<bool>,
    execution: bool,
    removing: bool,
}

impl Change {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn disk(mut self, disk: Disk) -> Self {
        self.disk = Some(disk);
        self
    }

    pub fn image(mut self, image: bool) -> Self {
        self.image = Some(image);
        self
    }

    pub fn archived(mut self, archived: bool) -> Self {
        self.archived = Some(archived);
        self
    }

    /// A new execution starts, from the disk: the generation rises.
    pub fn execution(mut self) -> Self {
        self.execution = true;
        self
    }

    /// Removal begins.
    pub fn removing(mut self) -> Self {
        self.removing = true;
        self
    }

    fn apply_to(self, record: &mut Record) {
        if let Some(disk) = self.disk {
            record.disk = disk;
        }
        if let Some(image) = self.image {
            record.image = image;
        }
        if let Some(archived) = self.archived {
            record.archived = archived;
        }
        if self.execution {
            record.generation += 1;
        }
        record.removing |= self.removing;
    }
}

/// A state write or check that could not be carried out.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum StateError {
    /// The record moved on since the operation was issued.
    #[error("sandbox {id} is at {found}, not {expected}")]
    Stale {
        /// The sandbox.
        id: Id,
        /// What the operation was issued against.
        expected: Fence,
        /// What the record holds now.
        found: Fence,
    },
    /// The request names an execution the sandbox no longer runs.
    #[error("sandbox {id} is at generation {found}, not {expected}")]
    Generation {
        /// The sandbox.
        id: Id,
        /// The generation the request names.
        expected: u64,
        /// The sandbox's generation.
        found: u64,
    },
    /// No record for this sandbox.
    #[error("no record for sandbox {0}")]
    NotFound(Id),
    /// A record for this sandbox already exists.
    #[error("a record for sandbox {0} already exists")]
    Exists(Id),
    /// Another agent holds the state root.
    #[error("another host agent holds {0}")]
    Locked(PathBuf),
    /// A record could not be read as one.
    #[error("record {path} is unreadable: {message}")]
    Corrupt {
        /// The record's file.
        path: PathBuf,
        /// What is wrong with it.
        message: String,
    },
    /// Host storage failed.
    #[error("state I/O failed: {0}")]
    Io(String),
}

impl From<io::Error> for StateError {
    fn from(error: io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

/// Decides a write: the record that replaces `current`, `None` when the
/// change leaves it as it is, or why the write is refused.
pub(crate) fn apply(
    id: Id,
    current: Option<&Record>,
    expected: Fence,
    change: Change,
) -> Result<Option<Record>, StateError> {
    let current = current.ok_or(StateError::NotFound(id))?;
    let found = current.fence();
    if found != expected {
        return Err(StateError::Stale {
            id,
            expected,
            found,
        });
    }
    let mut next = current.clone();
    change.apply_to(&mut next);
    if next == *current {
        return Ok(None);
    }
    next.revision += 1;
    Ok(Some(next))
}

/// Checks a request's generation against the sandbox's, when it names one.
pub(crate) fn check_generation(record: &Record, expected: Option<u64>) -> Result<(), StateError> {
    match expected {
        Some(expected) if expected != record.generation => Err(StateError::Generation {
            id: record.id,
            expected,
            found: record.generation,
        }),
        _ => Ok(()),
    }
}

/// A sandbox directory that holds no usable record.
#[derive(Debug)]
pub(crate) struct Stray {
    pub id: Id,
    /// Why its record is unusable; `None` when it has none, which means its
    /// creation never finished or its removal had begun.
    pub problem: Option<StateError>,
}

#[derive(Debug, Default)]
struct Entry {
    /// Serializes writes to this record. A write holds it until it is on
    /// disk, so a slow write delays only its own sandbox.
    writing: Arc<tokio::sync::Mutex<()>>,
    /// The record its file holds; `None` once removed.
    current: Mutex<Option<Record>>,
    /// A write failed part way, so the file may not be durable yet.
    unsure: AtomicBool,
}

/// Every sandbox's record under one state root.
#[derive(Debug)]
pub(crate) struct Records {
    root: PathBuf,
    entries: Mutex<HashMap<SandboxId, Arc<Entry>>>,
    /// The exclusive lock on the root. Every write in flight holds a clone.
    lock: Arc<File>,
    /// The lowest generation no record has used, kept in [`GENERATIONS`].
    unused: tokio::sync::Mutex<u64>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Records {
    /// Takes the state root, waiting up to `wait` for an earlier owner to
    /// let go, and reads every record under it.
    pub async fn open(root: PathBuf, wait: Duration) -> Result<(Self, Vec<Stray>), StateError> {
        tokio::task::spawn_blocking(move || Self::open_blocking(root, wait))
            .await
            .map_err(|error| StateError::Io(error.to_string()))?
    }

    fn open_blocking(root: PathBuf, wait: Duration) -> Result<(Self, Vec<Stray>), StateError> {
        let lock = lock_root(&root, wait)?;
        let dir = sandboxes_dir(&root);
        fs::create_dir_all(&dir)?;
        let generations = root.join(GENERATIONS);
        let mut unused = match fs::read_to_string(&generations) {
            Ok(text) => text.trim().parse().map_err(|error| StateError::Corrupt {
                path: generations.clone(),
                message: format!("{error}"),
            })?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
            Err(error) => return Err(error.into()),
        };
        let mut entries = HashMap::new();
        let mut strays = Vec::new();
        for entry in fs::read_dir(&dir)? {
            let Some(id) = entry?
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<Id>().ok())
            else {
                continue;
            };
            match read(&Paths::new(&root, id).record, id) {
                Ok(Some(record)) => {
                    unused = unused.max(record.generation + 1);
                    let entry = Entry {
                        current: Mutex::new(Some(record)),
                        ..Entry::default()
                    };
                    entries.insert(id.0, Arc::new(entry));
                }
                Ok(None) => strays.push(Stray { id, problem: None }),
                Err(problem) => strays.push(Stray {
                    id,
                    problem: Some(problem),
                }),
            }
        }
        let records = Self {
            root,
            entries: Mutex::new(entries),
            lock: Arc::new(lock),
            unused: tokio::sync::Mutex::new(unused),
        };
        Ok((records, strays))
    }

    /// Every record, in id order.
    pub fn all(&self) -> Vec<Record> {
        let mut all: Vec<Record> = locked(&self.entries)
            .values()
            .filter_map(|entry| locked(&entry.current).clone())
            .collect();
        all.sort_by_key(|record| record.id);
        all
    }

    /// The committed record for `id`.
    pub fn get(&self, id: Id) -> Option<Record> {
        let entry = locked(&self.entries).get(&id.0).cloned()?;
        locked(&entry.current).clone()
    }

    /// Writes the first record of a new sandbox, which starts at a
    /// generation no earlier record on this host used.
    pub async fn insert(&self, mut record: Record) -> Result<Record, StateError> {
        let id = record.id;
        record.generation = *self.unused.lock().await;
        let entry = Arc::clone(locked(&self.entries).entry(id.0).or_default());
        let writing = Arc::clone(&entry.writing).lock_owned().await;
        self.reconcile(id, &entry).await?;
        if locked(&entry.current).is_some() {
            return Err(StateError::Exists(id));
        }
        self.persist(id, &entry, writing, Some(record.clone()))
            .await?;
        Ok(record)
    }

    /// Replaces the record for `id` with `change` applied, if it is still
    /// at `expected`. Returns the record now committed.
    pub async fn commit(
        &self,
        id: Id,
        expected: Fence,
        change: Change,
    ) -> Result<Record, StateError> {
        let entry = self.entry(id)?;
        let writing = Arc::clone(&entry.writing).lock_owned().await;
        self.reconcile(id, &entry).await?;
        let current = locked(&entry.current).clone();
        match apply(id, current.as_ref(), expected, change)? {
            Some(next) => {
                self.persist(id, &entry, writing, Some(next.clone()))
                    .await?;
                Ok(next)
            }
            // Unchanged; `apply` saw that `current` exists.
            None => current.ok_or(StateError::NotFound(id)),
        }
    }

    /// Deletes the record for `id` if it is still at `expected`. The
    /// sandbox's directory stays; without a record it is a stray. Its
    /// generations are never used again.
    pub async fn remove(&self, id: Id, expected: Fence) -> Result<(), StateError> {
        let entry = self.entry(id)?;
        let writing = Arc::clone(&entry.writing).lock_owned().await;
        self.reconcile(id, &entry).await?;
        let found = locked(&entry.current)
            .as_ref()
            .map(Record::fence)
            .ok_or(StateError::NotFound(id))?;
        if found != expected {
            return Err(StateError::Stale {
                id,
                expected,
                found,
            });
        }
        self.retire_generation(found.generation).await?;
        self.persist(id, &entry, writing, None).await?;
        let mut entries = locked(&self.entries);
        if entries
            .get(&id.0)
            .is_some_and(|present| Arc::ptr_eq(present, &entry))
        {
            entries.remove(&id.0);
        }
        Ok(())
    }

    fn entry(&self, id: Id) -> Result<Arc<Entry>, StateError> {
        locked(&self.entries)
            .get(&id.0)
            .cloned()
            .ok_or(StateError::NotFound(id))
    }

    /// Makes sure no record starts at `generation` or below from now on.
    async fn retire_generation(&self, generation: u64) -> Result<(), StateError> {
        let mut unused = self.unused.lock().await;
        let next = generation + 1;
        if next <= *unused {
            return Ok(());
        }
        let path = self.root.join(GENERATIONS);
        let lock = Arc::clone(&self.lock);
        tokio::task::spawn_blocking(move || {
            let _held = lock;
            write_atomic(&path, format!("{next}\n").as_bytes())
        })
        .await
        .map_err(|error| StateError::Io(error.to_string()))??;
        *unused = next;
        Ok(())
    }

    /// After a write to `id` failed part way: makes its file durable and
    /// the cache what the file says, or fails without changing anything.
    async fn reconcile(&self, id: Id, entry: &Arc<Entry>) -> Result<(), StateError> {
        if !entry.unsure.load(Ordering::Acquire) {
            return Ok(());
        }
        let path = Paths::new(&self.root, id).record;
        let lock = Arc::clone(&self.lock);
        let entry = Arc::clone(entry);
        tokio::task::spawn_blocking(move || {
            let _held = lock;
            let found = read(&path, id)?;
            sync_parent(&path)?;
            *locked(&entry.current) = found;
            entry.unsure.store(false, Ordering::Release);
            Ok(())
        })
        .await
        .map_err(|error| StateError::Io(error.to_string()))?
    }

    /// Writes `next` as the record of `id` (or deletes it for `None`), then
    /// makes it the committed record. The work owns the record's lock and
    /// the root's lock, so it finishes even if the caller stops waiting.
    async fn persist(
        &self,
        id: Id,
        entry: &Arc<Entry>,
        writing: OwnedMutexGuard<()>,
        next: Option<Record>,
    ) -> Result<(), StateError> {
        let bytes = match &next {
            Some(record) => {
                let mut bytes = serde_json::to_vec(record)
                    .map_err(|error| StateError::Io(error.to_string()))?;
                bytes.push(b'\n');
                Some(bytes)
            }
            None => None,
        };
        let path = Paths::new(&self.root, id).record;
        let lock = Arc::clone(&self.lock);
        let entry = Arc::clone(entry);
        tokio::task::spawn_blocking(move || {
            let _held = (lock, writing);
            let written = match &bytes {
                Some(bytes) => write_atomic(&path, bytes),
                None => remove_durably(&path),
            };
            match written {
                Ok(()) => {
                    *locked(&entry.current) = next;
                    Ok(())
                }
                Err(error) => {
                    // The file may hold `next` already. Whatever it holds
                    // is what the cache says, and the next write first
                    // makes it durable.
                    entry.unsure.store(true, Ordering::Release);
                    if let Ok(found) = read(&path, id) {
                        *locked(&entry.current) = found;
                    }
                    Err(error.into())
                }
            }
        })
        .await
        .map_err(|error| StateError::Io(error.to_string()))?
    }
}

/// Opens `<root>/agent.lock` and takes an exclusive lock on it, retrying
/// until `wait` has passed.
fn lock_root(root: &Path, wait: Duration) -> Result<File, StateError> {
    fs::create_dir_all(root)?;
    lock_exclusive(&root.join(LOCK), wait)
}

/// Takes an exclusive `flock` on `path` (created if missing), waiting up to
/// `wait` for another holder to let go. The lock lasts as long as the file.
pub(crate) fn lock_exclusive(path: &Path, wait: Duration) -> Result<File, StateError> {
    use rustix::fs::{FlockOperation, flock};

    let path = path.to_owned();
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)?;
    let deadline = Instant::now() + wait;
    loop {
        match flock(&file, FlockOperation::NonBlockingLockExclusive) {
            Ok(()) => return Ok(file),
            Err(rustix::io::Errno::WOULDBLOCK) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(rustix::io::Errno::WOULDBLOCK) => return Err(StateError::Locked(path)),
            Err(error) => return Err(io::Error::from(error).into()),
        }
    }
}

/// Reads one record; `None` when there is none.
fn read(path: &Path, id: Id) -> Result<Option<Record>, StateError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let corrupt = |message: String| StateError::Corrupt {
        path: path.to_owned(),
        message,
    };
    let record: Record =
        serde_json::from_slice(&bytes).map_err(|error| corrupt(error.to_string()))?;
    if record.id != id {
        return Err(corrupt(format!("it names sandbox {}", record.id)));
    }
    Ok(Some(record))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::protocol::SleepConfig;

    /// splitmix64: small, fast and good enough to drive simulations.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }

        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }

        fn chance(&mut self, percent: u64) -> bool {
            self.below(100) < percent
        }
    }

    fn config() -> SandboxConfig {
        SandboxConfig {
            vcpus: 1,
            memory_mib: 256,
            sleep: SleepConfig::default(),
        }
    }

    fn id(n: u128) -> Id {
        Id(SandboxId(n))
    }

    fn allocation() -> Allocation {
        Allocation {
            uid: 4_000_000,
            gid: 4_000_000,
            link: None,
        }
    }

    fn random_change(rng: &mut Rng) -> Change {
        let mut change = Change::new();
        if rng.chance(30) {
            change = change.disk(if rng.chance(50) {
                Disk::Local
            } else {
                Disk::Remote
            });
        }
        if rng.chance(50) {
            change = change.image(rng.chance(50));
        }
        if rng.chance(40) {
            change = change.archived(rng.chance(50));
        }
        if rng.chance(20) {
            change = change.execution();
        }
        change
    }

    /// The current fence, or one wrong in a way a stale operation's is.
    fn random_fence(rng: &mut Rng, current: Fence, seen: &[Fence]) -> Fence {
        match rng.below(10) {
            0..=5 => current,
            6 | 7 if !seen.is_empty() => {
                seen[usize::try_from(rng.below(seen.len() as u64)).unwrap()]
            }
            8 => Fence {
                generation: current.generation + 1,
                ..current
            },
            _ => Fence {
                revision: current.revision + 1 + rng.below(3),
                ..current
            },
        }
    }

    /// The decision core against a plain model, over many seeds.
    #[test]
    fn writes_apply_only_against_the_current_fence() {
        for seed in 0..2_000 {
            let mut rng = Rng(seed);
            let sandbox = id(7);
            let mut model = Record::new(sandbox, 3, allocation(), config());
            let mut seen = Vec::new();
            for _ in 0..200 {
                let fence = random_fence(&mut rng, model.fence(), &seen);
                let change = random_change(&mut rng);
                let result = apply(sandbox, Some(&model), fence, change);
                if fence != model.fence() {
                    assert!(
                        matches!(result, Err(StateError::Stale { found, .. }) if found == model.fence()),
                        "seed {seed}: a stale write was not refused: {result:?}"
                    );
                    continue;
                }
                let mut expected = model.clone();
                change.apply_to(&mut expected);
                match result.unwrap() {
                    None => assert_eq!(expected, model, "seed {seed}"),
                    Some(next) => {
                        assert_ne!(expected, model, "seed {seed}: a no-op was written");
                        expected.revision += 1;
                        assert_eq!(next, expected, "seed {seed}");
                        seen.push(model.fence());
                        model = next;
                    }
                }
            }
        }
        let fence = Fence {
            generation: 0,
            revision: 1,
        };
        assert!(matches!(
            apply(id(1), None, fence, Change::new()),
            Err(StateError::NotFound(_))
        ));
    }

    #[test]
    fn requests_naming_another_execution_are_refused() {
        let mut record = Record::new(id(1), 0, allocation(), config());
        record.generation = 4;
        assert!(check_generation(&record, None).is_ok());
        assert!(check_generation(&record, Some(4)).is_ok());
        assert_eq!(
            check_generation(&record, Some(3)),
            Err(StateError::Generation {
                id: id(1),
                expected: 3,
                found: 4
            })
        );
    }

    fn temp_root(name: &str) -> tempfile::TempDir {
        tempfile::Builder::new().prefix(name).tempdir().unwrap()
    }

    /// A new sandbox's record, with the directory the agent creates before
    /// writing it.
    fn fresh(root: &Path, n: u128, ordinal: u32) -> Record {
        fs::create_dir_all(Paths::new(root, id(n)).dir).unwrap();
        Record::new(id(n), ordinal, allocation(), config())
    }

    #[tokio::test]
    async fn one_agent_at_a_time_owns_a_root() {
        let root = temp_root("state-lock");
        let (first, _) = Records::open(root.path().into(), Duration::ZERO)
            .await
            .unwrap();
        let second = Records::open(root.path().into(), Duration::from_millis(50)).await;
        assert!(matches!(second, Err(StateError::Locked(_))), "{second:?}");
        drop(first);
        Records::open(root.path().into(), Duration::from_secs(1))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn strays_and_corrupt_records_are_reported_not_loaded() {
        let root = temp_root("state-strays");
        let (records, _) = Records::open(root.path().into(), Duration::ZERO)
            .await
            .unwrap();
        records.insert(fresh(root.path(), 1, 0)).await.unwrap();
        assert!(matches!(
            records.insert(fresh(root.path(), 1, 1)).await,
            Err(StateError::Exists(_))
        ));
        drop(records);
        let unfinished = Paths::new(root.path(), id(2));
        fs::create_dir_all(&unfinished.dir).unwrap();
        let corrupt = Paths::new(root.path(), id(3));
        fs::create_dir_all(&corrupt.dir).unwrap();
        fs::write(&corrupt.record, b"{").unwrap();
        let (records, mut strays) = Records::open(root.path().into(), Duration::ZERO)
            .await
            .unwrap();
        strays.sort_by_key(|stray| stray.id);
        assert_eq!(records.all().len(), 1);
        assert_eq!(strays.len(), 2);
        assert!(strays[0].id == id(2) && strays[0].problem.is_none());
        assert!(matches!(
            strays[1].problem,
            Some(StateError::Corrupt { .. })
        ));
    }

    #[tokio::test]
    async fn removal_is_fenced_and_frees_the_id() {
        let root = temp_root("state-remove");
        let (records, _) = Records::open(root.path().into(), Duration::ZERO)
            .await
            .unwrap();
        let first = records.insert(fresh(root.path(), 1, 0)).await.unwrap();
        let moved = records
            .commit(id(1), first.fence(), Change::new().execution())
            .await
            .unwrap();
        assert_eq!(moved.generation, 1);
        assert!(matches!(
            records.remove(id(1), first.fence()).await,
            Err(StateError::Stale { .. })
        ));
        records.remove(id(1), moved.fence()).await.unwrap();
        assert!(records.get(id(1)).is_none());
        assert!(!Paths::new(root.path(), id(1)).record.exists());
        assert!(matches!(
            records.commit(id(1), moved.fence(), Change::new()).await,
            Err(StateError::NotFound(_))
        ));
        // A new sandbox with the same id never reuses a generation, so a
        // late request for the old one cannot act on it, even after a
        // restart.
        let again = records.insert(fresh(root.path(), 1, 0)).await.unwrap();
        assert_eq!(again.generation, 2);
        records.remove(id(1), again.fence()).await.unwrap();
        drop(records);
        let (records, _) = Records::open(root.path().into(), Duration::ZERO)
            .await
            .unwrap();
        let third = records.insert(fresh(root.path(), 1, 0)).await.unwrap();
        assert_eq!(third.generation, 3);
    }

    /// A write that replaced the file and then failed to sync its directory
    /// must not leave the cache describing the older record: the next write
    /// would be decided against a version the file no longer holds.
    #[tokio::test]
    async fn a_write_that_fails_after_landing_leaves_the_cache_true_to_the_file() {
        let root = temp_root("state-unsure");
        let (records, _) = Records::open(root.path().into(), Duration::ZERO)
            .await
            .unwrap();
        let first = records.insert(fresh(root.path(), 1, 0)).await.unwrap();
        let path = Paths::new(root.path(), id(1)).record;
        crate::layout::tests::FAILPOINTS
            .lock()
            .unwrap()
            .push((path.clone(), "renamed"));
        let failed = records
            .commit(id(1), first.fence(), Change::new().image(true))
            .await;
        crate::layout::tests::FAILPOINTS
            .lock()
            .unwrap()
            .retain(|(failing, _)| failing != &path);
        assert!(matches!(failed, Err(StateError::Io(_))), "{failed:?}");
        let cached = records.get(id(1)).unwrap();
        assert!(cached.image, "the cache lost a write the file holds");
        assert_eq!(cached, read(&path, id(1)).unwrap().unwrap());
        // Whoever still holds the old version is refused.
        assert!(matches!(
            records
                .commit(id(1), first.fence(), Change::new().image(false))
                .await,
            Err(StateError::Stale { .. })
        ));
        records
            .commit(id(1), cached.fence(), Change::new().image(false))
            .await
            .unwrap();
    }

    /// One acknowledged write, as its writer saw it.
    #[derive(Debug)]
    struct Acked {
        expected: Fence,
        record: Record,
    }

    type History = Arc<Mutex<BTreeMap<u128, Vec<Acked>>>>;

    /// Many writers race on a few records with fresh and stale fences while
    /// the agent repeatedly "crashes" (every writer is dropped wherever it
    /// is) and the records are reopened from disk. In some rounds every
    /// write to one record fails after replacing its file, as when syncing
    /// the directory fails. Checks that
    ///
    /// - acknowledged writes form one chain per record: each replaced
    ///   exactly the version before it, so no two writes ever applied
    ///   against the same version and none applied against a stale one;
    /// - after a crash the disk holds the last acknowledged record or a
    ///   later one, never anything older.
    #[test]
    fn racing_writers_and_crashes_never_lose_or_fork_a_record() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .unwrap();
        for seed in 0..24 {
            runtime.block_on(simulate(seed));
        }
    }

    async fn simulate(seed: u64) {
        const SANDBOXES: u128 = 3;
        const WRITERS: u64 = 8;
        let root = temp_root("state-sim");
        let mut rng = Rng(seed);
        let (records, _) = Records::open(root.path().into(), Duration::ZERO)
            .await
            .unwrap();
        for n in 0..SANDBOXES {
            records
                .insert(fresh(root.path(), n, u32::try_from(n).unwrap()))
                .await
                .unwrap();
        }
        let mut records = Arc::new(records);
        let history: History = Arc::default();
        restart_history(&history, &records, SANDBOXES);
        for _round in 0..6 {
            // Writes to sandbox 0 land, then report failure.
            let failing = rng.chance(50);
            let unsure = Paths::new(root.path(), id(0)).record;
            if failing {
                crate::layout::tests::FAILPOINTS
                    .lock()
                    .unwrap()
                    .push((unsure.clone(), "renamed"));
            }
            let mut writers = tokio::task::JoinSet::new();
            for _ in 0..WRITERS {
                let records = Arc::clone(&records);
                let history = Arc::clone(&history);
                let mut rng = Rng(rng.next());
                writers.spawn(async move {
                    let mut earlier: Vec<Fence> = Vec::new();
                    loop {
                        let n = u128::from(rng.below(3));
                        let current = records.get(id(n)).unwrap().fence();
                        let fence = random_fence(&mut rng, current, &earlier);
                        earlier.push(current);
                        match records.commit(id(n), fence, random_change(&mut rng)).await {
                            Ok(record) if record.fence() != fence => {
                                let mut history = history.lock().unwrap();
                                history.entry(n).or_default().push(Acked {
                                    expected: fence,
                                    record,
                                });
                            }
                            Ok(_) | Err(StateError::Stale { .. }) => {}
                            Err(StateError::Io(_)) if failing && n == 0 => {}
                            Err(error) => panic!("seed {seed}: {error}"),
                        }
                        if rng.chance(10) {
                            tokio::task::yield_now().await;
                        }
                    }
                });
            }
            tokio::time::sleep(Duration::from_millis(5 + rng.below(25))).await;
            // The crash: every writer stops wherever it is.
            writers.shutdown().await;
            crate::layout::tests::FAILPOINTS
                .lock()
                .unwrap()
                .retain(|(path, _)| path != &unsure);
            drop(Arc::try_unwrap(records).expect("every writer is gone"));
            let (reopened, strays) = Records::open(root.path().into(), Duration::from_secs(10))
                .await
                .unwrap();
            assert!(strays.is_empty(), "seed {seed}: {strays:?}");
            {
                let history = history.lock().unwrap();
                for n in 0..SANDBOXES {
                    let chain = &history[&n];
                    check_chain(seed, chain);
                    let last = &chain[chain.len() - 1].record;
                    let on_disk = reopened.get(id(n)).unwrap();
                    assert!(
                        on_disk.revision >= last.revision,
                        "seed {seed}: the disk lost an acknowledged write"
                    );
                    if on_disk.revision == last.revision {
                        assert_eq!(&on_disk, last, "seed {seed}");
                    }
                }
            }
            records = Arc::new(reopened);
            restart_history(&history, &records, SANDBOXES);
        }
    }

    /// Starts each record's chain again from what is committed now.
    fn restart_history(history: &History, records: &Records, sandboxes: u128) {
        let mut history = history.lock().unwrap();
        history.clear();
        for n in 0..sandboxes {
            let record = records.get(id(n)).unwrap();
            let expected = record.fence();
            history.insert(n, vec![Acked { expected, record }]);
        }
    }

    /// Acknowledged writes form one chain: each replaced the version just
    /// before it, and no two share a version. A crash can interrupt a
    /// writer after its write landed but before it heard so, leaving a gap
    /// where the unacknowledged write sits.
    fn check_chain(seed: u64, chain: &[Acked]) {
        let mut ordered: Vec<&Acked> = chain.iter().collect();
        ordered.sort_by_key(|acked| acked.record.revision);
        for pair in ordered.windows(2) {
            let (before, after) = (pair[0], pair[1]);
            assert!(
                after.record.revision > before.record.revision,
                "seed {seed}: two writes applied against one version"
            );
            assert_eq!(
                after.expected.revision + 1,
                after.record.revision,
                "seed {seed}"
            );
            if after.record.revision == before.record.revision + 1 {
                assert_eq!(
                    after.expected,
                    before.record.fence(),
                    "seed {seed}: a write applied against a version that was not current"
                );
            }
        }
    }
}
