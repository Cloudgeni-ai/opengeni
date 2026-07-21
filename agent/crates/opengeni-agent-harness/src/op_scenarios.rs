//! Engine-era op-stream scenarios (the engine scenario contract E1–E10 + E12).
//!
//! The harness plays the SERVER: `OpStart`/`OpCancel`/`OpQuery`/`OpAttach` on
//! the rpc subject, frame collection off the per-op subject (subscribed
//! BEFORE OpStart), cumulative `OpAck`s on the ack subject. Every scenario is
//! deterministic (fixed byte counts, measured stalls — never sleep-and-hope
//! where an event can be awaited) and emits the standard JSON + verdicts.
//!
//! E11 (fs_write/WriteChunk atomicity) ships with the M7 milestone in the
//! next PR — the runner answers those kinds typed-Unsupported today.

use std::sync::Arc;
use std::time::{Duration, Instant};

use opengeni_agent_proto::v1::{self, OpChannel, OpLostReason, OpState};
use serde_json::json;

use crate::agent::DisposableAgent;
use crate::driver::{Op, OpClass};
use crate::opstream::{grant_all_acks, OpCollector, OpDriver, OpReply};
use crate::report::{Aggregator, ResourceSampler, Verdict};
use crate::scenario::{pgrep_alive, unique_marker, Harness};

/// A generous credit figure (absolute window replacement) for GrantAll flows.
const BIG_CREDIT: u64 = 64 * 1024 * 1024;

impl Harness {
    /// The op driver + a fresh collector for one op on the primary agent.
    async fn op_rig(&self, op_id: &str) -> Result<(OpDriver, Arc<OpCollector>), String> {
        let driver = OpDriver::new(self.driver.raw_client(), self.agents[0].agent_id());
        let collector = Arc::new(
            OpCollector::attach(&self.driver.raw_client(), self.agents[0].agent_id(), op_id)
                .await?,
        );
        Ok((driver, collector))
    }

    /// Byte-exact assembly verdicts shared by most scenarios: no seq gap, the
    /// recomputed channel digests equal the Exit frame's, totals match.
    fn assembly_verdicts(collector: &OpCollector, exit: &v1::OpExit) -> Vec<Verdict> {
        let stdout_digest = collector.channel_digest(OpChannel::Stdout);
        let stdout_len = collector.channel_bytes(OpChannel::Stdout).len() as u64;
        vec![
            Verdict {
                check: "no seq gaps (contiguous delivery)".to_string(),
                pass: collector.missing_seqs().is_empty(),
                detail: format!("missing={:?}", collector.missing_seqs()),
            },
            Verdict {
                check: "stdout digest byte-exact vs Exit".to_string(),
                pass: Some(&stdout_digest) == exit.digests.get("stdout"),
                detail: format!(
                    "reassembled={} exit={:?}",
                    &stdout_digest[..16.min(stdout_digest.len())],
                    exit.digests.get("stdout").map(|d| &d[..16])
                ),
            },
            Verdict {
                check: "stdout totals match Exit".to_string(),
                pass: Some(&stdout_len) == exit.totals.get("stdout"),
                detail: format!(
                    "reassembled={stdout_len} exit={:?}",
                    exit.totals.get("stdout")
                ),
            },
        ]
    }

    // ---- E1: op-baseline -------------------------------------------------

    /// E1 — the happy-path reference: fixed stdout+stderr, GrantAll credit,
    /// byte-exact assembly, one clean Exit, `next_seq` agreement.
    pub async fn op_baseline(&self) -> crate::report::Report {
        let op_id = "e1-baseline";
        let (driver, collector) = self.op_rig(op_id).await.expect("op rig");
        // 256 KiB stdout of 'a' + 64 KiB stderr of 'b', deterministic.
        let command = "head -c 262144 /dev/zero | tr '\\0' 'a'; \
                       head -c 65536 /dev/zero | tr '\\0' 'b' 1>&2";
        let acker = grant_all_acks(
            driver.clone(),
            collector.clone(),
            op_id.to_string(),
            1,
            BIG_CREDIT,
        );

        let started = driver
            .start_exec(op_id, command, 0, 0)
            .await
            .expect("op start");
        let accepted = matches!(&started, OpReply::Started(s) if s.accepted);

        let exit = collector
            .wait_for_exit(Duration::from_secs(20))
            .await
            .expect("exit frame");
        acker.abort();
        let _ = driver.ack(op_id, exit.0, BIG_CREDIT, 1, true).await;

        let query = driver.query(op_id).await.expect("query");
        let status = query.status().clone();
        let stderr_digest = collector.channel_digest(OpChannel::Stderr);

        let mut verdicts = vec![
            Verdict {
                check: "OpStart accepted".to_string(),
                pass: accepted,
                detail: format!("{started:?}"),
            },
            Verdict {
                check: "exactly one clean Exit (code 0, no flags)".to_string(),
                pass: exit.1.exit_code == 0
                    && !exit.1.timed_out
                    && !exit.1.cancelled
                    && exit.1.failure_code.is_empty(),
                detail: format!("{:?}", exit.1),
            },
            Verdict {
                check: "stderr digest byte-exact vs Exit".to_string(),
                pass: Some(&stderr_digest) == exit.1.digests.get("stderr"),
                detail: format!(
                    "stderr bytes={}",
                    collector.channel_bytes(OpChannel::Stderr).len()
                ),
            },
            Verdict {
                check: "final OpQuery next_seq == exit seq + 1".to_string(),
                pass: status.next_seq == exit.0 + 1 && status.state == OpState::Complete as i32,
                detail: format!("next_seq={} exit_seq={}", status.next_seq, exit.0),
            },
        ];
        verdicts.extend(Self::assembly_verdicts(&collector, &exit.1));
        let verdicts = self.assertable(verdicts);
        self.finish(
            "op-baseline",
            json!({"stdout_bytes": 262_144, "stderr_bytes": 65_536}),
            Aggregator::new(),
            Vec::new(),
            verdicts,
        )
    }

    // ---- E2: ack-loss healing (M1) ----------------------------------------

    /// E2 — fill the window, DROP one ack, heal via the Progress-triggered
    /// re-ack: the child unblocks within one ack interval, zero byte loss.
    pub async fn op_ack_loss(&self) -> crate::report::Report {
        let op_id = "e2-ack-loss";
        let (driver, collector) = self.op_rig(op_id).await.expect("op rig");
        // 4 MiB total, window = one frame (clamped): several frames, each
        // needing an ack to move on.
        let command = "head -c 4194304 /dev/zero | tr '\\0' 'x'";
        let started = driver
            .start_exec(op_id, command, 1, 0)
            .await
            .expect("start");
        assert!(matches!(&started, OpReply::Started(s) if s.accepted));

        // Ack frame-by-frame with a ONE-FRAME credit (the absolute window
        // replacement must keep gating per frame), but SILENTLY DROP the ack
        // for the 2nd data frame — the M1 chaos injection.
        let frame_credit = u64::try_from(self.driver.max_payload()).unwrap_or(u64::MAX);
        let mut acked = 0u64;
        let mut dropped_at: Option<u64> = None;
        let stall_started;
        loop {
            let hi = collector.highest_data_seq();
            if hi > acked {
                if dropped_at.is_none() && acked > 0 {
                    // This ack is the one we "lose".
                    dropped_at = Some(hi);
                    stall_started = Instant::now();
                    break;
                }
                acked = hi;
                let _ = driver.ack(op_id, acked, frame_credit, 1, false).await;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let dropped_at = dropped_at.expect("drop point chosen");

        // With no further acks the stream must run into the window edge and
        // STALL: data stops growing, and the unacked payload (above the last
        // acked seq) never exceeds the granted window.
        let mut watermark = collector.highest_data_seq();
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let now_hi = collector.highest_data_seq();
            if now_hi == watermark {
                break;
            }
            watermark = now_hi;
        }
        let unacked = collector.data_payload_above(acked);
        let stalled_bounded = unacked <= frame_credit;

        // M1 gives the server two healing legs: (a) re-ack on a received
        // Progress frame, (b) re-ack on a 5s timer while credit is
        // outstanding. Which cue fires depends on whether the pump stalled
        // CAUGHT-UP (progress flows credit-free) or BEHIND by one retained-
        // unsent frame (progress queues in seq order; the timer leg heals).
        // Model the real server: wait one ack interval for the progress cue,
        // then re-ack either way.
        let progress_before = collector.progress_count();
        let progress_cue = collector
            .wait_until(Duration::from_millis(5500), |c| {
                c.progress_count() > progress_before
            })
            .await;

        let reack_at = Instant::now();
        let _ = driver.ack(op_id, watermark, frame_credit, 1, false).await;
        let resumed = collector
            .wait_until(Duration::from_secs(5), |c| {
                c.first_arrival_above(watermark).is_some()
            })
            .await;
        let heal_latency = collector
            .first_arrival_above(watermark)
            .map(|at| at.saturating_duration_since(reack_at));

        // Drain the rest with GrantAll and verify byte-exact completion.
        let drain_policy = grant_all_acks(
            driver.clone(),
            collector.clone(),
            op_id.to_string(),
            1,
            BIG_CREDIT,
        );
        let exit = collector
            .wait_for_exit(Duration::from_secs(30))
            .await
            .expect("exit");
        drain_policy.abort();
        let _ = driver.ack(op_id, exit.0, BIG_CREDIT, 1, true).await;

        let stall_span = stall_started.elapsed();
        let mut verdicts = vec![
            Verdict {
                check: "stream stalled at the window edge while the ack was withheld".to_string(),
                pass: stalled_bounded,
                detail: format!("unacked={unacked} <= window={frame_credit} (stalled at seq {watermark}, drop after {dropped_at})"),
            },
            Verdict {
                check: "the repeated cumulative ack healed the stall within one interval"
                    .to_string(),
                pass: resumed && heal_latency.is_some_and(|d| d < Duration::from_secs(5)),
                detail: format!(
                    "cue={} heal_latency={heal_latency:?} total_stall={stall_span:?}",
                    if progress_cue { "progress(leg a)" } else { "5s timer(leg b)" }
                ),
            },
            Verdict {
                check: "zero byte loss (4 MiB reassembled)".to_string(),
                pass: collector.channel_bytes(OpChannel::Stdout).len() == 4_194_304,
                detail: format!("bytes={}", collector.channel_bytes(OpChannel::Stdout).len()),
            },
        ];
        verdicts.extend(Self::assembly_verdicts(&collector, &exit.1));
        let verdicts = self.assertable(verdicts);
        self.finish(
            "op-ack-loss",
            json!({"total_bytes": 4_194_304, "dropped_ack_after_seq": dropped_at}),
            Aggregator::new(),
            Vec::new(),
            verdicts,
        )
    }

    // ---- E3: connected-stall / credit window (M2 send-credit, #3, #4) -----

    /// E3 — yes-spam under a one-frame window with NO further credit: sent
    /// bytes never exceed the window, RSS stays bounded over a 30s hold,
    /// liveness isolation holds, credit resumes the flow, cancel ends it.
    #[allow(clippy::too_many_lines)] // one linear stall/hold/resume story
    pub async fn op_connected_stall(&self) -> crate::report::Report {
        let op_id = "e3-stall";
        let (driver, collector) = self.op_rig(op_id).await.expect("op rig");
        let sampler = ResourceSampler::spawn(
            self.primary().pid(),
            Instant::now(),
            Duration::from_millis(250),
        );
        let command = "while :; do head -c 65536 /dev/zero; done";
        let started = driver
            .start_exec(op_id, command, 1, 0)
            .await
            .expect("start");
        let OpReply::Started(started) = started else {
            panic!("expected OpStarted")
        };
        assert!(started.accepted);

        // Wait for the initial window to fill, then hold 30s with no credit.
        let filled = collector
            .wait_until(Duration::from_secs(10), |c| c.data_payload_total() > 0)
            .await;
        tokio::time::sleep(Duration::from_secs(2)).await; // settle at the window edge
        let sent_at_stall = collector.data_payload_total();

        // Liveness probe DURING the stall hold.
        let subject = self.primary().rpc_subject();
        let mut probe = Aggregator::new();
        let hold_until = Instant::now() + Duration::from_secs(30);
        while Instant::now() < hold_until {
            let outcome = self
                .driver
                .execute(&subject, Op::Ping, Duration::from_secs(2))
                .await;
            probe.record(&outcome);
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let sent_after_hold = collector.data_payload_total();
        let ping = probe.stats("ping");

        // Credit returns in one increment: the flow must resume in order.
        let _ = driver
            .ack(op_id, collector.highest_data_seq(), BIG_CREDIT, 1, false)
            .await;
        let resumed = collector
            .wait_until(Duration::from_secs(5), |c| {
                c.data_payload_total() > sent_after_hold
            })
            .await;

        // Cancel the infinite producer; drain under acks so the post-kill
        // pipe contents and the queued Exit frame flush through the window.
        let _ = driver.cancel(op_id).await.expect("cancel");
        let drain_policy = grant_all_acks(
            driver.clone(),
            collector.clone(),
            op_id.to_string(),
            1,
            BIG_CREDIT,
        );
        let exit = collector
            .wait_for_exit(Duration::from_secs(15))
            .await
            .expect("exit");
        drain_policy.abort();
        let _ = driver.ack(op_id, exit.0, BIG_CREDIT, 1, true).await;

        let resources = sampler.finish();
        let rss_first = resources.first().map_or(0, |s| s.rss_bytes);
        let rss_max = resources.iter().map(|s| s.rss_bytes).max().unwrap_or(0);
        let window = u64::try_from(self.driver.max_payload()).unwrap_or(u64::MAX); // >= frame floor
        let max_gap = self
            .collector
            .gaps_ms()
            .values()
            .flatten()
            .copied()
            .max()
            .unwrap_or(0);

        let verdicts = self.assertable(vec![
            Verdict {
                check: "unacked sent bytes never exceed the window".to_string(),
                pass: filled && sent_at_stall <= window && sent_after_hold == sent_at_stall,
                detail: format!(
                    "sent_at_stall={sent_at_stall} after_hold={sent_after_hold} window~={window}"
                ),
            },
            Verdict {
                check: "runner RSS bounded by window + margin over the 30s hold".to_string(),
                pass: rss_max.saturating_sub(rss_first) <= window + 128 * 1024 * 1024,
                detail: format!("rss_first={rss_first} rss_max={rss_max}"),
            },
            Verdict {
                check: "ping p99 < 100ms during the stall (liveness isolation)".to_string(),
                pass: ping.as_ref().is_some_and(|s| s.p99 < 100_000),
                detail: ping.map_or_else(|| "no pings".to_string(), |s| format!("p99={}us", s.p99)),
            },
            Verdict {
                check: "no heartbeat gap > 7.5s during the stall".to_string(),
                pass: max_gap <= 7500,
                detail: format!("max_gap={max_gap}ms"),
            },
            Verdict {
                check: "credit resumes the flow; cancel yields a typed exit".to_string(),
                pass: resumed && exit.1.cancelled,
                detail: format!("resumed={resumed} exit={:?}", exit.1),
            },
        ]);
        self.finish(
            "op-connected-stall",
            json!({"window_bytes": window, "hold_secs": 30}),
            probe,
            resources,
            verdicts,
        )
    }

    // ---- E4: detached accumulation (M2 retention, #3) ----------------------

    /// E4 — a nats restart detaches the runner mid-stream: (a) with modest
    /// quotas the op accumulates into ring→spool and replays byte-exact on
    /// re-attach; (b) with tiny quotas + permanent detach it dies TYPED
    /// (OP_OVERFLOW), never silently. Runs against a dedicated agent with
    /// override-shrunk retention.
    #[allow(clippy::too_many_lines)] // two sub-cases of one linear chaos story
    pub async fn op_detached_accumulation(&mut self) -> crate::report::Report {
        // --- (a) bounded accumulation + byte-exact replay ---
        let agent_a = self
            .spawn_override_agent(
                90,
                "retention_memory_max_bytes=2097152,retention_spool_max_bytes=8388608",
            )
            .await
            .expect("override agent");
        let op_id = "e4-accumulate";
        let driver = OpDriver::new(self.driver.raw_client(), agent_a.agent_id());
        let collector = Arc::new(
            OpCollector::attach(&self.driver.raw_client(), agent_a.agent_id(), op_id)
                .await
                .expect("collector"),
        );
        // A bounded, PACED producer: 96 x 64 KiB (= 6 MiB) over ~5s, so the
        // detach lands mid-stream and the bulk of the output accumulates
        // detached; the total fits ring+spool (2+8 MiB), so the op COMPLETES
        // while detached.
        let command = "i=0; while [ $i -lt 96 ]; do head -c 65536 /dev/zero | tr '\\0' 'd'; \
                       sleep 0.05; i=$((i+1)); done";
        let acker = grant_all_acks(
            driver.clone(),
            collector.clone(),
            op_id.to_string(),
            1,
            BIG_CREDIT,
        );
        let started = driver
            .start_exec(op_id, command, 0, 0)
            .await
            .expect("start");
        assert!(matches!(&started, OpReply::Started(s) if s.accepted));
        // Let a little flow, then cut the wire (detach = the runner's own
        // connection loss).
        collector
            .wait_until(Duration::from_secs(10), |c| c.data_payload_total() > 0)
            .await;
        acker.abort();
        let restart_at = self.nats.restart().await.expect("nats restart");
        // Give the runner time to finish the op DETACHED (it keeps draining
        // into ring→spool; the producer completes well under the quotas).
        tokio::time::sleep(Duration::from_secs(7)).await;
        let spool_dir = agent_a.config_dir_path().join("spool");
        let spooled_bytes = dir_bytes(&spool_dir);

        // Reconnect happens on the runner's own backoff; re-attach and
        // collect EVERYTHING from 0 under a fresh generation.
        let attach_ok = wait_for_attach(&driver, op_id, 2).await;
        let acker = grant_all_acks(
            driver.clone(),
            collector.clone(),
            op_id.to_string(),
            2,
            BIG_CREDIT,
        );
        let exit = collector
            .wait_for_exit(Duration::from_secs(30))
            .await
            .expect("exit collected after re-attach");
        acker.abort();
        let _ = driver.ack(op_id, exit.0, BIG_CREDIT, 2, true).await;
        let replay_exact = collector.channel_bytes(OpChannel::Stdout).len() == 6_291_456
            && collector.missing_seqs().is_empty()
            && Some(&collector.channel_digest(OpChannel::Stdout)) == exit.1.digests.get("stdout");

        // --- (b) detached quota exhaustion PARKS the child, resumable ---
        // Ruling M2: at the quotas the runner stops reading — the child pipe-
        // blocks (never OOM, never truncation) and the op stays RUNNING and
        // resumable. (The typed OP_OVERFLOW path fires when an APPEND exceeds
        // quota — reachable when an attached consumer's credit outruns its
        // acks; pinned at unit level in the pump suite. Detached reads reserve
        // one frame of headroom by construction, so they park instead.)
        let agent_b = self
            .spawn_override_agent(
                91,
                "retention_memory_max_bytes=262144,retention_spool_max_bytes=4194304",
            )
            .await
            .expect("override agent b");
        let op_b = "e4-park";
        let driver_b = OpDriver::new(self.driver.raw_client(), agent_b.agent_id());
        let collector_b = Arc::new(
            OpCollector::attach(&self.driver.raw_client(), agent_b.agent_id(), op_b)
                .await
                .expect("collector b"),
        );
        let acker_b = grant_all_acks(
            driver_b.clone(),
            collector_b.clone(),
            op_b.to_string(),
            1,
            BIG_CREDIT,
        );
        let started_b = driver_b
            .start_exec(op_b, "while :; do head -c 65536 /dev/zero; done", 0, 0)
            .await
            .expect("start b");
        assert!(matches!(&started_b, OpReply::Started(s) if s.accepted));
        collector_b
            .wait_until(Duration::from_secs(10), |c| c.data_payload_total() > 0)
            .await;
        acker_b.abort();
        let _ = self.nats.restart().await.expect("nats restart b");
        // Detached, the hostile producer fills the quotas, then PARKS.
        tokio::time::sleep(Duration::from_secs(5)).await;
        let spool_b = dir_bytes(&agent_b.config_dir_path().join("spool"));
        let spool_bounded = spool_b <= 4_194_304 + 65_536;
        // Still RUNNING (parked), never a silent death.
        let parked_running = wait_for_query(&driver_b, op_b, Duration::from_secs(15), |status| {
            status.state == OpState::Running as i32
        })
        .await;
        // And RESUMABLE: re-attach + acks free retention; the stream moves.
        let resumed_after_park = {
            let attach_ok = wait_for_attach(&driver_b, op_b, 2).await;
            let drain = grant_all_acks(
                driver_b.clone(),
                collector_b.clone(),
                op_b.to_string(),
                2,
                BIG_CREDIT,
            );
            let before = collector_b.data_payload_total();
            let moved = collector_b
                .wait_until(Duration::from_secs(10), |c| c.data_payload_total() > before)
                .await;
            drain.abort();
            let _ = driver_b.cancel(op_b).await;
            attach_ok && moved
        };

        let verdicts = self.assertable(vec![
            Verdict {
                check: "(a) detached op completed and spilled to the disk spool".to_string(),
                pass: spooled_bytes > 0,
                detail: format!("spool bytes on disk during detach: {spooled_bytes}"),
            },
            Verdict {
                check: "(a) re-attach replays the full stream byte-exact".to_string(),
                pass: attach_ok && replay_exact,
                detail: format!(
                    "bytes={} missing={:?}",
                    collector.channel_bytes(OpChannel::Stdout).len(),
                    collector.missing_seqs()
                ),
            },
            Verdict {
                check: "(b) detached quota exhaustion PARKS the child, bounded + resumable"
                    .to_string(),
                pass: spool_bounded && parked_running && resumed_after_park,
                detail: format!(
                    "spool={spool_b} (quota 4194304), running={parked_running}, resumed={resumed_after_park}"
                ),
            },
        ]);
        let restart_note = format!("{:?}", restart_at.elapsed());
        drop(agent_a);
        drop(agent_b);
        self.finish(
            "op-detached-accumulation",
            json!({"bounded_bytes": 6_291_456, "quotas_a": "2MiB+8MiB", "quotas_b": "256KiB+512KiB", "elapsed_since_restart": restart_note}),
            Aggregator::new(),
            Vec::new(),
            verdicts,
        )
    }

    // ---- E5: dup + out-of-order idempotency (#2, B2) -----------------------

    /// E5 — a duplicate OpStart never re-runs (marker proves one spawn); a
    /// lower/stale ack never regresses the retention floor.
    pub async fn op_dup_idempotency(&self) -> crate::report::Report {
        let op_id = "e5-dup";
        let (driver, collector) = self.op_rig(op_id).await.expect("op rig");
        let work = self.primary().work_dir().to_string_lossy().into_owned();
        let marker = format!("{work}/e5-ran");
        // Runs ~2s so the duplicate lands while RUNNING.
        let command = format!("echo x >> {marker}; sleep 2; printf done");
        let acker = grant_all_acks(
            driver.clone(),
            collector.clone(),
            op_id.to_string(),
            1,
            BIG_CREDIT,
        );
        let first = driver
            .start_exec(op_id, &command, 0, 0)
            .await
            .expect("start");
        assert!(matches!(&first, OpReply::Started(s) if s.accepted));

        // Duplicate while running: acknowledged, not re-run.
        let dup_running = driver.start_exec(op_id, &command, 0, 0).await.expect("dup");
        let dup_running_ok = matches!(&dup_running, OpReply::Started(s)
            if s.accepted && s.status.as_ref().is_some_and(|st| st.state == OpState::Running as i32));

        let exit = collector
            .wait_for_exit(Duration::from_secs(20))
            .await
            .expect("exit");
        acker.abort();

        // Duplicate after completion: still one run, status COMPLETE.
        let dup_done = driver
            .start_exec(op_id, &command, 0, 0)
            .await
            .expect("dup2");
        let dup_done_ok = matches!(&dup_done, OpReply::Started(s)
            if s.accepted && s.status.as_ref().is_some_and(|st| st.state == OpState::Complete as i32));
        let runs = std::fs::read_to_string(&marker).map_or(0, |s| s.lines().count());

        // Out-of-order/lower ack: ack everything (floor = exit seq), then a
        // LOWER ack, then re-attach from 0. If the lower ack had regressed
        // the floor, freed frames would replay; the floor is monotonic, so
        // NOTHING may arrive (everything <= floor is gone, nothing is above).
        let _ = driver.ack(op_id, exit.0, BIG_CREDIT, 1, false).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        let _ = driver
            .ack(op_id, exit.0.saturating_sub(1), BIG_CREDIT, 1, false)
            .await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        let before = collector.arrivals();
        let _ = driver
            .attach(op_id, 0, 2, BIG_CREDIT)
            .await
            .expect("attach");
        tokio::time::sleep(Duration::from_millis(500)).await;
        let after = collector.arrivals();
        let floor_held = after == before;

        let _ = driver.ack(op_id, exit.0, BIG_CREDIT, 2, true).await;
        let verdicts = self.assertable(vec![
            Verdict {
                check: "duplicate OpStart while running attaches (never re-runs)".to_string(),
                pass: dup_running_ok,
                detail: format!("{dup_running:?}"),
            },
            Verdict {
                check: "duplicate OpStart after completion answers COMPLETE".to_string(),
                pass: dup_done_ok,
                detail: format!("{dup_done:?}"),
            },
            Verdict {
                check: "the command ran exactly once".to_string(),
                pass: runs == 1,
                detail: format!("marker lines={runs}"),
            },
            Verdict {
                check: "a lower ack never regresses the floor (no sub-floor replay)".to_string(),
                pass: floor_held,
                detail: format!("arrivals {before}->{after}"),
            },
        ]);
        self.finish(
            "op-dup-idempotency",
            json!({"marker": marker}),
            Aggregator::new(),
            Vec::new(),
            verdicts,
        )
    }

    // ---- E6: attach fan-out / zombie generation (B2, strict ==) ------------

    /// E6 — after generation 2 attaches, a zombie generation-1 ack must move
    /// NOTHING (strict fencing): no credit, no floor, no frames. The live
    /// generation's ack resumes the flow; reassembly stays byte-exact.
    pub async fn op_zombie_generation(&self) -> crate::report::Report {
        let op_id = "e6-zombie";
        let (driver, collector) = self.op_rig(op_id).await.expect("op rig");
        let command = "while :; do head -c 65536 /dev/zero; done";
        // window = one frame; gen-1 acks a couple of frames then goes zombie.
        let started = driver
            .start_exec(op_id, command, 1, 0)
            .await
            .expect("start");
        assert!(matches!(&started, OpReply::Started(s) if s.accepted));

        // Gen-1 consumes two windows' worth (one-frame credit keeps gating).
        let frame_credit = u64::try_from(self.driver.max_payload()).unwrap_or(u64::MAX);
        for _ in 0..2 {
            let hi = collector.highest_data_seq();
            collector
                .wait_until(Duration::from_secs(10), |c| c.highest_data_seq() > hi)
                .await;
            let _ = driver
                .ack(op_id, collector.highest_data_seq(), frame_credit, 1, false)
                .await;
        }
        // The redispatched worker: generation 2 attaches from its floor.
        let from = collector.highest_data_seq();
        let _ = driver.attach(op_id, from, 2, 0).await.expect("gen2 attach");
        collector
            .wait_until(Duration::from_secs(10), |c| c.highest_data_seq() > from)
            .await;
        let stalled_at = collector.highest_data_seq();
        tokio::time::sleep(Duration::from_millis(500)).await; // settle at gen-2's window edge
        let stalled_at = collector.highest_data_seq().max(stalled_at);

        // THE ZOMBIE: a gen-1 ack with a huge grant. Strict fencing: nothing
        // may move.
        let _ = driver.ack(op_id, stalled_at, BIG_CREDIT, 1, false).await;
        tokio::time::sleep(Duration::from_secs(2)).await;
        let zombie_moved_nothing = collector.highest_data_seq() == stalled_at;

        // The live generation's ack resumes the flow.
        let _ = driver.ack(op_id, stalled_at, frame_credit, 2, false).await;
        let resumed = collector
            .wait_until(Duration::from_secs(5), |c| {
                c.highest_data_seq() > stalled_at
            })
            .await;

        // Cancel; the post-kill drain + Exit frame flush under gen-2 acks
        // (the terminal frame queues behind the exhausted window otherwise).
        let _ = driver.cancel(op_id).await.expect("cancel");
        let drain_policy = grant_all_acks(
            driver.clone(),
            collector.clone(),
            op_id.to_string(),
            2,
            BIG_CREDIT,
        );
        let exit = collector
            .wait_for_exit(Duration::from_secs(10))
            .await
            .expect("exit");
        drain_policy.abort();
        let digest_ok =
            Some(&collector.channel_digest(OpChannel::Stdout)) == exit.1.digests.get("stdout");
        let _ = driver.ack(op_id, exit.0, BIG_CREDIT, 2, true).await;

        let verdicts = self.assertable(vec![
            Verdict {
                check: "zombie gen-1 ack moved nothing (strict generation fencing)".to_string(),
                pass: zombie_moved_nothing,
                detail: format!("stalled_at={stalled_at}"),
            },
            Verdict {
                check: "live gen-2 ack resumed the flow".to_string(),
                pass: resumed,
                detail: format!("highest={}", collector.highest_data_seq()),
            },
            Verdict {
                check: "cross-generation reassembly byte-exact".to_string(),
                pass: digest_ok && collector.missing_seqs().is_empty(),
                detail: format!("missing={:?}", collector.missing_seqs()),
            },
        ]);
        self.finish(
            "op-zombie-generation",
            json!({"generations": 2}),
            Aggregator::new(),
            Vec::new(),
            verdicts,
        )
    }

    // ---- E7: reconnect transparency ----------------------------------------

    /// E7 — a nats restart mid-op must NOT kill the child (op ⊥ connection);
    /// after reconnect, OpAttach resumes from the ack floor and the final
    /// reassembly is byte-exact across the seam.
    pub async fn op_reconnect(&mut self) -> crate::report::Report {
        let op_id = "e7-reconnect";
        let (driver, collector) = self.op_rig(op_id).await.expect("op rig");
        let work = self.primary().work_dir().to_string_lossy().into_owned();
        let marker = unique_marker(&work, "e7");
        crate::proc::register_marker(&marker);
        // ~20s of periodic ticks; the marker makes the tree pgrep-able.
        let command = format!(
            "i=0; while [ $i -lt 40 ]; do printf 'tick-%05d\\n' $i; sleep 0.5; i=$((i+1)); done; \
             echo done > {marker}"
        );
        let acker = grant_all_acks(
            driver.clone(),
            collector.clone(),
            op_id.to_string(),
            1,
            BIG_CREDIT,
        );
        let started = driver
            .start_exec(op_id, &command, 0, 0)
            .await
            .expect("start");
        assert!(matches!(&started, OpReply::Started(s) if s.accepted));
        collector
            .wait_until(Duration::from_secs(10), |c| c.data_payload_total() > 0)
            .await;
        let child_before = pgrep_alive(&marker);
        let acked_floor = collector.highest_data_seq();
        acker.abort();

        // THE BLIP.
        let restart_at = self.nats.restart().await.expect("nats restart");
        tokio::time::sleep(Duration::from_secs(2)).await;
        let child_across = pgrep_alive(&marker);

        // Reconnect + re-attach from the persisted floor (B2 resume shape).
        let attach_ok = wait_for_attach(&driver, op_id, 2).await;
        let acker = grant_all_acks(
            driver.clone(),
            collector.clone(),
            op_id.to_string(),
            2,
            BIG_CREDIT,
        );
        let first_resumed = collector
            .wait_until(Duration::from_secs(15), |c| {
                c.first_arrival_above(acked_floor).is_some()
            })
            .await;
        let resume_latency = restart_at.elapsed();
        let exit = collector
            .wait_for_exit(Duration::from_secs(40))
            .await
            .expect("exit");
        acker.abort();
        let _ = driver.ack(op_id, exit.0, BIG_CREDIT, 2, true).await;
        crate::proc::reap_marker_group(&marker);

        let mut verdicts = vec![
            Verdict {
                check: "child NEVER killed by the blip (op ⊥ connection)".to_string(),
                pass: child_before && child_across,
                detail: format!("before={child_before} across={child_across}"),
            },
            Verdict {
                check: "frames resume after re-attach".to_string(),
                pass: attach_ok && first_resumed,
                detail: format!("resume_latency~={resume_latency:?} (< 15s)"),
            },
            Verdict {
                check: "resume within 15s of the restart".to_string(),
                pass: resume_latency < Duration::from_secs(15),
                detail: format!("{resume_latency:?}"),
            },
        ];
        verdicts.extend(Self::assembly_verdicts(&collector, &exit.1));
        let verdicts = self.assertable(verdicts);
        self.finish(
            "op-reconnect",
            json!({"ticks": 40, "restart": "mid-op"}),
            Aggregator::new(),
            Vec::new(),
            verdicts,
        )
    }

    // ---- E8 + E9: cancellation + tombstone (#6, M5) ------------------------

    /// E8 — OpCancel kills the FULL tree ≤ 2s with a typed cancelled Exit and
    /// is idempotent. E9 — a cancel-before-start tombstone refuses the later
    /// OpStart with zero spawns, and expires on its TTL. The E9 probes run on
    /// a dedicated agent with a short tombstone TTL.
    #[allow(clippy::too_many_lines)] // E8 + E9 share one linear story
    pub async fn op_cancellation(&self) -> crate::report::Report {
        // --- E8 on the primary agent ---
        let op_id = "e8-cancel";
        let (driver, collector) = self.op_rig(op_id).await.expect("op rig");
        let work = self.primary().work_dir().to_string_lossy().into_owned();
        let marker = unique_marker(&work, "e8");
        crate::proc::register_marker(&marker);
        // A descendant tree carrying the marker in its argv.
        let command = format!("(sleep 60; echo {marker}) & sleep 60; echo {marker}");
        let started = driver
            .start_exec(op_id, &command, 0, 0)
            .await
            .expect("start");
        assert!(matches!(&started, OpReply::Started(s) if s.accepted));
        collector
            .wait_until(Duration::from_secs(5), |_| pgrep_alive(&marker))
            .await;
        let tree_before = pgrep_alive(&marker);

        let cancel_at = Instant::now();
        let first_cancel = driver.cancel(op_id).await.expect("cancel");
        let exit = collector
            .wait_for_exit(Duration::from_secs(10))
            .await
            .expect("exit");
        let tree_dead = collector
            .wait_until(Duration::from_secs(3), |_| !pgrep_alive(&marker))
            .await;
        let kill_latency = cancel_at.elapsed();
        let second_cancel = driver.cancel(op_id).await.expect("second cancel");
        let idempotent = matches!(&second_cancel, OpReply::Status(s)
            if s.state == OpState::Complete as i32
            && s.exit.as_ref().is_some_and(|e| e.cancelled));
        let _ = driver.ack(op_id, exit.0, BIG_CREDIT, 1, true).await;
        crate::proc::reap_marker_group(&marker);

        // --- E9 on a short-tombstone agent ---
        let agent = self
            .spawn_override_agent(92, "registry_tombstone_ttl_ms=2000")
            .await
            .expect("override agent");
        let driver9 = OpDriver::new(self.driver.raw_client(), agent.agent_id());
        let op9 = "e9-tombstone";
        let marker9 = agent
            .work_dir()
            .join("e9-ran")
            .to_string_lossy()
            .into_owned();
        let cancel_unknown = driver9.cancel(op9).await.expect("cancel unknown");
        let tombstoned = matches!(&cancel_unknown, OpReply::Status(s)
            if s.state == OpState::Complete as i32
            && s.exit.as_ref().is_some_and(|e| e.cancelled));
        let refused = driver9
            .start_exec(op9, &format!("echo x >> {marker9}"), 0, 0)
            .await
            .expect("start under tombstone");
        let born_cancelled = matches!(&refused, OpReply::Started(s)
            if !s.accepted
            && s.status.as_ref().and_then(|st| st.exit.as_ref()).is_some_and(|e| e.cancelled));
        tokio::time::sleep(Duration::from_millis(700)).await;
        let zero_spawns = !std::path::Path::new(&marker9).exists();

        // After the TTL, the SAME id runs normally.
        tokio::time::sleep(Duration::from_secs(2)).await;
        let collector9 = Arc::new(
            OpCollector::attach(&self.driver.raw_client(), agent.agent_id(), op9)
                .await
                .expect("collector9"),
        );
        let fresh = driver9
            .start_exec(op9, &format!("echo x >> {marker9}; printf ran"), 0, 0)
            .await
            .expect("post-ttl start");
        let fresh_accepted = matches!(&fresh, OpReply::Started(s) if s.accepted);
        let exit9 = collector9.wait_for_exit(Duration::from_secs(10)).await;
        let ran_after_ttl = exit9.is_some() && std::path::Path::new(&marker9).exists();
        if let Some((seq, _)) = exit9 {
            let _ = driver9.ack(op9, seq, BIG_CREDIT, 1, true).await;
        }
        drop(agent);

        let verdicts = self.assertable(vec![
            Verdict {
                check: "E8: full tree dead <= 2s after OpCancel".to_string(),
                pass: tree_before && tree_dead && kill_latency <= Duration::from_secs(2),
                detail: format!("kill_latency={kill_latency:?}"),
            },
            Verdict {
                check: "E8: terminal Exit{cancelled}; second cancel idempotent".to_string(),
                pass: exit.1.cancelled && idempotent,
                detail: format!("first={first_cancel:?}"),
            },
            Verdict {
                check: "E9: cancel-before-start tombstones and refuses with 0 spawns".to_string(),
                pass: tombstoned && born_cancelled && zero_spawns,
                detail: format!("tombstoned={tombstoned} born_cancelled={born_cancelled} zero_spawns={zero_spawns}"),
            },
            Verdict {
                check: "E9: after the tombstone TTL the same id runs".to_string(),
                pass: fresh_accepted && ran_after_ttl,
                detail: format!("fresh_accepted={fresh_accepted} ran={ran_after_ttl}"),
            },
        ]);
        self.finish(
            "op-cancellation",
            json!({"tombstone_ttl_ms": 2000}),
            Aggregator::new(),
            Vec::new(),
            verdicts,
        )
    }

    // ---- E10: loud eviction + typed lost (#1, M6) ---------------------------

    /// E10 — an un-final-acked completed op evicted past the (shrunk) cap
    /// answers typed LOST{EVICTED} with the loud counter visible in the
    /// heartbeat; a runner restart answers LOST{AGENT_RESTARTED}.
    pub async fn op_lost(&self) -> crate::report::Report {
        let mut agent = self
            .spawn_override_agent(
                93,
                "registry_max_completed=2,registry_completed_ttl_ms=3600000,housekeeping_tick_ms=400",
            )
            .await
            .expect("override agent");
        let driver = OpDriver::new(self.driver.raw_client(), agent.agent_id());

        // Three completed, never-final-acked ops overflow the cap of 2.
        for i in 0..3 {
            let op_id = format!("e10-op-{i}");
            let collector =
                OpCollector::attach(&self.driver.raw_client(), agent.agent_id(), &op_id)
                    .await
                    .expect("collector");
            let started = driver
                .start_exec(&op_id, &format!("printf out-{i}"), 0, 0)
                .await
                .expect("start");
            assert!(matches!(&started, OpReply::Started(s) if s.accepted));
            collector
                .wait_for_exit(Duration::from_secs(10))
                .await
                .expect("exit");
        }
        // The GC tick (400ms) evicts the oldest, loudly.
        let evicted = wait_for_query(&driver, "e10-op-0", Duration::from_secs(10), |status| {
            status.state == OpState::Lost as i32
                && status.lost_reason == OpLostReason::Evicted as i32
        })
        .await;
        // The loud counter reaches the heartbeat telemetry.
        let counter_seen = {
            let deadline = Instant::now() + Duration::from_secs(12);
            loop {
                let seen = self
                    .collector
                    .latest_heartbeat(agent.agent_id())
                    .and_then(|hb| hb.admission)
                    .is_some_and(|a| a.evicted_unacked_total >= 1);
                if seen || Instant::now() >= deadline {
                    break seen;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        };

        // Restart probe: a running op's identity is lost across a hard
        // restart (pre-journal) — typed, never a hang.
        let op_r = "e10-restarted";
        let started = driver
            .start_exec(op_r, "sleep 30", 0, 0)
            .await
            .expect("start");
        assert!(matches!(&started, OpReply::Started(s) if s.accepted));
        agent.kill_now().await;
        agent.relaunch().expect("relaunch");
        let restarted_typed = wait_for_query(&driver, op_r, Duration::from_secs(20), |status| {
            status.state == OpState::Lost as i32
                && status.lost_reason == OpLostReason::AgentRestarted as i32
        })
        .await;
        drop(agent);

        let verdicts = self.assertable(vec![
            Verdict {
                check: "eviction past the cap answers typed LOST{EVICTED}".to_string(),
                pass: evicted,
                detail: "OpQuery(e10-op-0) → LOST/EVICTED".to_string(),
            },
            Verdict {
                check: "the eviction is LOUD (heartbeat evicted_unacked_total >= 1)".to_string(),
                pass: counter_seen,
                detail: "read from AdmissionTelemetry".to_string(),
            },
            Verdict {
                check: "post-restart query answers typed LOST{AGENT_RESTARTED}".to_string(),
                pass: restarted_typed,
                detail: "no hang, no fabricated COMPLETE".to_string(),
            },
        ]);
        self.finish(
            "op-lost",
            json!({"max_completed": 2, "housekeeping_tick_ms": 400}),
            Aggregator::new(),
            Vec::new(),
            verdicts,
        )
    }

    // ---- E12: scaling sanity (LIMITS-DOCTRINE) ------------------------------

    /// E12 — capacity in, scaled telemetry out, and no observable ceiling
    /// below the breakers: two runners with injected 1x and 2x capacity both
    /// report their figures upward and both absorb a 64-op burst with zero
    /// refusals. (The derivation's linear scaling itself is pinned at unit
    /// level: engine budgets_scale_with_capacity + admission derive tests.)
    pub async fn op_scaling(&self) -> crate::report::Report {
        let gib = 1024u64 * 1024 * 1024;
        let agent_1x = self
            .spawn_override_agent(
                94,
                &format!(
                    "capacity_mem_bytes={},capacity_disk_bytes={}",
                    8 * gib,
                    64 * gib
                ),
            )
            .await
            .expect("1x agent");
        let agent_2x = self
            .spawn_override_agent(
                95,
                &format!(
                    "capacity_mem_bytes={},capacity_disk_bytes={}",
                    16 * gib,
                    128 * gib
                ),
            )
            .await
            .expect("2x agent");

        // The upward capacity report reflects the injected figures.
        let telemetry_ok = {
            let deadline = Instant::now() + Duration::from_secs(12);
            loop {
                let read = |agent: &DisposableAgent, mem: u64| {
                    self.collector
                        .latest_heartbeat(agent.agent_id())
                        .and_then(|hb| hb.capacity)
                        .is_some_and(|c| c.mem_available_bytes == mem)
                };
                let ok = read(&agent_1x, 8 * gib) && read(&agent_2x, 16 * gib);
                if ok || Instant::now() >= deadline {
                    break ok;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        };

        // No observable ceiling below the breakers on either host size.
        let mut zero_refusals = true;
        let mut agg = Aggregator::new();
        for agent in [&agent_1x, &agent_2x] {
            let subject = agent.rpc_subject();
            let burst = futures::future::join_all((0..64).map(|_| {
                self.driver
                    .execute_owned(subject.clone(), Op::ExecEcho, Duration::from_secs(15))
            }))
            .await;
            zero_refusals &= burst.iter().all(|o| o.class == OpClass::Ok);
            agg.record_all(&burst);
        }
        drop(agent_1x);
        drop(agent_2x);

        let verdicts = self.assertable(vec![
            Verdict {
                check: "heartbeat capacity reflects the host figures (1x and 2x)".to_string(),
                pass: telemetry_ok,
                detail: "HostCapacitySample.mem_available_bytes echoes the injected values"
                    .to_string(),
            },
            Verdict {
                check: "64-op bursts admit with zero refusals on both host sizes".to_string(),
                pass: zero_refusals,
                detail: "no DRAINING below the derived breakers".to_string(),
            },
        ]);
        self.finish(
            "op-scaling",
            json!({"capacity_1x_mem_gib": 8, "capacity_2x_mem_gib": 16, "burst": 64}),
            agg,
            Vec::new(),
            verdicts,
        )
    }

    /// Spawns a dedicated disposable agent with `OPENGENI_RUNNER_TEST_OVERRIDES`
    /// set, waiting for its first heartbeat.
    async fn spawn_override_agent(
        &self,
        index: usize,
        overrides: &str,
    ) -> Result<DisposableAgent, String> {
        let agent = DisposableAgent::spawn_with_env(
            self.agent_binary.clone(),
            index,
            &self.nats.url(),
            "info",
            vec![(
                "OPENGENI_RUNNER_TEST_OVERRIDES".to_string(),
                overrides.to_string(),
            )],
        )?;
        if !self
            .collector
            .wait_for_beats(agent.agent_id(), 1, Duration::from_secs(15))
            .await
        {
            return Err(format!(
                "override agent {} never heartbeat. Log tail:\n{}",
                agent.agent_id(),
                agent.log_tail(40)
            ));
        }
        Ok(agent)
    }
}

/// Polls `OpAttach` until the runner (which may still be redialing after a
/// blip) accepts it with a live status. Generation is the resumed consumer's.
async fn wait_for_attach(driver: &OpDriver, op_id: &str, generation: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(OpReply::Status(_)) = driver.attach(op_id, 0, generation, BIG_CREDIT).await {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Polls `OpQuery` until the status satisfies `pred` (or times out) —
/// tolerant of the runner still reconnecting.
async fn wait_for_query(
    driver: &OpDriver,
    op_id: &str,
    timeout: Duration,
    pred: impl Fn(&v1::OpStatus) -> bool,
) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(OpReply::Status(status)) = driver.query(op_id).await {
            if pred(&status) {
                return true;
            }
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Total bytes of regular files under a directory tree (spool inspection —
/// the engine spools into per-op subdirectories).
fn dir_bytes(dir: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let path = entry.path();
            match entry.metadata() {
                Ok(meta) if meta.is_file() => meta.len(),
                Ok(meta) if meta.is_dir() => dir_bytes(&path),
                _ => 0,
            }
        })
        .sum()
}
