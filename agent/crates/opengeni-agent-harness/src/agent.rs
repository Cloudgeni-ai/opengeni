//! A disposable `opengeni-agent run` child with hand-written credentials.
//!
//! This never touches the machine's real enrollment. Each agent gets its own
//! `$OPENGENI_CONFIG_DIR` (a temp dir) holding a `credentials.json` matching the
//! agent's `StoredCredentials` serde shape, so the `run` command loads them and
//! serves immediately (no device-flow enrollment). The bearer is a throwaway
//! string a no-auth local server accepts.

use std::path::{Path, PathBuf};

use nix::sys::signal::Signal;
use tokio::process::Child;

use crate::proc;

/// The fixed workspace id every disposable agent shares (so one wildcard events
/// subscription — `agent.<ws>.*.events` — sees the whole fleet).
pub const WORKSPACE_ID: &str = "hx-ws";

/// A single disposable agent process and its scratch dirs.
pub struct DisposableAgent {
    binary: PathBuf,
    agent_id: String,
    nats_url: String,
    log_level: String,
    /// The `$OPENGENI_CONFIG_DIR` holding `credentials.json` (kept alive here so
    /// it is not deleted until the agent is dropped).
    config_dir: tempfile::TempDir,
    /// The agent's cwd == its reported `workspace_root` (fs ops resolve here).
    work_dir: PathBuf,
    log_path: PathBuf,
    child: Option<Child>,
    pid: i32,
}

impl DisposableAgent {
    /// Creates the config + work dirs, writes credentials, and spawns `run`.
    ///
    /// # Errors
    ///
    /// Returns an error if the temp dirs or credentials cannot be written, or the
    /// agent binary cannot be spawned.
    pub async fn spawn(
        binary: PathBuf,
        index: usize,
        nats_url: &str,
        log_level: &str,
    ) -> Result<Self, String> {
        let agent_id = format!("hx-agent-{index}");
        let config_dir = tempfile::tempdir().map_err(|e| format!("config tempdir: {e}"))?;
        let work_dir = config_dir.path().join("work");
        std::fs::create_dir_all(&work_dir).map_err(|e| format!("work dir: {e}"))?;
        write_credentials(config_dir.path(), &agent_id, nats_url)?;

        let log_path = config_dir.path().join("agent.log");
        let mut agent = Self {
            binary,
            agent_id,
            nats_url: nats_url.to_string(),
            log_level: log_level.to_string(),
            config_dir,
            work_dir,
            log_path,
            child: None,
            pid: 0,
        };
        agent.launch()?;
        Ok(agent)
    }

    /// Spawns the `run` child with the isolated config dir + scratch cwd.
    fn launch(&mut self) -> Result<(), String> {
        let envs = vec![
            (
                "OPENGENI_CONFIG_DIR".to_string(),
                self.config_dir.path().to_string_lossy().into_owned(),
            ),
            ("RUST_LOG".to_string(), self.log_level.clone()),
            // A stable shell so `shell:true` execs (the pipelines the large
            // scenario drives) are deterministic across hosts.
            ("SHELL".to_string(), "/bin/sh".to_string()),
        ];
        let (child, pid) = proc::spawn_grouped(
            &self.binary,
            &["run".to_string()],
            Some(&self.work_dir),
            &envs,
            // Inherit PATH etc. so the agent (and the commands it execs) resolve;
            // OPENGENI_CONFIG_DIR wins over any inherited HOME/XDG for the config.
            false,
            &self.log_path,
        )
        .map_err(|e| format!("failed to spawn opengeni-agent: {e}"))?;
        self.child = Some(child);
        self.pid = pid;
        Ok(())
    }

    /// SIGKILLs the agent WITHOUT relaunching (models a hard crash), waiting for
    /// the process to exit. The exec children the agent isolated into their own
    /// process groups are deliberately NOT signalled here — the point is to
    /// observe whether a hard-killed agent leaves them orphaned.
    pub async fn kill_now(&mut self) {
        proc::signal_group(self.pid, nix::sys::signal::Signal::SIGKILL);
        if let Some(mut child) = self.child.take() {
            let _ = child.wait().await;
        }
        proc::unregister_pgid(self.pid);
    }

    /// Relaunches after a [`kill_now`](Self::kill_now) (the child handle is
    /// already reaped).
    ///
    /// # Errors
    ///
    /// Propagates a spawn failure.
    pub fn relaunch(&mut self) -> Result<(), String> {
        self.launch()
    }

    /// Sends SIGTERM (the clean-stop path: the agent announces GoingOffline and
    /// exits 0) and waits for the process to exit.
    pub async fn stop_clean(&mut self) {
        proc::signal_pid(self.pid, Signal::SIGTERM);
        if let Some(mut child) = self.child.take() {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(10), child.wait()).await;
        }
        proc::unregister_pgid(self.pid);
    }

    /// The agent's stable id.
    #[must_use]
    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }

    /// The RPC subject the driver issues ControlRequests on.
    #[must_use]
    pub fn rpc_subject(&self) -> String {
        format!("agent.{}.{}.rpc", WORKSPACE_ID, self.agent_id)
    }

    /// The agent's scratch working directory (its reported workspace root).
    #[must_use]
    pub fn work_dir(&self) -> &Path {
        &self.work_dir
    }

    /// The current pid.
    #[must_use]
    pub fn pid(&self) -> i32 {
        self.pid
    }

    /// The captured agent log (for diagnosing a failed milestone/run).
    #[must_use]
    pub fn log_tail(&self, lines: usize) -> String {
        std::fs::read_to_string(&self.log_path)
            .map(|log| {
                let all: Vec<&str> = log.lines().collect();
                let start = all.len().saturating_sub(lines);
                all[start..].join("\n")
            })
            .unwrap_or_default()
    }

    /// The dial URL this agent uses (for logs).
    #[must_use]
    pub fn nats_url(&self) -> &str {
        &self.nats_url
    }
}

impl Drop for DisposableAgent {
    fn drop(&mut self) {
        proc::signal_group(self.pid, Signal::SIGKILL);
        proc::unregister_pgid(self.pid);
    }
}

/// Writes a `credentials.json` matching the agent's `StoredCredentials` serde
/// shape into `config_dir`. Field names/types mirror
/// `opengeni-agent/src/config.rs`; the bearer is a throwaway a no-auth server
/// accepts, and `relay_url` is a dead loopback port that is never dialed (no
/// pty/desktop ops are issued).
fn write_credentials(config_dir: &Path, agent_id: &str, nats_url: &str) -> Result<(), String> {
    let creds = serde_json::json!({
        "agent_id": agent_id,
        "workspace_id": WORKSPACE_ID,
        "nats_bearer": "hx-token",
        "nats_urls": [nats_url],
        "relay_url": "http://127.0.0.1:9",
        "relay_token": "",
        "update_pubkey": "",
        "consented_whole_machine": true,
        "consented_screen_control": false,
        "update_channel": "stable",
        "resume_token": "",
        "last_known_epoch": 0
    });
    let path = config_dir.join("credentials.json");
    std::fs::write(&path, serde_json::to_vec_pretty(&creds).expect("creds serialize"))
        .map_err(|e| format!("write credentials.json: {e}"))
}
