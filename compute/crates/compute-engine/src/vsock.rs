//! Reaching agents inside a VM through the host side of its vsock device.

use std::io;
use std::path::Path;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

/// Connects to `port` inside the guest through the VMM's host-side socket.
///
/// Firecracker and Cloud Hypervisor both expose guest vsock ports through
/// one Unix socket and a one-line `CONNECT <port>` handshake. The returned
/// stream carries the guest connection with the handshake consumed.
pub async fn connect(uds: &Path, port: u32) -> io::Result<UnixStream> {
    answered(request(uds, port).await?).await
}

/// The host's half of [`connect`]: reaches the VMM's host-side socket and
/// asks it for a connection to `port` inside the guest. An error here says
/// nothing about the guest: the host could not ask.
pub async fn request(uds: &Path, port: u32) -> io::Result<UnixStream> {
    let mut stream = crate::confined::connect(uds).await?;
    stream
        .write_all(format!("CONNECT {port}\n").as_bytes())
        .await?;
    Ok(stream)
}

/// The guest's half of [`connect`]: waits for the VMM's answer to a
/// [`request`], which says whether the guest took the connection. The VMM
/// closes the stream, or refuses, if the guest refused it or left it
/// unanswered.
pub async fn answered(mut stream: UnixStream) -> io::Result<UnixStream> {
    // Read the reply one byte at a time so no guest data is consumed with it.
    let mut reply = Vec::with_capacity(16);
    loop {
        let byte = stream.read_u8().await?;
        if byte == b'\n' {
            break;
        }
        reply.push(byte);
        if reply.len() > 64 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "vsock handshake reply too long",
            ));
        }
    }
    if reply.starts_with(b"OK ") {
        Ok(stream)
    } else {
        Err(io::Error::new(
            io::ErrorKind::ConnectionRefused,
            format!(
                "vsock handshake refused: {}",
                String::from_utf8_lossy(&reply)
            ),
        ))
    }
}
