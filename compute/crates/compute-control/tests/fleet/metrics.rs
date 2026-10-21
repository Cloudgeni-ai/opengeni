//! The replica's metrics, and the hosts' metrics it passes on.

use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use serde_json::{Value, json};
use tokio::net::TcpListener;

use crate::support::{Fleet, until};

/// A metrics store that keeps what it is sent and answers `status`.
#[derive(Clone, Default)]
struct Store {
    got: Arc<Mutex<Vec<(String, Bytes)>>>,
    status: Arc<Mutex<Option<StatusCode>>>,
}

async fn take(
    State(store): State<Store>,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, &'static str) {
    let kind = headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    store.got.lock().unwrap().push((kind, body));
    let status = store.status.lock().unwrap().unwrap_or(StatusCode::OK);
    (status, "{}")
}

async fn metrics_store() -> (Store, String) {
    let store = Store::default();
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let url = format!(
        "http://{}/api/v1/otlp/v1/metrics",
        listener.local_addr().unwrap()
    );
    let router = Router::new()
        .route("/api/v1/otlp/v1/metrics", post(take))
        .with_state(store.clone());
    tokio::spawn(async move { axum::serve(listener, router).await });
    (store, url)
}

fn export(host: &str) -> Value {
    json!({
        "resourceMetrics": [{
            "resource": {"attributes": [
                {"key": "service.name", "value": {"stringValue": "compute-host"}},
                {"key": "host.name", "value": {"stringValue": host}},
            ]},
            "scopeMetrics": [{
                "scope": {"name": "compute-host"},
                "metrics": [{
                    "name": "compute.sandbox.count",
                    "unit": "{sandbox}",
                    "gauge": {"dataPoints": [{"asInt": "3", "timeUnixNano": "1"}]},
                }],
            }],
        }],
    })
}

/// The value of the one sample `series` names.
fn value(text: &str, series: &str) -> Option<f64> {
    text.lines()
        .find_map(|line| line.strip_prefix(series)?.strip_prefix(' '))
        .map(|value| value.parse().unwrap())
}

#[tokio::test]
async fn a_host_s_own_metrics_are_passed_on_and_no_other_s() {
    let (store, url) = metrics_store().await;
    let fleet = Fleet::start_passing_metrics_to(&url).await;
    let host = fleet.host("hosts-a").await;

    let (status, answer) = host.post_metrics(&export("hosts-a")).await;
    assert_eq!((status, answer.as_str()), (200, "{}"));
    {
        let got = store.got.lock().unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, "application/json");
        let sent: Value = serde_json::from_slice(&got[0].1).unwrap();
        assert_eq!(sent, export("hosts-a"), "passed on as it came");
    }

    // Another host's name, or none, is refused before the store sees it.
    let (status, _) = host.post_metrics(&export("hosts-b")).await;
    assert_eq!(status, 403);
    let (status, _) = host
        .post_metrics(&json!({"resourceMetrics": [{"resource": {}}]}))
        .await;
    assert_eq!(status, 400);
    assert_eq!(store.got.lock().unwrap().len(), 1);

    // The store's refusals reach the host as the store gave them, so it
    // retries what the store asks it to.
    *store.status.lock().unwrap() = Some(StatusCode::SERVICE_UNAVAILABLE);
    let (status, _) = host.post_metrics(&export("hosts-a")).await;
    assert_eq!(status, 503);

    let text = fleet.scrape().await;
    for (outcome, count) in [("forwarded", 1.0), ("refused", 2.0), ("failed", 1.0)] {
        assert_eq!(
            value(
                &text,
                &format!("compute_control_host_metrics_total{{outcome=\"{outcome}\"}}")
            ),
            Some(count),
            "{outcome}"
        );
    }
}

#[tokio::test]
async fn without_a_store_hosts_may_post_no_metrics() {
    let fleet = Fleet::start().await;
    let host = fleet.host("hosts-a").await;
    let (status, _) = host.post_metrics(&export("hosts-a")).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn the_leader_reports_the_fleet_and_every_replica_its_requests() {
    let fleet = Fleet::start().await;
    let host = fleet.host("hosts-a").await;
    let _host = host;
    fleet.create(json!({})).await;
    let (status, _) = fleet.get("/v1/sandboxes/not-an-id").await;
    assert_ne!(status, 200);

    let mut text = String::new();
    until(
        Duration::from_secs(10),
        "the leader reports the host",
        async || {
            text = fleet.scrape().await;
            value(&text, "compute_control_leader") == Some(1.0)
                && value(
                    &text,
                    "compute_fleet_host_renewal_age_seconds{host_name=\"hosts-a\"}",
                )
                .is_some()
        },
    )
    .await;
    assert!(
        text.contains("compute_fleet_host_info{host_name=\"hosts-a\",state=\"live\""),
        "{text}"
    );
    assert!(
        value(
            &text,
            "compute_fleet_host_memory_free_bytes{host_name=\"hosts-a\"}"
        )
        .is_some_and(|free| free > 0.0),
        "{text}"
    );
    assert_eq!(
        value(
            &text,
            "compute_control_requests_total{method=\"POST\",route=\"/v1/sandboxes\",outcome=\"ok\"}"
        ),
        Some(1.0),
        "{text}"
    );
    assert!(
        text.lines().any(|line| line.starts_with(
            "compute_control_requests_total{method=\"GET\",route=\"/v1/sandboxes/{id}\""
        ) && !line.contains("outcome=\"ok\"")),
        "{text}"
    );
}
