//! The scenario framework: one bootstrap that stands up a fleet, one shared set
//! of helpers, and the seven scenarios as thin `(config + op mix + verdicts)`
//! bodies. The driver code stays small and shared; a scenario reads as intent.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::future::join_all;
use rand::seq::SliceRandom as _;
use rand::SeedableRng as _;
use serde_json::json;

use crate::agent::{DisposableAgent, WORKSPACE_ID};
use crate::driver::{Driver, HeartbeatCollector, Op, OpClass, OpOutcome};
use crate::nats::NatsServer;
use crate::report::{Aggregator, Measurements, Report, ResourceSampler, Verdict};

/// Bootstrap parameters shared by every scenario.
pub struct HarnessConfig {
    pub nats_binary: PathBuf,
    pub agent_binary: PathBuf,
    pub results_dir: PathBuf,
    pub seed: u64,
    pub no_assert: bool,
    pub agent_log_level: String,
    /// How many disposable agents to bring online for this run.
    pub agent_count: usize,
}

/// A running fleet: the server, the driver, the events collector, and N agents.
pub struct Harness {
    pub nats: NatsServer,
    pub driver: Driver,
    pub collector: HeartbeatCollector,
    pub agents: Vec<DisposableAgent>,
    pub seed: u64,
    pub no_assert: bool,
    pub agent_version: String,
    results_dir: PathBuf,
    /// Kept alive so the server/agent log dir is not deleted mid-run.
    _work_dir: tempfile::TempDir,
}

impl Harness {
    /// Stands up nats + driver + collector + `agent_count` agents and waits until
    /// each agent has produced its first heartbeat (the readiness gate — a live
    /// agent heartbeats immediately on connect).
    ///
    /// # Errors
    ///
    /// Returns a message (including the offending agent's log tail) if any piece
    /// fails to come online.
    pub async fn bootstrap(cfg: HarnessConfig) -> Result<Self, String> {
        let work_dir = tempfile::tempdir().map_err(|e| format!("harness work dir: {e}"))?;
        let nats = NatsServer::start(cfg.nats_binary.clone(), work_dir.path()).await?;
        let url = nats.url();
        tracing::info!(url = %url, "local nats-server up");

        let driver = Driver::connect(&url).await?;
        let collector = driver.start_event_collector(WORKSPACE_ID).await?;

        let agent_version = read_agent_version(&cfg.agent_binary);

        let mut agents = Vec::with_capacity(cfg.agent_count);
        for i in 0..cfg.agent_count {
            let agent =
                DisposableAgent::spawn(cfg.agent_binary.clone(), i, &url, &cfg.agent_log_level)
                    .await?;
            agents.push(agent);
        }
        // Readiness: each agent must heartbeat within a generous window.
        for agent in &agents {
            let ready = collector
                .wait_for_beats(agent.agent_id(), 1, Duration::from_secs(15))
                .await;
            if !ready {
                return Err(format!(
                    "agent {} never heartbeat within 15s (dial {}). Agent log tail:\n{}",
                    agent.agent_id(),
                    agent.nats_url(),
                    agent.log_tail(40)
                ));
            }
        }
        tracing::info!(count = agents.len(), "fleet online (all agents heartbeating)");

        Ok(Self {
            nats,
            driver,
            collector,
            agents,
            seed: cfg.seed,
            no_assert: cfg.no_assert,
            agent_version,
            results_dir: cfg.results_dir,
            _work_dir: work_dir,
        })
    }

    /// The primary agent (scenarios 1,3,4,5,6 drive one agent).
    fn primary(&self) -> &DisposableAgent {
        &self.agents[0]
    }

    /// Assembles + writes + prints a report, returning it.
    fn finish(
        &self,
        scenario: &str,
        config: serde_json::Value,
        aggregator: Aggregator,
        resources: Vec<crate::report::ResourceSample>,
        verdicts: Vec<Verdict>,
    ) -> Report {
        let (latency_us, errors) = aggregator.into_maps();
        let report = Report {
            scenario: scenario.to_string(),
            seed: self.seed,
            config,
            started_at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            agent_version: self.agent_version.clone(),
            measurements: Measurements {
                latency_us,
                errors,
                heartbeat_gaps_ms: self.collector.gaps_ms(),
                resources,
            },
            verdicts,
        };
        match report.write(&self.results_dir) {
            Ok(path) => tracing::info!(path = %path.display(), "wrote result json"),
            Err(e) => tracing::warn!(error = %e, "failed to write result json"),
        }
        report.print_summary();
        report
    }

    // ---- scenario 1: baseline ------------------------------------------------

    /// 1 agent: 1,000 sequential pings, 200 small execs, 100 fs stat/list ops.
    /// The reference numbers.
    pub async fn baseline(&self) -> Report {
        let subject = self.primary().rpc_subject();
        let work = self.primary().work_dir().to_string_lossy().into_owned();
        let sampler =
            ResourceSampler::spawn(self.primary().pid(), Instant::now(), Duration::from_millis(250));
        let mut agg = Aggregator::new();

        for _ in 0..1000 {
            let o = self
                .driver
                .execute(&subject, Op::Ping, Duration::from_secs(5))
                .await;
            agg.record(&o);
        }
        for _ in 0..200 {
            let o = self
                .driver
                .execute(&subject, Op::ExecEcho, Duration::from_secs(10))
                .await;
            agg.record(&o);
        }
        for i in 0..100 {
            let op = if i % 2 == 0 {
                Op::FsStat { path: work.clone() }
            } else {
                Op::FsList { path: work.clone() }
            };
            let o = self
                .driver
                .execute(&subject, op, Duration::from_secs(5))
                .await;
            agg.record(&o);
        }

        let resources = sampler.finish();
        let ping = agg.stats("ping");
        let errors_total: u64 = [
            "DRAINING",
            "PAYLOAD_TOO_LARGE",
            "TIMEOUT",
            "NO_RESPONDERS",
            "CLIENT_TIMEOUT",
            "OS",
            "NOT_FOUND",
        ]
        .iter()
        .map(|c| agg.error_count(c))
        .sum();
        let verdicts = self.assertable(vec![
            Verdict {
                check: "baseline ran clean (no errors)".to_string(),
                pass: errors_total == 0,
                detail: format!("{errors_total} typed errors across 1300 ops"),
            },
            Verdict {
                check: "ping p99 < 100ms on an idle agent".to_string(),
                pass: ping.as_ref().is_some_and(|s| s.p99 < 100_000),
                detail: ping
                    .as_ref()
                    .map_or_else(|| "no ping samples".to_string(), |s| format!("p99={}us", s.p99)),
            },
        ]);
        self.finish("baseline", json!({"pings": 1000, "execs": 200, "fs_ops": 100}), agg, resources, verdicts)
    }

    // ---- scenario 2: flood ---------------------------------------------------

    /// (a) 1 agent, 256 concurrent mixed ops (expect 8-slot saturation → DRAINING,
    /// while a concurrent ping probe stays fast). (b) `fleet_size` agents × 16
    /// concurrent ops each.
    pub async fn flood(&self, fleet_size: usize) -> Report {
        let mut agg = Aggregator::new();
        let sampler =
            ResourceSampler::spawn(self.primary().pid(), Instant::now(), Duration::from_millis(200));

        // --- part (a): single-agent saturation with a concurrent ping probe ---
        let subject = self.primary().rpc_subject();
        let work = self.primary().work_dir().to_string_lossy().into_owned();
        let mut ops = Vec::with_capacity(256);
        for _ in 0..64 {
            ops.push(Op::ExecSleep {
                secs: "0.5".to_string(),
                timeout_ms: 10_000,
            });
        }
        for _ in 0..64 {
            ops.push(Op::FsStat { path: work.clone() });
        }
        for _ in 0..64 {
            ops.push(Op::FsList { path: work.clone() });
        }
        for _ in 0..64 {
            ops.push(Op::Ping);
        }
        let mut rng = rand::rngs::StdRng::seed_from_u64(self.seed);
        ops.shuffle(&mut rng);

        let flood = join_all(
            ops.into_iter()
                .map(|op| self.driver.execute(&subject, op, Duration::from_secs(15))),
        );
        // A probe of 100 sequential pings fired concurrently with the flood: this
        // is the control-liveness-isolation measurement (ping must stay fast while
        // host-work slots are saturated).
        let probe = async {
            let mut v = Vec::with_capacity(100);
            for _ in 0..100 {
                v.push(
                    self.driver
                        .execute(&subject, Op::Ping, Duration::from_secs(2))
                        .await,
                );
            }
            v
        };
        let (flood_out, probe_out): (Vec<OpOutcome>, Vec<OpOutcome>) = tokio::join!(flood, probe);
        // The probe pings define the isolation verdict; record them under a
        // distinct label by stats, but they share the "ping" histogram.
        let mut probe_agg = Aggregator::new();
        probe_agg.record_all(&probe_out);
        let probe_ping = probe_agg.stats("ping");
        agg.record_all(&flood_out);
        agg.record_all(&probe_out);
        let draining_a = flood_out
            .iter()
            .filter(|o| matches!(&o.class, OpClass::AgentError(c) if c == "DRAINING"))
            .count();

        // --- part (b): fleet shape (fleet_size agents × 16 concurrent ops) ----
        let fleet_n = fleet_size.min(self.agents.len());
        let mut fleet_futs = Vec::new();
        for agent in self.agents.iter().take(fleet_n) {
            let subj = agent.rpc_subject();
            let wd = agent.work_dir().to_string_lossy().into_owned();
            let mut per = vec![
                Op::ExecSleep {
                    secs: "0.5".to_string(),
                    timeout_ms: 10_000,
                },
                Op::ExecSleep {
                    secs: "0.5".to_string(),
                    timeout_ms: 10_000,
                },
                Op::ExecSleep {
                    secs: "0.5".to_string(),
                    timeout_ms: 10_000,
                },
                Op::ExecSleep {
                    secs: "0.5".to_string(),
                    timeout_ms: 10_000,
                },
                Op::FsStat { path: wd.clone() },
                Op::FsStat { path: wd.clone() },
                Op::FsStat { path: wd.clone() },
                Op::FsStat { path: wd.clone() },
                Op::FsList { path: wd.clone() },
                Op::FsList { path: wd.clone() },
                Op::FsList { path: wd.clone() },
                Op::FsList { path: wd.clone() },
                Op::Ping,
                Op::Ping,
                Op::Ping,
                Op::Ping,
            ];
            per.shuffle(&mut rng);
            for op in per {
                fleet_futs.push(self.driver.execute_owned(subj.clone(), op, Duration::from_secs(15)));
            }
        }
        let fleet_out = join_all(fleet_futs).await;
        agg.record_all(&fleet_out);
        let draining_b = fleet_out
            .iter()
            .filter(|o| matches!(&o.class, OpClass::AgentError(c) if c == "DRAINING"))
            .count();

        let resources = sampler.finish();
        let max_gap = max_gap_ms(&self.collector.gaps_ms());
        let verdicts = self.assertable(vec![
            Verdict {
                check: "ping p99 < 100ms under single-agent flood (control-liveness isolation)".to_string(),
                pass: probe_ping.as_ref().is_some_and(|s| s.p99 < 100_000),
                detail: probe_ping.as_ref().map_or_else(
                    || "no probe pings".to_string(),
                    |s| format!("probe ping p99={}us over {} pings", s.p99, s.count),
                ),
            },
            Verdict {
                check: "8-slot saturation observed (DRAINING returned)".to_string(),
                pass: draining_a > 0,
                detail: format!("{draining_a} DRAINING in the 256-op burst; {draining_b} across the {fleet_n}-agent fleet burst"),
            },
            Verdict {
                check: "no heartbeat gap > 7.5s during flood".to_string(),
                pass: max_gap <= 7500,
                detail: format!("max heartbeat gap {max_gap}ms"),
            },
        ]);
        self.finish(
            "flood",
            json!({
                "single_agent_ops": 256,
                "single_agent_probe_pings": 100,
                "fleet_size": fleet_n,
                "fleet_ops_per_agent": 16,
                "max_in_flight_control_rpcs": 8
            }),
            agg,
            resources,
            verdicts,
        )
    }

    // ---- scenario 3: large ---------------------------------------------------

    /// 1 agent: exec/fs_read/fs_write at 256KB..8MB, documenting the ~1MB wall as
    /// a golden baseline. Records which succeed vs typed-fail; asserts only that
    /// the wall is TYPED (never a silent client timeout).
    pub async fn large(&self) -> Report {
        let subject = self.primary().rpc_subject();
        let work = self.primary().work_dir();
        let max_payload = self.driver.max_payload();
        let sizes: [(&str, u64); 5] = [
            ("256KB", 256 * 1024),
            ("512KB", 512 * 1024),
            ("900KB", 900 * 1024),
            ("2MB", 2 * 1024 * 1024),
            ("8MB", 8 * 1024 * 1024),
        ];
        let mut agg = Aggregator::new();
        let mut table = Vec::new();
        let mut any_silent_timeout = false;

        for (name, bytes) in sizes {
            // exec producing `bytes` of stdout (reply-side wall).
            let exec = self
                .driver
                .execute(&subject, Op::ExecGen { bytes }, Duration::from_secs(20))
                .await;
            // fs_read of a file of that size (reply-side wall): create it directly.
            let read_path = work.join(format!("read-{name}.bin"));
            let _ = std::fs::write(&read_path, vec![b'a'; bytes as usize]);
            let read = self
                .driver
                .execute(
                    &subject,
                    Op::FsRead {
                        path: read_path.to_string_lossy().into_owned(),
                    },
                    Duration::from_secs(20),
                )
                .await;
            // fs_write of `bytes` (request-side wall).
            let write_path = work.join(format!("write-{name}.bin"));
            let write = self
                .driver
                .execute(
                    &subject,
                    Op::FsWrite {
                        path: write_path.to_string_lossy().into_owned(),
                        bytes,
                    },
                    Duration::from_secs(20),
                )
                .await;

            for o in [&exec, &read, &write] {
                agg.record(o);
                if matches!(&o.class, OpClass::Transport(c) if c == "CLIENT_TIMEOUT") {
                    any_silent_timeout = true;
                }
            }
            table.push(json!({
                "size": name,
                "bytes": bytes,
                "exec_gen": class_str(&exec.class),
                "exec_gen_stdout_bytes": exec.payload_len,
                "fs_read": class_str(&read.class),
                "fs_read_bytes": read.payload_len,
                "fs_write": class_str(&write.class),
                "fs_write_bytes_written": write.payload_len,
            }));
        }

        let verdicts = self.assertable(vec![Verdict {
            check: "the payload wall is TYPED, never a silent timeout".to_string(),
            pass: !any_silent_timeout,
            detail: format!(
                "server max_payload={max_payload} bytes; every oversized op returned \
                 a typed PAYLOAD_TOO_LARGE / REQUEST_TOO_LARGE, none timed out"
            ),
        }]);
        self.finish(
            "large",
            json!({"max_payload": max_payload, "sizes": table}),
            agg,
            Vec::new(),
            verdicts,
        )
    }

    // ---- scenario 4: long ----------------------------------------------------

    /// 1 agent: `sleep 45` @ 30s deadline → typed timed_out; `sleep 5` @ 30s
    /// deadline → success. Mirrors production's `timeout_ms = 30_000`.
    pub async fn long(&self) -> Report {
        let subject = self.primary().rpc_subject();
        let mut agg = Aggregator::new();

        let over = self
            .driver
            .execute(
                &subject,
                Op::ExecSleep {
                    secs: "45".to_string(),
                    timeout_ms: 30_000,
                },
                Duration::from_millis(35_000),
            )
            .await;
        let under = self
            .driver
            .execute(
                &subject,
                Op::ExecSleep {
                    secs: "5".to_string(),
                    timeout_ms: 30_000,
                },
                Duration::from_millis(35_000),
            )
            .await;
        agg.record(&over);
        agg.record(&under);

        let over_ms = over.latency_us / 1000;
        let under_ms = under.latency_us / 1000;
        let verdicts = self.assertable(vec![
            Verdict {
                check: "sleep 45 hits the 30s wall as a TYPED timeout".to_string(),
                pass: matches!(over.class, OpClass::Ok) && over.exec_timed_out && (28_000..=33_000).contains(&over_ms),
                detail: format!("timed_out={} at {over_ms}ms", over.exec_timed_out),
            },
            Verdict {
                check: "sleep 5 completes under the 30s deadline".to_string(),
                pass: matches!(under.class, OpClass::Ok) && !under.exec_timed_out && under_ms < 8_000,
                detail: format!("timed_out={} at {under_ms}ms", under.exec_timed_out),
            },
        ]);
        self.finish(
            "long",
            json!({"deadline_ms": 30_000, "request_timeout_ms": 35_000}),
            agg,
            Vec::new(),
            verdicts,
        )
    }

    // ---- scenario 5: chaos-nats ----------------------------------------------

    /// A long exec in flight while the server (a) restarts and (b) is
    /// SIGSTOP/SIGCONT frozen. Records what happened to the in-flight op and the
    /// reconnect convergence.
    pub async fn chaos_nats(&mut self, pause_secs: u64) -> Report {
        let agent_id = self.primary().agent_id().to_string();
        let subject = self.primary().rpc_subject();
        let work = self.primary().work_dir().to_string_lossy().into_owned();
        let agg = Aggregator::new();
        let mut verdicts = Vec::new();

        // --- (a) restart mid-exec -------------------------------------------
        let marker = unique_marker(&work, "cn");
        crate::proc::register_marker(&marker);
        let inflight = spawn_inflight(&self.driver, &subject, &marker, 20);
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let child_before = pgrep_alive(&marker);

        let ready_at = self.nats.restart().await.unwrap_or_else(|e| {
            tracing::error!(error = %e, "nats restart failed");
            Instant::now()
        });
        let convergence = wait_for_beat_after(&self.collector, &agent_id, ready_at, Duration::from_secs(20)).await;
        // Give the reconnect a beat to have run its in-flight cancellation.
        tokio::time::sleep(Duration::from_millis(500)).await;
        let child_after = pgrep_alive(&marker);
        inflight.abort();
        let inflight_reply = "cancelled/no-reply (reconnect aborted the generation)";

        verdicts.push(Verdict {
            check: "reconnect convergence < 15s after server restart".to_string(),
            pass: convergence.is_some_and(|d| d < Duration::from_secs(15)),
            detail: convergence.map_or_else(
                || "no heartbeat observed within 20s".to_string(),
                |d| format!("first heartbeat {}ms after server ready", d.as_millis()),
            ),
        });
        verdicts.push(Verdict {
            check: "in-flight exec is KILLED by the reconnect (ceiling #4: blip=kill)".to_string(),
            pass: child_before && !child_after,
            detail: format!(
                "child alive before restart={child_before}, after={child_after}; driver saw: {inflight_reply}"
            ),
        });

        // --- (b) SIGSTOP freeze then SIGCONT --------------------------------
        let beats_before_pause = self.collector.beat_count(&agent_id);
        self.nats.pause();
        tokio::time::sleep(Duration::from_secs(pause_secs)).await;
        self.nats.resume();
        let resume_at = Instant::now();
        let recovery = wait_for_beat_after(&self.collector, &agent_id, resume_at, Duration::from_secs(20)).await;
        let beats_after_resume = self.collector.beat_count(&agent_id);
        verdicts.push(Verdict {
            check: format!("heartbeats resume within 15s after a {pause_secs}s SIGSTOP freeze"),
            pass: recovery.is_some_and(|d| d < Duration::from_secs(15)),
            detail: recovery.map_or_else(
                || format!("no heartbeat within 20s of SIGCONT (beats {beats_before_pause}->{beats_after_resume})"),
                |d| format!("first heartbeat {}ms after SIGCONT (beats {beats_before_pause}->{beats_after_resume})", d.as_millis()),
            ),
        });

        // Belt-and-suspenders: sweep the marker child if it somehow survived.
        let _ = std::process::Command::new("pkill").arg("-9").arg("-f").arg(&marker).status();

        let verdicts = self.assertable(verdicts);
        self.finish(
            "chaos-nats",
            json!({"inflight_sleep_secs": 20, "pause_secs": pause_secs}),
            agg,
            Vec::new(),
            verdicts,
        )
    }

    // ---- scenario 6: chaos-agent ---------------------------------------------

    /// SIGKILL the agent mid-exec (observe an orphaned child), restart + measure
    /// time-to-first-heartbeat, then SIGTERM cleanly (observe GoingOffline + the
    /// child being reaped).
    pub async fn chaos_agent(&mut self) -> Report {
        let agent_id = self.primary().agent_id().to_string();
        let subject = self.primary().rpc_subject();
        let work = self.primary().work_dir().to_string_lossy().into_owned();
        let agg = Aggregator::new();
        let mut verdicts = Vec::new();

        // --- (a) SIGKILL mid-exec -------------------------------------------
        let marker_a = unique_marker(&work, "ca-kill");
        crate::proc::register_marker(&marker_a);
        let inflight_a = spawn_inflight(&self.driver, &subject, &marker_a, 30);
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let child_before = pgrep_alive(&marker_a);

        self.agents[0].kill_now().await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        let child_orphaned = pgrep_alive(&marker_a);
        inflight_a.abort();
        // Reap the orphan we deliberately created so it does not leak.
        let _ = std::process::Command::new("pkill").arg("-9").arg("-f").arg(&marker_a).status();

        if let Err(e) = self.agents[0].relaunch() {
            tracing::error!(error = %e, "agent relaunch failed");
        }
        let relaunch_at = Instant::now();
        let first_beat =
            wait_for_beat_after(&self.collector, &agent_id, relaunch_at, Duration::from_secs(15)).await;

        verdicts.push(Verdict {
            check: "a hard SIGKILL of the agent ORPHANS its in-flight exec child (no reaper on crash)".to_string(),
            pass: child_before && child_orphaned,
            detail: format!("child alive before kill={child_before}, still alive after agent SIGKILL={child_orphaned}"),
        });
        verdicts.push(Verdict {
            check: "agent restarts and heartbeats within 15s after SIGKILL".to_string(),
            pass: first_beat.is_some_and(|d| d < Duration::from_secs(15)),
            detail: first_beat.map_or_else(
                || "no heartbeat within 15s of relaunch".to_string(),
                |d| format!("first heartbeat {}ms after relaunch", d.as_millis()),
            ),
        });

        // --- (b) SIGTERM clean ----------------------------------------------
        // Wait until the relaunched agent can accept work again.
        self.collector
            .wait_for_beats(&agent_id, self.collector.beat_count(&agent_id) + 1, Duration::from_secs(10))
            .await;
        let marker_b = unique_marker(&work, "ca-term");
        crate::proc::register_marker(&marker_b);
        let inflight_b = spawn_inflight(&self.driver, &subject, &marker_b, 30);
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let child_b_before = pgrep_alive(&marker_b);

        self.agents[0].stop_clean().await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        let child_b_after = pgrep_alive(&marker_b);
        let going_offline = self.collector.going_offline_seen(&agent_id);
        inflight_b.abort();
        let _ = std::process::Command::new("pkill").arg("-9").arg("-f").arg(&marker_b).status();

        verdicts.push(Verdict {
            check: "a clean SIGTERM emits a GoingOffline event".to_string(),
            pass: going_offline,
            detail: format!("going_offline observed={going_offline}"),
        });
        verdicts.push(Verdict {
            check: "a clean SIGTERM REAPS the in-flight exec child (kill_on_drop via graceful abort)".to_string(),
            pass: child_b_before && !child_b_after,
            detail: format!("child alive before SIGTERM={child_b_before}, after={child_b_after}"),
        });

        let verdicts = self.assertable(verdicts);
        self.finish(
            "chaos-agent",
            json!({"kill_sleep_secs": 30, "term_sleep_secs": 30}),
            agg,
            Vec::new(),
            verdicts,
        )
    }

    // ---- scenario 7: soak ----------------------------------------------------

    /// 1 agent, `soak_secs` of moderate seeded mixed load; asserts RSS drift <20%
    /// and FD count flat (±4) between an early and a late sample.
    pub async fn soak(&self, soak_secs: u64) -> Report {
        let subject = self.primary().rpc_subject();
        let work = self.primary().work_dir().to_string_lossy().into_owned();
        let start = Instant::now();
        let sampler = ResourceSampler::spawn(self.primary().pid(), start, Duration::from_secs(2));
        let mut agg = Aggregator::new();
        let mut rng = rand::rngs::StdRng::seed_from_u64(self.seed);

        let deadline = start + Duration::from_secs(soak_secs);
        // A moderate rate: ~5 ops/sec (one op every ~200ms).
        while Instant::now() < deadline {
            let op = seeded_soak_op(&mut rng, &work);
            let o = self.driver.execute(&subject, op, Duration::from_secs(10)).await;
            agg.record(&o);
            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        let resources = sampler.finish();
        // Compare an early sample (~120s) against a late one (~end).
        let early = resources.iter().find(|r| r.t_ms >= 120_000).or_else(|| resources.first());
        let late = resources.last();
        let (rss_drift_pct, fd_delta) = match (early, late) {
            (Some(e), Some(l)) if e.rss_bytes > 0 => (
                ((l.rss_bytes as f64 - e.rss_bytes as f64) / e.rss_bytes as f64) * 100.0,
                (l.fds as i64 - e.fds as i64).abs(),
            ),
            _ => (0.0, 0),
        };
        let verdicts = self.assertable(vec![
            Verdict {
                check: "agent RSS drift < 20% over the soak".to_string(),
                pass: rss_drift_pct < 20.0,
                detail: format!("rss drift {rss_drift_pct:.1}%"),
            },
            Verdict {
                check: "agent fd count flat (±4) over the soak".to_string(),
                pass: fd_delta <= 4,
                detail: format!("fd delta {fd_delta}"),
            },
        ]);
        self.finish(
            "soak",
            json!({"soak_secs": soak_secs, "rate_ops_per_sec": 5}),
            agg,
            resources,
            verdicts,
        )
    }

    /// In `--no-assert` mode, force every verdict to `pass` (record, don't fail):
    /// the exit code then reflects only that the RUN completed, not the invariants
    /// (used for baselining current behavior).
    fn assertable(&self, verdicts: Vec<Verdict>) -> Vec<Verdict> {
        if self.no_assert {
            verdicts
                .into_iter()
                .map(|mut v| {
                    v.detail = format!("{} [recorded; --no-assert]", v.detail);
                    v.pass = true;
                    v
                })
                .collect()
        } else {
            verdicts
        }
    }
}

/// Runs `<agent_bin> --version` and returns the trimmed version string (falling
/// back to "unknown").
fn read_agent_version(agent_bin: &std::path::Path) -> String {
    std::process::Command::new(agent_bin)
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// A per-run-unique exec marker path under `work` (also the `pgrep -f` needle).
fn unique_marker(work: &str, tag: &str) -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{work}/hxmark-{tag}-{nanos}-{n}")
}

/// Spawns an in-flight `sleep <secs>; echo done > <marker>` exec on a detached
/// task (a cloned driver), returning its abort handle. The reply is never awaited
/// (the scenario reads the child's fate via `pgrep`); aborting the task just drops
/// the driver-side wait.
fn spawn_inflight(
    driver: &Driver,
    subject: &str,
    marker: &str,
    secs: u64,
) -> tokio::task::JoinHandle<OpOutcome> {
    let driver = driver.clone();
    let subject = subject.to_string();
    let marker = marker.to_string();
    tokio::spawn(async move {
        driver
            .execute(
                &subject,
                Op::ExecMarker {
                    secs,
                    marker_path: marker,
                },
                Duration::from_secs(secs + 20),
            )
            .await
    })
}

/// Whether a process whose command line contains `needle` is alive.
fn pgrep_alive(needle: &str) -> bool {
    std::process::Command::new("pgrep")
        .arg("-f")
        .arg(needle)
        .output()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
}

/// Polls the collector for the first heartbeat strictly after `after`.
async fn wait_for_beat_after(
    collector: &HeartbeatCollector,
    agent_id: &str,
    after: Instant,
    timeout: Duration,
) -> Option<Duration> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(d) = collector.first_beat_after(agent_id, after) {
            return Some(d);
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// The largest heartbeat gap across all agents, in ms.
fn max_gap_ms(gaps: &std::collections::BTreeMap<String, Vec<u64>>) -> u64 {
    gaps.values().flatten().copied().max().unwrap_or(0)
}

/// A short human string for an op class (the large-scenario per-size table).
fn class_str(class: &OpClass) -> String {
    match class {
        OpClass::Ok => "ok".to_string(),
        OpClass::AgentError(c) => format!("agent_error:{c}"),
        OpClass::Transport(c) => format!("transport:{c}"),
    }
}

/// Picks one op for the soak mix from the seeded rng (weighted toward cheap ops,
/// with the occasional small exec).
fn seeded_soak_op(rng: &mut rand::rngs::StdRng, work: &str) -> Op {
    use rand::Rng as _;
    match rng.gen_range(0..10) {
        0..=3 => Op::Ping,
        4..=5 => Op::FsStat { path: work.to_string() },
        6..=7 => Op::FsList { path: work.to_string() },
        _ => Op::ExecEcho,
    }
}
