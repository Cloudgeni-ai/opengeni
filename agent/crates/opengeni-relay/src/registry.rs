//! The channel registry — the stateful-but-bounded pairing + splice core.
//!
//! Keyed by [`ChannelKey`] (`{workspaceId, agentId, port}`), the registry holds the
//! live channels and pairs a PRODUCER (`role=AGENT`) with a CONSUMER (`role=CLIENT`)
//! that present the same key. It is the relay's ONLY state, and it is bounded:
//! per-channel it keeps two [`ReplayRing`]s (one per direction, for resume) and the
//! two peers' outbound queues; nothing persists past a channel's life.
//!
//! # The epoch fence (dossier §10.6/§18)
//!
//! Each live channel tracks an `epoch_floor` — the highest lease/active epoch any
//! VIEWER token has presented for the key. A swap-away bumps `lease_epoch` at the
//! control plane and the next viewer is minted a token with the new (higher) epoch;
//! the floor advances. A viewer presenting a token with `leaseEpoch < epoch_floor`
//! is REJECTED ([`AttachError::StaleEpoch`]) — it cannot reach a swapped-away box.
//! The producer (`ogr_`) token carries no epoch (it is the user's machine, fenced
//! at the control plane by the lease); the floor is established + advanced purely by
//! viewer tokens.
//!
//! # Splice + backpressure
//!
//! Each side hands the registry a bounded outbound queue
//! ([`PeerSink`]); a frame from one role is [`forward`](ChannelRegistry::forward)ed
//! to the OTHER role's sink, after a per-token rate-limit check and a ring push. A
//! full sink (a slow peer) sheds the frame (counted) rather than buffering
//! unboundedly — the bounded queue + ring is the backpressure point (§10.5).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use opengeni_agent_proto::v1::StreamFrame;
use opengeni_agent_stream::codec::RelayMessage;
use opengeni_agent_stream::ChannelKey;

use crate::config::RelayConfig;
use crate::metrics::RelayMetrics;
use crate::rate_limit::LeakyBucket;
use crate::ring::ReplayRing;

/// Which end of a channel a connection is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The agent producing pty/desktop bytes (and receiving input).
    Agent,
    /// The viewer consuming them (and sending input back).
    Client,
}

/// The bounded outbound queue to one peer. A clone of the `tokio::mpsc::Sender` the
/// connection task drains onto its socket. `try_send` is non-blocking so a slow
/// peer sheds rather than stalling the splice (the queue is the backpressure point).
pub type PeerSink = tokio::sync::mpsc::Sender<RelayMessage>;

/// Why an attach (a `StreamOpen`) was rejected at the registry layer (AFTER token
/// authenticity passed — these are the scope/fence gates).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachError {
    /// The viewer's token epoch is below the channel's active-epoch floor — it
    /// would reach a swapped-away box. The headline stream-side fence.
    StaleEpoch,
}

impl std::fmt::Display for AttachError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::StaleEpoch => f.write_str("stale epoch (a newer sandbox is active)"),
        }
    }
}

/// A per-side connection generation. Every attach to a `(key, role)` mints a fresh
/// generation; a [`detach`](ChannelRegistry::detach) only clears the side when its
/// generation MATCHES the live one — so the delayed teardown of an OLD connection
/// (a reconnect's stale socket finally closing) can never clobber the NEW connection
/// that already re-attached. This is the relay's reconnect-safety invariant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnGen(u64);

/// The outcome of a successful attach: the seq the peer should resume sending from,
/// the frames to replay immediately, and this connection's generation handle.
#[derive(Debug)]
pub struct Attached {
    /// Echoed in `StreamOpenAck.resume_from_seq`.
    pub resume_from_seq: u64,
    /// Frames to replay to THIS side immediately (the buffered tail the peer already
    /// produced toward this side, from the requested resume point).
    pub replay: Vec<StreamFrame>,
    /// This connection's generation — pass it back to [`detach`](ChannelRegistry::detach)
    /// so a stale teardown cannot clobber a newer reconnect.
    pub gen: ConnGen,
}

/// One side's live state within a channel.
struct Side {
    sink: PeerSink,
    /// The rate-limit bucket metering frames this side PRODUCES.
    bucket: LeakyBucket,
    /// The next seq the relay expects this side to send (its observed cursor).
    next_seq: u64,
    /// This side's live connection generation (the reconnect-safety fence).
    gen: ConnGen,
}

/// The per-channel-direction state: the ring of frames a producer-role pushed
/// toward the consumer (and vice-versa) for resume.
#[derive(Default)]
struct Direction {
    ring: Option<ReplayRing>,
}

/// One live channel: the two sides + the two directional rings + the epoch floor.
struct LiveChannel {
    agent: Option<Side>,
    client: Option<Side>,
    /// Frames agent→client (replayed to a reconnecting client).
    to_client: Direction,
    /// Frames client→agent (replayed to a reconnecting agent).
    to_agent: Direction,
    /// The highest viewer epoch seen — the stale-viewer fence floor.
    epoch_floor: u64,
    /// When the channel was created / last touched (for half-open reaping).
    last_touch: Instant,
}

/// The registry of live channels.
pub struct ChannelRegistry {
    channels: Mutex<HashMap<ChannelKey, LiveChannel>>,
    metrics: RelayMetrics,
    ring_frames: usize,
    rate_burst_bytes: u64,
    rate_bytes_per_sec: u64,
    pair_timeout: Duration,
    /// A monotonic generation counter minted per attach (reconnect-safety).
    gen_counter: std::sync::atomic::AtomicU64,
}

impl ChannelRegistry {
    /// Build a registry from the relay config + metrics sink.
    #[must_use]
    pub fn new(config: &RelayConfig, metrics: RelayMetrics) -> Self {
        Self {
            channels: Mutex::new(HashMap::new()),
            metrics,
            ring_frames: config.ring_frames,
            rate_burst_bytes: config.rate_burst_bytes,
            rate_bytes_per_sec: config.rate_bytes_per_sec,
            pair_timeout: Duration::from_secs(config.pair_timeout_secs),
            gen_counter: std::sync::atomic::AtomicU64::new(1),
        }
    }

    /// The shared metrics handle.
    #[must_use]
    pub fn metrics(&self) -> &RelayMetrics {
        &self.metrics
    }

    /// Lock the channel map, recovering a poisoned lock rather than panicking (a
    /// panic while holding the lock leaves the map structurally valid; recovering
    /// keeps the relay serving). This makes every registry method panic-free.
    fn channels(&self) -> std::sync::MutexGuard<'_, HashMap<ChannelKey, LiveChannel>> {
        self.channels
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Attach a side to its channel. Registers the side's outbound `sink`, advances
    /// the epoch floor (for a client), and returns the resume cursor + any frames to
    /// replay to this side. A `viewer_epoch` is `Some(epoch)` for a CLIENT (the
    /// fence) and `None` for an AGENT.
    ///
    /// `resume_from_seq` is the seq the RECONNECTING side last processed; the relay
    /// replays the OTHER side's buffered frames from there toward this side.
    ///
    /// # Errors
    ///
    /// [`AttachError::StaleEpoch`] when a client's epoch is below the floor.
    pub fn attach(
        &self,
        key: &ChannelKey,
        role: Role,
        viewer_epoch: Option<u64>,
        resume_from_seq: u64,
        sink: PeerSink,
        now: Instant,
    ) -> Result<Attached, AttachError> {
        let mut channels = self.channels();
        let fresh = !channels.contains_key(key);
        let chan = channels.entry(key.clone()).or_insert_with(|| LiveChannel {
            agent: None,
            client: None,
            to_client: Direction::default(),
            to_agent: Direction::default(),
            epoch_floor: 0,
            last_touch: now,
        });
        if fresh {
            self.metrics.channel_opened();
        }
        chan.last_touch = now;

        // Epoch fence (clients only): reject a stale viewer; advance the floor.
        if let Some(epoch) = viewer_epoch {
            if epoch < chan.epoch_floor {
                self.metrics.record_open_rejected();
                // Drop the channel entry if it was created fresh just for this
                // rejected attach and is otherwise empty.
                if chan.agent.is_none() && chan.client.is_none() {
                    let was_fresh = fresh;
                    drop(channels);
                    if was_fresh {
                        self.maybe_remove_empty(key);
                    }
                } else {
                    drop(channels);
                }
                return Err(AttachError::StaleEpoch);
            }
            chan.epoch_floor = chan.epoch_floor.max(epoch);
        }

        let gen = ConnGen(
            self.gen_counter
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        );
        let side = Side {
            sink,
            bucket: LeakyBucket::new(self.rate_burst_bytes, self.rate_bytes_per_sec, now),
            next_seq: resume_from_seq,
            gen,
        };

        // A reconnect is an attach onto a key/role that was already present.
        let reconnect = match role {
            Role::Agent => chan.agent.replace(side).is_some(),
            Role::Client => chan.client.replace(side).is_some(),
        };
        if reconnect {
            self.metrics.record_reconnect();
        }
        self.metrics.record_open_accepted();

        // Replay the buffered frames the PEER produced toward this side, from the
        // resume point. (A reconnecting agent gets the client→agent ring; a
        // reconnecting client gets the agent→client ring.)
        let replay = match role {
            Role::Agent => replay_dir(&chan.to_agent, resume_from_seq),
            Role::Client => replay_dir(&chan.to_client, resume_from_seq),
        };

        Ok(Attached {
            resume_from_seq,
            replay,
            gen,
        })
    }

    /// Forward a frame produced by `from_role` to the other side, after a
    /// rate-limit check + ring push. Returns the peer's [`PeerSink`] outcome:
    /// `Ok(true)` forwarded, `Ok(false)` shed (rate-limited OR peer absent/slow),
    /// recording the appropriate metric. Splices in a DUMB pass-through — the relay
    /// never interprets the bytes.
    pub fn forward(
        &self,
        key: &ChannelKey,
        from_role: Role,
        frame: StreamFrame,
        now: Instant,
    ) -> bool {
        let mut channels = self.channels();
        let Some(chan) = channels.get_mut(key) else {
            return false;
        };
        chan.last_touch = now;
        let bytes = frame.data.len() as u64;

        // Rate-limit on the PRODUCING side's bucket.
        let admit = match from_role {
            Role::Agent => chan.agent.as_mut().map(|s| s.bucket.admit(bytes, now)),
            Role::Client => chan.client.as_mut().map(|s| s.bucket.admit(bytes, now)),
        };
        if admit != Some(true) {
            self.metrics.record_rate_limit_drop();
            return false;
        }

        // Track the producing side's seq cursor (for an accurate resume ack).
        match from_role {
            Role::Agent => {
                if let Some(s) = chan.agent.as_mut() {
                    s.next_seq = frame.seq.wrapping_add(1);
                }
            }
            Role::Client => {
                if let Some(s) = chan.client.as_mut() {
                    s.next_seq = frame.seq.wrapping_add(1);
                }
            }
        }

        // Push into the directional ring for resume, observe high-water.
        let (dir, peer_sink) = match from_role {
            Role::Agent => (
                &mut chan.to_client,
                chan.client.as_ref().map(|s| s.sink.clone()),
            ),
            Role::Client => (
                &mut chan.to_agent,
                chan.agent.as_ref().map(|s| s.sink.clone()),
            ),
        };
        let ring = dir
            .ring
            .get_or_insert_with(|| ReplayRing::new(self.ring_frames));
        let depth = ring.push(frame.clone());
        self.metrics.observe_buffer_depth(depth as u64);

        // Forward to the peer's bounded sink (non-blocking — a full sink sheds).
        let Some(sink) = peer_sink else {
            // No peer yet (half-open); the frame is buffered in the ring for replay
            // when the peer attaches. Not a drop.
            return true;
        };
        if sink.try_send(RelayMessage::Frame(frame)).is_ok() {
            match from_role {
                Role::Agent => self.metrics.record_agent_to_viewer(bytes),
                Role::Client => self.metrics.record_viewer_to_agent(bytes),
            }
            true
        } else {
            // The peer's bounded queue is full (slow peer) or gone — shed + count.
            // The ring still holds it, so a reconnect resumes it.
            self.metrics.record_buffer_drop();
            false
        }
    }

    /// Forward a non-frame message (a typed `DesktopInput`, or a `StreamClose`) from
    /// `from_role` to the peer verbatim. Returns whether a peer received it.
    pub fn forward_message(&self, key: &ChannelKey, from_role: Role, msg: RelayMessage) -> bool {
        let channels = self.channels();
        let Some(chan) = channels.get(key) else {
            return false;
        };
        let peer = match from_role {
            Role::Agent => chan.client.as_ref(),
            Role::Client => chan.agent.as_ref(),
        };
        let Some(side) = peer else { return false };
        side.sink.try_send(msg).is_ok()
    }

    /// Detach a side (its connection dropped). Keeps the channel (and its rings)
    /// alive so the OTHER side can keep producing into the ring and the dropped side
    /// can reconnect + resume — UNLESS both sides are now gone, in which case the
    /// channel is removed (the relay holds no idle state).
    ///
    /// `gen` is the detaching connection's generation: the side is cleared ONLY when
    /// it still holds THIS generation. A stale teardown (an old reconnected-away
    /// connection's socket finally closing) whose generation no longer matches is a
    /// NO-OP — it cannot clobber the newer connection that already re-attached
    /// (the relay's reconnect-safety invariant).
    pub fn detach(&self, key: &ChannelKey, role: Role, gen: ConnGen) {
        let mut channels = self.channels();
        let Some(chan) = channels.get_mut(key) else {
            return;
        };
        let cleared = match role {
            Role::Agent => {
                if chan.agent.as_ref().is_some_and(|s| s.gen == gen) {
                    chan.agent = None;
                    true
                } else {
                    false
                }
            }
            Role::Client => {
                if chan.client.as_ref().is_some_and(|s| s.gen == gen) {
                    chan.client = None;
                    true
                } else {
                    false
                }
            }
        };
        if cleared && chan.agent.is_none() && chan.client.is_none() {
            channels.remove(key);
            self.metrics.channel_closed();
        }
    }

    /// Tear a channel down entirely (a `StreamClose`/`FENCED`): notify any live peer
    /// then remove it.
    pub fn close(&self, key: &ChannelKey, from_role: Role, close: RelayMessage) {
        // Notify the peer first (best-effort), then drop the channel.
        self.forward_message(key, from_role, close);
        let mut channels = self.channels();
        if channels.remove(key).is_some() {
            self.metrics.channel_closed();
        }
    }

    /// Whether a channel currently has both ends connected (paired + splicing).
    #[must_use]
    pub fn is_paired(&self, key: &ChannelKey) -> bool {
        let channels = self.channels();
        channels
            .get(key)
            .is_some_and(|c| c.agent.is_some() && c.client.is_some())
    }

    /// Reap channels whose only side has been half-open longer than the pair
    /// timeout (bounds transient state). Returns how many were reaped.
    pub fn reap_half_open(&self, now: Instant) -> usize {
        let mut channels = self.channels();
        let timeout = self.pair_timeout;
        let stale: Vec<ChannelKey> = channels
            .iter()
            .filter(|(_, c)| {
                let half_open = c.agent.is_none() || c.client.is_none();
                half_open && now.saturating_duration_since(c.last_touch) > timeout
            })
            .map(|(k, _)| k.clone())
            .collect();
        for key in &stale {
            channels.remove(key);
            self.metrics.channel_closed();
        }
        stale.len()
    }

    fn maybe_remove_empty(&self, key: &ChannelKey) {
        let mut channels = self.channels();
        if let Some(c) = channels.get(key) {
            if c.agent.is_none() && c.client.is_none() {
                channels.remove(key);
                self.metrics.channel_closed();
            }
        }
    }
}

/// The frames to replay to a side from `resume_from_seq` (the PEER's directional
/// ring; empty when there is no ring yet or nothing matches).
fn replay_dir(dir: &Direction, resume_from_seq: u64) -> Vec<StreamFrame> {
    dir.ring
        .as_ref()
        .map(|r| r.replay_from(resume_from_seq))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use opengeni_agent_proto::v1;

    fn key() -> ChannelKey {
        ChannelKey {
            workspace_id: "ws-1".to_string(),
            agent_id: "ag-1".to_string(),
            port: 7681,
        }
    }

    fn frame(seq: u64, data: &str) -> StreamFrame {
        StreamFrame {
            channel_id: "ch".to_string(),
            seq,
            data: prost::bytes::Bytes::copy_from_slice(data.as_bytes()),
            produced_at_ms: 0,
        }
    }

    fn registry() -> ChannelRegistry {
        ChannelRegistry::new(&RelayConfig::for_test("s"), RelayMetrics::new())
    }

    #[tokio::test]
    async fn pairs_and_splices_both_directions() {
        let reg = registry();
        let now = Instant::now();
        let (agent_tx, mut agent_rx) = tokio::sync::mpsc::channel(16);
        let (client_tx, mut client_rx) = tokio::sync::mpsc::channel(16);

        reg.attach(&key(), Role::Agent, None, 0, agent_tx, now)
            .unwrap();
        reg.attach(&key(), Role::Client, Some(0), 0, client_tx, now)
            .unwrap();
        assert!(reg.is_paired(&key()));

        // agent → client.
        assert!(reg.forward(&key(), Role::Agent, frame(0, "tty"), now));
        match client_rx.recv().await.unwrap() {
            RelayMessage::Frame(f) => assert_eq!(&f.data[..], b"tty"),
            other => panic!("expected a frame, got {other:?}"),
        }
        // client → agent (input).
        assert!(reg.forward(&key(), Role::Client, frame(0, "key"), now));
        match agent_rx.recv().await.unwrap() {
            RelayMessage::Frame(f) => assert_eq!(&f.data[..], b"key"),
            other => panic!("expected a frame, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_stale_epoch_viewer_is_rejected() {
        let reg = registry();
        let now = Instant::now();
        let (a_tx, _a_rx) = tokio::sync::mpsc::channel(16);
        let (c_tx, _c_rx) = tokio::sync::mpsc::channel(16);
        let (stale_tx, _s_rx) = tokio::sync::mpsc::channel(16);

        reg.attach(&key(), Role::Agent, None, 0, a_tx, now).unwrap();
        // A viewer at epoch 5 advances the floor to 5.
        reg.attach(&key(), Role::Client, Some(5), 0, c_tx, now)
            .unwrap();
        // A viewer at epoch 4 (a swapped-away generation) is REJECTED.
        let err = reg
            .attach(&key(), Role::Client, Some(4), 0, stale_tx, now)
            .unwrap_err();
        assert_eq!(err, AttachError::StaleEpoch);
        assert_eq!(reg.metrics().opens_rejected(), 1);
    }

    #[tokio::test]
    async fn cross_channel_isolation_a_viewer_cannot_read_another_channel() {
        let reg = registry();
        let now = Instant::now();
        let key_a = key();
        let key_b = ChannelKey {
            port: 6080,
            ..key()
        };

        let (agent_a_tx, _aa) = tokio::sync::mpsc::channel(16);
        let (client_a_tx, mut client_a_rx) = tokio::sync::mpsc::channel(16);
        let (agent_b_tx, _ab) = tokio::sync::mpsc::channel(16);
        let (client_b_tx, mut client_b_rx) = tokio::sync::mpsc::channel(16);

        reg.attach(&key_a, Role::Agent, None, 0, agent_a_tx, now)
            .unwrap();
        reg.attach(&key_a, Role::Client, Some(0), 0, client_a_tx, now)
            .unwrap();
        reg.attach(&key_b, Role::Agent, None, 0, agent_b_tx, now)
            .unwrap();
        reg.attach(&key_b, Role::Client, Some(0), 0, client_b_tx, now)
            .unwrap();

        // A frame on channel A reaches A's viewer only.
        reg.forward(&key_a, Role::Agent, frame(0, "secretA"), now);
        match client_a_rx.recv().await.unwrap() {
            RelayMessage::Frame(f) => assert_eq!(&f.data[..], b"secretA"),
            other => panic!("expected a frame, got {other:?}"),
        }
        // B's viewer received nothing from A.
        assert!(client_b_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn reconnect_replays_from_the_resume_seq() {
        let reg = registry();
        let now = Instant::now();
        let (a_tx, _a_rx) = tokio::sync::mpsc::channel(16);
        reg.attach(&key(), Role::Agent, None, 0, a_tx, now).unwrap();

        // The agent produces 3 frames while the client is absent — buffered in the
        // to_client ring.
        for s in 0..3 {
            reg.forward(&key(), Role::Agent, frame(s, &format!("f{s}")), now);
        }

        // The client attaches (reconnect) resuming from seq 1 — it replays f1, f2.
        let (c_tx, _c_rx) = tokio::sync::mpsc::channel(16);
        let attached = reg
            .attach(&key(), Role::Client, Some(0), 1, c_tx, now)
            .unwrap();
        let seqs: Vec<u64> = attached.replay.iter().map(|f| f.seq).collect();
        assert_eq!(seqs, vec![1, 2]);
    }

    #[tokio::test]
    async fn a_slow_peer_sheds_rather_than_blocking() {
        let reg = registry();
        let now = Instant::now();
        let (a_tx, _a_rx) = tokio::sync::mpsc::channel(16);
        // The client's sink has capacity 1; the second frame sheds (buffer_drop).
        let (c_tx, _c_rx) = tokio::sync::mpsc::channel::<RelayMessage>(1);
        reg.attach(&key(), Role::Agent, None, 0, a_tx, now).unwrap();
        reg.attach(&key(), Role::Client, Some(0), 0, c_tx, now)
            .unwrap();

        assert!(reg.forward(&key(), Role::Agent, frame(0, "a"), now));
        // The queue (cap 1) is full; the next forward sheds.
        let forwarded = reg.forward(&key(), Role::Agent, frame(1, "b"), now);
        assert!(!forwarded, "a full peer queue sheds the frame");
    }

    #[tokio::test]
    async fn detach_then_reattach_resumes_invisibly() {
        let reg = registry();
        let now = Instant::now();
        let (a_tx, _a_rx) = tokio::sync::mpsc::channel(16);
        let (c_tx, _c_rx) = tokio::sync::mpsc::channel(16);
        reg.attach(&key(), Role::Agent, None, 0, a_tx, now).unwrap();
        let client = reg
            .attach(&key(), Role::Client, Some(0), 0, c_tx, now)
            .unwrap();
        reg.forward(&key(), Role::Agent, frame(0, "x"), now);

        // The client drops — the channel survives (agent still present).
        reg.detach(&key(), Role::Client, client.gen);
        assert!(!reg.is_paired(&key()));
        // The agent keeps producing into the ring.
        reg.forward(&key(), Role::Agent, frame(1, "y"), now);

        // The client reconnects resuming from 1 → replays y (seq 1).
        let (c2_tx, _c2_rx) = tokio::sync::mpsc::channel(16);
        let attached = reg
            .attach(&key(), Role::Client, Some(0), 1, c2_tx, now)
            .unwrap();
        assert_eq!(
            attached.replay.iter().map(|f| f.seq).collect::<Vec<_>>(),
            vec![1]
        );
        assert!(reg.is_paired(&key()));
    }

    #[tokio::test]
    async fn a_stale_detach_does_not_clobber_a_reconnect() {
        // The reconnect-safety invariant: an OLD connection's delayed teardown
        // (carrying its stale generation) must NOT remove the side the NEW
        // (reconnected) connection already re-attached.
        let reg = registry();
        let now = Instant::now();
        let (a1_tx, _a1) = tokio::sync::mpsc::channel(16);
        let first = reg
            .attach(&key(), Role::Agent, None, 0, a1_tx, now)
            .unwrap();
        // The agent reconnects (a new connection, new gen) BEFORE the old one's
        // teardown lands.
        let (a2_tx, mut a2_rx) = tokio::sync::mpsc::channel(16);
        let second = reg
            .attach(&key(), Role::Agent, None, 0, a2_tx, now)
            .unwrap();
        assert_ne!(first.gen, second.gen);

        // The OLD connection's detach (stale gen) is a no-op — the new agent stays.
        reg.detach(&key(), Role::Agent, first.gen);

        // A client → agent input still reaches the NEW agent connection.
        let (c_tx, _c_rx) = tokio::sync::mpsc::channel(16);
        reg.attach(&key(), Role::Client, Some(0), 0, c_tx, now)
            .unwrap();
        assert!(reg.forward(&key(), Role::Client, frame(0, "input"), now));
        match a2_rx.recv().await.unwrap() {
            RelayMessage::Frame(f) => assert_eq!(&f.data[..], b"input"),
            other => panic!("expected the input frame on the new agent, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn close_removes_the_channel_and_notifies_the_peer() {
        let reg = registry();
        let now = Instant::now();
        let (a_tx, _a_rx) = tokio::sync::mpsc::channel(16);
        let (c_tx, mut c_rx) = tokio::sync::mpsc::channel(16);
        reg.attach(&key(), Role::Agent, None, 0, a_tx, now).unwrap();
        reg.attach(&key(), Role::Client, Some(0), 0, c_tx, now)
            .unwrap();

        let close = RelayMessage::Close(v1::StreamClose {
            channel_id: "ch".to_string(),
            reason: v1::StreamCloseReason::Fenced as i32,
            message: "swapped away".to_string(),
        });
        reg.close(&key(), Role::Agent, close);
        // The viewer is notified.
        match c_rx.recv().await.unwrap() {
            RelayMessage::Close(c) => assert_eq!(c.reason, v1::StreamCloseReason::Fenced as i32),
            other => panic!("expected a close, got {other:?}"),
        }
        assert!(!reg.is_paired(&key()));
    }
}
