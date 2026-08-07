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
//! against a caller-provided directory. The shared [`GlobalSpoolBudget`] is
//! charged only when bytes actually spill to disk, never from a command's
//! theoretical maximum (PROTOCOL.md ruling M2 "global byte budget").

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

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
    /// TEST-FLOOR values (LIMITS-DOCTRINE rule R): production construction
    /// derives these as fractions of measured [`crate::HostCapacity`] (the
    /// wiring layer's `EngineBudgets::derive`), with these absolutes as
    /// FLOORS. The defaults exist so tests are deterministic, never as
    /// deployment tuning.
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
    /// The machine-wide actual-byte spool budget cannot hold this write.
    /// Starting an op never causes this: it is returned only at the write
    /// that would exceed the shared disk safety budget.
    #[error(
        "global spool budget exhausted: requested {requested_bytes} bytes with {used_bytes} of \
         {spool_budget_bytes} already used"
    )]
    GlobalSpoolExhausted {
        /// This op's projected retained record-cost bytes.
        retained_bytes: u64,
        /// Additional physical encoded bytes this write needs.
        requested_bytes: u64,
        /// Actual encoded bytes held by all spooled ops.
        used_bytes: u64,
        /// The current machine-wide spool safety budget.
        spool_budget_bytes: u64,
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

/// Flat per-frame bookkeeping cost charged to the retention ledger on top of
/// the payload: the on-disk record header (13 bytes), the in-memory spool
/// index entry (~40 bytes), and deque/Frame overhead in memory mode. Charging
/// it makes ZERO-PAYLOAD frames (Progress) cost something real — a
/// long-detached quiet op ticking Progress forever grows the spool and its
/// index, and a purely payload-denominated budget would never notice
/// (design-review finding 1, 2026-07-10). Retention budgets are
/// record-denominated; the flow layer's credit window stays
/// PAYLOAD-denominated ([`RetentionLog::payload_bytes_in_range`]) — two
/// deliberately different quantities.
pub const RECORD_OVERHEAD_BYTES: u64 = 64;

/// The retention-ledger cost of one frame: payload + flat record overhead.
fn record_cost(body: &FrameBody) -> u64 {
    u64::try_from(body.payload_len())
        .unwrap_or(u64::MAX)
        .saturating_add(RECORD_OVERHEAD_BYTES)
}

/// Physical encoded bytes appended to the disk spool for one frame.
fn disk_record_cost(body: &FrameBody) -> u64 {
    u64::try_from(body.payload_len())
        .unwrap_or(u64::MAX)
        .saturating_add(RECORD_HEADER_LEN as u64)
}

/// Machine-wide spool accounting shared by every retention log.
///
/// The ledger tracks actual encoded bytes currently held by disk-backed
/// logs. Merely starting a command costs nothing, so many quiet or normally
/// acknowledged commands do not crowd one another out. Reservation is atomic:
/// concurrent spills cannot oversubscribe the configured disk safety budget.
#[derive(Debug)]
pub struct GlobalSpoolBudget {
    max_bytes: AtomicU64,
    used_bytes: AtomicU64,
}

impl GlobalSpoolBudget {
    /// Creates a shared ledger with the given maximum actual spool usage.
    #[must_use]
    pub fn new(max_bytes: u64) -> Self {
        Self {
            max_bytes: AtomicU64::new(max_bytes),
            used_bytes: AtomicU64::new(0),
        }
    }

    /// A ledger suitable for isolated unit tests and direct library callers.
    #[must_use]
    pub fn unlimited() -> Self {
        Self::new(u64::MAX)
    }

    /// Updates the ceiling for future writes. Existing retained bytes remain
    /// valid when a fresh capacity sample lowers the ceiling.
    pub fn set_max_bytes(&self, max_bytes: u64) {
        self.max_bytes.store(max_bytes, Ordering::Release);
    }

    /// Current ceiling in physical encoded bytes.
    #[must_use]
    pub fn max_bytes(&self) -> u64 {
        self.max_bytes.load(Ordering::Acquire)
    }

    /// Actual encoded bytes currently charged by disk-backed logs.
    #[must_use]
    pub fn used_bytes(&self) -> u64 {
        self.used_bytes.load(Ordering::Acquire)
    }

    fn try_reserve(&self, bytes: u64) -> Result<(), SpoolBudgetExhausted> {
        if bytes == 0 {
            return Ok(());
        }
        let mut used = self.used_bytes.load(Ordering::Acquire);
        loop {
            let max = self.max_bytes.load(Ordering::Acquire);
            if bytes > max.saturating_sub(used) {
                return Err(SpoolBudgetExhausted {
                    requested: bytes,
                    used,
                    max,
                });
            }
            match self.used_bytes.compare_exchange_weak(
                used,
                used + bytes,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Ok(()),
                Err(actual) => used = actual,
            }
        }
    }

    fn release(&self, bytes: u64) {
        if bytes == 0 {
            return;
        }
        let result = self
            .used_bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_sub(bytes)
            });
        debug_assert!(result.is_ok(), "spool ledger release exceeds usage");
    }
}

#[derive(Debug)]
struct SpoolBudgetExhausted {
    requested: u64,
    used: u64,
    max: u64,
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
    /// Shared actual-byte ledger and this log's currently charged physical
    /// encoded bytes.
    spool_budget: Arc<GlobalSpoolBudget>,
    spool_charged_bytes: u64,
    /// A spool create/write failure may leave a partial trailing record. Keep
    /// successful earlier frames replayable, but never append behind it.
    spool_failed: bool,
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
        Self::with_spool_budget(config, spool_dir, Arc::new(GlobalSpoolBudget::unlimited()))
    }

    /// Creates an empty log backed by a machine-wide actual-byte spool ledger.
    #[must_use]
    pub fn with_spool_budget(
        config: RetentionConfig,
        spool_dir: PathBuf,
        spool_budget: Arc<GlobalSpoolBudget>,
    ) -> Self {
        Self {
            config,
            mode: Mode::Memory(VecDeque::new()),
            next_seq: 1,
            floor: 0,
            retained_bytes: 0,
            spool_dir_pending: Some(spool_dir),
            spool_budget,
            spool_charged_bytes: 0,
            spool_failed: false,
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
        if self.spool_failed {
            return Err(RetentionError::SpoolIo {
                during: "append after prior spool failure",
                source: std::io::Error::other("retention spool is unavailable"),
            });
        }
        let seq = self.next_seq;
        let len = record_cost(&body);

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

        if matches!(self.mode, Mode::Spooled(_)) {
            if self.retained_bytes + len > self.config.spool_max_bytes {
                return Err(RetentionError::Overflow {
                    retained_bytes: self.retained_bytes + len,
                    memory_max_bytes: self.config.memory_max_bytes,
                    spool_max_bytes: self.config.spool_max_bytes,
                });
            }
            self.charge_spool(disk_record_cost(&body), self.retained_bytes + len)?;
        }

        let append_failure = match &mut self.mode {
            Mode::Memory(frames) => {
                frames.push_back(Frame { seq, body });
                None
            }
            Mode::Spooled(spool) => spool
                .append(&Frame { seq, body }, self.config.spool_segment_bytes)
                .err()
                .map(|error| (error, spool.charged_bytes_after_failure())),
        };
        if let Some((error, actual_bytes)) = append_failure {
            self.spool_failed = true;
            if let Some(actual_bytes) = actual_bytes {
                self.reconcile_spool_charge(actual_bytes);
            }
            return Err(error);
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
        let spool_freed = match &mut self.mode {
            Mode::Memory(frames) => {
                while let Some(front) = frames.front() {
                    if front.seq > acked_seq {
                        break;
                    }
                    self.retained_bytes -= record_cost(&front.body);
                    frames.pop_front();
                }
                SpoolFreed::default()
            }
            Mode::Spooled(spool) => {
                let freed = spool.free_through(acked_seq);
                self.retained_bytes -= freed.retention_bytes;
                freed
            }
        };
        if spool_freed.disk_bytes > 0 {
            self.release_spool(spool_freed.disk_bytes);
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

    /// RECORD-cost bytes currently retained (payload + per-frame overhead,
    /// memory or spool) — the quantity the retention budgets bound. For the
    /// flow layer's payload-denominated credit accounting use
    /// [`RetentionLog::payload_bytes_in_range`].
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
        if self.retained_bytes > self.config.spool_max_bytes {
            return Err(RetentionError::Overflow {
                retained_bytes: self.retained_bytes,
                memory_max_bytes: self.config.memory_max_bytes,
                spool_max_bytes: self.config.spool_max_bytes,
            });
        }
        let disk_bytes = match &self.mode {
            Mode::Memory(frames) => frames
                .iter()
                .map(|frame| disk_record_cost(&frame.body))
                .sum(),
            Mode::Spooled(_) => 0,
        };
        self.charge_spool(disk_bytes, self.retained_bytes)?;
        let dir = self
            .spool_dir_pending
            .take()
            .expect("spill only happens once, dir must still be pending");
        let mut spool = match Spool::create(dir) {
            Ok(spool) => spool,
            Err(error) => {
                self.spool_failed = true;
                self.release_spool(disk_bytes);
                return Err(error);
            }
        };
        let copy_failure = if let Mode::Memory(frames) = &self.mode {
            let mut failure = None;
            for frame in frames {
                if let Err(error) = spool.append(frame, self.config.spool_segment_bytes) {
                    failure = Some(error);
                    break;
                }
            }
            failure
        } else {
            None
        };
        if let Some(error) = copy_failure {
            self.spool_failed = true;
            if let Some(actual_bytes) = spool.charged_bytes_after_failure() {
                self.reconcile_spool_charge(actual_bytes);
            }
            return Err(error);
        }
        self.mode = Mode::Spooled(spool);
        Ok(())
    }

    fn charge_spool(
        &mut self,
        bytes: u64,
        projected_retained_bytes: u64,
    ) -> Result<(), RetentionError> {
        self.spool_budget.try_reserve(bytes).map_err(|exhausted| {
            RetentionError::GlobalSpoolExhausted {
                retained_bytes: projected_retained_bytes,
                requested_bytes: exhausted.requested,
                used_bytes: exhausted.used,
                spool_budget_bytes: exhausted.max,
            }
        })?;
        self.spool_charged_bytes = self.spool_charged_bytes.saturating_add(bytes);
        Ok(())
    }

    fn release_spool(&mut self, bytes: u64) {
        let released = bytes.min(self.spool_charged_bytes);
        self.spool_charged_bytes -= released;
        self.spool_budget.release(released);
    }

    fn reconcile_spool_charge(&mut self, actual_bytes: u64) {
        debug_assert!(
            actual_bytes <= self.spool_charged_bytes,
            "spool wrote more physical bytes than it reserved"
        );
        self.release_spool(self.spool_charged_bytes.saturating_sub(actual_bytes));
    }
}

impl Drop for RetentionLog {
    fn drop(&mut self) {
        self.spool_budget.release(self.spool_charged_bytes);
        self.spool_charged_bytes = 0;
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
    /// Physical bytes present per segment, including records whose logical
    /// frames were acknowledged before the whole segment became deletable.
    segment_sizes: HashMap<u64, u64>,
}

#[derive(Debug, Default)]
struct SpoolFreed {
    retention_bytes: u64,
    disk_bytes: u64,
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
            segment_sizes: HashMap::new(),
        })
    }

    fn segment_path(&self, segment: u64) -> PathBuf {
        self.dir.join(format!("seg-{segment:08}.spool"))
    }

    /// Physical bytes this spool successfully committed plus any partial
    /// trailing write in the active segment. Used only to reconcile a
    /// reservation after I/O failure; stale pre-existing files are excluded.
    fn charged_bytes_after_failure(&self) -> Option<u64> {
        let committed = self.segment_sizes.values().copied().sum::<u64>();
        let partial = if let Some((segment, _, written)) = &self.active {
            fs::metadata(self.segment_path(*segment))
                .ok()?
                .len()
                .saturating_sub(*written)
        } else {
            0
        };
        Some(committed.saturating_add(partial))
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
        *self.segment_sizes.entry(*segment).or_default() += record_len;
        Ok(())
    }

    /// Frees every indexed frame with `seq <= acked_seq`; deletes segment
    /// files whose every record is freed. Returns logical retention bytes and
    /// physical disk bytes actually removed; the shared disk ledger releases
    /// only the latter.
    fn free_through(&mut self, acked_seq: u64) -> SpoolFreed {
        let mut freed = SpoolFreed::default();
        while let Some(front) = self.index.front() {
            if front.seq > acked_seq {
                break;
            }
            freed.retention_bytes += front.payload_len + RECORD_OVERHEAD_BYTES;
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
                if fs::remove_file(self.segment_path(seg)).is_ok() {
                    freed.disk_bytes += self.segment_sizes.remove(&seg).unwrap_or(0);
                }
            }
        }
        // If every record in the active segment was acknowledged, close and
        // remove it immediately. Otherwise an attached high-volume command
        // could keep gigabytes of already-acked disk charged until teardown.
        if self.index.is_empty() {
            if let Some((active_segment, file, written)) = self.active.take() {
                drop(file);
                let path = self.segment_path(active_segment);
                if fs::remove_file(&path).is_ok() {
                    freed.disk_bytes += self.segment_sizes.remove(&active_segment).unwrap_or(0);
                } else if let Ok(file) = fs::OpenOptions::new().append(true).open(path) {
                    // Windows requires closing before unlink. If deletion
                    // still fails, restore the append handle and retain the
                    // disk charge rather than corrupting or undercounting it.
                    self.active = Some((active_segment, file, written));
                }
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
        // Record cost = payload + flat overhead (zero-payload frames are not free).
        let cost = 4 + RECORD_OVERHEAD_BYTES;
        for _ in 0..5 {
            log.append(data(b"xxxx")).unwrap();
        }
        assert_eq!(log.retained_bytes(), 5 * cost);
        log.ack(3);
        assert_eq!(log.floor(), 3);
        assert_eq!(log.retained_bytes(), 2 * cost);
        // Lower / repeated acks are no-ops (repetition-healing, monotonic).
        log.ack(2);
        log.ack(3);
        assert_eq!(log.floor(), 3);
        assert_eq!(log.retained_bytes(), 2 * cost);
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
        // Two records fit the byte cap; the third spills (record-cost sized).
        let two_records = 2 * (24 + RECORD_OVERHEAD_BYTES);
        let mut log = log_in(
            &dir,
            RetentionConfig {
                memory_max_bytes: usize::try_from(two_records).unwrap(),
                ..small_config()
            },
        );
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
        // Byte cap far above 5 progress records so ONLY the frame cap binds.
        let mut log = log_in(
            &dir,
            RetentionConfig {
                memory_max_bytes: 4096,
                ..small_config()
            },
        );
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
                spool_max_bytes: 2 * (40 + RECORD_OVERHEAD_BYTES) + 10,
                ..small_config()
            },
        );
        let payload = [1u8; 40];
        log.append(data(&payload)).unwrap();
        log.append(data(&payload)).unwrap(); // two record-costs, spilled by now
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
                memory_max_bytes: usize::try_from(40 + RECORD_OVERHEAD_BYTES + 10).unwrap(),
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
    fn shared_budget_charges_actual_spills_not_theoretical_quotas() {
        let disk_record_bytes = 40 + RECORD_HEADER_LEN as u64;
        let budget = Arc::new(GlobalSpoolBudget::new(2 * disk_record_bytes));
        let dirs = (0..100)
            .map(|_| tempfile::tempdir().unwrap())
            .collect::<Vec<_>>();
        let mut logs = dirs
            .iter()
            .map(|dir| {
                RetentionLog::with_spool_budget(
                    small_config(),
                    dir.path().join("spool"),
                    budget.clone(),
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(budget.used_bytes(), 0, "100 idle logs reserve nothing");

        let payload = [1u8; 40];
        logs[0].append(data(&payload)).unwrap();
        logs[1].append(data(&payload)).unwrap();
        assert_eq!(budget.used_bytes(), 2 * disk_record_bytes);

        let error = logs[2].append(data(&payload)).unwrap_err();
        assert!(matches!(error, RetentionError::GlobalSpoolExhausted { .. }));

        logs[0].ack(1);
        assert_eq!(budget.used_bytes(), disk_record_bytes);
        logs[2].append(data(&payload)).unwrap();
        assert_eq!(budget.used_bytes(), 2 * disk_record_bytes);

        drop(logs);
        assert_eq!(
            budget.used_bytes(),
            0,
            "log teardown releases its exact share"
        );
    }

    #[test]
    fn shared_budget_is_atomic_under_concurrent_writers() {
        let budget = Arc::new(GlobalSpoolBudget::new(1_000));
        let barrier = Arc::new(std::sync::Barrier::new(100));
        let writers = (0..100)
            .map(|_| {
                let budget = budget.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    budget.try_reserve(100).is_ok()
                })
            })
            .collect::<Vec<_>>();
        let admitted = writers
            .into_iter()
            .map(|writer| writer.join().unwrap())
            .filter(|admitted| *admitted)
            .count();
        assert_eq!(admitted, 10);
        assert_eq!(budget.used_bytes(), 1_000);
        budget.release(1_000);
        assert_eq!(budget.used_bytes(), 0);
    }

    #[test]
    fn shared_budget_releases_only_when_physical_segment_is_deleted() {
        let budget = Arc::new(GlobalSpoolBudget::new(4096));
        let dir = tempfile::tempdir().unwrap();
        let mut log = RetentionLog::with_spool_budget(
            RetentionConfig {
                spool_segment_bytes: 4096,
                ..small_config()
            },
            dir.path().join("spool"),
            budget.clone(),
        );
        let payload = [1u8; 40];
        log.append(data(&payload)).unwrap();
        log.append(data(&payload)).unwrap();
        let two_records = 2 * (40 + RECORD_HEADER_LEN as u64);
        assert_eq!(budget.used_bytes(), two_records);

        log.ack(1);
        assert_eq!(
            budget.used_bytes(),
            two_records,
            "a partially live segment still occupies all of its disk bytes"
        );
        log.ack(2);
        assert_eq!(budget.used_bytes(), 0);
    }

    #[test]
    fn spool_create_failure_is_sticky_without_losing_memory_replay() {
        let budget = Arc::new(GlobalSpoolBudget::new(4096));
        let dir = tempfile::tempdir().unwrap();
        let spool_path = dir.path().join("spool");
        let one_record = usize::try_from(40 + RECORD_OVERHEAD_BYTES).unwrap();
        let mut log = RetentionLog::with_spool_budget(
            RetentionConfig {
                memory_max_bytes: one_record,
                ..small_config()
            },
            spool_path.clone(),
            budget.clone(),
        );
        let payload = [1u8; 40];
        log.append(data(&payload)).unwrap();
        fs::write(&spool_path, b"blocks directory creation").unwrap();

        assert!(matches!(
            log.append(data(&payload)).unwrap_err(),
            RetentionError::SpoolIo { .. }
        ));
        assert!(matches!(
            log.append(FrameBody::Progress).unwrap_err(),
            RetentionError::SpoolIo { .. }
        ));
        assert_eq!(log.replay(0).unwrap().len(), 1);
        assert_eq!(
            budget.used_bytes(),
            0,
            "a create failure writes no bytes and releases the reservation immediately"
        );
        drop(log);
        assert_eq!(budget.used_bytes(), 0);
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
