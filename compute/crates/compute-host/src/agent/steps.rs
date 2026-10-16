//! Carrying out the core's decisions: steps, VM processes, teardown and
//! removal.

use std::io;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use compute_core::{Action, Durability, Failure, Input, Level, Notice, OpId, Outcome, State, Step};
use compute_engine::{CancellationToken, Engine, VmSpec};
use tokio::time::{Instant, sleep};

use crate::layout::{Paths, vm_spec};
use crate::net::Networks;
use crate::pool::Loaning;
use crate::protocol::Id;
use crate::state::{Change, Fence, Record, Records};
use crate::step::{After, Job, Live, LiveMemory};
use crate::store::Store;

use super::{Event, HostAgent, HostError, Reply, Running, TEARDOWN_RETRY, Woke};

impl<E: Engine, S: Store> HostAgent<E, S> {
    pub(super) fn on_event(&mut self, event: Event<E::Vm>) {
        match event {
            Event::Prepared {
                id,
                ordinal,
                result,
                reply,
                stale,
            } => {
                self.preparing.remove(&id.0);
                if let Some(template) = &stale {
                    self.template_stale(template);
                }
                let record = match result {
                    Ok(record) => record,
                    Err(error) => {
                        self.ordinals.remove(&ordinal);
                        let _ = reply.send(Err(error));
                        return;
                    }
                };
                let Ok(policy) = self.sleep_policy(&record.config) else {
                    return;
                };
                let paths = Paths::new(&self.root, id);
                let spec = vm_spec(&record, &paths, &self.images);
                self.insert(id, paths, spec);
                // A new sandbox is a saved one: a disk, with a memory image
                // when it started from a template. Its first wake boots or
                // restores it, under the same admission limits as any wake.
                self.input(Input::Add {
                    sandbox: id.0,
                    state: State::new(Level::Saved, Durability::Local, record.image),
                    policy,
                });
                let _ = reply.send(Ok(()));
            }
            Event::StepDone {
                id,
                op,
                outcome,
                after,
                launches,
            } => self.step_done(id, op, outcome, after, launches),
            Event::Loan(Loaning::Borrow {
                loan,
                step,
                granted,
            }) => {
                self.loans.insert(loan, granted);
                self.input(Input::Borrow { loan, step });
            }
            Event::Loan(Loaning::Return(loan)) => {
                self.loans.remove(&loan);
                self.input(Input::Return { loan });
            }
            Event::Unthrottled { id, op } => self.input(Input::Unthrottled { sandbox: id.0, op }),
            Event::Exited { id, incarnation } => self.exited(id, incarnation),
            Event::TemplateBuilt {
                shape,
                ordinal,
                built,
            } => self.template_built(shape, ordinal, built),
            Event::Destroyed {
                id,
                ordinal,
                result,
            } => {
                // A removal that stopped part way keeps its ordinal, and its
                // id stays blocked until removing it again or the next
                // start of the agent finishes it.
                match &result {
                    Ok(()) => {
                        if let Some(ordinal) = ordinal {
                            self.ordinals.remove(&ordinal);
                        }
                        self.leftovers.remove(&id.0);
                    }
                    Err(error) => {
                        self.block(id, format!("removal failed: {error}"));
                        if self.records.get(id).is_none() {
                            self.leftovers.insert(id.0, ordinal);
                        }
                    }
                }
                for remover in self.destroying.remove(&id.0).unwrap_or_default() {
                    let _ = remover.send(result.clone());
                }
            }
            Event::TornDown { id } => self.torn_down(id),
        }
    }

    pub(super) fn execute(&mut self, action: Action) {
        match action {
            Action::Start { sandbox, op, step } => self.start_step(Id(sandbox), op, step),
            Action::Cancel { sandbox, op } => {
                let Some(slot) = self.slots.get_mut(&sandbox) else {
                    return;
                };
                let Some(running) = slot.op.as_ref().filter(|running| running.op == op) else {
                    return;
                };
                running.cancel.cancel();
                if slot.deferred.take().is_some() {
                    // It never started, so nothing changed.
                    let after = slot.vm.take().map_or(After::NoVm, After::Kept);
                    let _ = self.events_tx.send(Event::StepDone {
                        id: Id(sandbox),
                        op,
                        outcome: Outcome::Cancelled,
                        after,
                        launches: 0,
                    });
                }
            }
            Action::Destroy { sandbox } => {
                if let Some(slot) = self.slots.get_mut(&sandbox) {
                    slot.destroy = true;
                    if slot.op.is_none() && !self.tearing_down.contains_key(&sandbox) {
                        self.destroy_now(Id(sandbox));
                    }
                }
            }
            Action::Notify { sandbox, notice } => self.notify(Id(sandbox), notice),
            Action::Lend { loan } => {
                if let Some(granted) = self.loans.remove(&loan) {
                    let _ = granted.send(());
                }
            }
        }
    }

    pub(super) fn start_step(&mut self, id: Id, op: OpId, step: Step) {
        let Some(slot) = self.slots.get_mut(&id.0) else {
            tracing::error!(%id, ?step, "step for a sandbox the host does not have");
            let _ = self.events_tx.send(Event::StepDone {
                id,
                op,
                outcome: Outcome::Failed(Failure::Fatal),
                after: After::NoVm,
                launches: 0,
            });
            return;
        };
        slot.op = Some(Running {
            op,
            step,
            cancel: CancellationToken::new(),
            started: Instant::now(),
        });
        self.stats[step.index()].started += 1;
        if self.tearing_down.contains_key(&id.0) {
            // A dead VM's teardown still owns this sandbox's jail; the step
            // starts once it is done.
            slot.deferred = Some(step);
            return;
        }
        self.spawn_job(id, op, step);
    }

    /// Runs the step the slot's `op` names.
    pub(super) fn spawn_job(&mut self, id: Id, op: OpId, step: Step) {
        let (Some(slot), Some(record)) = (self.slots.get_mut(&id.0), self.records.get(id)) else {
            tracing::error!(%id, ?step, "step for a sandbox without a record");
            let _ = self.events_tx.send(Event::StepDone {
                id,
                op,
                outcome: Outcome::Failed(Failure::Fatal),
                after: After::NoVm,
                launches: 0,
            });
            return;
        };
        let Some(cancel) = slot.op.as_ref().map(|running| running.cancel.clone()) else {
            return;
        };
        // A step that may run while a VM process exists owns it until the
        // step finishes; archiving a paused VM's saved copy hands it back.
        let needs_vm = matches!(
            step,
            Step::Pause | Step::Resume | Step::Compress | Step::Save | Step::Drop | Step::Archive
        );
        let events = self.events_tx.clone();
        let job = Job {
            engine: Arc::clone(&self.engine),
            store: Arc::clone(&self.store),
            records: Arc::clone(&self.records),
            record,
            id,
            spec: VmSpec::clone(&slot.spec),
            paths: Paths::clone(&slot.paths),
            cancel,
            live: if needs_vm { slot.vm.take() } else { None },
            restore_notice_port: self.restore_notice_port,
            base_image: self.base_image.clone(),
            kernel: self.images.kernel.clone(),
            #[cfg(target_os = "linux")]
            fetcher: self.fetcher.clone(),
            launches: 0,
            unthrottle: Some({
                let events = events.clone();
                Box::new(move || {
                    let _ = events.send(Event::Unthrottled { id, op });
                })
            }),
        };
        tokio::spawn(async move {
            let ran = job.run(step).await;
            let _ = events.send(Event::StepDone {
                id,
                op,
                outcome: ran.outcome,
                after: ran.after,
                launches: ran.launches,
            });
        });
    }

    pub(super) fn step_done(
        &mut self,
        id: Id,
        op: OpId,
        outcome: Outcome,
        after: After<E::Vm>,
        launches: u32,
    ) {
        let fresh = match after {
            After::New(vm, memory) => Some(self.own(id, vm, memory)),
            After::Kept(live) => Some(live),
            After::NoVm => None,
        };
        let mut reap = None;
        let mut destroy = false;
        if let Some(slot) = self.slots.get_mut(&id.0) {
            slot.launches += u64::from(launches);
            if let Some(running) = slot.op.take().filter(|running| running.op == op) {
                let stats = &mut self.stats[running.step.index()];
                let micros =
                    u64::try_from(running.started.elapsed().as_micros()).unwrap_or(u64::MAX);
                stats.total_us = stats.total_us.saturating_add(micros);
                stats.max_us = stats.max_us.max(micros);
                tracing::debug!(%id, step = ?running.step, micros, ?outcome, "step finished");
                match outcome {
                    Outcome::Done => stats.done += 1,
                    Outcome::Cancelled => stats.cancelled += 1,
                    Outcome::Failed(_) => stats.failed += 1,
                }
            }
            match fresh {
                // A process that already ended on its own only needs its
                // resources released. One that lost its memory was ended by
                // the step before it reported.
                Some(live) if slot.dead == Some(live.incarnation) => {
                    slot.incarnation = None;
                    slot.dead = None;
                    reap = Some(live);
                }
                Some(live) => {
                    debug_assert_ne!(outcome, Outcome::Failed(Failure::MemoryLost));
                    slot.incarnation = Some(live.incarnation);
                    slot.vm = Some(live);
                }
                None => {
                    slot.incarnation = None;
                    slot.dead = None;
                }
            }
            destroy = slot.destroy;
        } else {
            reap = fresh;
        }
        if let Some(live) = reap {
            self.reap(id, live);
        }
        self.input(Input::Finished {
            sandbox: id.0,
            op,
            outcome,
        });
        if destroy {
            if !self.tearing_down.contains_key(&id.0) {
                self.destroy_now(id);
            }
        } else {
            self.settle(id);
        }
    }

    /// Takes charge of a VM process, started by a step or found still
    /// running, and watches for it dying on its own.
    pub(super) fn own(&mut self, id: Id, vm: E::Vm, memory: LiveMemory) -> Live<E::Vm> {
        let incarnation = self.next_incarnation;
        self.next_incarnation += 1;
        let stopping = Arc::new(AtomicBool::new(false));
        let exited = self.engine.exited(&vm);
        let events = self.events_tx.clone();
        let deliberate = Arc::clone(&stopping);
        let memory_lost = memory.failed();
        tokio::spawn(async move {
            let lost = memory_lost;
            tokio::select! {
                () = exited => {}
                // Its memory can no longer be served: the next page fault
                // would wait forever, so it counts as dead.
                () = lost => {}
            }
            if !deliberate.load(Ordering::Acquire) {
                let _ = events.send(Event::Exited { id, incarnation });
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
    /// the teardown never touches a newer VM's jail.
    pub(super) fn reap(&mut self, id: Id, live: Live<E::Vm>) {
        live.stopping.store(true, Ordering::Release);
        *self.tearing_down.entry(id.0).or_default() += 1;
        let spec = match self.slots.get(&id.0) {
            Some(slot) => Some(VmSpec::clone(&slot.spec)),
            None => self
                .records
                .get(id)
                .map(|record| vm_spec(&record, &Paths::new(&self.root, id), &self.images)),
        };
        let engine = Arc::clone(&self.engine);
        // Keeps the state root locked until the teardown ends, so a
        // successor agent cannot start beside it.
        let records = Arc::clone(&self.records);
        let shutdown = self.shutdown.clone();
        let events = self.events_tx.clone();
        self.teardowns.spawn(async move {
            let _records = records;
            let mut result = engine.stop(live.vm).await;
            let mut delay = Duration::from_millis(100);
            while let Err(error) = result {
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

    pub(super) fn exited(&mut self, id: Id, incarnation: u64) {
        let Some(slot) = self.slots.get_mut(&id.0) else {
            return;
        };
        if slot.incarnation != Some(incarnation) {
            return;
        }
        tracing::warn!(%id, "VM process ended on its own; running programs are lost");
        if let Some(live) = slot.vm.take() {
            slot.incarnation = None;
            self.reap(id, live);
        } else {
            // A step holds it and will hand it back.
            slot.dead = Some(incarnation);
        }
        self.input(Input::Lost { sandbox: id.0 });
    }

    pub(super) fn destroy_now(&mut self, id: Id) {
        let Some(mut slot) = self.slots.remove(&id.0) else {
            return;
        };
        for waiter in slot.waiters.drain(..) {
            let _ = waiter.reply.send(Err(HostError::Removed(id)));
        }
        let live = slot.vm.take();
        if let Some(live) = &live {
            live.stopping.store(true, Ordering::Release);
        }
        let removers = std::mem::take(&mut slot.removers);
        if let Some(record) = self.records.get(id) {
            self.remove_recorded(&record, live.map(|live| live.vm), removers);
        } else {
            tracing::error!(%id, "removing a sandbox without a record");
            for remover in removers {
                let _ = remover.send(Err(HostError::NotFound(id)));
            }
        }
    }

    /// Deletes a recorded sandbox in the background. Its ordinal and id
    /// stay taken until nothing of it is left.
    pub(super) fn remove_recorded(
        &mut self,
        record: &Record,
        vm: Option<E::Vm>,
        removers: Vec<Reply<()>>,
    ) {
        let id = record.id;
        self.destroying.insert(id.0, removers);
        let paths = Paths::new(&self.root, id);
        let spec = vm_spec(record, &paths, &self.images);
        let engine = Arc::clone(&self.engine);
        let store = Arc::clone(&self.store);
        let records = Arc::clone(&self.records);
        let net = self.net.clone();
        let events = self.events_tx.clone();
        let (ordinal, fence) = (record.ordinal, record.fence());
        tokio::spawn(async move {
            let removal = Removal {
                engine: &*engine,
                store: &*store,
                records: &records,
                net,
                id,
            };
            let result = removal.run(fence, vm, &spec, &paths.dir).await;
            if let Err(error) = &result {
                tracing::error!(%id, %error, "removal stopped; the next start of the agent finishes it");
            }
            let _ = events.send(Event::Destroyed {
                id,
                ordinal: Some(ordinal),
                result,
            });
        });
    }

    /// Deletes in the background what a removal left of a sandbox whose
    /// record is already gone: its network and its directory.
    pub(super) fn remove_leftovers(&mut self, id: Id, ordinal: Option<u32>, reply: Reply<()>) {
        self.blocked.remove(&id.0);
        self.leftovers.remove(&id.0);
        self.destroying.insert(id.0, vec![reply]);
        let dir = Paths::new(&self.root, id).dir;
        let net = self.net.clone();
        let records = Arc::clone(&self.records);
        let events = self.events_tx.clone();
        tokio::spawn(async move {
            // Keeps the state root, and the host, locked until it is done.
            let _records = records;
            let failed = |error: &dyn std::fmt::Display| HostError::Io(error.to_string());
            let result = async {
                if let Some(net) = net {
                    tokio::task::spawn_blocking(move || net.remove_for(id))
                        .await
                        .map_err(|error| failed(&error))?
                        .map_err(|error| failed(&error))?;
                }
                match tokio::fs::remove_dir_all(&dir).await {
                    Err(error) if error.kind() != io::ErrorKind::NotFound => Err(failed(&error)),
                    _ => Ok(()),
                }
            }
            .await;
            let _ = events.send(Event::Destroyed {
                id,
                ordinal,
                result,
            });
        });
    }

    pub(super) fn notify(&mut self, id: Id, notice: Notice) {
        match notice {
            Notice::State(state) => tracing::debug!(
                %id,
                level = ?state.level,
                durability = ?state.durability,
                memory_saved = state.memory_saved,
                "state"
            ),
            Notice::MemoryLost => tracing::warn!(%id, "running programs lost; files kept"),
            Notice::Retrying { step, failures } => {
                tracing::warn!(%id, ?step, failures, "step failed; retrying");
            }
            Notice::Broken => {
                tracing::error!(%id, "sandbox broken on this host");
                self.settle(id);
            }
        }
    }

    /// Answers everyone waiting for `id` once it runs or cannot.
    pub(super) fn settle(&mut self, id: Id) {
        let Some(slot) = self.slots.get_mut(&id.0) else {
            return;
        };
        if slot.waiters.is_empty() {
            return;
        }
        let Some(view) = self.core.sandbox(id.0) else {
            return;
        };
        let result = if view.broken {
            Err(HostError::Broken(id))
        } else if view.state.level == Level::Running && view.step.is_none() && slot.vm.is_some() {
            Ok(slot.spec.vsock_path())
        } else {
            return;
        };
        let generation = self.records.get(id).map(|record| record.generation);
        for waiter in slot.waiters.drain(..) {
            let answer = match (waiter.generation, generation) {
                // It booted afresh since the request: the programs the
                // caller relies on are gone.
                (Some(expected), Some(found)) if expected != found => Err(HostError::Stale {
                    id,
                    expected,
                    found,
                }),
                _ => result.clone().map(|vsock| Woke {
                    vsock,
                    during: waiter.during,
                }),
            };
            let _ = waiter.reply.send(answer);
        }
    }
}

/// Deleting one sandbox, in an order that a crash at any point leaves
/// either finishable on the next start or finished.
struct Removal<'a, E, S> {
    engine: &'a E,
    store: &'a S,
    records: &'a Records,
    net: Option<Arc<Networks>>,
    id: Id,
}

impl<E: Engine, S: Store> Removal<'_, E, S> {
    /// Records that removal began, ends the VM, deletes the store's copy,
    /// then the record, then the files. Until the record is gone a restart
    /// resumes the removal; after, the directory is an unrecorded stray
    /// that recovery deletes.
    async fn run(
        &self,
        fence: Fence,
        vm: Option<E::Vm>,
        spec: &VmSpec,
        dir: &Path,
    ) -> Result<(), HostError> {
        let id = self.id;
        let record = self
            .records
            .commit(id, fence, Change::new().removing())
            .await?;
        let stopped = match vm {
            Some(vm) => self.engine.stop(vm).await,
            None => self.engine.clean_up(spec).await,
        };
        stopped.map_err(|error| HostError::Io(error.to_string()))?;
        if let Some(net) = self.net.clone() {
            tokio::task::spawn_blocking(move || net.remove_for(id))
                .await
                .map_err(|error| HostError::Io(error.to_string()))?
                .map_err(|error| HostError::Io(error.to_string()))?;
        }
        self.store
            .delete(id)
            .await
            .map_err(|error| HostError::Io(error.to_string()))?;
        self.records.remove(id, record.fence()).await?;
        match tokio::fs::remove_dir_all(dir).await {
            Err(error) if error.kind() != io::ErrorKind::NotFound => {
                Err(HostError::Io(error.to_string()))
            }
            _ => Ok(()),
        }
    }
}
