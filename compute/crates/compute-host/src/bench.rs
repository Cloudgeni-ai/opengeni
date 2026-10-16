//! `compute-host bench` and `exec`: drive a running agent and time it.
//!
//! The bench creates sandboxes, boots each with a warm-up script, then sends
//! them all to one sleep level and wakes them all at once, round after round.
//! It times every sandbox on its own (how long each took to reach the level,
//! and how long each wake took to the first byte and to the end of the
//! script) and samples the host's memory at every level.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::bail;
use clap::{Args, ValueEnum};
use compute_core::SandboxId;
use compute_host::client::Client;
use compute_host::protocol::{
    HostStatus, Id, LevelName, PriorityName, Reply, Request, SandboxConfig, SleepConfig, StepStats,
};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::task::JoinSet;
use tokio::time::Instant;

use crate::{expect_done, parse_duration};

/// How often the bench looks at the host while sandboxes go to sleep. Each
/// sandbox's time to reach its level is measured to this resolution.
const POLL: Duration = Duration::from_millis(10);

/// How long the sandboxes may take to reach a level.
const SLEEP_LIMIT: Duration = Duration::from_secs(1800);

/// Printed by the guest shell after the script. The script counts as done
/// when this arrives, not when the stream closes: the guest's stream bridge
/// may wait a while after the shell exits before closing its side.
const DONE_MARKER: &[u8] = b"\x1ecompute-bench-done\x1e";

#[derive(Args)]
pub(crate) struct BenchArgs {
    #[arg(long, default_value_t = 100)]
    count: usize,
    /// The level to wake from. After each wake the bench asks every sandbox
    /// to sleep this deep, timing the steps that get it there.
    #[arg(long, value_enum, default_value = "compressed")]
    level: BenchLevel,
    #[arg(long, default_value_t = 1)]
    vcpus: u8,
    #[arg(long, default_value_t = 512)]
    memory_mib: u32,
    #[arg(long, default_value_t = 52)]
    port: u32,
    /// Script each wake runs.
    #[arg(long, default_value = "cat /proc/loadavg")]
    script: String,
    /// Script the first wake (the boot) runs, to give each sandbox a
    /// realistic working set before it sleeps.
    #[arg(long, default_value = "echo ready")]
    warm: String,
    /// Idle time after each wake before the sandboxes are sent to sleep.
    #[arg(long, default_value = "1s", value_parser = parse_duration)]
    settle: Duration,
    /// Burst wakes to run, each after the sandboxes fall asleep again.
    #[arg(long, default_value_t = 1)]
    rounds: usize,
    /// Keep the sandboxes afterwards.
    #[arg(long)]
    keep: bool,
    /// Also write the results here as JSON.
    #[arg(long)]
    json: Option<PathBuf>,
}

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
enum BenchLevel {
    Paused,
    Compressed,
    Saved,
    Archived,
    Remote,
}

impl BenchLevel {
    const fn level(self) -> LevelName {
        match self {
            Self::Paused => LevelName::Paused,
            Self::Compressed => LevelName::Compressed,
            Self::Saved => LevelName::Saved,
            Self::Archived => LevelName::Archived,
            Self::Remote => LevelName::Remote,
        }
    }
}

/// One script run inside a sandbox, timed from the request.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct Run {
    /// Microseconds the host spent waking the sandbox.
    pub(crate) waited_us: u64,
    /// Microseconds spent reaching the guest port after waking.
    pub(crate) connect_us: u64,
    /// Until the first byte of output.
    #[serde(serialize_with = "micros")]
    pub(crate) first_byte: Duration,
    /// Until the script ended.
    #[serde(serialize_with = "micros")]
    pub(crate) done: Duration,
}

/// Wakes `id`, runs `script` in the shell on guest `port` and times it;
/// with `echo`, prints the output.
pub(crate) async fn run_script(
    client: &Client,
    id: Id,
    port: u32,
    script: &str,
    echo: bool,
) -> anyhow::Result<Run> {
    let started = Instant::now();
    let (reply, mut stream) = client.connect(id, port, PriorityName::Interactive).await?;
    let Reply::Connected {
        waited_us,
        connect_us,
    } = reply
    else {
        bail!("{reply:?}");
    };
    stream
        .get_mut()
        .write_all(format!("{script}\nprintf '\\036compute-bench-done\\036'\nexit\n").as_bytes())
        .await?;
    let mut output = Vec::new();
    let mut first_byte = None;
    let mut chunk = [0_u8; 8192];
    let done = loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            bail!("the guest closed the connection before the script ended");
        }
        first_byte.get_or_insert_with(|| started.elapsed());
        // The marker may straddle two reads, so search the tail that could
        // hold its start.
        let from = output.len().saturating_sub(DONE_MARKER.len() - 1);
        output.extend_from_slice(&chunk[..read]);
        if let Some(at) = find(&output[from..], DONE_MARKER) {
            output.truncate(from + at);
            break started.elapsed();
        }
    };
    if echo {
        print!("{}", String::from_utf8_lossy(&output));
    }
    Ok(Run {
        waited_us,
        connect_us,
        first_byte: first_byte.unwrap_or(done),
        done,
    })
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Host memory as `/proc/meminfo` reports it, in bytes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
struct HostMemory {
    /// Memory available for new work without swapping; reclaimable page
    /// cache counts as available.
    available: u64,
    /// Compressed memory zswap holds.
    zswap: u64,
    /// The same memory before compression.
    zswapped: u64,
    /// Reserved huge pages in use. The reserved pool never counts as
    /// available, so memory backed by it shows up only here.
    huge_pages_used: u64,
}

impl HostMemory {
    /// Reads the counters, or `None` where `/proc/meminfo` does not exist.
    fn sample() -> Option<Self> {
        std::fs::read_to_string("/proc/meminfo")
            .ok()
            .map(|meminfo| Self::parse(&meminfo))
    }

    fn parse(meminfo: &str) -> Self {
        let field = |name: &str| -> u64 {
            meminfo
                .lines()
                .find_map(|line| line.strip_prefix(name))
                .and_then(|rest| rest.split_whitespace().next())
                .and_then(|value| value.parse().ok())
                .unwrap_or(0)
        };
        let bytes = |name: &str| field(name).saturating_mul(1024);
        Self {
            available: bytes("MemAvailable:"),
            zswap: bytes("Zswap:"),
            zswapped: bytes("Zswapped:"),
            huge_pages_used: field("HugePages_Total:")
                .saturating_sub(field("HugePages_Free:"))
                .saturating_mul(bytes("Hugepagesize:")),
        }
    }

    /// What `count` sandboxes cost the host now, each, compared with
    /// `before` they existed.
    fn per_sandbox(self, before: Self, count: usize) -> MemoryPerSandbox {
        let count = i64::try_from(count.max(1)).unwrap_or(i64::MAX);
        let delta = |now: u64, then: u64| {
            let now = i64::try_from(now).unwrap_or(i64::MAX);
            let then = i64::try_from(then).unwrap_or(i64::MAX);
            now.saturating_sub(then) / count
        };
        MemoryPerSandbox {
            available_lost: delta(before.available, self.available),
            zswap: delta(self.zswap, before.zswap),
            huge_pages: delta(self.huge_pages_used, before.huge_pages_used),
        }
    }
}

/// Host memory one sandbox costs at a level, in bytes. Values can dip below
/// zero when the host frees unrelated memory meanwhile.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
struct MemoryPerSandbox {
    /// Available memory the host lost.
    available_lost: i64,
    /// Compressed memory in zswap.
    zswap: i64,
    /// Reserved huge pages in use.
    huge_pages: i64,
}

#[derive(Debug, Serialize)]
struct Burst {
    label: String,
    ok: usize,
    failed: Vec<String>,
    runs: Vec<Run>,
    steps: Vec<(String, StepStats)>,
}

async fn burst(client: &Client, ids: &[Id], args: &BenchArgs, script: &str, label: &str) -> Burst {
    let before = status(client).await.ok();
    let gate = Arc::new(tokio::sync::Barrier::new(ids.len()));
    let mut tasks = JoinSet::new();
    for id in ids {
        let (client, gate, id, port, script) = (
            client.clone(),
            Arc::clone(&gate),
            *id,
            args.port,
            script.to_owned(),
        );
        tasks.spawn(async move {
            gate.wait().await;
            run_script(&client, id, port, &script, false).await
        });
    }
    let mut runs = Vec::new();
    let mut failed = Vec::new();
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok(Ok(run)) => runs.push(run),
            Ok(Err(error)) => failed.push(error.to_string()),
            Err(error) => failed.push(error.to_string()),
        }
    }
    let after = status(client).await.ok();
    let burst = Burst {
        label: label.to_owned(),
        ok: runs.len(),
        failed,
        runs,
        steps: step_delta(before, after),
    };
    report(&burst);
    burst
}

async fn status(client: &Client) -> anyhow::Result<HostStatus> {
    match client.call(&Request::Status).await? {
        Reply::Status(status) => Ok(*status),
        other => bail!("status failed: {other:?}"),
    }
}

/// The steps that ran between two samples of the host's counters.
fn step_delta(before: Option<HostStatus>, after: Option<HostStatus>) -> Vec<(String, StepStats)> {
    let (Some(before), Some(after)) = (before, after) else {
        return Vec::new();
    };
    after
        .steps
        .into_iter()
        .zip(before.steps)
        .filter_map(|((name, after), (_, before))| {
            let started = after.started - before.started;
            (started > 0).then(|| {
                let mut delta = after;
                delta.started = started;
                delta.done -= before.done;
                delta.cancelled -= before.cancelled;
                delta.failed -= before.failed;
                delta.total_us -= before.total_us;
                (name, delta)
            })
        })
        .collect()
}

fn percentiles(mut values: Vec<Duration>) -> String {
    if values.is_empty() {
        return "-".into();
    }
    values.sort_unstable();
    let at = |q: f64| {
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss
        )]
        let index = ((values.len() - 1) as f64 * q).round() as usize;
        values[index]
    };
    format!(
        "p50 {:>9.1?}  p90 {:>9.1?}  p99 {:>9.1?}  max {:>9.1?}",
        at(0.5),
        at(0.9),
        at(0.99),
        at(1.0)
    )
}

fn report(burst: &Burst) {
    println!(
        "\n{}: {} ok, {} failed",
        burst.label,
        burst.ok,
        burst.failed.len()
    );
    for error in burst.failed.iter().take(3) {
        println!("  error: {error}");
    }
    let pick = |f: fn(&Run) -> Duration| burst.runs.iter().map(f).collect::<Vec<_>>();
    println!(
        "  host wake    {}",
        percentiles(pick(|run| Duration::from_micros(run.waited_us)))
    );
    println!(
        "  guest port   {}",
        percentiles(pick(|run| Duration::from_micros(run.connect_us)))
    );
    println!("  first byte   {}", percentiles(pick(|run| run.first_byte)));
    println!("  done         {}", percentiles(pick(|run| run.done)));
    report_steps(&burst.steps);
}

fn report_steps(steps: &[(String, StepStats)]) {
    for (name, stats) in steps {
        let mean = stats.total_us / stats.done.max(1);
        println!(
            "  step {name:<9} {} started, {} done, {} cancelled, {} failed, mean {:?}, max so far {:?}",
            stats.started,
            stats.done,
            stats.cancelled,
            stats.failed,
            Duration::from_micros(mean),
            Duration::from_micros(stats.max_us)
        );
    }
}

/// Waits until every sandbox in `ids` (sorted) is at `level` with no step
/// running, and returns how long each took from `started`, in `ids` order.
async fn wait_for_level(
    client: &Client,
    ids: &[Id],
    level: LevelName,
    started: Instant,
) -> anyhow::Result<Vec<Duration>> {
    let mut reached: Vec<Option<Duration>> = vec![None; ids.len()];
    let mut waiting = ids.len();
    let mut last_report = Instant::now();
    while waiting > 0 {
        let status = status(client).await?;
        let now = started.elapsed();
        for sandbox in &status.sandboxes {
            if sandbox.level != level || sandbox.step.is_some() {
                continue;
            }
            if let Ok(index) = ids.binary_search(&sandbox.id)
                && reached[index].is_none()
            {
                reached[index] = Some(now);
                waiting -= 1;
            }
        }
        if waiting == 0 {
            break;
        }
        if last_report.elapsed() > Duration::from_secs(10) {
            println!("  {}/{} at {level:?}", ids.len() - waiting, ids.len());
            last_report = Instant::now();
        }
        if now > SLEEP_LIMIT {
            bail!(
                "only {}/{} sandboxes reached {level:?}",
                ids.len() - waiting,
                ids.len()
            );
        }
        tokio::time::sleep(POLL).await;
    }
    Ok(reached.into_iter().flatten().collect())
}

/// Sends every sandbox to `level` at once and reports how long each took to
/// get there, the steps that took them and the host memory they hold there.
async fn put_to_sleep(
    client: &Client,
    ids: &[Id],
    level: LevelName,
    label: &str,
    baseline: Option<HostMemory>,
) -> anyhow::Result<Sleep> {
    let before = status(client).await.ok();
    let started = Instant::now();
    let mut requests = JoinSet::new();
    for id in ids {
        let (client, id) = (client.clone(), *id);
        requests.spawn(async move {
            client
                .call(&Request::Sleep {
                    id,
                    generation: None,
                    level,
                })
                .await
        });
    }
    while let Some(result) = requests.join_next().await {
        expect_done(result??)?;
    }
    let reached = wait_for_level(client, ids, level, started).await?;
    let took = started.elapsed();
    let after = status(client).await.ok();
    let memory = HostMemory::sample();
    let sleep = Sleep {
        label: label.to_owned(),
        took_us: micros_of(took),
        reached_us: reached.iter().copied().map(micros_of).collect(),
        resident_bytes: after.as_ref().map(|status| {
            status
                .sandboxes
                .iter()
                .filter(|sandbox| ids.binary_search(&sandbox.id).is_ok())
                .filter_map(|sandbox| sandbox.resident_bytes)
                .sum()
        }),
        memory,
        per_sandbox: memory
            .zip(baseline)
            .map(|(now, before)| now.per_sandbox(before, ids.len())),
        steps: step_delta(before, after),
    };
    println!("\n{label}: all there after {took:?}");
    println!("  each         {}", percentiles(reached));
    if let Some(bytes) = sleep.resident_bytes {
        println!(
            "  resident     {} MiB total, {} MiB per sandbox",
            bytes >> 20,
            (bytes / ids.len().max(1) as u64) >> 20
        );
    }
    if let Some(per) = sleep.per_sandbox {
        println!(
            "  host memory  {} MiB less available, {} MiB zswap, {} MiB huge pages, per sandbox",
            per.available_lost >> 20,
            per.zswap >> 20,
            per.huge_pages >> 20
        );
    }
    report_steps(&sleep.steps);
    Ok(sleep)
}

#[derive(Debug, Serialize)]
struct Sleep {
    label: String,
    /// Until the last sandbox reached the level.
    took_us: u64,
    /// Until each sandbox reached the level.
    reached_us: Vec<u64>,
    /// VM processes' resident memory, summed.
    resident_bytes: Option<u64>,
    /// The host's memory at the level.
    memory: Option<HostMemory>,
    /// What each sandbox costs the host at the level, against the memory
    /// before any was created.
    per_sandbox: Option<MemoryPerSandbox>,
    steps: Vec<(String, StepStats)>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
enum Phase {
    Wake(Burst),
    Sleep(Sleep),
}

#[derive(Debug, Serialize)]
struct Results {
    count: usize,
    vcpus: u8,
    memory_mib: u32,
    /// The host's memory before the sandboxes were created.
    baseline: Option<HostMemory>,
    /// How long the create requests took, all at once.
    create_us: u64,
    phases: Vec<Phase>,
}

pub(crate) async fn bench(client: &Client, args: &BenchArgs) -> anyhow::Result<()> {
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut ids: Vec<Id> = (0..args.count)
        .map(|index| Id(SandboxId((seed << 32) | index as u128)))
        .collect();
    ids.sort_unstable();
    // Sandboxes only sleep when the bench asks, so each phase is timed on
    // its own; idle timers would start steps at unpredictable moments.
    let config = SandboxConfig {
        vcpus: args.vcpus,
        memory_mib: args.memory_mib,
        sleep: SleepConfig::default(),
    };
    let baseline = HostMemory::sample();
    let started = Instant::now();
    let mut creates = JoinSet::new();
    for id in &ids {
        let (client, id, config) = (client.clone(), *id, config.clone());
        creates.spawn(async move { client.call(&Request::Create { id, config }).await });
    }
    while let Some(result) = creates.join_next().await {
        expect_done(result??)?;
    }
    let create = started.elapsed();
    println!("created {} sandboxes in {create:?}", ids.len());

    let level = args.level.level();
    let mut phases = vec![Phase::Wake(
        burst(client, &ids, args, &args.warm, "first wake (boot)").await,
    )];
    for round in 1..=args.rounds {
        tokio::time::sleep(args.settle).await;
        let label = format!("round {round}: sleep to {level:?}");
        phases.push(Phase::Sleep(
            put_to_sleep(client, &ids, level, &label, baseline).await?,
        ));
        let label = format!("round {round}: wake from {level:?}");
        phases.push(Phase::Wake(
            burst(client, &ids, args, &args.script, &label).await,
        ));
    }
    if let Some(path) = &args.json {
        let results = Results {
            count: args.count,
            vcpus: args.vcpus,
            memory_mib: args.memory_mib,
            baseline,
            create_us: micros_of(create),
            phases,
        };
        std::fs::write(path, serde_json::to_vec_pretty(&results)?)?;
    }
    if !args.keep {
        let mut removes = JoinSet::new();
        for id in &ids {
            let (client, id) = (client.clone(), *id);
            removes.spawn(async move {
                client
                    .call(&Request::Remove {
                        id,
                        generation: None,
                    })
                    .await
            });
        }
        while let Some(result) = removes.join_next().await {
            expect_done(result??)?;
        }
    }
    Ok(())
}

fn micros_of(duration: Duration) -> u64 {
    u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
}

fn micros<S: serde::Serializer>(duration: &Duration, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_u64(micros_of(*duration))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MEMINFO: &str = "\
MemTotal:       65536000 kB
MemFree:         1000000 kB
MemAvailable:   60000000 kB
Zswap:             10240 kB
Zswapped:          40960 kB
HugePages_Total:     100
HugePages_Free:       60
Hugepagesize:       2048 kB
";

    #[test]
    fn host_memory_reads_the_counters_it_needs() {
        assert_eq!(
            HostMemory::parse(MEMINFO),
            HostMemory {
                available: 60_000_000 * 1024,
                zswap: 10 << 20,
                zswapped: 40 << 20,
                huge_pages_used: 40 * (2 << 20),
            }
        );
    }

    #[test]
    fn missing_counters_read_as_zero() {
        assert_eq!(
            HostMemory::parse("MemAvailable: 4 kB\n"),
            HostMemory {
                available: 4096,
                ..HostMemory::default()
            }
        );
    }

    #[test]
    fn the_done_marker_matches_what_the_shell_prints() {
        // printf turns each \036 escape into the record separator byte.
        assert_eq!(DONE_MARKER, "\u{1e}compute-bench-done\u{1e}".as_bytes());
        assert_eq!(find(b"out\x1ecompute-bench-done\x1e", DONE_MARKER), Some(3));
        assert_eq!(find(b"out\x1ecompute-bench-do", DONE_MARKER), None);
    }

    #[test]
    fn per_sandbox_cost_divides_what_changed() {
        let before = HostMemory {
            available: 1000 << 20,
            zswap: 0,
            zswapped: 0,
            huge_pages_used: 0,
        };
        let now = HostMemory {
            available: 600 << 20,
            zswap: 40 << 20,
            zswapped: 160 << 20,
            huge_pages_used: 200 << 20,
        };
        assert_eq!(
            now.per_sandbox(before, 4),
            MemoryPerSandbox {
                available_lost: 100 << 20,
                zswap: 10 << 20,
                huge_pages: 50 << 20,
            }
        );
        // Memory freed elsewhere shows as a negative cost, not a wrap.
        assert!(before.per_sandbox(now, 4).available_lost < 0);
    }
}
