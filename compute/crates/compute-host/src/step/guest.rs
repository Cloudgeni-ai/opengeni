//! What a step tells the guest, over its notice port (see
//! [`crate::restore_notice`]): that it was restored, and to write its disks
//! out before it is saved; and, through its VMM, that its disk grew.

use std::time::{Duration, Instant};

use compute_core::{Failure, Outcome};
use compute_engine::{Engine, EngineError};

use super::Job;
use crate::restore_notice::{ask_sync, tell_restored};
use crate::state::{Change, Identity};
use crate::store::Store;

/// How long a restore keeps trying to tell the guest of it. A listening
/// guest answers in milliseconds, but only once its kernel has handled the
/// vsock transport reset that follows every restore; under a burst of
/// restores that can take a while.
const NOTICE_DEADLINE: Duration = Duration::from_secs(5);
/// The same for a guest that must learn which sandbox it is. It is never
/// used without answering, and the alternative, booting from its disk, is
/// slower still under the same burst: a burst of 100 restores on a nested
/// host keeps many guests from answering for well over five seconds.
const IDENTITY_DEADLINE: Duration = Duration::from_secs(30);

/// Longest a pause to save the guest, or to checkpoint it, waits for the
/// guest to write out what it holds for its disks. One that takes longer
/// is saved anyway, its disk then as after a power cut.
const SYNC_LIMIT: Duration = Duration::from_secs(10);

impl<E: Engine, S: Store> Job<E, S> {
    /// Tells a guest restored from its template's memory, before it runs,
    /// how long its disk is: that memory knows the template's disk, and the
    /// sandbox's own may have been made longer (see
    /// [`compute_engine::Engine::resize_drives`]). A guest that has yet to
    /// learn which sandbox it is still runs on that memory; one that asked
    /// for no disk length kept the template's.
    pub(super) async fn tell_disk_length(&self, vm: &E::Vm) -> Result<(), EngineError> {
        if self.record.identity != Identity::Pending || self.record.config.disk_mib.is_none() {
            return Ok(());
        }
        self.engine.resize_drives(vm, &self.spec).await
    }

    /// Has the running guest write out what it holds for its disks before
    /// it pauses to be saved, so its saved disk is whole without the memory
    /// saved beside it, as when its host is lost (see
    /// [`crate::restore_notice::ask_sync`]). A guest that does not answer
    /// in [`SYNC_LIMIT`] is paused anyway. `false` once the step is
    /// cancelled meanwhile, with nothing changed.
    pub(super) async fn sync_guest(&self) -> bool {
        let Some(port) = self.restore_notice_port else {
            return true;
        };
        let vsock = self.spec.vsock_path();
        let started = Instant::now();
        tokio::select! {
            () = self.cancel.cancelled() => false,
            synced = ask_sync(&vsock, port, SYNC_LIMIT) => {
                match synced {
                    Ok(()) => tracing::debug!(id = %self.id, us = started.elapsed().as_micros(), "guest wrote its disks out"),
                    Err(error) => tracing::warn!(id = %self.id, %error, "guest did not write its disks out; saved as it is"),
                }
                true
            }
        }
    }

    /// Lets the guest fix its clock, drop dead connections and learn which
    /// sandbox it is before the sandbox counts as awake.
    ///
    /// Failing to is not fatal for a guest that knows which sandbox it is:
    /// a guest without an agent still runs, just with a stale clock. One
    /// that does not (see [`Identity::Pending`]) must acknowledge the notice
    /// before anything may use it, so otherwise this reports its memory
    /// lost: the caller's VM is ended, and the sandbox's next wake boots
    /// from its disk, where the guest finds its id on the kernel command
    /// line and must still acknowledge the notice (see `boot`).
    pub(super) async fn tell_guest_restored(&mut self) -> Result<(), Outcome> {
        const LOST: Outcome = Outcome::Failed(Failure::MemoryLost);
        let must = self.record.identity == Identity::Pending;
        let Some(port) = self.restore_notice_port else {
            if must {
                tracing::error!(id = %self.id, "the guest must learn which sandbox it is, but no restore notice port is set");
                return Err(LOST);
            }
            return Ok(());
        };
        let started = Instant::now();
        let deadline = if must {
            IDENTITY_DEADLINE
        } else {
            NOTICE_DEADLINE
        };
        // Every way here wrote the record since the guest's last notice, so
        // its fence is above that notice's, if this owner sent it; one from
        // an earlier owner (on another host, whose record this one does not
        // continue) is at a lower epoch.
        let order = (
            self.record.owner_epoch,
            self.record.generation,
            self.record.revision,
        );
        match tell_restored(&self.spec.vsock_path(), port, self.id, order, deadline).await {
            Ok(told) if must && !told.seeded => {
                // It took its id but draws the numbers every other clone
                // of its snapshot draws.
                tracing::error!(id = %self.id, "the guest did not apply the restore notice's seed; it is not used");
                return Err(LOST);
            }
            Ok(told) => tracing::debug!(
                id = %self.id,
                us = started.elapsed().as_micros(),
                attempts = told.attempts,
                seeded = told.seeded,
                "guest acknowledged the restore"
            ),
            Err(error) if must => {
                tracing::error!(id = %self.id, %error, "the guest did not learn which sandbox it is; it is not used");
                return Err(LOST);
            }
            Err(error) => {
                tracing::warn!(id = %self.id, %error, "guest not told of its restore");
                return Ok(());
            }
        }
        if must && let Err(error) = self.commit(Change::new().identity(Identity::Known)).await {
            // A record that still says the guest must be told ends the VM
            // after a restart anyway.
            tracing::error!(id = %self.id, %error, "could not record that the guest knows which sandbox it is");
            return Err(LOST);
        }
        Ok(())
    }
}
