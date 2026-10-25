//! Carrying out the core's decisions: steps, VM processes and teardown.
//! Deleting sandboxes is in [`super::remove`].

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use compute_core::{
    Action, BalloonRequest, DiskSpace, Durability, Failure, Input, Level, Notice, OpId, Outcome,
    State, Step,
};
use compute_engine::{CancellationToken, Engine, VmSpec};
use tokio::time::{Instant, sleep};

use crate::layout::{Paths, vm_spec};
use crate::observe::notes::Notes;
use crate::observe::{Alarm, Cause, alarm_event};
use crate::pool::{Loaning, Template};
use crate::protocol::{Id, StepStats};
use crate::restore_notice::{Commands, REACH_LIMIT, ask_commands};
use crate::state::{Disk, Record};
use crate::step::{After, Job, Live, LiveMemory, Meter, Reading, Report};
use crate::store::Store;

use super::observe::Why;
use super::{Event, HostAgent, HostError, Leftover, Reply, Running, Slot, TEARDOWN_RETRY, Woke};

/// How long a guest that took the connection may take to say whether
/// commands still run before its sandbox sleeps anyway. It has as long to
/// take the connection as a check gives it ([`REACH_LIMIT`]), so a guest
/// slow to take one but not stopped is not kept awake for it.
const ASK_LIMIT: Duration = Duration::from_secs(1);

impl<E: Engine, S: Store> HostAgent<E, S> {
    pub(super) fn on_event(&mut self, event: Event<E::Vm>) {
        match event {
            Event::Prepared {
                id,
                ordinal,
                result,
                reply,
                stale,
                left,
            } => self.prepared(id, ordinal, result, reply, stale.as_ref(), left),
            Event::CopyClaimed {
                record,
                claimed,
                reply,
            } => self.copy_claimed(*record, *claimed, reply),
            Event::OwnerTaken { id, result, reply } => self.owner_taken(id, result, reply),
            Event::StepDone {
                id,
                op,
                outcome,
                after,
                report,
            } => self.step_done(id, op, outcome, after, *report, false),
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
            Event::Reading { id, reading } => {
                // The last reading before a checkpoint's capture is judged
                // at once: the capture must not hide a busy guest.
                if let Some(slot) = self.slots.get_mut(&id.0)
                    && slot.usage.lend(reading, self.busy)
                {
                    self.input(Input::Busy { sandbox: id.0 });
                }
            }
            Event::Exited { id, incarnation } => self.exited(id, incarnation),
            Event::Checked {
                id,
                incarnation,
                reach,
                unfrozen,
            } => self.checked(id, incarnation, reach, unfrozen),
            Event::Asked {
                id,
                op,
                step,
                stays,
            } => self.asked(id, op, step, stays),
            Event::TemplateChecked { shape, result } => {
                self.template_checked(shape, *result);
                self.refill();
            }
            Event::TemplateBuilt {
                shape,
                ordinal,
                built,
            } => {
                self.template_built(shape, ordinal, built);
                self.discard_stale_ready(shape);
                self.refill();
            }
            Event::Filled { host, filled } => {
                self.filled(host, *filled);
                self.refill();
            }
            Event::ImageSized { image, length } => self.image_sized(image, length),
            Event::ImageFetched { image, result } => self.fetch_ended(image, &result),
            Event::Claimed {
                id,
                config,
                reply,
                claimed,
            } => {
                self.claimed(id, config, reply, *claimed);
                self.refill();
            }
            Event::VmEnded { id, host } => self.vm_ended(id, host),
            Event::Destroyed {
                id,
                host,
                ordinal,
                result,
            } => self.destroyed(id, host, ordinal, &result),
            Event::TornDown { id } => self.torn_down(id),
            Event::BalloonFailed { id, request } => self.input(Input::BalloonFailed {
                sandbox: id.0,
                request,
            }),
            Event::BalloonSet { id, request } => self.input(Input::BalloonSet {
                sandbox: id.0,
                request,
            }),
        }
    }

    /// A create prepared its sandbox's files, or failed to.
    /// A create or adopt of `id` ended; with `left`, one that failed also
    /// left some of what it made behind.
    pub(super) fn prepared(
        &mut self,
        id: Id,
        ordinal: u32,
        result: Result<Box<Record>, HostError>,
        reply: Reply<()>,
        stale: Option<&Arc<Template>>,
        left: Option<String>,
    ) {
        self.preparing.remove(&id.0);
        // What its first files took shows in the next reading.
        self.input(Input::Writes {
            key: id.0,
            disk: DiskSpace::default(),
        });
        if let Some(template) = stale {
            self.template_stale(template);
        }
        let record = match result {
            Ok(record) => *record,
            Err(error) => {
                match left {
                    None => {
                        self.ordinals.remove(&ordinal);
                    }
                    // Its network may still hold its ordinal's link: the
                    // ordinal stays taken, and removing the id again
                    // retries.
                    Some(problem) => {
                        tracing::warn!(%id, %problem, "a create or adopt that failed left files or a network behind");
                        self.block(
                            id,
                            format!("a failed create or adopt left this behind: {problem}"),
                        );
                        self.leftovers.insert(
                            id.0,
                            Leftover {
                                host: id,
                                ordinal: Some(ordinal),
                            },
                        );
                    }
                }
                self.first_wake_unbooked(id);
                let _ = reply.send(Err(error));
                return;
            }
        };
        let Ok(policy) = self.sleep_policy(&record.config) else {
            self.first_wake_unbooked(id);
            return;
        };
        let paths = Paths::of(&self.root, &record);
        let spec = vm_spec(&record, &paths, &self.images);
        let size = self.record_size(&record);
        self.insert(id, paths, spec);
        // A new sandbox is a saved one: a disk, with a memory image when it
        // started from a template. An adopted one is in the store alone.
        // Its first wake boots, restores or fetches it, into the room its
        // create or adopt booked.
        let (level, durability) = match record.disk {
            Disk::Local => (Level::Saved, Durability::Local),
            Disk::Remote => (Level::Remote, Durability::Remote),
        };
        self.input(Input::Add {
            sandbox: id.0,
            state: State::new(level, durability, record.image),
            policy,
            size,
            last_activity: self.now(),
        });
        let _ = reply.send(Ok(()));
    }

    /// The VM of `id`, under removal, ended: its memory and processors are
    /// free for others at once, under whichever name it was counted,
    /// however long the rest of the removal takes and however it ends.
    fn vm_ended(&mut self, id: Id, host: Id) {
        self.release_vm(id, host);
        self.spare_gone(host, true);
    }

    /// Tells the core that the VM counted as `id` or `host` has ended.
    /// Telling it again changes nothing.
    fn release_vm(&mut self, id: Id, host: Id) {
        self.inputs([id, host].map(|name| Input::Unmanaged {
            sandbox: name.0,
            bytes: 0,
            cpu: 0,
        }));
    }

    /// A removal ended, finished or stopped part way.
    fn destroyed(
        &mut self,
        id: Id,
        host: Id,
        ordinal: Option<u32>,
        result: &Result<(), HostError>,
    ) {
        // A removal that stopped part way keeps its ordinal, and its
        // id stays blocked until removing it again or the next
        // start of the agent finishes it.
        match result {
            Ok(()) => {
                if let Some(ordinal) = ordinal {
                    self.ordinals.remove(&ordinal);
                }
                self.leftovers.remove(&id.0);
                self.hosts.remove(&host.0);
                // Its VM has ended, as already reported unless what was
                // left was only its files. What a restart booked for it
                // on disk shows in the next reading.
                self.release_vm(id, host);
                self.inputs([id, host].map(|name| Input::Writes {
                    key: name.0,
                    disk: DiskSpace::default(),
                }));
            }
            Err(error) => {
                self.block(id, format!("removal failed: {error}"));
                if self.records.get(id).is_none() {
                    self.leftovers.insert(id.0, Leftover { host, ordinal });
                }
            }
        }
        for remover in self.destroying.remove(&id.0).unwrap_or_default() {
            let _ = remover.send(result.clone());
        }
        self.handing_away.remove(&id.0);
        self.dropped(id, result);
        // A spare whose VM ended is already gone.
        self.spare_gone(host, result.is_ok());
    }

    pub(super) fn execute(&mut self, action: Action) {
        match action {
            Action::Start { sandbox, op, step } => {
                if step == Step::Pause
                    && self
                        .core
                        .sandbox(sandbox)
                        .is_some_and(|view| view.paused_for_memory.is_some())
                {
                    tracing::warn!(id = %Id(sandbox), "pausing and saving a sandbox in use for host memory");
                }
                self.start_step(Id(sandbox), op, step);
            }
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
                        report: Box::default(),
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
            Action::Balloon {
                sandbox,
                bytes,
                request,
            } => self.set_balloon(Id(sandbox), bytes, request),
            Action::Lend { loan } => {
                if let Some(granted) = self.loans.remove(&loan) {
                    let _ = granted.send(());
                }
            }
            Action::Discard { sandbox } => self.discard_spare(Id(sandbox)),
        }
    }

    /// Asks the guest of `id`'s running VM to give `bytes` back through its
    /// balloon, in the background: a VM that fails to keeps its memory, the
    /// host relieves pressure further if it must, and the setting is asked
    /// again after a backoff. Either answer names `request`.
    fn set_balloon(&self, id: Id, bytes: u64, request: BalloonRequest) {
        let Some(live) = self.slots.get(&id.0).and_then(|slot| slot.vm.as_ref()) else {
            // Not asked: no VM to ask.
            let _ = self.events_tx.send(Event::BalloonFailed { id, request });
            return;
        };
        let set = self.engine.set_balloon(&live.vm, bytes);
        let events = self.events_tx.clone();
        tokio::spawn(async move {
            match set.await {
                Ok(()) => {
                    tracing::info!(%id, mib = bytes >> 20, "balloon set");
                    let _ = events.send(Event::BalloonSet { id, request });
                }
                Err(error) => {
                    tracing::warn!(%id, mib = bytes >> 20, %error, "could not set the balloon");
                    let _ = events.send(Event::BalloonFailed { id, request });
                }
            }
        });
    }

    pub(super) fn start_step(&mut self, id: Id, op: OpId, step: Step) {
        let ask = self
            .restore_notice_port
            .filter(|_| self.sleeps_for_idleness(id, step));
        let why = self.why(id, op, step);
        let before = self.core.sandbox(id.0).map(|view| view.state);
        let Some(slot) = self.slots.get_mut(&id.0) else {
            tracing::error!(%id, ?step, "step for a sandbox the host does not have");
            let _ = self.events_tx.send(Event::StepDone {
                id,
                op,
                outcome: Outcome::Failed(Failure::Fatal),
                after: After::NoVm,
                report: Box::default(),
            });
            return;
        };
        // What the VM does from here is the step's work, not the guest's,
        // unless it is a checkpoint, whose guest runs on while it reads it.
        slot.usage.step_started(step == Step::Checkpoint);
        slot.op = Some(Running {
            op,
            step,
            cancel: CancellationToken::new(),
            started: Instant::now(),
            why,
            before,
        });
        self.stats[step.index()].started += 1;
        if self.tearing_down.contains_key(&id.0) {
            // A dead VM's teardown still owns this sandbox's jail; the step
            // starts once it is done.
            slot.deferred = Some(step);
            return;
        }
        if let Some(port) = ask
            && slot.vm.is_some()
        {
            // A command started through the guest's helper keeps it awake
            // however quiet it is: ask before the step takes the VM. A
            // guest that takes no connection may have stopped, and saving
            // it would keep it stopped: it stays awake until it takes one
            // or is found stopped (see `check`).
            let vsock = slot.spec.vsock_path();
            let events = self.events_tx.clone();
            tokio::spawn(async move {
                let stays = match ask_commands(&vsock, port, REACH_LIMIT, ASK_LIMIT).await {
                    Commands::Running(count) => count > 0,
                    Commands::Unknown(error) => {
                        tracing::debug!(%id, %error, "no command count; sleeping");
                        false
                    }
                    Commands::Unreached(error) => {
                        tracing::debug!(%id, %error, "guest took no connection; staying awake");
                        true
                    }
                };
                let _ = events.send(Event::Asked {
                    id,
                    op,
                    step,
                    stays,
                });
            });
            return;
        }
        self.spawn_job(id, op, step);
    }

    /// Whether `step` would only take the running sandbox to sleep for
    /// being idle: not for memory pressure, nor because it was asked to.
    /// A checkpoint never asks: it is for a sandbox in use and leaves it
    /// running, and one cancelled for a running command would be due again
    /// at once, so it would be started and cancelled over and over.
    fn sleeps_for_idleness(&self, id: Id, step: Step) -> bool {
        step == Step::Pause
            && self.core.sandbox(id.0).is_some_and(|view| {
                view.state.level == Level::Running
                    && view.floor == Level::Running
                    && view.requested == Level::Running
            })
    }

    /// The guest answered whether a command still runs: one that does, or
    /// a guest that took no connection, cancels the step, before it took
    /// effect, and counts as activity, so the sandbox stays running for
    /// another idle period. Otherwise, or if the VM ended meanwhile, the
    /// step goes ahead.
    fn asked(&mut self, id: Id, op: OpId, step: Step, stays: bool) {
        let Some(slot) = self.slots.get_mut(&id.0) else {
            return;
        };
        let Some(cancelled) = slot
            .op
            .as_ref()
            .filter(|current| current.op == op)
            .map(|current| current.cancel.is_cancelled())
        else {
            return;
        };
        if stays
            && !cancelled
            && slot.dead.is_none()
            && let Some(live) = slot.vm.take()
        {
            self.step_done(
                id,
                op,
                Outcome::Cancelled,
                After::Kept(live),
                Report::default(),
                true,
            );
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
                report: Box::default(),
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
            Step::Pause
                | Step::Resume
                | Step::Compress
                | Step::Save
                | Step::Drop
                | Step::Archive
                | Step::Checkpoint
        );
        let events = self.events_tx.clone();
        let (spec, paths) = (VmSpec::clone(&slot.spec), Paths::clone(&slot.paths));
        let live = if needs_vm { slot.vm.take() } else { None };
        if live.is_some() {
            // The step may pause the guest from now on, whenever the
            // agent next notes it, until it hands the VM back.
            slot.runs_since = None;
        }
        let link_clock = slot.link_clock.clone();
        // A sandbox paused for memory is known to wait for room before
        // any step can leave it saved: a restart then still wakes it.
        let kept =
            (!step.wakes() && slot.holds.paused_for_memory().is_some()).then(|| slot.holds.flush());
        let mut job = self.job(record, spec, paths, cancel);
        job.live = live;
        job.link_clock = Some(link_clock);
        job.unthrottle = Some({
            let events = events.clone();
            Box::new(move || {
                let _ = events.send(Event::Unthrottled { id, op });
            })
        });
        if step == Step::Checkpoint {
            let events = events.clone();
            job.meter = Some(Meter {
                every: self.sample_every,
                send: Box::new(move |reading| {
                    let _ = events.send(Event::Reading { id, reading });
                }),
            });
        }
        tokio::spawn(async move {
            // Without that kept, the step does not run: it fails for now,
            // handing back its VM untouched, and is tried again.
            if let Some(kept) = kept
                && let Err(error) = kept.await
            {
                tracing::warn!(%id, %error, "could not keep that the sandbox waits for memory");
                let _ = events.send(Event::StepDone {
                    id,
                    op,
                    outcome: Outcome::Failed(Failure::Transient),
                    after: job.live.take().map_or(After::NoVm, After::Kept),
                    report: Box::new(Report {
                        notes: Notes::failed(format!(
                            "could not keep that it waits for memory: {error}"
                        )),
                        ..Report::default()
                    }),
                });
                return;
            }
            let ran = job.run(step).await;
            let _ = events.send(Event::StepDone {
                id,
                op,
                outcome: ran.outcome,
                after: ran.after,
                report: Box::new(ran.report),
            });
        });
    }

    /// A step for the sandbox `record` describes, with no VM, that frees
    /// no place when its work is done.
    pub(super) fn job(
        &self,
        record: Record,
        spec: VmSpec,
        paths: Paths,
        cancel: CancellationToken,
    ) -> Job<E, S> {
        let last_activity = self
            .core
            .sandbox(record.id.0)
            .map_or_else(|| self.now(), |view| view.last_activity);
        let disk_image = self.image_path(record.config.image);
        Job {
            engine: Arc::clone(&self.engine),
            store: Arc::clone(&self.store),
            records: Arc::clone(&self.records),
            id: record.id,
            record,
            spec,
            paths,
            cancel,
            live: None,
            restore_notice_port: self.restore_notice_port,
            disk_image,
            kernel: self.images.kernel.clone(),
            #[cfg(target_os = "linux")]
            fetcher: self.fetcher.clone(),
            pager: self.pager.clone(),
            launches: 0,
            link_clock: None,
            untouched: false,
            unthrottle: None,
            meter: None,
            last_used_ms: self.unix_ms(last_activity),
        }
    }

    pub(super) fn step_done(
        &mut self,
        id: Id,
        op: OpId,
        outcome: Outcome,
        after: After<E::Vm>,
        mut report: Report,
        mut busy: bool,
    ) {
        let fresh = match after {
            After::New(vm, memory) => Some(self.own(id, vm, memory)),
            After::Kept(live) => Some(live),
            After::NoVm => None,
        };
        let mut reap = None;
        let mut destroy = false;
        let mut finished_step = None;
        if let Some(slot) = self.slots.get_mut(&id.0) {
            slot.launches += u64::from(report.launches);
            if let Some(running) = slot.op.take().filter(|running| running.op == op) {
                let stats = &mut self.stats[running.step.index()];
                count_step(id, stats, slot, &running, outcome, &report);
                // It runs: the request that woke it is answered. A fetch
                // only brings it back to the host; the restore after it
                // still serves that request.
                if running.step.wakes() && running.step != Step::Fetch && outcome == Outcome::Done {
                    slot.asked = None;
                    slot.summarized = Instant::now();
                }
                finished_step = Some(running);
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
                    // A checkpoint's guest ran on: what it did since the
                    // resume counts before the core picks the next step,
                    // however short that was.
                    if let Some(rule) = self.busy
                        && finished_step
                            .as_ref()
                            .is_some_and(|running: &Running| running.step == Step::Checkpoint)
                    {
                        let reading = Reading::of(&*self.engine, &live.vm, live.incarnation);
                        busy |= slot.usage.judge_now(&reading, rule);
                    }
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
        // Decided together, so the activity counts before the core picks
        // the next step.
        let finished = Input::Finished {
            sandbox: id.0,
            op,
            outcome,
            wrote: report.wrote,
        };
        let activity = busy.then_some(Input::Busy { sandbox: id.0 });
        // A step that found a later owner holding the sandbox began its
        // removal, which leaves the store's copy.
        let dropped = !destroy
            && self.slots.contains_key(&id.0)
            && self.records.get(id).is_some_and(|record| record.handed_off);
        let remove = dropped.then_some(Input::Remove { sandbox: id.0 });
        self.inputs(std::iter::once(finished).chain(activity).chain(remove));
        if let Some(running) = finished_step {
            self.step_event(id, &running, outcome, &mut report);
        }
        if destroy {
            if !self.tearing_down.contains_key(&id.0) {
                self.destroy_now(id);
            }
        } else {
            self.settle(id);
            self.continue_hand_off(id);
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
                .map(|record| vm_spec(&record, &Paths::of(&self.root, &record), &self.images)),
        };
        let engine = Arc::clone(&self.engine);
        // Keeps the state root locked until the teardown ends, so a
        // successor agent cannot start beside it.
        let records = Arc::clone(&self.records);
        let shutdown = self.shutdown.clone();
        let events = self.events_tx.clone();
        self.teardowns.spawn(async move {
            let _records = records;
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

    pub(super) fn exited(&mut self, id: Id, incarnation: u64) {
        if self.ready_exited(id, incarnation) {
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
        tracing::warn!(%id, "VM process ended on its own; running programs are lost");
        self.lost_vm(id, incarnation);
    }

    /// Ends VM process `incarnation` of `id`, which is lost (it ended on its
    /// own, or its guest stopped), and tells the core.
    pub(super) fn lost_vm(&mut self, id: Id, incarnation: u64) {
        let Some(slot) = self.slots.get_mut(&id.0) else {
            return;
        };
        // Whatever starts it again puts things right.
        slot.asked = Some(Why::plain(Cause::Recovery));
        if let Some(live) = slot.vm.take() {
            slot.incarnation = None;
            self.reap(id, live);
        } else {
            // A step holds it and will hand it back.
            slot.dead = Some(incarnation);
        }
        self.input(Input::Lost { sandbox: id.0 });
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
            Notice::MemoryLost => {
                tracing::warn!(%id, "running programs lost; files kept");
                self.alarm(id, Alarm::ProgramsLost, "running programs lost; files kept");
            }
            Notice::Retrying { step, failures } => {
                tracing::warn!(%id, ?step, failures, "step failed; retrying");
            }
            Notice::Unsavable => {
                tracing::warn!(
                    %id,
                    "no copy of the VM can be trusted; it sleeps no deeper than compressed"
                );
                // A hand-off needs a copy, so one under way ends.
                self.continue_hand_off(id);
            }
            Notice::Broken => {
                tracing::error!(%id, "sandbox broken on this host");
                self.alarm(id, Alarm::Broken, "sandbox broken on this host");
                self.settle(id);
            }
            Notice::PausedForMemory(bytes) => self.keep_memory_wait(id, bytes),
            Notice::HostFull {
                resource,
                needed,
                free,
            } => {
                tracing::warn!(%id, %resource, needed, free, "wake refused: host full");
                // Those waiting give up their holds when answered, so the
                // refusal ends unless something else keeps it held.
                if let Some(slot) = self.slots.get_mut(&id.0) {
                    for waiter in slot.waiters.drain(..) {
                        let _ = waiter.reply.send(Err(HostError::HostFull {
                            id,
                            resource,
                            needed,
                            free,
                        }));
                    }
                }
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
        } else if view.runs() && (slot.vm.is_some() || view.step == Some(Step::Checkpoint)) {
            // A checkpoint holds the VM while it runs on: its guest answers
            // once the capture's pause ends.
            Ok(slot.spec.vsock_path())
        } else {
            return;
        };
        let generation = self.records.get(id).map(|record| record.generation);
        let woke_by = slot.woke_by;
        for waiter in slot.waiters.drain(..) {
            let answer = match (waiter.generation, generation) {
                // It booted afresh since the request: the programs the
                // caller relies on are gone.
                (Some(expected), Some(found)) if expected != found => Err(HostError::Stale {
                    id,
                    expected,
                    found,
                }),
                (_, Some(found)) => result.clone().map(|vsock| Woke {
                    vsock,
                    during: waiter.during,
                    generation: found,
                    op: woke_by.filter(|_| waiter.queued),
                }),
                (_, None) => result.clone().and(Err(HostError::Removed(id))),
            };
            let _ = waiter.reply.send(answer);
        }
    }

    /// Raises `alarm` for sandbox `id`, with what happened.
    fn alarm(&self, id: Id, alarm: Alarm, what: &str) {
        let event = alarm_event(what).with("compute.sandbox.id", id.to_string());
        self.observer.alarm(alarm, event);
    }
}

/// Counts how the step `running` of `id` ended in its kind's `stats`, and
/// keeps a failure's error for the sandbox's status, or clears an earlier
/// failure of the same kind once one is done.
fn count_step<V>(
    id: Id,
    stats: &mut StepStats,
    slot: &mut Slot<V>,
    running: &Running,
    outcome: Outcome,
    report: &Report,
) {
    let micros = u64::try_from(running.started.elapsed().as_micros()).unwrap_or(u64::MAX);
    stats.total_us = stats.total_us.saturating_add(micros);
    stats.max_us = stats.max_us.max(micros);
    tracing::debug!(%id, step = ?running.step, micros, ?outcome, "step finished");
    match outcome {
        Outcome::Done => {
            stats.done += 1;
            if slot
                .failed
                .as_ref()
                .is_some_and(|(step, _)| *step == running.step)
            {
                slot.failed = None;
            }
        }
        Outcome::Cancelled => stats.cancelled += 1,
        Outcome::Failed(_) => {
            stats.failed += 1;
            slot.failed = Some((
                running.step,
                report
                    .notes
                    .error
                    .clone()
                    .unwrap_or_else(|| "no error recorded".to_owned()),
            ));
        }
    }
}
