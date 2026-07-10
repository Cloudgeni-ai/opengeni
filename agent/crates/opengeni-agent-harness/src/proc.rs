//! Process lifecycle plumbing shared by the child wrappers.
//!
//! Three concerns live here so the scenario code stays about MEASUREMENT, not
//! Unix bookkeeping:
//!
//! 1. **Signals** — thin, safe wrappers over `nix` for the chaos ops
//!    (SIGSTOP/SIGCONT to freeze a server, SIGKILL/SIGTERM to a child or a whole
//!    process group). We tolerate `ESRCH` (already gone) so a double-kill on the
//!    cleanup path is never an error.
//! 2. **A global reaper** — every child (nats-server, each disposable agent) is
//!    registered here at spawn. A harness crash or an interactive Ctrl-C must NOT
//!    leak a fleet of agents or a server; [`install_guards`] wires a panic hook
//!    and a signal task that kill every registered process group and sweep any
//!    orphaned exec descendants by the run's unique marker. The per-handle `Drop`
//!    impls cover the normal and `?`-early-return and panic-unwind paths; the
//!    guards cover a signal to the harness itself (where `Drop` never runs).
//! 3. **/proc sampling** — RSS, thread count, and open-fd count for a pid, so a
//!    scenario can watch an agent's resource envelope over time (leak detection).

use std::os::unix::process::CommandExt as _;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

use nix::sys::signal::{killpg, Signal};
use nix::unistd::Pid;

/// Spawns a child in its OWN process group (so a stray terminal Ctrl-C to the
/// harness never propagates to it, and the whole group is killable via
/// [`signal_group`]), with stderr+stdout redirected to `log_path`. The child is
/// registered with the reaper by its pid (== its new process-group id).
///
/// `envs` fully replaces the child environment when `clear_env` is set, else it
/// layers over the inherited one — the agent needs a clean, explicit env; a
/// server does not.
///
/// # Errors
///
/// Returns the spawn IO error (e.g. the binary is missing or not executable).
pub fn spawn_grouped(
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
    envs: &[(String, String)],
    clear_env: bool,
    log_path: &Path,
) -> std::io::Result<(tokio::process::Child, i32)> {
    let log = std::fs::File::create(log_path)?;
    let log_err = log.try_clone()?;

    let mut cmd = std::process::Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        // A new process group: pgid == child pid. Isolates it from the harness's
        // controlling-terminal signal group and makes the whole subtree killable.
        .process_group(0);
    if clear_env {
        cmd.env_clear();
    }
    for (k, v) in envs {
        cmd.env(k, v);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let mut tokio_cmd = tokio::process::Command::from(cmd);
    let child = tokio_cmd.spawn()?;
    let pid = child
        .id()
        .expect("a freshly spawned child always has a pid") as i32;
    register_pgid(pid);
    Ok((child, pid))
}

/// A point-in-time resource sample of a single process, read from `/proc/<pid>`.
#[derive(Debug, Clone, Copy)]
pub struct ProcSample {
    /// Resident set size in bytes (`VmRSS`).
    pub rss_bytes: u64,
    /// Kernel thread count (`Threads`).
    pub threads: u64,
    /// Open file-descriptor count (entries in `/proc/<pid>/fd`).
    pub fds: u64,
}

/// Finds a free localhost TCP port by binding `:0` and reading the assigned port
/// back. There is an unavoidable bind-then-spawn race, but the window is tiny and
/// the harness owns the machine during a run.
///
/// # Panics
///
/// Panics only if the OS cannot allocate any ephemeral port (a broken host).
#[must_use]
pub fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    listener.local_addr().expect("local addr").port()
}

/// Sends a signal to a single process, swallowing "no such process" (the target
/// already exited — never an error on a cleanup or race path).
pub fn signal_pid(pid: i32, sig: Signal) {
    match nix::sys::signal::kill(Pid::from_raw(pid), sig) {
        Ok(()) | Err(nix::errno::Errno::ESRCH) => {}
        Err(e) => tracing::warn!(pid, ?sig, error = %e, "failed to signal process"),
    }
}

/// Sends a signal to a whole process group (a child spawned with
/// `process_group(0)` has a group id equal to its pid), swallowing `ESRCH`.
pub fn signal_group(pgid: i32, sig: Signal) {
    match killpg(Pid::from_raw(pgid), sig) {
        Ok(()) | Err(nix::errno::Errno::ESRCH) => {}
        Err(e) => tracing::warn!(pgid, ?sig, error = %e, "failed to signal process group"),
    }
}

/// Reads a `/proc/<pid>` resource sample. Returns `None` if the process is gone
/// or `/proc` is unavailable (non-Linux), so callers degrade to "no sample"
/// rather than fail.
#[must_use]
pub fn sample_proc(pid: i32) -> Option<ProcSample> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let mut rss_bytes = 0u64;
    let mut threads = 0u64;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            rss_bytes = parse_kib_line(rest);
        } else if let Some(rest) = line.strip_prefix("Threads:") {
            threads = rest.trim().parse().unwrap_or(0);
        }
    }
    let fds = std::fs::read_dir(format!("/proc/{pid}/fd"))
        .map(|dir| dir.count() as u64)
        .unwrap_or(0);
    Some(ProcSample {
        rss_bytes,
        threads,
        fds,
    })
}

/// Parses a `VmRSS:   12345 kB` value tail into bytes.
fn parse_kib_line(rest: &str) -> u64 {
    rest.split_whitespace()
        .next()
        .and_then(|v| v.parse::<u64>().ok())
        .map(|kib| kib * 1024)
        .unwrap_or(0)
}

/// The global set of things to reap if the harness dies unexpectedly.
#[derive(Default)]
struct Registry {
    /// Process-group ids to SIGKILL (agents + nats-server).
    pgids: Vec<i32>,
    /// Unique command-line markers to `pkill -f` (orphaned exec descendants that
    /// the agent isolated into their OWN process groups, so a killpg of the agent
    /// never reaches them).
    markers: Vec<String>,
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

/// Registers a child process group for emergency cleanup.
pub fn register_pgid(pgid: i32) {
    registry().lock().unwrap().pgids.push(pgid);
}

/// Removes a process group from the registry (its owner dropped cleanly).
pub fn unregister_pgid(pgid: i32) {
    registry().lock().unwrap().pgids.retain(|p| *p != pgid);
}

/// Registers a unique exec marker so any orphaned descendant carrying it in its
/// command line is swept on cleanup.
pub fn register_marker(marker: impl Into<String>) {
    registry().lock().unwrap().markers.push(marker.into());
}

/// Kills every registered process group and sweeps any orphaned exec descendants
/// by marker. Idempotent and best-effort — used by the panic hook and the
/// harness's own signal handler, where per-handle `Drop` never runs.
pub fn reap_all() {
    let (pgids, markers) = {
        let reg = registry().lock().unwrap();
        (reg.pgids.clone(), reg.markers.clone())
    };
    for pgid in pgids {
        signal_group(pgid, Signal::SIGKILL);
    }
    for marker in markers {
        // A best-effort sweep of exec grandchildren the agent placed in their own
        // process groups. `pkill` is not fatal if absent; the marker is unique to
        // this run so it can never hit an unrelated process.
        let _ = std::process::Command::new("pkill")
            .arg("-9")
            .arg("-f")
            .arg(&marker)
            .status();
    }
}

/// Installs a panic hook and an async signal task so an unexpected harness exit
/// still reaps every child. Call once, inside the tokio runtime.
pub fn install_guards() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        reap_all();
        previous(info);
    }));

    tokio::spawn(async move {
        let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = sigterm.recv() => {}
        }
        tracing::warn!("harness received a stop signal; reaping children");
        reap_all();
        std::process::exit(130);
    });
}
