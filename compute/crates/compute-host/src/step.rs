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

use crate::image::{Images, Parts, Suspect, Verified};
use crate::layout::{Paths, link_kernel, remove_durably, remove_if_present, write_atomic};
#[cfg(target_os = "linux")]
use crate::lazy::{ChunkSource, Fetcher, Hydration, Memory, Paging, WakeProfile};
use crate::protocol::Id;
use crate::restore_notice::tell_restored;
use crate::state::{Change, Disk, Record, Records, StateError, apply};
use crate::store::{FetchInto, FetchedMemory, JailedFile, Receipt, SavedFiles, SavedImage, Store};

/// How long a restore waits for the guest to acknowledge the restore notice.
/// A guest that listens answers in about a millisecond.
const NOTICE_TIMEOUT: Duration = Duration::from_millis(250);

/// Longest a wake waits for its learned working set before resuming the
/// guest anyway; whatever is missing then arrives on demand.
const PREFETCH_LIMIT: Duration = Duration::from_secs(5);
/// How long a step first waits before trying again to settle a record
/// whose last write has an unknown fate, and the longest it waits between
/// tries.
const SETTLE_RETRY: (Duration, Duration) = (Duration::from_millis(50), Duration::from_secs(5));

mod live;

pub(crate) use live::{Base, DiskWatch, LiveMemory};

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

/// How a step ended.
#[derive(Debug)]
pub(crate) struct Ran<V> {
    pub outcome: Outcome,
    pub after: After<V>,
    /// VM processes the step started, counting any it ended again before
    /// finishing, such as a restore whose resume failed.
    pub launches: u32,
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
    /// The host's guest kernel, linked into the jail at each boot.
    pub kernel: PathBuf,
    /// Fetches remote memory for every VM on the host, when the store keeps
    /// memory as chunks.
    #[cfg(target_os = "linux")]
    pub fetcher: Option<Arc<Fetcher>>,
    /// VM processes this job has started; zero when it is issued.
    pub launches: u32,
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
    pub async fn run(mut self, step: Step) -> Ran<E::Vm> {
        let (mut outcome, mut after) = self.step(step).await;
        if outcome == Outcome::Failed(Failure::MemoryLost) {
            let vm = match after {
                After::NoVm => None,
                After::Kept(live) => {
                    live.stopping.store(true, Ordering::Release);
                    Some(live.vm)
                }
                After::New(vm, _) => Some(vm),
            };
            if let Some(vm) = vm {
                outcome = self.end(vm, outcome).await;
            }
            after = After::NoVm;
        }
        Ran {
            outcome,
            after,
            launches: self.launches,
        }
    }

    async fn step(&mut self, step: Step) -> (Outcome, After<E::Vm>) {
        if self.cancel.is_cancelled() {
            return (
                Outcome::Cancelled,
                self.live.take().map_or(After::NoVm, After::Kept),
            );
        }
        // Every decision below reads the record, which must be what its
        // file durably says: a write whose fate was unknown may have been
        // lost, and acting on it could run or drop a VM against a record
        // that a crash would take back.
        match self.records.settle(self.id).await {
            Ok(durable) if durable == self.record => {}
            Ok(durable) => {
                tracing::warn!(id = %self.id, issued = %self.record.fence(), durable = %durable.fence(), "record changed before the step began");
                return (
                    Outcome::Failed(Failure::Transient),
                    self.live.take().map_or(After::NoVm, After::Kept),
                );
            }
            Err(error) => {
                return (
                    state_failure(&error),
                    self.live.take().map_or(After::NoVm, After::Kept),
                );
            }
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

    /// Records `change` against the version this step last saw. A write
    /// whose fate is unknown is settled before this returns: it either
    /// landed durably, which counts as success, or durably did not, which
    /// is a plain I/O failure that changed nothing. Until one of the two is
    /// established the step waits, trying again with backoff, and touches
    /// nothing: an unknown fate says nothing about the sandbox's copies,
    /// so it is never taken as their loss.
    async fn commit(&mut self, change: Change) -> Result<(), StateError> {
        let before = self.record.clone();
        let failed = match self.records.commit(self.id, before.fence(), change).await {
            Ok(record) => {
                self.record = record;
                return Ok(());
            }
            Err(StateError::Io(error)) => error,
            Err(error) => return Err(error),
        };
        let intended = apply(self.id, Some(&before), before.fence(), change);
        let (mut wait, longest) = SETTLE_RETRY;
        loop {
            match self.records.settle(self.id).await {
                Ok(durable) if durable == before => return Err(StateError::Io(failed)),
                Ok(durable) if matches!(&intended, Ok(Some(next)) if *next == durable) => {
                    self.record = durable;
                    return Ok(());
                }
                // Only this step changes the record while it runs.
                Ok(durable) => {
                    return Err(StateError::Stale {
                        id: self.id,
                        expected: before.fence(),
                        found: durable.fence(),
                    });
                }
                Err(StateError::Io(error)) => {
                    tracing::warn!(id = %self.id, %error, ?wait, "record write has an unknown fate; the step waits with every copy as it is");
                    tokio::time::sleep(wait).await;
                    wait = (wait * 2).min(longest);
                }
                Err(error) => return Err(error),
            }
        }
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
        // One record write vouches for both copies at once, so the local
        // copy is never trusted without the remote one being settled too:
        // `Failure::RemoteUntrusted` cannot arise here.
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
                if live.memory.disk.failed() {
                    // No snapshot of this VM can be trusted again. It keeps
                    // running, pausing and waking from memory until a new
                    // process replaces it.
                    tracing::error!(id = %self.id, %error, "the VM cannot be saved");
                    return (Outcome::Failed(Failure::Unsavable), After::Kept(live));
                }
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
        // The VMM syncs the disk while it takes the snapshot, so the check
        // that vouches for the disk starts first.
        let starting = Arc::clone(&live.memory.disk);
        // A failed watch is final, which the caller finds on it.
        blocking(move || starting.begin())
            .await
            .and_then(|begun| begun)
            .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))?;
        let started = Instant::now();
        // From here on the VM's dirty pages are being reset: any failure
        // leaves its base unknown.
        live.memory.base = Base::Unknown;
        self.engine.snapshot(&live.vm, &files, kind).await?;
        let snapshot = started.elapsed();
        let scratch = self.paths.dir.join("saving");
        let watching = Arc::clone(&live.memory.disk);
        let published = blocking(move || {
            // The VMM wrote these inside its jail, where it could have put
            // links instead: they move somewhere only the host reaches and
            // must prove to be plain files before anything reads them.
            let files = take_written(&files, &scratch)?;
            // The image is only good with the disk as it was when the
            // snapshot was taken, so the disk must be durable first, with
            // nothing written since the VM started lost on the way.
            watching.sync()?;
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
        let paths = self.paths.clone();
        let watch = match blocking(move || DiskWatch::fresh(&paths))
            .await
            .and_then(|opened| opened)
        {
            Ok(watch) => watch,
            Err(error) => return (io_failure(OP, error), After::NoVm),
        };
        let (memory, live_memory) = match self.memory_source(&images, &image, watch) {
            Ok(prepared) => prepared,
            Err(error) => return (failure(&error), After::NoVm),
        };
        let files = RestoreFiles {
            state: self.paths.snapshot.state.clone(),
            memory,
        };
        let vm = match self.engine.restore(&self.spec, &files).await {
            Ok(vm) => {
                self.launches += 1;
                self.hold_watch(&vm, &live_memory.disk).await;
                vm
            }
            Err(error) => {
                self.launches += u32::from(error.launched);
                if error.kind == ErrorKind::MemoryLost {
                    let outcome = self.rejected(&images, &image, &live_memory, &error).await;
                    return (outcome, After::NoVm);
                }
                return (failure(&error), After::NoVm);
            }
        };
        let archived = self.record.archived;
        // A restore continues the saved execution: the generation stays.
        let running = Change::new().image(false).archived(false);
        if let Err(error) = self.commit(running).await {
            return (self.end(vm, state_failure(&error)).await, After::NoVm);
        }
        #[cfg(target_os = "linux")]
        if let Some(paging) = &live_memory.paging {
            paging.prefetched(PREFETCH_LIMIT).await;
        }
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
        self.tell_guest_restored().await;
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
        disk: DiskWatch,
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
            disk: Arc::new(disk),
        };
        if !image.meta().remote && !profile.needs_pager() {
            link(&images.memory(generation), &paths.snapshot.memory).map_err(io)?;
            remove_durably(&paged_marker(paths)).map_err(io)?;
            return Ok((MemorySource::File(paths.snapshot.memory.clone()), live));
        }
        #[cfg(target_os = "linux")]
        {
            // Written before the VMM can depend on the pager, so an agent
            // that restarts knows the VM cannot be taken back.
            write_atomic(&paged_marker(paths), b"").map_err(io)?;
            let socket = paths.in_jail("uffd.sock");
            let learned = wake_profile(paths);
            let wake = WakeProfile::load(&learned);
            let (memory, hydration) = if image.meta().remote {
                let Some(fetcher) = &self.fetcher else {
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
                    &wake.offsets,
                )
                .map_err(io)?;
                let source = ChunkSource::new(Arc::clone(&hydration)).map_err(io)?;
                (Memory::Remote(source), Some(hydration))
            } else {
                let mapped = images.map_memory(generation).map_err(io)?;
                (Memory::Local(mapped), None)
            };
            live.paging =
                Some(Paging::start(&socket, memory, hydration, wake, learned).map_err(io)?);
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

    /// Has the engine keep the description `watch` syncs for as long as
    /// `vm` lives, so a later agent can still vouch for the disk; see
    /// `DiskWatch`. Without it, a later agent never saves the VM.
    async fn hold_watch(&self, vm: &E::Vm, watch: &DiskWatch) {
        let held = match watch.description() {
            Ok(Some(description)) => self.engine.hold(vm, description).await,
            Ok(None) => return,
            Err(error) => Err(EngineError::io("hold", error)),
        };
        if let Err(error) = held {
            tracing::warn!(id = %self.id, %error, "disk watch not kept beyond this agent; a later one will not save this VM");
        }
    }

    /// Boot fresh from the disk; any old memory image is meaningless now.
    async fn boot(&mut self) -> (Outcome, After<E::Vm>) {
        let fresh = Change::new().image(false).archived(false).execution();
        if let Err(error) = self.commit(fresh).await {
            return (state_failure(&error), After::NoVm);
        }
        drop_snapshot(&self.paths);
        // Linked now rather than at creation, so a kernel upgrade reaches
        // every sandbox's next boot. No VMM of this sandbox runs meanwhile.
        let (kernel, paths) = (self.kernel.clone(), self.paths.clone());
        let prepared = blocking(move || {
            link_kernel(&kernel, &paths)?;
            DiskWatch::fresh(&paths)
        })
        .await
        .and_then(|prepared| prepared);
        let watch = match prepared {
            Ok(watch) => watch,
            Err(error) => return (io_failure("boot", error), After::NoVm),
        };
        match self.engine.boot(&self.spec).await {
            Ok(vm) => {
                self.launches += 1;
                self.hold_watch(&vm, &watch).await;
                (Outcome::Done, After::New(vm, LiveMemory::booted(watch)))
            }
            Err(error) => {
                self.launches += u32::from(error.launched);
                (failure(&error), After::NoVm)
            }
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
            disk: JailedFile::new(&self.paths.disk),
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
        // The sandbox is remote from here on, whatever happens to the local
        // files: what is left behind is deleted on the next recovery.
        if let Err(error) = clear_local(&self.paths).await {
            tracing::warn!(id = %self.id, %error, "local copy not fully deleted after eviction; recovery finishes it");
        }
        Outcome::Done
    }

    /// Brings the stored copy back: the disk and device state whole, memory
    /// left in the store where it can be paged in, as a new image.
    async fn fetch(&mut self) -> Outcome {
        const OP: &str = "fetch";
        let paths = self.paths.clone();
        let scratch = paths.dir.join("fetching");
        let _ = fs::remove_dir_all(&scratch);
        // The store writes a new file, never through whatever an earlier
        // VMM may have left at the disk's path.
        let stale = paths.disk.clone();
        if let Err(error) = blocking(move || remove_if_present(&stale))
            .await
            .and_then(|removed| removed)
        {
            return io_failure(OP, error);
        }
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

/// Moves the snapshot files a VMM wrote in its jail into `scratch`, a
/// directory only the host can reach, and checks each is a plain file of
/// its own. A renamed link stays a link, so the check sees what the VMM
/// left, and nothing jailed can swap it afterwards.
fn take_written(files: &SnapshotFiles, scratch: &Path) -> io::Result<SnapshotFiles> {
    match fs::remove_dir_all(scratch) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    fs::create_dir(scratch)?;
    let taken = SnapshotFiles {
        state: scratch.join("save.state"),
        memory: scratch.join("save.mem"),
    };
    for (written, moved) in [(&files.state, &taken.state), (&files.memory, &taken.memory)] {
        fs::rename(written, moved)?;
        compute_engine::confined::check_written(moved)?;
    }
    Ok(taken)
}

/// Deletes the sandbox's local disk, memory images and snapshot files.
pub(crate) async fn clear_local(paths: &Paths) -> io::Result<()> {
    let paths = paths.clone();
    blocking(move || {
        remove_if_present(&paths.disk)?;
        remove_if_present(&paths.snapshot.state)?;
        remove_if_present(&paths.snapshot.memory)?;
        remove_if_present(&paged_marker(&paths))?;
        images_of(&paths).clear()
    })
    .await
    .and_then(|removed| removed)
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

#[cfg(test)]
mod tests;
