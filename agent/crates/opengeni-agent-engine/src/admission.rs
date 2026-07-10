//! Job admission: fair start-ordering + derived circuit breakers. NOT a
//! throughput governor.
//!
//! Doctrine (LIMITS-DOCTRINE.md, supersedes the earlier fixed-cap design):
//! the runner holds **no concurrency policy**. It admits everything it is
//! asked to run; the swarm/server owns pacing, informed by the capacity
//! telemetry the runner reports upward ([`AdmissionState::snapshot`] feeds
//! the heartbeat). Physical protection is the kernel's job (per-op cgroup
//! leaves, OOM scoring) — counting ops was always a proxy, and proxies don't
//! ship as policy. What remains here:
//!
//! * **Liveness never enters admission** — ping/hello are answered inline by
//!   the transport layer and are invisible here.
//! * Two classes, **Light** (stat/list/mkdir/move/remove/pty-control) and
//!   **Heavy** (exec, large fs transfers, git), kept for *telemetry shape and
//!   fairness domains*, not for caps.
//! * **Per-origin fairness as start ordering**: when anything IS waiting
//!   (breaker saturation only), queued jobs promote round-robin across origin
//!   ids (workspace+session), so one chatty session cannot starve the rest.
//!   Ordering, never denial.
//! * **Circuit breakers, not caps**: `max_running`/`max_queued` default to
//!   `None` (unbounded) and, when set via [`AdmissionConfig::derive`], come
//!   from measured host headroom (fds, pids) at orders of magnitude above
//!   sane load. A breaker trip is LOUD (typed refusal naming the breaker) and
//!   means a pathology (fork-bomb-shaped bug), never legitimate load shaping.
//! * **No queue-wait deadline by default**: a queued job waits until its
//!   caller cancels — patience belongs to the caller (C in the taxonomy).
//!   `queue_wait_max_ms` exists as an optional breaker for tests/constrained
//!   deployments only.
//! * **No pressure-based refusal**: host pressure (PSI, memory headroom) is
//!   REPORTED upward in heartbeats and acted on by the server, which can
//!   pace, shed, or restart the machine — the brain is in the cloud and the
//!   state of record is server-side.
//!
//! Everything is pure and clock-injected: the integration layer owns timers
//! (it calls [`AdmissionState::expire`] on a tick — a no-op under default
//! config) and samples [`crate::HostCapacity`] for `derive`.

use std::collections::{HashMap, VecDeque};

use crate::{HostCapacity, OpId};

/// Which admission class a job belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum JobClass {
    /// Cheap, latency-sensitive control ops.
    Light,
    /// Long-running, resource-owning ops (exec, big transfers, git).
    Heavy,
}

/// Per-class breakers. `None` everywhere (the default) = unbounded: admit
/// immediately, always. `Some` values are circuit breakers — set them from
/// measured capacity ([`AdmissionConfig::derive`]) or explicitly in tests,
/// never as ambient policy constants.
#[derive(Debug, Clone, Default)]
pub struct ClassLimits {
    /// Breaker on concurrently-running jobs of this class.
    pub max_running: Option<usize>,
    /// Breaker on jobs of this class waiting in the queue.
    pub max_queued: Option<usize>,
    /// Optional breaker on queue wait. `None` = a queued job waits until its
    /// caller cancels it (the default: patience is the caller's).
    pub queue_wait_max_ms: Option<u64>,
}

/// Admission configuration. The default is **fully unbounded** — capable, not
/// constrained. Use [`AdmissionConfig::derive`] to install headroom-derived
/// breakers at wiring time.
#[derive(Debug, Clone, Default)]
pub struct AdmissionConfig {
    /// Breakers for light ops.
    pub light: ClassLimits,
    /// Breakers for heavy ops.
    pub heavy: ClassLimits,
}

/// Floor under every derived breaker: a misread /proc or a bizarre rlimit
/// must never constrain a normal host. Absolute constants are only legal as
/// floors (doctrine rule R).
const DERIVED_BREAKER_FLOOR: usize = 256;

/// Breaker on total queued entries per class when derived. Entries are ~100
/// bytes; 100k of them is ~10MiB — far above any sane backlog, cheap enough
/// to hold.
const DERIVED_QUEUE_BREAKER: usize = 100_000;

impl AdmissionConfig {
    /// Derives breaker values from measured host capacity. The numbers scale
    /// with the machine: a supercomputer gets tens of thousands of concurrent
    /// ops, a starved VPS degrades loudly instead of silently.
    ///
    /// Derivation: a heavy op holds ~4 fds (three pipes + anchor) and at
    /// least one pid; a light op holds a transient fd or two and no child.
    /// The breakers claim at most a quarter of the available fd headroom
    /// (heavy) or half (light, cheaper per-op), and half the pid headroom.
    #[must_use]
    pub fn derive(capacity: &HostCapacity) -> Self {
        let fd = usize::try_from(capacity.fd_headroom).unwrap_or(usize::MAX);
        let pid = usize::try_from(capacity.pid_headroom).unwrap_or(usize::MAX);
        let heavy_running = (fd / 8).min(pid / 2).max(DERIVED_BREAKER_FLOOR);
        let light_running = (fd / 2).max(DERIVED_BREAKER_FLOOR);
        Self {
            light: ClassLimits {
                max_running: Some(light_running),
                max_queued: Some(DERIVED_QUEUE_BREAKER),
                queue_wait_max_ms: None,
            },
            heavy: ClassLimits {
                max_running: Some(heavy_running),
                max_queued: Some(DERIVED_QUEUE_BREAKER),
                queue_wait_max_ms: None,
            },
        }
    }
}

/// Why an admission was refused. Refusals only happen when a circuit breaker
/// trips — each maps to a typed retryable response whose `backpressure`
/// detail names the tripped breaker, and each is telemetry-worthy (a trip
/// means pathology, not load).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalReason {
    /// The class's queued-entries breaker tripped.
    QueueFull,
    /// The job waited past the class's optional queue-wait breaker.
    WaitDeadline,
}

/// Outcome of an admission request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmissionOutcome {
    /// Run now. The caller MUST call [`AdmissionState::release`] when done.
    Admitted,
    /// Queued; the caller waits. Promotion arrives via the values returned
    /// from [`AdmissionState::release`] / [`AdmissionState::expire`].
    Queued,
    /// A breaker tripped. Typed, loud, telemetry-worthy.
    Refused(RefusalReason),
}

/// Point-in-time counts for the heartbeat's capacity telemetry — the upward
/// report the server paces against (FAILURE-VISIBILITY.md, out-of-band
/// plane). The impure half samples this every heartbeat tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdmissionSnapshot {
    /// Running light ops.
    pub light_running: usize,
    /// Queued light ops (only ever non-zero once a breaker saturates).
    pub light_queued: usize,
    /// Running heavy ops.
    pub heavy_running: usize,
    /// Queued heavy ops.
    pub heavy_queued: usize,
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
            queued_total: HashMap::new(),
        }
    }

    /// Requests admission for `op` of `class` from `origin`. Under the
    /// default (unbounded) config this always returns `Admitted` — queueing
    /// and refusal exist only behind tripped breakers.
    pub fn request(
        &mut self,
        op: &OpId,
        class: JobClass,
        origin: &str,
        now_ms: u64,
    ) -> AdmissionOutcome {
        let has_waiters = self.queued(class) > 0;
        if self.below_running_breaker(class) && !has_waiters {
            // Fast path only when nobody is queued — otherwise a fresh arrival
            // would jump ahead of promoted waiters and break fairness.
            *self.running_mut(class) += 1;
            return AdmissionOutcome::Admitted;
        }
        if let Some(max_queued) = self.limits(class).max_queued {
            if self.queued(class) >= max_queued {
                return AdmissionOutcome::Refused(RefusalReason::QueueFull);
            }
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

    /// Rejects queued jobs whose wait exceeded the class's optional
    /// queue-wait breaker. Returns (op, reason) pairs for the caller to fail
    /// typed. A no-op for classes with `queue_wait_max_ms: None` (the
    /// default — queued jobs wait until their caller cancels).
    pub fn expire(&mut self, now_ms: u64) -> Vec<(OpId, RefusalReason)> {
        let mut expired = Vec::new();
        for class in [JobClass::Light, JobClass::Heavy] {
            let Some(deadline) = self.limits(class).queue_wait_max_ms else {
                continue;
            };
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

    /// Capacity telemetry for the heartbeat (the upward report the server
    /// paces against).
    #[must_use]
    pub fn snapshot(&self) -> AdmissionSnapshot {
        AdmissionSnapshot {
            light_running: self.running(JobClass::Light),
            light_queued: self.queued(JobClass::Light),
            heavy_running: self.running(JobClass::Heavy),
            heavy_queued: self.queued(JobClass::Heavy),
        }
    }

    /// Promotes waiters into free capacity for `class`, round-robin across
    /// origins.
    fn promote(&mut self, class: JobClass) -> Vec<OpId> {
        let mut promoted = Vec::new();
        loop {
            if !self.below_running_breaker(class) {
                break;
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

    fn below_running_breaker(&self, class: JobClass) -> bool {
        self.limits(class)
            .max_running
            .is_none_or(|max| self.running(class) < max)
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

    /// Explicit tiny breakers: exercises the breaker/queue/fairness machinery.
    /// Real deployments run unbounded or `derive`d — these values are test
    /// instrumentation, not recommendations.
    fn tiny() -> AdmissionState {
        AdmissionState::new(AdmissionConfig {
            light: ClassLimits {
                max_running: Some(2),
                max_queued: Some(2),
                queue_wait_max_ms: Some(100),
            },
            heavy: ClassLimits {
                max_running: Some(1),
                max_queued: Some(3),
                queue_wait_max_ms: Some(200),
            },
        })
    }

    fn op(s: &str) -> OpId {
        OpId::from(s)
    }

    #[test]
    fn default_config_admits_everything_immediately() {
        // CAPABLE, NOT CONSTRAINED: the default admission has no numbers in
        // it at all — 10k concurrent heavy ops admit without a single queue
        // or refusal. (E12's in-process half.)
        let mut a = AdmissionState::new(AdmissionConfig::default());
        for i in 0..10_000 {
            assert_eq!(
                a.request(&op(&format!("h{i}")), JobClass::Heavy, "s1", 0),
                AdmissionOutcome::Admitted
            );
        }
        assert_eq!(a.running(JobClass::Heavy), 10_000);
        assert_eq!(a.queued(JobClass::Heavy), 0);
        // And with no wait breaker configured, expire() can never reject.
        assert!(a.expire(u64::MAX).is_empty());
    }

    #[test]
    fn derived_breakers_scale_with_host_capacity() {
        // Doubling the host doubles the breakers: no fixed ceiling anywhere
        // below them (E12 scaling sanity, pure half).
        let small = HostCapacity {
            fd_headroom: 65_536,
            pid_headroom: 30_000,
            ..HostCapacity::default()
        };
        let big = HostCapacity {
            fd_headroom: 131_072,
            pid_headroom: 60_000,
            ..HostCapacity::default()
        };
        let c_small = AdmissionConfig::derive(&small);
        let c_big = AdmissionConfig::derive(&big);
        let sr = c_small.heavy.max_running.unwrap();
        let br = c_big.heavy.max_running.unwrap();
        assert_eq!(br, sr * 2);
        assert!(
            sr >= 4_096,
            "a normal host's breaker is far above sane load"
        );
        // Wait breakers never come from derivation — patience is the caller's.
        assert_eq!(c_big.heavy.queue_wait_max_ms, None);
        assert_eq!(c_big.light.queue_wait_max_ms, None);
    }

    #[test]
    fn derived_breakers_respect_the_floor() {
        let starved = HostCapacity {
            fd_headroom: 64,
            pid_headroom: 32,
            ..HostCapacity::default()
        };
        let c = AdmissionConfig::derive(&starved);
        assert_eq!(c.heavy.max_running, Some(DERIVED_BREAKER_FLOOR));
        assert_eq!(c.light.max_running, Some(DERIVED_BREAKER_FLOOR));
    }

    #[test]
    fn admits_up_to_breaker_then_queues_then_refuses() {
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
        // Release promotes exactly one (breaker 1).
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
    fn wait_breaker_expires_typed_only_when_configured() {
        let mut a = tiny();
        let _ = a.request(&op("h1"), JobClass::Heavy, "s1", 0);
        let _ = a.request(&op("h2"), JobClass::Heavy, "s1", 0);
        let expired = a.expire(250); // heavy wait breaker 200ms
        assert_eq!(expired, vec![(op("h2"), RefusalReason::WaitDeadline)]);
        assert_eq!(a.queued(JobClass::Heavy), 0);
    }

    #[test]
    fn snapshot_reports_capacity_telemetry() {
        let mut a = tiny();
        let _ = a.request(&op("h1"), JobClass::Heavy, "s1", 0);
        let _ = a.request(&op("h2"), JobClass::Heavy, "s1", 0);
        let _ = a.request(&op("l1"), JobClass::Light, "s1", 0);
        assert_eq!(
            a.snapshot(),
            AdmissionSnapshot {
                light_running: 1,
                light_queued: 0,
                heavy_running: 1,
                heavy_queued: 1,
            }
        );
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
