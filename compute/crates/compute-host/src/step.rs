//! Carrying out one step for one sandbox.
//!
//! The core guarantees at most one step per sandbox at a time, so a step
//! takes the sandbox's VM handle, owns it while it works and hands it back
//! when it finishes. No locks are needed around a VM.
//!
//! A step is issued against the sandbox's record as it was at that moment
//! and records what it did with compare-and-set writes against that
//! version, so a step that outlived its sandbox, or raced anything else
//! that changed the record, fails instead of overwriting newer state.
//!
//! Saving, restoring and moving memory images follow one rule: a copy of the
//! sandbox's newest state is deleted or replaced only after another copy has
//! been checked and found good, and a copy that fails a check is moved to
//! quarantine rather than deleted. Local images are checked by
//! [`Images::verify`]; the store's copy by [`Store::verify`]. Only a check
//! that proves a copy bad counts: a copy that could not be read for reasons
//! of the host's own (a full file table, a pager that did not start) is kept
//! and the step retried.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use compute_core::{Failure, Outcome, Step};
use compute_engine::{
    CancellationToken, Completion, Engine, EngineError, ErrorKind, MemoryProfile, MemorySource,
    RestoreFiles, SnapshotFiles, SnapshotKind, VmSpec,
};
use serde::{Deserialize, Serialize};

use crate::image::{Generation, Images, Parts, Suspect, Verified};
use crate::layout::{Paths, remove_durably, remove_if_present, write_atomic};
#[cfg(target_os = "linux")]
use crate::lazy::{ChunkSource, Fetcher, Hydration, Memory, Paging, WakeProfile};
use crate::protocol::Id;
use crate::restore_notice::tell_restored;
use crate::state::{Change, Disk, Record, Records, StateError};
use crate::store::{FetchInto, FetchedMemory, Receipt, SavedFiles, SavedImage, Store};

/// How long a restore waits for the guest to acknowledge the restore notice.
/// A guest that listens answers in about a millisecond.
const NOTICE_TIMEOUT: Duration = Duration::from_millis(250);

/// Longest a wake waits for its learned working set before resuming the
/// guest anyway; whatever is missing then arrives on demand.
const PREFETCH_LIMIT: Duration = Duration::from_secs(5);

/// What the VM's memory equals, page for page, apart from what it changed
/// since: what a diff snapshot is relative to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Base {
    /// All zeros: a VM booted fresh.
    Zero,
    /// A published image generation.
    Image(Generation),
    /// Unknown, for example after a failed snapshot or merge: the next
    /// snapshot must hold every page.
    Unknown,
}

/// What backs a live VM's memory.
#[derive(Debug)]
pub(crate) struct LiveMemory {
    pub base: Base,
    /// The pager thread serving its memory, if a pager does.
    #[cfg(target_os = "linux")]
    pub paging: Option<Paging>,
}

impl LiveMemory {
    pub fn booted() -> Self {
        Self {
            base: Base::Zero,
            #[cfg(target_os = "linux")]
            paging: None,
        }
    }

    /// A VM found running after an agent restart: what its memory is based
    /// on is unknown.
    pub fn adopted() -> Self {
        Self {
            base: Base::Unknown,
            #[cfg(target_os = "linux")]
            paging: None,
        }
    }

    /// Resolves if the VM's memory can no longer be served, so the VM must
    /// be stopped.
    pub fn failed(&self) -> impl Future<Output = ()> + Send + 'static {
        #[cfg(target_os = "linux")]
        if let Some(paging) = &self.paging {
            return futures::future::Either::Left(paging.failed());
        }
        futures::future::Either::Right(std::future::pending())
    }

    /// For a VM that has ended and whose files are about to be deleted:
    /// stops serving and fetching its memory and returns once nothing more
    /// will be written for it.
    pub async fn close(self) {
        #[cfg(target_os = "linux")]
        if let Some(paging) = &self.paging {
            paging.close().await;
        }
    }
}

/// A VM process the host owns.
#[derive(Debug)]
pub(crate) struct Live<V> {
    pub vm: V,
    /// Distinguishes this VM process from earlier ones of the same sandbox,
    /// so a late exit notice from an old process is never blamed on a new one.
    pub incarnation: u64,
    /// Set before the host stops the VM on purpose, so its exit is not
    /// reported as a crash.
    pub stopping: Arc<AtomicBool>,
    pub memory: LiveMemory,
}

/// What a step leaves behind.
#[derive(Debug)]
pub(crate) enum After<V> {
    /// No VM process.
    NoVm,
    /// The VM the step was given.
    Kept(Live<V>),
    /// A VM process the step started.
    New(V, LiveMemory),
}

/// Which stored copy matches the local files. The record says whether an
/// archived copy exists; this names it, so eviction can check the store
/// still holds exactly that copy.
#[derive(Debug, Serialize, Deserialize)]
struct Archived {
    receipt: Receipt,
    memory: bool,
}

/// Everything one step needs.
pub(crate) struct Job<E: Engine, S> {
    pub engine: Arc<E>,
    pub store: Arc<S>,
    pub records: Arc<Records>,
    /// The sandbox's record when the step was issued, then as the step
    /// last committed it.
    pub record: Record,
    pub id: Id,
    pub spec: VmSpec,
    pub paths: Paths,
    pub cancel: CancellationToken,
    pub live: Option<Live<E::Vm>>,
    /// Guest port to tell about a restore, if any.
    pub restore_notice_port: Option<u32>,
    /// The image new sandboxes' disks are copied from, which a fetched
    /// disk probably still mostly matches.
    pub base_image: PathBuf,
    /// Fetches remote memory for every VM on the host, when the store keeps
    /// memory as chunks.
    #[cfg(target_os = "linux")]
    pub fetcher: Option<Arc<Fetcher>>,
}

fn failure(error: &EngineError) -> Outcome {
    tracing::warn!(%error, "step failed");
    Outcome::Failed(match error.kind {
        ErrorKind::Transient => Failure::Transient,
        ErrorKind::MemoryLost => Failure::MemoryLost,
        ErrorKind::Fatal => Failure::Fatal,
    })
}

fn io_failure(operation: &'static str, error: io::Error) -> Outcome {
    failure(&EngineError::io(operation, error))
}

/// What failing to record a step's effect means for the sandbox.
fn state_failure(error: &StateError) -> Outcome {
    if let StateError::Io(_) = error {
        tracing::warn!(%error, "step could not record its effect");
        Outcome::Failed(Failure::Transient)
    } else {
        tracing::error!(%error, "step refused: the sandbox's record moved on");
        Outcome::Failed(Failure::Fatal)
    }
}

fn suspect_error(operation: &'static str, suspect: Suspect) -> EngineError {
    match suspect {
        Suspect::Io(error) => EngineError::io(operation, error),
        suspect => EngineError::caused_by(ErrorKind::MemoryLost, operation, suspect),
    }
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> io::Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(io::Error::other)
}

/// The sandbox's memory images.
pub(crate) fn images_of(paths: &Paths) -> Images {
    Images::new(paths.dir.join("images"))
}

/// The learned order the guest touches memory after a wake.
fn wake_profile(paths: &Paths) -> PathBuf {
    paths.dir.join("wake-profile.json")
}

/// Names the stored copy the record's `archived` flag refers to.
fn archive_receipt(paths: &Paths) -> PathBuf {
    paths.dir.join("archive.json")
}

/// Present while the sandbox's VM has its memory served by this agent's
/// pager.
fn paged_marker(paths: &Paths) -> PathBuf {
    paths.dir.join("paged")
}

/// Whether the sandbox's last VM had its memory served by a pager, which
/// does not outlive the agent that ran it.
pub(crate) fn paged(paths: &Paths) -> bool {
    paged_marker(paths).exists()
}

/// What serves `image`'s memory to a pager: the local file, or the store
/// with the file filling in behind, fetching `first` (image offsets) first.
#[cfg(target_os = "linux")]
fn served_memory(
    images: &Images,
    image: &Verified,
    fetcher: Option<&Arc<Fetcher>>,
    first: &[u64],
) -> Result<(Memory, Option<Arc<Hydration>>), EngineError> {
    const OP: &str = "restore";
    let io = |error| EngineError::io(OP, error);
    let generation = image.generation();
    if !image.meta().remote {
        let file = fs::File::open(images.memory(generation)).map_err(io)?;
        // SAFETY: published images are sealed read-only and never
        // modified; a new save always writes a new generation.
        let mapped = unsafe { compute_pager::MappedFile::new(&file) }.map_err(io)?;
        return Ok((Memory::Local(mapped), None));
    }
    let Some(fetcher) = fetcher else {
        return Err(EngineError::new(
            ErrorKind::MemoryLost,
            OP,
            "the memory image is in a store this host cannot page from",
        ));
    };
    let manifest = fs::read(images.remote(generation)).map_err(io)?;
    let manifest = compute_storage::manifest::DiskManifest::decode(&manifest)
        .map_err(|error| EngineError::caused_by(ErrorKind::MemoryLost, OP, error))?;
    let refs = crate::chunked::chunk_refs(&manifest).ok_or_else(|| {
        EngineError::new(ErrorKind::MemoryLost, OP, "memory manifest not in chunks")
    })?;
    let hashes = images.chunk_map(image).map_err(io)?.0;
    let hydration = Hydration::start(
        Arc::clone(fetcher),
        &images.memory(generation),
        refs,
        hashes,
        first,
    )
    .map_err(io)?;
    let source = ChunkSource::new(Arc::clone(&hydration)).map_err(io)?;
    Ok((Memory::Remote(source), Some(hydration)))
}

/// Takes over serving the memory of `vm`, a VM found running after an
/// agent restart whose pager went with the previous agent. Its guest has
/// been waiting on any page it touched since; it goes on once a new pager
/// serves them. The pages come from the sandbox's current image: every
/// image published since the VM was restored is its restore image with
/// the pages the guest changed merged in, so the pages it has not touched
/// read the same in each.
#[cfg(target_os = "linux")]
pub(crate) async fn take_over_paging<E: Engine>(
    engine: &E,
    vm: &E::Vm,
    paths: &Paths,
    fetcher: Option<&Arc<Fetcher>>,
) -> Result<LiveMemory, EngineError> {
    const OP: &str = "take over paging";
    let images = images_of(paths);
    let marker = paged_marker(paths);
    let (regions, image) = blocking(move || {
        let layout = fs::read(&marker).map_err(|error| EngineError::io(OP, error))?;
        let regions: Vec<compute_pager::Mapping> =
            serde_json::from_slice(&layout).map_err(|_| {
                EngineError::new(
                    ErrorKind::MemoryLost,
                    OP,
                    "the VMM never connected to its pager",
                )
            })?;
        let image = images
            .current_verified()
            .map_err(|suspect| suspect_error(OP, suspect))?
            .ok_or_else(|| EngineError::new(ErrorKind::MemoryLost, OP, "no memory image"))?;
        Ok::<_, EngineError>((regions, image))
    })
    .await
    .map_err(|error| EngineError::io(OP, error))??;
    let (memory, hydration) = served_memory(&images_of(paths), &image, fetcher, &[])?;
    let handed = engine.paged_memory(vm)?;
    let paging = Paging::adopt(handed, regions, memory, hydration)
        .map_err(|error| EngineError::io(OP, error))?;
    Ok(LiveMemory {
        base: Base::Unknown,
        paging: Some(paging),
    })
}

/// The files a diff snapshot is written to, inside the jail.
fn diff_files(paths: &Paths) -> SnapshotFiles {
    SnapshotFiles {
        state: paths.in_jail("save.state"),
        memory: paths.in_jail("save.mem"),
    }
}

/// Makes the sandbox's images consistent after a host restart and reports
/// whether a good current image exists.
pub(crate) fn recover_images(paths: &Paths) -> bool {
    match images_of(paths).recover() {
        Ok(current) => current.is_some(),
        Err(error) => {
            tracing::error!(dir = %paths.dir.display(), %error, "could not check memory images");
            false
        }
    }
}

/// Points `link` at `target` with a hard link, replacing what was there.
fn link(target: &Path, link: &Path) -> io::Result<()> {
    remove_if_present(link)?;
    fs::hard_link(target, link)
}

impl<E: Engine, S: Store> Job<E, S> {
    /// Runs `step` and reports how it went and what VM remains. A step that
    /// lost the VM's memory leaves no VM process: it is ended before the
    /// step reports, since the core may start a replacement on the same disk
    /// right after.
    pub async fn run(mut self, step: Step) -> (Outcome, After<E::Vm>) {
        let (outcome, after) = self.step(step).await;
        if outcome != Outcome::Failed(Failure::MemoryLost) {
            return (outcome, after);
        }
        // The memory (and any pager serving it) goes only after the process.
        let (vm, _memory) = match after {
            After::NoVm => return (outcome, After::NoVm),
            After::Kept(live) => {
                live.stopping.store(true, Ordering::Release);
                (live.vm, live.memory)
            }
            After::New(vm, memory) => (vm, memory),
        };
        (self.end(vm, outcome).await, After::NoVm)
    }

    async fn step(&mut self, step: Step) -> (Outcome, After<E::Vm>) {
        if self.cancel.is_cancelled() {
            return (
                Outcome::Cancelled,
                self.live.take().map_or(After::NoVm, After::Kept),
            );
        }
        match step {
            Step::Pause | Step::Resume | Step::Compress | Step::Save | Step::Drop => {
                let Some(live) = self.live.take() else {
                    // The VM vanished between the decision and the step; the
                    // exit notice is on its way.
                    return (Outcome::Failed(Failure::MemoryLost), After::NoVm);
                };
                match step {
                    Step::Pause => self.simple(self.engine.pause(&live.vm).await, live),
                    Step::Resume => self.resume(live).await,
                    Step::Compress => self.compress(live).await,
                    Step::Save => self.save(live).await,
                    _ => self.end_process(live).await,
                }
            }
            Step::Restore => self.restore().await,
            Step::Boot => self.boot().await,
            // A paused VM stays as it is while its saved copy is archived.
            Step::Archive => {
                let outcome = self.archive().await;
                (outcome, self.live.take().map_or(After::NoVm, After::Kept))
            }
            Step::Evict => (self.evict().await, After::NoVm),
            Step::Fetch => (self.fetch().await, After::NoVm),
            Step::Forget => {
                let outcome = self.forget().await;
                (outcome, self.live.take().map_or(After::NoVm, After::Kept))
            }
        }
    }

    /// Records `change` against the version this step last saw.
    async fn commit(&mut self, change: Change) -> Result<(), StateError> {
        self.record = self
            .records
            .commit(self.id, self.record.fence(), change)
            .await?;
        Ok(())
    }

    #[allow(clippy::unused_self)]
    fn simple(
        &self,
        result: Result<(), EngineError>,
        live: Live<E::Vm>,
    ) -> (Outcome, After<E::Vm>) {
        let outcome = result.map_or_else(|error| failure(&error), |()| Outcome::Done);
        (outcome, After::Kept(live))
    }

    /// Resumes a paused VM. A saved copy of it goes stale the moment the
    /// guest runs and its disk moves on, so it is unmarked first, and marked
    /// again if the resume was refused: the guest never ran, and the core
    /// counts on a transient failure having changed nothing.
    async fn resume(&mut self, live: Live<E::Vm>) -> (Outcome, After<E::Vm>) {
        // The image stays on disk as the base the VM's next save is a diff
        // against; only the record stops vouching for it.
        let (image, archived) = (self.record.image, self.record.archived);
        if (image || archived)
            && let Err(error) = self
                .commit(Change::new().image(false).archived(false))
                .await
        {
            return (state_failure(&error), After::Kept(live));
        }
        let outcome = match self.engine.resume(&live.vm).await {
            Ok(()) => Outcome::Done,
            Err(error) => self.after_failed_wake(&error, image, archived).await,
        };
        (outcome, After::Kept(live))
    }

    /// The outcome of a wake that failed after the record stopped vouching
    /// for the saved copy (`image`, `archived`). A refused wake never ran
    /// the guest, so the record vouches for the copy again; if it cannot,
    /// the core can no longer count on nothing having changed and is told
    /// the copy is untrusted. After any other failure the guest may have
    /// run, so the copy stays unvouched.
    async fn after_failed_wake(
        &mut self,
        error: &EngineError,
        image: bool,
        archived: bool,
    ) -> Outcome {
        if error.kind != ErrorKind::Transient || !(image || archived) {
            return failure(error);
        }
        match self
            .commit(Change::new().image(image).archived(archived))
            .await
        {
            Ok(()) => failure(error),
            Err(lost) => {
                tracing::error!(id = %self.id, error = %lost, "saved copy not vouched for again after a refused wake");
                Outcome::Failed(Failure::Untrusted)
            }
        }
    }

    async fn compress(&self, live: Live<E::Vm>) -> (Outcome, After<E::Vm>) {
        let outcome = match self.engine.compress(&live.vm, &self.cancel).await {
            Ok(Completion::Finished) => Outcome::Done,
            // Partly compressed is still a valid paused VM.
            Ok(Completion::Cancelled) => Outcome::Cancelled,
            Err(error) => failure(&error),
        };
        (outcome, After::Kept(live))
    }

    /// Writes the pages that changed and merges them offline into a new
    /// self-contained image, which becomes valid and the base of the VM's
    /// next save. The VM stays paused in memory, so a wake still only has to
    /// resume it; the image lets memory pressure end the process instantly
    /// and survives the process crashing. A wake that arrives during the
    /// save cancels it.
    async fn save(&mut self, mut live: Live<E::Vm>) -> (Outcome, After<E::Vm>) {
        // A live VM's record never vouches for an image; this is a guard.
        if self.record.image
            && let Err(error) = self.commit(Change::new().image(false)).await
        {
            return (state_failure(&error), After::Kept(live));
        }
        match self.write_image(&mut live).await {
            Ok(image) => {
                if self.cancel.is_cancelled() {
                    // The image matches this paused VM but goes stale the
                    // moment it resumes; it is not marked saved.
                    return (Outcome::Cancelled, After::Kept(live));
                }
                let valid = Change::new().image(true).archived(false);
                if let Err(error) = self.commit(valid).await {
                    return (state_failure(&error), After::Kept(live));
                }
                // The new image is good: older ones may go. The VM maps
                // only the new one's content from now on.
                let images = images_of(&self.paths);
                if let Err(error) = blocking(move || images.retire(&image, &[]))
                    .await
                    .and_then(|r| r)
                {
                    tracing::warn!(id = %self.id, %error, "old memory images not removed");
                }
            }
            Err(error) => {
                live.memory.base = Base::Unknown;
                return (failure(&error), After::Kept(live));
            }
        }
        (Outcome::Done, After::Kept(live))
    }

    /// Ends the VM process of a paused VM whose current state is saved, which
    /// frees all of its memory at once and loses nothing.
    async fn end_process(&self, live: Live<E::Vm>) -> (Outcome, After<E::Vm>) {
        if !self.record.image {
            // The core only drops a VM with a current copy; ending this one
            // would lose its running programs.
            tracing::error!(id = %self.id, "no saved copy to fall back on; keeping the VM");
            return (Outcome::Failed(Failure::Fatal), After::Kept(live));
        }
        live.stopping.store(true, Ordering::Release);
        (self.end(live.vm, Outcome::Done).await, After::NoVm)
    }

    /// Snapshots the paused VM and publishes the result as a new image
    /// generation, which becomes the VM's base.
    async fn write_image(&self, live: &mut Live<E::Vm>) -> Result<Verified, EngineError> {
        const OP: &str = "save";
        let images = images_of(&self.paths);
        // A lazily woken VM's image must be whole before a diff can be
        // merged over it.
        #[cfg(target_os = "linux")]
        if let (Base::Image(generation), Some(hydration)) = (
            live.memory.base,
            live.memory
                .paging
                .as_ref()
                .and_then(|paging| paging.hydration.clone()),
        ) {
            hydration.finished().await.map_err(|why| {
                let kind = if why.permanent {
                    ErrorKind::MemoryLost
                } else {
                    ErrorKind::Transient
                };
                EngineError::caused_by(kind, OP, why)
            })?;
            let images = images.clone();
            blocking(move || {
                let image = images.verify(generation, crate::image::Depth::Light)?;
                if image.meta().remote {
                    images.mark_local(&image)?;
                }
                Ok::<_, Suspect>(())
            })
            .await
            .map_err(|error| EngineError::io(OP, error))?
            .map_err(|suspect| suspect_error(OP, suspect))?;
        }
        let base = live.memory.base;
        let kind = if base == Base::Unknown {
            SnapshotKind::Full
        } else {
            SnapshotKind::Diff
        };
        let files = diff_files(&self.paths);
        let started = Instant::now();
        // From here on the VM's dirty pages are being reset: any failure
        // leaves its base unknown.
        live.memory.base = Base::Unknown;
        self.engine.snapshot(&live.vm, &files, kind).await?;
        let snapshot = started.elapsed();
        let published = blocking(move || {
            let parts = match base {
                Base::Image(generation) if kind == SnapshotKind::Diff => Parts::Diff {
                    base: generation,
                    state: &files.state,
                    diff: &files.memory,
                },
                // A diff over zeros, or a full snapshot, is already whole.
                _ => Parts::Whole {
                    state: &files.state,
                    memory: &files.memory,
                },
            };
            let published = images.publish(parts);
            if published.is_err() {
                let _ = remove_if_present(&files.state);
                let _ = remove_if_present(&files.memory);
            }
            published
        })
        .await
        .map_err(|error| EngineError::io(OP, error))?
        .map_err(|suspect| suspect_error(OP, suspect))?;
        tracing::debug!(
            id = %self.id,
            ?kind,
            snapshot_ms = snapshot.as_millis(),
            merge_ms = started.elapsed().saturating_sub(snapshot).as_millis(),
            generation = %published.generation(),
            "memory image saved"
        );
        live.memory.base = Base::Image(published.generation());
        Ok(published)
    }

    /// Starts from the saved image, marks the image stale before the guest
    /// runs, then resumes.
    async fn restore(&mut self) -> (Outcome, After<E::Vm>) {
        const OP: &str = "restore";
        if !self.record.image || self.record.disk != Disk::Local {
            return (Outcome::Failed(Failure::MemoryLost), After::NoVm);
        }
        let started = Instant::now();
        let images = images_of(&self.paths);
        let checked = {
            let images = images.clone();
            blocking(move || images.current_verified()).await
        };
        let image = match checked {
            Ok(Ok(Some(image))) => image,
            Ok(Ok(None)) => {
                let _ = self.commit(Change::new().image(false)).await;
                return (Outcome::Failed(Failure::MemoryLost), After::NoVm);
            }
            Ok(Err(suspect)) => {
                self.quarantine_current(&images, &suspect).await;
                return (failure(&suspect_error(OP, suspect)), After::NoVm);
            }
            Err(error) => return (io_failure(OP, error), After::NoVm),
        };
        let verified = started.elapsed();
        let (memory, live_memory) = match self.memory_source(&images, &image) {
            Ok(prepared) => prepared,
            Err(error) => return (failure(&error), After::NoVm),
        };
        let source = match &memory {
            MemorySource::File(_) => "file",
            MemorySource::Pager(_) if image.meta().remote => "remote",
            MemorySource::Pager(_) => "pager",
        };
        let files = RestoreFiles {
            state: self.paths.snapshot.state.clone(),
            memory,
        };
        let vm = match self.engine.restore(&self.spec, &files).await {
            Ok(vm) => vm,
            Err(error) if error.kind == ErrorKind::MemoryLost => {
                let outcome = self.rejected(&images, &image, &live_memory, &error).await;
                return (outcome, After::NoVm);
            }
            Err(error) => return (failure(&error), After::NoVm),
        };
        let loaded = started.elapsed();
        let archived = self.record.archived;
        let running = Change::new().image(false).archived(false).execution();
        if let Err(error) = self.commit(running).await {
            return (self.end(vm, state_failure(&error)).await, After::NoVm);
        }
        let committed = started.elapsed();
        #[cfg(target_os = "linux")]
        if let Some(paging) = &live_memory.paging {
            paging.prefetched(PREFETCH_LIMIT).await;
        }
        let prefetched = started.elapsed();
        if let Err(error) = self.engine.resume(&vm).await {
            // The VM ends before the image is reconsidered, so no second
            // process ever runs from the same files.
            let ended = self.end(vm, Outcome::Done).await;
            if ended != Outcome::Done {
                return (ended, After::NoVm);
            }
            return (
                self.after_failed_wake(&error, true, archived).await,
                After::NoVm,
            );
        }
        let resumed = started.elapsed();
        self.tell_guest_restored().await;
        tracing::debug!(
            id = %self.id,
            source,
            verify_ms = verified.as_millis(),
            load_ms = loaded.saturating_sub(verified).as_millis(),
            commit_ms = committed.saturating_sub(loaded).as_millis(),
            prefetch_ms = prefetched.saturating_sub(committed).as_millis(),
            resume_ms = resumed.saturating_sub(prefetched).as_millis(),
            notice_ms = started.elapsed().saturating_sub(resumed).as_millis(),
            "memory image restored"
        );
        (Outcome::Done, After::New(vm, live_memory))
    }

    /// Decides what the VMM refusing to load `image` means. The image is
    /// given up only when it is proven bad: a local image that fails the
    /// deep check goes to quarantine, and a remote image whose store copy
    /// is bad or gone is dropped. Otherwise the refusal was the host's (a
    /// pager that could not start or could not reach the store, say) and
    /// the image is kept for a retry.
    async fn rejected(
        &mut self,
        images: &Images,
        image: &Verified,
        memory: &LiveMemory,
        error: &EngineError,
    ) -> Outcome {
        const OP: &str = "restore";
        tracing::warn!(id = %self.id, %error, "the VMM refused the memory image");
        if image.meta().remote {
            #[cfg(target_os = "linux")]
            let lost = memory
                .paging
                .as_ref()
                .and_then(|paging| paging.hydration.as_ref())
                .and_then(|hydration| hydration.failure())
                .filter(|why| why.permanent);
            #[cfg(not(target_os = "linux"))]
            let lost: Option<String> = {
                let _ = memory;
                None
            };
            if let Some(why) = lost {
                if let Err(error) = self.commit(Change::new().image(false)).await {
                    return state_failure(&error);
                }
                return failure(&EngineError::caused_by(ErrorKind::MemoryLost, OP, why));
            }
            return failure(&EngineError::new(
                ErrorKind::Transient,
                OP,
                error.to_string(),
            ));
        }
        let checked = {
            let images = images.clone();
            let generation = image.generation();
            blocking(move || images.verify(generation, crate::image::Depth::Deep)).await
        };
        match checked {
            Ok(Ok(_)) => {
                tracing::warn!(
                    id = %self.id,
                    "the refused image passes every check; keeping it and trying again"
                );
                failure(&EngineError::new(
                    ErrorKind::Transient,
                    OP,
                    error.to_string(),
                ))
            }
            Ok(Err(Suspect::Io(error))) | Err(error) => io_failure(OP, error),
            Ok(Err(suspect)) => {
                self.quarantine_current(images, &suspect).await;
                failure(&suspect_error(OP, suspect))
            }
        }
    }

    /// Links `image` into the jail and decides how the VM's memory is
    /// served: mapped straight from the file where the profile allows,
    /// otherwise through a pager, fetching from the store if the image's
    /// memory is still there.
    fn memory_source(
        &self,
        images: &Images,
        image: &Verified,
    ) -> Result<(MemorySource, LiveMemory), EngineError> {
        const OP: &str = "restore";
        let paths = &self.paths;
        let generation = image.generation();
        let io = |error| EngineError::io(OP, error);
        link(&images.state(generation), &paths.snapshot.state).map_err(io)?;
        let profile: MemoryProfile = self.engine.memory_profile();
        let mut live = LiveMemory {
            base: Base::Image(generation),
            #[cfg(target_os = "linux")]
            paging: None,
        };
        if !image.meta().remote && !profile.needs_pager() {
            link(&images.memory(generation), &paths.snapshot.memory).map_err(io)?;
            remove_durably(&paged_marker(paths)).map_err(io)?;
            return Ok((MemorySource::File(paths.snapshot.memory.clone()), live));
        }
        #[cfg(target_os = "linux")]
        {
            // Written before the VMM can depend on the pager, so an agent
            // that restarts knows the VM's memory needs a pager. The pager
            // fills in the memory layout once the VMM has connected; until
            // then a restarted agent cannot take the VM over.
            write_atomic(&paged_marker(paths), b"").map_err(io)?;
            let socket = paths.in_jail("uffd.sock");
            let learned = wake_profile(paths);
            let wake = WakeProfile::load(&learned);
            let (memory, hydration) =
                served_memory(images, image, self.fetcher.as_ref(), &wake.offsets)?;
            live.paging = Some(
                Paging::start(
                    &socket,
                    memory,
                    hydration,
                    wake,
                    learned,
                    paged_marker(paths),
                )
                .map_err(io)?,
            );
            Ok((MemorySource::Pager(socket), live))
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = live;
            Err(EngineError::new(
                ErrorKind::Fatal,
                OP,
                "paged memory needs Linux",
            ))
        }
    }

    /// Moves the current image aside for inspection and records that the
    /// sandbox has no usable memory image. A failure to read the image is
    /// no verdict on it: the image is kept.
    async fn quarantine_current(&mut self, images: &Images, suspect: &Suspect) {
        if let Suspect::Io(error) = suspect {
            tracing::warn!(id = %self.id, %error, "memory image unreadable for now; keeping it");
            return;
        }
        if let Ok(Some(generation)) = images.current()
            && let Err(error) = images.quarantine(generation, suspect)
        {
            tracing::error!(id = %self.id, %error, "could not quarantine a bad image");
        }
        if let Err(error) = self.commit(Change::new().image(false)).await {
            tracing::error!(id = %self.id, %error, "could not record a lost image");
        }
    }

    /// Ends a VM process this step started and reports `outcome`, or a fatal
    /// failure if the process would not end: without proof that it did,
    /// nothing may replace it.
    async fn end(&self, vm: E::Vm, outcome: Outcome) -> Outcome {
        match self.engine.stop(vm).await {
            Ok(()) => outcome,
            Err(error) => {
                tracing::error!(id = %self.id, %error, "a VM process would not end");
                Outcome::Failed(Failure::Fatal)
            }
        }
    }

    /// Lets the guest fix its clock and drop dead connections before the
    /// sandbox counts as awake. Failing to is not fatal: a guest without an
    /// agent still runs, just with a stale clock.
    async fn tell_guest_restored(&self) {
        let Some(port) = self.restore_notice_port else {
            return;
        };
        let started = Instant::now();
        match tell_restored(&self.spec.vsock_path(), port, NOTICE_TIMEOUT).await {
            Ok(()) => tracing::debug!(
                id = %self.id,
                us = started.elapsed().as_micros(),
                "guest acknowledged the restore"
            ),
            Err(error) => tracing::warn!(id = %self.id, %error, "guest not told of its restore"),
        }
    }

    /// Boot fresh from the disk; any old memory image is meaningless now.
    async fn boot(&mut self) -> (Outcome, After<E::Vm>) {
        let fresh = Change::new().image(false).archived(false).execution();
        if let Err(error) = self.commit(fresh).await {
            return (state_failure(&error), After::NoVm);
        }
        drop_snapshot(&self.paths);
        match self.engine.boot(&self.spec).await {
            Ok(vm) => (Outcome::Done, After::New(vm, LiveMemory::booted())),
            Err(error) => (failure(&error), After::NoVm),
        }
    }

    async fn archive(&mut self) -> Outcome {
        const OP: &str = "archive";
        let images = images_of(&self.paths);
        let image = self.record.image;
        let checked = blocking(move || -> Result<_, Suspect> {
            if !image {
                return Ok(None);
            }
            let Some(image) = images.current_verified()? else {
                return Ok(None);
            };
            let chunks = images.chunk_map(&image)?;
            Ok(Some((image, chunks)))
        })
        .await;
        let memory = match checked {
            Ok(Ok(memory)) => memory,
            Ok(Err(suspect)) => {
                self.quarantine_current(&images_of(&self.paths), &suspect)
                    .await;
                return failure(&suspect_error(OP, suspect));
            }
            Err(error) => return io_failure(OP, error),
        };
        let images = images_of(&self.paths);
        if memory
            .as_ref()
            .is_some_and(|(image, _)| image.meta().remote)
        {
            // Fetched but never woken: the store already holds this image.
            return match self.archived_copy_holds().await {
                Ok(true) => match self.commit(Change::new().archived(true)).await {
                    Ok(()) => Outcome::Done,
                    Err(error) => state_failure(&error),
                },
                Ok(false) => failure(&EngineError::new(
                    ErrorKind::Fatal,
                    OP,
                    "memory image is only partly local and the store no longer holds it",
                )),
                Err(error) => failure(&error),
            };
        }
        let profile = wake_profile(&self.paths);
        let files = SavedFiles {
            disk: self.paths.disk.clone(),
            memory: memory.as_ref().map(|(image, chunks)| SavedImage {
                state: images.state(image.generation()),
                memory: images.memory(image.generation()),
                chunks: Some(Arc::new(chunks.0.clone())),
            }),
            profile: profile.exists().then_some(profile),
        };
        let receipt = match self.store.archive(self.id, &files).await {
            Ok(receipt) => receipt,
            Err(error) => return failure(&error),
        };
        let marker = Archived {
            receipt,
            memory: files.memory.is_some(),
        };
        let written = serde_json::to_vec(&marker)
            .map_err(io::Error::other)
            .and_then(|bytes| write_atomic(&archive_receipt(&self.paths), &bytes));
        if let Err(error) = written {
            return io_failure(OP, error);
        }
        match self.commit(Change::new().archived(true)).await {
            Ok(()) => Outcome::Done,
            Err(error) => state_failure(&error),
        }
    }

    /// Whether the store still holds the copy the archive receipt names.
    async fn archived_copy_holds(&self) -> Result<bool, EngineError> {
        let Ok(bytes) = fs::read(archive_receipt(&self.paths)) else {
            return Ok(false);
        };
        let Ok(marker) = serde_json::from_slice::<Archived>(&bytes) else {
            return Ok(false);
        };
        self.store.verify(self.id, &marker.receipt).await
    }

    /// Deletes the local copy, but only once the store is confirmed to hold
    /// exactly the copy that was archived from it. The disk is recorded as
    /// remote first: a crash in between leaves files nothing relies on,
    /// never a record that relies on deleted files.
    async fn evict(&mut self) -> Outcome {
        const OP: &str = "evict";
        let holds = if self.record.archived {
            self.archived_copy_holds().await
        } else {
            Ok(false)
        };
        match holds {
            Ok(true) => {}
            Ok(false) => {
                // The local files may be the only good copy: keep them, and
                // forget the archive so the next one starts afresh.
                if self.record.archived {
                    let _ = self.commit(Change::new().archived(false)).await;
                }
                return failure(&EngineError::new(
                    ErrorKind::Fatal,
                    OP,
                    "the store does not hold the archived copy; keeping the local one",
                ));
            }
            Err(error) => return failure(&error),
        }
        if let Err(error) = self.commit(Change::new().disk(Disk::Remote)).await {
            return state_failure(&error);
        }
        let paths = self.paths.clone();
        let removed = blocking(move || {
            remove_if_present(&paths.disk)?;
            remove_if_present(&paths.snapshot.state)?;
            remove_if_present(&paths.snapshot.memory)?;
            remove_if_present(&paged_marker(&paths))?;
            images_of(&paths).clear()
        })
        .await
        .and_then(|removed| removed);
        match removed {
            Ok(()) => Outcome::Done,
            Err(error) => io_failure(OP, error),
        }
    }

    /// Brings the stored copy back: the disk and device state whole, memory
    /// left in the store where it can be paged in, as a new image.
    async fn fetch(&mut self) -> Outcome {
        const OP: &str = "fetch";
        let paths = self.paths.clone();
        let scratch = paths.dir.join("fetching");
        let _ = fs::remove_dir_all(&scratch);
        let into = FetchInto {
            disk: paths.disk.clone(),
            scratch: scratch.clone(),
            profile: wake_profile(&paths),
            memory: self.record.image,
            seed: Some(self.base_image.clone()),
        };
        let fetched = match self.store.fetch(self.id, &into).await {
            Ok(fetched) => fetched,
            Err(error) => {
                let _ = fs::remove_dir_all(&scratch);
                return failure(&error);
            }
        };
        let images = images_of(&paths);
        let published = blocking(move || {
            let published = match &fetched {
                FetchedMemory::None => images.clear().map_err(Suspect::from).map(|()| None),
                FetchedMemory::Local { state, memory } => {
                    images.publish(Parts::Whole { state, memory }).map(Some)
                }
                FetchedMemory::Remote {
                    state,
                    memory_len,
                    chunks,
                    manifest,
                } => images
                    .publish(Parts::Remote {
                        state,
                        memory_len: *memory_len,
                        chunks: crate::image::ChunkMap(chunks.clone()),
                        manifest,
                    })
                    .map(Some),
            };
            let _ = fs::remove_dir_all(&scratch);
            published
        })
        .await;
        let outcome = match published {
            Ok(Ok(Some(image))) => {
                let images = images_of(&paths);
                if let Err(error) = images.retire(&image, &[]) {
                    tracing::warn!(id = %self.id, %error, "old memory images not removed");
                }
                Outcome::Done
            }
            Ok(Ok(None)) => Outcome::Done,
            Ok(Err(suspect)) => failure(&suspect_error(OP, suspect)),
            Err(error) => io_failure(OP, error),
        };
        if outcome != Outcome::Done {
            return outcome;
        }
        match self.commit(Change::new().disk(Disk::Local)).await {
            Ok(()) => Outcome::Done,
            Err(error) => state_failure(&error),
        }
    }

    /// Deletes the memory image here and in the store, keeping the files.
    /// The image is unmarked first, so a crash part-way never claims an
    /// image that is gone.
    async fn forget(&mut self) -> Outcome {
        const OP: &str = "forget";
        if self.record.image
            && let Err(error) = self.commit(Change::new().image(false)).await
        {
            return state_failure(&error);
        }
        // A paused VM loses the base its next diff would be merged over.
        if let Some(live) = self.live.as_mut() {
            live.memory.base = Base::Unknown;
        }
        let paths = self.paths.clone();
        let cleared = blocking(move || {
            remove_if_present(&paths.snapshot.state)?;
            remove_if_present(&paths.snapshot.memory)?;
            images_of(&paths).clear()
        })
        .await
        .and_then(|cleared| cleared);
        if let Err(error) = cleared {
            return io_failure(OP, error);
        }
        if !self.record.archived {
            return Outcome::Done;
        }
        // Until the new receipt is written, the old one no longer matches
        // the store, so nothing evicts against a copy in flux.
        let receipt = match self.store.forget_memory(self.id).await {
            Ok(Some(receipt)) => receipt,
            Ok(None) => {
                return match self.commit(Change::new().archived(false)).await {
                    Ok(()) => Outcome::Done,
                    Err(error) => state_failure(&error),
                };
            }
            Err(error) => return failure(&error),
        };
        let marker = Archived {
            receipt,
            memory: false,
        };
        let written = serde_json::to_vec(&marker)
            .map_err(io::Error::other)
            .and_then(|bytes| write_atomic(&archive_receipt(&self.paths), &bytes));
        match written {
            Ok(()) => Outcome::Done,
            Err(error) => io_failure(OP, error),
        }
    }
}

fn drop_snapshot(paths: &Paths) {
    let _ = remove_if_present(&paths.snapshot.state);
    let _ = remove_if_present(&paths.snapshot.memory);
    let _ = remove_if_present(&paged_marker(paths));
    let _ = remove_if_present(&archive_receipt(paths));
    let files = diff_files(paths);
    let _ = remove_if_present(&files.state);
    let _ = remove_if_present(&files.memory);
    let _ = images_of(paths).clear();
}
