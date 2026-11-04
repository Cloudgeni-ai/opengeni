//! What a sandbox reserves on this host, and the sleep policy it gets
//! here.

use compute_core::{Size, SleepPolicy};
use compute_engine::Engine;

use super::{HostAgent, SAVE_EXTRA};
use crate::protocol::SandboxConfig;
use crate::state::Record;
use crate::store::Store;

impl<E: Engine, S: Store> HostAgent<E, S> {
    /// Validates a sandbox's settings and fits its sleep policy to this
    /// host.
    pub(super) fn sleep_policy(&self, config: &SandboxConfig) -> Result<SleepPolicy, String> {
        config.validate()?;
        let mut rules = config.sleep.rules();
        rules.compress_under_pressure &= self.can_compress;
        // A checkpoint clones the disk while its VM is paused. Where files
        // cannot share extents that would copy the whole disk with the VM
        // paused, so such a host takes none (its status says so), and its
        // sandboxes reach the store only as they sleep.
        if !self.shares_extents() {
            rules.checkpoint_every = None;
        }
        SleepPolicy::new(rules).map_err(|error| format!("invalid sleep settings: {error}"))
    }

    /// Whether files under the state root share extents, which checkpoints
    /// need: a save then writes one copy of memory at most.
    pub(super) const fn shares_extents(&self) -> bool {
        self.save_copies == 1
    }

    /// What a sandbox of `config` whose disk is `disk_bytes` long reserves
    /// and may use of host memory, and what one save of it may write: the
    /// memory that changed, the merged image where files cannot share
    /// extents, and its device state and chunk map; what its disk may grow
    /// by while it runs; and what a wake from object storage writes
    /// locally: its disk, the memory image its pager fills, and its device
    /// state. A disk of unknown length counts as a copy of its image as it
    /// is today grown to the length `config` asks for, as a new sandbox's
    /// is.
    pub(super) fn size(&self, config: &SandboxConfig, disk_bytes: Option<u64>) -> Size {
        let limit = u64::from(config.memory_mib) << 20;
        let request = if self.reserve_whole {
            limit
        } else {
            u64::from(config.memory_request()) << 20
        };
        let disk = disk_bytes.map_or_else(
            || self.new_disk_bound(config),
            |length| crate::disk_growth::disk_bound(length, self.allocation_unit),
        );
        Size {
            request,
            limit,
            cpu: u64::from(config.cpu_request()),
            save: limit * self.save_copies + SAVE_EXTRA,
            disk,
            fetch: disk
                .saturating_add(limit.next_multiple_of(self.allocation_unit.max(1)))
                .saturating_add(SAVE_EXTRA),
        }
    }

    /// [`Self::size`] for the sandbox `record` describes.
    pub(super) fn record_size(&self, record: &Record) -> Size {
        self.size(&record.config, record.allocation.disk_bytes)
    }
}
