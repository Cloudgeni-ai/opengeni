//! The canary ([ADR 16]): a small sandbox of the host's own that goes
//! through every way a sandbox wakes, one path per run, each within a
//! timeout, and reports how each went.
//!
//! The paths, in turn: resume from memory (put to sleep paused, then
//! woken), restore from the local disk (dropped from memory first), wake
//! from object storage (the local copy evicted first; only on a host with
//! a store), and a fresh create from the deployed image, which is removed
//! again. With a guest port set, each wake also connects to it, so the
//! guest has to answer, not just its VM run.
//!
//! Each run emits a `compute.canary` event and counts in the canary
//! metrics, whose last-run time per path lets the monitoring side alert
//! when results stop arriving: that also catches a dead or stuck agent.
//! The canary asks at background priority, so it never jumps ahead of a
//! sandbox someone waits on.
//!
//! [ADR 16]: https://github.com/Cloudgeni-ai/opengeni/blob/main/compute/docs/adr/0016-observability.md

use std::time::Duration;

use compute_core::{Level, OpId, Priority, SandboxId};
use tokio::time::Instant;

use super::{CanaryOutcome, CanaryPath, Event, Severity, unix_nanos_now};
use crate::agent::{Handle, HostError};
use crate::protocol::{Id, SandboxConfig, SleepConfig};

/// The canary's own sandbox, which every path but a create uses. It never
/// sleeps by its own settings: the canary puts it to sleep.
pub const SANDBOX: Id = Id(SandboxId(0xca4a_7900_0000_0000_0000_0000_0000_0001));
/// The sandbox a create path makes, and removes again.
pub const FRESH: Id = Id(SandboxId(0xca4a_7900_0000_0000_0000_0000_0000_0002));

/// How the canary runs.
#[derive(Clone, Debug)]
pub struct CanaryConfig {
    /// How often a run starts.
    pub every: Duration,
    /// How long one run may take, sleeping included.
    pub timeout: Duration,
    /// A guest port each wake connects to, if set.
    pub port: Option<u32>,
    /// Its sandboxes' memory.
    pub memory_mib: u32,
    /// Whether the host has a store, so the remote path can run.
    pub remote: bool,
}

impl CanaryConfig {
    /// Runs every `every`, five minutes each at most, with 128 MiB
    /// sandboxes and no guest port.
    #[must_use]
    pub fn new(every: Duration, remote: bool) -> Self {
        Self {
            every,
            timeout: Duration::from_secs(300),
            port: None,
            memory_mib: 128,
            remote,
        }
    }

    /// The paths it takes, in order.
    #[must_use]
    pub fn paths(&self) -> Vec<CanaryPath> {
        CanaryPath::ALL
            .into_iter()
            .filter(|path| self.remote || *path != CanaryPath::Remote)
            .collect()
    }

    fn sandbox(&self) -> SandboxConfig {
        SandboxConfig::new(1, self.memory_mib, SleepConfig::default())
    }
}

/// What a path that worked measured.
#[derive(Debug)]
struct Woken {
    sandbox: Id,
    /// How long its wake took.
    wake: Duration,
    /// How long reaching the guest port took after that.
    connect: Option<Duration>,
    /// The wake step's operation id.
    op: Option<OpId>,
}

/// Runs the canary until the agent stops.
pub async fn run(handle: Handle, config: CanaryConfig) {
    let paths = config.paths();
    let mut tick = tokio::time::interval(config.every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    for path in paths.into_iter().cycle() {
        tick.tick().await;
        let started = Instant::now();
        let ran = tokio::time::timeout(config.timeout, run_path(&handle, &config, path)).await;
        let took = started.elapsed();
        let result = match ran {
            Ok(Ok(woken)) => Ok(woken),
            Ok(Err(HostError::Stopped)) => return,
            Ok(Err(error)) => Err((CanaryOutcome::Failed, error.to_string())),
            Err(_) => Err((
                CanaryOutcome::TimedOut,
                format!("not done within {} s", config.timeout.as_secs()),
            )),
        };
        report(&handle, path, took, &result);
        // A broken canary sandbox is made again from scratch next time.
        let broken = matches!(&result, Err((_, error)) if error.contains("broken"));
        if path == CanaryPath::Create || broken {
            let id = if path == CanaryPath::Create {
                FRESH
            } else {
                SANDBOX
            };
            let removed = tokio::time::timeout(config.timeout, handle.remove(id, None)).await;
            if let Ok(Err(error)) = removed
                && !matches!(error, HostError::NotFound(_))
            {
                tracing::warn!(%id, %error, "canary sandbox not removed");
            }
        }
    }
}

async fn run_path(
    handle: &Handle,
    config: &CanaryConfig,
    path: CanaryPath,
) -> Result<Woken, HostError> {
    let level = match path {
        CanaryPath::Create => {
            // One a crashed run left goes first.
            match handle.remove(FRESH, None).await {
                Ok(()) | Err(HostError::NotFound(_)) => {}
                Err(error) => return Err(error),
            }
            handle.create(FRESH, config.sandbox()).await?;
            return wake(handle, FRESH, config.port).await;
        }
        CanaryPath::Resume => Level::Paused,
        CanaryPath::Restore => Level::Saved,
        CanaryPath::Remote => Level::Remote,
    };
    match handle.create(SANDBOX, config.sandbox()).await {
        Ok(()) | Err(HostError::Exists(_)) => {}
        Err(error) => return Err(error),
    }
    // Awake first, so every run of a path starts from the same place.
    drop(handle.acquire(SANDBOX, None, Priority::Background).await?);
    handle.sleep(SANDBOX, None, level).await?;
    reach(handle, SANDBOX, level).await?;
    wake(handle, SANDBOX, config.port).await
}

/// Waits until `id` is at `level` with no step under way.
async fn reach(handle: &Handle, id: Id, level: Level) -> Result<(), HostError> {
    loop {
        match handle.inspect(id).await? {
            Some((at, None)) if at == level => return Ok(()),
            Some(_) => tokio::time::sleep(Duration::from_millis(25)).await,
            None => return Err(HostError::NotFound(id)),
        }
    }
}

/// Wakes `id` and, with a `port`, connects to it.
async fn wake(handle: &Handle, id: Id, port: Option<u32>) -> Result<Woken, HostError> {
    let mut lease = handle.acquire(id, None, Priority::Background).await?;
    let connect = match port {
        Some(port) => {
            let started = Instant::now();
            // The run's own timeout bounds this sooner.
            drop(lease.connect(port, Duration::from_secs(3600)).await?);
            Some(started.elapsed())
        }
        None => None,
    };
    Ok(Woken {
        sandbox: id,
        wake: lease.waited(),
        connect,
        op: lease.op(),
    })
}

fn report(
    handle: &Handle,
    path: CanaryPath,
    took: Duration,
    result: &Result<Woken, (CanaryOutcome, String)>,
) {
    let outcome = match result {
        Ok(_) => CanaryOutcome::Ok,
        Err((outcome, _)) => *outcome,
    };
    let unix_ms = unix_nanos_now() / 1_000_000;
    handle
        .observer()
        .metrics()
        .canary(path, outcome, took, unix_ms);
    let severity = if outcome == CanaryOutcome::Ok {
        Severity::Info
    } else {
        Severity::Error
    };
    let mut event = Event::new("compute.canary", severity)
        .with("compute.canary.path", path.name())
        .with("compute.outcome", outcome.name())
        .with("compute.duration_us", took);
    match result {
        Ok(woken) => {
            event = event
                .with("compute.sandbox.id", woken.sandbox.to_string())
                .with("compute.wake_us", woken.wake)
                .with_some("compute.connect_us", woken.connect)
                .with_some("compute.op.id", woken.op.map(|op| op.0));
        }
        Err((_, error)) => {
            tracing::warn!(path = path.name(), outcome = outcome.name(), %error, "canary run failed");
            event = event.with("compute.error", error.clone());
        }
    }
    handle.observer().emit(event);
}
