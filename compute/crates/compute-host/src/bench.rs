//! `compute-host bench` and `exec`: drive a running agent and time it.
//!
//! The bench creates sandboxes, boots each with a warm-up script, then sends
//! them all to one sleep level and wakes them all at once, round after round.
//! It times every sandbox on its own (how long each took to reach the level,
//! and how long each wake took to the first byte and to the end of the
//! script) and samples the host's memory at every level.
//!
//! Every wake in a burst is timed from one shared release, so a request the
//! bench itself dispatches late still counts that delay. A script counts as
//! finished only when the guest reports its exit status, and only a zero
//! status counts as a success. Scripts run under bash, like the lab guest
//! service. Sandboxes are removed afterwards even when a phase fails, unless
//! `--keep` asks otherwise, and the results record every failure, cleanup's
//! included.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, anyhow, bail};
use clap::{Args, ValueEnum};
use compute_core::SandboxId;
use compute_host::client::Client;
use compute_host::protocol::{
    ErrorCode, HostStatus, Id, LevelName, PriorityName, Reply, Request, SandboxConfig, SleepConfig,
    StepStats,
};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Barrier, watch};
use tokio::task::JoinSet;
use tokio::time::Instant;

use crate::{expect_done, parse_duration};

/// How often the bench looks at the host while sandboxes go to sleep. Each
/// sandbox's time to reach its level is measured to this resolution.
const POLL: Duration = Duration::from_millis(10);

/// How long the sandboxes may take to reach a level.
const SLEEP_LIMIT: Duration = Duration::from_secs(1800);

/// How long the guest may take to close a stream after its script ended.
/// The bench waits for that outside the timing, so the host has let go of
/// the sandbox before the next measurement starts.
const DRAIN_LIMIT: Duration = Duration::from_secs(10);

/// How long sandboxes may stay held awake after a burst. Past it the bench
/// stops, since the next sleep would not be timed from a quiet start.
const RELEASE_LIMIT: Duration = Duration::from_secs(60);

/// How often a removal the host calls busy (still creating) is retried.
const REMOVE_ATTEMPTS: u32 = 50;

/// Starts the completion record the guest shell prints after a script:
/// the record separator, this text, the exit status in decimal and the
/// separator again. The script counts as done when the record arrives, not
/// when the stream closes: the guest's stream bridge may wait a while after
/// the shell exits before closing its side.
const RECORD_START: &[u8] = b"\x1ecompute-bench-done ";

/// Ends the completion record.
const RECORD_END: u8 = 0x1e;

/// The most digits an exit status has ("255").
const STATUS_DIGITS: usize = 3;

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

/// One script run inside a sandbox, timed from its release.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct Run {
    /// Microseconds the host spent waking the sandbox.
    pub(crate) waited_us: u64,
    /// Microseconds spent reaching the guest port after waking.
    pub(crate) connect_us: u64,
    /// Until the bench sent the request: its own lateness, included in the
    /// times below.
    #[serde(serialize_with = "micros")]
    pub(crate) dispatch_lag: Duration,
    /// Until the first byte the script printed, or `None` when it printed
    /// nothing.
    #[serde(serialize_with = "micros_if_some")]
    pub(crate) first_byte: Option<Duration>,
    /// Until the guest reported the script's exit status.
    #[serde(serialize_with = "micros")]
    pub(crate) done: Duration,
    /// The script's exit status.
    pub(crate) status: i32,
}

/// `compute-host exec`: wakes `id`, runs `script` on guest `port`, prints
/// its output and times, and fails unless it exits with status zero.
pub(crate) async fn exec(client: &Client, id: Id, port: u32, script: &str) -> anyhow::Result<()> {
    let run = run_script(client, id, port, script, Instant::now(), true).await?;
    eprintln!(
        "woke in {:?}, first byte {:?}, done {:?}",
        Duration::from_micros(run.waited_us),
        run.first_byte,
        run.done
    );
    if run.status != 0 {
        bail!("the script exited with status {}", run.status);
    }
    Ok(())
}

/// Wakes `id`, runs `script` in the shell on guest `port` and times it from
/// `started`; with `echo`, prints the output.
pub(crate) async fn run_script(
    client: &Client,
    id: Id,
    port: u32,
    script: &str,
    started: Instant,
    echo: bool,
) -> anyhow::Result<Run> {
    let dispatch_lag = started.elapsed();
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
        .write_all(framed(script).as_bytes())
        .await?;
    let mut buffer = Vec::new();
    let mut printed = 0;
    // The stream is the script's output, then the completion record, so
    // the first byte to arrive is the first byte of output, if there is
    // any; bytes held back until the record is told apart keep that time.
    let mut first_read = None;
    let mut chunk = [0_u8; 8192];
    let (printed, status, done) = loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            bail!("the guest closed the connection before the script ended");
        }
        first_read.get_or_insert_with(|| started.elapsed());
        buffer.extend_from_slice(&chunk[..read]);
        match scan(&buffer, printed)? {
            Scan::Running { output } => printed = output,
            Scan::Done { output, status } => break (output, status, started.elapsed()),
        }
    };
    let first_byte = first_read.filter(|_| printed > 0);
    // Let the guest close the stream, outside the timing, so the host has
    // let go of the sandbox before whatever the caller measures next. A
    // guest that never closes is caught by the release check before sleep.
    let _drained = tokio::time::timeout(DRAIN_LIMIT, async {
        tokio::io::copy(&mut stream, &mut tokio::io::sink()).await?;
        stream.get_mut().shutdown().await
    })
    .await;
    if echo {
        print!("{}", String::from_utf8_lossy(&buffer[..printed]));
    }
    Ok(Run {
        waited_us,
        connect_us,
        dispatch_lag,
        first_byte,
        done,
        status,
    })
}

/// What the guest shell receives for `script`. The script runs in a bash
/// of its own, so its `exit`, `exec` or syntax errors cannot swallow the
/// completion record, and without stdin, so it cannot read the lines after
/// it. Then the shell prints the record with the script's exit status and
/// ends the session.
fn framed(script: &str) -> String {
    // Inside single quotes only the quote itself needs care: end the quoted
    // text, add an escaped quote and start a new quoted text.
    let quoted = script.replace('\'', r"'\''");
    format!(
        "bash -c '{quoted}' </dev/null\nprintf '\\036compute-bench-done %d\\036' \"$?\"\nexit\n"
    )
}

/// How far a script's output has been read.
#[derive(Debug, PartialEq, Eq)]
enum Scan {
    /// The script still runs. The first `output` bytes are what it printed;
    /// any bytes after them may be the start of the completion record.
    Running { output: usize },
    /// The script printed `output` bytes and exited with `status`.
    Done { output: usize, status: i32 },
}

/// Looks for the completion record in `buffer` from `from` on: the `output`
/// of the previous scan, before which no record can start.
fn scan(buffer: &[u8], from: usize) -> anyhow::Result<Scan> {
    let tail = &buffer[from..];
    let Some(at) = find(tail, RECORD_START) else {
        // Hold back an ending that may still grow into the record.
        let held = (1..RECORD_START.len())
            .rev()
            .find(|&len| tail.ends_with(&RECORD_START[..len]))
            .unwrap_or(0);
        return Ok(Scan::Running {
            output: buffer.len() - held,
        });
    };
    let output = from + at;
    let rest = &buffer[output + RECORD_START.len()..];
    let malformed = |text: &[u8]| {
        anyhow!(
            "malformed completion record: {:?}",
            String::from_utf8_lossy(text)
        )
    };
    let Some(end) = rest.iter().position(|&byte| byte == RECORD_END) else {
        if rest.len() > STATUS_DIGITS {
            return Err(malformed(rest));
        }
        return Ok(Scan::Running { output });
    };
    let status = std::str::from_utf8(&rest[..end])
        .ok()
        .filter(|digits| !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|digits| digits.parse().ok())
        .ok_or_else(|| malformed(&rest[..end]))?;
    Ok(Scan::Done { output, status })
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
    // Every task parks first, then all are released at one instant they all
    // time from, so the bench's own scheduling delay counts against each
    // wake (and shows separately as `dispatch_lag`).
    let parked = Arc::new(Barrier::new(ids.len() + 1));
    let (release, released) = watch::channel(None::<Instant>);
    let mut tasks = JoinSet::new();
    for id in ids {
        let (client, parked, mut released, id, port, script) = (
            client.clone(),
            Arc::clone(&parked),
            released.clone(),
            *id,
            args.port,
            script.to_owned(),
        );
        tasks.spawn(async move {
            parked.wait().await;
            let started = (*released.wait_for(Option::is_some).await?).unwrap_or_else(Instant::now);
            run_script(&client, id, port, &script, started, false).await
        });
    }
    parked.wait().await;
    release.send_replace(Some(Instant::now()));
    let mut runs = Vec::new();
    let mut failed = Vec::new();
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok(Ok(run)) if run.status == 0 => runs.push(run),
            Ok(Ok(run)) => failed.push(format!("the script exited with status {}", run.status)),
            Ok(Err(error)) => failed.push(format!("{error:#}")),
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
        "  dispatch     {}",
        percentiles(pick(|run| run.dispatch_lag))
    );
    println!(
        "  host wake    {}",
        percentiles(pick(|run| Duration::from_micros(run.waited_us)))
    );
    println!(
        "  guest port   {}",
        percentiles(pick(|run| Duration::from_micros(run.connect_us)))
    );
    let first_bytes: Vec<_> = burst.runs.iter().filter_map(|run| run.first_byte).collect();
    let silent = burst.runs.len() - first_bytes.len();
    println!("  first byte   {}", percentiles(first_bytes));
    if silent > 0 {
        println!("               ({silent} printed nothing)");
    }
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

/// Waits until nothing holds any of `ids` (sorted) awake, a finished wake's
/// stream in particular, so the next sleep is timed from a quiet start.
/// Fails after [`RELEASE_LIMIT`]: a measurement from a busy start would be
/// wrong.
async fn wait_for_release(client: &Client, ids: &[Id]) -> anyhow::Result<()> {
    let started = Instant::now();
    loop {
        let status = status(client).await?;
        let held = status
            .sandboxes
            .iter()
            .filter(|sandbox| sandbox.holds > 0 && ids.binary_search(&sandbox.id).is_ok())
            .count();
        if held == 0 {
            return Ok(());
        }
        if started.elapsed() > RELEASE_LIMIT {
            bail!(
                "{held} sandboxes still held awake after {RELEASE_LIMIT:?}, \
                 so the next sleep could not be timed from a quiet start"
            );
        }
        tokio::time::sleep(POLL).await;
    }
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
    // Watch from the first request on, so a sandbox that settles while
    // others are still being asked gets its own time. The level is
    // reached when the last sandbox gets there, whenever the host got
    // round to answering every request.
    let ask = async {
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
        anyhow::Ok(started.elapsed())
    };
    let (accepted, reached) = tokio::try_join!(ask, wait_for_level(client, ids, level, started))?;
    let took = reached.iter().copied().max().unwrap_or_default();
    let after = status(client).await.ok();
    let memory = HostMemory::sample();
    let sleep = Sleep {
        label: label.to_owned(),
        took_us: micros_of(took),
        accepted_us: micros_of(accepted),
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
    println!("\n{label}: all there after {took:?}, all requests accepted after {accepted:?}");
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
    /// Until the host had accepted every request.
    accepted_us: u64,
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
    create_us: Option<u64>,
    phases: Vec<Phase>,
    /// What went wrong: why the bench stopped early, or why cleaning up
    /// failed. Empty after a clean run.
    errors: Vec<String>,
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
    let mut results = Results {
        count: args.count,
        vcpus: args.vcpus,
        memory_mib: args.memory_mib,
        baseline: HostMemory::sample(),
        create_us: None,
        phases: Vec::new(),
        errors: Vec::new(),
    };
    let outcome = run(client, args, &ids, &mut results).await;
    // Whatever failed, the sandboxes go, so they cannot skew the next run.
    let removed = if args.keep {
        Ok(())
    } else {
        remove_all(client, &ids).await.context("cleaning up")
    };
    results.errors = [outcome, removed]
        .into_iter()
        .filter_map(Result::err)
        .map(|error| format!("{error:#}"))
        .collect();
    if let Some(path) = &args.json {
        let written = serde_json::to_vec_pretty(&results)
            .map_err(anyhow::Error::from)
            .and_then(|json| {
                std::fs::write(path, json).with_context(|| format!("writing {}", path.display()))
            });
        if let Err(error) = written {
            results.errors.push(format!("{error:#}"));
        }
    }
    match results.errors.as_slice() {
        [] => Ok(()),
        errors => bail!("{}", errors.join("\n")),
    }
}

/// Creates the sandboxes and runs every phase, recording each in `results`
/// as it finishes.
async fn run(
    client: &Client,
    args: &BenchArgs,
    ids: &[Id],
    results: &mut Results,
) -> anyhow::Result<()> {
    // Sandboxes only sleep when the bench asks, so each phase is timed on
    // its own; idle timers would start steps at unpredictable moments.
    let config = SandboxConfig {
        vcpus: args.vcpus,
        memory_mib: args.memory_mib,
        sleep: SleepConfig::default(),
    };
    let started = Instant::now();
    let mut creates = JoinSet::new();
    for id in ids {
        let (client, id, config) = (client.clone(), *id, config.clone());
        creates.spawn(async move { client.call(&Request::Create { id, config }).await });
    }
    // Every create finishes before anything else happens, failed or not,
    // so cleanup never races one still in flight.
    let mut failures = Vec::new();
    while let Some(result) = creates.join_next().await {
        if let Err(error) = result
            .map_err(anyhow::Error::from)
            .and_then(|reply| expect_done(reply?))
        {
            failures.push(format!("{error:#}"));
        }
    }
    if let Some(first) = failures.first() {
        bail!(
            "{} of {} creates failed, first: {first}",
            failures.len(),
            ids.len()
        );
    }
    let create = started.elapsed();
    results.create_us = Some(micros_of(create));
    println!("created {} sandboxes in {create:?}", ids.len());

    let level = args.level.level();
    results.phases.push(Phase::Wake(
        burst(client, ids, args, &args.warm, "first wake (boot)").await,
    ));
    for round in 1..=args.rounds {
        tokio::time::sleep(args.settle).await;
        wait_for_release(client, ids).await?;
        let label = format!("round {round}: sleep to {level:?}");
        results.phases.push(Phase::Sleep(
            put_to_sleep(client, ids, level, &label, results.baseline).await?,
        ));
        let label = format!("round {round}: wake from {level:?}");
        results.phases.push(Phase::Wake(
            burst(client, ids, args, &args.script, &label).await,
        ));
    }
    Ok(())
}

/// Removes every sandbox in `ids`, created or not: one the host never
/// created counts as removed, one it is still creating is retried. Every
/// removal finishes before this returns, and every failure is reported.
async fn remove_all(client: &Client, ids: &[Id]) -> anyhow::Result<()> {
    let mut removes = JoinSet::new();
    for id in ids {
        let (client, id) = (client.clone(), *id);
        removes.spawn(async move {
            for _ in 0..REMOVE_ATTEMPTS {
                let request = Request::Remove {
                    id,
                    generation: None,
                };
                match client.call(&request).await? {
                    Reply::Error {
                        code: ErrorCode::Busy,
                        ..
                    } => tokio::time::sleep(Duration::from_millis(100)).await,
                    Reply::Done
                    | Reply::Error {
                        code: ErrorCode::NotFound,
                        ..
                    } => return Ok(()),
                    other => bail!("removing {id:?}: {other:?}"),
                }
            }
            bail!("removing {id:?}: still busy after {REMOVE_ATTEMPTS} attempts")
        });
    }
    let mut failures = Vec::new();
    while let Some(result) = removes.join_next().await {
        if let Err(error) = result
            .map_err(anyhow::Error::from)
            .and_then(|removed| removed)
        {
            failures.push(format!("{error:#}"));
        }
    }
    match failures.first() {
        None => Ok(()),
        Some(first) => bail!(
            "{} of {} removals failed, first: {first}",
            failures.len(),
            ids.len()
        ),
    }
}

fn micros_of(duration: Duration) -> u64 {
    u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
}

fn micros<S: serde::Serializer>(duration: &Duration, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_u64(micros_of(*duration))
}

#[allow(clippy::ref_option, reason = "serde hands fields over by reference")]
fn micros_if_some<S: serde::Serializer>(
    duration: &Option<Duration>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match duration {
        Some(duration) => serializer.serialize_some(&micros_of(*duration)),
        None => serializer.serialize_none(),
    }
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
    fn scan_finds_the_record_and_its_status() {
        assert_eq!(
            scan(b"out\n\x1ecompute-bench-done 0\x1e", 0).unwrap(),
            Scan::Done {
                output: 4,
                status: 0
            }
        );
        assert_eq!(
            scan(b"\x1ecompute-bench-done 127\x1e", 0).unwrap(),
            Scan::Done {
                output: 0,
                status: 127
            }
        );
    }

    #[test]
    fn scan_holds_back_what_may_become_the_record() {
        // A record split across reads is neither output nor done yet.
        assert_eq!(
            scan(b"out\x1ecompute-be", 0).unwrap(),
            Scan::Running { output: 3 }
        );
        assert_eq!(
            scan(b"out\x1ecompute-bench-done 1", 0).unwrap(),
            Scan::Running { output: 3 }
        );
        // Output that only looks like the start for a while is released.
        assert_eq!(
            scan(b"out\x1ecompute-x", 0).unwrap(),
            Scan::Running { output: 13 }
        );
        // Nothing printed yet: no first byte.
        assert_eq!(scan(b"\x1e", 0).unwrap(), Scan::Running { output: 0 });
    }

    #[test]
    fn scan_resumes_where_the_last_one_stopped() {
        let mut buffer = b"abc\x1ecompute-bench".to_vec();
        let Scan::Running { output } = scan(&buffer, 0).unwrap() else {
            panic!("not done yet");
        };
        assert_eq!(output, 3);
        buffer.extend_from_slice(b"-done 3\x1e");
        assert_eq!(
            scan(&buffer, output).unwrap(),
            Scan::Done {
                output: 3,
                status: 3
            }
        );
    }

    #[test]
    fn scan_rejects_a_malformed_record() {
        assert!(scan(b"\x1ecompute-bench-done x\x1e", 0).is_err());
        assert!(scan(b"\x1ecompute-bench-done \x1e", 0).is_err());
        assert!(scan(b"\x1ecompute-bench-done 1234", 0).is_err());
    }

    /// Feeds `script`, framed, to a real shell, as the guest's would get it.
    fn run_framed(script: &str) -> (String, i32) {
        use std::io::Write as _;
        let mut shell = std::process::Command::new("sh")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        shell
            .stdin
            .take()
            .unwrap()
            .write_all(framed(script).as_bytes())
            .unwrap();
        let stdout = shell.wait_with_output().unwrap().stdout;
        let Scan::Done { output, status } = scan(&stdout, 0).unwrap() else {
            panic!("no completion record in {stdout:?}");
        };
        (
            String::from_utf8(stdout[..output].to_vec()).unwrap(),
            status,
        )
    }

    #[test]
    fn the_record_carries_the_scripts_exit_status() {
        assert_eq!(run_framed("echo hi"), ("hi\n".into(), 0));
        assert_eq!(run_framed("false"), (String::new(), 1));
        assert_eq!(run_framed("echo partial; exit 7"), ("partial\n".into(), 7));
    }

    #[test]
    fn exit_exec_and_syntax_errors_cannot_swallow_the_record() {
        assert_eq!(run_framed("exit 0"), (String::new(), 0));
        assert_eq!(run_framed("exec echo replaced"), ("replaced\n".into(), 0));
        assert_ne!(run_framed("if then fi").1, 0);
    }

    #[test]
    fn scripts_keep_their_quotes_and_cannot_read_the_lines_after_them() {
        assert_eq!(run_framed("echo 'a  b' \"c'd\""), ("a  b c'd\n".into(), 0));
        // Reading stdin finds nothing instead of the record's own lines.
        assert_eq!(run_framed("cat; echo after"), ("after\n".into(), 0));
    }

    #[test]
    fn scripts_run_under_bash_whatever_the_outer_shell() {
        assert_eq!(
            run_framed("for i in {1..3}; do printf x; done"),
            ("xxx".into(), 0)
        );
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
