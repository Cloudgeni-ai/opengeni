//! A client for the host agent's local API.

use std::io;
use std::path::PathBuf;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

use crate::protocol::{Id, PriorityName, Reply, Request};

/// Connects to a host agent's socket.
#[derive(Clone, Debug)]
pub struct Client {
    socket: PathBuf,
}

impl Client {
    /// A client for the agent listening on `socket`.
    #[must_use]
    pub fn new(socket: impl Into<PathBuf>) -> Self {
        Self {
            socket: socket.into(),
        }
    }

    async fn send(&self, request: &Request) -> io::Result<(Reply, BufReader<UnixStream>)> {
        let mut stream = UnixStream::connect(&self.socket).await?;
        let mut line = serde_json::to_vec(request).map_err(io::Error::other)?;
        line.push(b'\n');
        stream.write_all(&line).await?;
        let mut stream = BufReader::new(stream);
        let mut reply = String::new();
        if stream.read_line(&mut reply).await? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "the host agent closed the connection without replying",
            ));
        }
        let reply = serde_json::from_str(&reply).map_err(io::Error::other)?;
        Ok((reply, stream))
    }

    /// Sends one request and returns its reply.
    pub async fn call(&self, request: &Request) -> io::Result<Reply> {
        Ok(self.send(request).await?.0)
    }

    /// Opens a byte stream to `port` inside sandbox `id`, waking it first.
    /// On success the reply is [`Reply::Connected`] and the stream carries
    /// the guest connection; read from the returned reader, which may
    /// already hold the guest's first bytes.
    pub async fn connect(
        &self,
        id: Id,
        port: u32,
        priority: PriorityName,
    ) -> io::Result<(Reply, BufReader<UnixStream>)> {
        self.send(&Request::Connect {
            id,
            generation: None,
            port,
            priority,
        })
        .await
    }
}
