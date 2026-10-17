//! The checkpoint step: a copy of a running sandbox in object storage,
//! taken while it goes on running.
//!
//! A checkpoint pauses the VM only while its state is captured as one
//! coherent bundle: a snapshot of the pages that changed since its last
//! one, and a clone of its disk sharing every extent, taken once the disk
//! is durable as the snapshot needs it. The VM then runs again while the
//! changed pages are merged over its last image into a new self-contained
//! one, which becomes the base of its next save, and the bundle, which
//! nothing changes any more, is archived as the owner's next save, under
//! the same fences as an archive. The step owns
//! the VM throughout, and the core runs no other step for the sandbox
//! until it ends, so no later save, retirement or forgetting can touch
//! the bundle while it uploads, and its save number orders it before
//! anything captured after it.
//!
//! The record goes on vouching for no local copy, since the VM moves on;
//! only its `backed_up_ms` moves, to when the bundle was captured, once
//! the store holds it. Protection starts there, not when the step began.
//!
//! From the resume on, the step sends readings of the VM's activity to the
//! agent (see [`Meter`]): the guest's use while the image is made and
//! uploaded counts, and the capture's own work does not.

use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use compute_core::{Failure, Outcome};
use compute_engine::{Engine, EngineError, ErrorKind};
use tokio::time::Instant;

use super::{
    After, Base, Job, Live, Meter, Reading, Taken, blocking, checkpoint_disk, failure, images_of,
    state_failure, wake_profile,
};
use crate::image::Verified;
use crate::layout::{clone_jailed, remove_if_present};
use crate::observe::notes;
use crate::state::{Change, unix_ms_now};
use crate::store::{JailedFile, SavedFiles, SavedImage, Store};

const OP: &str = "checkpoint";

/// How long a checkpoint goes on resuming the VM it paused while the VMM
/// answers that nothing changed: past that the VM is beyond control.
const RESUME_FOR: Duration = Duration::from_secs(30);

/// The first wait between those tries; each doubles it, up to a second.
const RESUME_AGAIN_AFTER: Duration = Duration::from_millis(10);

/// What a checkpoint captured while its VM was paused.
struct Captured<I> {
    /// The memory: a snapshot taken, then the image made from it.
    image: I,
    /// The disk's clone.
    disk: PathBuf,
    /// When, in milliseconds since the Unix epoch.
    at_ms: u64,
}

impl<E: Engine, S: Store> Job<E, S> {
    /// Copies the running VM to object storage while it goes on running;
    /// see the module's documentation.
    pub(super) async fn checkpoint(&mut self, mut live: Live<E::Vm>) -> (Outcome, After<E::Vm>) {
        // A lazily woken VM's image must be whole, and its pager hold all of
        // it, before a diff can be merged over it.
        match self.settled(&live, OP).await {
            None => return (Outcome::Cancelled, After::Kept(live)),
            Some(Err(error)) => {
                live.memory.base = Base::Unknown;
                return (failure(&error), After::Kept(live));
            }
            Some(Ok(())) => {}
        }
        notes::phase("settle");
        // A live VM's record never vouches for an image; this is a guard.
        if self.record.image
            && let Err(error) = self.commit(Change::new().image(false)).await
        {
            return (state_failure(&error), After::Kept(live));
        }
        let disk = checkpoint_disk(&self.paths);
        // A clone a crash left behind would stand in the new one's way.
        let stale = disk.clone();
        if let Err(error) = blocking(move || remove_if_present(&stale))
            .await
            .and_then(|removed| removed)
        {
            return (failure(&EngineError::io(OP, error)), After::Kept(live));
        }
        // From asking for the pause until the resume is done: at most the
        // time the guest stood still.
        let paused = std::time::Instant::now();
        if let Err(error) = self.engine.pause(&live.vm).await {
            return (failure(&error), After::Kept(live));
        }
        let captured = self.capture(&mut live, disk.clone()).await;
        // The VM runs again whatever the capture came to.
        let resumed = self.resume_paused(&live.vm, RESUME_FOR).await;
        notes::paused(paused.elapsed());
        notes::phase("resume");
        let outcome = match (captured, resumed) {
            (_, Err(error)) => {
                // Paused against the core's belief that it runs, and beyond
                // control: the VM ends, and the sandbox goes back to what it
                // has saved.
                tracing::error!(id = %self.id, %error, "a checkpoint could not resume the VM");
                notes::error(&error);
                Outcome::Failed(Failure::MemoryLost)
            }
            (Err(error), Ok(())) => {
                if live.memory.disk.failed() {
                    // No snapshot of this VM can be trusted again: it keeps
                    // running, with no further checkpoints or saves, until
                    // a new process replaces it.
                    tracing::error!(id = %self.id, %error, "the VM cannot be saved");
                    Outcome::Failed(Failure::Unsavable)
                } else {
                    failure(&error)
                }
            }
            (Ok(captured), Ok(())) => {
                // The guest runs from here: what its VM does counts as its
                // use, while the image is made and uploaded.
                let (meter, engine) = (self.meter.take(), Arc::clone(&self.engine));
                let metering = report_activity(&*engine, &live.vm, live.incarnation, meter);
                let base = &mut live.memory.base;
                let work = async {
                    match self.make_image(base, captured.image).await {
                        Ok(image) => {
                            self.publish(Captured {
                                image,
                                disk: captured.disk,
                                at_ms: captured.at_ms,
                            })
                            .await
                        }
                        Err(error) => failure(&error),
                    }
                };
                tokio::select! {
                    outcome = work => outcome,
                    never = metering => match never {},
                }
            }
        };
        let left = disk;
        if let Err(error) = blocking(move || remove_if_present(&left))
            .await
            .and_then(|removed| removed)
        {
            tracing::warn!(id = %self.id, %error, "checkpoint's disk clone not removed; the next checkpoint or recovery removes it");
        }
        (outcome, After::Kept(live))
    }

    /// Resumes the VM a checkpoint paused, trying again for up to `within`
    /// while the VMM answers that nothing changed, cancelled or not: the
    /// sandbox is in use, and the core believes it runs. Fails at once on
    /// a failure that may have changed something.
    pub(super) async fn resume_paused(
        &self,
        vm: &E::Vm,
        within: Duration,
    ) -> Result<(), EngineError> {
        let deadline = Instant::now() + within;
        let mut wait = RESUME_AGAIN_AFTER;
        loop {
            match self.engine.resume(vm).await {
                Err(error)
                    if error.kind == ErrorKind::Transient && Instant::now() + wait < deadline =>
                {
                    tracing::warn!(id = %self.id, %error, "a checkpoint's resume failed; trying again");
                    tokio::time::sleep(wait).await;
                    wait = (wait * 2).min(Duration::from_secs(1));
                }
                resumed => return resumed,
            }
        }
    }

    /// Captures the paused VM: a snapshot of its memory, from which an
    /// image is made once it runs again, and its disk as a clone at `disk`.
    async fn capture(
        &self,
        live: &mut Live<E::Vm>,
        disk: PathBuf,
    ) -> Result<Captured<Taken>, EngineError> {
        // The snapshot syncs the disk, and the image is only good with the
        // disk as it was then: the clone is taken after both, before the
        // guest runs again.
        let taken = match self.take_snapshot(live).await {
            Ok(taken) => taken,
            Err(error) => {
                live.memory.base = Base::Unknown;
                return Err(error);
            }
        };
        let at_ms = unix_ms_now();
        let (source, target) = (self.paths.disk.clone(), disk.clone());
        blocking(move || clone_jailed(&source, &target))
            .await
            .and_then(|cloned| cloned)
            .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))?;
        notes::phase("clone");
        Ok(Captured {
            image: taken,
            disk,
            at_ms,
        })
    }

    /// Archives what `captured` holds as the owner's next save, then
    /// records when it was captured. Images older than its image go first:
    /// the VM's next save is a diff over the new one.
    async fn publish(&mut self, captured: Captured<Verified>) -> Outcome {
        let images = images_of(&self.paths);
        let Captured { image, disk, at_ms } = captured;
        let generation = image.generation();
        let mapped = {
            let images = images.clone();
            blocking(move || {
                if let Err(error) = images.retire(&image, &[]) {
                    tracing::warn!(%error, "old memory images not removed");
                }
                images.chunk_map(&image).map(|chunks| (image, chunks))
            })
            .await
            .and_then(|mapped| mapped)
        };
        let (image, chunks) = match mapped {
            Ok(mapped) => mapped,
            Err(error) => return failure(&EngineError::io(OP, error)),
        };
        if self.cancel.is_cancelled() {
            return Outcome::Cancelled;
        }
        let profile = wake_profile(&self.paths);
        let files = SavedFiles {
            disk: JailedFile::new(&disk),
            memory: Some(SavedImage {
                state: images.state(generation),
                memory: images.memory(generation),
                chunks: Some(Arc::new(chunks.0)),
                runtime: image.meta().runtime.clone(),
            }),
            profile: profile.exists().then_some(profile),
        };
        if let Err(outcome) = self.archive_files(&files).await {
            return outcome;
        }
        notes::phase("upload");
        match self.commit(Change::new().backed_up(at_ms)).await {
            Ok(()) => Outcome::Done,
            Err(error) => state_failure(&error),
        }
    }
}

/// Sends readings of `vm`'s activity through `meter` at once and then every
/// [`Meter::every`], until dropped; without a meter, waits forever.
async fn report_activity<E: Engine>(
    engine: &E,
    vm: &E::Vm,
    incarnation: u64,
    meter: Option<Meter>,
) -> Infallible {
    let Some(meter) = meter else {
        return std::future::pending().await;
    };
    loop {
        (meter.send)(Reading::of(engine, vm, incarnation));
        tokio::time::sleep(meter.every).await;
    }
}
