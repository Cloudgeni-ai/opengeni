//! Relaying a connection inside the guest to a vsock stream to the host,
//! both ways: the agent's connections to its link, and the host's to the
//! guest's TCP ports through the gateway.
//!
//! The VMM's vsock device carries no half-close from the guest: a guest's
//! `shutdown(SHUT_WR)` reaches the host as nothing at all, so the host's
//! end of the stream stays open, and reads nothing more, until the guest
//! ends the stream in both directions. So once the guest's side has sent
//! all it will send, the relay ends the whole connection, both streams both
//! ways, which the host sees at once. A host that ends its sending is passed
//! on as a half-close, and what the guest's side still answers reaches it.
//!
//! The one exchange this cannot carry is a guest service that half-closes
//! and then goes on reading what the host still sends: what the host sends
//! after the guest's side ended is not delivered. Keeping that direction
//! open instead would leave the host waiting, with no end, for every
//! answer that ends when its service closes (a close-delimited HTTP body,
//! a service that answers and hangs up), and holding every connection the
//! guest's side closed until the host closes it too.

use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};

/// A connection the relay can copy in one direction while it copies the
/// other on another handle, and end in either direction.
pub trait Duplex: Read + Write + Send + Sized + 'static {
    /// Another handle on the same connection.
    ///
    /// # Errors
    ///
    /// As `dup(2)`.
    fn try_clone(&self) -> io::Result<Self>;

    /// `shutdown(2)`.
    ///
    /// # Errors
    ///
    /// As `shutdown(2)`.
    fn shutdown(&self, how: Shutdown) -> io::Result<()>;
}

impl Duplex for TcpStream {
    fn try_clone(&self) -> io::Result<Self> {
        TcpStream::try_clone(self)
    }

    fn shutdown(&self, how: Shutdown) -> io::Result<()> {
        TcpStream::shutdown(self, how)
    }
}

/// Relays `guest`, a connection inside the guest, and `host`, a stream to
/// the host, until both directions are done (see the module
/// documentation). Returns `false`, having relayed nothing, if it could not
/// start.
pub fn relay<G: Duplex, H: Duplex>(mut guest: G, mut host: H) -> bool {
    let (Ok(mut from_host), Ok(mut to_guest)) = (host.try_clone(), guest.try_clone()) else {
        return false;
    };
    let inbound = std::thread::Builder::new()
        .name("relay".to_owned())
        .stack_size(128 * 1024)
        .spawn(move || {
            let _ = io::copy(&mut from_host, &mut to_guest);
            let _ = to_guest.shutdown(Shutdown::Write);
        });
    let Ok(inbound) = inbound else {
        return false;
    };
    let _ = io::copy(&mut guest, &mut host);
    // Ending the host's stream for reading too ends the copy above.
    let _ = host.shutdown(Shutdown::Both);
    let _ = guest.shutdown(Shutdown::Both);
    let _ = inbound.join();
    true
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;

    /// Both ends of a loopback TCP connection.
    fn pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let near = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (far, _) = listener.accept().unwrap();
        (near, far)
    }

    /// Relays a guest and a host connection on a thread; the far ends of
    /// both, and what tells when the relay is done.
    fn relaying() -> (TcpStream, TcpStream, mpsc::Receiver<bool>) {
        let (guest, guest_far) = pair();
        let (host, host_far) = pair();
        let (done, finished) = mpsc::channel();
        std::thread::spawn(move || done.send(relay(guest, host)).unwrap());
        (guest_far, host_far, finished)
    }

    #[test]
    fn a_guest_side_that_ends_ends_the_hosts_stream_though_the_host_says_nothing() {
        let (mut agent, mut host, finished) = relaying();
        agent.write_all(b"PING\r\n").unwrap();
        drop(agent);
        // The host neither sends nor ends anything; the relay does not wait
        // for it, as it would for a host that never learns of a half-close.
        assert_eq!(finished.recv_timeout(Duration::from_secs(5)), Ok(true));
        let mut got = Vec::new();
        host.read_to_end(&mut got).unwrap();
        assert_eq!(got, b"PING\r\n");
    }

    #[test]
    fn a_service_that_half_closes_ends_the_connection() {
        let (mut service, mut host, finished) = relaying();
        service.write_all(b"HTTP/1.0 200 OK\r\n\r\nbody").unwrap();
        service.shutdown(Shutdown::Write).unwrap();
        // The host sees the end of a close-delimited answer at once; what
        // it sends after that is not delivered (see the module docs).
        let mut answer = Vec::new();
        host.read_to_end(&mut answer).unwrap();
        assert_eq!(answer, b"HTTP/1.0 200 OK\r\n\r\nbody");
        assert_eq!(finished.recv_timeout(Duration::from_secs(5)), Ok(true));
        let _ = host.write_all(b"later");
        let mut late = Vec::new();
        service.read_to_end(&mut late).unwrap();
        assert_eq!(late, b"");
    }

    #[test]
    fn a_host_that_ends_its_sending_still_gets_the_answer() {
        let (mut app, mut host, finished) = relaying();
        host.write_all(b"GET / HTTP/1.0\r\n\r\n").unwrap();
        host.shutdown(Shutdown::Write).unwrap();
        let mut request = Vec::new();
        app.read_to_end(&mut request).unwrap();
        assert_eq!(request, b"GET / HTTP/1.0\r\n\r\n");
        app.write_all(b"HTTP/1.0 200 OK\r\n\r\nhello").unwrap();
        drop(app);
        let mut answer = Vec::new();
        host.read_to_end(&mut answer).unwrap();
        assert_eq!(answer, b"HTTP/1.0 200 OK\r\n\r\nhello");
        assert_eq!(finished.recv_timeout(Duration::from_secs(5)), Ok(true));
    }

    #[test]
    fn every_byte_crosses_both_ways_at_once() {
        let (mut guest, mut host, finished) = relaying();
        let size = 8 << 20;
        let sent: Vec<u8> = (0..size).map(|i| u8::try_from(i % 251).unwrap()).collect();
        let to_host = sent.clone();
        let mut host_writer = host.try_clone().unwrap();
        let writer = std::thread::spawn(move || host_writer.write_all(&to_host).unwrap());
        let mut guest_writer = guest.try_clone().unwrap();
        let to_guest = sent.clone();
        let guest_sends = std::thread::spawn(move || {
            guest_writer.write_all(&to_guest).unwrap();
        });
        let mut at_guest = vec![0; size];
        guest.read_exact(&mut at_guest).unwrap();
        let mut at_host = vec![0; size];
        host.read_exact(&mut at_host).unwrap();
        writer.join().unwrap();
        guest_sends.join().unwrap();
        assert!(at_guest == sent && at_host == sent);
        drop(guest);
        assert_eq!(finished.recv_timeout(Duration::from_secs(5)), Ok(true));
    }
}
