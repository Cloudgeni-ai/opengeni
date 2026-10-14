//! Carrying a running contained exec into a successor process image.
//!
//! An in-place agent update `exec`s the new binary in the same process, so the
//! command, its anchor, and every descendant stay children of this PID and in
//! their process group and operation cgroup. What does not survive `exec` is
//! Rust state: tokio's child handles and close-on-exec descriptors. This
//! module turns the live parts of a [`crate::ContainedExec`] into an
//! [`ExecHandover`] (plain PIDs plus inheritable descriptor numbers) and back.
//!
//! A handover never weakens containment. The anchor's death lease is carried
//! like any other descriptor, so if the successor never starts (or dies) the
//! kernel closes the lease and the anchor kills the whole operation, exactly as
//! for a crashed runner.

use std::os::fd::{IntoRawFd as _, OwnedFd, RawFd};
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::ExitStatus;
use std::sync::OnceLock;
use std::time::Duration;

use nix::errno::Errno;
use nix::fcntl::{fcntl, FcntlArg, FdFlag};
use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
use nix::unistd::Pid;
use serde::{Deserialize, Serialize};

/// How often an adopted child's exit is re-checked even without a SIGCHLD
/// wakeup (a coalesced signal must never strand a wait).
const ADOPTED_WAIT_POLL: Duration = Duration::from_millis(250);

/// One direct child as carried across `exec`: either still running (its PID)
/// or already reaped (its raw wait status).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcHandover {
    /// The child's PID while it has not been reaped.
    pub pid: Option<i32>,
    /// The raw wait status once reaped.
    pub status: Option<i32>,
}

/// The operation cgroup leaf of a handed-over exec and the policy applied to
/// it, so the successor can keep enforcing exactly that policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpCgroupHandover {
    /// The leaf's absolute path.
    pub dir: PathBuf,
    /// Applied `memory.max`, if any.
    pub memory_max: Option<u64>,
    /// Applied `memory.high`, if any.
    pub memory_high: Option<u64>,
    /// Applied CPU quota in thousandths of a CPU, if any.
    pub cpu_max_millicores: Option<u32>,
}

/// Everything a successor needs to keep owning one contained exec.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecHandover {
    /// The stopped anchor that owns the process group and holds the lease.
    pub anchor: ProcHandover,
    /// The requested command.
    pub child: ProcHandover,
    /// The process group of the command and its anchor.
    pub pgid: i32,
    /// Whether teardown has not finished yet.
    pub running: bool,
    /// Whether the post-exit group kill already ran.
    pub wait_killed_group: bool,
    /// The write end of the anchor's death lease.
    pub lease_fd: Option<RawFd>,
    /// The command's stdin write end, when the runner still feeds it.
    pub stdin_fd: Option<RawFd>,
    /// The command's stdout read end, until EOF.
    pub stdout_fd: Option<RawFd>,
    /// The command's stderr read end, until EOF.
    pub stderr_fd: Option<RawFd>,
    /// The operation cgroup leaf, when per-op isolation is active.
    pub op_cgroup: Option<OpCgroupHandover>,
}

impl ExecHandover {
    /// The operation cgroup leaf a successor must keep rather than reclaim.
    #[must_use]
    pub fn op_cgroup_dir(&self) -> Option<&std::path::Path> {
        self.op_cgroup.as_ref().map(|cgroup| cgroup.dir.as_path())
    }

    /// Every descriptor this handover carries.
    #[must_use]
    pub fn descriptors(&self) -> Vec<RawFd> {
        [self.lease_fd, self.stdin_fd, self.stdout_fd, self.stderr_fd]
            .into_iter()
            .flatten()
            .collect()
    }

    /// Lets every carried descriptor survive `exec`. Call it immediately
    /// before `exec`, after nothing else in this process will spawn: an
    /// inheritable death lease in an unrelated child would keep the anchor
    /// alive past this agent.
    ///
    /// # Errors
    ///
    /// A descriptor's flags could not be changed.
    pub fn prepare_exec(&self) -> std::io::Result<()> {
        self.descriptors()
            .into_iter()
            .try_for_each(keep_across_exec)
    }

    /// Gives up a handover nobody will claim. Closing the carried death lease
    /// makes the anchor end the operation, as for a crashed runner.
    pub fn abandon(&self) {
        for fd in self.descriptors() {
            drop(claim(fd));
        }
    }
}

/// Closes a descriptor a predecessor image carried but nobody can use, so
/// the operation whose death lease it may be ends instead of running
/// unobserved.
pub fn discard_inherited_fd(fd: RawFd) {
    drop(claim(fd));
}

/// Makes a descriptor a predecessor image carried close-on-exec until its
/// job claims it.
///
/// # Errors
///
/// The descriptor is not open.
pub fn keep_inherited_fd_private(fd: RawFd) -> std::io::Result<()> {
    fcntl(fd, FcntlArg::F_SETFD(FdFlag::FD_CLOEXEC))
        .map(drop)
        .map_err(std::io::Error::from)
}

/// Lets a descriptor survive `exec`.
fn keep_across_exec(fd: RawFd) -> std::io::Result<()> {
    fcntl(fd, FcntlArg::F_SETFD(FdFlag::empty()))
        .map(drop)
        .map_err(std::io::Error::from)
}

/// Gives up ownership of a descriptor; the successor (or an in-process
/// resume) claims the number back.
pub(crate) fn release_fd(fd: OwnedFd) -> RawFd {
    fd.into_raw_fd()
}

/// Claims a descriptor recorded in this process's own handover.
pub(crate) fn claim(fd: RawFd) -> std::io::Result<OwnedFd> {
    opengeni_agent_linux_ffi::claim_inherited_fd(fd)
}

/// A direct child: tokio-owned when this process image spawned it, or adopted
/// by PID after an in-place `exec` (it is still our child, so `waitpid` works).
#[derive(Debug)]
pub(crate) enum UnixProc {
    Owned(tokio::process::Child),
    Adopted(AdoptedChild),
}

#[derive(Debug)]
pub(crate) struct AdoptedChild {
    pid: i32,
    status: Option<ExitStatus>,
}

impl UnixProc {
    pub(crate) fn adopt(handover: ProcHandover) -> Self {
        Self::Adopted(AdoptedChild {
            pid: handover.pid.unwrap_or(0),
            status: handover
                .status
                .map(ExitStatus::from_raw)
                .or_else(|| handover.pid.is_none().then(|| ExitStatus::from_raw(0))),
        })
    }

    /// The PID while the child has not been reaped.
    pub(crate) fn id(&self) -> Option<u32> {
        match self {
            Self::Owned(child) => child.id(),
            Self::Adopted(child) => child
                .status
                .is_none()
                .then(|| u32::try_from(child.pid).ok())
                .flatten(),
        }
    }

    /// Waits for exit. Cancel-safe: the status is recorded synchronously at
    /// reap, so a dropped and re-created wait returns the same status.
    pub(crate) async fn wait(&mut self) -> std::io::Result<ExitStatus> {
        match self {
            Self::Owned(child) => child.wait().await,
            Self::Adopted(child) => child.wait().await,
        }
    }

    /// A placeholder for a child whose ownership moved elsewhere.
    pub(crate) fn released() -> Self {
        Self::Adopted(AdoptedChild {
            pid: 0,
            status: Some(ExitStatus::from_raw(0)),
        })
    }

    /// The carried form, without changing ownership (fallible, so it runs
    /// before anything is given up).
    pub(crate) fn carried(&mut self) -> std::io::Result<ProcHandover> {
        match self {
            Self::Owned(child) => Ok(match child.try_wait()? {
                Some(status) => ProcHandover {
                    pid: None,
                    status: Some(status.into_raw()),
                },
                None => ProcHandover {
                    pid: child.id().and_then(|pid| i32::try_from(pid).ok()),
                    status: None,
                },
            }),
            Self::Adopted(child) => Ok(ProcHandover {
                pid: child.status.is_none().then_some(child.pid),
                status: child.status.map(ExitStatusExt::into_raw),
            }),
        }
    }

    /// Gives up ownership without signaling. A tokio child is forgotten rather
    /// than dropped: its `kill_on_drop` must not fire, and after `exec`
    /// nothing of tokio's state remains anyway.
    pub(crate) fn release(self) {
        if let Self::Owned(child) = self {
            std::mem::forget(child);
        }
    }
}

impl AdoptedChild {
    async fn wait(&mut self) -> std::io::Result<ExitStatus> {
        loop {
            if let Some(status) = self.status {
                return Ok(status);
            }
            // Subscribe before checking so an exit between the check and the
            // await still wakes this wait.
            let mut exits = child_exit_signal();
            exits.borrow_and_update();
            match waitpid(Pid::from_raw(self.pid), Some(WaitPidFlag::WNOHANG)) {
                Ok(WaitStatus::Exited(_, code)) => {
                    self.status = Some(ExitStatus::from_raw((code & 0xff) << 8));
                }
                Ok(WaitStatus::Signaled(_, signal, core)) => {
                    self.status = Some(ExitStatus::from_raw(
                        signal as i32 | if core { 0x80 } else { 0 },
                    ));
                }
                Ok(_) => {
                    tokio::select! {
                        _ = exits.changed() => {}
                        () = tokio::time::sleep(ADOPTED_WAIT_POLL) => {}
                    }
                }
                Err(Errno::EINTR) => {}
                Err(error) => return Err(std::io::Error::from(error)),
            }
        }
    }
}

/// One process-wide SIGCHLD listener fanned out to every adopted wait.
fn child_exit_signal() -> tokio::sync::watch::Receiver<u64> {
    static EXITS: OnceLock<tokio::sync::watch::Sender<u64>> = OnceLock::new();
    EXITS
        .get_or_init(|| {
            let (sender, _) = tokio::sync::watch::channel(0_u64);
            let notifier = sender.clone();
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child()) {
                Ok(mut signals) => {
                    tokio::spawn(async move {
                        while signals.recv().await.is_some() {
                            notifier.send_modify(|count| *count = count.wrapping_add(1));
                        }
                    });
                }
                Err(error) => {
                    // Polling alone still settles every adopted wait.
                    tracing::warn!(%error, "cannot listen for SIGCHLD; adopted commands are polled");
                }
            }
            sender
        })
        .subscribe()
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader};

    use crate::spawn_contained;

    fn script(body: &str) -> tokio::process::Command {
        let mut command = tokio::process::Command::new("/bin/sh");
        command.arg("-c").arg(body);
        command
    }

    fn alive(pid: i32) -> bool {
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
    }

    /// Whether our own direct child has exited (reaping it if so). A zombie
    /// still answers signal probes, so `alive` cannot tell for direct children.
    fn reaped(pid: i32) -> bool {
        !matches!(
            nix::sys::wait::waitpid(
                nix::unistd::Pid::from_raw(pid),
                Some(nix::sys::wait::WaitPidFlag::WNOHANG),
            ),
            Ok(nix::sys::wait::WaitStatus::StillAlive)
        )
    }

    /// A running command keeps producing output and is waited to its real exit
    /// code across handover and adoption; nothing is signaled in between.
    #[tokio::test]
    async fn a_handed_over_command_keeps_running_and_exits_with_its_own_status() {
        let mut exec = spawn_contained(
            script(
                "read line; echo \"got $line\"; sleep 1; echo one; sleep 1; echo two; echo err >&2; exit 7",
            ),
            None,
        )
        .unwrap();
        let mut stdin = exec.stdin.take();
        let mut stdout = BufReader::new(exec.stdout.take().unwrap());
        let stderr = exec.stderr.take();
        stdin.as_mut().unwrap().write_all(b"hello\n").await.unwrap();
        let mut first = String::new();
        stdout.read_line(&mut first).await.unwrap();
        assert_eq!(first, "got hello\n");
        assert!(stdout.buffer().is_empty(), "the test reads line by line");

        exec.stdin = stdin;
        exec.stdout = Some(stdout.into_inner());
        exec.stderr = stderr;
        let handover = exec.into_handover().map_err(|(_, error)| error).unwrap();
        let child_pid = handover.child.pid.expect("still running");
        assert!(handover.running);
        assert!(alive(child_pid));
        let carried = serde_json::to_string(&handover).unwrap();
        let handover: super::ExecHandover = serde_json::from_str(&carried).unwrap();

        let mut adopted = crate::ContainedExec::adopt(&handover, None).unwrap();
        drop(adopted.stdin.take());
        let mut out = String::new();
        let mut err = String::new();
        let mut stdout = adopted.stdout.take().unwrap();
        let mut stderr = adopted.stderr.take().unwrap();
        let (status, _, _) = tokio::join!(
            adopted.wait(),
            stdout.read_to_string(&mut out),
            stderr.read_to_string(&mut err),
        );
        assert_eq!(status.unwrap().code(), Some(7));
        assert_eq!(out, "one\ntwo\n");
        assert_eq!(err, "err\n");
        assert!(!alive(child_pid));
    }

    /// Adoption is still contained: dropping the adopted exec kills the whole
    /// group, including a descendant.
    #[tokio::test]
    async fn an_adopted_command_is_still_killed_with_its_group() {
        let mut exec = spawn_contained(script("sleep 300 & echo $!; wait"), None).unwrap();
        let mut stdout = BufReader::new(exec.stdout.take().unwrap());
        let mut line = String::new();
        stdout.read_line(&mut line).await.unwrap();
        let grandchild: i32 = line.trim().parse().unwrap();
        exec.stdout = Some(stdout.into_inner());
        let handover = exec.into_handover().map_err(|(_, error)| error).unwrap();
        let child = handover.child.pid.unwrap();
        let adopted = crate::ContainedExec::adopt(&handover, None).unwrap();
        assert!(alive(grandchild));
        drop(adopted);
        for _ in 0..100 {
            if reaped(child) && !alive(grandchild) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("the adopted group outlived its owner");
    }

    /// If no successor ever claims the handover, closing the carried death
    /// lease (what process exit does) makes the anchor kill the operation.
    #[tokio::test]
    async fn an_unclaimed_handover_is_killed_by_its_anchor() {
        let exec = spawn_contained(script("sleep 300"), None).unwrap();
        let handover = exec.into_handover().map_err(|(_, error)| error).unwrap();
        let child = handover.child.pid.unwrap();
        assert!(alive(child));
        for fd in handover.descriptors() {
            drop(super::claim(fd).unwrap());
        }
        for _ in 0..100 {
            if !alive(child) {
                // Our zombie child: reap it so the test leaves nothing behind.
                let _ = nix::sys::wait::waitpid(nix::unistd::Pid::from_raw(child), None);
                return;
            }
            if let Ok(nix::sys::wait::WaitStatus::Signaled(..)) = nix::sys::wait::waitpid(
                nix::unistd::Pid::from_raw(child),
                Some(nix::sys::wait::WaitPidFlag::WNOHANG),
            ) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("the anchor did not kill an unclaimed operation");
    }
}
