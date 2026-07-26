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
//!
//! The registry is generic over the per-op runtime state `T` (retention log,
//! credit flow, child handle …) so lifecycle rules are testable with `T = ()`
//! and there is exactly ONE map — no shadow bookkeeping to diverge from.
//! All time is caller-injected `now_ms`; the registry never reads a clock.

use std::collections::{HashMap, VecDeque};

use crate::OpId;

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
    /// Max lost markers retained so late queries stay answerable.
    pub max_lost_markers: usize,
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
            max_lost_markers: 4096,
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

/// Counters the integration layer exports as metrics. Monotonic.
#[derive(Debug, Default, Clone, Copy)]
pub struct RegistryCounters {
    /// Completed-but-never-final-acked ops evicted (dropped results). Loud.
    pub evicted_unacked_total: u64,
    /// Tombstones evicted early because the tombstone table hit its cap.
    pub tombstones_capped_total: u64,
    /// Lost MARKERS evicted because the marker table hit its cap — each one
    /// silently degrades a later query for that op from a typed
    /// `Lost(reason)` to `Unknown`, so the flip must be counted (design
    /// review finding 7): an Unknown answer is honest only while this
    /// counter says how many precise answers were given up.
    pub lost_markers_capped_total: u64,
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
    /// Markers for ops whose state is gone, so late queries answer typed.
    lost: HashMap<OpId, LostReason>,
    lost_order: VecDeque<OpId>,
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
            lost_order: VecDeque::new(),
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
        if let Some(reason) = self.lost.get(id) {
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
        if let Some(reason) = self.lost.get(id) {
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

    /// Marks a completed op as fully consumed; it becomes GC-eligible.
    pub fn final_ack(&mut self, id: &OpId) {
        if let Some(OpEntry::Complete { final_acked, .. }) = self.ops.get_mut(id) {
            *final_acked = true;
        }
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
                    report.dropped_completed += 1;
                } else {
                    self.record_lost(id.clone(), LostReason::Evicted);
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
                    report.dropped_completed += 1;
                } else {
                    self.record_lost(id.clone(), LostReason::Evicted);
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

        report
    }

    /// Registers an op as lost (e.g. every journaled-but-unrecovered op at
    /// runner boot → `RunnerRestarted`). Bounded FIFO: a marker evicted past
    /// [`RegistryConfig::max_lost_markers`] degrades that op's later queries
    /// from `Lost(reason)` to `Unknown` — a LOUD counted event
    /// ([`RegistryCounters::lost_markers_capped_total`]), never a silent
    /// flip. (Markers cost ~an id string + a discriminant each — the default
    /// cap holds well under a megabyte, a B-breaker, not a working figure.)
    pub fn record_lost(&mut self, id: OpId, reason: LostReason) {
        if reason == LostReason::Evicted {
            self.counters.evicted_unacked_total += 1;
        }
        if self.lost.len() >= self.config.max_lost_markers {
            if let Some(oldest) = self.lost_order.pop_front() {
                self.lost.remove(&oldest);
                self.counters.lost_markers_capped_total += 1;
            }
        }
        self.lost_order.push_back(id.clone());
        self.lost.insert(id, reason);
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
            max_lost_markers: 2,
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
        assert!(report.evicted_unacked.is_empty());
        assert_eq!(r.query(&op), QueryAnswer::Unknown);
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
        assert!(report.evicted_unacked.is_empty());
        assert_eq!(
            r.query(&op),
            QueryAnswer::Running {
                cancel_requested: false
            }
        );
    }

    #[test]
    fn lost_markers_are_bounded() {
        let mut r = registry();
        r.record_lost(id("l1"), LostReason::RunnerRestarted);
        r.record_lost(id("l2"), LostReason::RunnerRestarted);
        assert_eq!(
            r.counters().lost_markers_capped_total,
            0,
            "within the cap nothing is given up"
        );
        r.record_lost(id("l3"), LostReason::RunnerRestarted);
        assert_eq!(
            r.query(&id("l1")),
            QueryAnswer::Unknown,
            "oldest marker evicted"
        );
        assert_eq!(
            r.counters().lost_markers_capped_total,
            1,
            "the Known-lost -> Unknown flip is a LOUD counted event (finding 7)"
        );
        assert_eq!(
            r.query(&id("l3")),
            QueryAnswer::Lost(LostReason::RunnerRestarted)
        );
        // Begin of a lost op reports Known(Lost) — the caller decides to re-run.
        assert!(matches!(
            r.begin(&id("l3"), 1, 0),
            BeginOutcome::Known(QueryAnswer::Lost(LostReason::RunnerRestarted))
        ));
    }
}
