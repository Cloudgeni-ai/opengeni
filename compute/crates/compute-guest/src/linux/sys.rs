//! The system calls an init makes that the standard library has no safe
//! form of. Every `unsafe` block in the guest's system code is here (vsock
//! sockets are in `vsock`), each a direct call with arguments built just
//! before it.

use std::ffi::CString;
use std::fs::File;
use std::io;
use std::net::Ipv4Addr;
use std::os::fd::{AsRawFd, OwnedFd};
use std::time::Duration;

fn check(result: libc::c_int) -> io::Result<()> {
    if result == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn c_string(text: &str) -> io::Result<CString> {
    CString::new(text).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
}

/// `mount(2)`.
pub fn mount(
    source: &str,
    target: &str,
    fstype: &str,
    flags: libc::c_ulong,
    data: &str,
) -> io::Result<()> {
    let (source, target, fstype, data) = (
        c_string(source)?,
        c_string(target)?,
        c_string(fstype)?,
        c_string(data)?,
    );
    // SAFETY: all four are valid NUL-terminated strings that outlive the call.
    check(unsafe {
        libc::mount(
            source.as_ptr(),
            target.as_ptr(),
            fstype.as_ptr(),
            flags,
            data.as_ptr().cast(),
        )
    })
}

/// Remounts the root file system read-only, so a power-off loses nothing.
pub fn remount_root_read_only() -> io::Result<()> {
    let root = c_string("/")?;
    // SAFETY: a valid string; null source, type and data are allowed for a remount.
    check(unsafe {
        libc::mount(
            std::ptr::null(),
            root.as_ptr(),
            std::ptr::null(),
            libc::MS_REMOUNT | libc::MS_RDONLY,
            std::ptr::null(),
        )
    })
}

/// The `statvfs` flags a remount must give again to keep them, each with
/// its `mount(2)` flag.
const KEPT_ON_REMOUNT: [(libc::c_ulong, libc::c_ulong); 8] = [
    (libc::ST_RDONLY, libc::MS_RDONLY),
    (libc::ST_NOSUID, libc::MS_NOSUID),
    (libc::ST_NODEV, libc::MS_NODEV),
    (libc::ST_NOEXEC, libc::MS_NOEXEC),
    (libc::ST_SYNCHRONOUS, libc::MS_SYNCHRONOUS),
    (libc::ST_NOATIME, libc::MS_NOATIME),
    (libc::ST_NODIRATIME, libc::MS_NODIRATIME),
    (libc::ST_RELATIME, libc::MS_RELATIME),
];

/// Whether the root file system is mounted read-only.
pub fn root_read_only() -> io::Result<bool> {
    Ok(root_flags()? & libc::ST_RDONLY != 0)
}

/// The root file system's `statvfs` flags.
fn root_flags() -> io::Result<libc::c_ulong> {
    let root = c_string("/")?;
    // SAFETY: statvfs is plain data, valid when zeroed.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: a valid string and a statvfs that outlive the call.
    check(unsafe { libc::statvfs(root.as_ptr(), &raw mut stat) })?;
    Ok(stat.f_flag)
}

/// Remounts the root file system with its file system's options `data`
/// changed, and everything else as it is.
pub fn remount_root(data: &str) -> io::Result<()> {
    let found = root_flags()?;
    let flags = KEPT_ON_REMOUNT
        .iter()
        .filter(|(kept, _)| found & kept != 0)
        .fold(libc::MS_REMOUNT, |flags, (_, flag)| flags | flag);
    let (root, data) = (c_string("/")?, c_string(data)?);
    // SAFETY: valid strings that outlive the call; null source and type are
    // allowed for a remount.
    check(unsafe {
        libc::mount(
            std::ptr::null(),
            root.as_ptr(),
            std::ptr::null(),
            flags,
            data.as_ptr().cast(),
        )
    })
}

/// `EXT4_IOC_RESIZE_FS`: `_IOW('f', 16, __u64)`.
const EXT4_IOC_RESIZE_FS: libc::Ioctl = libc::_IOW::<u64>(0x66, 16);

/// Grows the ext4 file system holding `path`, mounted, to `blocks` of its
/// blocks. Any other file system fails with `ENOTTY`.
pub fn resize_file_system(path: &str, blocks: u64) -> io::Result<()> {
    let dir = File::open(path)?;
    // SAFETY: an open descriptor and a u64 that outlives the call, which
    // the kernel only reads.
    check(unsafe { libc::ioctl(dir.as_raw_fd(), EXT4_IOC_RESIZE_FS, &raw const blocks) })
}

/// The kernel's device events, as it sends them to the group every
/// listener of them joins.
#[derive(Debug)]
pub struct DeviceEvents(OwnedFd);

impl DeviceEvents {
    /// Starts taking device events; those sent before are not seen.
    pub fn open() -> io::Result<Self> {
        // SAFETY: no pointers; a returned descriptor is owned by the caller.
        let fd = unsafe {
            libc::socket(
                libc::AF_NETLINK,
                libc::SOCK_DGRAM | libc::SOCK_CLOEXEC,
                libc::NETLINK_KOBJECT_UEVENT,
            )
        };
        check(fd)?;
        // SAFETY: `fd` was just returned by socket(2) and nothing else owns it.
        let socket: OwnedFd = unsafe { std::os::fd::FromRawFd::from_raw_fd(fd) };
        // SAFETY: sockaddr_nl is plain data, valid when zeroed.
        let mut address: libc::sockaddr_nl = unsafe { std::mem::zeroed() };
        address.nl_family = libc::sa_family_t::try_from(libc::AF_NETLINK).unwrap_or_default();
        address.nl_groups = 1;
        let length =
            libc::socklen_t::try_from(std::mem::size_of::<libc::sockaddr_nl>()).unwrap_or_default();
        // SAFETY: an open descriptor and an address of `length` bytes that
        // outlives the call.
        check(unsafe { libc::bind(socket.as_raw_fd(), (&raw const address).cast(), length) })?;
        Ok(Self(socket))
    }

    /// Waits for the next event and returns it, cut to `buffer`'s length.
    pub fn next<'a>(&self, buffer: &'a mut [u8]) -> io::Result<&'a [u8]> {
        // SAFETY: an open descriptor and a buffer of `len` bytes that
        // outlives the call, which the kernel writes at most `len` of.
        let read = unsafe {
            libc::recv(
                self.0.as_raw_fd(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                0,
            )
        };
        let read = usize::try_from(read).map_err(|_| io::Error::last_os_error())?;
        Ok(&buffer[..read.min(buffer.len())])
    }
}

/// Makes ctrl-alt-del send SIGINT to this process instead of rebooting
/// at once, so the host's request to shut down gets a clean shutdown.
pub fn ctrl_alt_del_signals() -> io::Result<()> {
    // SAFETY: no pointers.
    check(unsafe { libc::reboot(libc::RB_DISABLE_CAD) })
}

/// Ends the VM. Firecracker ends on a guest reboot (`reboot=k`), which
/// works on every machine, unlike a power-off.
pub fn restart_machine() -> io::Error {
    // SAFETY: no pointers. Returns only on failure.
    unsafe { libc::reboot(libc::RB_AUTOBOOT) };
    io::Error::last_os_error()
}

/// `sethostname(2)`.
pub fn set_host_name(name: &str) -> io::Result<()> {
    // SAFETY: the pointer and length describe `name`'s bytes.
    check(unsafe { libc::sethostname(name.as_ptr().cast(), name.len()) })
}

/// Sets the wall clock to `nanos` since the Unix epoch.
pub fn set_clock(nanos: u64) -> io::Result<()> {
    let time = libc::timespec {
        tv_sec: (nanos / 1_000_000_000)
            .try_into()
            .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?,
        tv_nsec: libc::c_long::try_from(nanos % 1_000_000_000).unwrap_or(0),
    };
    // SAFETY: a valid timespec that outlives the call.
    check(unsafe { libc::clock_settime(libc::CLOCK_REALTIME, &raw const time) })
}

/// `RNDRESEEDCRNG`: reseed the kernel's generator from its input pool now.
const RNDRESEEDCRNG: libc::Ioctl = 0x5207;

/// Asks the kernel to reseed its random number generator at once, through
/// an open `/dev/urandom`.
pub fn reseed_random(urandom: &File) -> io::Result<()> {
    // SAFETY: an open descriptor; the request takes no argument.
    check(unsafe { libc::ioctl(urandom.as_raw_fd(), RNDRESEEDCRNG) })
}

/// `sync(2)`.
pub fn sync() {
    // SAFETY: no arguments.
    unsafe { libc::sync() };
}

/// `struct fstrim_range` of `linux/fs.h`.
#[repr(C)]
struct TrimRange {
    start: u64,
    len: u64,
    minlen: u64,
}

/// `FITRIM`: `_IOWR('X', 121, struct fstrim_range)`.
const FITRIM: libc::Ioctl = libc::_IOWR::<TrimRange>(0x58, 121);

/// Has the file system holding `path` discard its free space, in runs of
/// at least `min_len` bytes (`FITRIM`), and returns the bytes it
/// discarded. A device that takes no discards fails with `EOPNOTSUPP`.
pub fn trim(path: &str, min_len: u64) -> io::Result<u64> {
    let dir = File::open(path)?;
    let mut range = TrimRange {
        start: 0,
        len: u64::MAX,
        minlen: min_len,
    };
    // SAFETY: an open descriptor and a `fstrim_range` that outlives the
    // call, which the kernel reads and then updates in place.
    check(unsafe { libc::ioctl(dir.as_raw_fd(), FITRIM, &raw mut range) })?;
    Ok(range.len)
}

/// Whether any process but this one (and kernel threads) is left.
pub fn others_alive() -> bool {
    // SAFETY: no pointers; signal 0 only checks.
    unsafe { libc::kill(-1, 0) == 0 }
}

/// Makes `command`'s process take `uid`, `gid` and supplementary `groups`
/// just before it runs its program. The standard library sets the
/// supplementary groups only on nightly, and after changing the user it
/// could no longer set them.
pub fn run_as(command: &mut std::process::Command, uid: u32, gid: u32, groups: Vec<u32>) {
    // SAFETY: the closure only makes three system calls, each async-signal
    // safe, on data moved into it before the fork.
    unsafe {
        std::os::unix::process::CommandExt::pre_exec(command, move || {
            check(libc::setgroups(groups.len(), groups.as_ptr()))?;
            check(libc::setgid(gid))?;
            check(libc::setuid(uid))
        });
    }
}

/// Makes `command`'s process start with no signal blocked. A child
/// inherits its parent's mask, and this init blocks the signals it takes
/// itself; a program that never unblocks them could not handle `SIGTERM`.
pub fn unblock_signals(command: &mut std::process::Command) {
    // SAFETY: the closure makes two async-signal-safe calls on a set it
    // builds on its own stack.
    unsafe {
        std::os::unix::process::CommandExt::pre_exec(command, || {
            let mut set: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&raw mut set);
            check(libc::sigprocmask(
                libc::SIG_SETMASK,
                &raw const set,
                std::ptr::null_mut(),
            ))
        });
    }
}

/// Sends `signal` to the process `pid`.
pub fn kill(pid: i32, signal: libc::c_int) -> io::Result<()> {
    // SAFETY: no pointers.
    check(unsafe { libc::kill(pid, signal) })
}

/// Whether process `pid` exists.
pub fn alive(pid: i32) -> bool {
    // SAFETY: no pointers; signal 0 only checks.
    let found = unsafe { libc::kill(pid, 0) } == 0;
    found || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Sends `signal` to every process but this one (`kill(-1, …)`).
pub fn signal_all(signal: libc::c_int) {
    // SAFETY: no pointers.
    unsafe { libc::kill(-1, signal) };
}

/// A set of signals this process blocks and takes with [`Signals::wait`].
#[derive(Debug)]
pub struct Signals(libc::sigset_t);

impl Signals {
    /// Blocks `signals` in the calling thread and every thread it starts
    /// later. Children would inherit the mask too: they start through
    /// [`unblock_signals`].
    pub fn block(signals: &[libc::c_int]) -> io::Result<Self> {
        // SAFETY: sigset_t is plain data; sigemptyset initialises it.
        let mut set: libc::sigset_t = unsafe { std::mem::zeroed() };
        // SAFETY: `set` is a valid sigset_t for each call.
        unsafe {
            libc::sigemptyset(&raw mut set);
            for &signal in signals {
                libc::sigaddset(&raw mut set, signal);
            }
        }
        // SAFETY: a valid set; the old mask is not wanted.
        let error =
            unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &raw const set, std::ptr::null_mut()) };
        if error != 0 {
            return Err(io::Error::from_raw_os_error(error));
        }
        Ok(Self(set))
    }

    /// The next pending signal of the set, waiting at most `limit`.
    pub fn wait(&self, limit: Duration) -> Option<libc::c_int> {
        let limit = libc::timespec {
            tv_sec: limit.as_secs().try_into().unwrap_or(i32::MAX.into()),
            tv_nsec: limit.subsec_nanos().into(),
        };
        // SAFETY: a valid set and timeout; the signal's details are not wanted.
        let signal = unsafe {
            libc::sigtimedwait(&raw const self.0, std::ptr::null_mut(), &raw const limit)
        };
        (signal > 0).then_some(signal)
    }
}

/// How a child ended, from `waitpid(2)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    Code(i32),
    Signal(i32),
}

impl std::fmt::Display for Exit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Code(code) => write!(f, "exit code {code}"),
            Self::Signal(signal) => write!(f, "signal {signal}"),
        }
    }
}

/// Reaps one child that has ended, any child, without waiting.
pub fn reap() -> Option<(i32, Exit)> {
    let mut status = 0;
    // SAFETY: `status` outlives the call.
    let pid = unsafe { libc::waitpid(-1, &raw mut status, libc::WNOHANG) };
    if pid <= 0 {
        return None;
    }
    let exit = if libc::WIFSIGNALED(status) {
        Exit::Signal(libc::WTERMSIG(status))
    } else {
        Exit::Code(libc::WEXITSTATUS(status))
    };
    Some((pid, exit))
}

/// A socket for interface ioctls.
fn control_socket() -> io::Result<std::os::fd::OwnedFd> {
    // SAFETY: no pointers; a returned descriptor is owned by the caller.
    let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) };
    check(fd)?;
    // SAFETY: `fd` was just returned by socket(2) and nothing else owns it.
    Ok(unsafe { std::os::fd::FromRawFd::from_raw_fd(fd) })
}

/// An ioctl request number in the type this C library's `ioctl` takes.
#[allow(
    clippy::unnecessary_cast,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap
)]
fn ioctl_number(code: libc::c_ulong) -> libc::Ioctl {
    code as libc::Ioctl
}

fn interface_request(name: &str) -> io::Result<libc::ifreq> {
    if name.is_empty() || name.len() >= libc::IFNAMSIZ {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    // SAFETY: ifreq is plain data, valid when zeroed.
    let mut request: libc::ifreq = unsafe { std::mem::zeroed() };
    for (slot, byte) in request.ifr_name.iter_mut().zip(name.bytes()) {
        *slot = byte.cast_signed();
    }
    Ok(request)
}

fn socket_address(address: Ipv4Addr) -> libc::sockaddr {
    let inet = libc::sockaddr_in {
        sin_family: libc::sa_family_t::try_from(libc::AF_INET).unwrap_or_default(),
        sin_port: 0,
        sin_addr: libc::in_addr {
            s_addr: u32::from(address).to_be(),
        },
        sin_zero: [0; 8],
    };
    // SAFETY: sockaddr_in and sockaddr have the same size; the kernel reads
    // the family to know which it is.
    unsafe { std::mem::transmute::<libc::sockaddr_in, libc::sockaddr>(inet) }
}

/// Brings interface `name` up.
pub fn interface_up(name: &str) -> io::Result<()> {
    let socket = control_socket()?;
    let mut request = interface_request(name)?;
    // SAFETY: a valid ifreq for the duration of each call.
    unsafe {
        check(libc::ioctl(
            socket.as_raw_fd(),
            ioctl_number(libc::SIOCGIFFLAGS),
            &raw mut request,
        ))?;
        request.ifr_ifru.ifru_flags |= libc::c_short::try_from(libc::IFF_UP).unwrap_or_default();
        check(libc::ioctl(
            socket.as_raw_fd(),
            ioctl_number(libc::SIOCSIFFLAGS),
            &raw mut request,
        ))
    }
}

/// The IPv4 address of interface `name`, if it has one.
pub fn interface_address(name: &str) -> io::Result<Option<Ipv4Addr>> {
    let socket = control_socket()?;
    let mut request = interface_request(name)?;
    // SAFETY: a valid ifreq for the duration of the call.
    match check(unsafe {
        libc::ioctl(
            socket.as_raw_fd(),
            ioctl_number(libc::SIOCGIFADDR),
            &raw mut request,
        )
    }) {
        Ok(()) => {}
        Err(error) if error.raw_os_error() == Some(libc::EADDRNOTAVAIL) => return Ok(None),
        Err(error) => return Err(error),
    }
    // SAFETY: SIOCGIFADDR filled in an AF_INET address.
    let inet: libc::sockaddr_in = unsafe { std::mem::transmute(request.ifr_ifru.ifru_addr) };
    Ok(Some(Ipv4Addr::from(u32::from_be(inet.sin_addr.s_addr))))
}

/// Gives interface `name` `address` with `netmask`.
pub fn set_interface_address(name: &str, address: Ipv4Addr, netmask: Ipv4Addr) -> io::Result<()> {
    let socket = control_socket()?;
    let mut request = interface_request(name)?;
    request.ifr_ifru.ifru_addr = socket_address(address);
    // SAFETY: a valid ifreq for the duration of each call.
    unsafe {
        check(libc::ioctl(
            socket.as_raw_fd(),
            ioctl_number(libc::SIOCSIFADDR),
            &raw mut request,
        ))?;
        request.ifr_ifru.ifru_netmask = socket_address(netmask);
        check(libc::ioctl(
            socket.as_raw_fd(),
            ioctl_number(libc::SIOCSIFNETMASK),
            &raw mut request,
        ))
    }
}

/// Adds a default route through `gateway`; one already there is fine.
pub fn add_default_route(gateway: Ipv4Addr) -> io::Result<()> {
    let socket = control_socket()?;
    // SAFETY: rtentry is plain data, valid when zeroed.
    let mut route: libc::rtentry = unsafe { std::mem::zeroed() };
    route.rt_dst = socket_address(Ipv4Addr::UNSPECIFIED);
    route.rt_genmask = socket_address(Ipv4Addr::UNSPECIFIED);
    route.rt_gateway = socket_address(gateway);
    route.rt_flags = libc::c_ushort::try_from(libc::RTF_UP | libc::RTF_GATEWAY).unwrap_or_default();
    // SAFETY: a valid rtentry for the duration of the call.
    match check(unsafe {
        libc::ioctl(
            socket.as_raw_fd(),
            ioctl_number(libc::SIOCADDRT),
            &raw mut route,
        )
    }) {
        Err(error) if error.raw_os_error() == Some(libc::EEXIST) => Ok(()),
        result => result,
    }
}

#[cfg(test)]
mod tests {
    use super::{EXT4_IOC_RESIZE_FS, FITRIM, ioctl_number};

    /// The number `linux/fs.h` gives `FITRIM` on every architecture the
    /// guest is built for.
    #[test]
    fn trim_is_the_kernels_fitrim() {
        assert_eq!(FITRIM, ioctl_number(0xC018_5879));
    }

    /// The number `linux/ext4.h` gives `EXT4_IOC_RESIZE_FS` on every
    /// architecture the guest is built for.
    #[test]
    fn resize_is_ext4s_online_resize() {
        assert_eq!(EXT4_IOC_RESIZE_FS, ioctl_number(0x4008_6610));
    }
}
