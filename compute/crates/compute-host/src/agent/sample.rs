//! Periodic sampling of host memory and disk, and of VM processor use and
//! traffic.

use std::time::Duration;

use compute_core::{DiskSpace, Input, Level, SandboxId};
use compute_engine::Engine;
use tokio::time::Instant;

use crate::store::Store;

use super::{ActivityWindow, BusyRule, HostAgent};

impl<E: Engine, S: Store> HostAgent<E, S> {
    pub(super) fn sample(&mut self) {
        self.available_memory = read_available_memory();
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
        self.check_uncompressed();
        if self.pressure
            && let Some(available) = self.available_memory
        {
            batch.push(Input::Memory { available });
        }
        // The core ignores it without a disk policy.
        if let Some(available) = read_disk(&self.root) {
            batch.push(Input::Disk { available });
        }
        self.inputs(batch);
    }

    /// Finds running sandboxes whose VMs used enough processor time, or
    /// moved enough data, over the last window. A window starts afresh
    /// whenever the sandbox is not simply running, and whenever a step
    /// starts for it ([`HostAgent::start_step`]), so the work of waking,
    /// pausing or saving never counts, even when a whole pause and resume
    /// falls between two readings. Each signal counts only when it was read
    /// at both ends of the window, so one that cannot be read leaves the
    /// other to decide alone. A sandbox none of whose watched signals could
    /// be read counts as busy at once, whatever its window: putting a
    /// working guest to sleep costs far more than keeping an idle one awake
    /// a little longer. How many such sandboxes there are goes into the
    /// host's status.
    pub(super) fn sample_busy(&mut self, rule: BusyRule) -> Vec<SandboxId> {
        let now = Instant::now();
        let watching = rule.watches_cpu() || rule.watches_io();
        let mut busy = Vec::new();
        for (id, slot) in &mut self.slots {
            let running = self
                .core
                .sandbox(*id)
                .is_some_and(|view| view.state.level == Level::Running && view.step.is_none());
            let Some(live) = slot.vm.as_ref().filter(|_| running) else {
                slot.activity = None;
                continue;
            };
            let cpu = rule
                .watches_cpu()
                .then(|| self.engine.cpu_time(&live.vm).ok())
                .flatten();
            let io = rule
                .watches_io()
                .then(|| self.engine.io_bytes(&live.vm).ok())
                .flatten();
            let mut fresh = ActivityWindow {
                incarnation: live.incarnation,
                started: now,
                cpu,
                io,
                unseen: false,
            };
            if watching && cpu.is_none() && io.is_none() {
                // Nothing to judge by, now or at the end of any window: a
                // pause delay shorter than the window would otherwise let
                // a working guest fall asleep first.
                fresh.unseen = true;
                busy.push(*id);
                slot.activity = Some(fresh);
                continue;
            }
            match slot.activity {
                // A window that began unreadable has nothing to compare
                // against; one starts now.
                Some(window)
                    if window.incarnation == live.incarnation
                        && (window.cpu.is_some() || window.io.is_some()) =>
                {
                    let elapsed = now.duration_since(window.started);
                    if elapsed >= rule.window {
                        let used = window
                            .cpu
                            .zip(cpu)
                            .map(|(before, after)| after.saturating_sub(before));
                        let moved = window
                            .io
                            .zip(io)
                            .map(|(before, after)| after.saturating_sub(before));
                        fresh.unseen = used.is_none() && moved.is_none() && watching;
                        if fresh.unseen
                            || rule.is_busy(
                                used.unwrap_or(Duration::ZERO),
                                moved.unwrap_or(0),
                                elapsed,
                            )
                        {
                            busy.push(*id);
                        }
                        slot.activity = Some(fresh);
                    }
                }
                _ => slot.activity = Some(fresh),
            }
        }
        let unseen = self
            .slots
            .values()
            .filter(|slot| slot.activity.is_some_and(|window| window.unseen))
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
    fn check_uncompressed(&mut self) {
        for (id, slot) in &mut self.slots {
            let running = self
                .core
                .sandbox(*id)
                .is_some_and(|view| view.state.level == Level::Running && view.step.is_none());
            let Some(live) = slot.vm.as_ref().filter(|_| running) else {
                slot.compressed = None;
                continue;
            };
            let Ok(stats) = self.engine.memory_stats(&live.vm) else {
                continue;
            };
            if let Some((incarnation, before)) = slot.compressed
                && incarnation == live.incarnation
                && stats.zswpout > before
            {
                tracing::warn!(
                    sandbox = %crate::protocol::Id(*id),
                    pages = stats.zswpout - before,
                    "a running VM's memory was compressed into zswap"
                );
            }
            slot.compressed = Some((live.incarnation, stats.zswpout));
        }
    }
}

fn read_available_memory() -> Option<u64> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    let line = meminfo
        .lines()
        .find(|line| line.starts_with("MemAvailable:"))?;
    let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kib * 1024)
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
