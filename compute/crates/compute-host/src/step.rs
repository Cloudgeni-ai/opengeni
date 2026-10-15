//! Carrying out one step for one sandbox.
//!
//! The core guarantees at most one step per sandbox at a time, so a step
//! takes the sandbox's VM handle, owns it while it works and hands it back
//! when it finishes. No locks are needed around a VM.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use compute_core::{Failure, Outcome, Step};
use compute_engine::{CancellationToken, Completion, Engine, EngineError, ErrorKind, VmSpec};

use crate::layout::{Paths, remove_durably, remove_if_present, sync_file, write_atomic};
use crate::protocol::Id;
use crate::store::{SavedFiles, Store};

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
            Step::Pause | Step::Resume | Step::Compress | Step::Save => {
                let Some(live) = self.live.take() else {
                    // The VM vanished between the decision and the step; the
                    // exit notice is on its way.
                    return (Outcome::Failed(Failure::MemoryLost), After::NoVm);
                };
                match step {
                    Step::Pause => self.simple(self.engine.pause(&live.vm).await, live),
                    Step::Resume => self.simple(self.engine.resume(&live.vm).await, live),
                    Step::Compress => self.compress(live).await,
                    _ => self.save(live).await,
                }
            }
            Step::Restore => self.restore().await,
            Step::Boot => self.boot().await,
            Step::Archive => (self.archive().await, After::NoVm),
            Step::Evict => (self.evict().await, After::NoVm),
            Step::Fetch => (self.fetch().await, After::NoVm),
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

    async fn compress(&self, live: Live<E::Vm>) -> (Outcome, After<E::Vm>) {
        let outcome = match self.engine.compress(&live.vm, &self.cancel).await {
            Ok(Completion::Finished) => Outcome::Done,
            // Partly compressed is still a valid paused VM.
            Ok(Completion::Cancelled) => Outcome::Cancelled,
            Err(error) => failure(&error),
        };
        (outcome, After::Kept(live))
    }

    /// Snapshot, make it durable, mark it valid, then end the VM process.
    /// A wake that arrives before the process ends cancels the save and the
    /// still-paused VM simply resumes.
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
        live.stopping.store(true, Ordering::Release);
        match self.engine.stop(live.vm).await {
            Ok(()) => (Outcome::Done, After::NoVm),
            // The image is safe on disk either way; a VMM that would not die
            // is a host problem worth surfacing.
            Err(error) => (failure(&error), After::NoVm),
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
        (Outcome::Done, After::New(vm))
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
}

fn drop_snapshot(paths: &Paths) {
    let _ = remove_if_present(&paths.snapshot.state);
    let _ = remove_if_present(&paths.snapshot.memory);
}
