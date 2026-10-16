//! Periodic sampling of host memory and of VM processor use and traffic.

use std::path::PathBuf;
use std::time::Duration;

use compute_core::{Input, Level, SandboxId};
use compute_engine::{Engine, PageSize};
use tokio::time::Instant;

use crate::protocol::Id;
use crate::restore_notice::ask_commands;
use crate::store::Store;

use super::{ActivityWindow, BusyRule, Event, HostAgent};

/// How long a quiet guest may take to say whether commands still run.
const ASK_LIMIT: Duration = Duration::from_secs(1);

impl<E: Engine, S: Store> HostAgent<E, S> {
    pub(super) fn sample(&mut self) {
        let huge = self.engine.memory_profile().pages == PageSize::Huge;
        self.available_memory = std::fs::read_to_string("/proc/meminfo")
            .ok()
            .and_then(|meminfo| available_memory(&meminfo, huge));
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
        if self.memory_policy.is_some()
            && let Some(available) = self.available_memory
        {
            // Ready sandboxes give their memory back first.
            let freeing = self.relieve_with_ready(available);
            batch.push(Input::Memory {
                available: available.saturating_add(freeing),
            });
        }
        self.inputs(batch);
        self.retire_unused();
        self.refill();
    }

    /// Finds running sandboxes whose VMs used enough processor time, or
    /// moved enough data, over the last window. A window starts afresh
    /// whenever the sandbox is not simply running, and whenever a step
    /// starts for it ([`HostAgent::start_step`]), so the work of waking,
    /// pausing or saving never counts, even when a whole pause and resume
    /// falls between two readings. Each signal counts only when it was read
    /// at both ends of the window, so one that cannot be read leaves the
    /// other to decide alone.
    pub(super) fn sample_busy(&mut self, rule: BusyRule) -> Vec<SandboxId> {
        let now = Instant::now();
        let mut busy = Vec::new();
        let mut quiet = Vec::new();
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
            let fresh = ActivityWindow {
                incarnation: live.incarnation,
                started: now,
                cpu,
                io,
            };
            match slot.activity {
                Some(window) if window.incarnation == live.incarnation => {
                    let elapsed = now.duration_since(window.started);
                    if elapsed >= rule.window {
                        let used = window
                            .cpu
                            .zip(cpu)
                            .map_or(Duration::ZERO, |(before, after)| {
                                after.saturating_sub(before)
                            });
                        let moved = window
                            .io
                            .zip(io)
                            .map_or(0, |(before, after)| after.saturating_sub(before));
                        if rule.is_busy(used, moved, elapsed) {
                            busy.push(*id);
                        } else {
                            quiet.push((*id, live.incarnation, slot.spec.vsock_path()));
                        }
                        slot.activity = Some(fresh);
                    }
                }
                _ => slot.activity = Some(fresh),
            }
        }
        self.ask_quiet(quiet);
        busy
    }

    /// Asks the guests of sandboxes that used neither processor nor traffic
    /// over their last window whether a command started through the guest's
    /// helper still runs; one that does counts as busy. Guests that do not
    /// answer change nothing.
    fn ask_quiet(&self, quiet: Vec<(SandboxId, u64, PathBuf)>) {
        let Some(port) = self.restore_notice_port else {
            return;
        };
        for (sandbox, incarnation, vsock) in quiet {
            let events = self.events_tx.clone();
            tokio::spawn(async move {
                match ask_commands(&vsock, port, ASK_LIMIT).await {
                    Ok(0) => {}
                    Ok(_) => {
                        let _ = events.send(Event::CommandsRunning {
                            sandbox,
                            incarnation,
                        });
                    }
                    Err(error) => tracing::trace!(id = %Id(sandbox), %error, "no command count"),
                }
            });
        }
    }

    /// A quiet guest still runs a command started through its helper: that
    /// counts as activity, if the VM asked is still the sandbox's and runs.
    pub(super) fn commands_running(&mut self, sandbox: SandboxId, incarnation: u64) {
        let current = self
            .slots
            .get(&sandbox)
            .and_then(|slot| slot.vm.as_ref())
            .is_some_and(|live| live.incarnation == incarnation);
        let running = self
            .core
            .sandbox(sandbox)
            .is_some_and(|view| view.state.level == Level::Running && view.step.is_none());
        if current && running {
            self.inputs(vec![Input::Busy { sandbox }]);
        }
    }
}

/// The memory a new guest can have, from `/proc/meminfo`. Guests on a
/// huge-page profile take their memory from the reserved pool, which
/// `MemAvailable` leaves out, so the smaller of the two counts.
fn available_memory(meminfo: &str, huge: bool) -> Option<u64> {
    let field = |name: &str| -> Option<u64> {
        let line = meminfo.lines().find(|line| line.starts_with(name))?;
        line.split_whitespace().nth(1)?.parse().ok()
    };
    let available = field("MemAvailable:")? * 1024;
    if !huge {
        return Some(available);
    }
    let pool = field("HugePages_Free:")? * field("Hugepagesize:")? * 1024;
    Some(available.min(pool))
}

#[cfg(test)]
mod tests {
    use super::available_memory;

    const MEMINFO: &str = "MemTotal: 131072000 kB
MemAvailable:   16777216 kB
HugePages_Total:   55000
HugePages_Free:     1024
Hugepagesize:       2048 kB
";

    #[test]
    fn huge_page_guests_count_the_free_pool() {
        assert_eq!(available_memory(MEMINFO, false), Some(16 << 30));
        assert_eq!(available_memory(MEMINFO, true), Some(2 << 30));
        assert_eq!(available_memory("MemAvailable: 4 kB\n", true), None);
    }
}
