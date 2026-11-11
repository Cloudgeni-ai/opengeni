//! The checkpoint step: a copy of a running sandbox's disk in object
//! storage, taken while it goes on running.
//!
//! A checkpoint copies the disk alone, never the memory, and never pauses
//! the VM ([ADR 34](../../../../docs/adr/0034-a-checkpoint-copies-the-disk-alone.md)).
//! The guest first writes its disks out, then the disk is cloned, sharing
//! every extent. The clone is one call the filesystem makes while it holds
//! the disk file's locks, which also hold back the VM's own writes to it,
//! so the clone holds the disk as it was at one instant, as a power cut
//! would leave it. The clone, which nothing changes any more, is then
//! archived as the owner's next save with no memory image, under the same
//! fences as an archive. The step owns the VM throughout, and the core runs
//! no other step for the sandbox until it ends, so no later save,
//! retirement or forgetting can overtake the copy while it uploads, and
//! its save number orders it before anything captured after it.
//!
//! A host lost while its sandbox runs costs the sandbox its programs in any
//! case: a memory image is always older than what the programs did since
//! ([ADR 10](../../../../docs/adr/0010-crash-safety-bar.md)). The next owner
//! boots the sandbox from the checkpoint's disk, with its files as they
//! were when it was cloned.
//!
//! The record goes on vouching for no local copy, since the VM moves on;
//! only its `backed_up_ms` moves, to when the clone was taken, once the
//! store holds it. Protection starts there, not when the step began.
//!
//! The guest runs throughout, so the step sends readings of the VM's
//! activity to the agent from start to end (see [`Meter`]): the guest's use
//! counts, and the copy's own work, done outside the VM, does not.

use std::convert::Infallible;
use std::path::Path;
use std::sync::Arc;

use compute_core::Outcome;
use compute_engine::{Engine, EngineError, ErrorKind};

use super::{After, Job, Live, Meter, Reading, blocking, checkpoint_disk, failure, state_failure};
use crate::layout::{clone_jailed, remove_if_present};
use crate::observe::notes;
use crate::state::{Change, unix_ms_now};
use crate::store::{JailedFile, SavedFiles, Store};

const OP: &str = "checkpoint";

impl<E: Engine, S: Store> Job<E, S> {
    /// Copies the running VM's disk to object storage while it goes on
    /// running; see the module's documentation.
    pub(super) async fn checkpoint(&mut self, live: Live<E::Vm>) -> (Outcome, After<E::Vm>) {
        let (meter, engine) = (self.meter.take(), Arc::clone(&self.engine));
        let metering = report_activity(&*engine, &live.vm, live.incarnation, meter.as_ref());
        let outcome = tokio::select! {
            outcome = self.copy_disk() => outcome,
            never = metering => match never {},
        };
        (outcome, After::Kept(live))
    }

    /// Clones the disk once the guest wrote it out, archives the clone, and
    /// removes it again, whatever came of it.
    async fn copy_disk(&mut self) -> Outcome {
        if self.cancel.is_cancelled() {
            // Nothing written yet.
            self.untouched = true;
            return Outcome::Cancelled;
        }
        // The disk it copies must hold what the guest wrote: after a lost
        // host the sandbox boots from that disk alone.
        if !self.sync_guest().await {
            // Cancelled while the guest was asked to write its disks out,
            // which trims them too: it may have freed space it can take
            // again, so the step counts as one that wrote, and the core
            // keeps what it booked until a reading measures the disk.
            return Outcome::Cancelled;
        }
        notes::phase("sync");
        // A live VM's record never vouches for an image; this is a guard.
        if self.record.image
            && let Err(error) = self.commit(Change::new().image(false)).await
        {
            return state_failure(&error);
        }
        let disk = checkpoint_disk(&self.paths);
        // A clone a crash left behind would stand in the new one's way.
        let stale = disk.clone();
        if let Err(error) = blocking(move || remove_if_present(&stale))
            .await
            .and_then(|removed| removed)
        {
            return failure(&EngineError::io(OP, error));
        }
        // The clone holds the disk as at some instant after this one.
        let at_ms = unix_ms_now();
        let (source, target) = (self.paths.disk.clone(), disk.clone());
        let cloned = blocking(move || clone_jailed(&source, &target))
            .await
            .and_then(|cloned| cloned);
        let outcome = if let Err(error) = cloned {
            failure(&EngineError::caused_by(ErrorKind::Transient, OP, error))
        } else {
            notes::phase("clone");
            self.publish(&disk, at_ms).await
        };
        let left = disk;
        if let Err(error) = blocking(move || remove_if_present(&left))
            .await
            .and_then(|removed| removed)
        {
            tracing::warn!(id = %self.id, %error, "checkpoint's disk clone not removed; the next checkpoint or recovery removes it");
        }
        outcome
    }

    /// Archives the disk clone at `disk` as the owner's next save, with no
    /// memory image, then records `at_ms`, when it was cloned.
    async fn publish(&mut self, disk: &Path, at_ms: u64) -> Outcome {
        if self.cancel.is_cancelled() {
            return Outcome::Cancelled;
        }
        let files = SavedFiles {
            disk: JailedFile::new(disk),
            memory: None,
            // The order its memory's pages are wanted in: nothing without
            // a memory image.
            profile: None,
            image: self.record.config.image,
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
    meter: Option<&Meter>,
) -> Infallible {
    let Some(meter) = meter else {
        return std::future::pending().await;
    };
    loop {
        (meter.send)(Reading::of(engine, vm, incarnation));
        tokio::time::sleep(meter.every).await;
    }
}
