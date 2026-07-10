//! The seq-addressed retention log: what an op keeps so a re-attaching
//! consumer can replay everything it has not yet acknowledged.
//!
//! Two frontiers govern an op's bytes (PROTOCOL.md ruling M2):
//!
//! * **Send-credit** (owned by [`crate::flow`]) bounds what is sent ahead of
//!   acks while a consumer is attached.
//! * **Retention** (this module) bounds what is KEPT for replay: while no
//!   consumer is attached the op keeps draining its child into this log —
//!   memory first, spilling to a disk spool — so a build keeps running through
//!   a connection blip; when memory + spool quotas are exhausted the append
//!   fails TYPED and the op is failed explicitly (never silent truncation).
//!
//! The log is strictly seq-ordered: frames are appended with consecutive
//! sequence numbers, freed only by a cumulative ack floor, and replayed as a
//! contiguous range. Once a log spills to disk it stays disk-backed for the
//! rest of the op (ops are finite; mode ping-pong is complexity with no
//! payoff). Spool segments are dropped whole once fully acked.
//!
//! Nothing here reads clocks or spawns tasks; disk I/O is plain `std::fs`
//! against a caller-provided directory (the integration layer owns placement
//! and the global spool budget: it reserves an op's quota before constructing
//! the log — see PROTOCOL.md ruling M2 "global byte budget").

use std::collections::VecDeque;
use std::fs;
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::path::PathBuf;

use crate::{Channel, Frame, FrameBody};

/// Bounds for one op's retention log.
#[derive(Debug, Clone)]
pub struct RetentionConfig {
    /// Max payload bytes retained in memory before spilling to the spool.
    pub memory_max_bytes: usize,
    /// Max frame COUNT retained in memory (secondary cap so a flood of tiny
    /// progress frames during a long detach cannot grow the deque unbounded).
    pub memory_max_frames: usize,
    /// Per-op spool quota in payload bytes. 0 disables spooling entirely
    /// (memory exhaustion is then immediately terminal).
    pub spool_max_bytes: u64,
    /// Rotate spool segment files at this many payload bytes.
    pub spool_segment_bytes: u64,
}

impl Default for RetentionConfig {
    fn default() -> Self {
        Self {
            memory_max_bytes: 16 * 1024 * 1024,
            memory_max_frames: 8192,
            spool_max_bytes: 256 * 1024 * 1024,
            spool_segment_bytes: 8 * 1024 * 1024,
        }
    }
}

/// Typed retention failures — each maps to a terminal op outcome at the
/// integration layer (`OP_OVERFLOW` / `OP_SPOOL_IO`), never a dropped frame.
#[derive(Debug, thiserror::Error)]
pub enum RetentionError {
    /// Memory and spool quotas are exhausted; the op must be failed typed.
    #[error(
        "retention overflow: {retained_bytes} bytes retained, memory cap {memory_max_bytes}, \
         spool quota {spool_max_bytes}"
    )]
    Overflow {
        /// Payload bytes currently retained (memory + spool).
        retained_bytes: u64,
        /// The configured memory cap.
        memory_max_bytes: usize,
        /// The configured per-op spool quota.
        spool_max_bytes: u64,
    },
    /// A spool read/write failed (including ENOSPC). Terminal and typed
    /// (invariant #1: a spool I/O error is never a silently dropped frame).
    #[error("spool i/o failure during {during}: {source}")]
    SpoolIo {
        /// What the log was doing when the failure happened.
        during: &'static str,
        /// The underlying I/O error.
        #[source]
        source: std::io::Error,
    },
    /// A replay was requested from a sequence older than the retained floor —
    /// the consumer asked for frames that were already freed by its own
    /// (or a higher-generation) cumulative ack.
    #[error("replay from seq {from} is below the retained floor {floor}")]
    ReplayBelowFloor {
        /// The requested exclusive starting sequence.
        from: u64,
        /// The current cumulative-ack floor.
        floor: u64,
    },
}

/// Where the retained frames physically live.
enum Mode {
    /// All retained frames are in memory, oldest-first.
    Memory(VecDeque<Frame>),
    /// All retained frames live in spool segment files.
    Spooled(Spool),
}

/// The per-op retention log. Frames are appended (assigned consecutive seqs),
/// freed by a monotonic cumulative ack floor, and replayed as a contiguous
/// seq range for a re-attaching consumer.
pub struct RetentionLog {
    config: RetentionConfig,
    mode: Mode,
    /// The next sequence number to assign (first frame gets seq 1; 0 means
    /// "nothing", so `ack(0)` / `replay(from=0)` are natural zero states).
    next_seq: u64,
    /// The cumulative-ack floor: every frame with `seq <= floor` is freed.
    floor: u64,
    /// Payload bytes currently retained across memory or spool.
    retained_bytes: u64,
    /// The op-private spool directory, held until the (at most one) spill;
    /// `None` once spooled.
    spool_dir_pending: Option<PathBuf>,
}

impl std::fmt::Debug for RetentionLog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RetentionLog")
            .field("next_seq", &self.next_seq)
            .field("floor", &self.floor)
            .field("retained_bytes", &self.retained_bytes)
            .field(
                "mode",
                &match self.mode {
                    Mode::Memory(_) => "memory",
                    Mode::Spooled(_) => "spooled",
                },
            )
            .finish_non_exhaustive()
    }
}

impl RetentionLog {
    /// Creates an empty log. `spool_dir` is the op-private directory used if
    /// (and only if) the log spills past its memory bounds; it is created
    /// lazily on first spill.
    #[must_use]
    pub fn new(config: RetentionConfig, spool_dir: PathBuf) -> Self {
        Self {
            config,
            mode: Mode::Memory(VecDeque::new()),
            next_seq: 1,
            floor: 0,
            retained_bytes: 0,
            spool_dir_pending: Some(spool_dir),
        }
    }

    /// Appends a frame body, assigning and returning its sequence number.
    ///
    /// # Errors
    ///
    /// [`RetentionError::Overflow`] when memory + spool quotas cannot hold the
    /// frame; [`RetentionError::SpoolIo`] on any disk failure. Both are
    /// terminal for the op.
    pub fn append(&mut self, body: FrameBody) -> Result<u64, RetentionError> {
        let seq = self.next_seq;
        let len = u64::try_from(body.payload_len()).unwrap_or(u64::MAX);

        // Would this frame push memory past its caps? Spill FIRST so ordering
        // stays strict (all retained frames move to disk before any newer one).
        if let Mode::Memory(frames) = &mut self.mode {
            let over_bytes = self.retained_bytes + len
                > u64::try_from(self.config.memory_max_bytes).unwrap_or(u64::MAX);
            let over_frames = frames.len() + 1 > self.config.memory_max_frames;
            if over_bytes || over_frames {
                if self.config.spool_max_bytes == 0 {
                    return Err(RetentionError::Overflow {
                        retained_bytes: self.retained_bytes + len,
                        memory_max_bytes: self.config.memory_max_bytes,
                        spool_max_bytes: self.config.spool_max_bytes,
                    });
                }
                self.spill_to_spool()?;
            }
        }

        match &mut self.mode {
            Mode::Memory(frames) => {
                frames.push_back(Frame { seq, body });
            }
            Mode::Spooled(spool) => {
                if self.retained_bytes + len > self.config.spool_max_bytes {
                    return Err(RetentionError::Overflow {
                        retained_bytes: self.retained_bytes + len,
                        memory_max_bytes: self.config.memory_max_bytes,
                        spool_max_bytes: self.config.spool_max_bytes,
                    });
                }
                spool.append(&Frame { seq, body }, self.config.spool_segment_bytes)?;
            }
        }

        self.next_seq += 1;
        self.retained_bytes += len;
        Ok(seq)
    }

    /// Applies a cumulative ack: frees every retained frame with
    /// `seq <= acked_seq`. Monotonic — a lower or repeated ack is a no-op
    /// (PROTOCOL.md ruling B2: acks are taken monotonically; repetition is the
    /// healing mechanism, ruling M1).
    pub fn ack(&mut self, acked_seq: u64) {
        if acked_seq <= self.floor {
            return;
        }
        // Never ack past what exists; clamp to the highest assigned seq.
        let acked_seq = acked_seq.min(self.next_seq.saturating_sub(1));
        match &mut self.mode {
            Mode::Memory(frames) => {
                while let Some(front) = frames.front() {
                    if front.seq > acked_seq {
                        break;
                    }
                    self.retained_bytes -= u64::try_from(front.body.payload_len()).unwrap_or(0);
                    frames.pop_front();
                }
            }
            Mode::Spooled(spool) => {
                let freed = spool.free_through(acked_seq);
                self.retained_bytes -= freed;
            }
        }
        self.floor = acked_seq;
    }

    /// Replays every retained frame with `seq > from_exclusive`, in order.
    /// Returns owned frames (spooled bodies are read back from disk).
    ///
    /// Prefer [`RetentionLog::replay_bounded`] in send paths: the send window
    /// bounds how much can leave anyway, and materializing a multi-hundred-MiB
    /// spooled tail per catch-up burst is a large transient allocation.
    ///
    /// # Errors
    ///
    /// [`RetentionError::ReplayBelowFloor`] if the consumer asks for frames
    /// already freed; [`RetentionError::SpoolIo`] on a disk read failure.
    pub fn replay(&mut self, from_exclusive: u64) -> Result<Vec<Frame>, RetentionError> {
        self.replay_bounded(from_exclusive, u64::MAX)
    }

    /// Replays retained frames with `seq > from_exclusive`, in order, stopping
    /// after the frame that brings cumulative payload bytes to `max_bytes` or
    /// beyond. Always yields at least one frame when any is retained past
    /// `from_exclusive` (a frame larger than `max_bytes` is returned whole —
    /// progress beats stall). The caller resumes from the last returned seq;
    /// repeated calls walk the tail without ever materializing all of it.
    ///
    /// # Errors
    ///
    /// [`RetentionError::ReplayBelowFloor`] if the consumer asks for frames
    /// already freed; [`RetentionError::SpoolIo`] on a disk read failure.
    pub fn replay_bounded(
        &mut self,
        from_exclusive: u64,
        max_bytes: u64,
    ) -> Result<Vec<Frame>, RetentionError> {
        if from_exclusive < self.floor {
            return Err(RetentionError::ReplayBelowFloor {
                from: from_exclusive,
                floor: self.floor,
            });
        }
        match &mut self.mode {
            Mode::Memory(frames) => {
                let mut out = Vec::new();
                let mut budget: u64 = 0;
                for frame in frames.iter().filter(|f| f.seq > from_exclusive) {
                    budget =
                        budget.saturating_add(u64::try_from(frame.body.payload_len()).unwrap_or(0));
                    out.push(frame.clone());
                    if budget >= max_bytes {
                        break;
                    }
                }
                Ok(out)
            }
            Mode::Spooled(spool) => spool.read_from(from_exclusive, max_bytes),
        }
    }

    /// Payload bytes retained in the half-open seq range `(from, to]` —
    /// the flow layer uses this to size unacked-sent bytes without keeping a
    /// parallel ledger that could diverge.
    #[must_use]
    pub fn payload_bytes_in_range(&self, from_exclusive: u64, to_inclusive: u64) -> u64 {
        match &self.mode {
            Mode::Memory(frames) => frames
                .iter()
                .filter(|f| f.seq > from_exclusive && f.seq <= to_inclusive)
                .map(|f| u64::try_from(f.body.payload_len()).unwrap_or(0))
                .sum(),
            Mode::Spooled(spool) => spool.payload_bytes_in_range(from_exclusive, to_inclusive),
        }
    }

    /// The cumulative-ack floor (highest freed seq).
    #[must_use]
    pub fn floor(&self) -> u64 {
        self.floor
    }

    /// The highest assigned sequence number (0 = nothing appended yet).
    #[must_use]
    pub fn high_seq(&self) -> u64 {
        self.next_seq - 1
    }

    /// Payload bytes currently retained (memory or spool).
    #[must_use]
    pub fn retained_bytes(&self) -> u64 {
        self.retained_bytes
    }

    /// Whether the log has spilled to disk.
    #[must_use]
    pub fn is_spooled(&self) -> bool {
        matches!(self.mode, Mode::Spooled(_))
    }

    /// Migrates all retained memory frames into a fresh spool. Called exactly
    /// once, on the first append that exceeds the memory caps.
    fn spill_to_spool(&mut self) -> Result<(), RetentionError> {
        let dir = self
            .spool_dir_pending
            .take()
            .expect("spill only happens once, dir must still be pending");
        let mut spool = Spool::create(dir)?;
        if let Mode::Memory(frames) = &mut self.mode {
            for frame in frames.drain(..) {
                spool.append(&frame, self.config.spool_segment_bytes)?;
            }
        }
        self.mode = Mode::Spooled(spool);
        Ok(())
    }
}

// -- the disk spool ----------------------------------------------------------

/// Per-frame location in the spool.
#[derive(Debug, Clone)]
struct FrameLoc {
    seq: u64,
    segment: u64,
    offset: u64,
    /// Encoded record length (header + payload).
    record_len: u64,
    /// Payload length only (budget accounting).
    payload_len: u64,
    kind: RecordKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecordKind {
    Stdout,
    Stderr,
    Content,
    Progress,
    Exit,
}

impl RecordKind {
    fn to_byte(self) -> u8 {
        match self {
            RecordKind::Stdout => 0,
            RecordKind::Stderr => 1,
            RecordKind::Content => 2,
            RecordKind::Progress => 3,
            RecordKind::Exit => 4,
        }
    }

    fn from_byte(b: u8) -> Option<Self> {
        Some(match b {
            0 => RecordKind::Stdout,
            1 => RecordKind::Stderr,
            2 => RecordKind::Content,
            3 => RecordKind::Progress,
            4 => RecordKind::Exit,
            _ => return None,
        })
    }

    fn of(body: &FrameBody) -> Self {
        match body {
            FrameBody::Data {
                channel: Channel::Stdout,
                ..
            } => RecordKind::Stdout,
            FrameBody::Data {
                channel: Channel::Stderr,
                ..
            } => RecordKind::Stderr,
            FrameBody::Data {
                channel: Channel::Content,
                ..
            } => RecordKind::Content,
            FrameBody::Progress => RecordKind::Progress,
            FrameBody::Exit { .. } => RecordKind::Exit,
        }
    }
}

/// An append-only segmented spool: records are written sequentially into
/// numbered segment files; fully-acked segments are deleted whole. An
/// in-memory index maps seq → location (a 256 MiB spool of 128 KiB frames is
/// ~2k entries — trivial).
struct Spool {
    dir: PathBuf,
    /// Open handle for the segment currently being appended.
    active: Option<(u64, fs::File, u64 /* bytes written */)>,
    index: VecDeque<FrameLoc>,
}

/// Record header: [seq: u64 LE][kind: u8][payload_len: u32 LE].
const RECORD_HEADER_LEN: usize = 8 + 1 + 4;

impl Spool {
    fn create(dir: PathBuf) -> Result<Self, RetentionError> {
        fs::create_dir_all(&dir).map_err(|source| RetentionError::SpoolIo {
            during: "create spool dir",
            source,
        })?;
        Ok(Self {
            dir,
            active: None,
            index: VecDeque::new(),
        })
    }

    fn segment_path(&self, segment: u64) -> PathBuf {
        self.dir.join(format!("seg-{segment:08}.spool"))
    }

    fn append(&mut self, frame: &Frame, segment_bytes: u64) -> Result<(), RetentionError> {
        // Rotate when the active segment is past the rotation size (records
        // may straddle the boundary by one frame — segments are a GC unit, not
        // a hard size guarantee).
        let needs_new = match &self.active {
            None => true,
            Some((_, _, written)) => *written >= segment_bytes,
        };
        if needs_new {
            let next_id = self.active.as_ref().map_or(0, |(id, _, _)| id + 1);
            let file = fs::OpenOptions::new()
                .create_new(true)
                .append(true)
                .open(self.segment_path(next_id))
                .map_err(|source| RetentionError::SpoolIo {
                    during: "open segment",
                    source,
                })?;
            self.active = Some((next_id, file, 0));
        }
        let (segment, file, written) = self.active.as_mut().expect("active segment ensured above");

        let payload: &[u8] = match &frame.body {
            FrameBody::Data { bytes, .. } => bytes,
            FrameBody::Progress => &[],
            FrameBody::Exit { payload } => payload,
        };
        let payload_len = u32::try_from(payload.len()).map_err(|_| RetentionError::SpoolIo {
            during: "encode record (payload too large)",
            source: std::io::Error::new(std::io::ErrorKind::InvalidInput, "frame > 4GiB"),
        })?;
        let mut header = Vec::with_capacity(RECORD_HEADER_LEN);
        header.extend_from_slice(&frame.seq.to_le_bytes());
        header.push(RecordKind::of(&frame.body).to_byte());
        header.extend_from_slice(&payload_len.to_le_bytes());

        file.write_all(&header)
            .and_then(|()| file.write_all(payload))
            .and_then(|()| file.flush())
            .map_err(|source| RetentionError::SpoolIo {
                during: "append record",
                source,
            })?;

        let record_len = RECORD_HEADER_LEN as u64 + u64::from(payload_len);
        self.index.push_back(FrameLoc {
            seq: frame.seq,
            segment: *segment,
            offset: *written,
            record_len,
            payload_len: u64::from(payload_len),
            kind: RecordKind::of(&frame.body),
        });
        *written += record_len;
        Ok(())
    }

    /// Frees every indexed frame with `seq <= acked_seq`; deletes segment
    /// files whose every record is freed. Returns freed payload bytes.
    fn free_through(&mut self, acked_seq: u64) -> u64 {
        let mut freed = 0u64;
        while let Some(front) = self.index.front() {
            if front.seq > acked_seq {
                break;
            }
            freed += front.payload_len;
            let seg = front.segment;
            self.index.pop_front();
            let segment_still_referenced =
                self.index.front().is_some_and(|next| next.segment == seg);
            let segment_is_active = self
                .active
                .as_ref()
                .is_some_and(|(active, _, _)| *active == seg);
            if !segment_still_referenced && !segment_is_active {
                // Best-effort delete: a failed unlink only leaks disk, never
                // correctness; the next free attempt will not retry (the index
                // entries are gone) but op teardown removes the whole dir.
                let _ = fs::remove_file(self.segment_path(seg));
            }
        }
        freed
    }

    /// Reads frames past `from_exclusive`, stopping after the frame that
    /// brings cumulative payload to `max_bytes` (always at least one frame —
    /// progress beats stall). Bounded reads never materialize the whole tail.
    fn read_from(
        &mut self,
        from_exclusive: u64,
        max_bytes: u64,
    ) -> Result<Vec<Frame>, RetentionError> {
        let mut out = Vec::new();
        let mut open: Option<(u64, fs::File)> = None;
        let mut budget: u64 = 0;
        for loc in self.index.iter().filter(|l| l.seq > from_exclusive) {
            // Make sure appended bytes are on disk before reading them back
            // through a second handle.
            if let Some((active_seg, file, _)) = &mut self.active {
                if *active_seg == loc.segment {
                    file.flush().map_err(|source| RetentionError::SpoolIo {
                        during: "flush before replay read",
                        source,
                    })?;
                }
            }
            let need_open = match &open {
                Some((seg, _)) => *seg != loc.segment,
                None => true,
            };
            if need_open {
                let file = fs::File::open(self.segment_path(loc.segment)).map_err(|source| {
                    RetentionError::SpoolIo {
                        during: "open segment for replay",
                        source,
                    }
                })?;
                open = Some((loc.segment, file));
            }
            let (_, file) = open.as_mut().expect("opened above");
            file.seek(SeekFrom::Start(loc.offset))
                .map_err(|source| RetentionError::SpoolIo {
                    during: "seek record",
                    source,
                })?;
            let mut record =
                vec![0u8; usize::try_from(loc.record_len).expect("record fits in memory")];
            file.read_exact(&mut record)
                .map_err(|source| RetentionError::SpoolIo {
                    during: "read record",
                    source,
                })?;
            out.push(decode_record(&record, loc)?);
            budget = budget.saturating_add(loc.payload_len);
            if budget >= max_bytes {
                break;
            }
        }
        Ok(out)
    }

    fn payload_bytes_in_range(&self, from_exclusive: u64, to_inclusive: u64) -> u64 {
        self.index
            .iter()
            .filter(|l| l.seq > from_exclusive && l.seq <= to_inclusive)
            .map(|l| l.payload_len)
            .sum()
    }
}

/// Decodes one spool record back into a [`Frame`], validating the header
/// against the index entry it was read for.
fn decode_record(record: &[u8], loc: &FrameLoc) -> Result<Frame, RetentionError> {
    let corrupt = |what: &'static str| RetentionError::SpoolIo {
        during: "decode record",
        source: std::io::Error::new(std::io::ErrorKind::InvalidData, what),
    };
    if record.len() < RECORD_HEADER_LEN {
        return Err(corrupt("short record"));
    }
    let seq = u64::from_le_bytes(record[0..8].try_into().expect("8 bytes"));
    if seq != loc.seq {
        return Err(corrupt("seq mismatch between index and record"));
    }
    let kind = RecordKind::from_byte(record[8]).ok_or_else(|| corrupt("unknown record kind"))?;
    if kind != loc.kind {
        return Err(corrupt("kind mismatch between index and record"));
    }
    let payload = record[RECORD_HEADER_LEN..].to_vec();
    let body = match kind {
        RecordKind::Stdout => FrameBody::Data {
            channel: Channel::Stdout,
            bytes: payload,
        },
        RecordKind::Stderr => FrameBody::Data {
            channel: Channel::Stderr,
            bytes: payload,
        },
        RecordKind::Content => FrameBody::Data {
            channel: Channel::Content,
            bytes: payload,
        },
        RecordKind::Progress => FrameBody::Progress,
        RecordKind::Exit => FrameBody::Exit { payload },
    };
    Ok(Frame { seq, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(bytes: &[u8]) -> FrameBody {
        FrameBody::Data {
            channel: Channel::Stdout,
            bytes: bytes.to_vec(),
        }
    }

    fn small_config() -> RetentionConfig {
        RetentionConfig {
            memory_max_bytes: 64,
            memory_max_frames: 4,
            spool_max_bytes: 4096,
            spool_segment_bytes: 96,
        }
    }

    fn log_in(dir: &tempfile::TempDir, config: RetentionConfig) -> RetentionLog {
        RetentionLog::new(config, dir.path().join("spool"))
    }

    #[test]
    fn appends_assign_consecutive_seqs_and_replay_returns_them_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = log_in(&dir, RetentionConfig::default());
        assert_eq!(log.append(data(b"a")).unwrap(), 1);
        assert_eq!(log.append(FrameBody::Progress).unwrap(), 2);
        assert_eq!(log.append(data(b"bb")).unwrap(), 3);
        let frames = log.replay(0).unwrap();
        assert_eq!(
            frames.iter().map(|f| f.seq).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        // Partial replay: strictly after seq 1.
        let frames = log.replay(1).unwrap();
        assert_eq!(frames.iter().map(|f| f.seq).collect::<Vec<_>>(), vec![2, 3]);
    }

    #[test]
    fn cumulative_ack_frees_and_is_monotonic() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = log_in(&dir, RetentionConfig::default());
        for _ in 0..5 {
            log.append(data(b"xxxx")).unwrap();
        }
        assert_eq!(log.retained_bytes(), 20);
        log.ack(3);
        assert_eq!(log.floor(), 3);
        assert_eq!(log.retained_bytes(), 8);
        // Lower / repeated acks are no-ops (repetition-healing, monotonic).
        log.ack(2);
        log.ack(3);
        assert_eq!(log.floor(), 3);
        assert_eq!(log.retained_bytes(), 8);
        // Replay below the floor is a typed error.
        let err = log.replay(1).unwrap_err();
        assert!(matches!(
            err,
            RetentionError::ReplayBelowFloor { from: 1, floor: 3 }
        ));
    }

    #[test]
    fn ack_beyond_high_seq_clamps() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = log_in(&dir, RetentionConfig::default());
        log.append(data(b"a")).unwrap();
        log.ack(999);
        assert_eq!(log.floor(), 1);
        assert_eq!(log.retained_bytes(), 0);
    }

    #[test]
    fn spills_to_spool_at_memory_byte_cap_and_replays_identically() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = log_in(&dir, small_config());
        // 3 × 24 bytes = 72 > 64 cap → third append spills.
        let payload = [7u8; 24];
        log.append(data(&payload)).unwrap();
        log.append(data(&payload)).unwrap();
        assert!(!log.is_spooled());
        log.append(data(&payload)).unwrap();
        assert!(log.is_spooled());
        let frames = log.replay(0).unwrap();
        assert_eq!(frames.len(), 3);
        for (i, f) in frames.iter().enumerate() {
            assert_eq!(f.seq, i as u64 + 1);
            assert_eq!(f.body, data(&payload));
        }
    }

    #[test]
    fn spills_at_frame_count_cap_even_when_bytes_are_tiny() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = log_in(&dir, small_config());
        for _ in 0..4 {
            log.append(FrameBody::Progress).unwrap();
        }
        assert!(!log.is_spooled());
        log.append(FrameBody::Progress).unwrap(); // 5th > memory_max_frames=4
        assert!(log.is_spooled());
        assert_eq!(log.replay(0).unwrap().len(), 5);
    }

    #[test]
    fn spool_quota_exhaustion_is_a_typed_overflow() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = log_in(
            &dir,
            RetentionConfig {
                spool_max_bytes: 100,
                ..small_config()
            },
        );
        let payload = [1u8; 40];
        log.append(data(&payload)).unwrap();
        log.append(data(&payload)).unwrap(); // 80 bytes, spilled by now
        let err = log.append(data(&payload)).unwrap_err();
        assert!(
            matches!(err, RetentionError::Overflow { .. }),
            "got {err:?}"
        );
    }

    #[test]
    fn zero_spool_quota_makes_memory_exhaustion_immediately_terminal() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = log_in(
            &dir,
            RetentionConfig {
                spool_max_bytes: 0,
                ..small_config()
            },
        );
        let payload = [1u8; 40];
        log.append(data(&payload)).unwrap();
        let err = log.append(data(&payload)).unwrap_err();
        assert!(matches!(err, RetentionError::Overflow { .. }));
        // Nothing was silently dropped: the first frame is still replayable.
        assert_eq!(log.replay(0).unwrap().len(), 1);
    }

    #[test]
    fn acked_spool_segments_are_deleted_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = log_in(&dir, small_config());
        let payload = [9u8; 30];
        for _ in 0..8 {
            log.append(data(&payload)).unwrap();
        }
        assert!(log.is_spooled());
        let spool_dir = dir.path().join("spool");
        let count_segments = |d: &std::path::Path| fs::read_dir(d).unwrap().count();
        let before = count_segments(&spool_dir);
        assert!(before >= 2, "expected multiple segments, got {before}");
        log.ack(7);
        let after = count_segments(&spool_dir);
        assert!(
            after < before,
            "acking should delete fully-freed segments ({before} -> {after})"
        );
        // The unacked tail is still fully replayable after deletion.
        let frames = log.replay(7).unwrap();
        assert_eq!(frames.iter().map(|f| f.seq).collect::<Vec<_>>(), vec![8]);
        assert_eq!(frames[0].body, data(&payload));
    }

    #[test]
    fn payload_bytes_in_range_matches_across_memory_and_spool() {
        let dir = tempfile::tempdir().unwrap();
        let mut mem = log_in(&dir, RetentionConfig::default());
        let dir2 = tempfile::tempdir().unwrap();
        let mut spooled = log_in(&dir2, small_config());
        for i in 0..6u8 {
            let payload = vec![i; 20];
            mem.append(data(&payload)).unwrap();
            spooled.append(data(&payload)).unwrap();
        }
        assert!(spooled.is_spooled());
        assert!(!mem.is_spooled());
        for (from, to) in [(0u64, 6u64), (2, 5), (5, 6), (6, 6)] {
            assert_eq!(
                mem.payload_bytes_in_range(from, to),
                spooled.payload_bytes_in_range(from, to),
                "range ({from}, {to}]"
            );
        }
        assert_eq!(mem.payload_bytes_in_range(2, 5), 60);
    }

    #[test]
    fn exit_and_progress_frames_round_trip_through_the_spool() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = log_in(&dir, small_config());
        let big = [3u8; 70]; // force immediate spill
        log.append(data(&big)).unwrap();
        log.append(FrameBody::Progress).unwrap();
        log.append(FrameBody::Exit {
            payload: b"exit-proto".to_vec(),
        })
        .unwrap();
        assert!(log.is_spooled());
        let frames = log.replay(1).unwrap();
        assert_eq!(frames[0].body, FrameBody::Progress);
        assert_eq!(
            frames[1].body,
            FrameBody::Exit {
                payload: b"exit-proto".to_vec()
            }
        );
    }

    #[test]
    fn stderr_and_content_channels_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = log_in(&dir, small_config());
        let big = [3u8; 70];
        log.append(FrameBody::Data {
            channel: Channel::Stderr,
            bytes: big.to_vec(),
        })
        .unwrap();
        log.append(FrameBody::Data {
            channel: Channel::Content,
            bytes: b"c".to_vec(),
        })
        .unwrap();
        assert!(log.is_spooled());
        let frames = log.replay(0).unwrap();
        assert!(
            matches!(&frames[0].body, FrameBody::Data { channel: Channel::Stderr, bytes } if bytes.len() == 70)
        );
        assert!(
            matches!(&frames[1].body, FrameBody::Data { channel: Channel::Content, bytes } if bytes == b"c")
        );
    }

    #[test]
    fn replay_is_repeatable_until_acked() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = log_in(&dir, small_config());
        let payload = [5u8; 30];
        for _ in 0..4 {
            log.append(data(&payload)).unwrap();
        }
        let a = log.replay(0).unwrap();
        let b = log.replay(0).unwrap();
        assert_eq!(a, b, "replay must not consume");
    }

    #[test]
    fn bounded_replay_walks_the_tail_in_resumable_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = log_in(&dir, RetentionConfig::default());
        for _ in 0..5 {
            log.append(data(&[7u8; 10])).unwrap(); // seqs 1..=5, 10 bytes each
        }
        // 25-byte budget covers frames 1-2 and is crossed BY frame 3.
        let first = log.replay_bounded(0, 25).unwrap();
        assert_eq!(
            first.iter().map(|f| f.seq).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        // Resume from the last returned seq: the walk continues, no overlap.
        let rest = log.replay_bounded(3, 25).unwrap();
        assert_eq!(rest.iter().map(|f| f.seq).collect::<Vec<_>>(), vec![4, 5]);
        // Chunks concatenate to exactly the unbounded replay.
        let all = log.replay(0).unwrap();
        assert_eq!([first, rest].concat(), all);
    }

    #[test]
    fn bounded_replay_yields_an_oversized_frame_whole() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = log_in(&dir, RetentionConfig::default());
        log.append(data(&[9u8; 100])).unwrap();
        // Progress beats stall: a frame larger than the budget returns whole.
        let frames = log.replay_bounded(0, 1).unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].body.payload_len(), 100);
    }

    #[test]
    fn bounded_replay_is_bounded_in_spooled_mode_too() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = log_in(&dir, small_config());
        let payload = [5u8; 30];
        for _ in 0..6 {
            log.append(data(&payload)).unwrap(); // overflows the 64B ring -> spool
        }
        assert!(log.is_spooled());
        let first = log.replay_bounded(0, 30).unwrap();
        assert_eq!(first.iter().map(|f| f.seq).collect::<Vec<_>>(), vec![1]);
        let second = log.replay_bounded(1, 60).unwrap();
        assert_eq!(second.iter().map(|f| f.seq).collect::<Vec<_>>(), vec![2, 3]);
        // The walk covers the whole tail byte-exactly.
        let mut walked = [first, second].concat();
        let mut from = walked.last().map_or(0, |f| f.seq);
        loop {
            let chunk = log.replay_bounded(from, 60).unwrap();
            if chunk.is_empty() {
                break;
            }
            from = chunk.last().expect("non-empty").seq;
            walked.extend(chunk);
        }
        assert_eq!(walked, log.replay(0).unwrap());
    }
}
