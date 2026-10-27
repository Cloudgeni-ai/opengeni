//! The watchdog kept open by systemd, in the guard service's file
//! descriptor store (`FileDescriptorStoreMax=` in compute-guard.service).
//!
//! Closing an armed watchdog feeds it (see [`compute_engine::watchdog`]),
//! so a guard that ended with the device its own, however it ended (a
//! crash, an error, a stop at the wrong moment), would give VMs that run
//! past their lease one more watchdog timeout than the fleet's margin
//! allows for. Kept by systemd too, the device stays open when the guard
//! ends, and the next guard of the service takes it over from the store,
//! without opening it, which would feed it too.
//!
//! A guard is ready only once it sees systemd keep the device: once
//! systemd has dealt with its request ([`Barrier`]) and lists the device
//! in the service's store after that ([`stored`]). That systemd holds the
//! descriptor shows nothing: it holds one it was sent while it decides
//! whether to keep it, and systemd 255 closes one it refused afterwards,
//! in a process of its own, possibly after it dealt with the barrier.

use std::fs::File;
use std::io::{self, IoSlice, PipeReader};
use std::mem::MaybeUninit;
use std::os::fd::{AsFd as _, BorrowedFd, FromRawFd as _, OwnedFd, RawFd};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use compute_engine::watchdog::Watchdog;
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::fs::{major, minor};
use rustix::io::{FdFlags, fcntl_setfd};
use rustix::net::{
    AddressFamily, SendAncillaryBuffer, SendAncillaryMessage, SendFlags, SocketAddrUnix,
    SocketFlags, SocketType, sendmsg_addr, socket_with,
};
use serde::Deserialize;

/// The name the guard keeps its watchdog under in the store.
pub const WATCHDOG: &str = "watchdog";

/// The first file descriptor systemd passes (`SD_LISTEN_FDS_START`).
const FIRST: RawFd = 3;

/// The file descriptor named `name` among those systemd passed, as its
/// `LISTEN_PID`, `LISTEN_FDS` and `LISTEN_FDNAMES` say, if they were passed
/// to process `pid`.
fn passed(
    pid: u32,
    listen_pid: Option<&str>,
    listen_fds: Option<&str>,
    names: Option<&str>,
    name: &str,
) -> Option<RawFd> {
    if listen_pid?.parse::<u32>().ok()? != pid {
        return None;
    }
    let count = listen_fds?.parse::<usize>().ok()?;
    let index = names?
        .split(':')
        .take(count)
        .position(|named| named == name)?;
    FIRST.checked_add(RawFd::try_from(index).ok()?)
}

/// The watchdog `device` systemd kept and passed to this process, armed
/// already; `None` if it passed none. The guard's, once, as it starts.
///
/// # Errors
///
/// When what was passed is not that device, or the device is not set up
/// as [`Watchdog::open`] requires.
pub fn kept(device: &Path, timeout: Duration) -> io::Result<Option<Watchdog>> {
    let var = |name: &str| std::env::var(name).ok();
    let Some(fd) = passed(
        std::process::id(),
        var("LISTEN_PID").as_deref(),
        var("LISTEN_FDS").as_deref(),
        var("LISTEN_FDNAMES").as_deref(),
        WATCHDOG,
    ) else {
        return Ok(None);
    };
    // SAFETY: systemd passed this process `fd`, open, under the guard's
    // name for its watchdog, and nothing else in the guard's process takes
    // the file descriptors systemd passes: the guard takes it once, as it
    // starts, and owns it from here on.
    let file = File::from(unsafe { OwnedFd::from_raw_fd(fd) });
    fcntl_setfd(&file, FdFlags::CLOEXEC)?;
    Watchdog::adopt(file, device, timeout).map(Some)
}

/// Asks systemd, through its notification socket `socket` (a path, or an
/// abstract name after `@`, as `NOTIFY_SOCKET` gives it), to keep `fd` in
/// the service's file descriptor store under `name`, without polling it.
/// It does not wait for systemd to take the message.
///
/// # Errors
///
/// When the message cannot be sent, as when systemd has not taken those
/// sent before it ([`io::ErrorKind::WouldBlock`]). systemd answers
/// nothing: one that cannot keep it (the service keeps no store) logs
/// that and closes it; a [`Barrier`] sent after it shows when systemd has
/// done one or the other.
pub fn keep(socket: &str, name: &str, fd: BorrowedFd<'_>) -> io::Result<()> {
    notify(socket, &format!("FDSTORE=1\nFDNAME={name}\nFDPOLL=0\n"), fd)
}

/// A barrier sent to systemd (`BARRIER=1`, as `sd_notify_barrier` sends
/// it): systemd deals with the notifications it is sent in order, and
/// closes the barrier's descriptor as it deals with it, so once the
/// barrier has [`passed`](Self::passed), every notification sent before it
/// has been dealt with: a descriptor systemd was asked to keep is in the
/// store, or closed.
#[derive(Debug)]
pub struct Barrier(PipeReader);

impl Barrier {
    /// Sends a barrier through systemd's notification socket `socket`,
    /// without waiting for systemd to take it.
    ///
    /// # Errors
    ///
    /// When the message cannot be sent, as when systemd has not taken those
    /// sent before it ([`io::ErrorKind::WouldBlock`]).
    pub fn send(socket: &str) -> io::Result<Self> {
        let (reader, writer) = std::io::pipe()?;
        notify(socket, "BARRIER=1\n", writer.as_fd())?;
        // Only systemd's end is left, so the pipe hangs up once it closes it.
        drop(writer);
        Ok(Self(reader))
    }

    /// Whether systemd has dealt with the barrier, without waiting.
    ///
    /// # Errors
    ///
    /// When the pipe cannot be polled.
    pub fn passed(&self) -> io::Result<bool> {
        let mut fds = [PollFd::new(&self.0, PollFlags::IN)];
        let now = Timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        poll(&mut fds, Some(&now))?;
        Ok(fds[0].revents().intersects(PollFlags::HUP | PollFlags::ERR))
    }
}

/// Sends systemd the notification `message` with the descriptor `fd`,
/// through its notification socket `socket` (a path, or an abstract name
/// after `@`, as `NOTIFY_SOCKET` gives it). It fails rather than waits
/// when systemd's queue is full: systemd waits on the same busy machine
/// as everything else, and the guard asks it from the step that feeds the
/// watchdog, which must not wait; it asks again later.
fn notify(socket: &str, message: &str, fd: BorrowedFd<'_>) -> io::Result<()> {
    let address = match socket.strip_prefix('@') {
        Some(abstract_name) => SocketAddrUnix::new_abstract_name(abstract_name.as_bytes())?,
        None if socket.starts_with('/') => SocketAddrUnix::new(socket)?,
        None => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("not a notification socket this guard can use: {socket}"),
            ));
        }
    };
    let sender = socket_with(
        AddressFamily::UNIX,
        SocketType::DGRAM,
        SocketFlags::CLOEXEC,
        None,
    )?;
    let fds = [fd];
    let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
    let mut control = SendAncillaryBuffer::new(&mut space);
    if !control.push(SendAncillaryMessage::ScmRights(&fds)) {
        return Err(io::Error::other("no room for the file descriptor"));
    }
    let sent = sendmsg_addr(
        &sender,
        &address,
        &[IoSlice::new(message.as_bytes())],
        &mut control,
        SendFlags::DONTWAIT,
    )?;
    if sent != message.len() {
        return Err(io::Error::other("the notification was cut short"));
    }
    Ok(())
}

/// Which file a descriptor is open on, as systemd lists the files in a
/// store: the device holding it, its inode, and, for a device file, the
/// device it is. The watchdog opens once at a time, so a stored file of
/// the watchdog device is the guard's own open file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Identity {
    dev: (u32, u32),
    inode: u64,
    rdev: (u32, u32),
}

impl Identity {
    /// The file `fd` is open on.
    ///
    /// # Errors
    ///
    /// When it cannot be looked at.
    pub fn of(fd: BorrowedFd<'_>) -> io::Result<Self> {
        let stat = rustix::fs::fstat(fd)?;
        Ok(Self {
            dev: (major(stat.st_dev), minor(stat.st_dev)),
            inode: stat.st_ino,
            rdev: (major(stat.st_rdev), minor(stat.st_rdev)),
        })
    }
}

/// Whether this process's service keeps the file `identity` names in its
/// store, under `name`, as systemd lists the store (`systemd-analyze
/// fdstore`, systemd 254 and later): only a descriptor it kept is listed.
/// The service is the user's manager's (`MANAGERPID` set) or the
/// system's. It waits for systemd to answer, so the guard asks from
/// another thread.
///
/// # Errors
///
/// When the service cannot be found or systemd does not list its store,
/// as for a service that keeps none.
pub fn stored(name: &str, identity: Identity) -> io::Result<bool> {
    let cgroup = std::fs::read_to_string("/proc/self/cgroup")?;
    let unit = service_of(&cgroup).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!("not in a service's cgroup: {}", cgroup.trim()),
        )
    })?;
    let output = listing(unit, std::env::var_os("MANAGERPID").is_some()).output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "systemd-analyze fdstore {unit}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    listed(&output.stdout, name, identity)
}

/// The command that lists the store of `unit`, the user's manager's if
/// `user`. It gets neither systemd's notification socket nor the
/// descriptors systemd passed: they are the guard's, and systemd's tools
/// notify their exit status through a socket they are given, which systemd
/// then refuses, and logs, from a process that is not the service's main
/// one.
fn listing(unit: &str, user: bool) -> Command {
    let mut list = Command::new("systemd-analyze");
    for passed in [
        "NOTIFY_SOCKET",
        "LISTEN_PID",
        "LISTEN_FDS",
        "LISTEN_FDNAMES",
    ] {
        list.env_remove(passed);
    }
    if user {
        list.arg("--user");
    }
    list.args(["fdstore", "--json=short", unit])
        .stdin(Stdio::null());
    list
}

/// The service a process in the cgroup `cgroup` (as `/proc/<pid>/cgroup`
/// reads, cgroup v2) runs in, as `sd_pid_get_unit` finds it.
fn service_of(cgroup: &str) -> Option<&str> {
    let path = cgroup.lines().find_map(|line| line.strip_prefix("0::"))?;
    path.rsplit('/')
        .find(|part| !part.is_empty())
        .filter(|unit| unit.ends_with(".service"))
}

/// Whether the store systemd lists as `json` (`systemd-analyze fdstore
/// --json=short`) holds the file `identity` names, under `name`.
fn listed(json: &[u8], name: &str, identity: Identity) -> io::Result<bool> {
    #[derive(Deserialize)]
    struct Entry {
        fdname: String,
        devno: Option<(u32, u32)>,
        inode: Option<u64>,
        rdevno: Option<(u32, u32)>,
    }
    let entries: Vec<Entry> = serde_json::from_slice(json)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok(entries.iter().any(|entry| {
        entry.fdname == name
            && entry.devno == Some(identity.dev)
            && entry.inode == Some(identity.inode)
            && entry.rdevno == Some(identity.rdev)
    }))
}

/// Fills the queue of the datagram socket bound at `socket`, as systemd's
/// is while it is slow to take its messages: one more message cannot be
/// sent without waiting. Returns the senders, which keep what they sent.
#[cfg(test)]
pub(super) fn fill_queue(socket: &Path) -> Vec<std::os::unix::net::UnixDatagram> {
    let mut fillers = Vec::new();
    // A sender's own buffer may fill before the queue does: fresh senders
    // go on until one cannot send even once.
    for _ in 0..10_000 {
        let filler = std::os::unix::net::UnixDatagram::unbound().unwrap();
        filler.set_nonblocking(true).unwrap();
        let mut sent = 0;
        loop {
            match filler.send_to(b"x", socket) {
                Ok(_) => sent += 1,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) => panic!("filling {}: {error}", socket.display()),
            }
        }
        fillers.push(filler);
        if sent == 0 {
            return fillers;
        }
    }
    panic!("the queue of {} never filled", socket.display());
}

#[cfg(test)]
mod tests {
    use std::io::IoSliceMut;
    use std::os::unix::net::UnixDatagram;

    use rustix::net::{RecvAncillaryBuffer, RecvAncillaryMessage, RecvFlags, recvmsg};

    use super::*;

    #[test]
    fn the_watchdog_is_found_among_what_systemd_passed_this_process() {
        let find = |pid, fds, names| passed(7, Some(pid), Some(fds), Some(names), WATCHDOG);
        assert_eq!(find("7", "1", "watchdog"), Some(3));
        assert_eq!(find("7", "3", "a:b:watchdog"), Some(5));
        assert_eq!(
            find("8", "1", "watchdog"),
            None,
            "passed to another process"
        );
        assert_eq!(find("7", "1", "other"), None);
        assert_eq!(find("7", "1", "a:watchdog"), None, "beyond what was passed");
        assert_eq!(find("7", "x", "watchdog"), None);
        assert_eq!(find("x", "1", "watchdog"), None);
        assert_eq!(passed(7, None, Some("1"), Some("watchdog"), WATCHDOG), None);
        assert_eq!(passed(7, Some("7"), Some("1"), None, WATCHDOG), None);
    }

    /// What systemd receives: the request to keep, unpolled, under the
    /// name, and the file itself.
    #[test]
    fn the_watchdog_is_sent_to_systemd_to_keep() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("notify");
        let systemd = UnixDatagram::bind(&socket).unwrap();
        let kept = File::create(dir.path().join("device")).unwrap();
        keep(socket.to_str().unwrap(), WATCHDOG, kept.as_fd()).unwrap();

        let mut text = [0_u8; 256];
        let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
        let mut control = RecvAncillaryBuffer::new(&mut space);
        let received = recvmsg(
            &systemd,
            &mut [IoSliceMut::new(&mut text)],
            &mut control,
            RecvFlags::empty(),
        )
        .unwrap();
        assert_eq!(
            std::str::from_utf8(&text[..received.bytes]).unwrap(),
            "FDSTORE=1\nFDNAME=watchdog\nFDPOLL=0\n"
        );
        let fds: Vec<OwnedFd> = control
            .drain()
            .filter_map(|message| match message {
                RecvAncillaryMessage::ScmRights(fds) => Some(fds),
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(fds.len(), 1);
        let (sent, got) = (
            rustix::fs::fstat(&kept).unwrap(),
            rustix::fs::fstat(&fds[0]).unwrap(),
        );
        assert_eq!((sent.st_dev, sent.st_ino), (got.st_dev, got.st_ino));

        assert!(keep("vsock:2:1", WATCHDOG, kept.as_fd()).is_err());
        assert!(
            keep(
                dir.path().join("none").to_str().unwrap(),
                WATCHDOG,
                kept.as_fd()
            )
            .is_err()
        );
    }

    /// What tells a guard that systemd keeps its watchdog: systemd listing
    /// the same file, under its name, in the service's store.
    #[test]
    fn a_file_is_seen_stored_only_when_systemd_lists_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = File::create(dir.path().join("device")).unwrap();
        let identity = Identity::of(file.as_fd()).unwrap();
        let entry = |name: &str, identity: Identity| {
            format!(
                r#"{{"fdname":"{name}","type":8592,"devno":[{},{}],"inode":{},"rdevno":[{},{}],"path":"/dev/watchdog0","flags":"wo"}}"#,
                identity.dev.0, identity.dev.1, identity.inode, identity.rdev.0, identity.rdev.1
            )
        };
        let other = Identity {
            inode: identity.inode + 1,
            ..identity
        };
        let list = |entries: &[String]| format!("[{}]", entries.join(","));
        let stored = |json: String| listed(json.as_bytes(), WATCHDOG, identity).unwrap();
        assert!(stored(list(&[entry(WATCHDOG, identity)])));
        assert!(stored(list(&[
            entry("x", other),
            entry(WATCHDOG, identity)
        ])));
        assert!(!stored(list(&[])), "an empty store");
        assert!(!stored(list(&[entry(WATCHDOG, other)])), "another file");
        assert!(!stored(list(&[entry("x", identity)])), "another name");
        assert!(
            !stored(
                r#"[{"fdname":"watchdog","type":49663,"devno":[0,10],"inode":1,"rdevno":null,"path":"socket:[1]","flags":"rw"}]"#
                    .into()
            ),
            "a socket"
        );
        assert!(listed(b"", WATCHDOG, identity).is_err());
        assert!(listed(b"Failed", WATCHDOG, identity).is_err());
    }

    /// The store is listed without what systemd gave the guard: its
    /// notification socket, which systemd-analyze would notify its exit
    /// status through, and its passed descriptors.
    #[test]
    fn the_store_is_listed_without_what_systemd_gave_the_guard() {
        let list = listing("compute-guard.service", false);
        let removed: Vec<_> = list
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(key, _)| key.to_str().unwrap())
            .collect();
        for passed in [
            "NOTIFY_SOCKET",
            "LISTEN_PID",
            "LISTEN_FDS",
            "LISTEN_FDNAMES",
        ] {
            assert!(removed.contains(&passed), "{passed} kept");
        }
        let args: Vec<_> = list.get_args().map(|arg| arg.to_str().unwrap()).collect();
        assert_eq!(args, ["fdstore", "--json=short", "compute-guard.service"]);
        let user = listing("test.service", true);
        assert_eq!(user.get_args().next().unwrap(), "--user");
    }

    /// The service a process runs in, from its cgroup.
    #[test]
    fn a_process_s_service_is_its_cgroup_s() {
        assert_eq!(
            service_of("0::/system.slice/compute-guard.service\n"),
            Some("compute-guard.service")
        );
        assert_eq!(
            service_of("0::/user.slice/user-1000.slice/user@1000.service/app.slice/test.service\n"),
            Some("test.service")
        );
        assert_eq!(
            service_of("0::/user.slice/user-1000.slice/session-3.scope\n"),
            None
        );
        assert_eq!(service_of("1:name=systemd:/x.service\n"), None, "cgroup v1");
        assert_eq!(service_of(""), None);
    }

    /// A barrier passes once systemd has closed what it was sent, not while
    /// the message waits or systemd holds it.
    #[test]
    fn a_barrier_passes_once_systemd_closes_it() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("notify");
        let systemd = UnixDatagram::bind(&socket).unwrap();
        let barrier = Barrier::send(socket.to_str().unwrap()).unwrap();
        assert!(!barrier.passed().unwrap(), "not yet received");

        let mut text = [0_u8; 64];
        let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
        let mut control = RecvAncillaryBuffer::new(&mut space);
        let received = recvmsg(
            &systemd,
            &mut [IoSliceMut::new(&mut text)],
            &mut control,
            RecvFlags::empty(),
        )
        .unwrap();
        assert_eq!(&text[..received.bytes], b"BARRIER=1\n");
        let fds: Vec<OwnedFd> = control
            .drain()
            .filter_map(|message| match message {
                RecvAncillaryMessage::ScmRights(fds) => Some(fds),
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(fds.len(), 1);
        assert!(!barrier.passed().unwrap(), "received, not yet dealt with");
        drop(fds);
        assert!(barrier.passed().unwrap());
    }

    /// systemd slow to take its messages: asking it fails at once, rather
    /// than holding up the guard's step, which feeds the watchdog.
    #[test]
    fn asking_systemd_does_not_wait_for_it_to_take_the_message() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("notify");
        let _systemd = UnixDatagram::bind(&socket).unwrap();
        let _queued = fill_queue(&socket);
        let socket = socket.to_str().unwrap().to_owned();
        let kept = File::create(dir.path().join("device")).unwrap();
        let (done, answers) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let keeping = keep(&socket, WATCHDOG, kept.as_fd()).map_err(|error| error.kind());
            let barrier = Barrier::send(&socket)
                .map(drop)
                .map_err(|error| error.kind());
            let _ = done.send((keeping, barrier));
        });
        let (keeping, barrier) = answers
            .recv_timeout(Duration::from_secs(1))
            .expect("waited for systemd to take the message");
        assert_eq!(keeping, Err(io::ErrorKind::WouldBlock));
        assert_eq!(barrier, Err(io::ErrorKind::WouldBlock));
    }
}
