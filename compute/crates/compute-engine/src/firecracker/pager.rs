//! The page-fault handler process of a VM restored with
//! [`MemorySource::Pager`](crate::MemorySource).
//!
//! The pager is started after the VMM and before the VMM loads its state,
//! and then moved into the VM's own cgroup: from there on it lives beside
//! the VMM, survives the host agent like the VMM does, and is killed with
//! the VM's group at the latest. Before it says it is ready it runs as the
//! VM's own user, with no capabilities and no way to gain any, and the
//! engine checks that it does. It exits on its own once the guest no
//! longer needs it, or once the VMM has gone.
//!
//! A guest whose memory is still registered with a fault handler stalls on
//! its next missing page if the handler is gone, for good: no other
//! process can take its place without what the dead one knew (which pages
//! the guest discarded, above all). [`lost`] tells a VM found in that
//! state from one whose pager finished.

use std::fs::{self, OpenOptions};
use std::io;
use std::os::unix::ffi::OsStrExt;
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
/// the VMM may use, runs as the VM's user and belongs to the VM's group.
/// Its standard error goes to `pager.log` in `logs`. On failure no pager
/// is left running.
pub(super) async fn start(
    pager: &PagerSpec,
    vm: &FirecrackerVm,
    logs: &Path,
    uid: u32,
    gid: u32,
) -> io::Result<()> {
    let log_path = logs.join("pager.log");
    let log = {
        let (path, dir) = (log_path.clone(), pager.dir.clone());
        tokio::task::spawn_blocking(move || {
            crate::confined::hand_over(&dir, crate::confined::Owned::Dir, uid, gid)?;
            OpenOptions::new().create(true).append(true).open(path)
        })
        .await
        .map_err(io::Error::other)??
    };
    let mut command = Command::new(&pager.program);
    command
        .args(&pager.args)
        // A finishing pager asks the VMM before it exits; the argument also
        // marks the process as this VM's pager (see `lost`).
        .arg(API_SOCKET_ARG)
        .arg(vm.api.socket())
        .arg("--user")
        .arg(format!("{uid}:{gid}"))
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
            check_user(pid, uid, gid)?;
            crate::confined::hand_over(&socket, crate::confined::Owned::Socket, uid, gid)?;
            cgroup.add(pid)?;
            // Its VM cannot go on without it either.
            let pid = i32::try_from(pid)
                .ok()
                .and_then(Pid::from_raw)
                .ok_or_else(|| io::Error::other(format!("bad pager pid {pid}")))?;
            process::protect_from_oom(pid)
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

/// The argument that hands a pager its VMM's API socket.
const API_SOCKET_ARG: &str = "--api-socket";

/// Checks that process `pid`, a pager that said it is ready, runs as
/// `uid`:`gid` alone, with no capabilities and no way to gain any. `pid`
/// is the caller's unreaped child, so the number cannot name another
/// process.
fn check_user(pid: u32, uid: u32, gid: u32) -> io::Result<()> {
    let status = fs::read_to_string(format!("/proc/{pid}/status"))?;
    let problem = user_problem(&status, uid, gid);
    match problem {
        None => Ok(()),
        Some(problem) => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("the pager still {problem}"),
        )),
    }
}

/// What, in a process's `/proc/<pid>/status`, is more than a process of
/// `uid`:`gid` alone with no capabilities and no new privileges has.
fn user_problem(status: &str, uid: u32, gid: u32) -> Option<String> {
    let field = |name: &str| {
        status
            .lines()
            .find_map(|line| line.strip_prefix(name)?.strip_prefix(':'))
            .map(str::trim)
    };
    let ids = |id: u32| format!("{id}\t{id}\t{id}\t{id}");
    let expected = [
        ("Uid", ids(uid)),
        ("Gid", ids(gid)),
        ("Groups", String::new()),
        ("CapInh", "0".repeat(16)),
        ("CapPrm", "0".repeat(16)),
        ("CapEff", "0".repeat(16)),
        ("CapAmb", "0".repeat(16)),
        ("NoNewPrivs", "1".to_owned()),
    ];
    expected.into_iter().find_map(|(name, value)| {
        let found = field(name);
        (found != Some(value.as_str())).then(|| format!("has {name} {found:?}"))
    })
}

/// Whether the VM whose VMM is `vmm` and whose API listens at `api`, in
/// `group`, lost its pager while the guest still needed it: no pager of
/// this VM runs in the group, and either guest memory is still registered
/// for missing-page faults or a VMM thread waits for a userfaultfd event
/// to be read.
///
/// The group is read first: a pager unregisters the guest's memory and
/// reads every event still coming before it exits, so either state with
/// no pager left can only mean a pager that died. A thread whose wait
/// channel cannot be read proves nothing either way. A pager is known by
/// the API socket the engine passed it, so other helpers in the group do
/// not hide its death; a process whose command line cannot be read counts
/// as a pager, which keeps the VM.
pub(super) fn lost(vmm: Pid, group: &Cgroup, api: &Path) -> io::Result<bool> {
    if group
        .processes()?
        .into_iter()
        .any(|pid| pid != vmm && is_pager(pid.as_raw_pid().unsigned_abs(), api))
    {
        return Ok(false);
    }
    let vmm = vmm.as_raw_pid().unsigned_abs();
    Ok(registered(vmm)? || waits_for_event_reader(vmm))
}

/// Whether process `pid` is the pager of the VM whose API listens at
/// `api`, or cannot be told apart from one.
fn is_pager(pid: u32, api: &Path) -> bool {
    let Ok(cmdline) = fs::read(format!("/proc/{pid}/cmdline")) else {
        // Gone since the group was read, or unreadable: only a process
        // that is certainly gone is certainly not the pager.
        return Path::new(&format!("/proc/{pid}")).exists();
    };
    names_pager(&cmdline, api)
}

/// Whether process `pid` is certainly the pager of the VM whose API
/// listens at `api`: one whose command line cannot be read is not.
pub(super) fn certainly_pager(pid: Pid, api: &Path) -> bool {
    fs::read(format!("/proc/{}/cmdline", pid.as_raw_pid()))
        .is_ok_and(|cmdline| names_pager(&cmdline, api))
}

/// Whether a NUL-separated command line passes `api` as the API socket.
fn names_pager(cmdline: &[u8], api: &Path) -> bool {
    let mut args = cmdline.split(|&byte| byte == 0);
    while let Some(arg) = args.next() {
        if arg == API_SOCKET_ARG.as_bytes() {
            return args.next() == Some(api.as_os_str().as_bytes());
        }
    }
    false
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

    #[test]
    fn a_pager_must_run_as_its_vm_alone() {
        let dropped = "Name:\tcompute-host\nUid:\t7\t7\t7\t7\nGid:\t8\t8\t8\t8\nGroups:\t\n\
            CapInh:\t0000000000000000\nCapPrm:\t0000000000000000\n\
            CapEff:\t0000000000000000\nCapBnd:\t000001ffffffffff\n\
            CapAmb:\t0000000000000000\nNoNewPrivs:\t1\n";
        assert_eq!(user_problem(dropped, 7, 8), None);
        assert!(user_problem(dropped, 7, 9).unwrap().contains("Gid"));
        let root = dropped.replace("Uid:\t7\t7\t7\t7", "Uid:\t0\t0\t0\t0");
        assert!(user_problem(&root, 7, 8).unwrap().contains("Uid"));
        let saved = dropped.replace("Uid:\t7\t7\t7\t7", "Uid:\t7\t7\t0\t7");
        assert!(
            user_problem(&saved, 7, 8).is_some(),
            "could become root again"
        );
        let capable = dropped.replace("CapEff:\t0000000000000000", "CapEff:\t000001ffffffffff");
        assert!(user_problem(&capable, 7, 8).unwrap().contains("CapEff"));
        let grouped = dropped.replace("Groups:\t", "Groups:\t0");
        assert!(user_problem(&grouped, 7, 8).unwrap().contains("Groups"));
        let free = dropped.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0");
        assert!(user_problem(&free, 7, 8).unwrap().contains("NoNewPrivs"));
    }

    #[test]
    fn a_pager_is_known_by_its_vms_api_socket() {
        let api = Path::new("/srv/jail/vm/run/api.socket");
        assert!(names_pager(
            b"/bin/host\0pager\0--vmm-socket\0/x\0--api-socket\0/srv/jail/vm/run/api.socket\0",
            api
        ));
        assert!(!names_pager(
            b"/bin/host\0pager\0--api-socket\0/srv/jail/other/run/api.socket\0",
            api
        ));
        assert!(!names_pager(b"sleep\0infinity\0", api));
        assert!(!names_pager(b"/bin/host\0pager\0--api-socket\0", api));
    }
}
