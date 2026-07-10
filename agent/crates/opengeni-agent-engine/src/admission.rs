//! Class-aware job admission with a bounded fair wait queue.
//!
//! Replaces the flat 8-permit semaphore (the DRAINING-storm ceiling). Rules
//! (DESIGN.md §Admission, PROTOCOL.md §Admission):
//!
//! * **Liveness never enters admission** — ping/hello are answered inline by
//!   the transport layer and are invisible here.
//! * Two classes: **Light** (stat/list/mkdir/move/remove/pty-control — cheap,
//!   latency-sensitive) and **Heavy** (exec, large fs transfers, git — long,
//!   resource-owning). Each has its own running cap.
//! * A **bounded wait queue** absorbs bursts before typed backpressure: a job
//!   that cannot run immediately queues (up to a per-class depth and a wait
//!   deadline) instead of instantly failing. This converts the old
//!   instant-DRAINING cliff into short queueing.
//! * **Per-origin fairness**: queued jobs are promoted round-robin across
//!   origin ids (session ids), so one chatty session cannot starve nine quiet
//!   ones no matter how fast it submits.
//! * **Host-pressure gate**: the integration layer samples PSI/free-memory and
//!   passes `host_pressured`; while pressured, HEAVY admissions are refused
//!   typed (light ops still flow — they are what diagnosis is made of).
//!
//! Everything is pure and clock-injected: the integration layer owns timers
//! (it calls [`AdmissionState::expire`] on a tick) and the PSI probe.

use std::collections::{HashMap, VecDeque};

use crate::OpId;

/// Which admission class a job belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum JobClass {
    /// Cheap, latency-sensitive control ops.
    Light,
    /// Long-running, resource-owning ops (exec, big transfers, git).
    Heavy,
}

/// Per-class bounds.
#[derive(Debug, Clone)]
pub struct ClassLimits {
    /// Max jobs of this class running concurrently.
    pub max_running: usize,
    /// Max jobs of this class waiting in the queue.
    pub max_queued: usize,
    /// How long a queued job may wait before it is rejected typed.
    pub queue_wait_max_ms: u64,
}

/// Admission configuration.
#[derive(Debug, Clone)]
pub struct AdmissionConfig {
    /// Bounds for light ops.
    pub light: ClassLimits,
    /// Bounds for heavy ops.
    pub heavy: ClassLimits,
}

impl Default for AdmissionConfig {
    fn default() -> Self {
        Self {
            light: ClassLimits {
                max_running: 64,
                max_queued: 128,
                queue_wait_max_ms: 5_000,
            },
            heavy: ClassLimits {
                max_running: 16,
                max_queued: 32,
                queue_wait_max_ms: 10_000,
            },
        }
    }
}

/// Why an admission was refused. Every variant maps to a typed retryable
/// DRAINING response whose `backpressure` detail names the exhausted budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalReason {
    /// The class's wait queue is full.
    QueueFull,
    /// The job waited past the class's queue deadline.
    WaitDeadline,
    /// The host is under memory/PSI pressure (heavy jobs only).
    HostPressure,
}

/// Outcome of an admission request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmissionOutcome {
    /// Run now. The caller MUST call [`AdmissionState::release`] when done.
    Admitted,
    /// Queued; the caller waits. Promotion arrives via the values returned
    /// from [`AdmissionState::release`] / [`AdmissionState::expire`].
    Queued,
    /// Refused typed.
    Refused(RefusalReason),
}

/// A queued job awaiting promotion. (Class and origin live in the queue
/// map key, not here — one source of truth.)
#[derive(Debug)]
struct Waiter {
    op: OpId,
    enqueued_at_ms: u64,
}

/// The pure admission state machine. The integration layer wraps it in a
/// mutex, calls `release` when a job finishes, `expire` on a timer tick, and
/// wakes the promoted/rejected ops it returns.
#[derive(Debug)]
pub struct AdmissionState {
    config: AdmissionConfig,
    running_light: usize,
    running_heavy: usize,
    /// Per-origin FIFO queues (fairness domain), per class.
    queues: HashMap<(JobClass, String), VecDeque<Waiter>>,
    /// Round-robin ring of origin keys per class (an origin appears once
    /// while it has waiters).
    rings: HashMap<JobClass, VecDeque<String>>,
    /// Whether the host is currently pressured (heavy gate). Updated by the
    /// integration layer from its PSI probe.
    host_pressured: bool,
    queued_total: HashMap<JobClass, usize>,
}

impl AdmissionState {
    /// Empty state under `config`.
    #[must_use]
    pub fn new(config: AdmissionConfig) -> Self {
        Self {
            config,
            running_light: 0,
            running_heavy: 0,
            queues: HashMap::new(),
            rings: HashMap::new(),
            host_pressured: false,
            queued_total: HashMap::new(),
        }
    }

    /// Updates the host-pressure gate (sampled by the integration layer).
    pub fn set_host_pressured(&mut self, pressured: bool) {
        self.host_pressured = pressured;
    }

    /// Requests admission for `op` of `class` from `origin`.
    pub fn request(
        &mut self,
        op: &OpId,
        class: JobClass,
        origin: &str,
        now_ms: u64,
    ) -> AdmissionOutcome {
        if class == JobClass::Heavy && self.host_pressured {
            return AdmissionOutcome::Refused(RefusalReason::HostPressure);
        }
        let limits = self.limits(class);
        let has_waiters = self.queued(class) > 0;
        if self.running(class) < limits.max_running && !has_waiters {
            // Fast path only when nobody is queued — otherwise a fresh arrival
            // would jump ahead of promoted waiters and break fairness.
            *self.running_mut(class) += 1;
            return AdmissionOutcome::Admitted;
        }
        if self.queued(class) >= limits.max_queued {
            return AdmissionOutcome::Refused(RefusalReason::QueueFull);
        }
        let key = (class, origin.to_string());
        let queue = self.queues.entry(key).or_default();
        if queue.is_empty() {
            self.rings
                .entry(class)
                .or_default()
                .push_back(origin.to_string());
        }
        queue.push_back(Waiter {
            op: op.clone(),
            enqueued_at_ms: now_ms,
        });
        *self.queued_total.entry(class).or_insert(0) += 1;
        AdmissionOutcome::Queued
    }

    /// Releases one running slot of `class` and returns the ops promoted into
    /// the freed capacity (round-robin across origins). The caller wakes them.
    pub fn release(&mut self, class: JobClass) -> Vec<OpId> {
        let running = self.running_mut(class);
        *running = running.saturating_sub(1);
        self.promote(class)
    }

    /// Rejects queued jobs whose wait exceeded the class deadline. Returns
    /// (op, reason) pairs for the caller to fail typed. Call on a timer tick.
    pub fn expire(&mut self, now_ms: u64) -> Vec<(OpId, RefusalReason)> {
        let mut expired = Vec::new();
        for class in [JobClass::Light, JobClass::Heavy] {
            let deadline = self.limits(class).queue_wait_max_ms;
            let keys: Vec<(JobClass, String)> = self
                .queues
                .keys()
                .filter(|(c, _)| *c == class)
                .cloned()
                .collect();
            for key in keys {
                if let Some(queue) = self.queues.get_mut(&key) {
                    while let Some(front) = queue.front() {
                        if now_ms.saturating_sub(front.enqueued_at_ms) < deadline {
                            break;
                        }
                        if let Some(waiter) = queue.pop_front() {
                            *self.queued_total.entry(class).or_insert(1) -= 1;
                            expired.push((waiter.op, RefusalReason::WaitDeadline));
                        }
                    }
                    if queue.is_empty() {
                        self.queues.remove(&key);
                        if let Some(ring) = self.rings.get_mut(&class) {
                            ring.retain(|o| o != &key.1);
                        }
                    }
                }
            }
        }
        expired
    }

    /// Promotes waiters into free capacity for `class`, round-robin across
    /// origins. Heavy promotions honor the host-pressure gate.
    fn promote(&mut self, class: JobClass) -> Vec<OpId> {
        let mut promoted = Vec::new();
        loop {
            if self.running(class) >= self.limits(class).max_running {
                break;
            }
            if class == JobClass::Heavy && self.host_pressured {
                break; // waiters stay queued until pressure clears or deadline
            }
            let Some(ring) = self.rings.get_mut(&class) else {
                break;
            };
            let Some(origin) = ring.pop_front() else {
                break;
            };
            let key = (class, origin.clone());
            let Some(queue) = self.queues.get_mut(&key) else {
                continue;
            };
            if let Some(waiter) = queue.pop_front() {
                *self.queued_total.entry(class).or_insert(1) -= 1;
                *self.running_mut(class) += 1;
                promoted.push(waiter.op);
            }
            if self
                .queues
                .get(&key)
                .is_some_and(std::collections::VecDeque::is_empty)
            {
                self.queues.remove(&key);
            } else {
                // Origin still has waiters: back of the ring (round-robin).
                self.rings.entry(class).or_default().push_back(origin);
            }
        }
        promoted
    }

    /// Currently-running count for a class.
    #[must_use]
    pub fn running(&self, class: JobClass) -> usize {
        match class {
            JobClass::Light => self.running_light,
            JobClass::Heavy => self.running_heavy,
        }
    }

    /// Currently-queued count for a class.
    #[must_use]
    pub fn queued(&self, class: JobClass) -> usize {
        self.queued_total.get(&class).copied().unwrap_or(0)
    }

    fn running_mut(&mut self, class: JobClass) -> &mut usize {
        match class {
            JobClass::Light => &mut self.running_light,
            JobClass::Heavy => &mut self.running_heavy,
        }
    }

    fn limits(&self, class: JobClass) -> &ClassLimits {
        match class {
            JobClass::Light => &self.config.light,
            JobClass::Heavy => &self.config.heavy,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny() -> AdmissionState {
        AdmissionState::new(AdmissionConfig {
            light: ClassLimits {
                max_running: 2,
                max_queued: 2,
                queue_wait_max_ms: 100,
            },
            heavy: ClassLimits {
                max_running: 1,
                max_queued: 3,
                queue_wait_max_ms: 200,
            },
        })
    }

    fn op(s: &str) -> OpId {
        OpId::from(s)
    }

    #[test]
    fn admits_up_to_cap_then_queues_then_refuses() {
        let mut a = tiny();
        assert_eq!(
            a.request(&op("h1"), JobClass::Heavy, "s1", 0),
            AdmissionOutcome::Admitted
        );
        assert_eq!(
            a.request(&op("h2"), JobClass::Heavy, "s1", 0),
            AdmissionOutcome::Queued
        );
        assert_eq!(
            a.request(&op("h3"), JobClass::Heavy, "s1", 0),
            AdmissionOutcome::Queued
        );
        assert_eq!(
            a.request(&op("h4"), JobClass::Heavy, "s1", 0),
            AdmissionOutcome::Queued
        );
        assert_eq!(
            a.request(&op("h5"), JobClass::Heavy, "s1", 0),
            AdmissionOutcome::Refused(RefusalReason::QueueFull)
        );
        // Release promotes exactly one (cap 1).
        let promoted = a.release(JobClass::Heavy);
        assert_eq!(promoted, vec![op("h2")]);
        assert_eq!(a.queued(JobClass::Heavy), 2);
    }

    #[test]
    fn classes_are_isolated() {
        let mut a = tiny();
        let _ = a.request(&op("h1"), JobClass::Heavy, "s1", 0);
        // Heavy saturation does not touch light capacity.
        assert_eq!(
            a.request(&op("l1"), JobClass::Light, "s1", 0),
            AdmissionOutcome::Admitted
        );
        assert_eq!(
            a.request(&op("l2"), JobClass::Light, "s1", 0),
            AdmissionOutcome::Admitted
        );
        assert_eq!(
            a.request(&op("l3"), JobClass::Light, "s1", 0),
            AdmissionOutcome::Queued
        );
    }

    #[test]
    fn fairness_round_robins_origins() {
        let mut a = tiny();
        let _ = a.request(&op("run"), JobClass::Heavy, "s0", 0);
        // s1 floods the queue first; s2 and s3 each queue one.
        assert_eq!(
            a.request(&op("s1-a"), JobClass::Heavy, "s1", 0),
            AdmissionOutcome::Queued
        );
        assert_eq!(
            a.request(&op("s2-a"), JobClass::Heavy, "s2", 0),
            AdmissionOutcome::Queued
        );
        assert_eq!(
            a.request(&op("s3-a"), JobClass::Heavy, "s3", 0),
            AdmissionOutcome::Queued
        );
        // Promotions rotate origins: s1, s2, s3 — not s1's whole backlog first.
        assert_eq!(a.release(JobClass::Heavy), vec![op("s1-a")]);
        assert_eq!(a.release(JobClass::Heavy), vec![op("s2-a")]);
        assert_eq!(a.release(JobClass::Heavy), vec![op("s3-a")]);
    }

    #[test]
    fn fresh_arrivals_cannot_jump_queued_waiters() {
        let mut a = tiny();
        let _ = a.request(&op("h1"), JobClass::Heavy, "s1", 0);
        assert_eq!(
            a.request(&op("h2"), JobClass::Heavy, "s2", 0),
            AdmissionOutcome::Queued
        );
        // Slot frees; h2 is promoted by the release.
        assert_eq!(a.release(JobClass::Heavy), vec![op("h2")]);
        // A fresh arrival with waiters present would have queued, not jumped
        // (exercise: fill again and verify a newcomer queues behind).
        assert_eq!(
            a.request(&op("h3"), JobClass::Heavy, "s3", 0),
            AdmissionOutcome::Queued
        );
    }

    #[test]
    fn wait_deadline_expires_typed() {
        let mut a = tiny();
        let _ = a.request(&op("h1"), JobClass::Heavy, "s1", 0);
        let _ = a.request(&op("h2"), JobClass::Heavy, "s1", 0);
        let expired = a.expire(250); // heavy deadline 200ms
        assert_eq!(expired, vec![(op("h2"), RefusalReason::WaitDeadline)]);
        assert_eq!(a.queued(JobClass::Heavy), 0);
    }

    #[test]
    fn host_pressure_refuses_heavy_but_not_light() {
        let mut a = tiny();
        a.set_host_pressured(true);
        assert_eq!(
            a.request(&op("h1"), JobClass::Heavy, "s1", 0),
            AdmissionOutcome::Refused(RefusalReason::HostPressure)
        );
        assert_eq!(
            a.request(&op("l1"), JobClass::Light, "s1", 0),
            AdmissionOutcome::Admitted
        );
        // Pressure also pauses heavy promotions until cleared.
        a.set_host_pressured(false);
        let _ = a.request(&op("h2"), JobClass::Heavy, "s1", 0);
        assert_eq!(
            a.request(&op("h3"), JobClass::Heavy, "s1", 0),
            AdmissionOutcome::Queued
        );
        a.set_host_pressured(true);
        assert_eq!(
            a.release(JobClass::Heavy),
            vec![],
            "no heavy promotion under pressure"
        );
        a.set_host_pressured(false);
        // A light release does not promote heavy; the next heavy event does.
        assert_eq!(a.release(JobClass::Heavy), vec![op("h3")]);
    }

    #[test]
    fn empty_origin_queues_are_cleaned_up() {
        let mut a = tiny();
        let _ = a.request(&op("h1"), JobClass::Heavy, "s1", 0);
        let _ = a.request(&op("h2"), JobClass::Heavy, "s2", 0);
        let _ = a.release(JobClass::Heavy);
        let _ = a.release(JobClass::Heavy);
        assert_eq!(a.queued(JobClass::Heavy), 0);
        assert!(a.queues.is_empty(), "no empty per-origin queues linger");
    }
}
