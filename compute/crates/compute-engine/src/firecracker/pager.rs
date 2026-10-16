//! The page-fault handler process of a VM restored with
//! [`MemorySource::Pager`](crate::MemorySource).
//!
//! The pager is started after the VMM and before the VMM loads its state,
//! and then moved into the VM's own cgroup: from there on it lives beside
//! the VMM, survives the host agent like the VMM does, and is killed with
//! the VM's group at the latest. It exits on its own once the guest no
//! longer needs it, or once the VMM has gone.
//!
//! A guest whose memory is still registered with a fault handler stalls on
//! its next missing page if the handler is gone, for good: no other
//! process can take its place without what the dead one knew (which pages
//! the guest discarded, above all). [`lost`] tells a VM found in that
//! state from one whose pager finished.

use std::fs::{self, OpenOptions};
use std::io;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use rustix::process::Pid;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

use super::FirecrackerVm;
use super::process;
use crate::cgroup::Cgroup;
use crate::spec::PagerSpec;

/// How long a pager may take to listen.
const READY_TIMEOUT: Duration = Duration::from_secs(10);

/// Starts `pager` for `vm`, whose VMM runs as `uid`:`gid` and has not
/// loaded its state yet, and returns once the pager listens on a socket
/// the VMM may use and belongs to the VM's group. Its standard error goes
/// to `pager.log` in `logs`. On failure no pager is left running.
pub(super) async fn start(
    pager: &PagerSpec,
    vm: &FirecrackerVm,
    logs: &Path,
    uid: u32,
    gid: u32,
) -> io::Result<()> {
    let log_path = logs.join("pager.log");
    let log = {
        let path = log_path.clone();
        tokio::task::spawn_blocking(move || OpenOptions::new().create(true).append(true).open(path))
            .await
            .map_err(io::Error::other)??
    };
    let mut command = Command::new(&pager.program);
    command
        .args(&pager.args)
        // A finishing pager asks the VMM before it exits.
        .arg("--api-socket")
        .arg(vm.api.socket())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(log);
    process::detach(&mut command);
    let mut child = command.spawn()?;
    let started = async {
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("the pager exited at once"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("the pager's output is not piped"))?;
        let mut line = String::new();
        BufReader::new(stdout).read_line(&mut line).await?;
        if line.trim_end() != "ready" {
            return Err(io::Error::other(format!(
                "the pager did not start; see {}",
                log_path.display()
            )));
        }
        let (socket, cgroup) = (pager.socket.clone(), vm.cgroup.clone());
        tokio::task::spawn_blocking(move || {
            crate::confined::hand_over(&socket, uid, gid)?;
            cgroup.add(pid)
        })
        .await
        .map_err(io::Error::other)?
    };
    let error = match timeout(READY_TIMEOUT, started).await {
        // The pager is the VM group's concern now; the runtime reaps it
        // once it exits.
        Ok(Ok(())) => return Ok(()),
        Ok(Err(error)) => error,
        Err(_) => io::Error::new(
            io::ErrorKind::TimedOut,
            format!("the pager did not listen within {READY_TIMEOUT:?}"),
        ),
    };
    let _ = child.start_kill();
    let _ = child.wait().await;
    Err(error)
}

/// Whether the VM whose VMM is `vmm`, in `group`, lost its pager while
/// the guest still needed it: nothing but the VMM runs in the group, and
/// either guest memory is still registered for missing-page faults or a
/// VMM thread waits for a userfaultfd event to be read.
///
/// The group is read first: a pager unregisters the guest's memory and
/// reads every event still coming before it exits, so either state with
/// no pager left can only mean a pager that died. A thread whose wait
/// channel cannot be read proves nothing either way.
pub(super) fn lost(vmm: Pid, group: &Cgroup) -> io::Result<bool> {
    let vmm = vmm.as_raw_pid().unsigned_abs();
    if group.processes()?.into_iter().any(|pid| pid != vmm) {
        return Ok(false);
    }
    Ok(registered(vmm)? || waits_for_event_reader(vmm))
}

/// Whether a thread of process `pid` sleeps in the kernel's userfaultfd
/// code: until someone reads the event it queued (a discard of registered
/// memory, `userfaultfd_event_wait_completion` or the caller it is inlined
/// into) or answers its fault (`handle_userfault`). With no pager left,
/// nobody ever will. The kernel test `a_discard_nobody_reads_shows_in_its_wait_channel`
/// in the pager crate checks the name on the host's kernel.
fn waits_for_event_reader(pid: u32) -> bool {
    let Ok(threads) = fs::read_dir(format!("/proc/{pid}/task")) else {
        return false;
    };
    threads.flatten().any(|thread| {
        fs::read_to_string(thread.path().join("wchan"))
            .is_ok_and(|wchan| wchan.contains("userfault"))
    })
}

/// Whether any of process `pid`'s memory is registered with a
/// userfaultfd for missing pages.
fn registered(pid: u32) -> io::Result<bool> {
    let maps = fs::read_to_string(format!("/proc/{pid}/smaps"))?;
    Ok(maps
        .lines()
        .filter_map(|line| line.strip_prefix("VmFlags:"))
        .any(|flags| flags.split_whitespace().any(|flag| flag == "um")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_memory_is_not_registered() {
        assert!(!registered(std::process::id()).unwrap());
        assert!(!waits_for_event_reader(std::process::id()));
    }
}
