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
//! Hosts may share a store, so each host's canary sandboxes have ids of
//! their own, made up once and kept in the agent's state root.
//!
//! [ADR 16]: https://github.com/Cloudgeni-ai/opengeni/blob/main/compute/docs/adr/0016-observability.md

use std::io::{self, Read, Write};
use std::path::Path;
use std::time::Duration;

use compute_core::{Level, OpId, Priority, SandboxId};
use tokio::time::Instant;

use super::{CanaryOutcome, CanaryPath, Event, Severity, unix_nanos_now};
use crate::agent::{Handle, HostError};
use crate::protocol::{Id, SandboxConfig, SleepConfig};

/// The file in the state root that keeps the host's canary ids.
const IDS_FILE: &str = "canary-id";

/// One host's canary sandboxes. Their ids start with `ca4a79`, then the
/// host's own 64 bits, then `01` or `02`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CanaryIds {
    /// The sandbox every path but a create uses. It never sleeps by its
    /// own settings: the canary puts it to sleep.
    pub sandbox: Id,
    /// The sandbox a create path makes, and removes again.
    pub fresh: Id,
}

impl CanaryIds {
    /// The ids for the host with these 64 bits.
    #[must_use]
    pub fn for_bits(host: u64) -> Self {
        let base = (0x00ca_4a79_u128 << 104) | (u128::from(host) << 8);
        Self {
            sandbox: Id(SandboxId(base | 1)),
            fresh: Id(SandboxId(base | 2)),
        }
    }

    /// The ids of the host whose agent keeps its state in `root`: made up
    /// at random the first time and kept there, so a restarted agent finds
    /// its canary sandbox again. Two agents starting at once on the same
    /// root agree: the first to publish its ids wins, and the other reads
    /// them.
    ///
    /// # Errors
    ///
    /// When the file cannot be read or written, or holds something else.
    pub fn for_host(root: &Path) -> io::Result<Self> {
        let path = root.join(IDS_FILE);
        match Self::read(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            read => return read,
        }
        let mut bits = [0; 8];
        std::fs::File::open("/dev/urandom")?.read_exact(&mut bits)?;
        let bits = u64::from_le_bytes(bits);
        std::fs::create_dir_all(root)?;
        // Written whole under a name of its own, then linked into place,
        // which never replaces ids already there.
        let partial = root.join(format!("{IDS_FILE}.{bits:016x}.partial"));
        let written = (|| {
            let mut file = std::fs::File::create_new(&partial)?;
            writeln!(file, "{bits:016x}")?;
            file.sync_all()?;
            std::fs::hard_link(&partial, &path)
        })();
        let _ = std::fs::remove_file(&partial);
        match written {
            Ok(()) => {
                std::fs::File::open(root)?.sync_all()?;
                Ok(Self::for_bits(bits))
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Self::read(&path),
            Err(error) => Err(error),
        }
    }

    /// The ids kept at `path`.
    fn read(path: &Path) -> io::Result<Self> {
        let text = std::fs::read_to_string(path)?;
        let bits = u64::from_str_radix(text.trim(), 16).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{}: {error}", path.display()),
            )
        })?;
        Ok(Self::for_bits(bits))
    }
}

/// How the canary runs.
#[derive(Clone, Debug)]
pub struct CanaryConfig {
    /// How often a run starts; more than zero.
    pub every: Duration,
    /// How long one run may take, sleeping included.
    pub timeout: Duration,
    /// A guest port each wake connects to, if set.
    pub port: Option<u32>,
    /// Its sandboxes' memory.
    pub memory_mib: u32,
    /// Whether the host has a store, so the remote path can run.
    pub remote: bool,
    /// Its sandboxes.
    pub ids: CanaryIds,
}

impl CanaryConfig {
    /// Runs every `every`, five minutes each at most, with 128 MiB
    /// sandboxes `ids` and no guest port.
    #[must_use]
    pub fn new(every: Duration, remote: bool, ids: CanaryIds) -> Self {
        Self {
            every,
            timeout: Duration::from_secs(300),
            port: None,
            memory_mib: 128,
            remote,
            ids,
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
    // A zero period would panic; settings refuse it before this.
    let mut tick = tokio::time::interval(config.every.max(Duration::from_millis(1)));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let CanaryIds { sandbox, fresh } = config.ids;
    for path in paths.into_iter().cycle() {
        tick.tick().await;
        let started = Instant::now();
        let ran = tokio::time::timeout(config.timeout, run_path(&handle, &config, path)).await;
        let took = started.elapsed();
        // A broken canary sandbox is made again from scratch next time.
        let broken = matches!(ran, Ok(Err(HostError::Broken(_))));
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
        if path == CanaryPath::Create || broken {
            let id = if path == CanaryPath::Create {
                fresh
            } else {
                sandbox
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
    let CanaryIds { sandbox, fresh } = config.ids;
    let level = match path {
        CanaryPath::Create => {
            // One a crashed run left goes first.
            match handle.remove(fresh, None).await {
                Ok(()) | Err(HostError::NotFound(_)) => {}
                Err(error) => return Err(error),
            }
            handle.create(fresh, config.sandbox()).await?;
            return wake(handle, fresh, None, config.port).await;
        }
        CanaryPath::Resume => Level::Paused,
        CanaryPath::Restore => Level::Saved,
        CanaryPath::Remote => Level::Remote,
    };
    match handle.create(sandbox, config.sandbox()).await {
        Ok(()) | Err(HostError::Exists(_)) => {}
        Err(error) => return Err(error),
    }
    // Awake first, so every run of a path starts from the same place. The
    // wake must come back to this execution: a sandbox booted afresh
    // instead lost what ran in it, which is a failure, not a slow success.
    let generation = handle
        .acquire(sandbox, None, Priority::Background)
        .await?
        .generation();
    handle.sleep(sandbox, Some(generation), level).await?;
    reach(handle, sandbox, level).await?;
    wake(handle, sandbox, Some(generation), config.port).await
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

/// Wakes `id`, at `generation` if given, and, with a `port`, connects to
/// it.
async fn wake(
    handle: &Handle,
    id: Id,
    generation: Option<u64>,
    port: Option<u32>,
) -> Result<Woken, HostError> {
    let mut lease = handle.acquire(id, generation, Priority::Background).await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn root(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("canary-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    #[test]
    fn each_host_keeps_canary_ids_of_its_own() {
        let (first, second) = (root("first"), root("second"));
        let ids = CanaryIds::for_host(&first).unwrap();
        assert_eq!(
            CanaryIds::for_host(&first).unwrap(),
            ids,
            "kept across restarts"
        );
        let other = CanaryIds::for_host(&second).unwrap();
        assert_ne!(other.sandbox, ids.sandbox, "two hosts sharing a store");
        assert_ne!(other.fresh, ids.fresh);
        for id in [ids.sandbox, ids.fresh, other.sandbox, other.fresh] {
            assert!(id.to_string().starts_with("ca4a79"), "{id}");
        }
        assert_ne!(ids.sandbox, ids.fresh);

        // Something else in the file is refused, not replaced: that would
        // leave the old canary sandbox behind.
        std::fs::write(first.join(IDS_FILE), "not hex\n").unwrap();
        assert!(CanaryIds::for_host(&first).is_err());
        for root in [first, second] {
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn the_ids_carry_the_host_bits() {
        let ids = CanaryIds::for_bits(0x0123_4567_89ab_cdef);
        assert_eq!(ids.sandbox.0.0, 0xca4a_7900_0000_0001_2345_6789_abcd_ef01);
        assert_eq!(ids.fresh.0.0, 0xca4a_7900_0000_0001_2345_6789_abcd_ef02);
    }

    #[test]
    fn agents_starting_at_once_agree_on_the_ids() {
        for round in 0..20 {
            let root = root(&format!("race-{round}"));
            let start = std::sync::Barrier::new(8);
            let found: Vec<CanaryIds> = std::thread::scope(|scope| {
                let racers: Vec<_> = (0..8)
                    .map(|_| {
                        scope.spawn(|| {
                            start.wait();
                            CanaryIds::for_host(&root).unwrap()
                        })
                    })
                    .collect();
                racers
                    .into_iter()
                    .map(|racer| racer.join().unwrap())
                    .collect()
            });
            let kept = CanaryIds::for_host(&root).unwrap();
            assert!(
                found.iter().all(|ids| *ids == kept),
                "round {round}: {found:?}"
            );
            let left: Vec<_> = std::fs::read_dir(&root)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            assert_eq!(left, [IDS_FILE], "round {round}: nothing else is left");
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
