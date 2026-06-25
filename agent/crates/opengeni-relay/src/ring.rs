//! A bounded replay ring buffer for stream-frame resume (dossier §10.5/§10.6).
//!
//! When a peer reconnects with `resume_from_seq`, the relay replays the frames it
//! still holds from that seq so a relay-pod death (or a transient transport blip)
//! is invisible. The buffer is BOUNDED: it keeps at most `capacity` of the most
//! recent frames per channel direction; older frames are evicted. A
//! `resume_from_seq` older than the oldest retained frame replays whatever is still
//! held (best-effort — the viewer then sees a small gap, which for a pty is
//! cosmetic and for a desktop self-heals on the next full frame).
//!
//! This is the ONLY per-channel state the relay holds, and it is bounded — the
//! relay remains stateless-beyond-live-channels (§10.5).

use opengeni_agent_proto::v1::StreamFrame;
use std::collections::VecDeque;

/// A bounded ring of the most recent [`StreamFrame`]s for one channel direction.
#[derive(Debug)]
pub struct ReplayRing {
    frames: VecDeque<StreamFrame>,
    capacity: usize,
}

impl ReplayRing {
    /// A ring retaining at most `capacity` frames (evicting oldest-first).
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        Self {
            frames: VecDeque::with_capacity(capacity.min(1024)),
            capacity: capacity.max(1),
        }
    }

    /// Record a forwarded frame, evicting the oldest if at capacity. Returns the
    /// current depth (for the high-water metric).
    pub fn push(&mut self, frame: StreamFrame) -> usize {
        if self.frames.len() >= self.capacity {
            self.frames.pop_front();
        }
        self.frames.push_back(frame);
        self.frames.len()
    }

    /// The frames to replay for a reconnecting peer that last processed up to
    /// (exclusive) `resume_from_seq` — i.e. every retained frame with `seq >=
    /// resume_from_seq`, in order. Empty when nothing matches (the peer is fully
    /// caught up, or the buffer rolled past it).
    #[must_use]
    pub fn replay_from(&self, resume_from_seq: u64) -> Vec<StreamFrame> {
        self.frames
            .iter()
            .filter(|f| f.seq >= resume_from_seq)
            .cloned()
            .collect()
    }

    /// The current number of buffered frames.
    #[must_use]
    pub fn len(&self) -> usize {
        self.frames.len()
    }

    /// Whether the ring holds no frames.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(seq: u64) -> StreamFrame {
        StreamFrame {
            channel_id: "ch".to_string(),
            seq,
            data: prost::bytes::Bytes::from(format!("f{seq}")),
            produced_at_ms: 0,
        }
    }

    #[test]
    fn replays_from_a_seq() {
        let mut ring = ReplayRing::new(10);
        for s in 0..5 {
            ring.push(frame(s));
        }
        let replay = ring.replay_from(2);
        assert_eq!(
            replay.iter().map(|f| f.seq).collect::<Vec<_>>(),
            vec![2, 3, 4]
        );
    }

    #[test]
    fn evicts_oldest_at_capacity() {
        let mut ring = ReplayRing::new(3);
        for s in 0..6 {
            ring.push(frame(s));
        }
        assert_eq!(ring.len(), 3);
        // Only 3,4,5 remain; a resume from 0 replays what is still held.
        assert_eq!(
            ring.replay_from(0)
                .iter()
                .map(|f| f.seq)
                .collect::<Vec<_>>(),
            vec![3, 4, 5]
        );
    }

    #[test]
    fn replay_past_the_tail_is_empty() {
        let mut ring = ReplayRing::new(3);
        ring.push(frame(0));
        ring.push(frame(1));
        assert!(ring.replay_from(99).is_empty());
    }
}
