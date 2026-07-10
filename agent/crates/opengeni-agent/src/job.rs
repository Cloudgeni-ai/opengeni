//! The op-stream job pump: one tokio task per job, streaming a contained
//! child's output through the pure op engine to an injected frame sink.
//!
//! This module is TRANSPORT-FREE (`.agent/ENGINE-INTEGRATION.md` §"The job
//! runner"): it emits engine [`Frame`]s through a send hook and receives
//! [`JobCommand`]s through a mailbox. NATS subjects, protobuf encoding, and
//! publish failures are the supervisor's business; the pump never blocks on the
//! hook. The engine ([`RetentionLog`] + [`CreditFlow`]) owns every durability
//! and flow-control decision — the pump is the impure choreography around it.
//!
//! # The pump contract (binding, from ENGINE-INTEGRATION.md + PROTOCOL.md v1.1)
//!
//! * Reads of stdout/stderr share one budget and stop jointly: while attached
//!   the gate is `flow.allowance() > 0` (window exhaustion stops reads → the
//!   child blocks on write(2) → end-to-end throttle); while detached, and while
//!   draining after child exit, the gate is retention headroom (ruling M2).
//! * Ack accounting: freed sent-bytes are computed against retention BEFORE
//!   anything is freed (the frames are gone afterwards), and EVERY ack side
//!   effect — the credit window, the retention floor, final-ack honoring — is
//!   gated on the flow's `Applied` outcome (strict generation fencing,
//!   design-review ruling 2026-07-10: only the exact current attach
//!   generation speaks for the live consumer; stale AND future generations
//!   are refused wholesale).
//! * Frames are emitted in strictly ascending seq order — the engine's
//!   `on_sent` contract. When a frame cannot be sent at append time (window
//!   exhausted, detached, or mid-replay exhaustion) it stays retained and
//!   `flow.sent_hi()` becomes the pending-send cursor: every credit/attach
//!   event resumes sending from there ([`Pump::catch_up`]). A Progress tick
//!   appended while the pump is caught up is emitted immediately even with a
//!   zero allowance (credit-free — the M1 healing channel); one appended while
//!   data frames are still queued is emitted in order behind them, and M1
//!   healing rides the server's 5s re-ack timer leg instead.
//! * Progress ticks append every `progress_interval` of data silence while the
//!   op is alive — attached or not (they consume seqs and are retained, so gap
//!   detection stays uniform).
//! * The Exit frame is appended exactly once, on every path. If even the Exit
//!   append fails (retention already exhausted — the overflow path), the exit
//!   is NOT emitted as a frame; the [`JobHooks::on_exit`] lifecycle hook still
//!   fires (with `exit_seq: None`) and the supervisor answers `OpQuery` from
//!   the registry — honest, typed, never silent.
//! * After Exit the task lingers, serving Ack/Attach (replay of retained
//!   frames including the Exit) until a current-generation final ack or the
//!   supervisor drops the mailbox — completed-op replay is how a reconnecting
//!   server collects results; registry GC (supervisor scope) drops the mailbox.
//!
//! Input hygiene decisions (documented here because the wire can be hostile):
//! an `Attach.from_seq` beyond the high watermark is clamped to it (attaching
//! "past the end" would poison the ascending-seq send order); an attach floor
//! below the retention floor is served from the retention floor (the freed
//! frames are gone; server reassembly is seq-idempotent, so over-serving is
//! safe); a `final_ack` before completion is applied as a plain ack and the
//! final flag ignored.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use opengeni_agent_engine::flow::{AckOutcome, AttachOutcome, CreditFlow};
use opengeni_agent_engine::retention::{RetentionConfig, RetentionError, RetentionLog};
use opengeni_agent_engine::{Channel, Frame, FrameBody};
use opengeni_agent_platform::ContainedExec;
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::mpsc;
use tokio::time::{Instant, MissedTickBehavior};
use tracing::{debug, warn};

/// A command delivered to a running (or lingering completed) job through its
/// mailbox. The supervisor translates wire messages (`OpAck`/`OpAttach`/…)
/// into these; the pump never sees the transport.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobCommand {
    /// A cumulative ack + absolute credit grant from the consumer
    /// (wire: `OpAck`).
    Ack {
        /// The consumer's attach generation. Only the exact current
        /// generation applies (strict fencing); every side effect of a
        /// refused ack is discarded.
        generation: u64,
        /// Cumulative: every frame with `seq <= acked_seq` is acknowledged.
        acked_seq: u64,
        /// The replenished ABSOLUTE send-credit window in bytes.
        credit_bytes: u64,
        /// The consumer has fully consumed the terminal frame; the job may
        /// finish (honored only from the current generation, post-exit).
        final_ack: bool,
    },
    /// A consumer (re)attaches and requests replay (wire: `OpAttach`).
    Attach {
        /// The consumer's monotonic attach generation (ruling B2).
        generation: u64,
        /// Resume strictly after this seq (the consumer's cumulative-ack floor).
        from_seq: u64,
        /// The fresh send-credit window in bytes.
        window_bytes: u64,
    },
    /// The transport is gone (connection loss). Sending stops; the op keeps
    /// running and retention keeps accumulating (op ⊥ connection).
    Detach,
    /// Kill the job (wire: `OpCancel`). Terminates the process group and
    /// produces `Exit{cancelled}`. Idempotent; a no-op once terminal.
    Cancel,
}

/// Tuning knobs for one job's pump.
#[derive(Debug, Clone)]
pub struct JobConfig {
    /// Max payload bytes per Data frame (and per pipe read). Wire cap 128 KiB.
    pub max_frame_bytes: usize,
    /// Emit a Progress frame after this much data silence while the op lives.
    pub progress_interval: Duration,
}

impl Default for JobConfig {
    /// TEST-FLOOR values (LIMITS-DOCTRINE): production construction happens
    /// in the engine assembly, which derives `max_frame_bytes` from the
    /// NEGOTIATED transport `max_payload` (rule T) — the 128 KiB here is the
    /// no-transport fallback floor, never a ceiling. The progress interval is
    /// a pacing constant (rule P).
    fn default() -> Self {
        Self {
            max_frame_bytes: 128 * 1024,
            progress_interval: Duration::from_secs(5),
        }
    }
}

/// Everything a job needs at start. The supervisor performs admission and
/// spawns the contained child; the pump owns it from here to the grave.
pub struct JobParams {
    /// The spawned containment group (its stdio still attached; the pump takes
    /// stdin/stdout/stderr itself).
    pub child: ContainedExec,
    /// Bytes to feed the child's stdin; the handle is closed after writing
    /// (empty ⇒ closed immediately so a stdin-reading child never hangs).
    pub stdin: Vec<u8>,
    /// Retention bounds for this op (the supervisor already reserved the op's
    /// share of the global spool budget — ruling M2).
    pub retention: RetentionConfig,
    /// The op-private spool directory (created lazily on first spill; removed
    /// when the job task ends).
    pub spool_dir: PathBuf,
    /// Absolute runner-enforced deadline. Reaching it kills the process tree
    /// and produces `Exit{timed_out}` (deadline enforcement is authoritative
    /// agent-side).
    pub deadline: Option<Instant>,
    /// Pump tuning.
    pub config: JobConfig,
    /// The pump publishes its high watermark (the last assigned seq) here after
    /// every append, attached or not — the supervisor reads it to answer
    /// `OpQuery`/`OpStatus.next_seq` without reaching into the pump.
    pub watermark: Arc<AtomicU64>,
    /// Set (once) if POST-EXIT replay fails (spool IO/corruption): the
    /// terminal record survives in the registry, but the retained frames are
    /// unrecoverable — status answers must say so typed rather than let a
    /// consumer wait forever on replay (FAILURE-VISIBILITY two-planes rule).
    pub collection_failure: Arc<OnceLock<JobFailure>>,
}

/// The typed terminal outcome of a job — the engine-side form of the wire
/// `OpExit`; the supervisor encodes it (exit_code/timed_out/cancelled mapping).
#[derive(Debug, Clone, PartialEq)]
pub enum JobOutcome {
    /// The child exited on its own; `-1` when killed by an un-caught signal
    /// (mirrors the legacy one-shot exec mapping).
    Exited {
        /// The child's exit code.
        exit_code: i32,
    },
    /// The absolute deadline fired; the process tree was killed.
    TimedOut,
    /// Cancelled via [`JobCommand::Cancel`] (or an orphaning mailbox drop);
    /// the process tree was killed.
    Cancelled,
    /// The job was failed by the runner itself with a typed reason; the
    /// process tree was killed. Never silent (invariant #1).
    Failed(JobFailure),
}

/// Why the runner failed a job (each maps to a typed wire failure).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobFailure {
    /// Retention memory + spool quotas were exhausted (`OP_OVERFLOW`).
    Overflow {
        /// Payload bytes retained when the append was refused.
        retained_bytes: u64,
    },
    /// A spool read/write failed, including ENOSPC (`OP_SPOOL_IO`).
    SpoolIo {
        /// The rendered underlying error.
        detail: String,
    },
    /// Reading the child's pipes (or reaping it) failed.
    PipeIo {
        /// The rendered underlying error.
        detail: String,
    },
}

impl JobFailure {
    /// Maps a typed retention failure onto the job-failure form.
    fn from_retention(error: &RetentionError) -> Self {
        match error {
            RetentionError::Overflow { retained_bytes, .. } => JobFailure::Overflow {
                retained_bytes: *retained_bytes,
            },
            // SpoolIo — and ReplayBelowFloor, which cannot come out of an
            // append and is clamped away before replay; folded here so the
            // mapping stays total and honest.
            other => JobFailure::SpoolIo {
                detail: other.to_string(),
            },
        }
    }
}

/// Byte total + blake3 digest of one output channel's full stream — the
/// byte-exact assembly proof carried in the Exit frame.
#[derive(Debug, Clone, PartialEq)]
pub struct ChannelStats {
    /// Total bytes the child emitted on this channel.
    pub total_bytes: u64,
    /// blake3 of the full channel stream.
    pub digest: blake3::Hash,
}

/// The terminal record of a job. Encoded by the supervisor into the wire
/// `OpExit`; retained (encoded) as the Exit frame's payload for replay.
#[derive(Debug, Clone, PartialEq)]
pub struct JobExit {
    /// How the job ended.
    pub outcome: JobOutcome,
    /// Wall-clock job duration in milliseconds.
    pub duration_ms: u64,
    /// stdout totals + digest.
    pub stdout: ChannelStats,
    /// stderr totals + digest.
    pub stderr: ChannelStats,
}

/// The frame send hook: fire-and-forget, called in ascending seq order.
type EmitFn = Box<dyn Fn(Frame) + Send>;
/// Encodes the terminal record into the retained Exit-frame payload.
type EncodeExitFn = Box<dyn Fn(&JobExit) -> Vec<u8> + Send>;
/// The exactly-once lifecycle notification at completion.
type OnExitFn = Box<dyn FnOnce(Option<u64>, &JobExit) + Send>;

/// The supervisor-injected seams. All fire-and-forget: the pump never awaits
/// or retries them (publishing and its failures belong to the supervisor).
pub struct JobHooks {
    emit: EmitFn,
    encode_exit: EncodeExitFn,
    on_exit: Option<OnExitFn>,
}

impl JobHooks {
    /// Bundles the three seams.
    ///
    /// * `emit` — called for every frame the pump sends (live or replay), in
    ///   strictly ascending seq order per attachment.
    /// * `encode_exit` — produces the opaque Exit-frame payload the retention
    ///   log stores and replays (the wire encoding, at supervisor level).
    /// * `on_exit` — fires exactly once when the job reaches its terminal
    ///   record, attached or not; `exit_seq` is `None` in the rare case the
    ///   Exit frame itself could not be retained (see module docs). The
    ///   supervisor routes this to `registry.complete()`.
    pub fn new(
        emit: impl Fn(Frame) + Send + 'static,
        encode_exit: impl Fn(&JobExit) -> Vec<u8> + Send + 'static,
        on_exit: impl FnOnce(Option<u64>, &JobExit) + Send + 'static,
    ) -> Self {
        Self {
            emit: Box::new(emit),
            encode_exit: Box::new(encode_exit),
            on_exit: Some(Box::new(on_exit)),
        }
    }
}

/// How a job task ended — the pump is the single authority on final-ack
/// acceptance (it fences generations), so the caller uses this to decide
/// whether the registry entry may GC quietly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobEnd {
    /// A current-generation final ack confirmed full consumption of the
    /// terminal frame.
    FinalAcked,
    /// The mailbox was dropped/closed before a final ack (orphaned op, or
    /// supervisor-driven GC).
    Orphaned,
}

/// Runs one job to completion: pump the child's output into retention and (as
/// credit allows) out through the emit hook, service the mailbox, enforce the
/// deadline, then linger post-exit for result collection. See module docs for
/// the full contract. The future resolves when the job is fully collected
/// (current-generation final ack) or abandoned (mailbox dropped).
pub async fn run_job(
    params: JobParams,
    mailbox: mpsc::Receiver<JobCommand>,
    hooks: JobHooks,
) -> JobEnd {
    let JobParams {
        mut child,
        stdin,
        retention,
        spool_dir,
        deadline,
        config,
        watermark,
        collection_failure,
    } = params;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    spawn_stdin_writer(child.stdin.take(), stdin);

    let pump = Pump {
        retention: RetentionLog::new(retention.clone(), spool_dir.clone()),
        retention_config: retention,
        flow: CreditFlow::new(),
        hooks,
        watermark,
        collection_failure,
        exit_fence: None,
        child,
        child_done: false,
        child_code: -1,
        stdout,
        stderr,
        stdout_hash: blake3::Hasher::new(),
        stdout_total: 0,
        stderr_hash: blake3::Hasher::new(),
        stderr_total: 0,
        mailbox,
        mailbox_closed: false,
        pending_outcome: None,
        final_acked: false,
        started: Instant::now(),
        deadline,
        config,
    };
    // Boxed: the pump future carries the read buffers' state machine and this
    // sits at a task's root, so one heap allocation per job is the right trade.
    let end = Box::pin(pump.run()).await;

    // Op teardown removes the whole spool dir (retention.rs relies on this for
    // any segment an unlink failure leaked). Best-effort; absent dir is fine.
    let _ = std::fs::remove_dir_all(&spool_dir);
    end
}

/// Feeds the child's stdin from a buffer on a side task (writing inline could
/// deadlock against a child that fills stdout before reading stdin), then
/// closes the handle so the child sees EOF. An empty buffer closes immediately.
fn spawn_stdin_writer(stdin: Option<tokio::process::ChildStdin>, bytes: Vec<u8>) {
    let Some(mut stdin) = stdin else { return };
    if bytes.is_empty() {
        drop(stdin);
        return;
    }
    tokio::spawn(async move {
        // A dead child (EPIPE) is the child's business; the pump sees its exit.
        let _ = stdin.write_all(&bytes).await;
        let _ = stdin.shutdown().await;
    });
}

/// One pump-loop wakeup, produced by the select and handled with full `&mut`
/// access afterwards (the arm futures are dropped before handling).
enum Event {
    /// A mailbox command (`None` = the supervisor dropped the mailbox).
    Command(Option<JobCommand>),
    /// The direct child exited (the containment group is already reaped).
    ChildExit(std::io::Result<std::process::ExitStatus>),
    /// The absolute deadline fired.
    Deadline,
    /// The progress ticker fired (data silence).
    ProgressTick,
    /// A pipe read completed on `channel` (`Ok(0)` = EOF).
    Read(Channel, std::io::Result<usize>),
}

/// The per-job pump state. One instance per job task; nothing is shared.
struct Pump {
    retention: RetentionLog,
    retention_config: RetentionConfig,
    flow: CreditFlow,
    hooks: JobHooks,
    /// Mirror of `retention.high_seq()` for supervisor-side status answers.
    watermark: Arc<AtomicU64>,
    /// See [`JobParams::collection_failure`].
    collection_failure: Arc<OnceLock<JobFailure>>,
    /// The final-ack fence: the terminal frame's seq (or, when the exit frame
    /// could not be retained, the high watermark — everything retained). A
    /// final ack must reach it; set exactly once when the record is produced.
    exit_fence: Option<u64>,
    child: ContainedExec,
    child_done: bool,
    /// The child's exit code once `child_done` (`-1` for signal deaths,
    /// mirroring the legacy one-shot exec).
    child_code: i32,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
    stdout_hash: blake3::Hasher,
    stdout_total: u64,
    stderr_hash: blake3::Hasher,
    stderr_total: u64,
    mailbox: mpsc::Receiver<JobCommand>,
    mailbox_closed: bool,
    /// A terminal outcome decided before the exit record is built
    /// (cancel/deadline/typed failure). First writer wins.
    pending_outcome: Option<JobOutcome>,
    final_acked: bool,
    started: Instant,
    deadline: Option<Instant>,
    config: JobConfig,
}

impl Pump {
    /// The main loop: run until the child is reaped AND both pipes hit EOF,
    /// then emit the terminal record and linger for collection.
    async fn run(mut self) -> JobEnd {
        let period = self.config.progress_interval;
        let mut ticker = tokio::time::interval_at(self.started + period, period);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut stdout_buf = vec![0u8; self.config.max_frame_bytes];
        let mut stderr_buf = vec![0u8; self.config.max_frame_bytes];

        while !(self.child_done && self.stdout.is_none() && self.stderr.is_none()) {
            // The joint read gate (shared budget, both pipes stop together):
            // live-attached ⇒ credit; detached or post-exit drain ⇒ retention
            // headroom. Progress/mailbox stay serviced regardless (the arms
            // below are ungated) — a throttled pump must keep receiving the
            // credit that un-throttles it.
            let may_read = self.may_read();
            let event = tokio::select! {
                cmd = self.mailbox.recv(), if !self.mailbox_closed => Event::Command(cmd),
                status = wait_child(&mut self.child, self.child_done) => Event::ChildExit(status),
                () = sleep_until_opt(self.deadline), if self.deadline.is_some()
                    && !self.child_done
                    && self.pending_outcome.is_none() => Event::Deadline,
                _ = ticker.tick() => Event::ProgressTick,
                n = read_some(&mut self.stdout, &mut stdout_buf), if may_read
                    && self.stdout.is_some() => Event::Read(Channel::Stdout, n),
                n = read_some(&mut self.stderr, &mut stderr_buf), if may_read
                    && self.stderr.is_some() => Event::Read(Channel::Stderr, n),
            };
            match event {
                Event::Command(None) => {
                    // Orphaned: the supervisor is gone, nobody will collect.
                    // Kill the work; the exit record still forms (on_exit).
                    self.mailbox_closed = true;
                    if !self.child_done && self.pending_outcome.is_none() {
                        self.pending_outcome = Some(JobOutcome::Cancelled);
                        self.terminate_child();
                    }
                }
                Event::Command(Some(cmd)) => self.handle_command(cmd),
                Event::ChildExit(Ok(status)) => {
                    self.child_done = true;
                    self.child_code = status.code().unwrap_or(-1);
                }
                Event::ChildExit(Err(error)) => {
                    self.child_done = true;
                    self.fail(JobFailure::PipeIo {
                        detail: format!("wait: {error}"),
                    });
                }
                Event::Deadline => {
                    self.pending_outcome = Some(JobOutcome::TimedOut);
                    self.terminate_child();
                    // Keep looping: drain what the pipes hold (bounded by
                    // retention), then exit via the normal path.
                }
                Event::ProgressTick => {
                    if let Err(error) = self.append_and_send(FrameBody::Progress) {
                        self.fail(JobFailure::from_retention(&error));
                    }
                }
                Event::Read(channel, Ok(0)) => self.close_pipe(channel),
                Event::Read(channel, Ok(n)) => {
                    let bytes = match channel {
                        Channel::Stdout => &stdout_buf[..n],
                        Channel::Stderr | Channel::Content => &stderr_buf[..n],
                    };
                    self.on_data(channel, bytes);
                    // Data is the op's heartbeat; progress fills silences only.
                    ticker.reset();
                }
                Event::Read(channel, Err(error)) => {
                    self.fail(JobFailure::PipeIo {
                        detail: format!("read {channel:?}: {error}"),
                    });
                }
            }
        }

        self.finish().await
    }

    /// Emits the terminal record exactly once, then lingers serving
    /// replay/acks until a current-generation final ack or mailbox drop.
    async fn finish(mut self) -> JobEnd {
        let outcome = self.pending_outcome.take().unwrap_or(JobOutcome::Exited {
            exit_code: self.child_code,
        });
        let exit = JobExit {
            outcome,
            duration_ms: u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX),
            stdout: ChannelStats {
                total_bytes: self.stdout_total,
                digest: self.stdout_hash.finalize(),
            },
            stderr: ChannelStats {
                total_bytes: self.stderr_total,
                digest: self.stderr_hash.finalize(),
            },
        };
        let payload = (self.hooks.encode_exit)(&exit);
        let exit_seq = match self.append_and_send(FrameBody::Exit { payload }) {
            Ok(seq) => Some(seq),
            Err(error) => {
                // Retention is exhausted (the overflow path lands here). The
                // result still reaches the supervisor via on_exit; a late
                // consumer gets it through OpQuery — typed, never silent.
                warn!(%error, "exit frame could not be retained; result flows via lifecycle only");
                None
            }
        };
        // The final-ack fence: a consumer's final must cover the terminal
        // frame; when the exit frame itself could not be retained, covering
        // everything that WAS retained suffices (the record flows via query).
        self.exit_fence = Some(exit_seq.unwrap_or_else(|| self.retention.high_seq()));
        if let Some(on_exit) = self.hooks.on_exit.take() {
            on_exit(exit_seq, &exit);
        }

        // Post-exit collection: replay/acks for the retained frames (incl. the
        // Exit) until the consumer confirms full consumption. Errors here are
        // logged, not fatal — the terminal record already exists.
        while !self.final_acked && !self.mailbox_closed {
            let Some(cmd) = self.mailbox.recv().await else {
                break;
            };
            self.handle_command(cmd);
        }
        if self.final_acked {
            JobEnd::FinalAcked
        } else {
            JobEnd::Orphaned
        }
    }

    /// Services one mailbox command. Valid in both phases; phase-dependent
    /// behavior (cancel, final ack) checks `child_done`/`pending_outcome`.
    fn handle_command(&mut self, cmd: JobCommand) {
        match cmd {
            JobCommand::Ack {
                generation,
                acked_seq,
                credit_bytes,
                final_ack,
            } => {
                let applied = self.apply_ack(generation, acked_seq, credit_bytes);
                if final_ack {
                    // A final ack is honored ONLY from the exact current
                    // generation (Applied), post-exit, and covering the
                    // terminal frame (PROTOCOL v1.1: `acked_seq >= exit_seq`).
                    // Anything less applies as a plain ack, flag ignored,
                    // loudly — a "final" below the exit frame proves the
                    // consumer has NOT consumed the result.
                    match self.exit_fence {
                        Some(fence) if applied && acked_seq >= fence => {
                            self.final_acked = true;
                        }
                        Some(fence) => warn!(
                            generation,
                            acked_seq,
                            fence,
                            applied,
                            "final ack refused (wrong generation or below the terminal frame); \
                             applied as a plain ack"
                        ),
                        None => {
                            warn!(generation, acked_seq, "final ack before completion ignored");
                        }
                    }
                }
            }
            JobCommand::Attach {
                generation,
                from_seq,
                window_bytes,
            } => self.apply_attach(generation, from_seq, window_bytes),
            JobCommand::Detach => self.flow.detach(),
            JobCommand::Cancel => {
                // Idempotent; once the child is done the natural result stands
                // (the registry answers a late OpCancel with AlreadyComplete).
                if !self.child_done && self.pending_outcome.is_none() {
                    self.pending_outcome = Some(JobOutcome::Cancelled);
                    self.terminate_child();
                }
            }
        }
    }

    /// Whether the terminal record has been produced (we are lingering).
    fn exited(&self) -> bool {
        self.child_done && self.stdout.is_none() && self.stderr.is_none()
    }

    /// The ack-accounting order: freed sent-bytes are computed against
    /// retention FIRST (the frames are gone once freed), then the flow rules
    /// on the generation, and only an `Applied` outcome touches anything —
    /// the retention floor moves and catch-up runs for the live consumer
    /// alone (strict fencing: a zombie or never-attached generation's ack
    /// must not free frames or grant credit). Returns whether it applied.
    fn apply_ack(&mut self, generation: u64, acked_seq: u64, credit_bytes: u64) -> bool {
        let upper = acked_seq.min(self.flow.sent_hi());
        let freed = self
            .retention
            .payload_bytes_in_range(self.retention.floor(), upper);
        let applied = matches!(
            self.flow.on_ack(generation, credit_bytes, freed),
            AckOutcome::Applied
        );
        if applied {
            self.retention.ack(acked_seq);
            self.drive_catch_up();
        }
        applied
    }

    /// Handles an attach: generation fencing via the flow, then replay of
    /// retained frames under the fresh window. `from_seq` is clamped to the
    /// high watermark (see module docs on input hygiene).
    fn apply_attach(&mut self, generation: u64, from_seq: u64, window_bytes: u64) {
        let from = from_seq.min(self.retention.high_seq());
        match self.flow.attach(generation, from, window_bytes) {
            AttachOutcome::Accepted => self.drive_catch_up(),
            AttachOutcome::StaleGeneration { current } => {
                debug!(generation, current, "stale attach refused");
            }
        }
    }

    /// Runs [`Self::catch_up`], converting a pre-exit replay failure into the
    /// typed terminal path. Post-exit, a replay failure means the retained
    /// frames are UNRECOVERABLE (spool IO/corruption) while the terminal
    /// record survives — surfaced typed through the shared collection-failure
    /// slot so status answers stop promising a replay that cannot come.
    fn drive_catch_up(&mut self) {
        if let Err(error) = self.catch_up() {
            if self.exited() {
                warn!(
                    %error,
                    "post-exit replay failed; retained frames unrecoverable — \
                     the terminal record remains queryable and now carries the failure"
                );
                let _ = self
                    .collection_failure
                    .set(JobFailure::from_retention(&error));
            } else {
                self.fail(JobFailure::from_retention(&error));
            }
        }
    }

    /// Sends retained-but-unsent frames in seq order while the window allows.
    /// `flow.sent_hi()` is the pending-send cursor: it lags `retention`'s high
    /// watermark whenever frames were appended un-sendable (detached, window
    /// exhausted, mid-replay exhaustion) and this closes the gap. A cursor
    /// below the retention floor resumes at the floor (those frames are freed;
    /// serving from the floor is safe because server reassembly is
    /// seq-idempotent).
    ///
    /// The tail is walked through [`RetentionLog::replay_bounded`] with the
    /// remaining send allowance as the budget, so a huge spooled backlog is
    /// read in window-sized bites instead of being materialized whole.
    fn catch_up(&mut self) -> Result<(), RetentionError> {
        loop {
            if !self.flow.is_attached() {
                return Ok(());
            }
            let from = self.flow.sent_hi().max(self.retention.floor());
            if from >= self.retention.high_seq() {
                return Ok(());
            }
            let budget = self.flow.allowance();
            if budget == 0 {
                return Ok(());
            }
            let frames = self.retention.replay_bounded(from, budget)?;
            if frames.is_empty() {
                return Ok(());
            }
            for frame in frames {
                if !self.flow.may_send(payload_len(&frame.body)) {
                    // Window exhausted mid-catch-up: the cursor holds; the
                    // next current-generation ack resumes from here.
                    return Ok(());
                }
                self.send(frame);
            }
            // Everything in this bite was sent; loop for the next bite (the
            // cursor advanced, so the walk always terminates).
        }
    }

    /// Appends a frame to retention and emits it immediately iff the pump is
    /// attached, caught up (in-order), and within the window. Otherwise the
    /// frame waits in retention for [`Self::catch_up`].
    fn append_and_send(&mut self, body: FrameBody) -> Result<u64, RetentionError> {
        let len = payload_len(&body);
        let live = self.flow.is_attached()
            && self.flow.sent_hi() == self.retention.high_seq()
            && self.flow.may_send(len);
        let live_copy = live.then(|| body.clone());
        let seq = self.retention.append(body)?;
        self.watermark.store(seq, Ordering::Relaxed);
        if let Some(body) = live_copy {
            self.send(Frame { seq, body });
        }
        Ok(seq)
    }

    /// The single emit choke point: every frame that leaves the pump passes
    /// through `flow.on_sent` accounting first (a pinned invariant).
    fn send(&mut self, frame: Frame) {
        self.flow.on_sent(frame.seq, payload_len(&frame.body));
        (self.hooks.emit)(frame);
    }

    /// Digests + appends one chunk of child output.
    fn on_data(&mut self, channel: Channel, bytes: &[u8]) {
        let n = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        match channel {
            Channel::Stdout => {
                self.stdout_hash.update(bytes);
                self.stdout_total = self.stdout_total.saturating_add(n);
            }
            Channel::Stderr => {
                self.stderr_hash.update(bytes);
                self.stderr_total = self.stderr_total.saturating_add(n);
            }
            Channel::Content => {}
        }
        let body = FrameBody::Data {
            channel,
            bytes: bytes.to_vec(),
        };
        if let Err(error) = self.append_and_send(body) {
            self.fail(JobFailure::from_retention(&error));
        }
    }

    /// The joint read gate. See the loop comment in [`Self::run`].
    ///
    /// Attached, the gate is windowed: allowance must remain AND the pump
    /// must be caught up. The caught-up requirement is load-bearing (found
    /// live by harness scenario E3): a chunked read that overshoots the
    /// remaining allowance leaves a retained-UNSENT frame which consumes no
    /// window — with `allowance() > 0` alone the gate would never close and
    /// the child would stream unbounded into retention instead of being
    /// throttled end-to-end. Behind = the window is exhausted in spirit: the
    /// next frame cannot be sent either, so reading more only buys buffered
    /// bytes nobody granted credit for.
    fn may_read(&self) -> bool {
        if self.child_done {
            // Post-exit drain: the group is killed, EOF is imminent; what the
            // pipes still hold counts against retention like any output.
            self.retention_headroom()
        } else if self.flow.is_attached() {
            self.flow.sent_hi() >= self.retention.high_seq() && self.flow.allowance() > 0
        } else {
            self.retention_headroom()
        }
    }

    /// Whether retention can take one more max-size frame. Stopping reads one
    /// frame early keeps the (small) Exit frame appendable at quota, so a
    /// detached op that fills its quota parks (child pipe-blocked, resumable)
    /// instead of dying — ruling M2. Appends can still fail typed if a
    /// consumer's credit outruns its acks (the OP_OVERFLOW path).
    fn retention_headroom(&self) -> bool {
        let budget = if self.retention_config.spool_max_bytes > 0 {
            self.retention_config.spool_max_bytes
        } else {
            u64::try_from(self.retention_config.memory_max_bytes).unwrap_or(u64::MAX)
        };
        let reserve = u64::try_from(self.config.max_frame_bytes).unwrap_or(u64::MAX);
        self.retention.retained_bytes().saturating_add(reserve) <= budget
    }

    /// SIGKILLs the containment group (idempotent), logging a residual error.
    fn terminate_child(&mut self) {
        if let Err(error) = self.child.terminate() {
            warn!(%error, "terminating the job's process group failed");
        }
    }

    /// Enters the typed-failure path: record the outcome (first writer wins),
    /// kill the work, and stop reading — the loop then falls through to the
    /// terminal record as soon as the child is reaped.
    fn fail(&mut self, failure: JobFailure) {
        if self.pending_outcome.is_none() {
            self.pending_outcome = Some(JobOutcome::Failed(failure));
        }
        self.terminate_child();
        self.stdout = None;
        self.stderr = None;
    }

    /// Drops a pipe handle at EOF.
    fn close_pipe(&mut self, channel: Channel) {
        match channel {
            Channel::Stdout => self.stdout = None,
            Channel::Stderr => self.stderr = None,
            Channel::Content => {}
        }
    }
}

/// A frame body's payload size as the engine's u64 accounting unit.
fn payload_len(body: &FrameBody) -> u64 {
    u64::try_from(body.payload_len()).unwrap_or(u64::MAX)
}

/// Reads from an optional pipe; pends forever on `None` (select-arm safe: a
/// disabled precondition still constructs the future).
async fn read_some<R>(pipe: &mut Option<R>, buf: &mut [u8]) -> std::io::Result<usize>
where
    R: AsyncRead + Unpin,
{
    match pipe.as_mut() {
        Some(reader) => reader.read(buf).await,
        None => std::future::pending().await,
    }
}

/// Waits for the direct child once; pends forever after it was reaped so the
/// select arm never polls a finished wait.
async fn wait_child(
    child: &mut ContainedExec,
    done: bool,
) -> std::io::Result<std::process::ExitStatus> {
    if done {
        std::future::pending().await
    } else {
        child.wait().await
    }
}

/// Sleeps until an optional absolute deadline; pends forever on `None`.
async fn sleep_until_opt(deadline: Option<Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

// The tests drive REAL /bin/sh children through the containment primitive —
// they validate POSIX child semantics (exit codes, pipes, process groups)
// and are unix-only by nature (the #349 CI lesson). The code under test itself
// compiles and runs on Windows (Job Objects); its Windows behavior is
// covered by the platform crate's cross-platform surface.
#[cfg(all(test, unix))]
mod tests {
    use std::collections::BTreeMap;

    use opengeni_agent_platform::spawn_contained;
    use tokio::sync::oneshot;
    use tokio::time::timeout;

    use super::*;

    /// Timeout for awaited events in real-time tests. Paused-clock tests use
    /// [`PAUSED_WAIT`]: auto-advance would jump a small virtual timeout past a
    /// pending REAL event (child I/O, SIGCHLD), so they need a huge virtual
    /// budget that the pump's own timers walk through while the real event
    /// lands. The budget buys REAL time proportional to the wakeup count
    /// (virtual budget / 5s ticker steps × per-wakeup cost), so it is sized
    /// generously: ~500k wakeups ≈ seconds of real margin even under a fully
    /// loaded parallel test run.
    const WAIT: Duration = Duration::from_secs(10);
    const PAUSED_WAIT: Duration = Duration::from_secs(30 * 24 * 3600);

    struct JobBuilder {
        script: String,
        stdin: Vec<u8>,
        retention: RetentionConfig,
        deadline_after: Option<Duration>,
        config: JobConfig,
        wait: Duration,
        exit_payload_bytes: Option<usize>,
    }

    fn job(script: &str) -> JobBuilder {
        JobBuilder {
            script: script.to_string(),
            stdin: Vec::new(),
            retention: RetentionConfig::default(),
            deadline_after: None,
            config: JobConfig::default(),
            wait: WAIT,
            exit_payload_bytes: None,
        }
    }

    impl JobBuilder {
        fn stdin(mut self, bytes: &[u8]) -> Self {
            self.stdin = bytes.to_vec();
            self
        }

        fn frame_bytes(mut self, n: usize) -> Self {
            self.config.max_frame_bytes = n;
            self
        }

        fn retention(mut self, retention: RetentionConfig) -> Self {
            self.retention = retention;
            self
        }

        fn deadline_after(mut self, after: Duration) -> Self {
            self.deadline_after = Some(after);
            self
        }

        /// Use the huge virtual await budget (see [`PAUSED_WAIT`]).
        fn paused(mut self) -> Self {
            self.wait = PAUSED_WAIT;
            self
        }

        /// Encode Exit frames as a fixed blob of this size (drives the
        /// exit-cannot-be-retained path deterministically).
        fn exit_payload(mut self, bytes: usize) -> Self {
            self.exit_payload_bytes = Some(bytes);
            self
        }

        fn start(self) -> TestJob {
            let dir = tempfile::tempdir().expect("tempdir");
            let mut cmd = tokio::process::Command::new("/bin/sh");
            cmd.arg("-c").arg(&self.script);
            cmd.current_dir(dir.path());
            let child = spawn_contained(cmd, None).expect("spawn test child");

            let (cmd_tx, cmd_rx) = mpsc::channel(64);
            let (frame_tx, frame_rx) = mpsc::unbounded_channel();
            let (exit_tx, exit_rx) = oneshot::channel();
            let exit_payload_bytes = self.exit_payload_bytes;
            let hooks = JobHooks::new(
                move |frame| {
                    let _ = frame_tx.send(frame);
                },
                move |exit| match exit_payload_bytes {
                    Some(n) => vec![0xEE; n],
                    None => format!("{exit:?}").into_bytes(),
                },
                move |exit_seq, exit: &JobExit| {
                    let _ = exit_tx.send((exit_seq, exit.clone()));
                },
            );
            let watermark = Arc::new(AtomicU64::new(0));
            let collection_failure = Arc::new(OnceLock::new());
            let params = JobParams {
                child,
                stdin: self.stdin,
                retention: self.retention,
                spool_dir: dir.path().join("spool"),
                deadline: self.deadline_after.map(|after| Instant::now() + after),
                config: self.config,
                watermark: watermark.clone(),
                collection_failure: collection_failure.clone(),
            };
            let task = tokio::spawn(run_job(params, cmd_rx, hooks));
            TestJob {
                commands: Some(cmd_tx),
                frames: frame_rx,
                exit: Some(exit_rx),
                task,
                dir,
                wait: self.wait,
                watermark,
                collection_failure,
            }
        }
    }

    struct TestJob {
        commands: Option<mpsc::Sender<JobCommand>>,
        frames: mpsc::UnboundedReceiver<Frame>,
        exit: Option<oneshot::Receiver<(Option<u64>, JobExit)>>,
        task: tokio::task::JoinHandle<JobEnd>,
        dir: tempfile::TempDir,
        wait: Duration,
        watermark: Arc<AtomicU64>,
        collection_failure: Arc<OnceLock<JobFailure>>,
    }

    impl TestJob {
        async fn send(&self, cmd: JobCommand) {
            self.commands
                .as_ref()
                .expect("commands still held")
                .send(cmd)
                .await
                .expect("pump alive");
        }

        async fn attach(&self, generation: u64, from_seq: u64, window_bytes: u64) {
            self.send(JobCommand::Attach {
                generation,
                from_seq,
                window_bytes,
            })
            .await;
        }

        async fn ack(&self, generation: u64, acked_seq: u64, credit_bytes: u64) {
            self.send(JobCommand::Ack {
                generation,
                acked_seq,
                credit_bytes,
                final_ack: false,
            })
            .await;
        }

        async fn final_ack(&self, generation: u64, acked_seq: u64, credit_bytes: u64) {
            self.send(JobCommand::Ack {
                generation,
                acked_seq,
                credit_bytes,
                final_ack: true,
            })
            .await;
        }

        async fn next_frame(&mut self) -> Frame {
            timeout(self.wait, self.frames.recv())
                .await
                .expect("frame within the await budget")
                .expect("frame channel open")
        }

        /// Asserts NOTHING is emitted for `quiet` (real-time tests only).
        async fn no_frame_for(&mut self, quiet: Duration) {
            if let Ok(frame) = timeout(quiet, self.frames.recv()).await {
                panic!("expected emission silence, got {frame:?}");
            }
        }

        async fn collect_until_exit(&mut self) -> Vec<Frame> {
            let mut frames = Vec::new();
            loop {
                let frame = self.next_frame().await;
                let done = frame.body.is_exit();
                frames.push(frame);
                if done {
                    return frames;
                }
            }
        }

        async fn wait_exit(&mut self) -> (Option<u64>, JobExit) {
            timeout(self.wait, self.exit.take().expect("exit awaited once"))
                .await
                .expect("exit within the await budget")
                .expect("exit hook fired")
        }

        async fn join(self) {
            timeout(self.wait, self.task)
                .await
                .expect("task ends within the await budget")
                .expect("pump task must not panic");
        }
    }

    /// Orders frames by seq, asserting duplicate seqs (replay overlap) carry
    /// identical bodies, and concatenates one channel's Data payloads.
    fn reassemble(frames: &[Frame], channel: Channel) -> Vec<u8> {
        let mut by_seq: BTreeMap<u64, &Frame> = BTreeMap::new();
        for frame in frames {
            if let Some(previous) = by_seq.insert(frame.seq, frame) {
                assert_eq!(
                    previous, frame,
                    "replayed frame must be byte-identical to the original"
                );
            }
        }
        let mut bytes = Vec::new();
        for frame in by_seq.values() {
            if let FrameBody::Data {
                channel: c,
                bytes: b,
            } = &frame.body
            {
                if *c == channel {
                    bytes.extend_from_slice(b);
                }
            }
        }
        bytes
    }

    /// Asserts the deduped seqs run consecutively from 1 (uniform gap
    /// detection: every frame kind consumes exactly one seq).
    fn assert_consecutive_from_one(frames: &[Frame]) {
        let mut seqs: Vec<u64> = frames.iter().map(|f| f.seq).collect();
        seqs.sort_unstable();
        seqs.dedup();
        let expected: Vec<u64> = (1..=u64::try_from(seqs.len()).expect("fits")).collect();
        assert_eq!(seqs, expected, "seqs must be consecutive from 1");
    }

    fn data_total(frames: &[Frame]) -> u64 {
        let mut by_seq: BTreeMap<u64, u64> = BTreeMap::new();
        for frame in frames {
            if let FrameBody::Data { bytes, .. } = &frame.body {
                by_seq.insert(frame.seq, u64::try_from(bytes.len()).expect("fits"));
            }
        }
        by_seq.values().sum()
    }

    #[tokio::test]
    async fn happy_path_streams_both_channels_with_exact_digests() {
        let mut job = job("printf hello; printf oops >&2; exit 3").start();
        job.attach(1, 0, 1 << 20).await;

        let frames = job.collect_until_exit().await;
        assert_eq!(reassemble(&frames, Channel::Stdout), b"hello");
        assert_eq!(reassemble(&frames, Channel::Stderr), b"oops");
        assert_consecutive_from_one(&frames);

        let (exit_seq, exit) = job.wait_exit().await;
        assert_eq!(exit.outcome, JobOutcome::Exited { exit_code: 3 });
        assert_eq!(exit.stdout.total_bytes, 5);
        assert_eq!(exit.stdout.digest, blake3::hash(b"hello"));
        assert_eq!(exit.stderr.total_bytes, 4);
        assert_eq!(exit.stderr.digest, blake3::hash(b"oops"));
        assert_eq!(
            exit_seq,
            Some(frames.last().expect("exit frame").seq),
            "lifecycle exit_seq matches the emitted Exit frame"
        );

        job.final_ack(1, exit_seq.unwrap(), 1 << 20).await;
        job.join().await;
    }

    #[tokio::test]
    async fn stdin_is_delivered_and_closed() {
        let mut job = job("cat").stdin(b"stdin-bytes").start();
        job.attach(1, 0, 1 << 20).await;

        let frames = job.collect_until_exit().await;
        assert_eq!(reassemble(&frames, Channel::Stdout), b"stdin-bytes");

        let (exit_seq, exit) = job.wait_exit().await;
        assert_eq!(exit.outcome, JobOutcome::Exited { exit_code: 0 });
        assert_eq!(exit.stdout.digest, blake3::hash(b"stdin-bytes"));
        job.final_ack(1, exit_seq.unwrap(), 1 << 20).await;
        job.join().await;
    }

    #[tokio::test]
    async fn detached_run_retains_all_emits_nothing_and_replays_post_exit() {
        let mut job = job("printf payload").start();

        // The whole run happens with no consumer attached.
        let (exit_seq, exit) = job.wait_exit().await;
        assert_eq!(exit.outcome, JobOutcome::Exited { exit_code: 0 });
        assert_eq!(exit_seq, Some(2), "data seq 1, exit seq 2");
        assert_eq!(
            job.watermark.load(Ordering::Relaxed),
            2,
            "the shared watermark mirrors the high seq for OpStatus.next_seq"
        );
        job.no_frame_for(Duration::from_millis(150)).await;

        // A late consumer collects the completed op by attach + replay.
        job.attach(1, 0, 1 << 20).await;
        let first = job.collect_until_exit().await;
        assert_eq!(reassemble(&first, Channel::Stdout), b"payload");
        assert_eq!(first.last().expect("exit").seq, 2);

        // An equal-generation re-attach (redelivered OpAttach) replays
        // idempotently.
        job.attach(1, 0, 1 << 20).await;
        let second = job.collect_until_exit().await;
        assert_eq!(first, second, "equal-generation replay is identical");

        job.final_ack(1, 2, 1 << 20).await;
        job.join().await;
    }

    #[tokio::test]
    async fn detach_and_reattach_mid_stream_reassembles_byte_exact() {
        let expected: Vec<u8> = (0..2000)
            .flat_map(|i| format!("{i:0100}").into_bytes())
            .collect();
        let mut job = job("i=0; while [ $i -lt 2000 ]; do printf '%0100d' $i; i=$((i+1)); done")
            .frame_bytes(4096)
            .start();

        job.attach(1, 0, 16 * 1024).await;
        let mut frames = Vec::new();
        let mut acked = 0u64;

        // Consume + cumulatively ack until mid-stream, then vanish.
        while data_total(&frames) < 50_000 {
            let frame = job.next_frame().await;
            acked = frame.seq;
            job.ack(1, acked, 16 * 1024).await;
            frames.push(frame);
        }
        job.send(JobCommand::Detach).await;

        // Reconnect as the next consumer generation from the ack floor; the
        // window between our last ack and the detach replays (dedup-checked).
        job.attach(2, acked, 16 * 1024).await;
        loop {
            let frame = job.next_frame().await;
            let done = frame.body.is_exit();
            acked = frame.seq;
            job.ack(2, acked, 16 * 1024).await;
            frames.push(frame);
            if done {
                break;
            }
        }

        let stdout = reassemble(&frames, Channel::Stdout);
        assert_eq!(stdout.len(), expected.len());
        assert_eq!(stdout, expected, "byte-exact across detach/attach");
        let (exit_seq, exit) = job.wait_exit().await;
        assert_eq!(exit.stdout.total_bytes, 200_000);
        assert_eq!(exit.stdout.digest, blake3::hash(&expected));
        assert_eq!(exit.stdout.digest, blake3::hash(&stdout));

        job.final_ack(2, exit_seq.unwrap(), 16 * 1024).await;
        job.join().await;
    }

    #[tokio::test]
    async fn lost_ack_is_healed_by_a_repeated_cumulative_ack() {
        let mut job = job("i=0; while [ $i -lt 8 ]; do head -c 1024 /dev/zero; i=$((i+1)); done")
            .frame_bytes(1024)
            .start();
        job.attach(1, 0, 2048).await;

        // Two frames fill the window; the server's first ack is "lost".
        let mut frames = vec![job.next_frame().await, job.next_frame().await];
        assert_eq!(data_total(&frames), 2048);
        job.no_frame_for(Duration::from_millis(200)).await;

        // The server re-emits its cumulative ack (ruling M1) — flow resumes
        // with no other stimulus.
        job.ack(1, 2, 2048).await;
        frames.push(job.next_frame().await);
        // From here, ack-per-frame keeps the window open through the queued
        // remainder and the Exit frame.
        loop {
            let last = frames.last().expect("nonempty");
            if last.body.is_exit() {
                break;
            }
            job.ack(1, last.seq, 2048).await;
            frames.push(job.next_frame().await);
        }

        let zeros = vec![0u8; 8192];
        assert_eq!(reassemble(&frames, Channel::Stdout), zeros);
        let (exit_seq, exit) = job.wait_exit().await;
        assert_eq!(exit.stdout.digest, blake3::hash(&zeros));
        job.final_ack(1, exit_seq.unwrap(), 2048).await;
        job.join().await;
    }

    #[tokio::test]
    async fn exhausted_window_throttles_the_child_end_to_end() {
        // The child reports its own write progress to a FILE (not a pipe), so
        // a stalled file proves the child is blocked in write(2) on stdout.
        let mut job = job("i=0; while [ $i -lt 200 ]; do head -c 4096 /dev/zero; \
             echo $i >> progress.txt; i=$((i+1)); done")
        .frame_bytes(4096)
        .start();
        let progress_path = job.dir.path().join("progress.txt");
        let lines =
            |path: &std::path::Path| std::fs::read_to_string(path).map_or(0, |s| s.lines().count());

        job.attach(1, 0, 8192).await;
        let mut frames = vec![job.next_frame().await, job.next_frame().await];
        assert_eq!(data_total(&frames), 8192, "exactly one window was emitted");
        job.no_frame_for(Duration::from_millis(200)).await;

        // Pipe (64 KiB) + window are full: the producer must be blocked well
        // short of its 200 iterations, and stay parked while we withhold acks.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let parked_at = lines(&progress_path);
        assert!(
            parked_at < 200,
            "producer must be far from done: {parked_at}"
        );
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(
            lines(&progress_path),
            parked_at,
            "producer is blocked in write(2) while credit is withheld"
        );

        // Credit returns: the child un-blocks and finishes all 200 writes.
        job.ack(1, frames.last().expect("frames").seq, 1 << 20)
            .await;
        loop {
            let frame = job.next_frame().await;
            let done = frame.body.is_exit();
            job.ack(1, frame.seq, 1 << 20).await;
            frames.push(frame);
            if done {
                break;
            }
        }
        let zeros = vec![0u8; 200 * 4096];
        assert_eq!(reassemble(&frames, Channel::Stdout), zeros);
        let (exit_seq, exit) = job.wait_exit().await;
        assert_eq!(exit.outcome, JobOutcome::Exited { exit_code: 0 });
        assert_eq!(exit.stdout.total_bytes, 819_200);
        assert_eq!(exit.stdout.digest, blake3::hash(&zeros));
        assert_eq!(lines(&progress_path), 200);
        job.final_ack(1, exit_seq.unwrap(), 1 << 20).await;
        job.join().await;
    }

    #[tokio::test]
    async fn throttled_pump_still_services_cancel_and_ack_releases_queued_exit() {
        let mut job = job("while :; do head -c 4096 /dev/zero; done")
            .frame_bytes(4096)
            .start();
        job.attach(1, 0, 4096).await;

        let first = job.next_frame().await;
        assert_eq!(data_total(std::slice::from_ref(&first)), 4096);
        job.no_frame_for(Duration::from_millis(200)).await;

        // The mailbox must stay serviced while reads are gated shut.
        job.send(JobCommand::Cancel).await;
        let (exit_seq, exit) = job.wait_exit().await;
        assert_eq!(exit.outcome, JobOutcome::Cancelled);
        let exit_seq = exit_seq.expect("exit frame retained");

        // The window is still exhausted, so the post-kill drain and the Exit
        // frame are retained-unsent; the next ack replays them in order.
        let mut frames = vec![first];
        job.ack(1, 1, 1 << 20).await;
        frames.extend(job.collect_until_exit().await);
        assert_eq!(frames.last().expect("exit").seq, exit_seq);
        assert_consecutive_from_one(&frames);

        job.final_ack(1, exit_seq, 1 << 20).await;
        job.join().await;
    }

    #[tokio::test(start_paused = true)]
    async fn progress_frames_flow_while_the_data_window_is_exhausted() {
        // 4 KiB fills the window exactly; the child then stays alive quietly.
        let mut job = job("head -c 4096 /dev/zero; sleep 300")
            .frame_bytes(4096)
            .paused()
            .start();
        job.attach(1, 0, 4096).await;

        // Under a paused clock, ticks may interleave before/around the real
        // child output — accumulate until the full 4096 data bytes arrived.
        let mut last_seq = 0;
        let mut data_bytes = 0usize;
        while data_bytes < 4096 {
            let frame = job.next_frame().await;
            last_seq = frame.seq;
            match &frame.body {
                FrameBody::Data { bytes, .. } => data_bytes += bytes.len(),
                body => assert_eq!(*body, FrameBody::Progress),
            }
        }
        assert_eq!(data_bytes, 4096);

        // The window is now exhausted (4096 unacked = window). Data cannot
        // move, but Progress keeps flowing — the M1 healing channel.
        for _ in 0..2 {
            let frame = job.next_frame().await;
            assert_eq!(
                frame.body,
                FrameBody::Progress,
                "credit-free progress must flow while throttled"
            );
            assert_eq!(frame.seq, last_seq + 1, "progress consumes a seq");
            last_seq = frame.seq;
        }

        job.send(JobCommand::Cancel).await;
        let (exit_seq, exit) = job.wait_exit().await;
        assert_eq!(exit.outcome, JobOutcome::Cancelled);
        assert_eq!(exit.stdout.total_bytes, 4096);
        job.final_ack(1, exit_seq.expect("retained"), 1 << 20).await;
        job.join().await;
    }

    #[tokio::test(start_paused = true)]
    async fn deadline_kills_the_child_and_exits_timed_out() {
        let mut job = job("sleep 60")
            .deadline_after(Duration::from_secs(2))
            .paused()
            .start();
        job.attach(1, 0, 1 << 20).await;

        let (exit_seq, exit) = job.wait_exit().await;
        assert_eq!(exit.outcome, JobOutcome::TimedOut);
        assert!(
            exit.duration_ms >= 2000,
            "the deadline is absolute: {}ms",
            exit.duration_ms
        );
        let frames = job.collect_until_exit().await;
        assert_eq!(frames.last().map(|f| f.seq), exit_seq);
        job.final_ack(1, exit_seq.expect("retained"), 1 << 20).await;
        job.join().await;
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_kills_the_child_and_exits_cancelled() {
        let mut job = job("sleep 60").paused().start();
        job.attach(1, 0, 1 << 20).await;
        job.send(JobCommand::Cancel).await;

        let (exit_seq, exit) = job.wait_exit().await;
        assert_eq!(exit.outcome, JobOutcome::Cancelled);
        let frames = job.collect_until_exit().await;
        assert_eq!(frames.last().map(|f| f.seq), exit_seq);
        job.final_ack(1, exit_seq.expect("retained"), 1 << 20).await;
        job.join().await;
    }

    #[tokio::test]
    async fn stale_generation_acks_and_attaches_are_ignored_end_to_end() {
        let mut job = job("while :; do head -c 4096 /dev/zero; done")
            .frame_bytes(4096)
            .start();

        // The current consumer is generation 2 with a one-frame window.
        job.attach(2, 0, 4096).await;
        let first = job.next_frame().await;
        assert_eq!(first.seq, 1);
        job.no_frame_for(Duration::from_millis(150)).await;

        // A zombie generation-1 consumer acks with a huge grant: STRICT
        // fencing refuses it wholesale (design-review ruling 2026-07-10) —
        // no credit, no retention-floor movement, no catch-up. The pump
        // stays throttled.
        job.ack(1, 1, 1 << 20).await;
        job.no_frame_for(Duration::from_millis(250)).await;

        // A zombie re-attach is refused: no replay burst.
        job.attach(1, 0, 1 << 20).await;
        job.no_frame_for(Duration::from_millis(250)).await;

        // THE LOSS-PROOF PIN: the zombie ack moved NO retention floor — a
        // current-generation re-attach from 0 replays frame 1 byte-intact.
        job.attach(2, 0, 4096).await;
        let replayed = job.next_frame().await;
        assert_eq!(replayed.seq, 1, "zombie ack freed nothing; frame 1 replays");
        assert_eq!(replayed, first, "replay is byte-identical");
        job.no_frame_for(Duration::from_millis(150)).await; // window full again

        // The current generation's ack resumes the flow.
        job.ack(2, 1, 1 << 20).await;
        let resumed = job.next_frame().await;
        assert_eq!(resumed.seq, 2, "live flow resumed for the owning consumer");

        job.send(JobCommand::Cancel).await;
        let (exit_seq, exit) = job.wait_exit().await;
        assert_eq!(exit.outcome, JobOutcome::Cancelled);
        job.final_ack(2, exit_seq.expect("retained"), 1 << 20).await;
        job.join().await;
    }

    #[tokio::test]
    async fn attach_replay_respects_the_window_and_resumes_on_credit() {
        // Run to completion fully detached: retention holds data seqs 1..=10
        // (1 KiB each) plus the Exit frame at seq 11.
        let mut job = job("i=0; while [ $i -lt 10 ]; do head -c 1024 /dev/zero; i=$((i+1)); done")
            .frame_bytes(1024)
            .start();
        let (exit_seq, _) = job.wait_exit().await;
        assert_eq!(exit_seq, Some(11));

        // A 3 KiB window admits exactly three replay frames; the pending-send
        // cursor holds the rest without buffering.
        job.attach(1, 0, 3 * 1024).await;
        for expected_seq in 1..=3 {
            assert_eq!(job.next_frame().await.seq, expected_seq);
        }
        job.no_frame_for(Duration::from_millis(200)).await;

        // Each cumulative ack resumes the replay exactly where it held.
        for (acked, batch) in [(3u64, 4..=6), (6, 7..=9)] {
            job.ack(1, acked, 3 * 1024).await;
            for expected_seq in batch {
                assert_eq!(job.next_frame().await.seq, expected_seq);
            }
            job.no_frame_for(Duration::from_millis(150)).await;
        }
        job.ack(1, 9, 3 * 1024).await;
        assert_eq!(job.next_frame().await.seq, 10);
        let exit_frame = job.next_frame().await;
        assert!(exit_frame.body.is_exit(), "small Exit fits the last window");
        assert_eq!(exit_frame.seq, 11);

        job.final_ack(1, 11, 3 * 1024).await;
        job.join().await;
    }

    #[tokio::test]
    async fn retention_overflow_terminates_with_a_typed_exit() {
        // Retention is RECORD-denominated (payload + RECORD_OVERHEAD_BYTES per
        // frame, exported): size the memory cap for EXACTLY four 1 KiB data
        // frames, spooling disabled. The consumer grants credit far beyond
        // retention while never acking, so reads outrun frees — the typed
        // OP_OVERFLOW path; an oversized Exit payload pins the exit-not-
        // retainable edge on top.
        use opengeni_agent_engine::retention::RECORD_OVERHEAD_BYTES;
        let frame_cost = 1024 + RECORD_OVERHEAD_BYTES;
        let memory_max = usize::try_from(4 * frame_cost).expect("fits");
        let mut job = job("while :; do head -c 1024 /dev/zero; done")
            .frame_bytes(1024)
            .retention(RetentionConfig {
                memory_max_bytes: memory_max,
                memory_max_frames: 64,
                spool_max_bytes: 0,
                spool_segment_bytes: 4096,
            })
            .exit_payload(8192)
            .start();
        job.attach(1, 0, 1 << 20).await;

        let (exit_seq, exit) = job.wait_exit().await;
        match exit.outcome {
            JobOutcome::Failed(JobFailure::Overflow { retained_bytes }) => {
                assert_eq!(
                    retained_bytes,
                    5 * frame_cost,
                    "the exact refused-append counter, record-denominated"
                );
            }
            other => panic!("expected typed overflow, got {other:?}"),
        }
        assert_eq!(
            exit_seq, None,
            "retention is exhausted, so even the Exit frame cannot be retained"
        );

        // Exactly the four retainable frames were emitted, in order; nothing
        // follows the typed death.
        for expected_seq in 1..=4 {
            assert_eq!(job.next_frame().await.seq, expected_seq);
        }
        job.no_frame_for(Duration::from_millis(150)).await;

        // The result is still collectable/finishable: a final ack at the
        // fence (= high watermark, since the exit frame was unretainable)
        // ends the task.
        job.final_ack(1, 4, 1 << 20).await;
        job.join().await;
    }

    #[tokio::test]
    async fn dropping_the_mailbox_cancels_a_running_job() {
        let mut job = job("sleep 60").start();
        job.commands = None; // the supervisor abandons the op
        let (_, exit) = job.wait_exit().await;
        assert_eq!(exit.outcome, JobOutcome::Cancelled);
        job.join().await;
    }

    #[tokio::test]
    async fn overshoot_frame_closes_the_read_gate_end_to_end() {
        // Window 1536, frames <= 1024: frame 1 (1024) sends; frame 2 cannot
        // (allowance 512) and is retained UNSENT — the pump is now behind.
        // The read gate must CLOSE (caught-up requirement): the producer's
        // progress file plateaus, and retention never grows past the
        // overshoot frame. Credit + catch-up then resume everything.
        let mut job = job(
            "i=0; while [ $i -lt 200 ]; do head -c 1024 /dev/zero;              echo $i >> progress.txt; i=$((i+1)); done",
        )
        .frame_bytes(1024)
        .start();
        let progress_path = job.dir.path().join("progress.txt");
        let lines =
            |path: &std::path::Path| std::fs::read_to_string(path).map_or(0, |s| s.lines().count());

        job.attach(1, 0, 1536).await;
        let first = job.next_frame().await;
        assert_eq!(first.body.payload_len(), 1024);
        job.no_frame_for(Duration::from_millis(200)).await;

        // Gate closed: the producer parks (pipe full) despite allowance 512.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let parked_at = lines(&progress_path);
        assert!(
            parked_at < 200,
            "producer must be far from done: {parked_at}"
        );
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(
            lines(&progress_path),
            parked_at,
            "the overshoot frame must close the read gate (E3 regression)"
        );

        // Credit resumes: catch-up sends the retained overshoot frame first,
        // then the stream completes in order.
        let mut frames = vec![first];
        job.ack(1, 1, 1 << 20).await;
        loop {
            let frame = job.next_frame().await;
            let done = frame.body.is_exit();
            job.ack(1, frame.seq, 1 << 20).await;
            frames.push(frame);
            if done {
                break;
            }
        }
        assert_consecutive_from_one(&frames);
        let zeros = vec![0u8; 200 * 1024];
        assert_eq!(reassemble(&frames, Channel::Stdout), zeros);
        let (exit_seq, exit) = job.wait_exit().await;
        assert_eq!(exit.stdout.digest, blake3::hash(&zeros));
        job.final_ack(1, exit_seq.expect("retained"), 1 << 20).await;
        job.join().await;
    }

    #[tokio::test]
    async fn final_ack_below_the_exit_frame_is_refused_as_final() {
        // PROTOCOL v1.1: `final=true` is honored only with acked_seq >=
        // exit_seq — a "final" that does not cover the terminal frame proves
        // the consumer has NOT consumed the result; it applies as a plain
        // ack (loudly) and the pump keeps lingering.
        let mut job = job("printf fenced").start();
        let (exit_seq, _) = job.wait_exit().await;
        let exit_seq = exit_seq.expect("retained"); // data 1, exit 2
        assert_eq!(exit_seq, 2);

        job.attach(1, 0, 1 << 20).await;
        let _ = job.collect_until_exit().await;

        // A final that only covers the data frame: refused as final.
        job.final_ack(1, exit_seq - 1, 1 << 20).await;
        // The pump must still be alive and serving (replay works).
        job.attach(1, 0, 1 << 20).await;
        let replay = job.collect_until_exit().await;
        assert_eq!(replay.last().expect("exit").seq, exit_seq);

        // A final at the fence ends the task.
        job.final_ack(1, exit_seq, 1 << 20).await;
        job.join().await;
    }

    #[tokio::test]
    async fn post_exit_replay_failure_is_surfaced_typed_not_swallowed() {
        // Force the retained frames onto the disk spool, complete the op,
        // then destroy the spool behind the pump's back: the terminal record
        // must survive, the collection failure must surface TYPED through the
        // shared slot, and the op must still be finishable by a final ack at
        // the fence (the consumer takes the record via status, not frames).
        let mut job = job("head -c 4096 /dev/zero")
            .frame_bytes(1024)
            .retention(RetentionConfig {
                memory_max_bytes: 128, // spill immediately
                memory_max_frames: 2,
                spool_max_bytes: 1024 * 1024,
                spool_segment_bytes: 4096,
            })
            .start();
        let (exit_seq, exit) = job.wait_exit().await;
        assert_eq!(exit.outcome, JobOutcome::Exited { exit_code: 0 });
        let exit_seq = exit_seq.expect("retained");

        // Destroy the spool segments out from under the retention log.
        std::fs::remove_dir_all(job.dir.path().join("spool")).expect("spool dir exists");

        // Attach: the replay read hits the missing segments.
        job.attach(1, 0, 1 << 20).await;
        for _ in 0..200 {
            if job.collection_failure.get().is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        match job.collection_failure.get() {
            Some(JobFailure::SpoolIo { .. }) => {}
            other => panic!("expected a typed SpoolIo collection failure, got {other:?}"),
        }

        // The op remains finishable: a final ack at the fence ends the task.
        job.final_ack(1, exit_seq, 1 << 20).await;
        job.join().await;
    }

    #[tokio::test(start_paused = true)]
    async fn detached_progress_ticks_are_retained_with_uniform_seqs() {
        let mut job = job("sleep 300").paused().start();

        // No consumer ever attaches; two 5s silences pass.
        tokio::time::sleep(Duration::from_secs(12)).await;
        job.send(JobCommand::Cancel).await;

        let (exit_seq, exit) = job.wait_exit().await;
        assert_eq!(exit.outcome, JobOutcome::Cancelled);
        let exit_seq = exit_seq.expect("retained");
        assert!(
            exit_seq >= 3,
            "at least two progress ticks precede the exit"
        );

        // A late consumer sees the full uniform sequence: progress frames
        // consumed seqs while detached, so gap detection has no blind spots.
        job.attach(1, 0, 1 << 20).await;
        let frames = job.collect_until_exit().await;
        assert_consecutive_from_one(&frames);
        assert_eq!(frames.last().expect("exit").seq, exit_seq);
        for frame in &frames[..frames.len() - 1] {
            assert_eq!(frame.body, FrameBody::Progress);
        }

        job.final_ack(1, exit_seq, 1 << 20).await;
        job.join().await;
    }
}
