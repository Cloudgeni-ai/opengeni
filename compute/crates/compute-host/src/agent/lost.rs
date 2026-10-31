//! VM processes that end: the agent watches each it takes charge of, tells
//! how one ended (on its own, its memory lost, or killed by the guard when
//! the lease ran out), keeps its last words, and tears it down.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use compute_core::Input;
use compute_engine::{Engine, LastWords, VmSpec};
use tokio::time::sleep;

use crate::layout::{Paths, vm_spec};
use crate::observe::{Alarm, Cause};
use crate::protocol::Id;
use crate::step::{Live, LiveMemory};
use crate::store::Store;

use super::observe::Why;
use super::{End, Event, Exit, HostAgent, TEARDOWN_RETRY};

/// How long the teardown of a lost VM waits to read what its logs last
/// said before it ends the VM anyway (see [`HostAgent::reap`]).
const LAST_WORDS_WAIT: Duration = Duration::from_secs(2);

/// How long after the guard records ending a VM the VM's end still counts
/// as the guard's doing. The agent usually hears of it within moments, but
/// the host stalls that lose a lease can stall the agent too, and the
/// record names the VM, so a long window costs nothing.
const FENCED_WITHIN: Duration = Duration::from_secs(600);

impl<E: Engine, S: Store> HostAgent<E, S> {
    /// Takes charge of a VM process, started by a step or found still
    /// running, and watches for it dying on its own.
    pub(super) fn own(&mut self, id: Id, vm: E::Vm, memory: LiveMemory) -> Live<E::Vm> {
        let incarnation = self.next_incarnation;
        self.next_incarnation += 1;
        let owned = crate::fleet::boot_now();
        let stopping = Arc::new(AtomicBool::new(false));
        let exited = self.engine.exited(&vm);
        let events = self.events_tx.clone();
        let deliberate = Arc::clone(&stopping);
        let memory_lost = memory.failed();
        tokio::spawn(async move {
            let lost = memory_lost;
            let end = tokio::select! {
                () = exited => End::Exited,
                // Its memory can no longer be served: the next page fault
                // would wait forever, so it counts as dead.
                () = lost => End::MemoryLost,
            };
            if !deliberate.load(Ordering::Acquire) {
                let _ = events.send(Event::Exited(Exit {
                    id,
                    incarnation,
                    end,
                    owned,
                }));
            }
        });
        Live {
            vm,
            incarnation,
            stopping,
            memory,
        }
    }

    /// Ends a dead VM process and releases what it held, in the
    /// background. Nothing new starts for the sandbox until that is done, so
    /// the teardown never touches a newer VM's jail. A VM that was `lost`
    /// first has its logs' last words kept, as a `compute.vm.lost` event:
    /// its sandbox, and the logs with it, may be removed once it is gone.
    pub(super) fn reap(&mut self, id: Id, live: Live<E::Vm>, lost: Option<End>) {
        live.stopping.store(true, Ordering::Release);
        *self.tearing_down.entry(id.0).or_default() += 1;
        let spec = match self.slots.get(&id.0) {
            Some(slot) => Some(VmSpec::clone(&slot.spec)),
            None => self
                .records
                .get(id)
                .map(|record| vm_spec(&record, &Paths::of(&self.root, &record), &self.images)),
        };
        let engine = Arc::clone(&self.engine);
        let words = lost.map(|end| (end, engine.last_words(&live.vm)));
        let observer = self.observer.clone();
        // Keeps the state root locked until the teardown ends, so a
        // successor agent cannot start beside it.
        let records = Arc::clone(&self.records);
        let shutdown = self.shutdown.clone();
        let events = self.events_tx.clone();
        self.teardowns.spawn(async move {
            let _records = records;
            if let Some((end, words)) = words {
                // Bounded: a VM ended for host memory frees it only once
                // stopped, and a pressed host may be slow to read.
                let words = tokio::time::timeout(LAST_WORDS_WAIT, words)
                    .await
                    .unwrap_or_else(|_| LastWords {
                        guest: format!("(its logs were not read within {LAST_WORDS_WAIT:?})"),
                        ..LastWords::default()
                    });
                observer.emit(lost_event(id, end, words));
            }
            live.memory.ending();
            let mut result = engine.stop(live.vm).await;
            let mut delay = Duration::from_millis(100);
            while let Err(error) = &result {
                tracing::error!(%id, %error, "could not tear down a dead VM; retrying");
                let Some(spec) = &spec else {
                    break;
                };
                tokio::select! {
                    // The next agent finishes it when it adopts or cleans up.
                    () = shutdown.cancelled() => break,
                    () = sleep(delay) => {}
                }
                delay = (delay * 2).min(TEARDOWN_RETRY);
                result = engine.clean_up(spec).await;
            }
            // Only once the process is gone: its pager may still serve it.
            // A wake from the same image starts only after this teardown,
            // so the old hydration never writes beside a new one.
            if result.is_ok() {
                live.memory.close().await;
            }
            let _ = events.send(Event::TornDown { id });
        });
    }

    /// One of `id`'s dead VMs is gone; once none is left, whatever waited
    /// for that proceeds.
    pub(super) fn torn_down(&mut self, id: Id) {
        if let Some(count) = self.tearing_down.get_mut(&id.0) {
            *count = count.saturating_sub(1);
            if *count > 0 {
                return;
            }
            self.tearing_down.remove(&id.0);
        }
        let Some(slot) = self.slots.get_mut(&id.0) else {
            return;
        };
        if let Some(step) = slot.deferred.take() {
            if let Some(op) = slot.op.as_ref().map(|running| running.op) {
                self.spawn_job(id, op, step);
            }
        } else if slot.destroy && slot.op.is_none() {
            self.destroy_now(id);
        }
    }

    /// A watched VM process went without the agent ending it.
    pub(super) fn on_exit(&mut self, exit: &Exit) {
        let end = self.why_ended(exit.id, exit.end, exit.owned);
        self.exited(exit.id, exit.incarnation, end);
    }

    /// Ends the sandbox's VM process `incarnation`, which went as `end`
    /// says (already told apart from a guard's kill).
    pub(super) fn exited(&mut self, id: Id, incarnation: u64, end: End) {
        if self.ready_exited(id, incarnation, end) {
            return;
        }
        // A claimed ready sandbox's VM was watched under its host name.
        let id = self.hosts.get(&id.0).map_or(id, |public| Id(*public));
        let Some(slot) = self.slots.get_mut(&id.0) else {
            return;
        };
        if slot.incarnation != Some(incarnation) {
            return;
        }
        match end {
            End::MemoryLost => tracing::warn!(
                %id,
                "VM's memory can no longer be served; ending it, and running programs are lost"
            ),
            End::Fenced => {
                let what = "the guard ended the VM: it had not frozen by the time the host's lease \
                            with the control service ran out; running programs are lost";
                tracing::error!(%id, "{what}");
                self.alarm(id, Alarm::Fenced, what);
            }
            _ => tracing::warn!(%id, "VM process ended on its own; running programs are lost"),
        }
        self.lost_vm(id, incarnation, end);
    }

    /// How the VM of sandbox `id` ended, which its process alone said was
    /// `end`: [`End::Fenced`] for one that ended on its own, or whose
    /// memory could no longer be served, as a killed VM's pager can tell
    /// first, when the guard recorded ending it shortly before, and since
    /// the agent took this VM process on at `owned`: a kill before then was
    /// of an earlier VM of the same sandbox. The guard names a VM by its
    /// group, which is named after the sandbox the host made it for, a
    /// ready VM's own id for one a create claimed.
    fn why_ended(&self, id: Id, end: End, owned: compute_core::At) -> End {
        if !matches!(end, End::Exited | End::MemoryLost) {
            return end;
        }
        let Some(freezes) = &self.guard_freezes else {
            return end;
        };
        let since = owned.max(compute_core::At::from_duration(
            crate::fleet::boot_now()
                .since_origin()
                .saturating_sub(FENCED_WITHIN),
        ));
        let name = self.records.get(id).map_or(id, |record| record.host());
        if freezes.fenced().ended(&name.to_string(), since) {
            End::Fenced
        } else {
            end
        }
    }

    /// Ends VM process `incarnation` of `id`, which is lost (it ended on its
    /// own, or its guest stopped), as `end` says, and tells the core.
    pub(super) fn lost_vm(&mut self, id: Id, incarnation: u64, end: End) {
        let Some(slot) = self.slots.get_mut(&id.0) else {
            return;
        };
        // Whatever starts it again puts things right.
        slot.asked = Some(Why::plain(Cause::Recovery));
        if let Some(live) = slot.vm.take() {
            slot.incarnation = None;
            self.reap(id, live, Some(end));
        } else {
            // A step holds it and will hand it back.
            slot.dead = Some((incarnation, end));
        }
        self.input(Input::Lost { sandbox: id.0 });
    }
}

/// The event that keeps what a lost VM's logs last said (see
/// [`HostAgent::reap`]): how it was lost, and its guest's, VMM's and
/// pager's last lines.
fn lost_event(id: Id, end: End, words: LastWords) -> crate::observe::Event {
    crate::observe::Event::new("compute.vm.lost", crate::observe::Severity::Warn)
        .with("compute.sandbox.id", id.to_string())
        .with("compute.vm.end", end.name())
        .with("compute.vm.guest_said", words.guest)
        .with("compute.vm.vmm_said", words.vmm)
        .with("compute.vm.pager_said", words.pager)
}
