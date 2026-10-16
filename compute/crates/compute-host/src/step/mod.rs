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

mod remote;
#[cfg(test)]
mod tests;

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
use crate::lazy::{Fetcher, Hydration};
#[cfg(target_os = "linux")]
use crate::paging::Paging;
use crate::protocol::Id;
use crate::restore_notice::tell_restored;
use crate::state::{Change, Disk, Record, Records, StateError, apply};
use crate::store::{Receipt, Store};
#[cfg(target_os = "linux")]
use crate::working_set::{PageSet, READY_BYTES, WakeProfile};

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

pub(crate) use live::{Base, DiskWatch, LiveMemory, Reconnected};

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
    /// How VMs get a memory pager.
    pub pager: crate::PagerConfig,
    /// VM processes this job has started; zero when it is issued.
    pub launches: u32,
    /// The sandbox's last activity when the step was issued, in
    /// milliseconds since the Unix epoch; every write of the record keeps it.
    pub last_used_ms: u64,
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

/// Present while the sandbox's VM may have its memory served by a pager,
/// naming that pager's launch (see [`crate::paging::tag`]).
fn paged_marker(paths: &Paths) -> PathBuf {
    paths.dir.join("paged")
}

/// Where the sandbox's pager listens for the agent.
fn pager_control(paths: &Paths) -> PathBuf {
    paths.dir.join("pager.sock")
}

/// Whether the sandbox's last VM may have had its memory served by a
/// pager.
pub(crate) fn paged(paths: &Paths) -> bool {
    paged_marker(paths).exists()
}

/// Reconnects to the pager of a VM found running after an agent restart;
/// see [`Paging::reconnect`]. What the VM's memory was based on is not
/// known any more.
#[cfg(target_os = "linux")]
pub(crate) async fn reconnect_paging(
    paths: &Paths,
    fetcher: Option<&Arc<Fetcher>>,
) -> Result<Option<Reconnected>, EngineError> {
    let paging = Paging::reconnect(
        &paged_marker(paths),
        &pager_control(paths),
        images_of(paths),
        fetcher.cloned(),
    )
    .await?;
    Ok(paging.map(|paging| Reconnected { paging }))
}

/// The files a diff snapshot is written to, inside the jail.
fn diff_files(paths: &Paths) -> SnapshotFiles {
    SnapshotFiles {
        state: paths.in_jail("save.state"),
        memory: paths.in_jail("save.mem"),
    }
}

/// Makes the sandbox's images consistent after a host restart and reports
/// whether a good current image exists. An error means they could not be
/// checked, which proves nothing about them.
pub(crate) fn recover_images(paths: &Paths) -> io::Result<bool> {
    images_of(paths).recover().map(|current| current.is_some())
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
            // The memory (and any pager serving it) goes only after the
            // process.
            let ended = match after {
                After::NoVm => None,
                After::Kept(live) => {
                    live.stopping.store(true, Ordering::Release);
                    Some((live.vm, live.memory))
                }
                After::New(vm, memory) => Some((vm, memory)),
            };
            if let Some((vm, memory)) = ended {
                outcome = self.end_with_memory(vm, memory, outcome).await;
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
        let change = change.last_used(self.last_used_ms);
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
        let outcome = self
            .end_with_memory(live.vm, live.memory, Outcome::Done)
            .await;
        (outcome, After::NoVm)
    }

    /// Snapshots the paused VM and publishes the result as a new image
    /// generation, which becomes the VM's base.
    async fn write_image(&self, live: &mut Live<E::Vm>) -> Result<Verified, EngineError> {
        const OP: &str = "save";
        let images = images_of(&self.paths);
        // A lazily woken VM's image must be whole, and its pager hold all
        // of it, before a diff can be merged over it or the image replaced.
        live.memory.settled(OP).await?;
        #[cfg(target_os = "linux")]
        if let (Some(_), Base::Image(generation)) = (&live.memory.paging, live.memory.base) {
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
        let runtime = self.engine.runtime().to_owned();
        let memory_len = self.spec.memory_bytes();
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
                    len: memory_len,
                },
            };
            let published = images.publish_made_by(parts, Some(&runtime));
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

    /// The sandbox's current local image, checked. A missing one is lost
    /// memory and the record says so; a bad one goes to quarantine.
    async fn saved_image(&mut self, images: &Images) -> Result<Verified, Outcome> {
        const OP: &str = "restore";
        let checked = {
            let images = images.clone();
            blocking(move || images.current_verified()).await
        };
        match checked {
            Ok(Ok(Some(image))) => Ok(image),
            Ok(Ok(None)) => {
                let _ = self.commit(Change::new().image(false)).await;
                Err(Outcome::Failed(Failure::MemoryLost))
            }
            Ok(Err(suspect)) => {
                self.quarantine_current(images, &suspect).await;
                Err(failure(&suspect_error(OP, suspect)))
            }
            Err(error) => Err(io_failure(OP, error)),
        }
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
        let image = match self.saved_image(&images).await {
            Ok(image) => image,
            Err(outcome) => return (outcome, After::NoVm),
        };
        let verified = started.elapsed();
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
        let source = match &memory {
            MemorySource::File(_) => "file",
            MemorySource::Pager(_) if image.meta().remote => "remote",
            MemorySource::Pager(_) => "pager",
        };
        let files = RestoreFiles {
            state: self.paths.snapshot.state.clone(),
            memory,
        };
        // On any failure below the VM process is gone before its memory's
        // pager and hydration are stopped and joined, so a retry never
        // fills the same file beside them.
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
                    live_memory.close().await;
                    return (outcome, After::NoVm);
                }
                live_memory.close().await;
                return (failure(&error), After::NoVm);
            }
        };
        let loaded = started.elapsed();
        let archived = self.record.archived;
        // A restore continues the saved execution: the generation stays.
        let running = Change::new().image(false).archived(false);
        if let Err(error) = self.commit(running).await {
            let outcome = self
                .end_with_memory(vm, live_memory, state_failure(&error))
                .await;
            return (outcome, After::NoVm);
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
            let ended = self.end_with_memory(vm, live_memory, Outcome::Done).await;
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
    /// is bad or gone is dropped. An image recorded as made under another
    /// runtime (a different VMM version or processor model) is given up
    /// too: that VMM will go on refusing it, so the sandbox wakes from its
    /// disk instead of retrying forever. Otherwise the refusal was the
    /// host's (a pager that could not start or could not reach the store,
    /// say) and the image is kept for a retry.
    async fn rejected(
        &mut self,
        images: &Images,
        image: &Verified,
        memory: &LiveMemory,
        error: &EngineError,
    ) -> Outcome {
        const OP: &str = "restore";
        tracing::warn!(id = %self.id, %error, "the VMM refused the memory image");
        let made_under = image.meta().runtime.as_deref().unwrap_or("");
        if !made_under.is_empty() && made_under != self.engine.runtime() {
            tracing::warn!(
                id = %self.id,
                made_under,
                runtime = self.engine.runtime(),
                "the refused image was made under another runtime; waking from the disk"
            );
            if let Err(error) = self.commit(Change::new().image(false)).await {
                return state_failure(&error);
            }
            return failure(&EngineError::new(
                ErrorKind::MemoryLost,
                OP,
                format!("made under another runtime ({made_under:?}): {error}"),
            ));
        }
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
            let (paging, tag) = self.start_paging(images, image)?;
            let socket = paths.in_jail("uffd.sock");
            let options = compute_pager::linux::serve::Options {
                vmm_socket: socket.clone(),
                control: pager_control(paths),
                memory: images.memory(generation),
                tag,
                complete: !image.meta().remote,
                profile: Some(wake_profile(paths)),
                learned: Some(wake_profile(paths)),
                ready_bytes: READY_BYTES,
                record_for: self.pager.record_for,
                // The engine adds the VMM's API socket, which it places.
                api_socket: None,
            };
            live.paging = Some(paging);
            let mut args = vec![std::ffi::OsString::from("pager")];
            args.extend(options.args());
            let pager = compute_engine::PagerSpec {
                socket,
                program: self.pager.program.clone(),
                args,
            };
            Ok((MemorySource::Pager(pager), live))
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

    /// Starts the agent's side of the pager about to serve `image`: marks
    /// the sandbox as paged by this launch and, for a remote image, starts
    /// filling its memory file. Returns it with the launch's tag.
    #[cfg(target_os = "linux")]
    fn start_paging(
        &self,
        images: &Images,
        image: &Verified,
    ) -> Result<(Paging, String), EngineError> {
        const OP: &str = "restore";
        let io = |error| EngineError::io(OP, error);
        let paths = &self.paths;
        let generation = image.generation();
        let memory = images.memory(generation);
        let control = pager_control(paths);
        let tag = crate::paging::tag(generation);
        let identity = crate::paging::identity(&memory).map_err(io)?;
        remove_if_present(&crate::paging::done_file(&control)).map_err(io)?;
        // Written before the pager starts, so an agent that restarts knows
        // the VM's memory may need it, and which launch to look for.
        write_atomic(&paged_marker(paths), tag.as_bytes()).map_err(io)?;
        if !image.meta().remote {
            let paging = Paging::start(control, tag.clone(), identity, None, Vec::new());
            return Ok((paging, tag));
        }
        let Some(fetcher) = &self.fetcher else {
            return Err(EngineError::new(
                ErrorKind::MemoryLost,
                OP,
                "the memory image is in a store this host cannot page from",
            ));
        };
        let (refs, hashes) = crate::paging::remote_chunks(images, image, OP)?;
        let filled = images.filled(image).map_err(io)?;
        let first = WakeProfile::load(&wake_profile(paths)).offsets;
        let hydration = Hydration::start(
            Arc::clone(fetcher),
            &memory,
            refs,
            hashes,
            PageSet::new(&filled),
            &[],
            &first,
        )
        .map_err(io)?;
        let paging = Paging::start(control, tag.clone(), identity, Some(hydration), filled);
        Ok((paging, tag))
    }

    /// Moves the current image aside for inspection and records that the
    /// sandbox has no usable memory image. A failure to read the image is
    /// no verdict on it: the image is kept.
    async fn quarantine_current(&mut self, images: &Images, suspect: &Suspect) {
        if !suspect.is_verdict() {
            tracing::warn!(id = %self.id, error = %suspect, "memory image unreadable for now; keeping it");
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

    /// Like [`Self::end`] for a VM with its memory: the pager going away is
    /// expected, and once the process has ended its memory is closed. A VM
    /// that would not end keeps its memory served, since it may still run.
    async fn end_with_memory(&self, vm: E::Vm, memory: LiveMemory, outcome: Outcome) -> Outcome {
        memory.ending();
        let outcome = self.end(vm, outcome).await;
        if outcome == Outcome::Failed(Failure::Fatal) {
            memory.serve_detached();
        } else {
            memory.close().await;
        }
        outcome
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
    let _ = remove_if_present(&pager_control(paths).with_extension("done"));
    let _ = remove_if_present(&archive_receipt(paths));
    let files = diff_files(paths);
    let _ = remove_if_present(&files.state);
    let _ = remove_if_present(&files.memory);
    let _ = images_of(paths).clear();
}
