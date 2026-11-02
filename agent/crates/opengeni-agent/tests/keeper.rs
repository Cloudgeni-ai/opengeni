//! A foreground `opengeni-agent run` on Linux keeps its agent: a killed agent
//! starts again, while stop signals and a killed keeper end it for good.
//!
//! Runs the real binary with throwaway credentials that dial a closed loopback
//! port, so the agent serves (and keeps retrying) without any control plane.
#![cfg(target_os = "linux")]

use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;

const API_URL: &str = "http://127.0.0.1:9";
const WORKSPACE_ID: &str = "keeper-test-ws";

/// One saved connection, in the agent's `connections/<id>.json` format.
fn write_connection(config_dir: &Path) {
    let id =
        blake3::hash(format!("{API_URL}\0{WORKSPACE_ID}").as_bytes()).to_hex()[..20].to_string();
    let connection = serde_json::json!({
        "schema_version": 1,
        "connection_id": id,
        "api_url": API_URL,
        "credentials": {
            "agent_id": "keeper-test-agent",
            "workspace_id": WORKSPACE_ID,
            "nats_bearer": "keeper-test-token",
            "nats_urls": ["nats://127.0.0.1:9"],
            "relay_url": API_URL,
            "update_pubkey": "",
            "consented_whole_machine": true,
            "consented_screen_control": false
        }
    });
    let dir = config_dir.join("connections");
    std::fs::create_dir_all(&dir).expect("connections dir");
    std::fs::write(
        dir.join(format!("{id}.json")),
        serde_json::to_vec_pretty(&connection).expect("connection"),
    )
    .expect("write connection");
}

struct Run {
    keeper: Child,
    config: tempfile::TempDir,
}

impl Run {
    /// `opengeni-agent run` with a saved connection, as a shell starts it.
    fn start() -> Self {
        Self::start_with(None, true)
    }

    /// Starts with every signal at its default disposition, whatever this test
    /// process inherited (a CI job under `nohup` ignores `SIGHUP`), except
    /// `ignored`, as `nohup` ignores `HUP`. Uses GNU `env --default-signal`
    /// and `--ignore-signal`: a shell's `trap ''` may keep its own `SIGCHLD`
    /// handler, which `exec` resets to the default.
    fn start_with(ignored: Option<&str>, enrolled: bool) -> Self {
        let config = tempfile::tempdir().expect("config dir");
        if enrolled {
            write_connection(config.path());
        }
        let agent = env!("CARGO_BIN_EXE_opengeni-agent");
        let mut command = Command::new("env");
        command.arg("--default-signal");
        if let Some(signal) = ignored {
            command.arg(format!("--ignore-signal={signal}"));
        }
        command.arg(agent);
        let keeper = command
            .arg("--api-url")
            .arg(API_URL)
            .arg("run")
            .current_dir(config.path())
            .env("OPENGENI_CONFIG_DIR", config.path())
            .env("RUST_LOG", "warn")
            .env_remove("OPENGENI_AGENT_KEEPER_PID")
            .env_remove("OPENGENI_AGENT_KEEPER_RESTART")
            .env_remove("OPENGENI_AGENT_HOST")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start opengeni-agent run");
        Self { keeper, config }
    }

    fn keeper_pid(&self) -> Pid {
        Pid::from_raw(i32::try_from(self.keeper.id()).expect("pid"))
    }

    /// The keeper's agent child once it exists and differs from `previous`.
    fn agent(&self, previous: Option<Pid>) -> Pid {
        let deadline = Instant::now() + Duration::from_secs(20);
        let path = format!("/proc/{0}/task/{0}/children", self.keeper.id());
        loop {
            let children = std::fs::read_to_string(&path).unwrap_or_default();
            let found = children
                .split_whitespace()
                .filter_map(|pid| pid.parse::<i32>().ok())
                .map(Pid::from_raw)
                .find(|pid| Some(*pid) != previous);
            if let Some(pid) = found {
                return pid;
            }
            assert!(Instant::now() < deadline, "no agent child under the keeper");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn wait_keeper(&mut self, within: Duration) -> std::process::ExitStatus {
        let deadline = Instant::now() + within;
        loop {
            if let Some(status) = self.keeper.try_wait().expect("keeper status") {
                return status;
            }
            assert!(Instant::now() < deadline, "the keeper did not exit");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        let _ = self.keeper.kill();
        let _ = self.keeper.wait();
    }
}

fn alive(pid: Pid) -> bool {
    // A zombie is gone for our purposes; its parent reaps it.
    std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
        !stat
            .rsplit(')')
            .next()
            .unwrap_or("")
            .trim_start()
            .starts_with('Z')
    })
}

fn wait_gone(pid: Pid) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while alive(pid) {
        assert!(Instant::now() < deadline, "process {pid} is still alive");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Waits until `pid` handles `signal`: a stop signal sent before the agent
/// installs its handler ends it by the signal rather than by a clean stop.
fn wait_catches(pid: Pid, signal: Signal) {
    let bit = 1_u64 << (signal as i32 - 1);
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let caught = std::fs::read_to_string(format!("/proc/{pid}/status"))
            .ok()
            .and_then(|status| {
                status
                    .lines()
                    .find_map(|line| line.strip_prefix("SigCgt:"))
                    .and_then(|mask| u64::from_str_radix(mask.trim(), 16).ok())
            })
            .unwrap_or(0);
        if caught & bit != 0 {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the agent never handled {signal}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Signals blocked by one thread, from its status mask.
fn blocked_signals(status_path: &Path) -> Option<u64> {
    std::fs::read_to_string(status_path)
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("SigBlk:"))
        .and_then(|mask| u64::from_str_radix(mask.trim(), 16).ok())
}

/// The keeper waits for signals it blocks, and a spawned process inherits the
/// mask. Once the agent runs its threads (which every command it starts
/// inherits its mask from), none of them may block a keeper signal.
fn assert_agent_receives_keeper_signals(agent: Pid) {
    let keeper_signals = [
        Signal::SIGTERM,
        Signal::SIGINT,
        Signal::SIGHUP,
        Signal::SIGQUIT,
        Signal::SIGUSR1,
        Signal::SIGUSR2,
        Signal::SIGCHLD,
        Signal::SIGALRM,
    ];
    let mask = keeper_signals
        .iter()
        .fold(0_u64, |mask, signal| mask | 1 << (*signal as i32 - 1));
    let tasks = format!("/proc/{agent}/task");
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let threads: Vec<_> = std::fs::read_dir(&tasks)
            .map(|dir| dir.flatten().map(|task| task.path()).collect())
            .unwrap_or_default();
        if threads.len() > 1 {
            for thread in &threads {
                let Some(blocked) = blocked_signals(&thread.join("status")) else {
                    continue;
                };
                assert_eq!(
                    blocked & mask,
                    0,
                    "agent thread {} blocks keeper signals (SigBlk {blocked:#x})",
                    thread.display()
                );
            }
            return;
        }
        assert!(Instant::now() < deadline, "the agent started no threads");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn a_killed_agent_starts_again_and_a_stop_signal_ends_it() {
    let mut run = Run::start();
    let first = run.agent(None);
    assert_agent_receives_keeper_signals(first);

    // What the out-of-memory killer does.
    kill(first, Signal::SIGKILL).expect("kill agent");
    let second = run.agent(Some(first));
    assert_ne!(first, second);
    wait_gone(first);
    assert_agent_receives_keeper_signals(second);
    wait_catches(second, Signal::SIGTERM);
    // The new agent's own log says why it started.
    wait_for_log(&run, "started again by its keeper");

    // A stop signal to the keeper stops the agent cleanly and for good.
    kill(run.keeper_pid(), Signal::SIGTERM).expect("stop keeper");
    let status = run.wait_keeper(Duration::from_secs(60));
    assert!(status.success(), "keeper exit {status:?}");
    wait_gone(second);
}

/// `SIGINT` (Ctrl-C) stops the agent cleanly like `SIGTERM`; a stop signal
/// the agent does not handle ends it, and the keeper exits as the shell
/// reports a process that signal ended.
#[test]
fn stop_signals_are_passed_on_and_end_the_agent_for_good() {
    for (signal, expected) in [(Signal::SIGINT, 0), (Signal::SIGHUP, 128 + 1)] {
        let mut run = Run::start();
        let agent = run.agent(None);
        assert!(
            !ignores(agent, Signal::SIGHUP),
            "SIGHUP must not be ignored here"
        );
        wait_catches(agent, Signal::SIGTERM);
        wait_catches(agent, Signal::SIGINT);
        kill(run.keeper_pid(), signal).expect("signal keeper");
        let status = run.wait_keeper(Duration::from_secs(60));
        assert_eq!(status.code(), Some(expected), "{signal}: {status:?}");
        wait_gone(agent);
    }
}

/// Under `nohup` (`SIGHUP` ignored) a hangup reaches neither the keeper nor
/// the agent.
#[test]
fn a_signal_ignored_at_start_stays_ignored() {
    let mut run = Run::start_with(Some("HUP"), true);
    let agent = run.agent(None);
    assert!(
        ignores(agent, Signal::SIGHUP),
        "the agent must inherit the ignored SIGHUP"
    );
    wait_catches(agent, Signal::SIGTERM);
    kill(run.keeper_pid(), Signal::SIGHUP).expect("hang up keeper");
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        alive(run.keeper_pid()),
        "the keeper ended on an ignored SIGHUP"
    );
    assert!(alive(agent), "the agent ended on an ignored SIGHUP");
    kill(run.keeper_pid(), Signal::SIGTERM).expect("stop keeper");
    let status = run.wait_keeper(Duration::from_secs(60));
    assert!(status.success(), "keeper exit {status:?}");
    wait_gone(agent);
}

/// With `SIGCHLD` ignored the kernel never reports a child's end, so a keeper
/// could not see its agent die: the process runs the agent itself instead.
#[test]
fn an_ignored_sigchld_runs_the_agent_without_a_keeper() {
    let mut run = Run::start_with(Some("CHLD"), true);
    let pid = run.keeper_pid();
    wait_catches(pid, Signal::SIGTERM);
    assert!(
        ignores(pid, Signal::SIGCHLD),
        "SIGCHLD must be ignored for this test"
    );
    let children =
        std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children")).unwrap_or_default();
    for child in children.split_whitespace() {
        let comm = std::fs::read_to_string(format!("/proc/{child}/comm")).unwrap_or_default();
        assert_ne!(
            comm.trim_end(),
            "opengeni-agent",
            "a keeper started an agent"
        );
    }
    kill(pid, Signal::SIGTERM).expect("stop agent");
    let status = run.wait_keeper(Duration::from_secs(60));
    assert!(status.success(), "agent exit {status:?}");
}

/// An agent that ends by itself (here: nothing to connect to) is not started
/// again, and the keeper exits with the agent's own status, the one it has
/// without a keeper.
#[test]
fn an_agent_that_exits_by_itself_is_not_started_again() {
    let mut kept = Run::start_with(None, false);
    let kept_status = kept.wait_keeper(Duration::from_secs(60));
    let mut alone = Run::start_with(Some("CHLD"), false);
    let alone_status = alone.wait_keeper(Duration::from_secs(60));
    assert_eq!(kept_status.code(), alone_status.code());
    assert!(kept_status.code().is_some(), "{kept_status:?}");
}

#[test]
fn a_killed_keeper_takes_its_agent_with_it() {
    // Killed at once (often before the agent tied its life to the keeper)
    // and once the agent runs: either way the agent goes too.
    for settled in [false, false, false, true] {
        let mut run = Run::start();
        let agent = run.agent(None);
        if settled {
            wait_catches(agent, Signal::SIGTERM);
        }
        kill(run.keeper_pid(), Signal::SIGKILL).expect("kill keeper");
        let _ = run.wait_keeper(Duration::from_secs(10));
        wait_gone(agent);
    }
}

fn ignores(pid: Pid, signal: Signal) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find_map(|line| line.strip_prefix("SigIgn:"))
                .and_then(|mask| u64::from_str_radix(mask.trim(), 16).ok())
        })
        .is_some_and(|mask| mask & (1 << (signal as i32 - 1)) != 0)
}

fn wait_for_log(run: &Run, needle: &str) {
    let log = run.config.path().join("logs").join("agent.log");
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if std::fs::read_to_string(&log).is_ok_and(|text| text.contains(needle)) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "{} lacks {needle:?}",
            log.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}
