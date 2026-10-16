//! VMM processes the host agent watches but does not parent.
//!
//! The jailer forks Firecracker into its own PID namespace and session and
//! exits, so the VMM is never a child of the host agent: it survives the
//! agent stopping, crashing or being upgraded, and the init process reaps
//! it. The agent instead holds a pidfd, which names exactly one process for
//! as long as the descriptor is open (a recycled pid can never be confused
//! with it), becomes readable when that process exits, and can signal it.

use std::fs;
use std::io;
use std::os::fd::OwnedFd;
use std::path::Path;
use std::sync::Arc;

use rustix::process::{Pid, PidfdFlags, Signal};
use tokio::io::Interest;
use tokio::io::unix::AsyncFd;
use tokio::sync::watch;

/// Whether a VMM process is still alive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exit {
    /// Still running.
    Running,
    /// Ended.
    Exited,
}

/// One VMM process, pinned by a pidfd.
#[derive(Debug)]
pub(crate) struct Process {
    pid: Pid,
    pidfd: Arc<AsyncFd<OwnedFd>>,
    exit: watch::Receiver<Exit>,
}

impl Process {
    /// Pins process `pid` and starts watching for its exit. Must be called
    /// within a Tokio runtime.
    pub fn open(pid: Pid) -> io::Result<Self> {
        let pidfd = rustix::process::pidfd_open(pid, PidfdFlags::NONBLOCK)?;
        // SAFETY: an `OwnedFd` returns the descriptor it owns from every
        // `as_raw_fd` call and keeps it open until dropped, which only
        // happens when the `AsyncFd` is.
        let pidfd = unsafe { AsyncFd::register_with_interest(pidfd, Interest::READABLE) }
            .map_err(io::Error::from)?;
        let pidfd = Arc::new(pidfd);
        let (exit_tx, exit) = watch::channel(Exit::Running);
        let watched = Arc::clone(&pidfd);
        tokio::spawn(async move {
            // A pidfd turns readable once its process has exited. An error
            // here only means the runtime is shutting down.
            let _ = watched.readable().await;
            let _ = exit_tx.send(Exit::Exited);
        });
        Ok(Self { pid, pidfd, exit })
    }

    pub fn pid(&self) -> Pid {
        self.pid
    }

    pub fn exit(&self) -> watch::Receiver<Exit> {
        self.exit.clone()
    }

    pub fn is_running(&self) -> bool {
        *self.exit.borrow() == Exit::Running
    }

    /// Kills the process. Succeeds if it has already exited.
    pub fn kill(&self) -> io::Result<()> {
        match rustix::process::pidfd_send_signal(self.pidfd.get_ref(), Signal::KILL) {
            Ok(()) | Err(rustix::io::Errno::SRCH) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    /// Resolves once the process has exited.
    pub async fn exited(&self) {
        let mut exit = self.exit.clone();
        let _ = exit.wait_for(|exit| *exit == Exit::Exited).await;
    }
}

/// Makes `command` start its process in a session of its own, away from
/// the agent's terminal and process group, so signals aimed at the agent
/// (such as Ctrl-C) never reach a VM or its pager.
pub(crate) fn detach(command: &mut tokio::process::Command) {
    // SAFETY: the closure runs in the forked child before exec and makes
    // one setsid(2) call, which is async-signal-safe.
    unsafe {
        command.pre_exec(|| rustix::process::setsid().map(drop).map_err(io::Error::from));
    }
}

/// Whether process `pid` currently belongs to the cgroup at `relative`
/// (its path below the cgroup v2 mount, starting with `/`).
pub(crate) fn in_cgroup(pid: Pid, relative: &Path) -> io::Result<bool> {
    let membership = match fs::read_to_string(format!("/proc/{}/cgroup", pid.as_raw_pid())) {
        Ok(membership) => membership,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    Ok(membership
        .lines()
        .filter_map(|line| line.strip_prefix("0::"))
        .any(|path| Path::new(path) == relative))
}

/// Parses a pid file the jailer wrote.
pub(crate) fn parse_pid(text: &str) -> Option<Pid> {
    text.trim()
        .parse::<i32>()
        .ok()
        .filter(|pid| *pid > 0)
        .and_then(Pid::from_raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pid_files_hold_one_positive_number() {
        assert_eq!(parse_pid("4242").map(Pid::as_raw_pid), Some(4242));
        assert_eq!(parse_pid(" 17\n").map(Pid::as_raw_pid), Some(17));
        assert!(parse_pid("").is_none());
        assert!(parse_pid("0").is_none());
        assert!(parse_pid("-3").is_none());
        assert!(parse_pid("12 13").is_none());
    }

    #[tokio::test]
    async fn a_pidfd_sees_its_process_exit_and_survives_pid_reuse() {
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let pid = Pid::from_raw(i32::try_from(child.id()).unwrap()).unwrap();
        let process = Process::open(pid).unwrap();
        assert!(process.is_running());
        process.kill().unwrap();
        process.exited().await;
        assert!(!process.is_running());
        let _ = child.wait();
        // Signalling a reaped process through its pidfd never reaches a
        // process that reused the pid.
        process.kill().unwrap();
    }

    #[test]
    fn this_process_is_in_its_own_cgroup() {
        let me = Pid::from_raw(i32::try_from(std::process::id()).unwrap()).unwrap();
        let own = fs::read_to_string("/proc/self/cgroup").unwrap();
        let path = own
            .lines()
            .find_map(|line| line.strip_prefix("0::"))
            .unwrap();
        assert!(in_cgroup(me, Path::new(path)).unwrap());
        assert!(!in_cgroup(me, Path::new("/not-this-one")).unwrap());
    }
}
