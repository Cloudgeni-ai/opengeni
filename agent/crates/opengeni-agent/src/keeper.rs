//! Starts a foreground Linux agent again when the kernel kills it.
//!
//! A service manager (the generated systemd units' `Restart=always`), the
//! desktop app and a compute sandbox's guest init each start the agent again
//! when it dies. A foreground `opengeni-agent run` has none of them: in a
//! container, a CI job or a terminal, an agent the out-of-memory killer ends
//! leaves the machine offline until a person notices. Commands are the kernel's
//! preferred victims (see the platform crate's `oom_score_adj` policy), but a
//! memory limit no command can be freed from, or another process's memory,
//! can still leave the agent the largest process left.
//!
//! There, `run` becomes a small keeper process that starts the real agent as
//! its child and starts it again, after a short back-off, whenever a signal
//! kills it (`SIGKILL` from the out-of-memory killer, or a crash). The keeper
//! touches little memory, runs no threads and holds no connection, so the
//! kernel prefers every other process over it. It is transparent to whoever
//! started it:
//!
//! * `SIGTERM`, `SIGINT`, `SIGHUP` and `SIGQUIT` are passed on and stop the
//!   agent for good; `SIGUSR1` and `SIGUSR2` are passed on. A signal ignored
//!   when the keeper started (`nohup`, a background job) stays ignored by both.
//! * A stop signal one of the agent's own commands sent (`kill -1` in a
//!   command reaches the keeper too) does not stop the keeper, and an agent
//!   such a signal ended is started again. A signal whose sender exited before
//!   the keeper could place it is passed on under that sender's name
//!   ([`signal_sender::queue_signal_from`]), so the agent, which knows whether
//!   it runs commands, decides; an agent such a signal ended is started again
//!   too.
//! * The keeper exits with the agent's exit status. An agent that exits by
//!   itself, with any status, is not started again.
//! * A keeper killed outright takes its agent with it (`PR_SET_PDEATHSIG`), as
//!   killing the agent's process did before.
//! * As a container's PID 1 it also reaps the orphans reparented to it.
//!
//! The agent that starts again is a new process: it reconnects with a new
//! connection instance, its predecessor's commands ended with it (their anchors
//! kill each command when the agent dies), and it reclaims their operation
//! cgroups at startup, exactly as after a service manager's restart.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use nix::sys::signal::{kill, SigSet, Signal};
use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
use nix::unistd::{alarm, getpid, getppid, Pid};
use opengeni_agent_platform::signal_sender::{self, Sender, SignalDelivery};

use crate::cli::{Cli, Command};

/// Names the keeper's PID in the environment of the agent it starts. The
/// agent removes it at once, so its commands (a nested `opengeni-agent run`
/// among them) never see it, and a verified self-update, which execs in place
/// and so stays the keeper's child, passes it on explicitly
/// ([`successor_env`]). Present with another parent, it therefore means the
/// keeper died.
pub(crate) const KEEPER_PID_ENV: &str = "OPENGENI_AGENT_KEEPER_PID";

/// Set by the keeper on an agent it starts again: why, for the agent's log.
const KEEPER_RESTART_ENV: &str = "OPENGENI_AGENT_KEEPER_RESTART";

/// The keeper of this agent, once [`kept_by_parent`] established it.
static KEPT_BY: OnceLock<Pid> = OnceLock::new();
/// Why the keeper started this agent again, if it did.
static RESTARTED: OnceLock<String> = OnceLock::new();

/// Signals that stop the agent for good when sent to the keeper.
const STOP_SIGNALS: [Signal; 4] = [
    Signal::SIGTERM,
    Signal::SIGINT,
    Signal::SIGHUP,
    Signal::SIGQUIT,
];

/// Signals the keeper only passes on.
const PASSED_SIGNALS: [Signal; 2] = [Signal::SIGUSR1, Signal::SIGUSR2];

/// First wait before starting a killed agent again; it doubles per kill.
const FIRST_BACKOFF: Duration = Duration::from_secs(1);
/// Longest wait between starts: the keeper never gives up.
const LONGEST_BACKOFF: Duration = Duration::from_secs(30);
/// A run this long counts as healthy, so the next kill restarts quickly.
const HEALTHY_RUN: Duration = Duration::from_secs(60);
/// How long a signal from a command (or a sender already gone) explains the
/// agent's death by that signal.
const COMMAND_SIGNAL_MEMORY: Duration = Duration::from_secs(10);

/// In the agent: whether its parent is the keeper that started it. If so, the
/// agent unblocks the signals the keeper blocks, which a spawned process
/// inherits, and dies with the keeper. Exits at once when the keeper died
/// before the agent could tie its life to it, as a killed keeper takes its
/// agent with it.
///
/// Must run before this process starts any thread: a thread keeps the mask it
/// started with, and so does every command such a thread starts. It also
/// removes the keeper's variables from this process's environment, which only
/// a single thread may do safely.
pub(crate) fn kept_by_parent() -> bool {
    let keeper = std::env::var_os(KEEPER_PID_ENV);
    let restart = std::env::var_os(KEEPER_RESTART_ENV);
    std::env::remove_var(KEEPER_PID_ENV);
    std::env::remove_var(KEEPER_RESTART_ENV);
    let Some(keeper) = keeper else {
        return false;
    };
    // Started by a keeper, so its blocked signals came with the spawn: unblock
    // them whatever happens next. `SIGUSR1` is left to the agent's reconnect
    // signal, which `main` already caught (it treats one blocked at start as
    // pending since an exec).
    let _ = inherited_from_keeper().thread_unblock();
    let Some(keeper) = keeper
        .to_str()
        .and_then(|value| value.parse::<i32>().ok())
        .map(Pid::from_raw)
    else {
        return false;
    };
    if getppid() != keeper {
        // The keeper died before this agent could tie its life to it.
        std::process::exit(1);
    }
    // Without the tie a dead keeper would leave this agent unsupervised, which
    // is how it would run without a keeper: still correct.
    if nix::sys::prctl::set_pdeathsig(Signal::SIGKILL).is_ok() && getppid() != keeper {
        // The keeper died between the check above and the tie.
        std::process::exit(1);
    }
    let _ = KEPT_BY.set(keeper);
    if let Some(restart) = restart.and_then(|restart| restart.into_string().ok()) {
        let _ = RESTARTED.set(restart);
    }
    true
}

/// The variable a verified self-update passes to its successor image: it
/// replaces this process, so it is the same keeper's child.
pub(crate) fn successor_env() -> Option<(&'static str, String)> {
    KEPT_BY
        .get()
        .map(|keeper| (KEEPER_PID_ENV, keeper.to_string()))
}

/// Logs, once tracing is up, that the keeper started this agent again, so an
/// out-of-memory kill leaves a trace in the agent's own log.
pub(crate) fn report_restart() {
    if let Some(restart) = RESTARTED.get() {
        tracing::warn!(
            previous_agent = %restart,
            "this agent was started again by its keeper after the previous agent was killed; SIGKILL usually means the kernel's out-of-memory killer chose it"
        );
    }
}

/// The signals the keeper blocks that the agent must receive normally.
fn inherited_from_keeper() -> SigSet {
    let mut set = watched_signals(&[]);
    set.remove(Signal::SIGUSR1);
    set
}

/// Whether this invocation should run the agent under a keeper: a foreground
/// `run` (or a bare launch, which runs an enrolled agent) that nothing else
/// starts again.
pub(crate) fn wanted(cli: &Cli, hosted_by_desktop_app: bool) -> bool {
    wanted_for(cli, hosted_by_desktop_app, parent_is_service_manager())
}

fn wanted_for(cli: &Cli, hosted_by_desktop_app: bool, under_service_manager: bool) -> bool {
    let foreground = match &cli.command {
        None => true,
        Some(Command::Run(args)) => args.compute.is_none(),
        Some(_) => false,
    };
    foreground && !hosted_by_desktop_app && !under_service_manager
}

/// The generated systemd units restart the agent themselves; systemd (system
/// or user manager) is then the agent's parent.
fn parent_is_service_manager() -> bool {
    std::fs::read_to_string(format!("/proc/{}/comm", getppid()))
        .is_ok_and(|comm| is_service_manager(&comm))
}

fn is_service_manager(comm: &str) -> bool {
    comm.trim_end() == "systemd"
}

/// Runs `executable` with this process's arguments as the kept agent until it
/// stops for good. `None` when the keeper cannot work here; the caller then
/// runs the agent in this process, as without a keeper. That is the case
/// when the signals it needs cannot be blocked, when `/proc` cannot tell which
/// signals were ignored at start (a keeper must leave those alone), when
/// `SIGCHLD` was ignored (the kernel then reaps children without reporting
/// their end, so a keeper would never see its agent die), and when the first
/// start fails.
///
/// Must run before this process starts any thread: the keeper waits for its
/// signals with `sigwait`, which only sees signals every thread blocks.
pub(crate) fn keep(executable: &Path) -> Option<ExitCode> {
    let ignored = ignored_signals()?;
    if ignored.contains(&Signal::SIGCHLD) {
        return None;
    }
    let watched = watched_signals(&ignored);
    if watched.thread_block().is_err() {
        return None;
    }
    let mut keeper = Keeper {
        executable: executable.to_path_buf(),
        args: std::env::args_os().skip(1).collect(),
        watched,
        stopping: None,
        from_commands: CommandSignals::default(),
        restarts: 0,
    };
    let Ok(first) = keeper.start(None) else {
        let _ = keeper.watched.thread_unblock();
        return None;
    };
    Some(keeper.run(first))
}

struct Keeper {
    executable: PathBuf,
    args: Vec<OsString>,
    watched: SigSet,
    /// The stop signal received, if any: the agent is not started again.
    stopping: Option<Signal>,
    /// The recent signals one of the agent's commands sent, or a sender gone
    /// before it could be placed: an agent one of them ended is started again.
    from_commands: CommandSignals,
    /// How many times the agent was started again.
    restarts: u32,
}

impl Keeper {
    /// Starts the agent. It inherits this process's signal mask and unblocks
    /// the keeper's signals itself as it starts ([`kept_by_parent`]). A
    /// restart names the signal that killed the previous agent.
    fn start(&self, killed_by: Option<Signal>) -> std::io::Result<Pid> {
        let mut command = std::process::Command::new(&self.executable);
        command
            .args(&self.args)
            .env(KEEPER_PID_ENV, getpid().to_string());
        if let Some(signal) = killed_by {
            command.env(
                KEEPER_RESTART_ENV,
                format!("killed by {signal}; restart {}", self.restarts),
            );
        }
        let child = command.spawn()?;
        let pid = i32::try_from(child.id()).map_err(std::io::Error::other)?;
        // Reaped below with `waitpid`, together with any orphan.
        drop(child);
        Ok(Pid::from_raw(pid))
    }

    fn run(&mut self, mut agent: Pid) -> ExitCode {
        let mut backoff = FIRST_BACKOFF;
        loop {
            let started = Instant::now();
            let status = self.wait_for(agent);
            let signal = match status {
                AgentEnd::Exited(code) => return ExitCode::from(code),
                AgentEnd::Killed(signal) => signal,
            };
            if let Some(stop) = self.stopping {
                return signal_exit_code(stop);
            }
            if !starts_again(signal, self.from_commands.contains(signal, Instant::now())) {
                return signal_exit_code(signal);
            }
            if started.elapsed() >= HEALTHY_RUN {
                backoff = FIRST_BACKOFF;
            }
            eprintln!(
                "opengeni-agent: the agent (pid {agent}) was killed by {signal}{}; starting it again in {} s",
                if signal == Signal::SIGKILL {
                    ", for example by the out-of-memory killer"
                } else {
                    ""
                },
                backoff.as_secs()
            );
            loop {
                if !self.sleep(backoff) {
                    return signal_exit_code(self.stopping.unwrap_or(Signal::SIGTERM));
                }
                self.restarts = self.restarts.saturating_add(1);
                match self.start(Some(signal)) {
                    Ok(pid) => {
                        agent = pid;
                        self.from_commands.clear();
                        break;
                    }
                    Err(error) => {
                        eprintln!("opengeni-agent: could not start the agent again: {error}");
                    }
                }
                backoff = next_backoff(backoff);
            }
            backoff = next_backoff(backoff);
        }
    }

    /// Waits until `agent` ends, passing signals on and reaping orphans.
    fn wait_for(&mut self, agent: Pid) -> AgentEnd {
        loop {
            if let Some(end) = reap(agent) {
                return end;
            }
            let Some((signal, delivery)) = self.next_signal() else {
                continue;
            };
            let stop = STOP_SIGNALS.contains(&signal);
            if !stop && !PASSED_SIGNALS.contains(&signal) {
                continue;
            }
            match placed(delivery, Some(agent)) {
                // The agent received its command's signal itself.
                Sender::Command if stop => self.from_commands.note(signal, Instant::now()),
                Sender::Command => {
                    self.from_commands.note(signal, Instant::now());
                    let _ = kill(agent, signal);
                }
                Sender::Gone(sender) => {
                    self.from_commands.note(signal, Instant::now());
                    if signal_sender::queue_signal_from(agent.as_raw(), signal as i32, sender)
                        .is_err()
                    {
                        let _ = kill(agent, signal);
                    }
                }
                Sender::Outside(_) => {
                    if stop {
                        self.stopping = Some(signal);
                    }
                    let _ = kill(agent, signal);
                }
            }
        }
    }

    /// Sleeps for `duration`, reaping orphans. `false` when a stop signal came.
    fn sleep(&mut self, duration: Duration) -> bool {
        let seconds = u32::try_from(duration.as_secs().max(1)).unwrap_or(u32::MAX);
        alarm::set(seconds);
        loop {
            let Some((signal, delivery)) = self.next_signal() else {
                continue;
            };
            if STOP_SIGNALS.contains(&signal) {
                let from_command = match placed(delivery, None) {
                    Sender::Command => true,
                    // Most likely the rest of what ended the agent, such as
                    // `kill -HUP -1; kill -TERM -1`.
                    Sender::Gone(_) => self.from_commands.any(Instant::now()),
                    Sender::Outside(_) => false,
                };
                if !from_command {
                    alarm::cancel();
                    self.stopping = Some(signal);
                    return false;
                }
            }
            if signal == Signal::SIGCHLD {
                let _ = reap(Pid::from_raw(0));
            }
            if signal == Signal::SIGALRM {
                return true;
            }
        }
    }
}

impl Keeper {
    /// Waits for the next watched signal and its sender.
    fn next_signal(&self) -> Option<(Signal, SignalDelivery)> {
        let watched: Vec<i32> = self.watched.iter().map(|signal| signal as i32).collect();
        let delivery = signal_sender::wait_for_signal(&watched).ok()?;
        Some((Signal::try_from(delivery.signal).ok()?, delivery))
    }
}

/// Who sent `delivery`: one of the agent's commands (a descendant of this
/// keeper other than `agent` itself), a sender already gone, or anyone else.
/// Says so when it was not from outside.
fn placed(delivery: SignalDelivery, agent: Option<Pid>) -> Sender {
    if delivery.sender.is_some() && delivery.sender == agent.map(Pid::as_raw) {
        return Sender::Outside(delivery.sender);
    }
    let sender = signal_sender::place(delivery.sender, getpid().as_raw());
    match sender {
        Sender::Command => eprintln!(
            "opengeni-agent: the keeper keeps running: one of the agent's own commands (pid {}) sent it signal {} (for example `kill -1`, which signals every process of the user)",
            delivery.sender.unwrap_or_default(),
            delivery.signal
        ),
        Sender::Gone(pid) => eprintln!(
            "opengeni-agent: the keeper keeps running: signal {} came from pid {pid}, which already exited; it is passed on to the agent, which stops unless it is running commands",
            delivery.signal
        ),
        Sender::Outside(_) => {}
    }
    sender
}

/// Recent signals from the agent's commands (or senders already gone), each
/// remembered for [`COMMAND_SIGNAL_MEMORY`].
#[derive(Debug, Default)]
struct CommandSignals(Vec<(Signal, Instant)>);

impl CommandSignals {
    fn note(&mut self, signal: Signal, now: Instant) {
        self.forget_old(now);
        self.0.retain(|(noted, _)| *noted != signal);
        self.0.push((signal, now));
    }

    fn contains(&mut self, signal: Signal, now: Instant) -> bool {
        self.forget_old(now);
        self.0.iter().any(|(noted, _)| *noted == signal)
    }

    fn any(&mut self, now: Instant) -> bool {
        self.forget_old(now);
        !self.0.is_empty()
    }

    fn clear(&mut self) {
        self.0.clear();
    }

    fn forget_old(&mut self, now: Instant) {
        self.0
            .retain(|(_, at)| now.saturating_duration_since(*at) < COMMAND_SIGNAL_MEMORY);
    }
}

/// How the agent ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentEnd {
    Exited(u8),
    Killed(Signal),
}

/// Reaps every exited child; returns `agent`'s end if it was among them.
fn reap(agent: Pid) -> Option<AgentEnd> {
    let mut end = None;
    loop {
        match waitpid(None::<Pid>, Some(WaitPidFlag::WNOHANG)) {
            Ok(WaitStatus::Exited(pid, code)) if pid == agent => {
                end = Some(AgentEnd::Exited(u8::try_from(code).unwrap_or(1)));
            }
            Ok(WaitStatus::Signaled(pid, signal, _)) if pid == agent => {
                end = Some(AgentEnd::Killed(signal));
            }
            Ok(WaitStatus::StillAlive) | Err(_) => return end,
            Ok(_) => {}
        }
    }
}

/// Signals that end an agent without anyone asking it to stop: the
/// out-of-memory killer's `SIGKILL`, and crashes.
fn restarts_after(signal: Signal) -> bool {
    matches!(
        signal,
        Signal::SIGKILL
            | Signal::SIGSEGV
            | Signal::SIGBUS
            | Signal::SIGABRT
            | Signal::SIGILL
            | Signal::SIGFPE
            | Signal::SIGSYS
    )
}

/// Whether an agent `signal` ended is started again: after a kill or crash,
/// and after a recent signal one of its own commands sent (`from_command`),
/// which the keeper did not obey either.
fn starts_again(signal: Signal, from_command: bool) -> bool {
    restarts_after(signal) || from_command
}

fn next_backoff(backoff: Duration) -> Duration {
    (backoff * 2).min(LONGEST_BACKOFF)
}

/// The shell convention for a process a signal ended.
fn signal_exit_code(signal: Signal) -> ExitCode {
    ExitCode::from(signal_exit_status(signal))
}

fn signal_exit_status(signal: Signal) -> u8 {
    128_u8.saturating_add(u8::try_from(signal as i32).unwrap_or(0))
}

/// The signals the keeper waits for: its stop and passed signals that were not
/// ignored when it started, its children's ends and its back-off alarm.
fn watched_signals(ignored: &[Signal]) -> SigSet {
    let mut set = SigSet::empty();
    for signal in STOP_SIGNALS.into_iter().chain(PASSED_SIGNALS) {
        if !ignored.contains(&signal) {
            set.add(signal);
        }
    }
    set.add(Signal::SIGCHLD);
    set.add(Signal::SIGALRM);
    set
}

/// The signals this process ignores, from `/proc/self/status`. A blocked
/// signal is queued even when ignored, so these must not be waited for.
fn ignored_signals() -> Option<Vec<Signal>> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    parse_ignored_signals(&status)
}

fn parse_ignored_signals(status: &str) -> Option<Vec<Signal>> {
    let mask = status
        .lines()
        .find_map(|line| line.strip_prefix("SigIgn:"))
        .and_then(|mask| u64::from_str_radix(mask.trim(), 16).ok())?;
    Some(
        Signal::iterator()
            .filter(|signal| {
                let bit = (*signal as i32) - 1;
                (0..64).contains(&bit) && mask & (1 << bit) != 0
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser as _;

    fn cli(args: &[&str]) -> Cli {
        Cli::try_parse_from(std::iter::once("opengeni-agent").chain(args.iter().copied()))
            .expect("valid command line")
    }

    #[test]
    fn only_a_foreground_run_nothing_restarts_gets_a_keeper() {
        // A bare launch and `run`, from a shell, a container or a CI job.
        assert!(wanted_for(&cli(&[]), false, false));
        assert!(wanted_for(&cli(&["run"]), false, false));
        assert!(wanted_for(
            &cli(&["--api-url", "https://example.test", "run"]),
            false,
            false
        ));
        // A compute sandbox's guest init restarts the agent itself.
        assert!(!wanted_for(
            &cli(&["run", "--compute", "/run/link.json"]),
            false,
            false
        ));
        // So do the desktop app and the generated systemd services.
        assert!(!wanted_for(&cli(&["run"]), true, false));
        assert!(!wanted_for(&cli(&["run"]), false, true));
        assert!(!wanted_for(&cli(&[]), false, true));
        // One-shot commands are not agents.
        assert!(!wanted_for(&cli(&["connections"]), false, false));
    }

    #[test]
    fn only_crashes_and_kills_start_the_agent_again() {
        for signal in [
            Signal::SIGKILL,
            Signal::SIGSEGV,
            Signal::SIGABRT,
            Signal::SIGBUS,
        ] {
            assert!(restarts_after(signal), "{signal}");
        }
        for signal in [
            Signal::SIGTERM,
            Signal::SIGINT,
            Signal::SIGHUP,
            Signal::SIGQUIT,
            Signal::SIGPIPE,
        ] {
            assert!(!restarts_after(signal), "{signal}");
        }
    }

    #[test]
    fn an_agent_its_own_commands_stop_signal_ended_starts_again() {
        assert!(starts_again(Signal::SIGHUP, true));
        assert!(starts_again(Signal::SIGKILL, false));
        assert!(!starts_again(Signal::SIGHUP, false));
    }

    /// `kill -HUP -1; kill -TERM -1` in a command: the agent the hangup ended
    /// starts again, whichever signal came last. A command's signal explains
    /// only a death soon after it, so a later stop by a person still stops.
    #[test]
    fn every_recent_command_signal_explains_the_agents_death() {
        let start = Instant::now();
        let mut signals = CommandSignals::default();
        assert!(!signals.any(start));
        signals.note(Signal::SIGHUP, start);
        signals.note(Signal::SIGTERM, start);
        assert!(signals.contains(Signal::SIGHUP, start));
        assert!(signals.contains(Signal::SIGTERM, start));
        assert!(!signals.contains(Signal::SIGQUIT, start));
        let later = start + COMMAND_SIGNAL_MEMORY;
        assert!(!signals.contains(Signal::SIGHUP, later));
        assert!(!signals.any(later));
        signals.note(Signal::SIGHUP, later);
        signals.clear();
        assert!(!signals.any(later));
    }

    /// A stop signal from one of the agent's commands (a descendant of the
    /// keeper below the agent) is not obeyed; one from the agent itself, the
    /// keeper's parent or the kernel is.
    #[test]
    fn only_the_agents_commands_count_as_its_commands() {
        let mut agent = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("sleep 30 & echo $!; wait")
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("start an agent stand-in");
        let mut line = String::new();
        std::io::BufRead::read_line(
            &mut std::io::BufReader::new(agent.stdout.take().expect("stdout")),
            &mut line,
        )
        .expect("its command's pid");
        let command: i32 = line.trim().parse().expect("a pid");
        let agent_pid = Pid::from_raw(i32::try_from(agent.id()).expect("pid"));
        let from = |sender: Option<i32>| SignalDelivery {
            signal: Signal::SIGTERM as i32,
            sender,
        };
        let agent = Some(agent_pid);
        assert_eq!(placed(from(Some(command)), agent), Sender::Command);
        for outside in [agent_pid.as_raw(), getppid().as_raw(), getpid().as_raw()] {
            assert_eq!(
                placed(from(Some(outside)), agent),
                Sender::Outside(Some(outside))
            );
        }
        assert_eq!(placed(from(None), agent), Sender::Outside(None));
        let _ = kill(Pid::from_raw(command), Signal::SIGKILL);
        let _ = agent.kill();
        let _ = agent.wait();
    }

    #[test]
    fn back_off_doubles_up_to_its_limit() {
        let mut backoff = FIRST_BACKOFF;
        let mut seen = Vec::new();
        for _ in 0..7 {
            seen.push(backoff.as_secs());
            backoff = next_backoff(backoff);
        }
        assert_eq!(seen, [1, 2, 4, 8, 16, 30, 30]);
    }

    #[test]
    fn signal_exits_follow_the_shell_convention() {
        assert_eq!(signal_exit_status(Signal::SIGTERM), 143);
        assert_eq!(signal_exit_status(Signal::SIGINT), 130);
    }

    #[test]
    fn ignored_signals_are_read_from_the_status_mask() {
        // SIGHUP (1), SIGINT (2) and SIGQUIT (3), as `nohup cmd &` leaves them.
        let status = "Name:\tsh\nSigBlk:\t0000000000000000\nSigIgn:\t0000000000000007\n";
        assert_eq!(
            parse_ignored_signals(status),
            Some(vec![Signal::SIGHUP, Signal::SIGINT, Signal::SIGQUIT])
        );
        let watched = watched_signals(&parse_ignored_signals(status).unwrap());
        assert!(!watched.contains(Signal::SIGHUP));
        assert!(!watched.contains(Signal::SIGINT));
        assert!(watched.contains(Signal::SIGTERM));
        assert!(watched.contains(Signal::SIGCHLD));
        assert!(watched.contains(Signal::SIGALRM));
        assert_eq!(parse_ignored_signals("Name:\tsh\n"), None);
    }

    #[test]
    fn only_systemd_counts_as_a_restarting_parent() {
        assert!(is_service_manager("systemd\n"));
        assert!(!is_service_manager("bash\n"));
        assert!(!is_service_manager("sh\n"));
        assert!(!is_service_manager("systemd-run\n"));
    }
}
