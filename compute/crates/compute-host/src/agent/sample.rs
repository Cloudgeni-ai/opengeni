//! Periodic sampling of host memory and VM processor use.

use compute_core::{Input, Level, SandboxId};
use compute_engine::Engine;
use tokio::time::Instant;

use crate::store::Store;

use super::{BusyRule, CpuWindow, HostAgent};

impl<E: Engine, S: Store> HostAgent<E, S> {
    pub(super) fn sample(&mut self) {
        self.available_memory = read_available_memory();
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
        if self.pressure
            && let Some(available) = self.available_memory
        {
            batch.push(Input::Memory { available });
        }
        self.inputs(batch);
    }

    /// Finds running sandboxes whose VMs used enough processor time over the
    /// last window. A window starts afresh whenever the sandbox is not simply
    /// running, so time spent waking or pausing never counts.
    pub(super) fn sample_busy(&mut self, rule: BusyRule) -> Vec<SandboxId> {
        let now = Instant::now();
        let mut busy = Vec::new();
        for (id, slot) in &mut self.slots {
            let running = self
                .core
                .sandbox(*id)
                .is_some_and(|view| view.state.level == Level::Running && view.step.is_none());
            let Some(live) = slot.vm.as_ref().filter(|_| running) else {
                slot.cpu = None;
                continue;
            };
            let Ok(cpu) = self.engine.cpu_time(&live.vm) else {
                slot.cpu = None;
                continue;
            };
            let fresh = CpuWindow {
                incarnation: live.incarnation,
                started: now,
                cpu,
            };
            match slot.cpu {
                Some(window) if window.incarnation == live.incarnation => {
                    let elapsed = now.duration_since(window.started);
                    if elapsed >= rule.window {
                        if rule.is_busy(cpu.saturating_sub(window.cpu), elapsed) {
                            busy.push(*id);
                        }
                        slot.cpu = Some(fresh);
                    }
                }
                _ => slot.cpu = Some(fresh),
            }
        }
        busy
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
