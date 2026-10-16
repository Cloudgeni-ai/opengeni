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

use rustix::process::{Pid, PidfdFlags, PidfdGetfdFlags};
use tokio::process::Command;

use super::process::in_cgroup;
use crate::cgroup::Cgroup;
use crate::error::EngineError;

/// The holder's program and its argument: it sleeps until killed.
const PROGRAM: &str = "sleep";
const ARGUMENT: &str = "infinity";

/// The descriptor the holder keeps the file at: its standard input.
const HELD_FD: i32 = 0;

/// Starts a holder of `file` in `cgroup`, finding its program on `path`.
pub(super) fn hold(cgroup: &Cgroup, path: &str, file: OwnedFd) -> Result<(), EngineError> {
    start(cgroup, path, file).map_err(|error| EngineError::io("hold", error))
}

fn start(cgroup: &Cgroup, path: &str, file: OwnedFd) -> io::Result<()> {
    let mut child = Command::new(PROGRAM)
        .arg(ARGUMENT)
        .env_clear()
        .env("PATH", path)
        .stdin(Stdio::from(file))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Out of the agent's process group, so signals aimed at the agent
        // (such as Ctrl-C) never reach it.
        .process_group(0)
        .spawn()?;
    let added = child
        .id()
        .ok_or_else(|| io::Error::other("the holder exited at once"))
        .and_then(|pid| cgroup.add(pid));
    if let Err(error) = added {
        let _ = child.start_kill();
        return Err(error);
    }
    // Tokio reaps it should it end while this agent runs; init does after.
    Ok(())
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
