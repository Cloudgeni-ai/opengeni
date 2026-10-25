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
//! systemd has dealt with its request ([`Barrier`]) and holds the device
//! after that ([`held_by_manager`]). systemd holds a descriptor it was
//! sent for a moment before it decides whether to keep it, so holding it
//! alone shows nothing.

use std::fs::File;
use std::io::{self, IoSlice, PipeReader};
use std::mem::MaybeUninit;
use std::os::fd::{AsFd as _, AsRawFd as _, BorrowedFd, FromRawFd as _, OwnedFd, RawFd};
use std::path::{Path, PathBuf};
use std::time::Duration;

use compute_engine::watchdog::Watchdog;
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::io::{FdFlags, fcntl_setfd};
use rustix::net::{
    AddressFamily, SendAncillaryBuffer, SendAncillaryMessage, SendFlags, SocketAddrUnix,
    SocketFlags, SocketType, sendmsg_addr, socket_with,
};

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
///
/// # Errors
///
/// When the message cannot be sent. systemd answers nothing: one that
/// cannot keep it (the service keeps no store) logs that and closes it;
/// a [`Barrier`] sent after it shows when systemd has done one or the
/// other.
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
    /// Sends a barrier through systemd's notification socket `socket`.
    ///
    /// # Errors
    ///
    /// When the message cannot be sent.
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
/// after `@`, as `NOTIFY_SOCKET` gives it).
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
        SendFlags::empty(),
    )?;
    if sent != message.len() {
        return Err(io::Error::other("the notification was cut short"));
    }
    Ok(())
}

/// Whether the service manager holds the file `fd` is open on: the user's
/// manager (`MANAGERPID`) for a user's service, otherwise PID 1. For the
/// watchdog, which opens once at a time, that is the guard's own open
/// file, which the manager holds only in the service's store.
///
/// # Errors
///
/// When the manager's descriptors cannot be read.
pub fn held_by_manager(fd: BorrowedFd<'_>) -> io::Result<bool> {
    let manager = std::env::var("MANAGERPID")
        .ok()
        .and_then(|pid| pid.parse::<u32>().ok())
        .unwrap_or(1);
    held_by(manager, fd)
}

/// Whether process `pid` has a descriptor open on the file `fd` is open on.
fn held_by(pid: u32, fd: BorrowedFd<'_>) -> io::Result<bool> {
    let path = |of: PathBuf| std::fs::read_link(of).ok();
    let ours = path(PathBuf::from(format!("/proc/self/fd/{}", fd.as_raw_fd())));
    let same = rustix::fs::fstat(fd)?;
    for entry in std::fs::read_dir(format!("/proc/{pid}/fd"))? {
        // A descriptor closed meanwhile is not the one.
        let Ok(entry) = entry else { continue };
        // Its path first, so only a likely one is looked at.
        if path(entry.path()) != ours {
            continue;
        }
        let Ok(theirs) = rustix::fs::stat(entry.path()) else {
            continue;
        };
        if (theirs.st_dev, theirs.st_ino, theirs.st_rdev)
            == (same.st_dev, same.st_ino, same.st_rdev)
        {
            return Ok(true);
        }
    }
    Ok(false)
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

    /// What tells a guard that systemd keeps its watchdog: another process
    /// holding the same file.
    #[test]
    fn a_file_is_seen_held_only_by_a_process_that_holds_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = File::create(dir.path().join("device")).unwrap();
        let other = File::create(dir.path().join("other")).unwrap();
        let holding = std::process::Command::new("sleep")
            .arg("30")
            .stdin(file.try_clone().unwrap())
            .spawn()
            .unwrap();
        let not_holding = std::process::Command::new("sleep")
            .arg("30")
            .stdin(other.try_clone().unwrap())
            .spawn()
            .unwrap();
        assert!(held_by(holding.id(), file.as_fd()).unwrap());
        assert!(!held_by(not_holding.id(), file.as_fd()).unwrap());
        assert!(held_by(not_holding.id(), other.as_fd()).unwrap());
        for mut child in [holding, not_holding] {
            child.kill().unwrap();
            child.wait().unwrap();
        }
        assert!(held_by(u32::MAX, file.as_fd()).is_err(), "no such process");
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
}
