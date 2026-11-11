//! How `opengeni-agent stop` reaches the running agent on Windows.
//!
//! On Windows the background agent runs from a per-user logon task inside a
//! headless console host (see the platform service module). Ending the task only
//! ends the console host: the agent survives it. And a console-less stop cannot
//! send Ctrl-C across consoles. So the running agent listens on a named pipe
//! private to its config directory; `stop` writes `stop` to it and the agent
//! shuts down exactly like on SIGTERM (going offline promptly and cleaning up its
//! browser). The agent also records its process id, so `stop` can end the
//! process tree when a wedged agent does not answer.
//!
//! The pipe's default security lets only its owner (and administrators) write,
//! so another user can connect but cannot ask the agent to stop.

// Only Windows runs this; the shared pieces stay compiled and tested everywhere.
#![cfg_attr(not(windows), allow(dead_code))]

use std::path::{Path, PathBuf};

/// The file the running agent records its process id in, next to its lock.
const PID_FILE: &str = "agent.pid";

/// The stop request the pipe accepts.
const STOP_REQUEST: &[u8] = b"stop";

/// The pipe that asks the agent using `config_dir` to stop. Named after the
/// config directory (case-insensitively, like Windows paths), so separate users
/// and separate configs never share one.
#[must_use]
pub fn stop_pipe_name(config_dir: &Path) -> String {
    // FNV-1a: stable across releases and platforms, no dependency.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in config_dir.to_string_lossy().to_lowercase().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!(r"\\.\pipe\opengeni-agent-stop-{hash:016x}")
}

/// Where the running agent records its process id.
#[must_use]
pub fn pid_file(config_dir: &Path) -> PathBuf {
    config_dir.join(PID_FILE)
}

/// Records this process's id for `stop`'s last resort. Best-effort.
pub fn record_pid(config_dir: &Path) {
    let _ = std::fs::write(pid_file(config_dir), std::process::id().to_string());
}

/// The process id the running agent recorded, if readable.
#[must_use]
pub fn recorded_pid(config_dir: &Path) -> Option<u32> {
    std::fs::read_to_string(pid_file(config_dir))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Asks the agent using `config_dir` to stop. Returns once the request is
/// delivered, not once the agent has exited.
///
/// # Errors
///
/// The pipe does not exist (no agent is listening) or cannot be written.
#[cfg(windows)]
pub fn request_stop(config_dir: &Path) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut pipe = std::fs::OpenOptions::new()
        .write(true)
        .open(stop_pipe_name(config_dir))?;
    pipe.write_all(STOP_REQUEST)?;
    pipe.flush()
}

/// Resolves when a stop request arrives on this agent's pipe. If the pipe cannot
/// be created (another process holds the name), it logs once and never resolves,
/// leaving Ctrl-C and the process-id fallback in charge.
#[cfg(windows)]
pub async fn wait_for_stop_request(config_dir: &Path) {
    use tokio::io::AsyncReadExt as _;
    use tokio::net::windows::named_pipe::ServerOptions;

    let name = stop_pipe_name(config_dir);
    let mut server = match ServerOptions::new().first_pipe_instance(true).create(&name) {
        Ok(server) => server,
        Err(error) => {
            tracing::warn!(%error, pipe = %name, "could not listen for stop requests");
            return std::future::pending().await;
        }
    };
    loop {
        if let Err(error) = server.connect().await {
            tracing::warn!(%error, "stop pipe connection failed");
        }
        // Keep an instance listening before this one is read, so the name never
        // lapses for another process to take.
        let mut connected = server;
        server = match ServerOptions::new().create(&name) {
            Ok(next) => next,
            Err(error) => {
                tracing::warn!(%error, pipe = %name, "could not keep listening for stop requests");
                return std::future::pending().await;
            }
        };
        let mut request = [0_u8; 8];
        let read = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            connected.read(&mut request),
        )
        .await;
        if matches!(read, Ok(Ok(length)) if &request[..length] == STOP_REQUEST) {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stop_pipe_is_per_config_and_case_insensitive() {
        let upper = stop_pipe_name(Path::new(r"C:\Users\Asa\.config\opengeni\agent"));
        let lower = stop_pipe_name(Path::new(r"c:\users\asa\.config\opengeni\agent"));
        let other = stop_pipe_name(Path::new(r"C:\Users\Bo\.config\opengeni\agent"));
        assert_eq!(upper, lower);
        assert_ne!(upper, other);
        assert!(upper.starts_with(r"\\.\pipe\opengeni-agent-stop-"));
        assert_eq!(upper.len(), r"\\.\pipe\opengeni-agent-stop-".len() + 16);
    }

    #[test]
    fn the_recorded_pid_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(recorded_pid(dir.path()), None);
        record_pid(dir.path());
        assert_eq!(recorded_pid(dir.path()), Some(std::process::id()));
    }
}
