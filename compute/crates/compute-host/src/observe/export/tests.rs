use std::sync::Mutex;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

use super::super::{ObserveConfig, Observer, Severity, Value};
use super::*;

/// One answer the fake collector gives: a status, an optional
/// `Retry-After` in seconds, and a body.
#[derive(Clone)]
struct Answer(u16, Option<u64>, &'static str);

const OK: Answer = Answer(200, None, "{}");

/// A request the fake collector received.
#[derive(Debug)]
struct Received {
    path: String,
    headers: Vec<String>,
    body: serde_json::Value,
}

/// Serves one connection of the fake collector.
async fn serve(
    stream: tokio::net::TcpStream,
    script: Arc<Mutex<VecDeque<Answer>>>,
    sender: mpsc::UnboundedSender<Received>,
) {
    let mut stream = BufReader::new(stream);
    loop {
        let mut line = String::new();
        if stream.read_line(&mut line).await.unwrap_or(0) == 0 {
            return;
        }
        let path = line.split(' ').nth(1).unwrap_or("").to_owned();
        let mut headers = Vec::new();
        let mut length = 0;
        loop {
            let mut header = String::new();
            stream.read_line(&mut header).await.unwrap();
            let header = header.trim_end().to_ascii_lowercase();
            if header.is_empty() {
                break;
            }
            if let Some(value) = header.strip_prefix("content-length:") {
                length = value.trim().parse().unwrap();
            }
            headers.push(header);
        }
        let mut body = vec![0; length];
        stream.read_exact(&mut body).await.unwrap();
        let body = serde_json::from_slice(&body).unwrap();
        let Answer(status, retry, text) = script.lock().unwrap().pop_front().unwrap_or(OK);
        let _ = sender.send(Received {
            path,
            headers,
            body,
        });
        let retry = retry.map_or(String::new(), |after| format!("retry-after: {after}\r\n"));
        let response = format!(
            "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n{retry}content-length: {}\r\n\r\n{text}",
            text.len()
        );
        stream
            .get_mut()
            .write_all(response.as_bytes())
            .await
            .unwrap();
    }
}

/// A minimal HTTP/1.1 server standing in for an OpenTelemetry collector:
/// it gives the scripted answers in order, then `OK` to everything, and
/// sends each request it receives on.
async fn collector(script: Vec<Answer>) -> (String, mpsc::UnboundedReceiver<Received>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, received) = mpsc::unbounded_channel();
    let script = Arc::new(Mutex::new(VecDeque::from(script)));
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(serve(stream, Arc::clone(&script), sender.clone()));
        }
    });
    (format!("http://{address}"), received)
}

fn origin() -> Origin {
    Origin {
        resource: Vec::new(),
        version: String::new(),
        started_unix_nanos: 0,
    }
}

fn exporter(endpoint: &str, retry_for: Duration) -> Exporter {
    let mut config = ExportConfig::new(endpoint);
    config.retry_for = retry_for;
    config
        .headers
        .push(("authorization".into(), "Bearer t".into()));
    Exporter {
        client: reqwest::Client::new(),
        config,
        origin: origin(),
        metrics: Arc::default(),
    }
}

fn events(count: u64) -> VecDeque<Event> {
    (0..count)
        .map(|index| Event::new("compute.step", Severity::Info).with("n", index))
        .collect()
}

fn records(request: &Received) -> usize {
    request.body["resourceLogs"][0]["scopeLogs"][0]["logRecords"]
        .as_array()
        .map_or(0, Vec::len)
}

async fn send(exporter: &Exporter, pending: &mut VecDeque<Event>) -> (Sent, u64) {
    finished(&mut Some(exporter.send_logs(pending))).await
}

#[tokio::test]
async fn retryable_refusals_are_retried_after_the_delay_asked() {
    let script = vec![Answer(503, Some(0), ""), Answer(429, Some(0), "")];
    let (endpoint, mut received) = collector(script).await;
    let exporter = exporter(&endpoint, Duration::from_secs(5));
    let mut pending = events(3);
    assert_eq!(
        send(&exporter, &mut pending).await,
        (Sent::Accepted { rejected: 0 }, 3)
    );
    assert!(pending.is_empty());
    for _ in 0..3 {
        let request = received.recv().await.unwrap();
        assert_eq!(request.path, "/v1/logs");
        assert!(request.headers.contains(&"authorization: bearer t".into()));
        assert!(
            request
                .headers
                .contains(&"content-type: application/json".into())
        );
        assert_eq!(records(&request), 3, "the same batch each time");
    }
    assert!(received.try_recv().is_err(), "accepted on the third");
}

#[tokio::test]
async fn other_refusals_are_not_retried() {
    let (endpoint, mut received) = collector(vec![Answer(400, None, "")]).await;
    let exporter = exporter(&endpoint, Duration::from_secs(5));
    let (sent, count) = send(&exporter, &mut events(2)).await;
    assert!(
        matches!(sent, Sent::Failed(ref why) if why.contains("400")),
        "{sent:?}"
    );
    assert_eq!(count, 2);
    received.recv().await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(received.try_recv().is_err(), "sent once");
}

#[tokio::test]
async fn a_partial_success_is_never_retried() {
    let body = r#"{"partialSuccess":{"rejectedLogRecords":"2","errorMessage":"bad"}}"#;
    let (endpoint, mut received) = collector(vec![Answer(200, None, body)]).await;
    let exporter = exporter(&endpoint, Duration::from_secs(5));
    let (sent, count) = send(&exporter, &mut events(5)).await;
    assert_eq!((&sent, count), (&Sent::Accepted { rejected: 2 }, 5));
    received.recv().await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(received.try_recv().is_err(), "sent once");
    let metrics = Metrics::default();
    account(&metrics, Signal::Logs, sent, count);
    assert_eq!(metrics.drops(Signal::Logs, DropReason::Rejected), 2);
    assert_eq!(metrics.drops(Signal::Logs, DropReason::Failed), 0);
}

#[tokio::test]
async fn retries_stop_when_their_time_runs_out() {
    // Asked to come back in an hour with ten seconds to retry: give up now.
    let (endpoint, mut received) = collector(vec![Answer(503, Some(3600), "")]).await;
    let exporter = exporter(&endpoint, Duration::from_secs(10));
    let started = tokio::time::Instant::now();
    let (sent, _) = send(&exporter, &mut events(1)).await;
    assert!(
        matches!(sent, Sent::Failed(ref why) if why.contains("503")),
        "{sent:?}"
    );
    assert!(started.elapsed() < Duration::from_secs(5), "did not wait");
    received.recv().await.unwrap();
    let metrics = Metrics::default();
    account(&metrics, Signal::Metrics, sent, 7);
    assert_eq!(metrics.drops(Signal::Metrics, DropReason::Failed), 7);
}

#[tokio::test]
async fn a_collector_that_is_away_fails_the_batch() {
    // Nothing listens on a port just freed.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let exporter = exporter(&endpoint, Duration::ZERO);
    let (sent, count) = send(&exporter, &mut events(4)).await;
    assert!(matches!(sent, Sent::Failed(_)), "{sent:?}");
    assert_eq!(count, 4);
}

#[tokio::test]
async fn batches_take_the_oldest_events_first() {
    let (endpoint, mut received) = collector(Vec::new()).await;
    let mut exporter = exporter(&endpoint, Duration::ZERO);
    exporter.config.batch = 2;
    let mut pending = events(3);
    assert_eq!(send(&exporter, &mut pending).await.1, 2);
    assert_eq!(pending.len(), 1);
    let request = received.recv().await.unwrap();
    let first = &request.body["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0];
    assert_eq!(first["attributes"][0]["value"]["intValue"], "0");
}

/// A seeded generator, so a failure names the run that found it.
struct SplitMix64(u64);

impl SplitMix64 {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, bound: u64) -> usize {
        usize::try_from(self.next() % bound).unwrap()
    }
}

#[test]
fn the_buffer_keeps_the_newest_events_and_counts_the_rest() {
    let sinks = Sinks {
        origin: origin(),
        export: None,
        journal: false,
        tap: None,
    };
    for seed in 0..500 {
        let mut random = SplitMix64(seed);
        let capacity = random.below(8);
        let metrics = Metrics::default();
        let mut pending = VecDeque::new();
        let mut delivered = 0_u64;
        let mut sent = 0_u64;
        for _ in 0..random.below(64) {
            if random.below(4) == 0 {
                // The exporter takes a batch off the front.
                let take = random.below(4).min(pending.len());
                sent += take as u64;
                pending.drain(..take);
            } else {
                let event = Event::new("e", Severity::Info).with("n", delivered);
                deliver(&sinks, event, Some((&mut pending, capacity)), &metrics);
                delivered += 1;
            }
            assert!(pending.len() <= capacity, "seed {seed}: over capacity");
        }
        let dropped = metrics.drops(Signal::Logs, DropReason::Full);
        assert_eq!(
            sent + pending.len() as u64 + dropped,
            delivered,
            "seed {seed}: every event is sent, waiting or counted"
        );
        // What waits is the newest delivered, in order.
        for (offset, event) in pending.iter().rev().enumerate() {
            let expected = delivered - 1 - offset as u64;
            assert_eq!(event.get("n"), Some(&Value::from(expected)), "seed {seed}");
        }
    }
}

#[tokio::test]
async fn the_observer_exports_events_and_metrics_and_flushes_when_dropped() {
    let (endpoint, mut received) = collector(Vec::new()).await;
    let mut export = ExportConfig::new(format!("{endpoint}/"));
    export.logs_every = Duration::from_secs(3600);
    export.metrics_every = Duration::from_secs(3600);
    let observer = Observer::start(ObserveConfig {
        export: Some(export),
        journal: false,
        ..ObserveConfig::default()
    });
    observer.emit(Event::new("compute.step", Severity::Info));
    observer.emit(Event::new("compute.request", Severity::Info));
    drop(observer);
    let mut logged = 0;
    let mut metrics = 0;
    while let Ok(Some(request)) =
        tokio::time::timeout(Duration::from_secs(5), received.recv()).await
    {
        match request.path.as_str() {
            "/v1/logs" => logged += records(&request),
            "/v1/metrics" => metrics += 1,
            other => panic!("unexpected path {other}"),
        }
    }
    assert_eq!(logged, 2, "both events, once each");
    assert!(metrics >= 1, "metrics go once more when stopping");
}
