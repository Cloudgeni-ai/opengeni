//! One guest connection: a task parses what the agent sends and hands it
//! to the hub, and another writes what the hub sends back.

use bytes::BytesMut;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::core::{ConnId, Input};
use crate::hub::Command;
use crate::nats::{ServerOp, parse};

/// The largest payload parsed at all. The gateway's own limit, which the
/// core enforces, is lower; this only bounds what one operation buffers.
const PARSE_LIMIT: usize = 64 << 20;

/// What the hub sends a connection.
#[derive(Debug)]
pub(crate) enum Out {
    Op(ServerOp),
    /// End the connection after what was sent before.
    Close,
}

pub(crate) fn serve<S>(
    hub: &mpsc::UnboundedSender<Command>,
    conn: ConnId,
    sandbox: String,
    stream: S,
) where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (reader, writer) = tokio::io::split(stream);
    let (out, outgoing) = mpsc::unbounded_channel();
    let done = CancellationToken::new();
    if hub
        .send(Command::Conn {
            conn,
            sandbox,
            writer: out.clone(),
        })
        .is_err()
    {
        return;
    }
    tokio::spawn(write(writer, outgoing, done.clone()));
    tokio::spawn(read(reader, hub.clone(), out, conn, done));
}

async fn read<R: AsyncRead>(
    reader: R,
    hub: mpsc::UnboundedSender<Command>,
    out: mpsc::UnboundedSender<Out>,
    conn: ConnId,
    done: CancellationToken,
) {
    tokio::pin!(reader);
    let mut buffer = BytesMut::with_capacity(4096);
    'reading: loop {
        loop {
            match parse(&mut buffer, PARSE_LIMIT) {
                Ok(Some(op)) => {
                    if hub.send(Command::Input(Input::Guest { conn, op })).is_err() {
                        break 'reading;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    tracing::debug!(conn, %error, "a guest broke the protocol");
                    let _ = out.send(Out::Op(ServerOp::Err(error.server_text().to_owned())));
                    let _ = out.send(Out::Close);
                    break 'reading;
                }
            }
        }
        tokio::select! {
            () = done.cancelled() => break,
            read = reader.read_buf(&mut buffer) => match read {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            },
        }
    }
    let _ = hub.send(Command::Input(Input::GuestClosed { conn }));
}

async fn write<W: AsyncWrite>(
    writer: W,
    mut outgoing: mpsc::UnboundedReceiver<Out>,
    done: CancellationToken,
) {
    tokio::pin!(writer);
    let mut bytes = BytesMut::with_capacity(4096);
    'writing: while let Some(first) = outgoing.recv().await {
        let mut next = Some(first);
        let mut close = false;
        // Everything already waiting goes in one write.
        while let Some(out) = next {
            match out {
                Out::Op(op) => op.write(&mut bytes),
                Out::Close => {
                    close = true;
                    break;
                }
            }
            next = outgoing.try_recv().ok();
        }
        if !bytes.is_empty() {
            if writer.write_all(&bytes).await.is_err() {
                break 'writing;
            }
            bytes.clear();
        }
        if close {
            break;
        }
    }
    let _ = writer.shutdown().await;
    done.cancel();
}
