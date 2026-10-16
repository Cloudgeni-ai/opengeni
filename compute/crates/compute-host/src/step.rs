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

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use compute_core::{Failure, Outcome, Step};
use compute_engine::{CancellationToken, Completion, Engine, EngineError, ErrorKind, VmSpec};

use crate::layout::{Paths, remove_if_present, sync_file};
use crate::protocol::Id;
use crate::restore_notice::tell_restored;
use crate::state::{Change, Disk, Record, Records, StateError};
use crate::store::{SavedFiles, Store};

/// How long a restore waits for the guest to acknowledge the restore notice.
/// A guest that listens answers in about a millisecond.
const NOTICE_TIMEOUT: Duration = Duration::from_millis(250);

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
}

/// What a step leaves behind.
#[derive(Debug)]
pub(crate) enum After<V> {
    /// No VM process.
    NoVm,
    /// The VM the step was given.
    Kept(Live<V>),
    /// A VM process the step started.
    New(V),
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
}

fn failure(error: &EngineError) -> Outcome {
    tracing::warn!(%error, "step failed");
    Outcome::Failed(match error.kind {
        ErrorKind::Transient => Failure::Transient,
        ErrorKind::MemoryLost => Failure::MemoryLost,
        ErrorKind::Fatal => Failure::Fatal,
    })
}

fn io_failure(operation: &'static str, error: std::io::Error) -> Outcome {
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

impl<E: Engine, S: Store> Job<E, S> {
    /// Runs `step` and reports how it went and what VM remains.
    pub async fn run(mut self, step: Step) -> (Outcome, After<E::Vm>) {
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
            Step::Forget => (self.forget().await, After::NoVm),
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
    /// guest runs and its disk moves on, so the record stops vouching for
    /// it first, and vouches again if the resume was refused: the guest
    /// never ran, and the core counts on a transient failure having changed
    /// nothing.
    async fn resume(&mut self, live: Live<E::Vm>) -> (Outcome, After<E::Vm>) {
        let (image, archived) = (self.record.image, self.record.archived);
        if (image || archived)
            && let Err(error) = self
                .commit(Change::new().image(false).archived(false))
                .await
        {
            return (state_failure(&error), After::Kept(live));
        }
        let result = self.engine.resume(&live.vm).await;
        if let Err(error) = &result
            && error.kind == ErrorKind::Transient
            && (image || archived)
            && let Err(error) = self
                .commit(Change::new().image(image).archived(archived))
                .await
        {
            // The copy is still good but no longer recorded, so the host
            // just stops relying on it; nothing stale can be restored this
            // way.
            tracing::error!(id = %self.id, %error, "saved copy not recorded again after a refused resume");
        }
        self.simple(result, live)
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

    /// Snapshot the paused VM, make the copy durable and record it as
    /// valid. The VM stays paused in memory, so a wake still only has to
    /// resume it; the copy lets memory pressure end the process instantly
    /// and survives the process crashing. A wake that arrives during the
    /// save cancels it.
    async fn save(&mut self, live: Live<E::Vm>) -> (Outcome, After<E::Vm>) {
        // The snapshot overwrites the image files, so no record may vouch
        // for them meanwhile. The core never saves a VM it already saved;
        // this is a guard.
        if self.record.image
            && let Err(error) = self.commit(Change::new().image(false)).await
        {
            return (state_failure(&error), After::Kept(live));
        }
        if let Err(error) = self.engine.snapshot(&live.vm, &self.paths.snapshot).await {
            return (failure(&error), After::Kept(live));
        }
        let files = self.paths.snapshot.clone();
        let synced = tokio::task::spawn_blocking(move || {
            sync_file(&files.state)?;
            sync_file(&files.memory)
        })
        .await
        .unwrap_or_else(|error| Err(std::io::Error::other(error)));
        if let Err(error) = synced {
            return (io_failure("save", error), After::Kept(live));
        }
        if self.cancel.is_cancelled() {
            // The image matches this paused VM but goes stale the moment it
            // resumes, so drop it rather than leave a trap.
            drop_snapshot(&self.paths);
            return (Outcome::Cancelled, After::Kept(live));
        }
        let valid = Change::new().image(true).archived(false);
        if let Err(error) = self.commit(valid).await {
            return (state_failure(&error), After::Kept(live));
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
        match self.engine.stop(live.vm).await {
            Ok(()) => (Outcome::Done, After::NoVm),
            Err(error) => {
                // The copy is safe on disk either way, so the sandbox moves
                // on without the process; a VMM that would not die is a host
                // problem worth surfacing.
                tracing::error!(id = %self.id, %error, "VM process did not end cleanly");
                (Outcome::Failed(Failure::MemoryLost), After::NoVm)
            }
        }
    }

    /// Start from the saved image, record the image as stale and a new
    /// execution before the guest runs, then resume.
    async fn restore(&mut self) -> (Outcome, After<E::Vm>) {
        if !self.record.image || self.record.disk != Disk::Local {
            return (Outcome::Failed(Failure::MemoryLost), After::NoVm);
        }
        let vm = match self.engine.restore(&self.spec, &self.paths.snapshot).await {
            Ok(vm) => vm,
            Err(error) => {
                if error.kind == ErrorKind::MemoryLost {
                    let _ = self.commit(Change::new().image(false)).await;
                }
                return (failure(&error), After::NoVm);
            }
        };
        let archived = self.record.archived;
        let running = Change::new().image(false).archived(false).execution();
        if let Err(error) = self.commit(running).await {
            let _ = self.engine.stop(vm).await;
            return (state_failure(&error), After::NoVm);
        }
        if let Err(error) = self.engine.resume(&vm).await {
            // The guest never ran, so the image is still good: keep it.
            let _ = self.engine.stop(vm).await;
            let kept = Change::new().image(true).archived(archived);
            let _ = self.commit(kept).await;
            return (failure(&error), After::NoVm);
        }
        self.tell_guest_restored().await;
        (Outcome::Done, After::New(vm))
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
            Ok(vm) => (Outcome::Done, After::New(vm)),
            Err(error) => (failure(&error), After::NoVm),
        }
    }

    fn saved_files(&self) -> SavedFiles {
        SavedFiles {
            disk: self.paths.disk.clone(),
            memory: self.record.image.then(|| self.paths.snapshot.clone()),
        }
    }

    /// Copies the saved state to the store. The copy runs to its end even
    /// when cancelled: abandoning the future would leave the store writing in
    /// the background after the step claimed to have stopped, so it reports
    /// its real outcome instead. The copy holds memory exactly when the
    /// record's image is valid, so `image` describes both copies.
    async fn archive(&mut self) -> Outcome {
        if let Err(error) = self.store.archive(self.id, &self.saved_files()).await {
            return failure(&error);
        }
        match self.commit(Change::new().archived(true)).await {
            Ok(()) => Outcome::Done,
            Err(error) => state_failure(&error),
        }
    }

    /// Records the disk as remote, then deletes the local files: a crash in
    /// between leaves files nothing relies on, never a record that relies
    /// on deleted files.
    async fn evict(&mut self) -> Outcome {
        if !self.record.archived {
            return failure(&EngineError::new(
                ErrorKind::Fatal,
                "evict",
                "no archived copy to fall back on",
            ));
        }
        if let Err(error) = self.commit(Change::new().disk(Disk::Remote)).await {
            return state_failure(&error);
        }
        let paths = self.paths.clone();
        let removed = tokio::task::spawn_blocking(move || {
            remove_if_present(&paths.disk)?;
            remove_if_present(&paths.snapshot.state)?;
            remove_if_present(&paths.snapshot.memory)
        })
        .await
        .unwrap_or_else(|error| Err(std::io::Error::other(error)));
        match removed {
            Ok(()) => Outcome::Done,
            Err(error) => io_failure("evict", error),
        }
    }

    async fn fetch(&mut self) -> Outcome {
        let files = self.saved_files();
        if let Err(error) = self.store.fetch(self.id, &files).await {
            return failure(&error);
        }
        match self.commit(Change::new().disk(Disk::Local)).await {
            Ok(()) => Outcome::Done,
            Err(error) => state_failure(&error),
        }
    }

    /// Deletes the memory image here and in the store, keeping the files.
    /// The record lets go of the image first, so a crash part-way never
    /// claims an image that is gone; the archived copy stays current, now
    /// without memory.
    async fn forget(&mut self) -> Outcome {
        if self.record.image
            && let Err(error) = self.commit(Change::new().image(false)).await
        {
            return state_failure(&error);
        }
        drop_snapshot(&self.paths);
        if !self.record.archived {
            return Outcome::Done;
        }
        match self.store.forget_memory(self.id).await {
            Ok(()) => Outcome::Done,
            Err(error) => failure(&error),
        }
    }
}

fn drop_snapshot(paths: &Paths) {
    let _ = remove_if_present(&paths.snapshot.state);
    let _ = remove_if_present(&paths.snapshot.memory);
}
