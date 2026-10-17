//! The exporter: takes every event off the agent's hands, writes it to the
//! local journal, and sends events and metrics to an OpenTelemetry
//! collector over OTLP/HTTP with JSON encoding.
//!
//! Nothing here can slow the agent. Events wait in a bounded buffer while
//! the collector is slow or away; when it is full the oldest go, counted.
//! One request per signal is in flight at a time. A request is retried on
//! transport failures and on 429, 502, 503 and 504, with backoff and for a
//! bounded time; any other refusal drops its batch, counted. A partial
//! success is never retried: what it rejected is counted as dropped.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::event::{Event, unix_nanos_now};
use super::metrics::{DropReason, Metrics, Signal};
use super::otlp::{self, Origin, Process};

/// Where and how often to export.
#[derive(Clone, Debug)]
pub struct ExportConfig {
    /// The collector's OTLP/HTTP base URL, such as `http://127.0.0.1:4318`;
    /// requests go to `/v1/logs` and `/v1/metrics` under it.
    pub endpoint: String,
    /// Headers every request carries, such as an authorization.
    pub headers: Vec<(String, String)>,
    /// How long one attempt may take.
    pub timeout: Duration,
    /// How long a request may keep retrying before its batch is dropped.
    pub retry_for: Duration,
    /// How often waiting events are sent.
    pub logs_every: Duration,
    /// How often metrics are sent.
    pub metrics_every: Duration,
    /// Events held for the collector at most.
    pub buffer: usize,
    /// Events sent in one request at most.
    pub batch: usize,
}

impl ExportConfig {
    /// Exports to `endpoint` with the defaults: events every second and
    /// metrics every ten, 10 s per attempt, retried for up to a minute,
    /// 2,048 events held and 512 sent at a time.
    #[must_use]
    pub fn new(endpoint: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into().trim_end_matches('/').to_owned(),
            headers: Vec::new(),
            timeout: Duration::from_secs(10),
            retry_for: Duration::from_secs(60),
            logs_every: Duration::from_secs(1),
            metrics_every: Duration::from_secs(10),
            buffer: 2048,
            batch: 512,
        }
    }
}

/// How a request to the collector ended.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Sent {
    /// Accepted, except for `rejected` records or points.
    Accepted { rejected: u64 },
    /// Refused for good, or failed until the retries ran out.
    Failed(String),
}

/// Where events go besides the journal.
pub(crate) struct Sinks {
    pub origin: Origin,
    pub export: Option<ExportConfig>,
    pub journal: bool,
    pub tap: Option<mpsc::Sender<Event>>,
}

/// One request in flight, with how many records or points it carries.
struct InFlight(JoinHandle<Sent>, u64);

/// Waits for the request in `slot` to end, or forever if there is none.
async fn finished(slot: &mut Option<InFlight>) -> (Sent, u64) {
    match slot {
        Some(InFlight(handle, count)) => {
            let sent = handle
                .await
                .unwrap_or_else(|error| Sent::Failed(error.to_string()));
            (sent, *count)
        }
        None => std::future::pending().await,
    }
}

/// Runs until every [`super::Observer`] is gone, then sends what is left
/// once.
pub(crate) async fn run(sinks: Sinks, metrics: Arc<Metrics>, mut events: mpsc::Receiver<Event>) {
    let client = sinks.export.as_ref().and_then(|export| {
        reqwest::Client::builder()
            .timeout(export.timeout)
            .build()
            .map_err(
                |error| tracing::error!(%error, "no HTTP client; events go to the journal only"),
            )
            .ok()
            .map(|client| Exporter {
                client,
                config: export.clone(),
                origin: sinks.origin.clone(),
                metrics: Arc::clone(&metrics),
            })
    });
    let (logs_every, metrics_every) = sinks.export.as_ref().map_or(
        (Duration::from_secs(3600), Duration::from_secs(3600)),
        |export| (export.logs_every, export.metrics_every),
    );
    let capacity = sinks.export.as_ref().map_or(0, |export| export.buffer);
    let mut pending: VecDeque<Event> = VecDeque::with_capacity(capacity.min(256));
    let mut logs: Option<InFlight> = None;
    let mut points: Option<InFlight> = None;
    let mut logs_tick = tokio::time::interval(logs_every);
    let mut metrics_tick = tokio::time::interval(metrics_every);
    logs_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    metrics_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            event = events.recv() => {
                let Some(event) = event else { break };
                deliver(&sinks, event, client.as_ref().map(|_| (&mut pending, capacity)), &metrics);
            }
            _ = logs_tick.tick(), if client.is_some() && logs.is_none() && !pending.is_empty() => {
                if let Some(exporter) = &client {
                    logs = Some(exporter.send_logs(&mut pending));
                }
            }
            _ = metrics_tick.tick(), if client.is_some() && points.is_none() => {
                if let Some(exporter) = &client {
                    points = Some(exporter.send_metrics());
                }
            }
            (sent, count) = finished(&mut logs) => {
                logs = None;
                account(&metrics, Signal::Logs, sent, count);
            }
            (sent, count) = finished(&mut points) => {
                points = None;
                account(&metrics, Signal::Metrics, sent, count);
            }
        }
    }
    let Some(exporter) = client else { return };
    // The agent is stopping: whatever is in flight finishes, then what is
    // left goes once, without retries beyond a single attempt's time.
    for (slot, signal) in [(&mut logs, Signal::Logs), (&mut points, Signal::Metrics)] {
        if slot.is_some() {
            let (sent, count) = finished(slot).await;
            account(&metrics, signal, sent, count);
        }
    }
    let mut exporter = exporter;
    exporter.config.retry_for = Duration::ZERO;
    while !pending.is_empty() {
        let mut last = Some(exporter.send_logs(&mut pending));
        let (sent, count) = finished(&mut last).await;
        account(&metrics, Signal::Logs, sent, count);
    }
    let mut last = Some(exporter.send_metrics());
    let (sent, count) = finished(&mut last).await;
    account(&metrics, Signal::Metrics, sent, count);
}

/// Hands one event to the journal, the tap and the collector's buffer,
/// dropping the oldest buffered event when the buffer is full.
fn deliver(
    sinks: &Sinks,
    event: Event,
    buffer: Option<(&mut VecDeque<Event>, usize)>,
    metrics: &Metrics,
) {
    if sinks.journal {
        tracing::info!(target: "compute_event", "{}", event.to_json_line());
    }
    if let Some(tap) = &sinks.tap {
        let _ = tap.try_send(event.clone());
    }
    if let Some((pending, capacity)) = buffer {
        if pending.len() >= capacity {
            pending.pop_front();
            metrics.dropped(Signal::Logs, DropReason::Full, 1);
        }
        if capacity > 0 {
            pending.push_back(event);
        }
    }
}

/// Counts what a finished request dropped.
fn account(metrics: &Metrics, signal: Signal, sent: Sent, count: u64) {
    match sent {
        Sent::Accepted { rejected: 0 } => {}
        Sent::Accepted { rejected } => metrics.dropped(signal, DropReason::Rejected, rejected),
        Sent::Failed(error) => {
            tracing::warn!(?signal, count, %error, "export failed; dropped");
            metrics.dropped(signal, DropReason::Failed, count);
        }
    }
}

/// Sends requests to one collector.
#[derive(Clone)]
struct Exporter {
    client: reqwest::Client,
    config: ExportConfig,
    origin: Origin,
    metrics: Arc<Metrics>,
}

impl Exporter {
    /// Starts sending up to a batch of the oldest pending events.
    fn send_logs(&self, pending: &mut VecDeque<Event>) -> InFlight {
        let take = pending.len().min(self.config.batch.max(1));
        let batch: Vec<Event> = pending.drain(..take).collect();
        let body = otlp::logs(&self.origin, &batch, unix_nanos_now());
        let count = batch.len() as u64;
        drop(batch);
        InFlight(self.spawn("/v1/logs", body), count)
    }

    /// Starts sending every metric as it stands.
    fn send_metrics(&self) -> InFlight {
        let (body, points) =
            otlp::metrics(&self.origin, &self.metrics, process(), unix_nanos_now());
        InFlight(self.spawn("/v1/metrics", body), points as u64)
    }

    fn spawn(&self, path: &'static str, body: Vec<u8>) -> JoinHandle<Sent> {
        let this = self.clone();
        tokio::spawn(async move { this.post(path, body).await })
    }

    /// Posts `body` to `path`, retrying what is worth retrying.
    async fn post(&self, path: &str, body: Vec<u8>) -> Sent {
        let url = format!("{}{path}", self.config.endpoint);
        let body = bytes::Bytes::from(body);
        let give_up = tokio::time::Instant::now() + self.config.retry_for;
        let mut delay = Duration::from_millis(500);
        loop {
            let mut request = self
                .client
                .post(&url)
                .header("content-type", "application/json")
                .body(body.clone());
            for (name, value) in &self.config.headers {
                request = request.header(name, value);
            }
            let (problem, wait) = match request.send().await {
                Ok(response) if response.status().is_success() => {
                    let body = response.bytes().await.unwrap_or_default();
                    let (rejected, message) = otlp::rejected(&body);
                    if let Some(message) = message {
                        tracing::warn!(
                            path,
                            rejected,
                            message,
                            "the collector rejected part of an export"
                        );
                    }
                    return Sent::Accepted { rejected };
                }
                Ok(response) if retryable(response.status().as_u16()) => {
                    let wait = retry_after(&response);
                    (format!("{url}: {}", response.status()), wait)
                }
                Ok(response) => return Sent::Failed(format!("{url}: {}", response.status())),
                Err(error) => (format!("{url}: {error}"), None),
            };
            let wait = wait.unwrap_or(delay).min(Duration::from_secs(30));
            if tokio::time::Instant::now() + wait > give_up {
                return Sent::Failed(problem);
            }
            tokio::time::sleep(wait).await;
            delay = (delay * 2).min(Duration::from_secs(16));
        }
    }
}

/// Whether a response status is worth retrying, as the OTLP specification
/// lists them.
pub(crate) fn retryable(status: u16) -> bool {
    matches!(status, 429 | 502 | 503 | 504)
}

/// The delay a `Retry-After` header in seconds asks for.
fn retry_after(response: &reqwest::Response) -> Option<Duration> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
        .map(Duration::from_secs)
}

/// What the agent's process has used, on Linux.
fn process() -> Option<Process> {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
        // Fields after the command name, which may hold spaces and ends at
        // the last parenthesis.
        let fields: Vec<&str> = stat.rsplit_once(')')?.1.split_whitespace().collect();
        let ticks = |index: usize| fields.get(index)?.parse::<u64>().ok();
        #[allow(clippy::cast_precision_loss)]
        let per_second = rustix::param::clock_ticks_per_second() as f64;
        #[allow(clippy::cast_precision_loss)]
        let seconds = |index| ticks(index).map(|ticks| ticks as f64 / per_second);
        // utime and stime are fields 14 and 15 of the whole line: 11 and 12
        // after the name; rss is field 24, 21 after it, in pages.
        let page = u64::try_from(rustix::param::page_size()).unwrap_or(4096);
        Some(Process {
            cpu: [seconds(11)?, seconds(12)?],
            memory: ticks(21)? * page,
        })
    }
    #[cfg(not(target_os = "linux"))]
    None
}

#[cfg(test)]
mod tests;
