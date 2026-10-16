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

use crate::layout::{
    Paths, chroot_base, create_dir_durably, remove_durably, sandboxes_dir, sync_parent,
    write_atomic,
};
use crate::net::LinkAddresses;
use crate::protocol::{Id, SandboxConfig};

/// Name of the lock file in the state root.
const LOCK: &str = "agent.lock";

/// Name of the file in the state root holding the lowest generation no
/// record has used.
const GENERATIONS: &str = "generations";

/// Milliseconds since the Unix epoch, as records keep times.
pub(crate) fn unix_ms_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

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
#[allow(
    clippy::struct_excessive_bools,
    reason = "each flag is a separate fact one write may change on its own"
)]
pub(crate) struct Record {
    /// The sandbox's id: every request names it.
    pub id: Id,
    /// The name its directory, jail, cgroup and network were made under,
    /// when that is not its id: a ready sandbox keeps the name it was
    /// filled under once a create claims it, as cgroups and network
    /// namespaces cannot be renamed (see [`crate::agent`]'s ready pool).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<Id>,
    /// A ready sandbox: restored from its shape's template ahead of any
    /// create, and disposable until one claims it. It is never saved, and
    /// a starting agent removes it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ready: bool,
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
    /// Whether its guest knows it is this sandbox.
    #[serde(default)]
    pub identity: Identity,
    /// Its last activity, in milliseconds since the Unix epoch, as of the
    /// record's latest write, so a restart does not reset how long it has
    /// been idle. Steps write it along with what they change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_ms: Option<u64>,
    /// When the store's latest copy was made, in milliseconds since the
    /// Unix epoch. It stays once the sandbox changes again: that copy is
    /// still what losing this host would go back to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backed_up_ms: Option<u64>,
}

/// Whether a sandbox's guest knows which sandbox it is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Identity {
    /// It booted with the sandbox's id on its kernel command line, or
    /// acknowledged a restore notice naming it.
    #[default]
    Known,
    /// The memory image is of another guest, such as a template's. Until
    /// the guest has acknowledged a restore notice naming this sandbox, no
    /// VM of it may be counted awake or used, and a VM found running after
    /// a restart is ended. A boot makes it known.
    Pending,
}

impl Record {
    /// A new sandbox: a local disk, nothing saved, no execution yet. Its
    /// generation is set when it is inserted.
    pub fn new(id: Id, ordinal: u32, allocation: Allocation, config: SandboxConfig) -> Self {
        Self {
            id,
            host: None,
            ready: false,
            generation: 0,
            revision: 1,
            ordinal,
            allocation,
            config,
            disk: Disk::Local,
            image: false,
            archived: false,
            removing: false,
            identity: Identity::Known,
            last_used_ms: None,
            backed_up_ms: None,
        }
    }

    /// The name of the sandbox's directory and everything else the host
    /// made for it: its id, unless it was claimed under another.
    pub fn host(&self) -> Id {
        self.host.unwrap_or(self.id)
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
    identity: Option<Identity>,
    last_used_ms: Option<u64>,
    backed_up_ms: Option<u64>,
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

    /// Whether the guest knows which sandbox it is.
    pub fn identity(mut self, identity: Identity) -> Self {
        self.identity = Some(identity);
        self
    }

    /// Removal begins.
    pub fn removing(mut self) -> Self {
        self.removing = true;
        self
    }

    /// Records the sandbox's last activity. It never moves backwards.
    pub fn last_used(mut self, unix_ms: u64) -> Self {
        self.last_used_ms = Some(unix_ms);
        self
    }

    /// Records that the store now holds a copy made at `unix_ms`. It never
    /// moves backwards.
    pub fn backed_up(mut self, unix_ms: u64) -> Self {
        self.backed_up_ms = Some(unix_ms);
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
        if let Some(identity) = self.identity {
            record.identity = identity;
        }
        if self.execution {
            record.generation += 1;
        }
        record.removing |= self.removing;
        if let Some(at) = self.last_used_ms {
            record.last_used_ms = Some(record.last_used_ms.map_or(at, |was| was.max(at)));
        }
        if let Some(at) = self.backed_up_ms {
            record.backed_up_ms = Some(record.backed_up_ms.map_or(at, |was| was.max(at)));
        }
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
    /// The host's user ids and networks belong to another state root,
    /// whose VMs may still run.
    #[error("this host's sandboxes belong to state root {0}, which still has sandboxes")]
    HostOwned(PathBuf),
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

#[derive(Debug)]
struct Entry {
    /// The directory the record lives in (see [`Record::host`]).
    host: Id,
    /// Serializes work on this record. Work holds it until it is done, so a
    /// slow write delays only its own sandbox.
    writing: Arc<tokio::sync::Mutex<()>>,
    /// The record its file holds; `None` once removed.
    current: Mutex<Option<Record>>,
    /// A write failed part way, so the file may not be durable yet.
    unsure: AtomicBool,
}

impl Entry {
    fn new(host: Id) -> Self {
        Self {
            host,
            writing: Arc::default(),
            current: Mutex::new(None),
            unsure: AtomicBool::new(false),
        }
    }
}

/// The locks a state root's owner holds. Every piece of work in flight
/// keeps them, so a successor never starts beside it.
#[derive(Debug)]
struct Locks {
    _root: File,
    /// The host's lock, when the agent took one: host-wide resources such
    /// as user ids and networks are touched only under it.
    _host: Option<File>,
}

/// A share of the state root's ownership. Work outside the records that
/// must not outlive their owner, such as a write of a sandbox's holds,
/// keeps one until it lands, so a successor takes the root only after.
#[derive(Clone, Debug)]
pub(crate) struct Ownership {
    _locks: Arc<Locks>,
}

#[cfg(test)]
impl Ownership {
    /// A share of no root's ownership, for tests of work that keeps one.
    pub fn detached() -> Self {
        let root = File::open("/dev/null").expect("/dev/null opens");
        Self {
            _locks: Arc::new(Locks {
                _root: root,
                _host: None,
            }),
        }
    }
}

/// The lowest generation no record has used, as [`GENERATIONS`] holds it.
#[derive(Debug)]
struct Generations {
    path: PathBuf,
    /// Always what the file holds once written; held across each write,
    /// so floors are written in order.
    unused: Mutex<u64>,
}

impl Generations {
    fn unused(&self) -> u64 {
        *locked(&self.unused)
    }

    /// Makes sure no record starts at `generation` or below from now on.
    fn retire(&self, generation: u64) -> io::Result<()> {
        let mut unused = locked(&self.unused);
        let next = generation + 1;
        if next <= *unused {
            return Ok(());
        }
        write_atomic(&self.path, format!("{next}\n").as_bytes())?;
        *unused = next;
        Ok(())
    }
}

/// One record while work on it holds its lock.
struct Slot<'a> {
    /// The directory its file is in.
    host: Id,
    path: &'a Path,
    entry: &'a Entry,
}

impl Slot<'_> {
    fn current(&self) -> Option<Record> {
        locked(&self.entry.current).clone()
    }

    /// After a write failed part way: makes the file durable and the cache
    /// what the file says, or fails without changing anything.
    fn reconcile(&self) -> Result<(), StateError> {
        if !self.entry.unsure.load(Ordering::Acquire) {
            return Ok(());
        }
        let found = read(self.path, self.host)?;
        sync_parent(self.path)?;
        *locked(&self.entry.current) = found;
        self.entry.unsure.store(false, Ordering::Release);
        Ok(())
    }

    /// Writes `next` as the record (or deletes it for `None`), then makes
    /// it the cached one.
    fn write(&self, next: Option<Record>) -> Result<(), StateError> {
        let written = match &next {
            Some(record) => {
                let mut bytes = serde_json::to_vec(record)
                    .map_err(|error| StateError::Io(error.to_string()))?;
                bytes.push(b'\n');
                write_atomic(self.path, &bytes)
            }
            None => remove_durably(self.path),
        };
        match written {
            Ok(()) => {
                *locked(&self.entry.current) = next;
                Ok(())
            }
            Err(error) => {
                // The file may hold `next` already. Whatever it holds is
                // what the cache says, and the next work on the record
                // first makes it durable.
                self.entry.unsure.store(true, Ordering::Release);
                if let Ok(found) = read(self.path, self.host) {
                    *locked(&self.entry.current) = found;
                }
                Err(error.into())
            }
        }
    }
}

/// Holds work on a record at its start, for tests that need it to run
/// late.
#[cfg(test)]
#[derive(Debug)]
struct Gate {
    started: std::sync::mpsc::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
}

/// Every sandbox's record under one state root.
#[derive(Debug)]
pub(crate) struct Records {
    root: PathBuf,
    entries: Mutex<HashMap<SandboxId, Arc<Entry>>>,
    locks: Arc<Locks>,
    generations: Arc<Generations>,
    #[cfg(test)]
    gate: Mutex<Option<Gate>>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Records {
    /// Takes the state root, waiting up to `wait` for an earlier owner to
    /// let go, and reads every record under it. `host` is the host's lock,
    /// if the caller took one; it is kept until the last work in flight
    /// ends.
    pub async fn open(
        root: PathBuf,
        wait: Duration,
        host: Option<File>,
    ) -> Result<(Self, Vec<Stray>), StateError> {
        tokio::task::spawn_blocking(move || Self::open_blocking(root, wait, host))
            .await
            .map_err(|error| StateError::Io(error.to_string()))?
    }

    fn open_blocking(
        root: PathBuf,
        wait: Duration,
        host: Option<File>,
    ) -> Result<(Self, Vec<Stray>), StateError> {
        let lock = lock_root(&root, wait)?;
        // A record is only as durable as every directory above it.
        let dir = sandboxes_dir(&root);
        for each in [root.as_path(), &chroot_base(&root), &dir] {
            create_dir_durably(each)?;
        }
        let path = root.join(GENERATIONS);
        let on_file = match fs::read_to_string(&path) {
            Ok(text) => text.trim().parse().map_err(|error| StateError::Corrupt {
                path: path.clone(),
                message: format!("{error}"),
            })?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
            Err(error) => return Err(error.into()),
        };
        let mut unused = on_file;
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
                Ok(Some(record)) if entries.contains_key(&record.id.0) => strays.push(Stray {
                    id,
                    problem: Some(StateError::Corrupt {
                        path: Paths::new(&root, id).record,
                        message: format!("another record also names sandbox {}", record.id),
                    }),
                }),
                Ok(Some(record)) => {
                    unused = unused.max(record.generation + 1);
                    // A record found on disk may be a write the previous
                    // owner never made durable: nothing relies on it before
                    // it is settled.
                    let entry = Entry::new(id);
                    entry.unsure.store(true, Ordering::Release);
                    let key = record.id.0;
                    *locked(&entry.current) = Some(record);
                    entries.insert(key, Arc::new(entry));
                }
                Ok(None) => strays.push(Stray { id, problem: None }),
                Err(problem) => strays.push(Stray {
                    id,
                    problem: Some(problem),
                }),
            }
        }
        // Live records may have used generations past the file's floor; it
        // is raised now, as removing them would not raise it later.
        if unused > on_file {
            write_atomic(&path, format!("{unused}\n").as_bytes())?;
        }
        let records = Self {
            root,
            entries: Mutex::new(entries),
            locks: Arc::new(Locks {
                _root: lock,
                _host: host,
            }),
            generations: Arc::new(Generations {
                path,
                unused: Mutex::new(unused),
            }),
            #[cfg(test)]
            gate: Mutex::new(None),
        };
        Ok((records, strays))
    }

    /// Every record, in id order, as last written: a write whose fate is
    /// unknown may show here before it is durable. Only for reporting;
    /// anything that acts on a record takes it from [`Records::settle`].
    pub fn all(&self) -> Vec<Record> {
        let mut all: Vec<Record> = locked(&self.entries)
            .values()
            .filter_map(|entry| locked(&entry.current).clone())
            .collect();
        all.sort_by_key(|record| record.id);
        all
    }

    /// The record for `id` as last written, which, like [`Records::all`],
    /// may not be durable yet.
    pub fn get(&self, id: Id) -> Option<Record> {
        let entry = locked(&self.entries).get(&id.0).cloned()?;
        locked(&entry.current).clone()
    }

    /// The record for `id` as its file durably holds it: a write whose fate
    /// was unknown is made durable first, or this fails.
    pub async fn settle(&self, id: Id) -> Result<Record, StateError> {
        let entry = self.entry(id)?;
        self.exclusive(entry, move |slot| {
            slot.current().ok_or(StateError::NotFound(id))
        })
        .await
    }

    /// A share of the root's ownership; see [`Ownership`].
    pub fn ownership(&self) -> Ownership {
        Ownership {
            _locks: Arc::clone(&self.locks),
        }
    }

    /// Writes the first record of a new sandbox, which starts at a
    /// generation no earlier record on this host used.
    pub async fn insert(&self, mut record: Record) -> Result<Record, StateError> {
        let id = record.id;
        let host = record.host();
        let entry = Arc::clone(
            locked(&self.entries)
                .entry(id.0)
                .or_insert_with(|| Arc::new(Entry::new(host))),
        );
        if entry.host != host {
            return Err(StateError::Exists(id));
        }
        let generations = Arc::clone(&self.generations);
        self.exclusive(entry, move |slot| {
            if slot.current().is_some() {
                return Err(StateError::Exists(id));
            }
            record.generation = generations.unused();
            slot.write(Some(record.clone()))?;
            Ok(record)
        })
        .await
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
        self.exclusive(entry, move |slot| {
            let current = slot.current();
            match apply(id, current.as_ref(), expected, change)? {
                Some(next) => {
                    slot.write(Some(next.clone()))?;
                    Ok(next)
                }
                // Unchanged; `apply` saw that `current` exists.
                None => current.ok_or(StateError::NotFound(id)),
            }
        })
        .await
    }

    /// Gives the ready sandbox `ready`, still at `expected`, to a create:
    /// one write makes it sandbox `id` with `config`, no longer ready, and
    /// with a guest that has yet to learn which sandbox it is. Its
    /// directory keeps its name, which the record keeps as its host name.
    /// Like a new record it takes a generation no earlier record used, so
    /// one `id` had before never comes back with it. Returns the record now
    /// committed.
    ///
    /// The record answers to whichever id its file holds afterwards: `id`
    /// once the write landed, `ready` if it did not, and whatever the file
    /// says if its fate is unknown.
    pub async fn claim(
        &self,
        ready: Id,
        expected: Fence,
        id: Id,
        config: SandboxConfig,
    ) -> Result<Record, StateError> {
        let entry = {
            let mut entries = locked(&self.entries);
            if entries.contains_key(&id.0) {
                return Err(StateError::Exists(id));
            }
            let entry = entries
                .get(&ready.0)
                .cloned()
                .ok_or(StateError::NotFound(ready))?;
            // Both names lead to it while the write is under way.
            entries.insert(id.0, Arc::clone(&entry));
            entry
        };
        let generations = Arc::clone(&self.generations);
        let result = self
            .exclusive(Arc::clone(&entry), move |slot| {
                let current = slot.current().ok_or(StateError::NotFound(ready))?;
                let found = current.fence();
                if found != expected || !current.ready || current.id != ready {
                    return Err(StateError::Stale {
                        id: ready,
                        expected,
                        found,
                    });
                }
                let next = Record {
                    id,
                    host: Some(slot.host),
                    ready: false,
                    config,
                    identity: Identity::Pending,
                    generation: generations.unused().max(current.generation),
                    revision: current.revision + 1,
                    ..current
                };
                slot.write(Some(next.clone()))?;
                Ok(next)
            })
            .await;
        let held = locked(&entry.current).as_ref().map(|record| record.id);
        let mut entries = locked(&self.entries);
        for name in [ready, id] {
            if held != Some(name)
                && entries
                    .get(&name.0)
                    .is_some_and(|present| Arc::ptr_eq(present, &entry))
            {
                entries.remove(&name.0);
            }
        }
        result
    }

    /// Deletes the record for `id` if it is still at `expected`. The
    /// sandbox's directory stays; without a record it is a stray. Its
    /// generations are never used again.
    pub async fn remove(&self, id: Id, expected: Fence) -> Result<(), StateError> {
        let entry = self.entry(id)?;
        let generations = Arc::clone(&self.generations);
        self.exclusive(Arc::clone(&entry), move |slot| {
            let found = slot
                .current()
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
            generations.retire(found.generation)?;
            slot.write(None)
        })
        .await?;
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

    /// Runs `work` on the record of `entry` once all earlier work on it is
    /// done, after making a write whose fate was unknown durable. The work
    /// runs on a blocking thread that owns the record's lock and the
    /// root's, so it finishes even if the caller stops waiting, and nothing
    /// else touches the record or takes over the root meanwhile.
    async fn exclusive<T: Send + 'static>(
        &self,
        entry: Arc<Entry>,
        work: impl FnOnce(&Slot<'_>) -> Result<T, StateError> + Send + 'static,
    ) -> Result<T, StateError> {
        let writing = Arc::clone(&entry.writing).lock_owned().await;
        let path = Paths::new(&self.root, entry.host).record;
        let locks = Arc::clone(&self.locks);
        #[cfg(test)]
        let gate = locked(&self.gate).take();
        tokio::task::spawn_blocking(move || {
            let _held = (locks, writing);
            #[cfg(test)]
            if let Some(gate) = gate {
                let _ = gate.started.send(());
                let _ = gate.release.recv();
            }
            let slot = Slot {
                host: entry.host,
                path: &path,
                entry: &entry,
            };
            slot.reconcile()?;
            work(&slot)
        })
        .await
        .map_err(|error| StateError::Io(error.to_string()))?
    }
}

/// Opens `<root>/agent.lock` and takes an exclusive lock on it, retrying
/// until `wait` has passed.
fn lock_root(root: &Path, wait: Duration) -> Result<File, StateError> {
    create_root(root)?;
    lock_exclusive(&root.join(LOCK), wait)
}

/// Creates the state root, durably, in a parent that must exist already:
/// records are only as durable as every directory above them, and the
/// agent can vouch only for the entries it makes.
fn create_root(root: &Path) -> Result<(), StateError> {
    create_dir_durably(root).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            StateError::Io(format!(
                "the state root {} needs an existing parent directory",
                root.display()
            ))
        } else {
            error.into()
        }
    })
}

/// Takes the host's lock at `path` for the agent of state root `root`.
///
/// The lock file names the state root whose sandboxes hold the host's user
/// ids, networks and firewall rules. VMs outlive their agent, so an agent
/// of another root may take the host over only once the root named has no
/// sandbox left; until then it would hand out what those VMs still use. The
/// file belongs where the system clears it at boot, such as `/run`: no VM
/// outlives that.
pub(crate) fn claim_host(path: &Path, root: &Path, wait: Duration) -> Result<File, StateError> {
    use std::ffi::OsStr;
    use std::io::{Read, Seek, Write};
    use std::os::unix::ffi::OsStrExt;

    let mut file = lock_exclusive(path, wait)?;
    create_root(root)?;
    let root = fs::canonicalize(root)?;
    let mut named = Vec::new();
    file.read_to_end(&mut named)?;
    let owner = Path::new(OsStr::from_bytes(
        named.strip_suffix(b"\n").unwrap_or(&named),
    ));
    if owner == root {
        return Ok(file);
    }
    if !owner.as_os_str().is_empty() && has_sandboxes(owner)? {
        return Err(StateError::HostOwned(owner.to_owned()));
    }
    file.set_len(0)?;
    file.rewind()?;
    file.write_all(root.as_os_str().as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(file)
}

/// Whether any sandbox directory exists under state root `root`.
fn has_sandboxes(root: &Path) -> io::Result<bool> {
    match fs::read_dir(sandboxes_dir(root)) {
        Ok(mut entries) => Ok(entries.next().is_some()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// Takes an exclusive `flock` on `path` (created if missing), waiting up to
/// `wait` for another holder to let go. The lock lasts as long as the file.
fn lock_exclusive(path: &Path, wait: Duration) -> Result<File, StateError> {
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

/// Reads the record in sandbox directory `host`; `None` when there is
/// none.
fn read(path: &Path, host: Id) -> Result<Option<Record>, StateError> {
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
    if record.host() != host {
        return Err(corrupt(format!(
            "it names directory {}, not {host}",
            record.host()
        )));
    }
    Ok(Some(record))
}

#[cfg(test)]
mod tests;
