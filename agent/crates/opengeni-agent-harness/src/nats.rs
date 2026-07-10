//! A disposable local `nats-server`, driven exactly like the control plane's
//! transport: no auth (the agent's connect bearer is accepted by an unsecured
//! server), a random free port, its own process group.
//!
//! The harness spawns the REAL binary directly (not wrapped by `nix run` or
//! `docker`) so the chaos scenarios can signal it precisely — SIGSTOP to freeze a
//! reachable-but-unresponsive server, SIGKILL + respawn on the SAME port to model
//! a rolling-deploy blip. A wrapper process would swallow those signals.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use nix::sys::signal::Signal;
use tokio::process::Child;

use crate::proc;

/// Where a spawned server writes its logs (readiness is detected by tailing it).
const READY_MARKER: &str = "Server is ready";

/// A running local nats-server child.
pub struct NatsServer {
    binary: PathBuf,
    port: u16,
    log_path: PathBuf,
    child: Option<Child>,
    pid: i32,
}

impl NatsServer {
    /// Resolves a `nats-server` binary path: an explicit override first
    /// (`--nats-server` / `$HX_NATS_SERVER`), then `$PATH`, then a nix-store scan
    /// (this harness's home is NixOS). Returns a clear error naming the docker
    /// fallback if none is found.
    ///
    /// # Errors
    ///
    /// Returns a human message when no binary can be located.
    pub fn resolve_binary(explicit: Option<&str>) -> Result<PathBuf, String> {
        if let Some(path) = explicit {
            let p = PathBuf::from(path);
            if p.is_file() {
                return Ok(p);
            }
            return Err(format!("--nats-server '{path}' is not a file"));
        }
        if let Some(path) = which_on_path("nats-server") {
            return Ok(path);
        }
        if let Some(path) = scan_nix_store() {
            return Ok(path);
        }
        Err("could not find a nats-server binary. Put one on $PATH, pass \
             --nats-server <path> / set $HX_NATS_SERVER, or (docker) run \
             `docker run --rm -p 4222:4222 nats:2-alpine` and point the harness at it"
            .to_string())
    }

    /// Spawns a server on a fresh free port and waits until it is ready.
    ///
    /// # Errors
    ///
    /// Returns an error if the child cannot be spawned or does not report ready
    /// within the timeout (its log tail is included for diagnosis).
    pub async fn start(binary: PathBuf, work_dir: &Path) -> Result<Self, String> {
        let port = proc::free_port();
        let log_path = work_dir.join(format!("nats-{port}.log"));
        let mut server = Self {
            binary,
            port,
            log_path,
            child: None,
            pid: 0,
        };
        server.spawn().await?;
        Ok(server)
    }

    /// (Re)spawns the server child on the SAME port and waits for readiness. Used
    /// both by [`start`](Self::start) and by the chaos restart path.
    async fn spawn(&mut self) -> Result<(), String> {
        let args = vec![
            "-a".to_string(),
            "127.0.0.1".to_string(),
            "-p".to_string(),
            self.port.to_string(),
        ];
        let (child, pid) = proc::spawn_grouped(
            &self.binary,
            &args,
            None,
            &[],
            false,
            &self.log_path,
        )
        .map_err(|e| format!("failed to spawn nats-server: {e}"))?;
        self.child = Some(child);
        self.pid = pid;
        self.await_ready().await
    }

    /// Polls the server log until it prints its ready line, or times out.
    async fn await_ready(&self) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(log) = std::fs::read_to_string(&self.log_path) {
                if log.contains(READY_MARKER) {
                    return Ok(());
                }
            }
            if Instant::now() >= deadline {
                let tail = std::fs::read_to_string(&self.log_path).unwrap_or_default();
                return Err(format!(
                    "nats-server did not become ready within 10s. Log tail:\n{}",
                    tail.lines().rev().take(20).collect::<Vec<_>>().join("\n")
                ));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// The `nats://` URL agents and the driver dial.
    #[must_use]
    pub fn url(&self) -> String {
        format!("nats://127.0.0.1:{}", self.port)
    }

    /// SIGKILLs the current server child and respawns a fresh one on the same
    /// port, returning the instant the NEW server reported ready (so a scenario
    /// can measure reconnect convergence from that instant).
    ///
    /// # Errors
    ///
    /// Propagates a respawn/readiness failure.
    pub async fn restart(&mut self) -> Result<Instant, String> {
        proc::signal_group(self.pid, Signal::SIGKILL);
        if let Some(mut child) = self.child.take() {
            let _ = child.wait().await;
        }
        proc::unregister_pgid(self.pid);
        // Truncate the log so the readiness poll only sees the NEW generation's
        // ready line, not the previous one.
        let _ = std::fs::write(&self.log_path, b"");
        self.spawn().await?;
        Ok(Instant::now())
    }

    /// Freezes the server (SIGSTOP): still reachable at the TCP layer, but it
    /// processes nothing — models a stalled/paused server.
    pub fn pause(&self) {
        proc::signal_pid(self.pid, Signal::SIGSTOP);
    }

    /// Resumes a paused server (SIGCONT).
    pub fn resume(&self) {
        proc::signal_pid(self.pid, Signal::SIGCONT);
    }
}

impl Drop for NatsServer {
    fn drop(&mut self) {
        // Always SIGCONT first: a server left SIGSTOPped would ignore the SIGKILL.
        proc::signal_pid(self.pid, Signal::SIGCONT);
        proc::signal_group(self.pid, Signal::SIGKILL);
        proc::unregister_pgid(self.pid);
    }
}

/// Searches `$PATH` for an executable by name.
fn which_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// Best-effort scan of `/nix/store` for a `nats-server` binary (this harness's
/// host is NixOS, where the package is present in the store but not on `$PATH`).
fn scan_nix_store() -> Option<PathBuf> {
    let entries = std::fs::read_dir("/nix/store").ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.contains("nats-server") && !name.ends_with(".drv") {
            let candidate = entry.path().join("bin").join("nats-server");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}
