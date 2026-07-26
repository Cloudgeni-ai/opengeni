//! The impure assembly of the pure op engine, at supervisor scope.
//!
//! ONE `Engine` exists per runner process and survives every connection
//! generation (op ⊥ connection). Every [`WorkspaceLink`](crate::supervisor)
//! and every legacy adapter drives jobs through it:
//!
//! * **Registry** — idempotent begin / cancel tombstones / bounded completed
//!   retention (`opengeni-agent-engine::registry`). The per-op state stored in
//!   the registry is [`OpHandles`]: the seq watermark, the terminal record,
//!   and the (bounded, GC-governed) stashed legacy reply for dedup answers.
//! * **Admission** — fair start-ordering + derived circuit breakers, NEVER a
//!   throughput governor (LIMITS-DOCTRINE.md). [`Engine::admit`] returns an
//!   RAII [`AdmissionTicket`]; a queued caller parks until promotion.
//! * **Budgets** — every byte figure is derived from the measured
//!   [`HostCapacity`] as a fraction with the old absolute defaults as FLOORS
//!   (rule R), and the per-frame wire size is T-derived from the negotiated
//!   NATS `max_payload` ([`Engine::set_negotiated_max_payload`]).
//! * **Spool ledger** — the global disk budget (PROTOCOL.md ruling M2): each
//!   job reserves its per-op spool quota against the shared budget at start
//!   and releases it at teardown; when the budget is short the op's quota is
//!   clamped (loudly) rather than the op refused.
//! * **Routing** — `op_id → mailbox` for wire-command delivery and the
//!   broadcast [`Engine::detach_all`] a link fires on connection loss.
//!
//! Lock discipline: every mutex here is a plain `std::sync::Mutex` held only
//! for map/state operations — never across an `.await`, a spawn, or a hook.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use opengeni_agent_engine::admission::{
    AdmissionConfig, AdmissionOutcome, AdmissionSnapshot, AdmissionState, JobClass, RefusalReason,
};
use opengeni_agent_engine::registry::{
    BeginOutcome, CancelOutcome, OpRegistry, QueryAnswer, RegistryConfig, RegistryCounters,
};
use opengeni_agent_engine::retention::RetentionConfig;
use opengeni_agent_engine::{Frame, HostCapacity, OpId};
use opengeni_agent_platform::ContainedExec;
use tokio::sync::{mpsc, oneshot};
use tracing::{info, warn};

use crate::job::{run_job, JobCommand, JobConfig, JobEnd, JobExit, JobHooks, JobParams};

/// The admission-fairness origin for legacy request/reply work (legacy
/// requests carry no session identity; they share one fairness domain).
pub const LEGACY_ORIGIN: &str = "legacy";

/// Commands queued to one job. A pipe diameter, not a limit (queue rule):
/// senders block/backpressure, the pump drains every loop iteration.
const JOB_MAILBOX_DEPTH: usize = 1024;

/// Wire-envelope margin subtracted from the negotiated `max_payload` when
/// deriving the per-frame data size (the `OpFrame` wrapper: op id, seq, tags).
const FRAME_ENVELOPE_MARGIN: usize = 4 * 1024;

/// The per-frame size used when no transport has negotiated yet (T unknown).
/// A fallback/floor only — never a ceiling (LIMITS-DOCTRINE).
const FALLBACK_FRAME_BYTES: usize = 128 * 1024;

/// Byte budgets derived from measured host capacity (rule R: fractions that
/// scale with the machine; the old absolute defaults survive only as floors).
#[derive(Debug, Clone)]
pub struct EngineBudgets {
    /// Per-op retention template (memory ring + spool quota + segment size).
    pub retention_per_op: RetentionConfig,
    /// The global spool budget every per-op quota is reserved against (M2).
    pub spool_budget_bytes: u64,
    /// Circuit breaker on a legacy adapter's assembled reply buffer: far above
    /// any publishable reply (the transport caps those at `max_payload`), it
    /// exists so a pathological command cannot OOM the runner through the
    /// legacy path while its output is being counted.
    pub legacy_buffer_max_bytes: u64,
}

impl EngineBudgets {
    /// Derives the budgets from measured capacity. Fractions scale with the
    /// host; the floors are the engine-era absolute defaults.
    #[must_use]
    pub fn derive(capacity: &HostCapacity) -> Self {
        let memory_max_bytes = usize::try_from(capacity.mem_available_bytes / 64)
            .unwrap_or(usize::MAX)
            .max(16 * 1024 * 1024);
        let spool_max_bytes = (capacity.disk_free_bytes / 16).max(256 * 1024 * 1024);
        Self {
            retention_per_op: RetentionConfig {
                memory_max_bytes,
                // A breaker, not a working figure (bytes are the real bound;
                // the count exists so a flood of zero-byte progress frames
                // during a very long detach cannot grow the deque unbounded).
                memory_max_frames: 1_000_000,
                spool_max_bytes,
                // IO granularity (P), not a limit.
                spool_segment_bytes: 8 * 1024 * 1024,
            },
            spool_budget_bytes: capacity.disk_free_bytes / 4,
            legacy_buffer_max_bytes: (capacity.mem_available_bytes / 16).max(64 * 1024 * 1024),
        }
    }
}

/// The shared per-op state stored in the registry AND handed to callers: the
/// pump's seq watermark (answers `OpStatus.next_seq`), the terminal record,
/// and the encoded legacy reply retained for duplicate-request answers
/// (bounded by registry GC — ruling M6).
#[derive(Debug, Clone, Default)]
pub struct OpHandles {
    /// Last assigned frame seq (the pump publishes it on every append).
    pub watermark: Arc<AtomicU64>,
    /// The terminal record, set exactly once at completion.
    pub exit: Arc<OnceLock<JobExit>>,
    /// The legacy adapter's encoded `ControlResponse`, for dedup replays.
    pub legacy_reply: Arc<OnceLock<Vec<u8>>>,
    /// The send window granted at OpStart — the fallback for an `OpAttach`
    /// that carries `window_bytes: 0` (reuse the original grant).
    pub window_bytes: Arc<AtomicU64>,
    /// Set (once) if post-exit replay failed: the terminal record survives,
    /// the retained frames do not — status answers carry it typed.
    pub collection_failure: Arc<OnceLock<crate::job::JobFailure>>,
}

/// Outcome of [`Engine::start_job`].
pub enum StartOutcome<E> {
    /// A fresh job is running; command it through [`StartedJob::mailbox`].
    Started(StartedJob),
    /// The spawn closure failed. The registry entry was completed as failed
    /// (typed) so late duplicates see a terminal op; the caller crafts the
    /// reply and may stash it in [`OpHandles::legacy_reply`].
    SpawnFailed {
        /// The spawn error.
        error: E,
        /// The failed op's shared handles (for stashing the typed reply).
        handles: OpHandles,
    },
    /// The op id is already known — NEVER re-run (ruling B1). The caller
    /// answers from the phase + handles.
    Known {
        /// The op's current phase.
        answer: QueryAnswer,
        /// Present when the op's state is live (Running/Complete).
        handles: Option<OpHandles>,
    },
    /// A cancel tombstone exists: nothing was spawned (ruling M5).
    BornCancelled,
}

/// A running job started through the engine.
pub struct StartedJob {
    /// The job's command mailbox.
    pub mailbox: mpsc::Sender<JobCommand>,
    /// The job's shared state handles.
    pub handles: OpHandles,
}

/// RAII admission slot: dropping it releases the slot and wakes promoted
/// waiters. Obtained from [`Engine::admit`].
pub struct AdmissionTicket {
    engine: Arc<Engine>,
    class: JobClass,
    armed: bool,
}

impl AdmissionTicket {
    /// Defuses the ticket (its slot is accounted elsewhere — used when a
    /// promotion could not be delivered and the slot is re-released manually).
    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for AdmissionTicket {
    fn drop(&mut self) {
        if self.armed {
            self.engine.release_slot(self.class);
        }
    }
}

/// A job's share of the global spool ledger (M2). Idempotent release: the
/// legacy adapter returns it early at the terminal record (no consumer is
/// ever coming for a legacy op's spool frames), the task-end guard returns
/// whatever remains, and a double release is a no-op.
struct SpoolReservation {
    engine: Arc<Engine>,
    granted: AtomicU64,
}

impl SpoolReservation {
    fn release(&self) {
        let granted = self.granted.swap(0, Ordering::AcqRel);
        if granted > 0 {
            self.engine.release_spool(granted);
        }
    }
}

/// Owned by the pump task: route removal + spool release run on Drop, so a
/// PANICKING pump still cleans up (design-review fold-in — previously the
/// cleanup ran after `run_job().await` and a panic leaked the route and the
/// reservation until restart).
struct JobCleanup {
    engine: Arc<Engine>,
    op_id: OpId,
    reservation: Arc<SpoolReservation>,
}

impl Drop for JobCleanup {
    fn drop(&mut self) {
        self.engine
            .routes
            .lock()
            .expect("routes lock")
            .remove(&self.op_id);
        self.reservation.release();
    }
}

/// The engine assembly. See module docs. Construct once, share via `Arc`.
pub struct Engine {
    registry: Mutex<OpRegistry<OpHandles>>,
    admission: Mutex<AdmissionState>,
    /// Queued admissions awaiting promotion (op → waker).
    waiters: Mutex<HashMap<OpId, oneshot::Sender<Result<AdmissionTicket, RefusalReason>>>>,
    /// op → job mailbox, for wire-command routing + broadcast detach. Entries
    /// are inserted at job start and removed when the pump task ends; registry
    /// GC also clears entries for ops it evicts (which ends their linger).
    routes: Mutex<HashMap<OpId, mpsc::Sender<JobCommand>>>,
    budgets: RwLock<EngineBudgets>,
    capacity: RwLock<HostCapacity>,
    spool_root: PathBuf,
    spool_reserved: Mutex<u64>,
    /// T-derived per-frame data size (from the negotiated max_payload).
    max_frame_bytes: AtomicUsize,
    /// Op frames dropped by the fire-and-forget publish path (bulk lane down
    /// or its channel full). Protocol-healed (gap-detect + replay), but per
    /// FAILURE-VISIBILITY healed faults are RECORDED — this feeds the
    /// heartbeat so an undersized lane is visible before it matters.
    frames_dropped: AtomicU64,
    /// Monotonic clock base for the pure engine's injected `now_ms`.
    started: std::time::Instant,
}

impl std::fmt::Debug for Engine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Engine")
            .field("spool_root", &self.spool_root)
            .field(
                "max_frame_bytes",
                &self.max_frame_bytes.load(Ordering::Relaxed),
            )
            .finish_non_exhaustive()
    }
}

impl Engine {
    /// Builds the engine from measured capacity: admission breakers and byte
    /// budgets are derived (never ambient constants).
    #[must_use]
    pub fn new(spool_root: PathBuf, capacity: HostCapacity) -> Arc<Self> {
        Self::with_admission(spool_root, capacity, AdmissionConfig::derive(&capacity))
    }

    /// Test/entry constructor with an explicit admission config (tests install
    /// tiny breakers to exercise queueing/refusal deterministically).
    #[must_use]
    pub fn with_admission(
        spool_root: PathBuf,
        capacity: HostCapacity,
        admission: AdmissionConfig,
    ) -> Arc<Self> {
        let _ = std::fs::create_dir_all(&spool_root);
        // Harness-only shrink knobs (ENGINE-SCENARIOS open question 2): loud
        // when active, inert otherwise.
        let overrides = crate::overrides::get();
        let mut budgets = EngineBudgets::derive(&capacity);
        if let Some(v) = overrides.retention_memory_max_bytes {
            budgets.retention_per_op.memory_max_bytes = v;
        }
        if let Some(v) = overrides.retention_spool_max_bytes {
            budgets.retention_per_op.spool_max_bytes = v;
        }
        let mut registry = RegistryConfig::default();
        if let Some(v) = overrides.registry_max_completed {
            registry.max_completed = v;
        }
        if let Some(v) = overrides.registry_completed_ttl_ms {
            registry.completed_ttl_ms = v;
        }
        if let Some(v) = overrides.registry_tombstone_ttl_ms {
            registry.tombstone_ttl_ms = v;
        }
        Arc::new(Self {
            registry: Mutex::new(OpRegistry::new(registry)),
            admission: Mutex::new(AdmissionState::new(admission)),
            waiters: Mutex::new(HashMap::new()),
            routes: Mutex::new(HashMap::new()),
            budgets: RwLock::new(budgets),
            capacity: RwLock::new(capacity),
            spool_root,
            spool_reserved: Mutex::new(0),
            max_frame_bytes: AtomicUsize::new(FALLBACK_FRAME_BYTES),
            frames_dropped: AtomicU64::new(0),
            started: std::time::Instant::now(),
        })
    }

    /// Milliseconds since engine start — the injected clock for the pure
    /// engine (which never reads clocks itself).
    #[must_use]
    pub fn now_ms(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    /// Installs a fresh capacity sample: byte budgets re-derive so long-lived
    /// runners track their host. (Admission breakers keep their boot-time
    /// derivation — they are pathology backstops, not load figures, and
    /// re-deriving them mid-flight would make refusals timing-dependent.)
    pub fn refresh_capacity(&self, capacity: HostCapacity) {
        let overrides = crate::overrides::get();
        let mut budgets = EngineBudgets::derive(&capacity);
        if let Some(v) = overrides.retention_memory_max_bytes {
            budgets.retention_per_op.memory_max_bytes = v;
        }
        if let Some(v) = overrides.retention_spool_max_bytes {
            budgets.retention_per_op.spool_max_bytes = v;
        }
        *self.budgets.write().expect("budgets lock") = budgets;
        *self.capacity.write().expect("capacity lock") = capacity;
    }

    /// The current derived budgets.
    #[must_use]
    pub fn budgets(&self) -> EngineBudgets {
        self.budgets.read().expect("budgets lock").clone()
    }

    /// The last installed capacity sample (heartbeat telemetry).
    #[must_use]
    pub fn capacity(&self) -> HostCapacity {
        *self.capacity.read().expect("capacity lock")
    }

    /// Admission counts for the heartbeat's upward capacity report.
    #[must_use]
    pub fn admission_snapshot(&self) -> AdmissionSnapshot {
        self.admission.lock().expect("admission lock").snapshot()
    }

    /// Derives the per-frame data size from the connection's negotiated
    /// `max_payload` (rule T: query the external constraint, derive from it).
    pub fn set_negotiated_max_payload(&self, max_payload: usize) {
        let frame = if max_payload > 2 * FRAME_ENVELOPE_MARGIN {
            max_payload - FRAME_ENVELOPE_MARGIN
        } else {
            FALLBACK_FRAME_BYTES
        };
        self.max_frame_bytes.store(frame, Ordering::Relaxed);
    }

    /// The current per-frame data size.
    #[must_use]
    pub fn max_frame_bytes(&self) -> usize {
        self.max_frame_bytes.load(Ordering::Relaxed)
    }

    /// The spool root this engine was built against (the capacity sampler's
    /// disk target).
    #[must_use]
    pub fn spool_root(&self) -> &std::path::Path {
        &self.spool_root
    }

    /// Requests an admission slot, parking until promoted when queued. Under
    /// the derived config this admits immediately in all but pathological
    /// states; a refusal names the tripped breaker (typed, loud).
    ///
    /// Cancellation-safe: a caller dropped while queued surrenders its place;
    /// the slot a later promotion would have given it is re-released.
    ///
    /// # Errors
    ///
    /// The tripped breaker when the admission circuit refuses.
    pub async fn admit(
        self: &Arc<Self>,
        op: &OpId,
        class: JobClass,
        origin: &str,
    ) -> Result<AdmissionTicket, RefusalReason> {
        let outcome = self.admission.lock().expect("admission lock").request(
            op,
            class,
            origin,
            self.now_ms(),
        );
        match outcome {
            AdmissionOutcome::Admitted => Ok(self.ticket(class)),
            AdmissionOutcome::Refused(reason) => {
                warn!(op = %op, ?class, ?reason, "admission breaker tripped");
                Err(reason)
            }
            AdmissionOutcome::Queued => {
                let (tx, rx) = oneshot::channel();
                self.waiters
                    .lock()
                    .expect("waiters lock")
                    .insert(op.clone(), tx);
                match rx.await {
                    Ok(result) => result,
                    // The engine (and its waiter map) went away mid-wait —
                    // process shutdown; report as a queue refusal.
                    Err(_) => Err(RefusalReason::QueueFull),
                }
            }
        }
    }

    fn ticket(self: &Arc<Self>, class: JobClass) -> AdmissionTicket {
        AdmissionTicket {
            engine: self.clone(),
            class,
            armed: true,
        }
    }

    /// Releases one running slot and delivers tickets to every waiter the
    /// promotion wakes. A promotion whose waiter died (its admit future was
    /// cancelled) is re-released, iteratively, so slots never leak.
    fn release_slot(self: &Arc<Self>, class: JobClass) {
        let mut to_wake = {
            self.admission
                .lock()
                .expect("admission lock")
                .release(class)
        };
        while let Some(op) = to_wake.pop() {
            let sender = self.waiters.lock().expect("waiters lock").remove(&op);
            let ticket = self.ticket(class);
            let delivered = if let Some(sender) = sender {
                match sender.send(Ok(ticket)) {
                    Ok(()) => true,
                    Err(returned) => {
                        // The waiter is gone; defuse the bounced ticket and
                        // free its slot iteratively (no Drop recursion).
                        if let Ok(ticket) = returned {
                            ticket.disarm();
                        }
                        false
                    }
                }
            } else {
                ticket.disarm();
                false
            };
            if !delivered {
                to_wake.extend(
                    self.admission
                        .lock()
                        .expect("admission lock")
                        .release(class),
                );
            }
        }
    }

    /// Idempotently starts a job (ruling B1: a known id NEVER re-runs — the
    /// registry is consulted BEFORE `spawn` so a duplicate has no side
    /// effects). On the fresh path: reserves spool against the global budget,
    /// spawns the child via `spawn`, wires the pump hooks (engine lifecycle
    /// bookkeeping composed in front of the caller's `on_exit`), and launches
    /// the pump task. The admission ticket rides inside `on_exit`, releasing
    /// at completion (linger is not running work). Route removal + spool
    /// release live in a task-owned Drop guard, so even a panicking pump
    /// cleans up.
    ///
    /// Reserves the op's spool quota against the global ledger (M2); a short
    /// budget clamps the quota (loudly) rather than refusing the op.
    fn reserve_op_spool(
        self: &Arc<Self>,
        op_id: &OpId,
        retention: &mut RetentionConfig,
    ) -> Arc<SpoolReservation> {
        let granted = self.reserve_spool(retention.spool_max_bytes);
        if granted < retention.spool_max_bytes {
            warn!(
                op = %op_id,
                wanted = retention.spool_max_bytes,
                granted,
                "global spool budget short; op spool quota clamped"
            );
        }
        retention.spool_max_bytes = granted;
        Arc::new(SpoolReservation {
            engine: self.clone(),
            granted: AtomicU64::new(granted),
        })
    }

    /// `release_spool_at_exit`: LEGACY ops set this — their spool ledger
    /// share returns at the terminal record instead of task end, because no
    /// consumer ever collects a legacy op's spool frames post-exit (duplicate
    /// replies serve the stashed ENCODED reply); the lingering pump's spool
    /// residue is already ack-trimmed to ~nothing. Op-stream ops keep their
    /// reservation through the linger — post-exit replay is their whole point.
    #[allow(clippy::too_many_arguments)] // the job seams are irreducible; a builder would just rename them
    pub fn start_job<E>(
        self: &Arc<Self>,
        op_id: &OpId,
        ticket: AdmissionTicket,
        stdin: Vec<u8>,
        deadline: Option<tokio::time::Instant>,
        release_spool_at_exit: bool,
        spawn: impl FnOnce() -> Result<ContainedExec, E>,
        emit: impl Fn(Frame) + Send + 'static,
        encode_exit: impl Fn(&JobExit) -> Vec<u8> + Send + 'static,
        on_exit: impl FnOnce(Option<u64>, &JobExit) + Send + 'static,
    ) -> StartOutcome<E> {
        let handles = OpHandles::default();
        {
            let mut registry = self.registry.lock().expect("registry lock");
            match registry.begin(op_id, handles.clone(), self.now_ms()) {
                BeginOutcome::Fresh(_) => {}
                BeginOutcome::Known(answer) => {
                    let handles = match registry.get_mut(op_id) {
                        Some(
                            opengeni_agent_engine::registry::OpEntry::Running { state, .. }
                            | opengeni_agent_engine::registry::OpEntry::Complete { state, .. },
                        ) => Some(state.clone()),
                        None => None,
                    };
                    return StartOutcome::Known { answer, handles };
                }
                BeginOutcome::BornCancelled => return StartOutcome::BornCancelled,
            }
        }

        let child = match spawn() {
            Ok(child) => child,
            Err(error) => {
                // Complete the entry as terminal so late duplicates see a
                // settled op instead of a ghost Running; final-ack it so GC
                // drops it quietly on its TTL.
                let mut registry = self.registry.lock().expect("registry lock");
                registry.complete(op_id, 0, self.now_ms());
                registry.final_ack(op_id);
                return StartOutcome::SpawnFailed { error, handles };
            }
        };

        let mut retention = self.budgets().retention_per_op;
        let reservation = self.reserve_op_spool(op_id, &mut retention);

        let (mailbox_tx, mailbox_rx) = mpsc::channel(JOB_MAILBOX_DEPTH);
        let params = JobParams {
            child,
            stdin,
            retention,
            spool_dir: self.spool_root.join(op_dir_name(op_id)),
            deadline,
            config: JobConfig {
                max_frame_bytes: self.max_frame_bytes(),
                ..JobConfig::default()
            },
            watermark: handles.watermark.clone(),
            collection_failure: handles.collection_failure.clone(),
        };

        // Engine lifecycle bookkeeping runs FIRST at exit (stash the record,
        // flip the registry to Complete, release the admission slot), then the
        // caller's own on_exit.
        let hooks = {
            let engine = self.clone();
            let id = op_id.clone();
            let exit_stash = handles.exit.clone();
            let watermark = handles.watermark.clone();
            let exit_reservation = release_spool_at_exit.then(|| reservation.clone());
            JobHooks::new(emit, encode_exit, move |exit_seq, exit: &JobExit| {
                let _ = exit_stash.set(exit.clone());
                engine.registry.lock().expect("registry lock").complete(
                    &id,
                    exit_seq.unwrap_or_else(|| watermark.load(Ordering::Relaxed)),
                    engine.now_ms(),
                );
                if let Some(reservation) = exit_reservation {
                    reservation.release();
                }
                drop(ticket);
                on_exit(exit_seq, exit);
            })
        };

        self.routes
            .lock()
            .expect("routes lock")
            .insert(op_id.clone(), mailbox_tx.clone());

        let cleanup = JobCleanup {
            engine: self.clone(),
            op_id: op_id.clone(),
            reservation,
        };
        tokio::spawn(async move {
            // Owned here so a PANIC in the pump still removes the route and
            // returns the spool reservation on unwind (Drop guard).
            let cleanup = cleanup;
            let end = run_job(params, mailbox_rx, hooks).await;
            if end == JobEnd::FinalAcked {
                // The pump is the single authority on final-ack acceptance
                // (it fences consumer generations); only then may the
                // registry entry GC quietly.
                cleanup
                    .engine
                    .registry
                    .lock()
                    .expect("registry lock")
                    .final_ack(&cleanup.op_id);
            }
        });

        StartOutcome::Started(StartedJob {
            mailbox: mailbox_tx,
            handles,
        })
    }

    /// Delivers a wire command to a job's mailbox without blocking. `false`
    /// when the op is unknown/ended or its mailbox is saturated (fire-and-
    /// forget wire messages are healed by repetition — ruling M1).
    pub fn route_command(&self, op_id: &OpId, cmd: JobCommand) -> bool {
        let Some(sender) = self.routes.lock().expect("routes lock").get(op_id).cloned() else {
            return false;
        };
        sender.try_send(cmd).is_ok()
    }

    /// Live jobs with a routable mailbox (running + lingering-completed) —
    /// the heartbeat's routes-map telemetry.
    #[must_use]
    pub fn live_ops(&self) -> usize {
        self.routes.lock().expect("routes lock").len()
    }

    /// Records one dropped op frame (fire-and-forget lane down/full). The drop
    /// is protocol-healed by replay; the COUNT is the out-of-band record.
    pub fn note_frame_dropped(&self) {
        self.frames_dropped.fetch_add(1, Ordering::Relaxed);
    }

    /// Total op frames dropped by the publish path since start (monotonic).
    #[must_use]
    pub fn frames_dropped_total(&self) -> u64 {
        self.frames_dropped.load(Ordering::Relaxed)
    }

    /// The registry's loud counters (evictions of un-final-acked results).
    #[must_use]
    pub fn registry_counters(&self) -> RegistryCounters {
        self.registry.lock().expect("registry lock").counters()
    }

    /// Broadcasts `Detach` to every live job — a link lost its connection.
    /// Ops keep running and retaining output (op ⊥ connection); the server
    /// re-attaches per op after reconnect.
    pub fn detach_all(&self) {
        let routes: Vec<mpsc::Sender<JobCommand>> = self
            .routes
            .lock()
            .expect("routes lock")
            .values()
            .cloned()
            .collect();
        for sender in routes {
            let _ = sender.try_send(JobCommand::Detach);
        }
    }

    /// The op's current phase (for `OpQuery`/`OpStarted` answers).
    #[must_use]
    pub fn query(&self, op_id: &OpId) -> QueryAnswer {
        self.registry.lock().expect("registry lock").query(op_id)
    }

    /// Requests cancellation: flags/tombstones in the registry (ruling M5) and,
    /// for a running op, delivers the kill to its pump. Idempotent.
    pub fn cancel(&self, op_id: &OpId) -> CancelOutcome {
        let outcome = self
            .registry
            .lock()
            .expect("registry lock")
            .cancel(op_id, self.now_ms());
        if outcome == CancelOutcome::KillRunning {
            self.route_command(op_id, JobCommand::Cancel);
        }
        outcome
    }

    /// The live state handles of a known (Running/Complete) op.
    #[must_use]
    pub fn handles(&self, op_id: &OpId) -> Option<OpHandles> {
        use opengeni_agent_engine::registry::OpEntry;
        match self.registry.lock().expect("registry lock").get_mut(op_id) {
            Some(OpEntry::Running { state, .. } | OpEntry::Complete { state, .. }) => {
                Some(state.clone())
            }
            None => None,
        }
    }

    /// One GC pass: expire tombstones, drop consumed/expired completed ops
    /// (loud for un-final-acked evictions), end evicted ops' lingering pumps,
    /// and expire queue waiters past an explicitly-configured wait breaker.
    pub fn gc_tick(&self) {
        let now = self.now_ms();
        let report = { self.registry.lock().expect("registry lock").gc(now) };
        if !report.evicted_unacked.is_empty() {
            warn!(
                evicted = report.evicted_unacked.len(),
                ops = ?report.evicted_unacked,
                "evicted completed ops whose results were never final-acked (dropped results)"
            );
        }
        {
            let mut routes = self.routes.lock().expect("routes lock");
            for op in &report.evicted_unacked {
                routes.remove(op);
            }
        }
        let expired = { self.admission.lock().expect("admission lock").expire(now) };
        for (op, reason) in expired {
            if let Some(waiter) = self.waiters.lock().expect("waiters lock").remove(&op) {
                let _ = waiter.send(Err(reason));
            }
        }
        if report.dropped_completed > 0 || report.expired_tombstones > 0 {
            info!(
                dropped_completed = report.dropped_completed,
                expired_tombstones = report.expired_tombstones,
                "engine gc pass"
            );
        }
    }

    /// Reserves up to `want` spool bytes against the global budget, returning
    /// the granted amount.
    fn reserve_spool(&self, want: u64) -> u64 {
        let budget = self
            .budgets
            .read()
            .expect("budgets lock")
            .spool_budget_bytes;
        let mut reserved = self.spool_reserved.lock().expect("spool ledger lock");
        let granted = want.min(budget.saturating_sub(*reserved));
        *reserved += granted;
        granted
    }

    /// Returns a job's spool reservation to the global budget.
    fn release_spool(&self, granted: u64) {
        let mut reserved = self.spool_reserved.lock().expect("spool ledger lock");
        *reserved = reserved.saturating_sub(granted);
    }
}

/// A filesystem-safe per-op spool directory name. Op ids carry `:` and
/// arbitrary caller content, so the name is a digest, not the id.
fn op_dir_name(op_id: &OpId) -> String {
    let digest = blake3::hash(op_id.as_str().as_bytes()).to_hex();
    format!("op-{}", &digest.as_str()[..24])
}

#[cfg(test)]
mod tests {
    use opengeni_agent_engine::admission::ClassLimits;

    use super::*;
    use crate::job::JobOutcome;

    fn tiny_admission(max_running: usize) -> AdmissionConfig {
        AdmissionConfig {
            light: ClassLimits::default(),
            heavy: ClassLimits {
                max_running: Some(max_running),
                max_queued: Some(2),
                queue_wait_max_ms: None,
            },
        }
    }

    fn test_engine(admission: AdmissionConfig) -> (Arc<Engine>, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let engine =
            Engine::with_admission(dir.path().join("spool"), HostCapacity::default(), admission);
        (engine, dir)
    }

    #[cfg(unix)]
    fn sh(script: &str) -> ContainedExec {
        let mut cmd = tokio::process::Command::new("/bin/sh");
        cmd.arg("-c").arg(script);
        opengeni_agent_platform::spawn_contained(cmd, None).expect("spawn")
    }

    #[test]
    fn budgets_scale_with_capacity_and_floor_below() {
        let small = EngineBudgets::derive(&HostCapacity {
            mem_available_bytes: 1024,
            disk_free_bytes: 1024,
            ..HostCapacity::default()
        });
        // A starved reading floors at the absolute defaults, never below.
        assert_eq!(small.retention_per_op.memory_max_bytes, 16 * 1024 * 1024);
        assert_eq!(small.retention_per_op.spool_max_bytes, 256 * 1024 * 1024);
        assert_eq!(small.legacy_buffer_max_bytes, 64 * 1024 * 1024);

        let big = EngineBudgets::derive(&HostCapacity {
            mem_available_bytes: 2 * 1024 * 1024 * 1024 * 1024,
            disk_free_bytes: 64 * 1024 * 1024 * 1024 * 1024,
            ..HostCapacity::default()
        });
        // A 2x host gets 2x budgets (rule R: fractions, not constants).
        assert_eq!(
            big.retention_per_op.memory_max_bytes as u64,
            2 * 1024 * 1024 * 1024 * 1024 / 64
        );
        assert_eq!(big.spool_budget_bytes, 64 * 1024 * 1024 * 1024 * 1024 / 4);
    }

    #[test]
    fn frame_size_is_derived_from_negotiated_max_payload() {
        let (engine, _dir) = test_engine(AdmissionConfig::default());
        assert_eq!(engine.max_frame_bytes(), FALLBACK_FRAME_BYTES);
        engine.set_negotiated_max_payload(1024 * 1024);
        assert_eq!(
            engine.max_frame_bytes(),
            1024 * 1024 - FRAME_ENVELOPE_MARGIN
        );
        // A degenerate negotiation falls back to the floor, never to zero.
        engine.set_negotiated_max_payload(1024);
        assert_eq!(engine.max_frame_bytes(), FALLBACK_FRAME_BYTES);
    }

    #[tokio::test]
    async fn default_admission_admits_immediately() {
        let (engine, _dir) = test_engine(AdmissionConfig::default());
        for i in 0..64 {
            let op = OpId::new(format!("op-{i}"));
            let ticket = engine
                .admit(&op, JobClass::Heavy, "origin")
                .await
                .expect("unbounded default admits");
            // Hold nothing: drop immediately; the point is no queueing.
            drop(ticket);
        }
    }

    #[tokio::test]
    async fn breaker_queues_then_promotes_on_release() {
        let (engine, _dir) = test_engine(tiny_admission(1));
        let first = engine
            .admit(&OpId::from("a"), JobClass::Heavy, "o")
            .await
            .expect("first admitted");

        let engine2 = engine.clone();
        let queued =
            tokio::spawn(
                async move { engine2.admit(&OpId::from("b"), JobClass::Heavy, "o").await },
            );
        tokio::task::yield_now().await;

        drop(first); // release → promotion delivers the queued ticket
        let ticket = tokio::time::timeout(std::time::Duration::from_secs(5), queued)
            .await
            .expect("promotion within timeout")
            .expect("task ok")
            .expect("admitted after release");
        drop(ticket);
    }

    #[tokio::test]
    async fn cancelled_queued_waiter_does_not_leak_the_slot() {
        let (engine, _dir) = test_engine(tiny_admission(1));
        let first = engine
            .admit(&OpId::from("a"), JobClass::Heavy, "o")
            .await
            .expect("admitted");

        // A queued waiter whose future is dropped (JoinSet abort).
        let engine2 = engine.clone();
        let doomed = tokio::spawn(async move {
            engine2
                .admit(&OpId::from("dead"), JobClass::Heavy, "o")
                .await
        });
        tokio::task::yield_now().await;
        doomed.abort();
        let _ = doomed.await;

        // Releasing the running slot promotes the dead waiter, whose bounced
        // ticket must free the slot again — so a THIRD admit succeeds.
        drop(first);
        let third = engine
            .admit(&OpId::from("c"), JobClass::Heavy, "o")
            .await
            .expect("slot recovered from the dead waiter");
        drop(third);
    }

    #[tokio::test]
    async fn queue_breaker_refuses_typed() {
        let (engine, _dir) = test_engine(tiny_admission(1));
        let _held = engine
            .admit(&OpId::from("a"), JobClass::Heavy, "o")
            .await
            .expect("admitted");
        // Fill the tiny queue breaker (2), then the third trips it.
        let mut parked = Vec::new();
        for name in ["q1", "q2"] {
            let engine2 = engine.clone();
            let op = OpId::from(name);
            parked.push(tokio::spawn(async move {
                engine2.admit(&op, JobClass::Heavy, "o").await
            }));
        }
        tokio::task::yield_now().await;
        let refused = engine.admit(&OpId::from("q3"), JobClass::Heavy, "o").await;
        assert!(matches!(refused, Err(RefusalReason::QueueFull)));
        for task in parked {
            task.abort();
        }
    }

    // Drives a REAL /bin/sh child (unix-only by nature; the #349 CI lesson).
    #[cfg(unix)]
    #[tokio::test]
    async fn start_job_runs_a_real_child_and_never_reruns_a_known_id() {
        let (engine, _dir) = test_engine(AdmissionConfig::default());
        let op = OpId::from("job-1");
        let ticket = engine
            .admit(&op, JobClass::Heavy, "o")
            .await
            .expect("admit");
        let (exit_tx, exit_rx) = oneshot::channel();

        let outcome = engine.start_job(
            &op,
            ticket,
            Vec::new(),
            None,
            false,
            || Ok::<_, std::io::Error>(sh("printf out; exit 4")),
            |_frame| {},
            |exit| format!("{exit:?}").into_bytes(),
            move |seq, exit: &JobExit| {
                let _ = exit_tx.send((seq, exit.clone()));
            },
        );
        let StartOutcome::Started(started) = outcome else {
            panic!("fresh id must start");
        };

        let (exit_seq, exit) = tokio::time::timeout(std::time::Duration::from_secs(10), exit_rx)
            .await
            .expect("exit in time")
            .expect("exit delivered");
        assert_eq!(exit.outcome, JobOutcome::Exited { exit_code: 4 });
        assert_eq!(exit.stdout.total_bytes, 3);
        // Registry answers Complete; handles stash the record.
        assert!(matches!(
            engine.query(&op),
            QueryAnswer::Complete {
                final_acked: false,
                ..
            }
        ));
        assert_eq!(started.handles.exit.get(), Some(&exit));
        assert_eq!(
            started.handles.watermark.load(Ordering::Relaxed),
            exit_seq.expect("retained")
        );

        // A duplicate start NEVER re-runs: it attaches to the known phase.
        let ticket2 = engine
            .admit(&op, JobClass::Heavy, "o")
            .await
            .expect("admit");
        let dup = engine.start_job(
            &op,
            ticket2,
            Vec::new(),
            None,
            false,
            || -> Result<ContainedExec, std::io::Error> { panic!("a known op id must not spawn") },
            |_| {},
            |_| Vec::new(),
            |_, _| {},
        );
        match dup {
            StartOutcome::Known { answer, handles } => {
                assert!(matches!(answer, QueryAnswer::Complete { .. }));
                assert_eq!(
                    handles
                        .expect("live handles")
                        .exit
                        .get()
                        .map(|e| &e.outcome),
                    Some(&JobOutcome::Exited { exit_code: 4 })
                );
            }
            _ => panic!("expected Known"),
        }

        // Collection requires an attached consumer: strict generation fencing
        // refuses acks (including final) from a generation that never
        // attached. Attach as generation 1, then final-ack; the pump ends and
        // the wrapper marks the registry entry final-acked (JobEnd::FinalAcked).
        let _ = started
            .mailbox
            .send(JobCommand::Attach {
                generation: 1,
                from_seq: 0,
                window_bytes: 1 << 20,
            })
            .await;
        let _ = started
            .mailbox
            .send(JobCommand::Ack {
                generation: 1,
                acked_seq: u64::MAX,
                credit_bytes: 0,
                final_ack: true,
            })
            .await;
        for _ in 0..200 {
            if !engine.route_command(&op, JobCommand::Detach) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            !engine.route_command(&op, JobCommand::Detach),
            "route removed once the pump task ends"
        );
    }

    #[tokio::test]
    async fn spawn_failure_completes_typed_and_spool_ledger_balances() {
        let (engine, _dir) = test_engine(AdmissionConfig::default());
        let op = OpId::from("bad-spawn");
        let ticket = engine
            .admit(&op, JobClass::Heavy, "o")
            .await
            .expect("admit");
        let outcome = engine.start_job(
            &op,
            ticket,
            Vec::new(),
            None,
            false,
            || Err(std::io::Error::other("no such program")),
            |_| {},
            |_| Vec::new(),
            |_, _| {},
        );
        assert!(matches!(outcome, StartOutcome::SpawnFailed { .. }));
        // The entry settled terminal (a late duplicate sees Complete, not a
        // ghost Running) and is GC-eligible (final-acked).
        assert!(matches!(
            engine.query(&op),
            QueryAnswer::Complete {
                final_acked: true,
                ..
            }
        ));
        // Nothing reserved: the ledger only moves for launched jobs.
        assert_eq!(*engine.spool_reserved.lock().expect("ledger"), 0);
    }

    #[tokio::test]
    async fn born_cancelled_spawns_nothing() {
        let (engine, _dir) = test_engine(AdmissionConfig::default());
        let op = OpId::from("cancelled-early");
        // Tombstone via the registry (the wire's OpCancel path).
        engine
            .registry
            .lock()
            .expect("registry")
            .cancel(&op, engine.now_ms());
        let ticket = engine
            .admit(&op, JobClass::Heavy, "o")
            .await
            .expect("admit");
        let outcome = engine.start_job(
            &op,
            ticket,
            Vec::new(),
            None,
            false,
            || -> Result<ContainedExec, std::io::Error> {
                panic!("a tombstoned op must not spawn")
            },
            |_| {},
            |_| Vec::new(),
            |_, _| {},
        );
        assert!(matches!(outcome, StartOutcome::BornCancelled));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn panicking_pump_still_cleans_up_route_and_ledger() {
        // The emit hook panics on the first frame: the pump task unwinds and
        // the task-owned Drop guard must still remove the route and return
        // the spool reservation (design-review fold-in — previously the
        // cleanup ran only on the normal path).
        let (engine, _dir) = test_engine(AdmissionConfig::default());
        let op = OpId::from("panicky");
        let ticket = engine
            .admit(&op, JobClass::Heavy, "o")
            .await
            .expect("admit");
        let outcome = engine.start_job(
            &op,
            ticket,
            Vec::new(),
            None,
            false,
            || Ok::<_, std::io::Error>(sh("printf boom")),
            |_frame| panic!("emit hook panic (deliberate)"),
            |_| Vec::new(),
            |_, _| {},
        );
        let StartOutcome::Started(started) = outcome else {
            panic!("fresh id must start");
        };
        // Attach so the first frame is emitted (and panics the task).
        let _ = started
            .mailbox
            .send(JobCommand::Attach {
                generation: 1,
                from_seq: 0,
                window_bytes: 1 << 20,
            })
            .await;
        // Poll NON-destructively (a probe command like Detach would detach
        // the pump before the child's first output, and the hook never fires).
        let route_alive =
            |engine: &Arc<Engine>| engine.routes.lock().expect("routes lock").contains_key(&op);
        for _ in 0..500 {
            if !route_alive(&engine) && *engine.spool_reserved.lock().expect("ledger") == 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(!route_alive(&engine), "route removed on the panic path");
        assert_eq!(
            *engine.spool_reserved.lock().expect("ledger"),
            0,
            "spool reservation returned on the panic path"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn legacy_jobs_release_their_ledger_share_at_exit() {
        // release_spool_at_exit: the ledger share returns at the terminal
        // record while the pump still lingers (route alive) — legacy ops
        // never serve post-exit spool replay, so holding the share through
        // the linger only starves new ops under connection churn.
        let (engine, _dir) = test_engine(AdmissionConfig::default());
        let op = OpId::from("legacy-early-release");
        let ticket = engine
            .admit(&op, JobClass::Heavy, "o")
            .await
            .expect("admit");
        let (exit_tx, exit_rx) = oneshot::channel();
        let outcome = engine.start_job(
            &op,
            ticket,
            Vec::new(),
            None,
            true,
            || Ok::<_, std::io::Error>(sh("printf done")),
            |_frame| {},
            |_| Vec::new(),
            move |seq, exit: &JobExit| {
                let _ = exit_tx.send((seq, exit.clone()));
            },
        );
        let StartOutcome::Started(started) = outcome else {
            panic!("fresh id must start");
        };
        let _ = tokio::time::timeout(std::time::Duration::from_secs(10), exit_rx)
            .await
            .expect("exit in time")
            .expect("exit delivered");
        assert_eq!(
            *engine.spool_reserved.lock().expect("ledger"),
            0,
            "ledger share returned at the terminal record"
        );
        assert!(
            engine.route_command(&op, JobCommand::Detach),
            "the pump still lingers (route alive) after the early release"
        );
        // Normal teardown still works.
        let _ = started
            .mailbox
            .send(JobCommand::Attach {
                generation: 1,
                from_seq: 0,
                window_bytes: 1 << 20,
            })
            .await;
        let _ = started
            .mailbox
            .send(JobCommand::Ack {
                generation: 1,
                acked_seq: u64::MAX,
                credit_bytes: 0,
                final_ack: true,
            })
            .await;
    }

    #[test]
    fn spool_reservation_clamps_to_the_global_budget() {
        let (engine, _dir) = test_engine(AdmissionConfig::default());
        let budget = engine.budgets().spool_budget_bytes;
        let first = engine.reserve_spool(budget - 100);
        assert_eq!(first, budget - 100);
        let second = engine.reserve_spool(1000);
        assert_eq!(second, 100, "clamped to the remaining budget");
        engine.release_spool(first);
        engine.release_spool(second);
        assert_eq!(*engine.spool_reserved.lock().expect("ledger"), 0);
    }

    #[test]
    fn op_dir_names_are_filesystem_safe() {
        let name = op_dir_name(&OpId::from("call_abc:0/../../etc"));
        assert!(name.starts_with("op-"));
        assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    }
}
