use super::*;
use std::sync::atomic::AtomicUsize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const INFO: &str = "INFO {\"server_id\":\"dialer-test\",\"server_name\":\"dialer-test\",\"version\":\"2.10.0\",\"go\":\"go1\",\"host\":\"0.0.0.0\",\"port\":4222,\"headers\":true,\"max_payload\":1048576,\"proto\":1}\r\n";

/// Plays a NATS server on one end of an in-memory pipe: sends INFO, then
/// answers every PING until the client goes away. Returns the client's ops.
async fn serve(stream: tokio::io::DuplexStream) -> Vec<String> {
    let (read, mut write) = tokio::io::split(stream);
    write.write_all(INFO.as_bytes()).await.unwrap();
    let mut lines = BufReader::new(read).lines();
    let mut seen = Vec::new();
    while let Ok(Some(line)) = lines.next_line().await {
        let op = line
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_owned();
        if op == "PING" && write.write_all(b"PONG\r\n").await.is_err() {
            break;
        }
        seen.push(op);
    }
    seen
}

#[tokio::test]
async fn custom_dialer_replaces_dns_and_tcp() {
    let dials = Arc::new(AtomicUsize::new(0));
    let (server_end_tx, server_end_rx) = tokio::sync::oneshot::channel();
    let server_end_tx = std::sync::Mutex::new(Some(server_end_tx));
    let counted = dials.clone();
    let options = ConnectOptions::new()
        .ignore_discovered_servers()
        .custom_dialer(move |server: ServerAddr| {
            counted.fetch_add(1, Ordering::SeqCst);
            assert_eq!(server.host(), "unresolvable.invalid");
            let (client, server) = tokio::io::duplex(64 * 1024);
            if let Some(tx) = server_end_tx.lock().unwrap().take() {
                let _ = tx.send(server);
            }
            async move { Ok(client) }
        });
    let server = tokio::spawn(async move { serve(server_end_rx.await.unwrap()).await });

    // The host does not resolve, so this only works if DNS and TCP are skipped.
    let client = options
        .connect("nats://unresolvable.invalid:4222")
        .await
        .unwrap();
    client.publish("dialed", "hello".into()).await.unwrap();
    client.flush().await.unwrap();
    drop(client);

    let ops = server.await.unwrap();
    assert_eq!(dials.load(Ordering::SeqCst), 1);
    assert_eq!(ops.first().map(String::as_str), Some("CONNECT"), "{ops:?}");
    assert!(ops.iter().any(|op| op == "PUB"), "{ops:?}");
}

#[cfg(feature = "websockets")]
#[tokio::test]
async fn custom_dialer_refuses_websocket_servers() {
    let error = ConnectOptions::new()
        .custom_dialer(|_| async { Ok(tokio::io::duplex(64).0) })
        .connect("ws://localhost:8080")
        .await
        .unwrap_err();
    assert_eq!(error.kind(), ConnectErrorKind::ServerParse, "{error}");
}
