//! The relay's Prometheus exposition placement, over real sockets through the
//! actual `serve` entry point.
//!
//! With `OPENGENI_RELAY_METRICS_BIND` set, `GET /metrics` is served only on that
//! dedicated internal listener and the public wss listener answers `404`, so an
//! ingress that forwards every path of the relay host cannot publish it. Without
//! it, the single-listener layout keeps `/metrics` on the wss port.

use std::time::Duration;

use opengeni_relay::{serve, RelayConfig, RelayMetrics};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpStream;

const SECRET: &str = "relay-metrics-secret";

/// Reserve an ephemeral localhost port (close the probe listener so `serve` can
/// rebind it; a tiny race window that is fine for a test).
async fn free_port() -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    port
}

async fn wait_for_listener(port: u16) {
    for _ in 0..100 {
        if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("listener on port {port} never accepted a connection");
}

/// Start the relay and wait until every given port accepts connections.
async fn start_relay(config: RelayConfig, ports: &[u16]) -> tokio::sync::oneshot::Sender<()> {
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = serve(config, RelayMetrics::new(), async {
            let _ = rx.await;
        })
        .await;
    });
    for port in ports {
        wait_for_listener(*port).await;
    }
    tx
}

/// A minimal HTTP/1.1 GET; returns (status, headers + body text).
async fn http_get(port: u16, path: &str) -> (u16, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response))
        .await
        .expect("the relay must answer within 5s")
        .unwrap();
    let text = String::from_utf8_lossy(&response).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or_else(|| panic!("malformed HTTP response: {text:?}"));
    (status, text)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dedicated_listener_serves_metrics_and_the_wss_port_does_not() {
    let (wss_port, metrics_port) = (free_port().await, free_port().await);
    let mut config = RelayConfig::for_test(SECRET);
    config.bind = format!("127.0.0.1:{wss_port}");
    config.metrics_bind = Some(format!("127.0.0.1:{metrics_port}"));
    let _shutdown = start_relay(config, &[wss_port, metrics_port]).await;

    let (status, body) = http_get(metrics_port, "/metrics").await;
    assert_eq!(status, 200, "{body}");
    assert!(
        body.contains("content-type: text/plain; version=0.0.4"),
        "{body}"
    );
    assert!(
        body.contains("opengeni_relay_opens_accepted_total"),
        "{body}"
    );

    // The public wss listener no longer publishes the exposition, but keeps its
    // probe endpoint.
    assert_eq!(http_get(wss_port, "/metrics").await.0, 404);
    assert_eq!(http_get(wss_port, "/healthz").await.0, 200);

    // The internal listener routes nothing but /metrics.
    assert_eq!(http_get(metrics_port, "/healthz").await.0, 404);
    assert_eq!(
        http_get(metrics_port, "/stream?ws=a&agent=b&port=1&channel=c")
            .await
            .0,
        404
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_a_dedicated_listener_metrics_stay_on_the_wss_port() {
    let wss_port = free_port().await;
    let mut config = RelayConfig::for_test(SECRET);
    config.bind = format!("127.0.0.1:{wss_port}");
    let _shutdown = start_relay(config, &[wss_port]).await;

    let (status, body) = http_get(wss_port, "/metrics").await;
    assert_eq!(status, 200, "{body}");
    assert!(
        body.contains("opengeni_relay_opens_accepted_total"),
        "{body}"
    );
    assert_eq!(http_get(wss_port, "/healthz").await.0, 200);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_metrics_listener_on_the_wss_port_is_refused() {
    let port = free_port().await;
    for metrics_bind in [format!("127.0.0.1:{port}"), format!("0.0.0.0:{port}")] {
        let mut config = RelayConfig::for_test(SECRET);
        config.bind = format!("127.0.0.1:{port}");
        config.metrics_bind = Some(metrics_bind.clone());
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            serve(config, RelayMetrics::new(), std::future::pending::<()>()),
        )
        .await
        .expect("a refused configuration must fail fast, not serve");
        // Either the OS refuses the second bind or, where it accepts a
        // host-specific bind on a shared port (macOS), the explicit port check does.
        let error = result.expect_err("sharing the wss port must be refused");
        assert!(
            error.to_string().to_lowercase().contains("metrics"),
            "{metrics_bind}: {error}"
        );
    }
}
