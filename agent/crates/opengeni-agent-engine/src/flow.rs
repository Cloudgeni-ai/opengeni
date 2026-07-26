//! Send-side credit flow control with attach-generation fencing.
//!
//! One [`CreditFlow`] exists per op. It answers exactly one question — "may I
//! send this frame now?" — under the protocol's rules (PROTOCOL.md §Flow
//! control + rulings B2/M1/M2):
//!
//! * The op may have at most `window` bytes of UNACKED Data payload in flight
//!   while a consumer is attached. Window exhaustion is the signal to stop
//!   reading the child's pipes (end-to-end throttling); it never blocks
//!   Progress frames (payload 0), which is what keeps the M1 deadlock-healing
//!   path (server re-acks on Progress) alive while the window is exhausted.
//! * Acks are cumulative and taken monotonically; the granted
//!   `credit_bytes` is an ABSOLUTE window replacement, so the server can
//!   resize the window dynamically.
//! * Every attach carries a generation (the consumer's Temporal attempt
//!   number). Only the highest generation ever seen may drive replay and
//!   credit; a zombie consumer's stale acks are ignored (ruling B2).
//!
//! Ack accounting contract (documented, single call site in the engine
//! assembly): freed sent-bytes must be computed against the retention log
//! BEFORE freeing, because the frames are gone afterwards:
//!
//! ```text
//! let upper = acked_seq.min(flow.sent_hi());
//! let freed = retention.payload_bytes_in_range(retention.floor(), upper);
//! retention.ack(acked_seq);
//! flow.on_ack(gen, credit_bytes, freed);
//! ```

/// Outcome of an attach request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachOutcome {
    /// The attach was accepted; the caller should replay retained frames
    /// `> from_seq` (each passing through `may_send`/`on_sent`) and then
    /// resume live flow.
    Accepted,
    /// The attach carried a generation lower than one already seen — a
    /// zombie/stale consumer. It must be refused (the current consumer owns
    /// the stream).
    StaleGeneration {
        /// The generation currently owning the stream.
        current: u64,
    },
}

/// Outcome of an ack.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AckOutcome {
    /// The ack was applied (window replaced, sent-bytes freed).
    Applied,
    /// The ack came from a stale generation and was ignored.
    StaleGeneration {
        /// The generation currently owning the stream.
        current: u64,
    },
}

/// Per-op send-side flow state. See the module docs for the rules.
#[derive(Debug)]
pub struct CreditFlow {
    /// Highest attach generation seen; 0 = never attached.
    attach_gen: u64,
    /// Whether a consumer is currently attached (transport reachable).
    attached: bool,
    /// The current absolute window grant in payload bytes.
    window_bytes: u64,
    /// Highest seq sent in the current attachment.
    sent_hi: u64,
    /// Unacked Data/Exit payload bytes in flight in the current attachment.
    unacked_sent_bytes: u64,
}

impl CreditFlow {
    /// A fresh, detached flow (no consumer yet).
    #[must_use]
    pub fn new() -> Self {
        Self {
            attach_gen: 0,
            attached: false,
            window_bytes: 0,
            sent_hi: 0,
            unacked_sent_bytes: 0,
        }
    }

    /// Handles an attach request from a consumer at `generation`, resuming
    /// from `from_seq` (its cumulative ack floor) with an initial `window`.
    ///
    /// A generation EQUAL to the current one is accepted (a redelivered
    /// OpAttach must be idempotent — the replay it triggers is harmless
    /// because server reassembly is seq-idempotent); a lower one is refused.
    /// Generation 0 is never valid.
    pub fn attach(&mut self, generation: u64, from_seq: u64, window: u64) -> AttachOutcome {
        if generation == 0 || generation < self.attach_gen {
            return AttachOutcome::StaleGeneration {
                current: self.attach_gen,
            };
        }
        self.attach_gen = generation;
        self.attached = true;
        self.window_bytes = window;
        self.sent_hi = from_seq;
        self.unacked_sent_bytes = 0;
        AttachOutcome::Accepted
    }

    /// Marks the consumer unreachable (transport gone). Sending stops; the
    /// retention log keeps accumulating (that is its job, not ours).
    pub fn detach(&mut self) {
        self.attached = false;
    }

    /// Whether a consumer is currently attached.
    #[must_use]
    pub fn is_attached(&self) -> bool {
        self.attached
    }

    /// The generation currently owning the stream (0 = never attached).
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.attach_gen
    }

    /// Highest seq sent in the current attachment.
    #[must_use]
    pub fn sent_hi(&self) -> u64 {
        self.sent_hi
    }

    /// May a frame with this payload size be sent now? Zero-payload frames
    /// (Progress) are always sendable while attached — they are the liveness
    /// and ack-healing channel and consume no credit.
    #[must_use]
    pub fn may_send(&self, payload_len: u64) -> bool {
        if !self.attached {
            return false;
        }
        if payload_len == 0 {
            return true;
        }
        self.unacked_sent_bytes.saturating_add(payload_len) <= self.window_bytes
    }

    /// Remaining send allowance in payload bytes (0 when detached).
    #[must_use]
    pub fn allowance(&self) -> u64 {
        if !self.attached {
            return 0;
        }
        self.window_bytes.saturating_sub(self.unacked_sent_bytes)
    }

    /// Records a frame as sent.
    pub fn on_sent(&mut self, seq: u64, payload_len: u64) {
        debug_assert!(seq > self.sent_hi, "frames are sent in seq order");
        self.sent_hi = seq.max(self.sent_hi);
        self.unacked_sent_bytes = self.unacked_sent_bytes.saturating_add(payload_len);
    }

    /// Applies a cumulative ack from `generation`: replaces the window with
    /// the absolute `credit_bytes` grant and releases `freed_sent_bytes`
    /// (computed by the caller against retention BEFORE freeing — see module
    /// docs).
    ///
    /// ONLY the exact current attach generation applies (design-review ruling
    /// 2026-07-10, supersedes the earlier reject-below-only rule): a STALE
    /// generation is a zombie whose acks say nothing about what the live
    /// consumer holds, and a FUTURE generation that never attached is a
    /// protocol violation or hostile probe — accepting either could grant a
    /// window (or, at the caller, free retention / honor a final ack) on
    /// behalf of a consumer that does not exist. The caller must gate EVERY
    /// ack side effect — retention floor, final-ack honoring — on `Applied`.
    pub fn on_ack(
        &mut self,
        generation: u64,
        credit_bytes: u64,
        freed_sent_bytes: u64,
    ) -> AckOutcome {
        if generation != self.attach_gen {
            return AckOutcome::StaleGeneration {
                current: self.attach_gen,
            };
        }
        self.window_bytes = credit_bytes;
        self.unacked_sent_bytes = self.unacked_sent_bytes.saturating_sub(freed_sent_bytes);
        AckOutcome::Applied
    }
}

impl Default for CreditFlow {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attached_flow(window: u64) -> CreditFlow {
        let mut flow = CreditFlow::new();
        assert_eq!(flow.attach(1, 0, window), AttachOutcome::Accepted);
        flow
    }

    #[test]
    fn detached_flow_sends_nothing() {
        let flow = CreditFlow::new();
        assert!(
            !flow.may_send(0),
            "even progress needs an attached consumer"
        );
        assert_eq!(flow.allowance(), 0);
    }

    #[test]
    fn window_bounds_data_but_never_progress() {
        let mut flow = attached_flow(100);
        assert!(flow.may_send(60));
        flow.on_sent(1, 60);
        assert!(flow.may_send(40));
        flow.on_sent(2, 40);
        // Window exhausted: data blocked, progress still flows (M1 healing).
        assert!(!flow.may_send(1));
        assert!(flow.may_send(0));
        assert_eq!(flow.allowance(), 0);
    }

    #[test]
    fn ack_frees_sent_bytes_and_replaces_window_absolutely() {
        let mut flow = attached_flow(100);
        flow.on_sent(1, 100);
        assert!(!flow.may_send(1));
        // Server acked 100 bytes and grants a BIGGER window (dynamic resize).
        assert_eq!(flow.on_ack(1, 200, 100), AckOutcome::Applied);
        assert_eq!(flow.allowance(), 200);
        assert!(flow.may_send(150));
    }

    #[test]
    fn stale_generation_acks_and_attaches_are_refused() {
        let mut flow = attached_flow(100);
        assert_eq!(flow.attach(3, 5, 64), AttachOutcome::Accepted);
        // A zombie consumer at gen 1/2 can neither attach nor ack.
        assert_eq!(
            flow.attach(2, 0, 1024),
            AttachOutcome::StaleGeneration { current: 3 }
        );
        assert_eq!(
            flow.on_ack(1, 1024, 50),
            AckOutcome::StaleGeneration { current: 3 }
        );
        // Its refused messages changed nothing.
        assert_eq!(flow.allowance(), 64);
        assert_eq!(flow.generation(), 3);
    }

    #[test]
    fn equal_generation_reattach_is_idempotent() {
        let mut flow = attached_flow(100);
        flow.on_sent(1, 80);
        // The same consumer re-sends OpAttach (its reply was lost): accepted,
        // send state resets to its ack floor, window re-granted.
        assert_eq!(flow.attach(1, 0, 100), AttachOutcome::Accepted);
        assert_eq!(flow.allowance(), 100);
        assert_eq!(flow.sent_hi(), 0);
    }

    #[test]
    fn generation_zero_is_never_valid() {
        let mut flow = CreditFlow::new();
        assert_eq!(
            flow.attach(0, 0, 100),
            AttachOutcome::StaleGeneration { current: 0 }
        );
        assert!(!flow.is_attached());
    }

    #[test]
    fn detach_stops_sending_reattach_resumes() {
        let mut flow = attached_flow(100);
        flow.on_sent(1, 10);
        flow.detach();
        assert!(!flow.may_send(0));
        assert_eq!(flow.attach(2, 1, 100), AttachOutcome::Accepted);
        assert!(flow.may_send(100), "fresh window after re-attach");
    }
}
