//! The proof an exiting pager waits for: an answer from the VMM's API.
//!
//! Firecracker issues every discard of guest memory (the balloon's
//! inflation and free page reporting) from its VMM thread, the same single
//! thread that handles API requests. A discard that looked at the guest's
//! registration before the pager unregistered it holds that thread until
//! its event is read. So once the pager has unregistered, an answer to an
//! API request proves the thread got past every such discard, whose
//! events the pager has therefore read, and that any later discard finds
//! nothing registered. `GET /` is a request the VMM thread itself answers
//! (malformed requests are answered by the API thread alone and prove
//! nothing).

use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use nix::fcntl::{OFlag, open};
use nix::sys::stat::{Mode, SFlag, fstat};

use super::Quiesce;

/// The request whose answer is the proof.
const REQUEST: &[u8] = b"GET / HTTP/1.1\r\nHost: localhost\r\nAccept: application/json\r\n\r\n";

/// Asks the VMM listening on an API socket.
#[derive(Debug)]
pub struct AskVmm {
    socket: PathBuf,
    asking: Option<UnixStream>,
    reply: Vec<u8>,
}

impl AskVmm {
    /// Asks the VMM whose API listens at `socket`.
    #[must_use]
    pub fn new(socket: PathBuf) -> Self {
        Self {
            socket,
            asking: None,
            reply: Vec::new(),
        }
    }
}

impl Quiesce for AskVmm {
    fn ask(&mut self) -> io::Result<RawFd> {
        self.asking = None;
        self.reply.clear();
        let mut stream = connect(&self.socket)?;
        stream.set_write_timeout(Some(Duration::from_secs(1)))?;
        stream.write_all(REQUEST)?;
        stream.set_nonblocking(true)?;
        let fd = stream.as_raw_fd();
        self.asking = Some(stream);
        Ok(fd)
    }

    fn answered(&mut self) -> io::Result<bool> {
        let stream = self
            .asking
            .as_mut()
            .ok_or_else(|| io::Error::other("nothing asked"))?;
        let mut buffer = [0_u8; 4096];
        let mut ended = false;
        loop {
            match stream.read(&mut buffer) {
                Ok(0) => {
                    ended = true;
                    break;
                }
                Ok(count) => self.reply.extend_from_slice(&buffer[..count]),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
        let Some(end) = self.reply.windows(2).position(|pair| pair == b"\r\n") else {
            if ended {
                self.asking = None;
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "the VMM hung up without answering",
                ));
            }
            return Ok(false);
        };
        let status = String::from_utf8_lossy(&self.reply[..end]).into_owned();
        self.asking = None;
        match status.split_whitespace().nth(1) {
            Some(code) if code.starts_with('2') => Ok(true),
            _ => Err(io::Error::other(format!("the VMM answered {status:?}"))),
        }
    }
}

/// Connects to the socket at `path` without following a link: the jail
/// the socket lives in belongs to the VMM, and the pager is not to be sent
/// anywhere else.
fn connect(path: &Path) -> io::Result<UnixStream> {
    let fd = open(
        path,
        OFlag::O_PATH | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    )?;
    let kind = SFlag::from_bits_truncate(fstat(&fd)?.st_mode) & SFlag::S_IFMT;
    if kind != SFlag::S_IFSOCK {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is not a socket", path.display()),
        ));
    }
    // The descriptor stays open until the connection is made.
    UnixStream::connect(format!("/proc/self/fd/{}", fd.as_raw_fd()))
}

#[cfg(test)]
mod tests {
    use std::os::unix::net::UnixListener;
    use std::thread;

    use super::*;

    /// Answers one request on `listener` with `status`.
    fn answer_once(listener: UnixListener, status: &'static str) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 256];
            while !request.ends_with(b"\r\n\r\n") {
                let count = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..count]);
            }
            assert!(request.starts_with(b"GET / "));
            let reply = format!("HTTP/1.1 {status}\r\nContent-Length: 2\r\n\r\n{{}}");
            stream.write_all(reply.as_bytes()).unwrap();
        })
    }

    fn wait_answered(ask: &mut AskVmm, fd: RawFd) -> io::Result<bool> {
        for _ in 0..500 {
            super::super::poll(&[fd], Duration::from_millis(10))?;
            if ask.answered()? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    #[test]
    fn only_a_successful_answer_is_proof() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("api.sock");
        let mut ask = AskVmm::new(socket.clone());
        assert!(ask.ask().is_err(), "nothing listens yet");

        let answering = answer_once(UnixListener::bind(&socket).unwrap(), "200 OK");
        let fd = ask.ask().unwrap();
        assert!(wait_answered(&mut ask, fd).unwrap());
        answering.join().unwrap();

        std::fs::remove_file(&socket).unwrap();
        let refusing = answer_once(UnixListener::bind(&socket).unwrap(), "400 Bad Request");
        let fd = ask.ask().unwrap();
        assert!(wait_answered(&mut ask, fd).is_err());
        refusing.join().unwrap();
    }

    #[test]
    fn links_are_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.sock");
        let _listener = UnixListener::bind(&real).unwrap();
        let link = dir.path().join("api.sock");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(AskVmm::new(link).ask().is_err());
        assert!(AskVmm::new(real).ask().is_ok());
    }
}
