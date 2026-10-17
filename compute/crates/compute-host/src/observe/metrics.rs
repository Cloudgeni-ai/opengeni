//! Metrics with bounded cardinality: every label set is known when the
//! agent starts, and no metric is labelled by sandbox.
//!
//! Counters and histograms are atomics anyone may add to without waiting.
//! Gauges are written whole by the agent at each sample and read whole by
//! the exporter.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::Duration;

use compute_core::{Failure, Level, Outcome, Step};

use crate::protocol::ErrorCode;

/// Why a step started.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cause {
    /// A caller asked: a wake, hold, connection or sleep request, or data
    /// arriving for the sandbox on a guest port.
    Request,
    /// The sandbox's sleep rules, after it was idle.
    Idle,
    /// Host memory or disk: pressure relief, room for a wake or the free
    /// buffer, or a sandbox paused for memory waking once there is room.
    Pressure,
    /// Putting things right: after the agent started, or after a VM
    /// process ended on its own.
    Recovery,
}

impl Cause {
    /// Every cause.
    pub const ALL: [Self; 4] = [Self::Request, Self::Idle, Self::Pressure, Self::Recovery];

    /// Its name on events and metrics.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Request => "request",
            Self::Idle => "idle",
            Self::Pressure => "pressure",
            Self::Recovery => "recovery",
        }
    }
}

/// Something that must never happen. Each counts, stays counted, and
/// writes an event naming what it happened to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Alarm {
    /// A copy was kept because it may be the only good one: the store did
    /// not hold the archived copy an eviction relied on, or a VM was to end
    /// without a saved copy.
    OnlyCopyKept,
    /// A copy failed its verification: a local memory image, or an object
    /// in the store.
    VerificationFailed,
    /// A copy was moved to quarantine.
    Quarantined,
    /// A copy the record trusted was gone or could no longer be trusted.
    CopyLost,
    /// A sandbox became broken on this host.
    Broken,
    /// A sandbox's running programs were lost: it boots fresh from its
    /// disk.
    ProgramsLost,
}

impl Alarm {
    /// Every alarm.
    pub const ALL: [Self; 6] = [
        Self::OnlyCopyKept,
        Self::VerificationFailed,
        Self::Quarantined,
        Self::CopyLost,
        Self::Broken,
        Self::ProgramsLost,
    ];

    /// Its name on events and metrics.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::OnlyCopyKept => "only_copy_kept",
            Self::VerificationFailed => "verification_failed",
            Self::Quarantined => "quarantined",
            Self::CopyLost => "copy_lost",
            Self::Broken => "broken",
            Self::ProgramsLost => "programs_lost",
        }
    }
}

/// A kind of API request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestKind {
    #[allow(missing_docs)]
    Create,
    #[allow(missing_docs)]
    Remove,
    #[allow(missing_docs)]
    Touch,
    #[allow(missing_docs)]
    Wake,
    #[allow(missing_docs)]
    Connect,
    #[allow(missing_docs)]
    Sleep,
    #[allow(missing_docs)]
    Hold,
    #[allow(missing_docs)]
    Release,
    #[allow(missing_docs)]
    Status,
    /// A request that could not be read.
    Invalid,
}

impl RequestKind {
    /// Every kind.
    pub const ALL: [Self; 10] = [
        Self::Create,
        Self::Remove,
        Self::Touch,
        Self::Wake,
        Self::Connect,
        Self::Sleep,
        Self::Hold,
        Self::Release,
        Self::Status,
        Self::Invalid,
    ];

    /// Its name on events and metrics, as the `op` of the request.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Remove => "remove",
            Self::Touch => "touch",
            Self::Wake => "wake",
            Self::Connect => "connect",
            Self::Sleep => "sleep",
            Self::Hold => "hold",
            Self::Release => "release",
            Self::Status => "status",
            Self::Invalid => "invalid",
        }
    }
}

/// Every error a request can end with, in [`result_name`] order after
/// success.
const ERROR_CODES: [ErrorCode; 11] = [
    ErrorCode::Invalid,
    ErrorCode::NotFound,
    ErrorCode::Exists,
    ErrorCode::Busy,
    ErrorCode::Broken,
    ErrorCode::Blocked,
    ErrorCode::Removed,
    ErrorCode::Stale,
    ErrorCode::Unreachable,
    ErrorCode::HostFull,
    ErrorCode::Internal,
];
const RESULTS: usize = ERROR_CODES.len() + 1;

/// The result of a request on events and metrics: `ok`, or the error
/// code's wire name.
#[must_use]
pub fn result_name(result: Option<ErrorCode>) -> &'static str {
    match result {
        None => "ok",
        Some(ErrorCode::Invalid) => "invalid",
        Some(ErrorCode::NotFound) => "not_found",
        Some(ErrorCode::Exists) => "exists",
        Some(ErrorCode::Busy) => "busy",
        Some(ErrorCode::Broken) => "broken",
        Some(ErrorCode::Blocked) => "blocked",
        Some(ErrorCode::Removed) => "removed",
        Some(ErrorCode::Stale) => "stale",
        Some(ErrorCode::Unreachable) => "unreachable",
        Some(ErrorCode::HostFull) => "host_full",
        Some(ErrorCode::Internal) => "internal",
    }
}

fn result_index(result: Option<ErrorCode>) -> usize {
    result.map_or(0, |code| {
        1 + ERROR_CODES
            .iter()
            .position(|known| *known == code)
            .unwrap_or(ERROR_CODES.len() - 1)
    })
}

/// Every way a step ends, as named on events and metrics.
const OUTCOMES: [&str; 8] = [
    "done",
    "cancelled",
    "transient",
    "untrusted",
    "remote_untrusted",
    "memory_lost",
    "unsavable",
    "fatal",
];

fn outcome_index(outcome: Outcome) -> usize {
    match outcome {
        Outcome::Done => 0,
        Outcome::Cancelled => 1,
        Outcome::Failed(Failure::Transient) => 2,
        Outcome::Failed(Failure::Untrusted) => 3,
        Outcome::Failed(Failure::RemoteUntrusted) => 4,
        Outcome::Failed(Failure::MemoryLost) => 5,
        Outcome::Failed(Failure::Unsavable) => 6,
        Outcome::Failed(Failure::Fatal) => 7,
    }
}

/// How a step ended, as named on events and metrics: `done`,
/// `cancelled`, or the kind of failure.
#[must_use]
pub fn outcome_name(outcome: Outcome) -> &'static str {
    OUTCOMES[outcome_index(outcome)]
}

/// Whether a step ended done, cancelled or failed: what step durations
/// are kept by.
fn outcome_class(outcome: Outcome) -> usize {
    match outcome {
        Outcome::Done => 0,
        Outcome::Cancelled => 1,
        Outcome::Failed(_) => 2,
    }
}
const OUTCOME_CLASSES: [&str; 3] = ["done", "cancelled", "failed"];

/// A canary path; see [`crate::observe::canary`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CanaryPath {
    /// Resume from memory.
    Resume,
    /// Restore from the local disk after being dropped from memory.
    Restore,
    /// Wake from object storage after the local copy was dropped.
    Remote,
    /// A fresh create from the deployed image.
    Create,
}

impl CanaryPath {
    /// Every path, in the order the canary takes them.
    pub const ALL: [Self; 4] = [Self::Resume, Self::Restore, Self::Remote, Self::Create];

    /// Its name on events and metrics.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Resume => "resume",
            Self::Restore => "restore",
            Self::Remote => "remote",
            Self::Create => "create",
        }
    }
}

/// How a canary run ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CanaryOutcome {
    /// Every part of the path worked in time.
    Ok,
    /// A part failed.
    Failed,
    /// The path took longer than its timeout.
    TimedOut,
}

impl CanaryOutcome {
    /// Every outcome.
    pub const ALL: [Self; 3] = [Self::Ok, Self::Failed, Self::TimedOut];

    /// Its name on events and metrics.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Failed => "failed",
            Self::TimedOut => "timed_out",
        }
    }
}

/// What the exporter sends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    /// Events, as log records.
    Logs,
    /// Metrics, as data points.
    Metrics,
}

/// Why the exporter dropped something.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DropReason {
    /// Its buffer was full: the collector was slow or away.
    Full,
    /// The collector accepted the request but rejected these records.
    Rejected,
    /// The request failed for good: a response not worth retrying, or
    /// every retry failed.
    Failed,
}

impl DropReason {
    const ALL: [Self; 3] = [Self::Full, Self::Rejected, Self::Failed];

    fn name(self) -> &'static str {
        match self {
            Self::Full => "buffer_full",
            Self::Rejected => "rejected",
            Self::Failed => "failed",
        }
    }
}

/// Upper bounds of duration histogram buckets, in seconds: from a resume
/// (milliseconds) to a slow archive (minutes).
pub const BOUNDS: [f64; 16] = [
    0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 300.0,
];

/// A histogram of durations over [`BOUNDS`].
#[derive(Debug)]
pub(crate) struct Histogram {
    buckets: [AtomicU64; BOUNDS.len() + 1],
    sum_us: AtomicU64,
}

impl Default for Histogram {
    fn default() -> Self {
        Self {
            buckets: [const { AtomicU64::new(0) }; BOUNDS.len() + 1],
            sum_us: AtomicU64::new(0),
        }
    }
}

/// One histogram as read: counts per bucket, their total and sum.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct HistogramReading {
    pub buckets: [u64; BOUNDS.len() + 1],
    pub count: u64,
    pub sum_seconds: f64,
}

impl Histogram {
    fn record(&self, took: Duration) {
        let seconds = took.as_secs_f64();
        let bucket = BOUNDS
            .iter()
            .position(|bound| seconds <= *bound)
            .unwrap_or(BOUNDS.len());
        self.buckets[bucket].fetch_add(1, Relaxed);
        let micros = u64::try_from(took.as_micros()).unwrap_or(u64::MAX);
        self.sum_us.fetch_add(micros, Relaxed);
    }

    pub fn read(&self) -> HistogramReading {
        let buckets = std::array::from_fn(|index| self.buckets[index].load(Relaxed));
        // Read after the buckets, so the count never falls short of them.
        let count = buckets.iter().sum();
        #[allow(clippy::cast_precision_loss)]
        let sum_seconds = self.sum_us.load(Relaxed) as f64 / 1e6;
        HistogramReading {
            buckets,
            count,
            sum_seconds,
        }
    }
}

/// What the agent read at its last sample, written whole each time.
/// Absent readings are `None`, never zero.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Gauges {
    /// When the agent last sampled, in milliseconds since the Unix epoch;
    /// 0 before its first sample.
    pub sampled_unix_ms: u64,
    /// Sandboxes per level, in [`Level`] order.
    pub sandboxes: [u64; 6],
    /// Host memory their VMs held per level, in bytes.
    pub memory: [u64; 6],
    /// Steps running per kind, in [`Step::ALL`] order.
    pub in_flight: [u64; Step::COUNT],
    /// Milliseconds the oldest unfinished step of each kind has run; 0
    /// when none runs.
    pub oldest_ms: [u64; Step::COUNT],
    /// Sandboxes broken on this host.
    pub broken: u64,
    /// Sandboxes the host does not manage until someone resolves why.
    pub blocked: u64,
    /// Sandboxes whose VM process cannot be saved.
    pub unsavable: u64,
    /// Host memory available for guests, in bytes.
    pub available: Option<u64>,
    /// Bytes zswap holds, compressed.
    pub zswap_stored: Option<u64>,
    /// Bytes of memory zswap holds, before compression.
    pub zswap_original: Option<u64>,
    /// Free pages in the huge-page pool.
    pub huge_pages_free: Option<u64>,
    /// Total stall time in microseconds, `some` and `full`, for memory,
    /// I/O and processors: the host's pressure stall information.
    pub pressure: [[Option<u64>; 2]; 3],
    /// Object-storage transfers a wake waits on now.
    pub transfers_foreground: Option<u64>,
    /// Background object-storage transfers running now.
    pub transfers_background: Option<u64>,
}

/// The resources pressure stall information covers, in
/// [`Gauges::pressure`] order.
pub const PRESSURE_RESOURCES: [&str; 3] = ["memory", "io", "cpu"];

/// Every metric the agent keeps; see the module documentation.
#[derive(Debug)]
pub struct Metrics {
    steps: [[[AtomicU64; OUTCOMES.len()]; Cause::ALL.len()]; Step::COUNT],
    step_time: [[Histogram; OUTCOME_CLASSES.len()]; Step::COUNT],
    requests: [[AtomicU64; RESULTS]; RequestKind::ALL.len()],
    request_time: [Histogram; RequestKind::ALL.len()],
    streams_opened: AtomicU64,
    streams_closed: AtomicU64,
    stream_bytes: [AtomicU64; 2],
    alarms: [AtomicU64; Alarm::ALL.len()],
    canary: [[AtomicU64; CanaryOutcome::ALL.len()]; CanaryPath::ALL.len()],
    canary_time: [Histogram; CanaryPath::ALL.len()],
    canary_last_ms: [AtomicU64; CanaryPath::ALL.len()],
    dropped: [[AtomicU64; DropReason::ALL.len()]; 2],
    gauges: Mutex<Gauges>,
}

impl Default for Metrics {
    fn default() -> Self {
        use std::array::from_fn;
        Self {
            steps: from_fn(|_| from_fn(|_| zeros())),
            step_time: std::array::from_fn(|_| std::array::from_fn(|_| Histogram::default())),
            requests: from_fn(|_| zeros()),
            request_time: std::array::from_fn(|_| Histogram::default()),
            streams_opened: AtomicU64::new(0),
            streams_closed: AtomicU64::new(0),
            stream_bytes: zeros(),
            alarms: zeros(),
            canary: from_fn(|_| zeros()),
            canary_time: std::array::from_fn(|_| Histogram::default()),
            canary_last_ms: zeros(),
            dropped: from_fn(|_| zeros()),
            gauges: Mutex::new(Gauges::default()),
        }
    }
}

fn zeros<const N: usize>() -> [AtomicU64; N] {
    std::array::from_fn(|_| AtomicU64::new(0))
}

fn index_of<T: PartialEq>(all: &[T], item: &T) -> usize {
    all.iter().position(|known| known == item).unwrap_or(0)
}

impl Metrics {
    /// Counts a finished step.
    pub(crate) fn step(&self, step: Step, cause: Cause, outcome: Outcome, took: Duration) {
        self.steps[step.index()][index_of(&Cause::ALL, &cause)][outcome_index(outcome)]
            .fetch_add(1, Relaxed);
        self.step_time[step.index()][outcome_class(outcome)].record(took);
    }

    /// Counts a request answered in `took` with `result`.
    pub(crate) fn request(&self, kind: RequestKind, result: Option<ErrorCode>, took: Duration) {
        let kind = index_of(&RequestKind::ALL, &kind);
        self.requests[kind][result_index(result)].fetch_add(1, Relaxed);
        self.request_time[kind].record(took);
    }

    /// Counts a stream established.
    pub(crate) fn stream_opened(&self) {
        self.streams_opened.fetch_add(1, Relaxed);
    }

    /// Counts a stream closed after moving `up` bytes to the guest and
    /// `down` to the client.
    pub(crate) fn stream_closed(&self, up: u64, down: u64) {
        self.streams_closed.fetch_add(1, Relaxed);
        self.stream_bytes[0].fetch_add(up, Relaxed);
        self.stream_bytes[1].fetch_add(down, Relaxed);
    }

    /// Counts an alarm.
    pub(crate) fn alarm(&self, alarm: Alarm) {
        self.alarms[index_of(&Alarm::ALL, &alarm)].fetch_add(1, Relaxed);
    }

    /// Counts a canary run that ended at `unix_ms`.
    pub(crate) fn canary(
        &self,
        path: CanaryPath,
        outcome: CanaryOutcome,
        took: Duration,
        unix_ms: u64,
    ) {
        let path = index_of(&CanaryPath::ALL, &path);
        self.canary[path][index_of(&CanaryOutcome::ALL, &outcome)].fetch_add(1, Relaxed);
        self.canary_time[path].record(took);
        self.canary_last_ms[path].store(unix_ms, Relaxed);
    }

    /// Counts what the exporter dropped.
    pub(crate) fn dropped(&self, signal: Signal, reason: DropReason, count: u64) {
        let signal = usize::from(signal == Signal::Metrics);
        self.dropped[signal][index_of(&DropReason::ALL, &reason)].fetch_add(count, Relaxed);
    }

    /// Replaces the gauges with a new sample's.
    pub(crate) fn set_gauges(&self, gauges: &Gauges) {
        *self
            .gauges
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = *gauges;
    }

    /// The gauges as last sampled.
    #[must_use]
    pub fn gauges(&self) -> Gauges {
        *self
            .gauges
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// How often `alarm` happened since the agent started.
    #[must_use]
    pub fn alarms(&self, alarm: Alarm) -> u64 {
        self.alarms[index_of(&Alarm::ALL, &alarm)].load(Relaxed)
    }

    /// How many steps of `step` ended with `outcome`, whatever their cause.
    #[must_use]
    pub fn steps(&self, step: Step, outcome: Outcome) -> u64 {
        self.steps[step.index()]
            .iter()
            .map(|outcomes| outcomes[outcome_index(outcome)].load(Relaxed))
            .sum()
    }

    /// How many requests of `kind` ended with `result`.
    #[must_use]
    pub fn requests(&self, kind: RequestKind, result: Option<ErrorCode>) -> u64 {
        self.requests[index_of(&RequestKind::ALL, &kind)][result_index(result)].load(Relaxed)
    }

    /// How many canary runs of `path` ended with `outcome`.
    #[must_use]
    pub fn canary_runs(&self, path: CanaryPath, outcome: CanaryOutcome) -> u64 {
        self.canary[index_of(&CanaryPath::ALL, &path)][index_of(&CanaryOutcome::ALL, &outcome)]
            .load(Relaxed)
    }

    /// How many records or data points of `signal` the exporter dropped
    /// for `reason`.
    #[must_use]
    pub fn drops(&self, signal: Signal, reason: DropReason) -> u64 {
        self.dropped[usize::from(signal == Signal::Metrics)][index_of(&DropReason::ALL, &reason)]
            .load(Relaxed)
    }

    /// Calls `each` for every metric's data points as they stand: what
    /// the exporter encodes.
    pub(crate) fn visit(&self, each: &mut impl Visitor) {
        let label = |pairs: &[(&'static str, &'static str)]| pairs.to_vec();
        for step in Step::ALL {
            for (cause_index, cause) in Cause::ALL.iter().enumerate() {
                for (outcome_index, outcome) in OUTCOMES.iter().enumerate() {
                    let count = self.steps[step.index()][cause_index][outcome_index].load(Relaxed);
                    if count > 0 {
                        each.sum(
                            "compute.step.count",
                            &label(&[
                                ("compute.step", crate::protocol::step_name(step)),
                                ("compute.cause", cause.name()),
                                ("compute.outcome", outcome),
                            ]),
                            count,
                        );
                    }
                }
            }
            for (class, name) in OUTCOME_CLASSES.iter().enumerate() {
                let reading = self.step_time[step.index()][class].read();
                if reading.count > 0 {
                    each.histogram(
                        "compute.step.duration",
                        &label(&[
                            ("compute.step", crate::protocol::step_name(step)),
                            ("compute.outcome", name),
                        ]),
                        &reading,
                    );
                }
            }
        }
        for (kind_index, kind) in RequestKind::ALL.iter().enumerate() {
            for result in std::iter::once(None).chain(ERROR_CODES.map(Some)) {
                let count = self.requests[kind_index][result_index(result)].load(Relaxed);
                if count > 0 {
                    each.sum(
                        "compute.request.count",
                        &label(&[
                            ("compute.request", kind.name()),
                            ("compute.result", result_name(result)),
                        ]),
                        count,
                    );
                }
            }
            let reading = self.request_time[kind_index].read();
            if reading.count > 0 {
                each.histogram(
                    "compute.request.duration",
                    &label(&[("compute.request", kind.name())]),
                    &reading,
                );
            }
        }
        let opened = self.streams_opened.load(Relaxed);
        let closed = self.streams_closed.load(Relaxed);
        each.sum("compute.stream.opened", &[], opened);
        each.sum("compute.stream.closed", &[], closed);
        each.gauge("compute.stream.open", &[], opened.saturating_sub(closed));
        for (direction, bytes) in ["to_guest", "to_client"].iter().zip(&self.stream_bytes) {
            each.sum(
                "compute.stream.bytes",
                &label(&[("compute.direction", direction)]),
                bytes.load(Relaxed),
            );
        }
        // Always present, zero included: an alert on these must see a
        // value to compare.
        for (alarm, count) in Alarm::ALL.iter().zip(&self.alarms) {
            each.sum(
                "compute.alarm.count",
                &label(&[("compute.alarm", alarm.name())]),
                count.load(Relaxed),
            );
        }
        self.visit_canary(each);
        for (signal, reasons) in ["logs", "metrics"].iter().zip(&self.dropped) {
            for (reason, count) in DropReason::ALL.iter().zip(reasons) {
                each.sum(
                    "compute.export.dropped",
                    &label(&[
                        ("compute.signal", signal),
                        ("compute.reason", reason.name()),
                    ]),
                    count.load(Relaxed),
                );
            }
        }
        visit_gauges(&self.gauges(), each);
    }

    fn visit_canary(&self, each: &mut impl Visitor) {
        for (path_index, path) in CanaryPath::ALL.iter().enumerate() {
            let last = self.canary_last_ms[path_index].load(Relaxed);
            if last == 0 {
                // This host's canary never ran the path.
                continue;
            }
            for (outcome_index, outcome) in CanaryOutcome::ALL.iter().enumerate() {
                each.sum(
                    "compute.canary.count",
                    &[
                        ("compute.canary.path", path.name()),
                        ("compute.outcome", outcome.name()),
                    ],
                    self.canary[path_index][outcome_index].load(Relaxed),
                );
            }
            each.histogram(
                "compute.canary.duration",
                &[("compute.canary.path", path.name())],
                &self.canary_time[path_index].read(),
            );
            each.gauge_seconds(
                "compute.canary.last_run",
                &[("compute.canary.path", path.name())],
                Duration::from_millis(last).as_secs_f64(),
            );
        }
    }
}

/// Every level's name, in [`Gauges::sandboxes`] order.
const LEVELS: [Level; 6] = [
    Level::Running,
    Level::Paused,
    Level::Compressed,
    Level::Saved,
    Level::Archived,
    Level::Remote,
];

/// A level's name on events and metrics, as on the wire.
#[must_use]
pub fn level_name(level: Level) -> &'static str {
    match level {
        Level::Running => "running",
        Level::Paused => "paused",
        Level::Compressed => "compressed",
        Level::Saved => "saved",
        Level::Archived => "archived",
        Level::Remote => "remote",
    }
}

/// The index of `level` in [`Gauges::sandboxes`].
#[must_use]
pub fn level_index(level: Level) -> usize {
    index_of(&LEVELS, &level)
}

fn visit_gauges(gauges: &Gauges, each: &mut impl Visitor) {
    if gauges.sampled_unix_ms > 0 {
        each.gauge_seconds(
            "compute.sample.time",
            &[],
            Duration::from_millis(gauges.sampled_unix_ms).as_secs_f64(),
        );
    }
    for (index, level) in LEVELS.iter().enumerate() {
        let labels = [("compute.level", level_name(*level))];
        each.gauge("compute.sandbox.count", &labels, gauges.sandboxes[index]);
        each.gauge("compute.sandbox.memory", &labels, gauges.memory[index]);
    }
    for step in Step::ALL {
        let labels = [("compute.step", crate::protocol::step_name(step))];
        each.gauge(
            "compute.step.in_flight",
            &labels,
            gauges.in_flight[step.index()],
        );
        each.gauge_seconds(
            "compute.step.oldest_age",
            &labels,
            Duration::from_millis(gauges.oldest_ms[step.index()]).as_secs_f64(),
        );
    }
    for (health, count) in [
        ("broken", gauges.broken),
        ("blocked", gauges.blocked),
        ("unsavable", gauges.unsavable),
    ] {
        each.gauge(
            "compute.sandbox.unhealthy",
            &[("compute.health", health)],
            count,
        );
    }
    let optional = [
        ("compute.host.memory.available", gauges.available),
        ("compute.host.zswap.stored", gauges.zswap_stored),
        ("compute.host.zswap.original", gauges.zswap_original),
        ("compute.host.hugepages.free", gauges.huge_pages_free),
        ("compute.transfer.foreground", gauges.transfers_foreground),
        ("compute.transfer.background", gauges.transfers_background),
    ];
    for (name, value) in optional {
        if let Some(value) = value {
            each.gauge(name, &[], value);
        }
    }
    for (resource, kinds) in PRESSURE_RESOURCES.iter().zip(&gauges.pressure) {
        for (kind, total) in ["some", "full"].iter().zip(kinds) {
            if let Some(total) = total {
                each.sum(
                    "compute.host.pressure.stall",
                    &[("compute.resource", resource), ("compute.pressure", kind)],
                    *total,
                );
            }
        }
    }
}

/// Receives every data point of [`Metrics::visit`].
pub(crate) trait Visitor {
    /// A cumulative, monotonic count.
    fn sum(&mut self, name: &'static str, labels: &[(&'static str, &'static str)], value: u64);
    /// A whole-number reading.
    fn gauge(&mut self, name: &'static str, labels: &[(&'static str, &'static str)], value: u64);
    /// A reading in seconds.
    fn gauge_seconds(
        &mut self,
        name: &'static str,
        labels: &[(&'static str, &'static str)],
        value: f64,
    );
    /// A cumulative histogram of durations over [`BOUNDS`].
    fn histogram(
        &mut self,
        name: &'static str,
        labels: &[(&'static str, &'static str)],
        reading: &HistogramReading,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_land_in_the_first_bucket_that_holds_them() {
        let histogram = Histogram::default();
        histogram.record(Duration::from_micros(500));
        histogram.record(Duration::from_millis(1));
        histogram.record(Duration::from_millis(80));
        histogram.record(Duration::from_secs(600));
        let reading = histogram.read();
        assert_eq!(reading.count, 4);
        assert_eq!(reading.buckets[0], 2, "0.5 ms and 1 ms are at most 1 ms");
        assert_eq!(reading.buckets[6], 1, "80 ms is in (50 ms, 100 ms]");
        assert_eq!(reading.buckets[BOUNDS.len()], 1, "600 s overflows");
        assert!((reading.sum_seconds - 600.0815).abs() < 1e-9);
    }

    #[test]
    fn every_result_has_its_own_count() {
        let metrics = Metrics::default();
        metrics.request(RequestKind::Wake, None, Duration::ZERO);
        metrics.request(RequestKind::Wake, Some(ErrorCode::HostFull), Duration::ZERO);
        metrics.request(RequestKind::Wake, Some(ErrorCode::Internal), Duration::ZERO);
        assert_eq!(metrics.requests(RequestKind::Wake, None), 1);
        assert_eq!(
            metrics.requests(RequestKind::Wake, Some(ErrorCode::HostFull)),
            1
        );
        assert_eq!(
            metrics.requests(RequestKind::Wake, Some(ErrorCode::Internal)),
            1
        );
        assert_eq!(metrics.requests(RequestKind::Touch, None), 0);
    }
}
