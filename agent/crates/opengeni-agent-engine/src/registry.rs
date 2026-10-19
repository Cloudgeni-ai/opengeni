//! Op lifecycle: idempotent begin, cancel tombstones, bounded completed-op
//! retention with LOUD eviction.
//!
//! The registry is the runner-side authority for "does this op exist and in
//! what phase" (PROTOCOL.md rulings B1/M5/M6):
//!
//! * **Idempotent begin** — beginning a known op NEVER re-runs it; the caller
//!   gets the current phase and attaches instead (this is what kills the
//!   at-least-once double-execution hazard, and it is also the recovery path
//!   for a re-dispatched turn re-issuing the same durable op id).
//! * **Cancel tombstones** — a cancel for an op that has not begun yet is
//!   recorded; a later begin refuses to spawn (born-cancelled). Without this,
//!   message reordering turns cancellation into advice.
//! * **Bounded retention, loud eviction** — completed ops are retained until
//!   the consumer's final ack, a TTL, or an LRU cap. Evicting an op whose
//!   result was never final-acked is a counted, queryable event
//!   (`lost{evicted}`) — a dropped result must never be silent.
//! * **A started op never runs again** — whatever ends an op's retention
//!   (a release, a final ack, eviction), its id stays known as long as
//!   Opengeni can still deliver a start for it ([`OP_START_RESEND_HORIZON_MS`]),
//!   bounded by time only: retention pressure never forgets it sooner.
//!
//! The registry is generic over the per-op runtime state `T` (retention log,
//! credit flow, child handle …) so lifecycle rules are testable with `T = ()`
//! and there is exactly ONE map — no shadow bookkeeping to diverge from.
//! All time is caller-injected `now_ms`; the registry never reads a clock.

use std::collections::{HashMap, VecDeque};

use crate::OpId;

/// Opengeni's start resend horizon: no start for an op is delivered later
/// than this after its first start attempt (`OP_START_RESEND_HORIZON_MS` in
/// the runtime's op-stream client, which enforces it). A runner receives the
/// first start no earlier than that attempt, so keeping a departed op's id
/// for longer than this after it departs covers every start it can still get.
pub const OP_START_RESEND_HORIZON_MS: u64 = 15 * 60 * 1000;

/// Bounds and TTLs for the registry.
#[derive(Debug, Clone)]
pub struct RegistryConfig {
    /// Max completed (terminal, retained) ops before LRU eviction.
    pub max_completed: usize,
    /// How long a completed op is retained awaiting its final ack.
    pub completed_ttl_ms: u64,
    /// How long a cancel tombstone for a never-begun op is honored.
    pub tombstone_ttl_ms: u64,
    /// Max simultaneously-held tombstones (oldest evicted beyond this).
    pub max_tombstones: usize,
    /// How long the marker of an op that is gone (released, final-acked,
    /// evicted or lost to a restart) is kept, from when it went. While it is,
    /// a duplicate start answers it instead of running the op again. Bounded
    /// by time, never by count, and longer than
    /// [`OP_START_RESEND_HORIZON_MS`].
    pub lost_marker_ttl_ms: u64,
}

impl Default for RegistryConfig {
    /// TEST-FLOOR values (LIMITS-DOCTRINE): production construction goes
    /// through the wiring layer, which may override these from measured
    /// capacity or harness knobs. The absolute figures here are floors and
    /// B-breakers for tests, never deployment tuning.
    fn default() -> Self {
        Self {
            max_completed: 2048,
            completed_ttl_ms: 60 * 60 * 1000,
            tombstone_ttl_ms: 15 * 60 * 1000,
            max_tombstones: 4096,
            lost_marker_ttl_ms: 2 * OP_START_RESEND_HORIZON_MS,
        }
    }
}

/// Why a formerly-known op is gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LostReason {
    /// Retention bounds evicted a completed op whose result was never
    /// final-acked — a dropped result, counted loudly.
    Evicted,
    /// The runner restarted and the op did not survive (pre-restart-journal
    /// behavior; honest typed loss, never silence).
    RunnerRestarted,
    /// The consumer released the op's retained result after storing it
    /// (`OpRelease`). Nothing the consumer needs is gone.
    Released,
}

/// The lifecycle phase of a known op.
#[derive(Debug)]
pub enum OpEntry<T> {
    /// The op is executing; `T` is its live runtime state.
    Running {
        /// Per-op runtime state (retention log, flow, child handle …).
        state: T,
        /// Whether a cancel has been requested (the integration layer kills
        /// the child; the flag makes cancel idempotent and queryable).
        cancel_requested: bool,
        /// Begin time (for diagnostics; not used for GC).
        began_at_ms: u64,
    },
    /// The op reached its terminal frame; retained for replay/collection
    /// until final-acked, TTL, or LRU eviction.
    Complete {
        /// Per-op runtime state — the retention log stays alive so the
        /// terminal frames remain replayable until the final ack.
        state: T,
        /// Sequence number of the terminal frame.
        exit_seq: u64,
        /// Completion time (drives TTL + LRU ordering).
        completed_at_ms: u64,
        /// Whether the consumer confirmed full consumption.
        final_acked: bool,
    },
}

/// Answer to a status query.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryAnswer {
    /// The op is running (cancel flag included).
    Running {
        /// Whether cancellation has been requested.
        cancel_requested: bool,
    },
    /// The op completed; terminal frames are replayable.
    Complete {
        /// The terminal frame's sequence number.
        exit_seq: u64,
        /// Whether the final ack was already received.
        final_acked: bool,
    },
    /// The op existed but its state is gone — typed loss.
    Lost(LostReason),
    /// A cancel tombstone exists (op was cancelled before it ever began).
    Tombstoned,
    /// Never heard of it.
    Unknown,
}

/// Outcome of an idempotent begin.
#[derive(Debug)]
pub enum BeginOutcome<'a, T> {
    /// New op admitted; mutable access to its runtime state.
    Fresh(&'a mut T),
    /// Already known — attach instead of re-running. Carries the phase.
    Known(QueryAnswer),
    /// A cancel tombstone exists: do NOT spawn; report born-cancelled.
    BornCancelled,
}

/// Outcome of a cancel request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelOutcome {
    /// The op runs; the integration layer must kill the process tree and
    /// emit the terminal frame. Idempotent: repeated cancels return this
    /// (with the flag already set) until completion.
    KillRunning,
    /// Already terminal — nothing to kill.
    AlreadyComplete,
    /// State already lost — nothing to kill.
    AlreadyLost(LostReason),
    /// Unknown op: a tombstone was recorded so a racing begin refuses.
    TombstoneRecorded,
}

/// Outcome of a release request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseOutcome {
    /// The completed op was dropped; it now answers `Lost(Released)`.
    Released,
    /// Already released (a duplicate release): nothing changes.
    AlreadyReleased,
    /// The op completed with a different terminal frame: nothing released.
    FrontierMismatch,
    /// The op is still running: nothing released.
    Running,
    /// The op is otherwise gone, tombstoned or unknown: nothing to release.
    NotRetained,
}

/// Counters the integration layer exports as metrics. Monotonic.
#[derive(Debug, Default, Clone, Copy)]
pub struct RegistryCounters {
    /// Completed-but-never-final-acked ops evicted (dropped results). Loud.
    pub evicted_unacked_total: u64,
    /// Tombstones evicted early because the tombstone table hit its cap.
    pub tombstones_capped_total: u64,
}

/// Report from one GC pass.
#[derive(Debug, Default)]
pub struct GcReport {
    /// Ops evicted while un-final-acked (their ids — for loud logging).
    pub evicted_unacked: Vec<OpId>,
    /// Final-acked or TTL-expired completed ops dropped quietly.
    pub dropped_completed: usize,
    /// Tombstones expired by TTL.
    pub expired_tombstones: usize,
    /// Lost markers expired by TTL.
    pub expired_lost_markers: usize,
}

/// The op registry. See module docs.
#[derive(Debug)]
pub struct OpRegistry<T> {
    config: RegistryConfig,
    ops: HashMap<OpId, OpEntry<T>>,
    /// Cancel-before-begin tombstones: id → expiry_ms. Bounded FIFO by
    /// insertion (`tombstone_order`).
    tombstones: HashMap<OpId, u64>,
    tombstone_order: VecDeque<OpId>,
    /// Markers for ops whose state is gone, so late queries answer typed and
    /// a late start never re-runs them: id → (reason, expiry_ms).
    lost: HashMap<OpId, (LostReason, u64)>,
    counters: RegistryCounters,
}

impl<T> OpRegistry<T> {
    /// An empty registry under `config`.
    #[must_use]
    pub fn new(config: RegistryConfig) -> Self {
        Self {
            config,
            ops: HashMap::new(),
            tombstones: HashMap::new(),
            tombstone_order: VecDeque::new(),
            lost: HashMap::new(),
            counters: RegistryCounters::default(),
        }
    }

    /// Idempotently begins an op. A known id attaches (never re-runs); a
    /// tombstoned id is born-cancelled; otherwise `state` is admitted as a
    /// fresh Running entry.
    pub fn begin(&mut self, id: &OpId, state: T, now_ms: u64) -> BeginOutcome<'_, T> {
        if let Some(expiry) = self.tombstones.get(id) {
            if *expiry > now_ms {
                return BeginOutcome::BornCancelled;
            }
            // Expired tombstone: fall through (it will be reaped by gc).
        }
        if self.ops.contains_key(id) || self.lost.contains_key(id) {
            return BeginOutcome::Known(self.query(id));
        }
        let entry = OpEntry::Running {
            state,
            cancel_requested: false,
            began_at_ms: now_ms,
        };
        let slot = self.ops.entry(id.clone()).or_insert(entry);
        match slot {
            OpEntry::Running { state, .. } => BeginOutcome::Fresh(state),
            OpEntry::Complete { .. } => unreachable!("just inserted Running"),
        }
    }

    /// The current phase of an op.
    #[must_use]
    pub fn query(&self, id: &OpId) -> QueryAnswer {
        if let Some(entry) = self.ops.get(id) {
            return match entry {
                OpEntry::Running {
                    cancel_requested, ..
                } => QueryAnswer::Running {
                    cancel_requested: *cancel_requested,
                },
                OpEntry::Complete {
                    exit_seq,
                    final_acked,
                    ..
                } => QueryAnswer::Complete {
                    exit_seq: *exit_seq,
                    final_acked: *final_acked,
                },
            };
        }
        if let Some((reason, _)) = self.lost.get(id) {
            return QueryAnswer::Lost(*reason);
        }
        if self.tombstones.contains_key(id) {
            return QueryAnswer::Tombstoned;
        }
        QueryAnswer::Unknown
    }

    /// Mutable access to a live entry (Running or Complete).
    pub fn get_mut(&mut self, id: &OpId) -> Option<&mut OpEntry<T>> {
        self.ops.get_mut(id)
    }

    /// Transitions Running → Complete, keeping the runtime state alive so the
    /// terminal frames stay replayable until the final ack. No-op if the op
    /// is not Running.
    pub fn complete(&mut self, id: &OpId, exit_seq: u64, now_ms: u64) {
        match self.ops.remove(id) {
            Some(OpEntry::Running { state, .. }) => {
                self.ops.insert(
                    id.clone(),
                    OpEntry::Complete {
                        state,
                        exit_seq,
                        completed_at_ms: now_ms,
                        final_acked: false,
                    },
                );
            }
            Some(other) => {
                // Already terminal: put it back untouched (idempotent).
                self.ops.insert(id.clone(), other);
            }
            None => {}
        }
    }

    /// Requests cancellation. Unknown ops get a tombstone (bounded) so a
    /// racing begin refuses to spawn.
    pub fn cancel(&mut self, id: &OpId, now_ms: u64) -> CancelOutcome {
        if let Some(entry) = self.ops.get_mut(id) {
            return match entry {
                OpEntry::Running {
                    cancel_requested, ..
                } => {
                    *cancel_requested = true;
                    CancelOutcome::KillRunning
                }
                OpEntry::Complete { .. } => CancelOutcome::AlreadyComplete,
            };
        }
        if let Some((reason, _)) = self.lost.get(id) {
            return CancelOutcome::AlreadyLost(*reason);
        }
        if !self.tombstones.contains_key(id) {
            if self.tombstones.len() >= self.config.max_tombstones {
                if let Some(oldest) = self.tombstone_order.pop_front() {
                    self.tombstones.remove(&oldest);
                    self.counters.tombstones_capped_total += 1;
                }
            }
            self.tombstones
                .insert(id.clone(), now_ms + self.config.tombstone_ttl_ms);
            self.tombstone_order.push_back(id.clone());
        }
        CancelOutcome::TombstoneRecorded
    }

    /// Releases a completed op whose consumer stored its result through the
    /// terminal frame `exit_seq`: the entry (and its runtime state) is
    /// dropped now, not at the next GC pass, and a `Released` marker answers
    /// later requests so a duplicate begin never re-runs it. Anything else is
    /// left untouched.
    pub fn release(&mut self, id: &OpId, exit_seq: u64, now_ms: u64) -> ReleaseOutcome {
        match self.ops.get(id) {
            Some(OpEntry::Complete {
                exit_seq: retained, ..
            }) if *retained == exit_seq => {}
            Some(OpEntry::Complete { .. }) => return ReleaseOutcome::FrontierMismatch,
            Some(OpEntry::Running { .. }) => return ReleaseOutcome::Running,
            None => {
                return match self.lost.get(id) {
                    Some((LostReason::Released, _)) => ReleaseOutcome::AlreadyReleased,
                    _ => ReleaseOutcome::NotRetained,
                };
            }
        }
        self.ops.remove(id);
        self.record_lost(id.clone(), LostReason::Released, now_ms);
        ReleaseOutcome::Released
    }

    /// Marks a completed op as fully consumed; it becomes GC-eligible.
    pub fn final_ack(&mut self, id: &OpId) {
        if let Some(OpEntry::Complete { final_acked, .. }) = self.ops.get_mut(id) {
            *final_acked = true;
        }
    }

    /// Terminal records still awaiting custody acknowledgement. The existing
    /// retention lifecycle owns their lifetime; notification retries add no log.
    pub fn unacknowledged_completed(&self) -> impl Iterator<Item = (&OpId, &T)> {
        self.ops.iter().filter_map(|(id, entry)| match entry {
            OpEntry::Complete {
                state,
                final_acked: false,
                ..
            } => Some((id, state)),
            _ => None,
        })
    }

    /// One GC pass: drop final-acked + TTL-expired completed ops, LRU-evict
    /// past the completed cap (LOUDLY when un-final-acked), expire
    /// tombstones, bound lost markers.
    pub fn gc(&mut self, now_ms: u64) -> GcReport {
        let mut report = GcReport::default();

        // Collect completed ids with their ack/ttl standing.
        let mut completed: Vec<(OpId, u64, bool)> = self
            .ops
            .iter()
            .filter_map(|(id, e)| match e {
                OpEntry::Complete {
                    completed_at_ms,
                    final_acked,
                    ..
                } => Some((id.clone(), *completed_at_ms, *final_acked)),
                OpEntry::Running { .. } => None,
            })
            .collect();

        // Pass 1: final-acked or TTL-expired.
        for (id, at, acked) in &completed {
            let expired = now_ms.saturating_sub(*at) >= self.config.completed_ttl_ms;
            if *acked || expired {
                self.ops.remove(id);
                if *acked {
                    // Fully consumed: as released, a late start answers it.
                    self.record_lost(id.clone(), LostReason::Released, now_ms);
                    report.dropped_completed += 1;
                } else {
                    self.record_lost(id.clone(), LostReason::Evicted, now_ms);
                    report.evicted_unacked.push(id.clone());
                }
            }
        }
        completed.retain(|(id, _, _)| self.ops.contains_key(id));

        // Pass 2: LRU past the cap (oldest completion first).
        if completed.len() > self.config.max_completed {
            completed.sort_by_key(|(_, at, _)| *at);
            let excess = completed.len() - self.config.max_completed;
            for (id, _, acked) in completed.into_iter().take(excess) {
                self.ops.remove(&id);
                if acked {
                    self.record_lost(id.clone(), LostReason::Released, now_ms);
                    report.dropped_completed += 1;
                } else {
                    self.record_lost(id.clone(), LostReason::Evicted, now_ms);
                    report.evicted_unacked.push(id);
                }
            }
        }

        // Tombstone TTLs.
        let before = self.tombstones.len();
        self.tombstones.retain(|_, expiry| *expiry > now_ms);
        self.tombstone_order
            .retain(|id| self.tombstones.contains_key(id));
        report.expired_tombstones = before - self.tombstones.len();

        // Lost-marker TTLs: past it no start for the op can still arrive.
        let before = self.lost.len();
        self.lost.retain(|_, (_, expiry)| *expiry > now_ms);
        report.expired_lost_markers = before - self.lost.len();

        report
    }

    /// Registers an op as lost (e.g. every journaled-but-unrecovered op at
    /// runner boot → `RunnerRestarted`). The marker is kept for
    /// [`RegistryConfig::lost_marker_ttl_ms`] from `now_ms`, however many
    /// others are recorded meanwhile: a marker costs an id and a
    /// discriminant, and only ops that went within that time are held.
    pub fn record_lost(&mut self, id: OpId, reason: LostReason, now_ms: u64) {
        if reason == LostReason::Evicted {
            self.counters.evicted_unacked_total += 1;
        }
        self.lost
            .insert(id, (reason, now_ms + self.config.lost_marker_ttl_ms));
    }

    /// The lost markers still kept at `now_ms`: each op, why it is gone, and
    /// how much longer it is kept (to carry to a successor process image).
    #[must_use]
    pub fn lost_markers(&self, now_ms: u64) -> Vec<(OpId, LostReason, u64)> {
        self.lost
            .iter()
            .filter(|(_, (_, expiry))| *expiry > now_ms)
            .map(|(id, (reason, expiry))| (id.clone(), *reason, expiry - now_ms))
            .collect()
    }

    /// Keeps a carried marker for `remaining_ms` from `now_ms`, unless the op
    /// is live here or already marked.
    pub fn restore_lost(&mut self, id: OpId, reason: LostReason, remaining_ms: u64, now_ms: u64) {
        if remaining_ms == 0 || self.ops.contains_key(&id) || self.lost.contains_key(&id) {
            return;
        }
        self.lost.insert(id, (reason, now_ms + remaining_ms));
    }

    /// Monotonic counters for metrics export.
    #[must_use]
    pub fn counters(&self) -> RegistryCounters {
        self.counters
    }

    /// Number of live (Running or Complete) entries.
    #[must_use]
    pub fn len(&self) -> usize {
        self.ops.len()
    }

    /// Whether the registry holds no live entries.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> OpRegistry<u32> {
        OpRegistry::new(RegistryConfig {
            max_completed: 3,
            completed_ttl_ms: 1_000,
            tombstone_ttl_ms: 500,
            max_tombstones: 2,
            lost_marker_ttl_ms: 5_000,
        })
    }

    fn id(s: &str) -> OpId {
        OpId::from(s)
    }

    #[test]
    fn begin_is_idempotent_never_reruns() {
        let mut r = registry();
        let op = id("call-1:0");
        assert!(matches!(r.begin(&op, 7, 100), BeginOutcome::Fresh(_)));
        // A re-issued begin (re-dispatched turn, redelivered OpStart) attaches.
        match r.begin(&op, 999, 200) {
            BeginOutcome::Known(QueryAnswer::Running {
                cancel_requested: false,
            }) => {}
            other => panic!("expected Known(Running), got {other:?}"),
        }
        // After completion, a late begin still attaches to the result.
        r.complete(&op, 42, 300);
        match r.begin(&op, 999, 400) {
            BeginOutcome::Known(QueryAnswer::Complete {
                exit_seq: 42,
                final_acked: false,
            }) => {}
            other => panic!("expected Known(Complete), got {other:?}"),
        }
    }

    #[test]
    fn completion_retry_inventory_ends_only_at_final_ack() {
        let mut r = registry();
        let op = id("retained");
        r.begin(&op, 7, 100);
        assert_eq!(r.unacknowledged_completed().count(), 0);
        r.complete(&op, 2, 200);
        assert_eq!(
            r.unacknowledged_completed()
                .map(|(_, value)| *value)
                .collect::<Vec<_>>(),
            vec![7]
        );
        r.final_ack(&op);
        assert_eq!(r.unacknowledged_completed().count(), 0);
    }

    #[test]
    fn cancel_before_begin_tombstones_and_begin_refuses() {
        let mut r = registry();
        let op = id("early-cancel");
        assert_eq!(r.cancel(&op, 100), CancelOutcome::TombstoneRecorded);
        assert!(matches!(r.begin(&op, 1, 200), BeginOutcome::BornCancelled));
        // After the tombstone TTL, the id is usable again.
        assert!(matches!(r.begin(&op, 1, 700), BeginOutcome::Fresh(_)));
    }

    #[test]
    fn cancel_running_is_idempotent_and_flagged() {
        let mut r = registry();
        let op = id("run");
        let _ = r.begin(&op, 1, 100);
        assert_eq!(r.cancel(&op, 150), CancelOutcome::KillRunning);
        assert_eq!(r.cancel(&op, 160), CancelOutcome::KillRunning);
        assert_eq!(
            r.query(&op),
            QueryAnswer::Running {
                cancel_requested: true
            }
        );
        r.complete(&op, 5, 200);
        assert_eq!(r.cancel(&op, 210), CancelOutcome::AlreadyComplete);
    }

    #[test]
    fn tombstone_table_is_bounded_with_counter() {
        let mut r = registry();
        assert_eq!(r.cancel(&id("t1"), 100), CancelOutcome::TombstoneRecorded);
        assert_eq!(r.cancel(&id("t2"), 100), CancelOutcome::TombstoneRecorded);
        assert_eq!(r.cancel(&id("t3"), 100), CancelOutcome::TombstoneRecorded);
        assert_eq!(r.counters().tombstones_capped_total, 1);
        // t1 (oldest) was evicted to make room; t3 is present.
        assert_eq!(r.query(&id("t1")), QueryAnswer::Unknown);
        assert_eq!(r.query(&id("t3")), QueryAnswer::Tombstoned);
    }

    #[test]
    fn final_acked_ops_drop_quietly_on_gc() {
        let mut r = registry();
        let op = id("done");
        let _ = r.begin(&op, 1, 100);
        r.complete(&op, 9, 200);
        r.final_ack(&op);
        let report = r.gc(250);
        assert_eq!(report.dropped_completed, 1);
        assert_eq!(report.evicted_unacked, Vec::<OpId>::new());
        // Fully consumed: a late start answers it as released, never re-runs.
        assert_eq!(r.query(&op), QueryAnswer::Lost(LostReason::Released));
        assert!(matches!(
            r.begin(&op, 2, 300),
            BeginOutcome::Known(QueryAnswer::Lost(LostReason::Released))
        ));
        assert_eq!(r.counters().evicted_unacked_total, 0);
    }

    #[test]
    fn unacked_ttl_expiry_is_loud_and_queryable_as_lost() {
        let mut r = registry();
        let op = id("dropped-result");
        let _ = r.begin(&op, 1, 0);
        r.complete(&op, 9, 0);
        let report = r.gc(1_000); // TTL is 1000ms
        assert_eq!(report.evicted_unacked, vec![op.clone()]);
        assert_eq!(r.counters().evicted_unacked_total, 1);
        assert_eq!(r.query(&op), QueryAnswer::Lost(LostReason::Evicted));
        // Cancel of a lost op reports the loss, no tombstone churn.
        assert_eq!(
            r.cancel(&op, 1_100),
            CancelOutcome::AlreadyLost(LostReason::Evicted)
        );
    }

    #[test]
    fn lru_evicts_oldest_completed_past_cap() {
        let mut r = registry();
        for (i, t) in [10u64, 20, 30, 40].iter().enumerate() {
            let op = id(&format!("op-{i}"));
            let _ = r.begin(&op, 1, *t);
            r.complete(&op, 1, *t);
        }
        let report = r.gc(50); // well inside TTL; cap is 3
        assert_eq!(report.evicted_unacked.len(), 1, "one over cap");
        assert_eq!(
            report.evicted_unacked[0],
            id("op-0"),
            "oldest completion evicted"
        );
        assert_eq!(r.len(), 3);
    }

    #[test]
    fn running_ops_are_never_gced() {
        let mut r = registry();
        let op = id("long-runner");
        let _ = r.begin(&op, 1, 0);
        let report = r.gc(1_000_000);
        assert_eq!(report.evicted_unacked, Vec::<OpId>::new());
        assert_eq!(
            r.query(&op),
            QueryAnswer::Running {
                cancel_requested: false
            }
        );
    }

    #[test]
    fn release_drops_a_completed_op_at_once_and_answers_released() {
        let mut r = registry();
        let op = id("rel");
        assert!(matches!(r.begin(&op, 7, 100), BeginOutcome::Fresh(_)));
        assert_eq!(
            r.release(&op, 4, 150),
            ReleaseOutcome::Running,
            "running: kept"
        );
        r.complete(&op, 4, 200);
        assert_eq!(
            r.release(&op, 3, 250),
            ReleaseOutcome::FrontierMismatch,
            "another terminal frame releases nothing"
        );
        assert!(matches!(r.query(&op), QueryAnswer::Complete { .. }));
        assert_eq!(r.release(&op, 4, 250), ReleaseOutcome::Released);
        assert_eq!(r.len(), 0, "dropped now, not at the next GC pass");
        assert_eq!(r.query(&op), QueryAnswer::Lost(LostReason::Released));
        assert_eq!(r.release(&op, 4, 260), ReleaseOutcome::AlreadyReleased);
        assert_eq!(
            r.cancel(&op, 300),
            CancelOutcome::AlreadyLost(LostReason::Released)
        );
        assert!(
            matches!(
                r.begin(&op, 8, 300),
                BeginOutcome::Known(QueryAnswer::Lost(LostReason::Released))
            ),
            "a duplicate start never re-runs a released op"
        );
        assert_eq!(
            r.counters().evicted_unacked_total,
            0,
            "a release is no loss"
        );
        assert_eq!(
            r.release(&id("unknown"), 1, 300),
            ReleaseOutcome::NotRetained
        );
    }

    #[test]
    fn lost_markers_are_kept_by_time_not_count() {
        let mut r = registry();
        r.record_lost(id("l1"), LostReason::RunnerRestarted, 0);
        r.record_lost(id("l2"), LostReason::RunnerRestarted, 1_000);
        assert_eq!(
            r.query(&id("l1")),
            QueryAnswer::Lost(LostReason::RunnerRestarted)
        );
        // Begin of a lost op reports Known(Lost) — the caller decides to re-run.
        assert!(matches!(
            r.begin(&id("l1"), 1, 10),
            BeginOutcome::Known(QueryAnswer::Lost(LostReason::RunnerRestarted))
        ));
        // Each marker lasts its TTL from when it was recorded (5 s here).
        assert_eq!(r.gc(4_999).expired_lost_markers, 0);
        assert_eq!(r.gc(5_000).expired_lost_markers, 1);
        assert_eq!(r.query(&id("l1")), QueryAnswer::Unknown);
        assert_eq!(
            r.query(&id("l2")),
            QueryAnswer::Lost(LostReason::RunnerRestarted)
        );
        assert_eq!(r.gc(6_000).expired_lost_markers, 1);
    }

    /// However many ops are released after it, a released op's start is
    /// answered, never run again, until the marker's time is up; the marker
    /// survives a hand-over to a successor registry with its remaining time.
    #[test]
    fn a_released_op_never_runs_again_however_many_follow() {
        let mut r = registry();
        let first = id("first");
        assert!(matches!(r.begin(&first, 1, 0), BeginOutcome::Fresh(_)));
        r.complete(&first, 2, 0);
        assert_eq!(r.release(&first, 2, 0), ReleaseOutcome::Released);
        for n in 0..5_000 {
            let other = id(&format!("other-{n}"));
            let _ = r.begin(&other, 1, 100);
            r.complete(&other, 2, 100);
            assert_eq!(r.release(&other, 2, 100), ReleaseOutcome::Released);
        }
        let _ = r.gc(200);
        assert!(
            matches!(
                r.begin(&first, 9, 300),
                BeginOutcome::Known(QueryAnswer::Lost(LostReason::Released))
            ),
            "the first of 5,001 released ops is still known"
        );

        // Carried to a successor (its clock starts again at 0).
        let carried = r.lost_markers(1_000);
        assert_eq!(carried.len(), 5_001);
        let mut successor = registry();
        for (op, reason, remaining) in carried {
            successor.restore_lost(op, reason, remaining, 0);
        }
        assert!(matches!(
            successor.begin(&first, 9, 3_999),
            BeginOutcome::Known(QueryAnswer::Lost(LostReason::Released))
        ));
        let _ = successor.gc(4_000);
        assert!(
            matches!(successor.begin(&first, 9, 4_000), BeginOutcome::Fresh(_)),
            "its time is up only once no start can still arrive"
        );
    }
}
