use super::*;
use futures_util::task::AtomicWaker;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

#[derive(Default)]
struct WriterState {
    writable: AtomicBool,
    budget: AtomicUsize,
    disconnected: AtomicBool,
    vectored: bool,
    attempted: AtomicUsize,
    bytes: Mutex<Vec<u8>>,
    waker: AtomicWaker,
}

struct PausedStream(Arc<WriterState>);

impl AsyncRead for PausedStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        _buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        self.0.waker.register(cx.waker());
        if self.0.disconnected.load(Ordering::SeqCst) {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "synthetic disconnect",
            )));
        }
        Poll::Pending
    }
}

impl AsyncWrite for PausedStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.0.attempted.fetch_add(1, Ordering::SeqCst);
        self.0.waker.register(cx.waker());
        let count = if self.0.writable.load(Ordering::SeqCst) {
            bytes.len()
        } else {
            bytes.len().min(self.0.budget.load(Ordering::SeqCst))
        };
        if count == 0 {
            return Poll::Pending;
        }
        if !self.0.writable.load(Ordering::SeqCst) {
            self.0.budget.fetch_sub(count, Ordering::SeqCst);
        }
        self.0
            .bytes
            .lock()
            .unwrap()
            .extend_from_slice(&bytes[..count]);
        Poll::Ready(Ok(count))
    }

    fn is_write_vectored(&self) -> bool {
        self.0.vectored
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffers: &[std::io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let bytes: Vec<u8> = buffers
            .iter()
            .flat_map(|buffer| buffer.iter().copied())
            .collect();
        self.poll_write(cx, &bytes)
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        // A TCP flush is a no-op even when the library's own write queue is full.
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

fn paused_handler() -> (
    Client,
    ConnectionHandler,
    mpsc::Receiver<Command>,
    Arc<WriterState>,
) {
    paused_handler_at("nats://127.0.0.1:1", false)
}

fn paused_handler_at(
    address: &str,
    vectored: bool,
) -> (
    Client,
    ConnectionHandler,
    mpsc::Receiver<Command>,
    Arc<WriterState>,
) {
    let options = ConnectOptions::new();
    let (events_tx, _events_rx) = mpsc::channel(8);
    let (state_tx, state_rx) = tokio::sync::watch::channel(State::Connected);
    let max_payload = Arc::new(AtomicUsize::new(1024));
    let statistics = Arc::new(Statistics::default());
    let connector = Connector::new(
        address,
        ConnectorOptions {
            tls_required: options.tls_required,
            certificates: options.certificates,
            client_key: options.client_key,
            client_cert: options.client_cert,
            tls_client_config: options.tls_client_config,
            tls_first: options.tls_first,
            auth: options.auth,
            no_echo: options.no_echo,
            connection_timeout: options.connection_timeout,
            name: options.name,
            ignore_discovered_servers: options.ignore_discovered_servers,
            retain_servers_order: options.retain_servers_order,
            read_buffer_capacity: options.read_buffer_capacity,
            reconnect_delay_callback: options.reconnect_delay_callback,
            auth_callback: options.auth_callback,
            max_reconnects: options.max_reconnects,
        },
        events_tx,
        state_tx,
        max_payload.clone(),
        statistics.clone(),
    )
    .unwrap();
    let writer = Arc::new(WriterState {
        vectored,
        ..Default::default()
    });
    let connection = Connection::new(
        Box::new(PausedStream(writer.clone())),
        0,
        statistics.clone(),
    );
    let (info_tx, info_rx) = tokio::sync::watch::channel(ServerInfo::default());
    let (sender, receiver) = mpsc::channel(8);
    let client = Client::new(
        info_rx,
        state_rx,
        sender,
        8,
        "_INBOX".into(),
        None,
        max_payload,
        statistics,
    );
    let handler = ConnectionHandler::new(connection, connector, info_tx, Duration::from_secs(60));
    (client, handler, receiver, writer)
}

async fn atomic_first_pending(vectored: bool) {
    let (client, mut handler, mut receiver, writer) =
        paused_handler_at("nats://127.0.0.1:1", vectored);
    let mut publication = Box::pin(client.publish_with_flush("fixture.reply", "synthetic".into()));
    assert!(futures_util::poll!(publication.as_mut()).is_pending());
    let mut process = Box::pin(handler.process(&mut receiver));
    assert!(futures_util::poll!(process.as_mut()).is_pending());
    assert!(writer.attempted.load(Ordering::SeqCst) > 0);
    assert!(writer.bytes.lock().unwrap().is_empty());
    assert!(futures_util::poll!(publication.as_mut()).is_pending());
    writer.writable.store(true, Ordering::SeqCst);
    writer.waker.wake();
    assert!(futures_util::poll!(process.as_mut()).is_pending());
    assert!(matches!(
        futures_util::poll!(publication.as_mut()),
        Poll::Ready(Ok(()))
    ));
    assert!(writer
        .bytes
        .lock()
        .unwrap()
        .windows(9)
        .any(|part| part == b"synthetic"));
    assert_eq!(client.statistics().out_messages.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn flush_custody_atomic_sequential_receipt_waits_for_the_actual_writer() {
    atomic_first_pending(false).await;
}

#[tokio::test]
async fn flush_custody_atomic_vectored_receipt_waits_for_the_actual_writer() {
    atomic_first_pending(true).await;
}

#[tokio::test]
async fn flush_custody_atomic_validation_does_not_enqueue_oversized_bytes() {
    let (client, mut handler, mut receiver, writer) = paused_handler();
    let error = client
        .publish_with_flush("fixture.reply", vec![0; 1025].into())
        .await
        .unwrap_err();
    assert_eq!(
        error.kind(),
        client::PublishFlushErrorKind::MaxPayloadExceeded
    );
    assert_eq!(client.statistics().out_messages.load(Ordering::SeqCst), 0);
    let mut process = Box::pin(handler.process(&mut receiver));
    assert!(futures_util::poll!(process.as_mut()).is_pending());
    assert!(writer.bytes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn flush_custody_processor_cancellation_fails_an_attached_receipt() {
    let (client, mut handler, mut receiver, writer) = paused_handler();
    let mut publication = Box::pin(client.publish_with_flush("fixture.reply", "synthetic".into()));
    assert!(futures_util::poll!(publication.as_mut()).is_pending());
    let mut process = Box::pin(handler.process(&mut receiver));
    assert!(futures_util::poll!(process.as_mut()).is_pending());
    assert!(writer.attempted.load(Ordering::SeqCst) > 0);
    drop(process);
    let error = publication.await.unwrap_err();
    assert_eq!(error.kind(), client::PublishFlushErrorKind::Unsettled);
    assert!(writer.bytes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn flush_custody_successful_reconnect_cannot_redeem_a_partial_old_publication() {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("nats://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let server_seen = seen.clone();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let (read, mut write) = socket.into_split();
        let mut read = BufReader::new(read);
        write.write_all(b"INFO {\"server_id\":\"fixture.replacement\",\"version\":\"2.10.0\",\"proto\":1,\"max_payload\":1048576}\r\n").await.unwrap();
        loop {
            let mut line = String::new();
            if read.read_line(&mut line).await.unwrap() == 0 {
                break;
            }
            if line == "PING\r\n" {
                write.write_all(b"PONG\r\n").await.unwrap();
            } else if line.starts_with("PUB ") {
                let length: usize = line.split_whitespace().last().unwrap().parse().unwrap();
                assert!(length <= 1024);
                let mut body = vec![0; length + 2];
                read.read_exact(&mut body).await.unwrap();
                server_seen.lock().unwrap().push(body);
            }
        }
    });
    let (client, mut handler, mut receiver, writer) = paused_handler_at(&address, false);
    writer.budget.store(8, Ordering::SeqCst);
    let mut old_publication =
        Box::pin(client.publish_with_flush("fixture.old", "old synthetic".into()));
    assert!(futures_util::poll!(old_publication.as_mut()).is_pending());
    let mut process = Box::pin(handler.process(&mut receiver));
    assert!(futures_util::poll!(process.as_mut()).is_pending());
    assert_eq!(writer.bytes.lock().unwrap().len(), 8);
    assert!(futures_util::poll!(old_publication.as_mut()).is_pending());
    writer.disconnected.store(true, Ordering::SeqCst);
    writer.waker.wake();
    tokio::time::timeout(Duration::from_secs(2), async {
        tokio::select! {
            outcome = client.publish_with_flush("fixture.new", "new synthetic".into()) => outcome.unwrap(),
            _ = process.as_mut() => panic!("processor ended before its replacement settled"),
        }
    }).await.unwrap();
    assert_eq!(client.server_info().server_id, "fixture.replacement");
    let error = old_publication.await.unwrap_err();
    assert_eq!(error.kind(), client::PublishFlushErrorKind::Unsettled);
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if !seen.lock().unwrap().is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(*seen.lock().unwrap(), vec![b"new synthetic\r\n".to_vec()]);
    drop(process);
    drop(client);
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn flush_custody_first_pending_write_keeps_the_receipt_pending() {
    let (client, mut handler, mut receiver, writer) = paused_handler();
    let mut publication = Box::pin(async {
        client
            .publish("fixture.reply", "synthetic".into())
            .await
            .unwrap();
        client.flush().await
    });
    assert!(futures_util::poll!(publication.as_mut()).is_pending());
    let mut process = Box::pin(handler.process(&mut receiver));
    assert!(futures_util::poll!(process.as_mut()).is_pending());
    assert!(writer.attempted.load(Ordering::SeqCst) > 0);
    assert!(writer.bytes.lock().unwrap().is_empty());
    assert!(
        futures_util::poll!(publication.as_mut()).is_pending(),
        "receipt completed while the actual handler writer was blocked"
    );
    writer.writable.store(true, Ordering::SeqCst);
    writer.waker.wake();
    assert!(futures_util::poll!(process.as_mut()).is_pending());
    assert!(matches!(
        futures_util::poll!(publication.as_mut()),
        Poll::Ready(Ok(()))
    ));
    assert!(writer
        .bytes
        .lock()
        .unwrap()
        .windows(9)
        .any(|part| part == b"synthetic"));
}
