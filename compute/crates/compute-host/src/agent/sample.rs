//! Periodic sampling of host memory and disk, and of VM processor use and
//! traffic.

use compute_core::{DiskSpace, Input, Level, SandboxId, Step};
use compute_engine::{Engine, PageSize};
use tokio::time::Instant;

use crate::step::Reading;
use crate::store::Store;

use super::{BusyRule, HostAgent};

impl<E: Engine, S: Store> HostAgent<E, S> {
    pub(super) fn sample(&mut self) {
        let huge = self.engine.memory_profile().pages == PageSize::Huge;
        self.available_memory = crate::host_memory::available(huge);
        #[cfg(target_os = "linux")]
        if let Some(fetcher) = &self.fetcher {
            fetcher.forget_old();
        }
        let mut batch: Vec<Input> = match self.busy {
            Some(rule) => self
                .sample_busy(rule)
                .into_iter()
                .map(|sandbox| Input::Busy { sandbox })
                .collect(),
            None => Vec::new(),
        };
        // Resident sizes always, so the status can report reclaimable
        // memory; they go in before the host total so relief is planned
        // from fresh numbers. The whole sweep is one batch, so no sleep
        // timer fires between two readings taken at the same moment.
        batch.extend(self.slots.iter().filter_map(|(id, slot)| {
            let live = slot.vm.as_ref()?;
            let bytes = self.engine.resident_bytes(&live.vm).ok()?;
            Some(Input::Resident {
                sandbox: *id,
                bytes,
            })
        }));
        // Ready sandboxes too, which count against the same budget.
        batch.extend(self.spare_readings());
        self.check_uncompressed();
        if self.memory_policy.is_some()
            && let Some(available) = self.available_memory
        {
            batch.push(Input::Memory { available });
        }
        // What disks may still grow by and which memory images are still
        // being filled, then the disk reading that shows what they took.
        // The core ignores them without a disk policy.
        batch.extend(self.disk_readings());
        if let Some(available) = read_disk(&self.root) {
            batch.push(Input::Disk { available });
        }
        let resident: Vec<(Level, u64)> = batch
            .iter()
            .filter_map(|input| match input {
                Input::Resident { sandbox, bytes } => {
                    Some((self.core.sandbox(*sandbox)?.state.level, *bytes))
                }
                _ => None,
            })
            .collect();
        self.inputs(batch);
        let gauges = self.gauges(resident.into_iter());
        self.observer.metrics().set_gauges(&gauges);
        self.summarize();
        self.retire_unused();
        self.retire_unused_images();
        self.refill();
    }

    /// Finds running sandboxes whose guests count as busy by `rule` (see
    /// [`super::usage`]): the agent reads each VM that simply runs, and a
    /// checkpoint lends what it reads of the VM it holds. How many
    /// sandboxes count as busy because nothing could be read goes into the
    /// host's status.
    pub(super) fn sample_busy(&mut self, rule: BusyRule) -> Vec<SandboxId> {
        let now = Instant::now();
        let mut busy = Vec::new();
        for (id, slot) in &mut self.slots {
            let view = self.core.sandbox(*id);
            let own = match (&slot.vm, view) {
                (Some(live), Some(view))
                    if view.state.level == Level::Running && view.step.is_none() =>
                {
                    Some(Reading {
                        incarnation: live.incarnation,
                        at: now,
                        cpu: rule
                            .watches_cpu()
                            .then(|| self.engine.cpu_time(&live.vm).ok())
                            .flatten(),
                        io: rule
                            .watches_io()
                            .then(|| self.engine.io_bytes(&live.vm).ok())
                            .flatten(),
                        last_before_pause: false,
                    })
                }
                (None, Some(view)) if view.runs() && view.step == Some(Step::Checkpoint) => None,
                _ => {
                    slot.usage.stopped();
                    continue;
                }
            };
            if slot.usage.sample(own, rule) {
                busy.push(*id);
            }
        }
        let unseen = self
            .slots
            .values()
            .filter(|slot| slot.usage.unseen())
            .count();
        if unseen > self.unseen_activity {
            tracing::warn!(
                sandboxes = unseen,
                "activity of running sandboxes cannot be read; they count as busy"
            );
        }
        self.unseen_activity = unseen;
        busy
    }
}

impl<E: Engine, S: Store> HostAgent<E, S> {
    /// Warns when a running VM's memory was compressed into zswap between
    /// two samples: only a paused one may be, so this is a defect, and the
    /// sandbox would slow down unnoticed while it pages back in.
    ///
    /// The reading is kept for the sandbox's summary (see
    /// [`HostAgent::summarize`]).
    fn check_uncompressed(&mut self) {
        for (id, slot) in &mut self.slots {
            let running = self
                .core
                .sandbox(*id)
                .is_some_and(|view| view.state.level == Level::Running && view.step.is_none());
            let Some(live) = slot.vm.as_ref().filter(|_| running) else {
                slot.stats = None;
                continue;
            };
            let Ok(stats) = self.engine.memory_stats(&live.vm) else {
                continue;
            };
            if let Some((incarnation, before)) = slot.stats
                && incarnation == live.incarnation
                && stats.zswpout > before.zswpout
            {
                tracing::warn!(
                    sandbox = %crate::protocol::Id(*id),
                    pages = stats.zswpout - before.zswpout,
                    "a running VM's memory was compressed into zswap"
                );
            }
            slot.stats = Some((live.incarnation, stats));
        }
    }
}

/// What the filesystem holding the state root has available to the agent.
/// One without a fixed number of inodes, such as btrfs, reports none, and
/// never runs out of them.
fn read_disk(root: &std::path::Path) -> Option<DiskSpace> {
    let stat = rustix::fs::statvfs(root).ok()?;
    Some(DiskSpace {
        bytes: stat.f_bavail.saturating_mul(stat.f_frsize),
        inodes: if stat.f_files == 0 {
            u64::MAX
        } else {
            stat.f_favail
        },
    })
}
