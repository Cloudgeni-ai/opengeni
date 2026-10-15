//! Carrying out one step for one sandbox.
//!
//! The core guarantees at most one step per sandbox at a time, so a step
//! takes the sandbox's VM handle, owns it while it works and hands it back
//! when it finishes. No locks are needed around a VM.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use compute_core::{Failure, Outcome, Step};
use compute_engine::{CancellationToken, Completion, Engine, EngineError, ErrorKind, VmSpec};

use crate::layout::{Paths, remove_durably, remove_if_present, sync_file, write_atomic};
use crate::protocol::Id;
use crate::restore_notice::tell_restored;
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
    /// guest runs and its disk moves on, so it is unmarked first.
    async fn resume(&self, live: Live<E::Vm>) -> (Outcome, After<E::Vm>) {
        let paths = &self.paths;
        if paths.saved.exists() || paths.archived.exists() {
            let unmarked =
                remove_durably(&paths.saved).and_then(|()| remove_durably(&paths.archived));
            if let Err(error) = unmarked {
                return (io_failure("resume", error), After::Kept(live));
            }
        }
        self.simple(self.engine.resume(&live.vm).await, live)
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

    /// Snapshot the paused VM, make the copy durable and mark it valid. The
    /// VM stays paused in memory, so a wake still only has to resume it; the
    /// copy lets memory pressure end the process instantly and survives the
    /// process crashing. A wake that arrives during the save cancels it.
    async fn save(&self, live: Live<E::Vm>) -> (Outcome, After<E::Vm>) {
        let paths = &self.paths;
        if let Err(error) = remove_durably(&paths.saved) {
            return (io_failure("save", error), After::Kept(live));
        }
        if let Err(error) = self.engine.snapshot(&live.vm, &paths.snapshot).await {
            return (failure(&error), After::Kept(live));
        }
        let files = paths.snapshot.clone();
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
            drop_snapshot(paths);
            return (Outcome::Cancelled, After::Kept(live));
        }
        if let Err(error) = write_atomic(&paths.saved, b"") {
            return (io_failure("save", error), After::Kept(live));
        }
        (Outcome::Done, After::Kept(live))
    }

    /// Ends the VM process of a paused VM whose current state is saved, which
    /// frees all of its memory at once and loses nothing.
    async fn end_process(&self, live: Live<E::Vm>) -> (Outcome, After<E::Vm>) {
        if !self.paths.saved.exists() {
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

    /// Start from the saved image, mark the image stale before the guest
    /// runs, then resume.
    async fn restore(&self) -> (Outcome, After<E::Vm>) {
        let paths = &self.paths;
        if !paths.saved.exists() {
            return (Outcome::Failed(Failure::MemoryLost), After::NoVm);
        }
        let vm = match self.engine.restore(&self.spec, &paths.snapshot).await {
            Ok(vm) => vm,
            Err(error) => {
                if error.kind == ErrorKind::MemoryLost {
                    let _ = remove_durably(&paths.saved);
                }
                return (failure(&error), After::NoVm);
            }
        };
        let unmarked = remove_durably(&paths.saved).and_then(|()| remove_durably(&paths.archived));
        if let Err(error) = unmarked {
            let _ = self.engine.stop(vm).await;
            return (io_failure("restore", error), After::NoVm);
        }
        if let Err(error) = self.engine.resume(&vm).await {
            // The guest never ran, so the image is still good: keep it.
            let _ = self.engine.stop(vm).await;
            let _ = write_atomic(&paths.saved, b"");
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
    async fn boot(&self) -> (Outcome, After<E::Vm>) {
        let paths = &self.paths;
        let cleared = remove_durably(&paths.saved).and_then(|()| remove_durably(&paths.archived));
        if let Err(error) = cleared {
            return (io_failure("boot", error), After::NoVm);
        }
        drop_snapshot(paths);
        match self.engine.boot(&self.spec).await {
            Ok(vm) => (Outcome::Done, After::New(vm)),
            Err(error) => (failure(&error), After::NoVm),
        }
    }

    fn saved_files(&self) -> SavedFiles {
        SavedFiles {
            disk: self.paths.disk.clone(),
            memory: self
                .paths
                .saved
                .exists()
                .then(|| self.paths.snapshot.clone()),
        }
    }

    /// Copies the saved state to the store. The copy runs to its end even
    /// when cancelled: abandoning the future would leave the store writing in
    /// the background after the step claimed to have stopped, so it reports
    /// its real outcome instead.
    async fn archive(&self) -> Outcome {
        let files = self.saved_files();
        let marker: &[u8] = if files.memory.is_some() {
            b"memory"
        } else {
            b"disk"
        };
        if let Err(error) = self.store.archive(self.id, &files).await {
            return failure(&error);
        }
        match write_atomic(&self.paths.archived, marker) {
            Ok(()) => Outcome::Done,
            Err(error) => io_failure("archive", error),
        }
    }

    async fn evict(&self) -> Outcome {
        if !self.paths.archived.exists() {
            return failure(&EngineError::new(
                ErrorKind::Fatal,
                "evict",
                "no archived copy to fall back on",
            ));
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

    async fn fetch(&self) -> Outcome {
        let files = self.saved_files();
        match self.store.fetch(self.id, &files).await {
            Ok(()) => Outcome::Done,
            Err(error) => failure(&error),
        }
    }

    /// Deletes the memory image here and in the store, keeping the files.
    /// The image is unmarked first, so a crash part-way never claims an
    /// image that is gone.
    async fn forget(&self) -> Outcome {
        let paths = &self.paths;
        if let Err(error) = remove_durably(&paths.saved) {
            return io_failure("forget", error);
        }
        drop_snapshot(paths);
        if !paths.archived.exists() {
            return Outcome::Done;
        }
        if let Err(error) = self.store.forget_memory(self.id).await {
            return failure(&error);
        }
        match write_atomic(&paths.archived, b"disk") {
            Ok(()) => Outcome::Done,
            Err(error) => io_failure("forget", error),
        }
    }
}

fn drop_snapshot(paths: &Paths) {
    let _ = remove_if_present(&paths.snapshot.state);
    let _ = remove_if_present(&paths.snapshot.memory);
}
