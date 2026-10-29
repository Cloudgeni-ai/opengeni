//! The guard's fence on a machine the host shares (ADR 26).
//!
//! On a machine of its own, the guard feeds the machine's watchdog, which
//! resets the machine if the guard ends or stalls ([`super::kept`]). On a
//! machine it shares, such as a hypervisor that also runs other VMs, that
//! reset would end their work too. There the guard feeds systemd's
//! watchdog of its own service instead ([`ServiceWatchdog`]: `WatchdogSec=`
//! of at most the lease terms' watchdog timeout), and the service's stop
//! hook ([`guard_stopped`], its `ExecStopPost=`) does to the VMs what the
//! reset would: it kills every one, and restarts the agent if it runs, so
//! that a new guard starts with it. systemd kills a guard that stops
//! feeding it (`WatchdogSignal=SIGKILL`), and one that does not end within
//! the same timeout of being asked to stop (`TimeoutStopSec=`), so the hook
//! runs within that timeout of the last feed, whatever stopped the guard.
//!
//! The hook kills the VMs after every end of the guard but one: a hand-over
//! to a new release's guard. An upgrade marks it ([`mark_hand_over`],
//! `compute-host hand-over-guard`) and restarts the guard's service; the
//! old guard ends at a step that may feed its watchdog, as asked to stop
//! it always does, and a hook that finds it ended so (`SERVICE_RESULT`
//! `success`) within [`HAND_OVER_WITHIN`] of the mark leaves the VMs to
//! the new guard, which systemd starts next and which must feed its own
//! watchdog within the timeout, as every guard must. The hook takes the
//! mark whatever it decides, so it serves one hand-over only.
//!
//! What this does not cover: systemd itself. A guard that stalls while
//! systemd (the service manager, PID 1) stalls too is never killed, so a
//! shared machine should have systemd feed a hardware watchdog
//! (`RuntimeWatchdogSec=`), which resets the machine if systemd stops.

use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{bail, ensure};
use compute_core::At;
use compute_engine::cgroup::Cgroup;

use super::gate::{boot_now, nanos};
use super::kept;

/// How long after it is marked a hand-over of the guard stays good: long
/// enough for systemd to ask the guard to stop and for the guard to reach
/// a step that may feed its watchdog, which takes one step while the lease
/// is valid.
pub const HAND_OVER_WITHIN: Duration = Duration::from_secs(10);

/// How long the stop hook waits for the VMs it killed to be gone before it
/// restarts the agent all the same.
const GONE_WITHIN: Duration = Duration::from_secs(10);

/// How often the stop hook looks whether the VMs are gone.
const LOOK_EVERY: Duration = Duration::from_millis(50);

/// systemd's watchdog of the guard's own service, which the guard of a host
/// that shares its machine feeds instead of the machine's.
#[derive(Debug)]
pub struct ServiceWatchdog {
    /// systemd's notification socket.
    socket: String,
    /// Whether a feed has got through.
    fed: bool,
    /// Whether the last feed failed, so a failure is said once.
    failing: bool,
}

impl ServiceWatchdog {
    /// The watchdog systemd set up for this process, as its
    /// `NOTIFY_SOCKET`, `WATCHDOG_PID` and `WATCHDOG_USEC` say.
    ///
    /// # Errors
    ///
    /// When systemd set none up for it, or one with a timeout longer than
    /// `timeout`, the lease terms' watchdog timeout.
    pub fn from_env(timeout: Duration) -> anyhow::Result<Self> {
        let var = |name: &str| std::env::var(name).ok();
        Self::new(
            var("NOTIFY_SOCKET"),
            var("WATCHDOG_PID").as_deref(),
            var("WATCHDOG_USEC").as_deref(),
            std::process::id(),
            timeout,
        )
    }

    /// The watchdog of process `own`, given systemd's notification socket
    /// `socket`, and the process (`pid`) and timeout in microseconds
    /// (`usec`) systemd set it up for.
    fn new(
        socket: Option<String>,
        pid: Option<&str>,
        usec: Option<&str>,
        own: u32,
        timeout: Duration,
    ) -> anyhow::Result<Self> {
        let Some(socket) = socket else {
            bail!(
                "not run by systemd, whose watchdog of its service the guard of a shared machine feeds"
            );
        };
        if let Some(pid) = pid {
            ensure!(
                pid.parse::<u32>().ok() == Some(own),
                "systemd's watchdog is set up for process {pid}, not this guard ({own})"
            );
        }
        let Some(set) = usec.and_then(|usec| usec.parse::<u64>().ok()) else {
            bail!(
                "the guard's service sets no watchdog: on a shared machine it needs WatchdogSec= of at most {} s",
                timeout.as_secs()
            );
        };
        let set = Duration::from_micros(set);
        ensure!(
            !set.is_zero() && set <= timeout,
            "the guard's service sets WatchdogSec= to {} ms, more than the lease terms' {} ms: its VMs could run that much longer past their lease",
            set.as_millis(),
            timeout.as_millis()
        );
        Ok(Self {
            socket,
            fed: false,
            failing: false,
        })
    }

    /// Feeds it, without waiting for systemd. A feed that does not get
    /// through is said once; if none does within the timeout, systemd
    /// kills the guard and the stop hook kills the VMs.
    pub fn feed(&mut self) {
        match kept::ping(&self.socket) {
            Ok(()) => {
                self.fed = true;
                if std::mem::take(&mut self.failing) {
                    tracing::info!("the guard feeds its service's watchdog again");
                }
            }
            Err(error) => {
                if !std::mem::replace(&mut self.failing, true) {
                    tracing::error!(
                        %error,
                        "the guard could not feed its service's watchdog: unless a feed gets through, systemd kills it and its stop hook kills every VM"
                    );
                }
            }
        }
    }

    /// Whether a feed has got through.
    #[must_use]
    pub fn fed(&self) -> bool {
        self.fed
    }
}

/// The mark of a hand-over of the guard whose lock is `lock`, beside it.
#[must_use]
pub fn hand_over_mark(lock: &Path) -> PathBuf {
    let mut name = lock.file_name().unwrap_or_default().to_owned();
    name.push(".handover");
    lock.with_file_name(name)
}

/// Marks a hand-over of the guard at `mark`, good for [`HAND_OVER_WITHIN`]
/// from now on the boot clock.
///
/// # Errors
///
/// When the mark cannot be written.
pub fn mark_hand_over(mark: &Path) -> io::Result<()> {
    if let Some(dir) = mark.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let staging = mark.with_extension("handover.staging");
    std::fs::write(
        &staging,
        format!("{}\n", nanos(boot_now() + HAND_OVER_WITHIN)),
    )?;
    std::fs::rename(&staging, mark)
}

/// Takes the mark at `mark`: until when the hand-over it marks is good, if
/// there is one that can be read. The mark is gone afterwards either way.
fn take_hand_over(mark: &Path) -> Option<At> {
    let text = std::fs::read_to_string(mark).ok();
    if let Err(error) = std::fs::remove_file(mark)
        && error.kind() != io::ErrorKind::NotFound
    {
        tracing::warn!(%error, mark = %mark.display(), "could not remove the hand-over mark");
    }
    let deadline = text?.trim().parse::<u64>().ok()?;
    Some(At::from_duration(Duration::from_nanos(deadline)))
}

/// Whether the VMs stay for the next guard after a guard ended with
/// systemd's `result` (its `SERVICE_RESULT`), with a hand-over marked
/// good until `handed` if one was, at `now`: only a guard that ended of
/// its own accord, which it does only at a step that may feed its
/// watchdog, within a hand-over leaves them.
#[must_use]
pub fn hands_over(result: Option<&str>, handed: Option<At>, now: At) -> bool {
    result == Some("success") && handed.is_some_and(|until| now < until)
}

/// What the guard service's stop hook works on.
#[derive(Clone, Debug)]
pub struct StopHook {
    /// The cgroup that holds every VM.
    pub cgroup: PathBuf,
    /// The hand-over mark ([`hand_over_mark`]).
    pub mark: PathBuf,
    /// The agent's service, restarted if it runs.
    pub agent: String,
}

/// The guard service's stop hook (`compute-host guard-stopped`, its
/// `ExecStopPost=` on a shared machine), run after every end of the guard:
/// unless the guard was handed over, it kills every VM, waits up to
/// [`GONE_WITHIN`] for them to be gone, and restarts the agent if it runs,
/// which starts a new guard with it. It says what it did; a VM it could
/// not kill is an error.
///
/// # Errors
///
/// When the VMs could not be killed, or are still there after
/// [`GONE_WITHIN`].
pub fn guard_stopped(hook: &StopHook) -> anyhow::Result<()> {
    let result = std::env::var("SERVICE_RESULT").ok();
    let handed = take_hand_over(&hook.mark);
    let now = boot_now();
    if hands_over(result.as_deref(), handed, now) {
        tracing::info!("the guard was handed over: its VMs stay for the next guard");
        return Ok(());
    }
    tracing::warn!(
        result = result.as_deref().unwrap_or("unknown"),
        hand_over = match handed {
            None => "none marked",
            Some(until) if until <= now => "marked, but expired",
            Some(_) => "marked, but the guard did not end of its own accord",
        },
        "the guard ended: killing every VM, as a reset of the machine would, and restarting the agent"
    );
    let gone = kill_every_vm(&Cgroup::at(&hook.cgroup), GONE_WITHIN);
    restart_agent(&hook.agent);
    gone
}

/// Kills every process in `cgroup` and its groups, and waits up to
/// `within` for them to be gone.
fn kill_every_vm(cgroup: &Cgroup, within: Duration) -> anyhow::Result<()> {
    let started = Instant::now();
    loop {
        match cgroup.freezer() {
            Ok(state) if state.empty => {
                tracing::info!(took = ?started.elapsed(), "every VM is gone");
                return Ok(());
            }
            Ok(_) => {}
            Err(error) => tracing::warn!(%error, "reading the VMs' cgroup failed"),
        }
        if started.elapsed() >= within {
            bail!(
                "the VMs' cgroup {} still holds processes {} s after they were killed",
                cgroup.path().display(),
                within.as_secs()
            );
        }
        // Again at every look: a VM the agent started meanwhile goes too.
        if let Err(error) = cgroup.kill_all() {
            tracing::error!(%error, "killing the VMs failed");
        }
        std::thread::sleep(LOOK_EVERY);
    }
}

/// Restarts the agent's service `agent` if it runs, without waiting: its
/// start starts a new guard, which it requires. A service stopped on
/// purpose (the guard stopped along with it, or the machine shutting down)
/// stays stopped.
fn restart_agent(agent: &str) {
    match kept::systemctl(&["try-restart", "--no-block", agent]) {
        Ok(output) if output.status.success() => {
            tracing::info!(agent, "restarting the agent, if it ran, with a new guard");
        }
        Ok(output) => tracing::warn!(
            agent,
            stderr = %String::from_utf8_lossy(&output.stderr).trim(),
            "the agent was not restarted"
        ),
        Err(error) => tracing::warn!(%error, agent, "the agent was not restarted"),
    }
}

/// Hands the guard of service `unit`, whose lock is `lock`, over to the
/// installed release's: marks the hand-over and restarts the service,
/// waiting for systemd to have done so (`compute-host hand-over-guard`).
///
/// # Errors
///
/// When the mark cannot be written or systemd fails the restart.
pub fn hand_over_guard(lock: &Path, unit: &str) -> anyhow::Result<()> {
    let mark = hand_over_mark(lock);
    mark_hand_over(&mark)
        .map_err(|error| anyhow::anyhow!("marking {}: {error}", mark.display()))?;
    let output = kept::systemctl(&["restart", unit])?;
    ensure!(
        output.status.success(),
        "systemctl restart {unit} failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    tracing::info!(unit, "the guard was handed over to the installed release's");
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::os::unix::net::UnixDatagram;

    use super::*;

    const W: Duration = Duration::from_secs(3);

    /// The guard takes systemd's watchdog only as systemd set it up for
    /// the guard itself, with a timeout no longer than the lease terms'.
    #[test]
    fn the_service_watchdog_must_be_the_guard_s_and_no_longer_than_the_terms() {
        let socket = || Some("/run/systemd/notify".to_owned());
        let watchdog = |socket, pid, usec| ServiceWatchdog::new(socket, pid, usec, 42, W);
        assert!(watchdog(socket(), Some("42"), Some("3000000")).is_ok());
        assert!(watchdog(socket(), None, Some("1500000")).is_ok());
        assert!(
            watchdog(None, Some("42"), Some("3000000")).is_err(),
            "not run by systemd"
        );
        assert!(
            watchdog(socket(), Some("41"), Some("3000000")).is_err(),
            "another process's"
        );
        assert!(
            watchdog(socket(), Some("42"), None).is_err(),
            "no WatchdogSec="
        );
        assert!(watchdog(socket(), Some("42"), Some("0")).is_err());
        let longer = watchdog(socket(), Some("42"), Some("3000001")).unwrap_err();
        assert!(
            longer.to_string().contains("more than the lease terms'"),
            "{longer}"
        );
    }

    /// A feed is `WATCHDOG=1` on systemd's socket; one that cannot be sent
    /// is said, and the next that gets through counts.
    #[test]
    fn a_feed_is_a_watchdog_ping_on_systemd_s_socket() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notify");
        let mut watchdog = ServiceWatchdog::new(
            Some(path.to_str().unwrap().to_owned()),
            None,
            Some("3000000"),
            1,
            W,
        )
        .unwrap();
        watchdog.feed();
        assert!(!watchdog.fed(), "nothing listens yet");
        let systemd = UnixDatagram::bind(&path).unwrap();
        watchdog.feed();
        assert!(watchdog.fed());
        let mut message = [0; 64];
        let read = systemd.recv(&mut message).unwrap();
        assert_eq!(&message[..read], b"WATCHDOG=1\n");
    }

    /// Only a guard that ended of its own accord within a fresh hand-over
    /// leaves its VMs to the next one.
    #[test]
    fn only_a_guard_handed_over_in_time_leaves_its_vms() {
        let now = At::from_duration(Duration::from_secs(100));
        let later = Some(now + Duration::from_secs(1));
        let earlier = Some(At::from_duration(Duration::from_secs(99)));
        assert!(hands_over(Some("success"), later, now));
        assert!(
            !hands_over(Some("success"), None, now),
            "a stop, not a hand-over"
        );
        assert!(!hands_over(Some("success"), earlier, now), "a stale mark");
        for ended in ["watchdog", "signal", "core-dump", "exit-code", "timeout"] {
            assert!(!hands_over(Some(ended), later, now), "{ended}");
        }
        assert!(!hands_over(None, later, now));
    }

    /// The mark holds until when it is good, and serves one hook only.
    #[test]
    fn a_hand_over_mark_serves_once() {
        let dir = tempfile::tempdir().unwrap();
        let mark = hand_over_mark(&dir.path().join("guard.lock"));
        assert_eq!(mark, dir.path().join("guard.lock.handover"));
        assert_eq!(take_hand_over(&mark), None, "no mark");
        let before = boot_now();
        mark_hand_over(&mark).unwrap();
        let until = take_hand_over(&mark).unwrap();
        assert!(until >= before + HAND_OVER_WITHIN);
        assert!(until <= boot_now() + HAND_OVER_WITHIN);
        assert!(!mark.exists());
        assert_eq!(take_hand_over(&mark), None, "taken");
        std::fs::write(&mark, "soon").unwrap();
        assert_eq!(take_hand_over(&mark), None, "unreadable");
        assert!(!mark.exists(), "taken all the same");
    }

    /// The hook kills the VMs' cgroup until it is empty, and gives up,
    /// saying so, if it never is.
    #[test]
    fn the_hook_kills_every_vm_and_waits_for_them_to_go() {
        let dir = tempfile::tempdir().unwrap();
        let group = dir.path().join("vms");
        std::fs::create_dir(&group).unwrap();
        std::fs::write(group.join("cgroup.freeze"), "0").unwrap();
        std::fs::write(group.join("cgroup.events"), "populated 1\nfrozen 0\n").unwrap();
        let cgroup = Cgroup::at(&group);
        let error = kill_every_vm(&cgroup, Duration::from_millis(120)).unwrap_err();
        assert!(
            error.to_string().contains("still holds processes"),
            "{error}"
        );
        assert_eq!(
            std::fs::read_to_string(group.join("cgroup.kill")).unwrap(),
            "1"
        );
        std::fs::write(group.join("cgroup.events"), "populated 0\nfrozen 0\n").unwrap();
        kill_every_vm(&cgroup, Duration::from_millis(120)).unwrap();
        kill_every_vm(&Cgroup::at(dir.path().join("none")), Duration::ZERO)
            .expect("no cgroup, no VMs");
    }

    /// The shared machine's drop-in has the guard feed systemd's watchdog
    /// of the lease terms' timeout, has systemd kill a guard that stops
    /// feeding it at once, and runs the hook after every end of the guard.
    #[test]
    fn the_shared_machine_s_guard_has_the_watchdog_and_the_hook() {
        let unit = include_str!("../../../../deploy/host/compute-guard-shared.conf");
        let set: Vec<&str> = unit
            .lines()
            .map(str::trim)
            .filter(|line| !line.starts_with('#'))
            .collect();
        assert_eq!(
            compute_fleet::LeaseTerms::RECOMMENDED.watchdog,
            W,
            "WatchdogSec= below is the terms' W"
        );
        for directive in [
            "[Service]",
            "ExecStart=",
            "ExecStart=/opt/compute/current/compute-host guard --watchdog service",
            "WatchdogSec=3s",
            "WatchdogSignal=SIGKILL",
            "ExecStopPost=/opt/compute/current/compute-host guard-stopped",
        ] {
            assert!(
                set.contains(&directive),
                "compute-guard-shared.conf lacks {directive}"
            );
        }
    }
}
