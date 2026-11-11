//! Blocking vsock sockets: the host agent's only way in.

use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::time::Duration;

/// Any context id: listen for the host.
const ANY: u32 = u32::MAX;

/// The host's context id.
const HOST: u32 = 2;

fn check(result: libc::c_int) -> io::Result<libc::c_int> {
    if result == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result)
    }
}

/// A listening vsock socket.
#[derive(Debug)]
pub struct Listener(OwnedFd);

impl Listener {
    /// Listens on `port` for connections from the host.
    pub fn bind(port: u32) -> io::Result<Self> {
        // SAFETY: no pointers.
        let fd = check(unsafe {
            libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0)
        })?;
        // SAFETY: `fd` was just returned by socket(2) and nothing else owns it.
        let socket = unsafe { OwnedFd::from_raw_fd(fd) };
        // SAFETY: sockaddr_vm is plain data, valid when zeroed.
        let mut address: libc::sockaddr_vm = unsafe { std::mem::zeroed() };
        address.svm_family = libc::sa_family_t::try_from(libc::AF_VSOCK).unwrap_or_default();
        address.svm_port = port;
        address.svm_cid = ANY;
        let length = libc::socklen_t::try_from(size_of::<libc::sockaddr_vm>()).unwrap_or_default();
        // SAFETY: the address and its length describe a valid sockaddr_vm.
        check(unsafe { libc::bind(socket.as_raw_fd(), (&raw const address).cast(), length) })?;
        // SAFETY: no pointers.
        check(unsafe { libc::listen(socket.as_raw_fd(), 128) })?;
        Ok(Self(socket))
    }

    /// Waits for the next connection.
    pub fn accept(&self) -> io::Result<Stream> {
        loop {
            // SAFETY: null address arguments are allowed; the peer is not wanted.
            let fd = unsafe {
                libc::accept4(
                    self.0.as_raw_fd(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    libc::SOCK_CLOEXEC,
                )
            };
            match check(fd) {
                // SAFETY: `fd` was just returned by accept4(2) and nothing else owns it.
                Ok(fd) => return Ok(Stream(unsafe { OwnedFd::from_raw_fd(fd) })),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
    }
}

/// A connected vsock stream.
#[derive(Debug)]
pub struct Stream(OwnedFd);

impl Stream {
    /// Connects to the host's vsock `port`.
    pub fn connect_host(port: u32) -> io::Result<Self> {
        // SAFETY: no pointers.
        let fd = check(unsafe {
            libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0)
        })?;
        // SAFETY: `fd` was just returned by socket(2) and nothing else owns it.
        let socket = unsafe { OwnedFd::from_raw_fd(fd) };
        // SAFETY: sockaddr_vm is plain data, valid when zeroed.
        let mut address: libc::sockaddr_vm = unsafe { std::mem::zeroed() };
        address.svm_family = libc::sa_family_t::try_from(libc::AF_VSOCK).unwrap_or_default();
        address.svm_port = port;
        address.svm_cid = HOST;
        let length = libc::socklen_t::try_from(size_of::<libc::sockaddr_vm>()).unwrap_or_default();
        // Every thread blocks the signals PID 1 takes, so no handler can
        // interrupt the connect.
        // SAFETY: the address and its length describe a valid sockaddr_vm.
        check(unsafe { libc::connect(socket.as_raw_fd(), (&raw const address).cast(), length) })?;
        Ok(Self(socket))
    }

    /// Another handle on the same connection, for the other direction.
    pub fn try_clone(&self) -> io::Result<Self> {
        Ok(Self(self.0.try_clone()?))
    }

    /// `shutdown(2)`.
    pub fn shutdown(&self, how: Shutdown) -> io::Result<()> {
        let how = match how {
            Shutdown::Read => libc::SHUT_RD,
            Shutdown::Write => libc::SHUT_WR,
            Shutdown::Both => libc::SHUT_RDWR,
        };
        // SAFETY: no pointers.
        check(unsafe { libc::shutdown(self.0.as_raw_fd(), how) }).map(drop)
    }

    /// How long a read may wait; `None` for ever.
    pub fn set_read_timeout(&self, limit: Option<Duration>) -> io::Result<()> {
        let limit = limit.unwrap_or_default();
        let value = libc::timeval {
            tv_sec: limit.as_secs().try_into().unwrap_or(i32::MAX.into()),
            tv_usec: limit.subsec_micros().into(),
        };
        let length = libc::socklen_t::try_from(size_of::<libc::timeval>()).unwrap_or_default();
        // SAFETY: the value and its length describe a valid timeval.
        check(unsafe {
            libc::setsockopt(
                self.0.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_RCVTIMEO,
                (&raw const value).cast(),
                length,
            )
        })
        .map(drop)
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            // SAFETY: the pointer and length describe `buf`.
            let n = unsafe { libc::read(self.0.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
            if n >= 0 {
                return Ok(n.cast_unsigned());
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        loop {
            // SAFETY: the pointer and length describe `buf`.
            let n = unsafe {
                libc::send(
                    self.0.as_raw_fd(),
                    buf.as_ptr().cast(),
                    buf.len(),
                    libc::MSG_NOSIGNAL,
                )
            };
            if n >= 0 {
                return Ok(n.cast_unsigned());
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl crate::relay::Duplex for Stream {
    fn try_clone(&self) -> io::Result<Self> {
        Stream::try_clone(self)
    }

    fn shutdown(&self, how: Shutdown) -> io::Result<()> {
        Stream::shutdown(self, how)
    }

    fn set_read_timeout(&self, limit: Option<Duration>) -> io::Result<()> {
        Stream::set_read_timeout(self, limit)
    }
}
