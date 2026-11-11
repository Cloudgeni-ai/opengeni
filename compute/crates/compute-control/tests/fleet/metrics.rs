//! The replica's metrics, and the hosts' metrics it passes on.

use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use serde_json::{Value, json};
use tokio::net::TcpListener;

use crate::support::{Fleet, OPERATOR_KEY, given_up, until};

/// A metrics store that keeps what it is sent and answers `status`,
/// with `retry_after` when set.
#[derive(Clone, Default)]
struct Store {
    got: Arc<Mutex<Vec<(String, Bytes)>>>,
    status: Arc<Mutex<Option<StatusCode>>>,
    retry_after: Arc<Mutex<Option<&'static str>>>,
}

impl Store {
    /// The exports it was sent, parsed.
    fn exports(&self) -> Vec<Value> {
        let got = self.got.lock().unwrap();
        got.iter()
            .map(|(_, body)| serde_json::from_slice(body).unwrap())
            .collect()
    }
}

async fn take(State(store): State<Store>, headers: HeaderMap, body: Bytes) -> Response {
    let kind = headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    store.got.lock().unwrap().push((kind, body));
    let status = store.status.lock().unwrap().unwrap_or(StatusCode::OK);
    let mut answer = (status, "{}").into_response();
    if let Some(after) = *store.retry_after.lock().unwrap() {
        answer
            .headers_mut()
            .insert("retry-after", HeaderValue::from_static(after));
    }
    answer
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

fn text(key: &str, value: &str) -> Value {
    json!({"key": key, "value": {"stringValue": value}})
}

/// A gauge data point of `value` with the attributes `labels`.
fn point(labels: &[(&str, &str)], value: i64) -> Value {
    let attributes: Vec<Value> = labels.iter().map(|(key, value)| text(key, value)).collect();
    json!({"attributes": attributes, "asInt": value.to_string(), "timeUnixNano": "1"})
}

/// An export from `host` of `metrics`, describing itself by more than
/// the control service passes on.
fn export_of(host: &str, metrics: &[Value]) -> Value {
    json!({
        "resourceMetrics": [{
            "resource": {"attributes": [
                text("service.name", "something-else"),
                text("host.name", host),
                text("compute.memory_profile", "bare_metal"),
                text("team", "not-a-host-attribute"),
            ]},
            "scopeMetrics": [{"scope": {"name": "compute-host"}, "metrics": metrics}],
        }],
    })
}

/// One sandbox count, as hosts send it.
fn sandboxes(value: i64) -> Value {
    json!({
        "name": "compute.sandbox.count",
        "unit": "{sandbox}",
        "gauge": {"dataPoints": [point(&[("compute.level", "running")], value)]},
    })
}

fn export(host: &str) -> Value {
    export_of(host, &[sandboxes(3)])
}

/// The value of the one sample `series` names.
fn value(text: &str, series: &str) -> Option<f64> {
    text.lines()
        .find_map(|line| line.strip_prefix(series)?.strip_prefix(' '))
        .map(|value| value.parse().unwrap())
}

/// The resource attributes and metric names of `export`'s one resource.
fn shape(export: &Value) -> (Vec<(String, String)>, Vec<String>) {
    let resource = &export["resourceMetrics"][0];
    let mut attributes: Vec<(String, String)> = resource["resource"]["attributes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|attribute| {
            (
                attribute["key"].as_str().unwrap().to_owned(),
                attribute["value"]["stringValue"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            )
        })
        .collect();
    attributes.sort();
    let names = resource["scopeMetrics"][0]["metrics"]
        .as_array()
        .unwrap()
        .iter()
        .map(|metric| metric["name"].as_str().unwrap().to_owned())
        .collect();
    (attributes, names)
}

#[tokio::test]
async fn a_host_s_own_metrics_are_passed_on_under_its_name_and_no_other_s() {
    let (store, url) = metrics_store().await;
    let fleet = Fleet::start_passing_metrics_to(&url).await;
    let host = fleet.host("hosts-a").await;

    let (status, _, answer) = host.post_metrics(&export("hosts-a")).await;
    assert_eq!((status, answer.as_str()), (200, "{}"));
    {
        let got = store.got.lock().unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, "application/json");
    }
    let sent = &store.exports()[0];
    let pair = |key: &str, value: &str| (key.to_owned(), value.to_owned());
    assert_eq!(
        shape(sent),
        (
            vec![
                pair("host.name", "hosts-a"),
                pair("service.instance.id", "hosts-a"),
                pair("service.name", "compute-host"),
            ],
            vec!["compute.sandbox.count".to_owned()],
        ),
        "under the host's own name, with nothing else the host says of itself"
    );
    let points =
        &sent["resourceMetrics"][0]["scopeMetrics"][0]["metrics"][0]["gauge"]["dataPoints"];
    assert_eq!(points[0]["asInt"], "3");
    assert_eq!(
        points[0]["attributes"],
        json!([text("compute.level", "running")])
    );

    // Another host's name, or what is not an export, is refused before
    // the store sees it.
    let (status, _, _) = host.post_metrics(&export("hosts-b")).await;
    assert_eq!(status, 403);
    let (status, _, _) = host
        .post_metrics(&json!({"resourceMetrics": "not a list"}))
        .await;
    assert_eq!(status, 400);
    assert_eq!(store.got.lock().unwrap().len(), 1);

    // The store's refusals reach the host as the store gave them, with
    // when to retry, so it retries what the store asks it to.
    *store.status.lock().unwrap() = Some(StatusCode::SERVICE_UNAVAILABLE);
    *store.retry_after.lock().unwrap() = Some("7");
    let (status, retry_after, _) = host.post_metrics(&export("hosts-a")).await;
    assert_eq!((status, retry_after.as_deref()), (503, Some("7")));

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
async fn series_hosts_do_not_send_are_left_out_and_reported_as_rejected() {
    let (store, url) = metrics_store().await;
    let fleet = Fleet::start_passing_metrics_to(&url).await;
    let host = fleet.host("hosts-a").await;

    // A host may not pass off the control service's or the fleet's
    // series as its own, nor add labels of its own.
    let forged = json!({
        "name": "compute_fleet_host_info",
        "unit": "1",
        "gauge": {"dataPoints": [point(&[("host_name", "hosts-b")], 1)]},
    });
    let labelled = json!({
        "name": "compute.sandbox.count",
        "unit": "{sandbox}",
        "gauge": {"dataPoints": [point(&[("compute.level", "running"), ("team", "x")], 1)]},
    });
    let (status, _, answer) = host
        .post_metrics(&export_of(
            "hosts-a",
            &[sandboxes(2), forged.clone(), labelled],
        ))
        .await;
    assert_eq!(status, 200);
    let answer: Value = serde_json::from_str(&answer).unwrap();
    assert_eq!(
        answer["partialSuccess"]["rejectedDataPoints"], "2",
        "{answer}"
    );
    let sent = store.exports();
    assert_eq!(sent.len(), 1);
    assert_eq!(shape(&sent[0]).1, vec!["compute.sandbox.count".to_owned()]);
    let points =
        &sent[0]["resourceMetrics"][0]["scopeMetrics"][0]["metrics"][0]["gauge"]["dataPoints"];
    assert_eq!(points.as_array().unwrap().len(), 1);
    assert_eq!(points[0]["asInt"], "2");

    // An export with nothing to pass on does not reach the store.
    let (status, _, answer) = host.post_metrics(&export_of("hosts-a", &[forged])).await;
    assert_eq!(status, 200);
    let answer: Value = serde_json::from_str(&answer).unwrap();
    assert_eq!(
        answer["partialSuccess"]["rejectedDataPoints"], "1",
        "{answer}"
    );
    assert_eq!(store.got.lock().unwrap().len(), 1);

    let text = fleet.scrape().await;
    assert_eq!(
        value(&text, "compute_control_host_metric_points_left_out_total"),
        Some(3.0),
        "{text}"
    );
}

#[tokio::test]
async fn without_a_store_hosts_may_post_no_metrics() {
    let fleet = Fleet::start().await;
    let host = fleet.host("hosts-a").await;
    let (status, _, _) = host.post_metrics(&export("hosts-a")).await;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_drained_host_that_goes_is_counted_removed_and_a_live_one_lost() {
    let fleet = Fleet::start().await;
    let drained = fleet.host("hosts-a").await;
    let lost = fleet.host("hosts-b").await;
    let (status, answer) = fleet
        .call(
            reqwest::Method::POST,
            "/v1/hosts/hosts-a/drain",
            Some(OPERATOR_KEY),
            None,
        )
        .await;
    assert_eq!(status, 200, "{answer}");
    until(
        Duration::from_secs(5),
        "the view sees it draining",
        async || {
            fleet
                .scrape()
                .await
                .contains("compute_fleet_host_info{host_name=\"hosts-a\",state=\"draining\"")
        },
    )
    .await;

    drained.renewing(false);
    given_up(&fleet, &drained).await;
    lost.renewing(false);
    given_up(&fleet, &lost).await;

    let mut text = String::new();
    until(Duration::from_secs(5), "both are counted", async || {
        text = fleet.scrape().await;
        value(
            &text,
            "compute_control_hosts_given_up_total{cause=\"lost\"}",
        ) == Some(1.0)
    })
    .await;
    assert_eq!(
        value(
            &text,
            "compute_control_hosts_given_up_total{cause=\"removed\"}"
        ),
        Some(1.0),
        "{text}"
    );
}
