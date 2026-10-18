//! One guest connection: a task parses what the agent sends and hands it
//! to the hub, and another writes what the hub sends back.
//!
//! Both directions are bounded, as a guest is not trusted:
//!
//! - What the reader hands the hub holds [`CREDIT`] from the connection
//!   until the hub handled it, or, for the frame it led to, until that
//!   frame is written to the gateway. A connection out of credit is not
//!   read, so a guest that sends faster than its gateway takes is slowed
//!   down by its own socket.
//! - The reader parses a payload only up to the maximum its `INFO` gave.
//! - What waits to be written to the guest is bounded by [`BACKLOG`]: a
//!   guest that does not read its socket ends as a slow consumer, as a
//!   NATS server ends one.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use bytes::BytesMut;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

use crate::core::{ConnId, Input};
use crate::hub::Command;
use crate::nats::{ServerOp, parse};

/// What a connection may have in flight to the hub and its gateway, by
/// [`crate::nats::ClientOp::cost`]. One operation larger than this takes
/// all of it.
pub(crate) const CREDIT: usize = 4 << 20;
/// What may wait to be written to a connection, by [`ServerOp::cost`],
/// before it ends as a slow consumer: a NATS server's default.
pub(crate) const BACKLOG: usize = 64 << 20;

/// What the hub sends a connection.
#[derive(Debug)]
enum Out {
    /// An operation, and what it was counted in the backlog.
    Op { op: ServerOp, cost: usize },
    /// End the connection after what was sent before.
    Close,
}

/// The hub's end of a connection.
#[derive(Debug)]
pub(crate) struct Handle {
    out: mpsc::UnboundedSender<Out>,
    /// The cost of what was sent and not yet written.
    backlog: Arc<AtomicUsize>,
    /// The largest payload the reader parses.
    max_payload: Arc<AtomicUsize>,
    /// Ends the connection at once.
    done: CancellationToken,
}

/// The connection fell [`BACKLOG`] behind and was ended.
#[derive(Debug)]
pub(crate) struct SlowConsumer;

impl Handle {
    /// Sends `op`, or ends the connection when what it was sent before
    /// still waits past [`BACKLOG`].
    pub(crate) fn send(&self, op: ServerOp) -> Result<(), SlowConsumer> {
        if let ServerOp::Info(info) = &op {
            let max_payload = usize::try_from(info.max_payload).unwrap_or(usize::MAX);
            self.max_payload.store(max_payload, Ordering::Release);
        }
        let cost = op.cost();
        if self.backlog.fetch_add(cost, Ordering::Relaxed) + cost > BACKLOG {
            self.done.cancel();
            return Err(SlowConsumer);
        }
        let _ = self.out.send(Out::Op { op, cost });
        Ok(())
    }
}

impl Drop for Handle {
    /// A connection the hub forgot ends, after what it was sent before.
    fn drop(&mut self) {
        let _ = self.out.send(Out::Close);
    }
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
    let backlog = Arc::new(AtomicUsize::new(0));
    // Nothing but `CONNECT`, which carries no payload, comes before `INFO`.
    let max_payload = Arc::new(AtomicUsize::new(0));
    let handle = Handle {
        out: out.clone(),
        backlog: Arc::clone(&backlog),
        max_payload: Arc::clone(&max_payload),
        done: done.clone(),
    };
    if hub
        .send(Command::Conn {
            conn,
            sandbox,
            guest: handle,
        })
        .is_err()
    {
        return;
    }
    tokio::spawn(write(writer, outgoing, backlog, done.clone()));
    tokio::spawn(read(reader, hub.clone(), out, max_payload, conn, done));
}

async fn read<R: AsyncRead>(
    reader: R,
    hub: mpsc::UnboundedSender<Command>,
    out: mpsc::UnboundedSender<Out>,
    max_payload: Arc<AtomicUsize>,
    conn: ConnId,
    done: CancellationToken,
) {
    tokio::pin!(reader);
    let credit = Arc::new(Semaphore::new(CREDIT));
    let mut buffer = BytesMut::with_capacity(4096);
    'reading: loop {
        loop {
            match parse(&mut buffer, max_payload.load(Ordering::Acquire)) {
                Ok(Some(op)) => {
                    let cost = u32::try_from(op.cost().min(CREDIT)).unwrap_or(u32::MAX);
                    let credit = tokio::select! {
                        () = done.cancelled() => break 'reading,
                        permit = Arc::clone(&credit).acquire_many_owned(cost) => {
                            permit.expect("the semaphore is never closed")
                        }
                    };
                    let input = Input::Guest { conn, op };
                    if hub.send(Command::Credited { input, credit }).is_err() {
                        break 'reading;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    tracing::debug!(conn, %error, "a guest broke the protocol");
                    let op = ServerOp::Err(error.server_text().to_owned());
                    let _ = out.send(Out::Op { op, cost: 0 });
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
    backlog: Arc<AtomicUsize>,
    done: CancellationToken,
) {
    tokio::pin!(writer);
    let mut bytes = BytesMut::with_capacity(4096);
    'writing: loop {
        let first = tokio::select! {
            () = done.cancelled() => break 'writing,
            out = outgoing.recv() => match out {
                Some(out) => out,
                None => break 'writing,
            },
        };
        let mut next = Some(first);
        let mut close = false;
        let mut cost = 0;
        // Everything already waiting goes in one write.
        while let Some(out) = next {
            match out {
                Out::Op { op, cost: counted } => {
                    cost += counted;
                    op.write(&mut bytes);
                }
                Out::Close => {
                    close = true;
                    break;
                }
            }
            next = outgoing.try_recv().ok();
        }
        if !bytes.is_empty() {
            tokio::select! {
                () = done.cancelled() => break 'writing,
                written = writer.write_all(&bytes) => if written.is_err() {
                    break 'writing;
                },
            }
            bytes.clear();
        }
        backlog.fetch_sub(cost, Ordering::Relaxed);
        if close {
            break;
        }
    }
    let _ = writer.shutdown().await;
    done.cancel();
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use bytes::Bytes;

    use super::*;
    use crate::nats::{ClientOp, Delivery, Info};

    /// Serves one end of a pipe, returning the hub's handle, the hub's
    /// commands and the guest's end.
    async fn served() -> (
        Handle,
        mpsc::UnboundedReceiver<Command>,
        tokio::io::DuplexStream,
    ) {
        let (hub, mut commands) = mpsc::unbounded_channel();
        let (host, guest) = tokio::io::duplex(64 << 10);
        serve(&hub, 1, "sb".into(), host);
        let Some(Command::Conn { guest: handle, .. }) = commands.recv().await else {
            panic!("the connection was not handed to the hub");
        };
        (handle, commands, guest)
    }

    async fn closed(commands: &mut mpsc::UnboundedReceiver<Command>) {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), commands.recv()).await {
                Ok(Some(Command::Input(Input::GuestClosed { conn: 1 }))) => return,
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => panic!("the connection did not end"),
            }
        }
    }

    #[tokio::test]
    async fn a_guest_that_does_not_read_ends_as_a_slow_consumer() {
        let (handle, mut commands, _guest) = served().await;
        let message = || {
            ServerOp::Msg(Delivery {
                subject: "s".into(),
                sid: "1".into(),
                reply: None,
                headers: None,
                payload: Bytes::from(vec![0; 1 << 20]),
            })
        };
        let mut sent = 0;
        while handle.send(message()).is_ok() {
            sent += 1;
            assert!(
                sent <= BACKLOG >> 20,
                "kept {sent} MiB for a guest that never reads"
            );
        }
        assert!(sent >= (BACKLOG >> 20) - 1, "ended after only {sent} MiB");
        closed(&mut commands).await;
    }

    #[tokio::test]
    async fn a_guest_that_sends_faster_than_the_hub_takes_is_not_read() {
        let (handle, mut commands, mut guest) = served().await;
        handle.send(ServerOp::Info(Info::new(1 << 20, 1))).unwrap();
        let payload = vec![b'x'; 64 << 10];
        let writing = tokio::spawn(async move {
            for _ in 0..1_000 {
                let mut op = format!("PUB s {}\r\n", payload.len()).into_bytes();
                op.extend_from_slice(&payload);
                op.extend_from_slice(b"\r\n");
                if guest.write_all(&op).await.is_err() {
                    return;
                }
            }
        });
        // The hub holds what it was handed, credit and all.
        let mut held = Vec::new();
        while let Ok(Some(command)) =
            tokio::time::timeout(Duration::from_millis(300), commands.recv()).await
        {
            if let Command::Credited {
                input:
                    Input::Guest {
                        op: ClientOp::Pub(_),
                        ..
                    },
                credit,
            } = command
            {
                held.push(credit);
            }
        }
        let cost = 64 + 1 + (64 << 10);
        assert_eq!(held.len(), CREDIT / cost, "in flight past the credit");
        // Handled, they let more through.
        let before = held.len();
        held.clear();
        let more = tokio::time::timeout(Duration::from_secs(5), commands.recv())
            .await
            .expect("nothing more was read");
        assert!(more.is_some(), "after {before}");
        writing.abort();
    }
}
