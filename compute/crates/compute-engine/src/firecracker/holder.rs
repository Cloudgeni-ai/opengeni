//! Open files kept for a VM by a process of its own.
//!
//! Some state belongs to one open file description rather than to a file,
//! such as which write errors on a disk have already been reported through
//! it. To keep such a description for as long as its VM lives, whatever
//! happens to the host agent, it is handed to a holder: a process that does
//! nothing but keep it open, placed in the VM's cgroup so it ends with the
//! VM. A new agent gets the same description back with `pidfd_getfd(2)`.

use std::fs;
use std::io;
use std::os::fd::OwnedFd;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use rustix::process::{Pid, PidfdFlags, PidfdGetfdFlags};
use tokio::process::Command;

use super::process::in_cgroup;
use crate::cgroup::Cgroup;
use crate::error::EngineError;

/// The holder's program and its argument: it sleeps until killed.
const PROGRAM: &str = "sleep";
const ARGUMENT: &str = "infinity";

/// Run by the shell the holder starts as, with the VM group's process list
/// as `$1`: it joins the group itself and only then becomes the holder, so
/// it never holds the file outside the group, even when the agent that
/// started it dies at once. If the group is gone, it exits.
const JOIN_THEN_HOLD: &str = "echo 0 > \"$1\" && exec sleep infinity";

/// The descriptor the holder keeps the file at: its standard input.
const HELD_FD: i32 = 0;

/// Starts a holder of `file` in `cgroup`, finding its program on `path`,
/// and returns once it holds the file there.
pub(super) async fn hold(cgroup: Cgroup, path: &str, file: OwnedFd) -> Result<(), EngineError> {
    start(&cgroup, path, file)
        .await
        .map(drop)
        .map_err(|error| EngineError::io("hold", error))
}

/// Returns the holder's process id.
async fn start(cgroup: &Cgroup, path: &str, file: OwnedFd) -> io::Result<u32> {
    /// How long a holder may take to join its group and start.
    const LIMIT: Duration = Duration::from_secs(5);
    let mut child = Command::new("sh")
        .args(["-c", JOIN_THEN_HOLD, "sh"])
        .arg(cgroup.path().join("cgroup.procs"))
        .env_clear()
        .env("PATH", path)
        .stdin(Stdio::from(file))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Out of the agent's process group, so signals aimed at the agent
        // (such as Ctrl-C) never reach it.
        .process_group(0)
        .spawn()?;
    let pid = child
        .id()
        .ok_or_else(|| io::Error::other("the holder exited at once"))?;
    // Only a shell that joined the group becomes the holder.
    let holding = format!("{PROGRAM}\0{ARGUMENT}\0");
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Err(io::Error::other(format!(
                "the holder could not join its group: {status}"
            )));
        }
        if fs::read(format!("/proc/{pid}/cmdline"))? == holding.as_bytes() {
            // Tokio reaps it should it end while this agent runs; init
            // does after.
            return Ok(pid);
        }
        if started.elapsed() > LIMIT {
            let _ = child.start_kill();
            return Err(io::Error::other("the holder did not start in time"));
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

/// A new descriptor for the open file a holder in `cgroup` keeps, if one
/// does. `relative` is the group's path below the cgroup v2 mount and
/// `vmm` the VM's own process, which is never a holder. Reads a few small
/// kernel files.
pub(super) fn held(
    cgroup: &Cgroup,
    relative: &Path,
    vmm: Pid,
) -> Result<Option<OwnedFd>, EngineError> {
    find(cgroup, relative, vmm).map_err(|error| EngineError::io("held", error))
}

fn find(cgroup: &Cgroup, relative: &Path, vmm: Pid) -> io::Result<Option<OwnedFd>> {
    for pid in cgroup.processes()? {
        if pid == vmm {
            continue;
        }
        if let Some(holder) = pin(pid, relative)? {
            return rustix::process::pidfd_getfd(&holder, HELD_FD, PidfdGetfdFlags::empty())
                .map(Some)
                .map_err(io::Error::from);
        }
    }
    Ok(None)
}

/// Whether a process other than a holder may be in `cgroup`, at
/// `relative` below the cgroup v2 mount, such as a VMM. Reads a few small
/// kernel files.
pub(super) fn besides_holders(cgroup: &Cgroup, relative: &Path) -> io::Result<bool> {
    if !cgroup.is_populated()? {
        return Ok(false);
    }
    for pid in cgroup.processes()? {
        // One that ended meanwhile is not known to be a holder either.
        if pin(pid, relative)?.is_none() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Pins process `pid` if it is a holder in the group at `relative`.
fn pin(pid: Pid, relative: &Path) -> io::Result<Option<OwnedFd>> {
    let pidfd = match rustix::process::pidfd_open(pid, PidfdFlags::empty()) {
        Ok(pidfd) => pidfd,
        Err(rustix::io::Errno::SRCH) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    // Checked after pinning, so a process that reused the pid of one that
    // ended cannot pass for it.
    let command = match fs::read(format!("/proc/{}/cmdline", pid.as_raw_pid())) {
        Ok(command) => command,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let holder = command == format!("{PROGRAM}\0{ARGUMENT}\0").as_bytes();
    Ok((holder && in_cgroup(pid, relative)?).then_some(pidfd))
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use rustix::process::{Pid, Signal, kill_process};

    use super::{Cgroup, hold, start};

    /// Holds the write end of a pipe: the read end sees its end only once
    /// no process keeps the write end open.
    fn pipe() -> (std::io::PipeReader, std::os::fd::OwnedFd) {
        let (reader, writer) = std::io::pipe().unwrap();
        (reader, writer.into())
    }

    /// The holder joins its group itself before it holds anything, so
    /// whatever happens to the agent that started it, it never holds a
    /// file outside the group: when the group is gone, nothing holds it.
    #[tokio::test]
    async fn a_holder_holds_only_inside_its_group() {
        let dir = tempfile::tempdir().unwrap();
        let (mut reader, writer) = pipe();
        let gone = Cgroup::at(dir.path().join("gone"));
        assert!(hold(gone, "/usr/bin:/bin", writer).await.is_err());
        let mut rest = Vec::new();
        assert_eq!(
            reader.read_to_end(&mut rest).unwrap(),
            0,
            "a holder outlived its failed start"
        );

        // A stand-in for a group's process list: the holder wrote itself
        // into it, not the agent.
        let group = Cgroup::at(dir.path());
        std::fs::write(dir.path().join("cgroup.procs"), "").unwrap();
        let (mut reader, writer) = pipe();
        let pid = start(&group, "/usr/bin:/bin", writer).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("cgroup.procs")).unwrap(),
            "0\n"
        );
        let pid = Pid::from_raw(i32::try_from(pid).unwrap()).unwrap();
        kill_process(pid, Signal::KILL).unwrap();
        assert_eq!(
            reader.read_to_end(&mut rest).unwrap(),
            0,
            "the holder held it"
        );
    }
}
