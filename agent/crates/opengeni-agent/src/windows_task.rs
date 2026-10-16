//! The Windows background agent: a per-user logon task (see
//! [`opengeni_agent_platform::service::render_windows_task_xml`]).
//!
//! `start` registers the task, enables it and starts the agent in the signed-in
//! user's desktop session; `stop` disables the task (so its keep-alive repetition
//! does not bring the agent back) and asks the agent to shut down cleanly; `status`
//! reports whether the agent is actually running, from its instance lock. None of
//! it needs elevation.

// Only Windows runs this; the pure parsers stay compiled and tested everywhere.
#![cfg_attr(not(windows), allow(dead_code))]

use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use opengeni_agent_platform::service::{self, ServiceSpec};

use crate::{config, windows_control};

const TASK: &str = service::ids::WINDOWS_TASK;

/// How long a starting agent may take to take its lock.
const START_WAIT: Duration = Duration::from_secs(20);
/// How long a clean stop may take (going offline, closing the browser) before
/// `stop` ends the process tree. Below the desktop app's one-minute pause limit.
const STOP_WAIT: Duration = Duration::from_secs(45);

/// What `status` reports, in the one line it prints.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskState {
    /// The agent is running.
    Running,
    /// The task is disabled: `stop` paused the agent until the next `start`.
    Paused,
    /// The task is registered and enabled, but the agent is not running (it is
    /// started again within a minute, or at the next sign-in).
    Stopped,
    /// No task is registered.
    NotInstalled,
}

impl TaskState {
    fn label(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Stopped => "stopped",
            Self::NotInstalled => "not installed",
        }
    }
}

/// Registers (or refreshes) the task and makes sure the agent runs. With
/// `restart`, a running agent is stopped first so a new binary takes over.
///
/// # Errors
///
/// The task cannot be rendered or registered, or the agent does not start.
pub fn install(spec: &ServiceSpec, restart: bool) -> Result<(), String> {
    let host = service::current_windows_task_host().map_err(|error| error.to_string())?;
    let xml = service::render_windows_task_xml(spec, &host).map_err(|error| error.to_string())?;
    let dir = config::config_dir().map_err(|error| error.to_string())?;
    remove_legacy_service();
    let running = agent_running(&dir);
    if running && restart {
        stop_agent(&dir)?;
    }
    register(&xml)?;
    if !running || restart {
        schtasks(&["/Run", "/TN", TASK])?;
        wait_until(START_WAIT, || agent_running(&dir)).map_err(|()| {
            format!(
                "the agent did not start within {} seconds; its log is in {}",
                START_WAIT.as_secs(),
                crate::log_file::log_directory(&dir).display()
            )
        })?;
    }
    println!("the Opengeni agent runs in the background whenever you are signed in to Windows.");
    Ok(())
}

/// Pauses the agent: disables the task, then stops the running agent.
///
/// # Errors
///
/// A running agent could not be stopped.
pub fn stop() -> Result<(), String> {
    let dir = config::config_dir().map_err(|error| error.to_string())?;
    if task_status().is_some() {
        schtasks(&["/Change", "/TN", TASK, "/DISABLE"])?;
    }
    stop_agent(&dir)?;
    println!("paused the Opengeni agent; `opengeni-agent start` resumes it.");
    Ok(())
}

/// Stops the agent and removes the task.
///
/// # Errors
///
/// A running agent could not be stopped or the task could not be removed.
pub fn uninstall() -> Result<(), String> {
    let dir = config::config_dir().map_err(|error| error.to_string())?;
    if task_status().is_some() {
        schtasks(&["/Change", "/TN", TASK, "/DISABLE"])?;
        stop_agent(&dir)?;
        schtasks(&["/Delete", "/TN", TASK, "/F"])?;
    } else {
        stop_agent(&dir)?;
    }
    remove_legacy_service();
    println!("removed the Opengeni agent background task.");
    Ok(())
}

/// The agent's state, for `status`.
#[must_use]
pub fn state() -> TaskState {
    let running = config::config_dir().is_ok_and(|dir| agent_running(&dir));
    resolve_state(task_status().as_deref(), running)
}

/// Prints the one-line status the desktop app and scripts read.
pub fn print_status() {
    println!("opengeni-agent background task: {}", state().label());
}

fn resolve_state(task_status: Option<&str>, running: bool) -> TaskState {
    match (task_status, running) {
        (_, true) => TaskState::Running,
        (None, false) => TaskState::NotInstalled,
        (Some(status), false) if status.eq_ignore_ascii_case("disabled") => TaskState::Paused,
        (Some(_), false) => TaskState::Stopped,
    }
}

/// Whether an agent holds the instance lock in `dir` (Windows only).
fn agent_running(dir: &Path) -> bool {
    #[cfg(windows)]
    {
        crate::instance_lock::is_held_in(dir)
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
        false
    }
}

/// Asks a running agent to stop and waits for it; ends its process tree if it
/// does not stop in time. A no-op when no agent runs.
fn stop_agent(dir: &Path) -> Result<(), String> {
    if !agent_running(dir) {
        return Ok(());
    }
    #[cfg(windows)]
    if let Err(error) = windows_control::request_stop(dir) {
        tracing::warn!(%error, "could not ask the agent to stop; ending it instead");
    }
    if wait_until(STOP_WAIT, || !agent_running(dir)).is_ok() {
        return Ok(());
    }
    if let Some(pid) = windows_control::recorded_pid(dir).filter(|&pid| is_agent_process(pid)) {
        let pid = pid.to_string();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .output();
    }
    wait_until(Duration::from_secs(10), || !agent_running(dir))
        .map_err(|()| "the agent did not stop".to_string())
}

/// Whether `pid` is still an Opengeni agent (a recorded id can be reused).
fn is_agent_process(pid: u32) -> bool {
    let filter = format!("PID eq {pid}");
    Command::new("tasklist")
        .args(["/FI", &filter, "/FO", "CSV", "/NH"])
        .output()
        .is_ok_and(|output| tasklist_names_agent(&String::from_utf8_lossy(&output.stdout)))
}

fn tasklist_names_agent(output: &str) -> bool {
    output.lines().any(|line| {
        line.trim()
            .trim_start_matches('"')
            .split('"')
            .next()
            .is_some_and(|image| image.eq_ignore_ascii_case("opengeni-agent.exe"))
    })
}

/// The task's status column (`Ready`, `Running`, `Disabled`), or `None` when the
/// task is not registered.
fn task_status() -> Option<String> {
    let output = Command::new("schtasks")
        .args(["/Query", "/TN", TASK, "/FO", "CSV", "/NH"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_task_status(&String::from_utf8_lossy(&output.stdout))
}

/// The status column of `schtasks /Query /FO CSV /NH`:
/// `"\Opengeni Agent","N/A","Running"`.
fn parse_task_status(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let fields: Vec<&str> = line.trim().split("\",\"").collect();
        (fields.len() >= 3).then(|| fields[fields.len() - 1].trim_matches('"').to_string())
    })
}

/// Writes the definition as UTF-16 (what its XML declaration says) and registers
/// it, replacing an earlier definition.
fn register(xml: &str) -> Result<(), String> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in xml.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    let path = std::env::temp_dir().join(format!("opengeni-agent-task-{}.xml", std::process::id()));
    std::fs::write(&path, bytes)
        .map_err(|error| format!("could not write {}: {error}", path.display()))?;
    let registered = schtasks(&[
        "/Create",
        "/F",
        "/TN",
        TASK,
        "/XML",
        &path.to_string_lossy(),
    ]);
    let _ = std::fs::remove_file(&path);
    registered.map(|_| ())
}

/// Removes the Windows Service earlier releases registered. It never started,
/// but its automatic start fails at every boot. Deleting it needs elevation; say
/// how when this run cannot.
fn remove_legacy_service() {
    let legacy = service::ids::LEGACY_WINDOWS_SERVICE;
    let present = Command::new("sc.exe")
        .args(["query", legacy])
        .output()
        .is_ok_and(|output| output.status.success());
    if !present {
        return;
    }
    let deleted = Command::new("sc.exe")
        .args(["delete", legacy])
        .output()
        .is_ok_and(|output| output.status.success());
    if !deleted {
        eprintln!(
            "note: the old {legacy} Windows service from an earlier release is still registered; \
             it does nothing, and an administrator can remove it with: sc.exe delete {legacy}"
        );
    }
}

/// Runs `schtasks` quietly; a failure carries its message.
fn schtasks(args: &[&str]) -> Result<String, String> {
    let output = Command::new("schtasks")
        .args(args)
        .output()
        .map_err(|error| format!("could not run schtasks: {error}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(format!(
        "schtasks {} failed: {}",
        args.first().copied().unwrap_or_default(),
        if message.is_empty() {
            output.status.to_string()
        } else {
            message
        }
    ))
}

fn wait_until(limit: Duration, mut done: impl FnMut() -> bool) -> Result<(), ()> {
    let started = Instant::now();
    loop {
        if done() {
            return Ok(());
        }
        if started.elapsed() >= limit {
            return Err(());
        }
        thread::sleep(Duration::from_millis(200));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_task_status_column_is_parsed() {
        assert_eq!(
            parse_task_status("\r\n\"\\Opengeni Agent\",\"N/A\",\"Running\"\r\n").as_deref(),
            Some("Running")
        );
        assert_eq!(
            parse_task_status("\"\\Opengeni Agent\",\"10/15/2026 9:00:00 AM\",\"Disabled\"")
                .as_deref(),
            Some("Disabled")
        );
        assert_eq!(parse_task_status("INFO: no tasks"), None);
    }

    #[test]
    fn state_prefers_the_running_agent_over_the_task_column() {
        assert_eq!(resolve_state(Some("Ready"), true), TaskState::Running);
        // An agent started by hand (or a successor after an update) counts too.
        assert_eq!(resolve_state(None, true), TaskState::Running);
        assert_eq!(resolve_state(Some("Disabled"), false), TaskState::Paused);
        // The console host can outlive nothing: a "Running" task with no agent
        // holding the lock is not running.
        assert_eq!(resolve_state(Some("Running"), false), TaskState::Stopped);
        assert_eq!(resolve_state(None, false), TaskState::NotInstalled);
    }

    #[test]
    fn only_an_agent_image_is_ended() {
        assert!(tasklist_names_agent(
            "\"opengeni-agent.exe\",\"8800\",\"Console\",\"1\",\"52,104 K\"\r\n"
        ));
        assert!(!tasklist_names_agent(
            "\"notepad.exe\",\"8800\",\"Console\",\"1\",\"9,104 K\"\r\n"
        ));
        assert!(!tasklist_names_agent(
            "INFO: No tasks are running which match the specified criteria.\r\n"
        ));
    }
}
