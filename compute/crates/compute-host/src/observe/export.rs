//! The exporter: takes every event off the agent's hands, writes it to the
//! local journal, and sends events and metrics to an OpenTelemetry
//! collector over OTLP/HTTP with JSON encoding.
//!
//! Nothing here can slow the agent. Events wait in a bounded buffer while
//! the collector is slow or away; when it is full the oldest go, counted.
//! One request per signal is in flight at a time. A request is retried on
//! transport failures and on 429, 502, 503 and 504, with backoff and for a
//! bounded time, waiting as long as a `Retry-After` asks, or giving up
//! at once when that is longer than the time left; any other refusal drops
//! its batch, counted. A partial success is never retried: what it
//! rejected is counted as dropped. A response that cannot be read in full
//! counts as a transport failure; one that is too large or not an OTLP
//! response fails its batch, since what it accepted is unknown.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::event::{Event, unix_nanos_now};
use super::metrics::{DropReason, Metrics, Signal};
use super::otlp::{self, Origin, Process};

/// The most of a collector's response read. A real one is a few bytes, or
/// a short message with a partial success.
const MAX_RESPONSE: usize = 64 << 10;

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

/// What the observer hands the exporter task.
pub(crate) enum Message {
    /// An event to journal and export.
    Event(Event),
    /// Send everything now, then say so: the agent is stopping.
    Flush(oneshot::Sender<()>),
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
/// once; a flush does the same and goes on.
pub(crate) async fn run(
    sinks: Sinks,
    metrics: Arc<Metrics>,
    mut messages: mpsc::Receiver<Message>,
) {
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
    // A zero period would panic; the agent's settings refuse it before.
    let (logs_every, metrics_every) = sinks.export.as_ref().map_or(
        (Duration::from_secs(3600), Duration::from_secs(3600)),
        |export| {
            let shortest = Duration::from_millis(1);
            (
                export.logs_every.max(shortest),
                export.metrics_every.max(shortest),
            )
        },
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
            message = messages.recv() => {
                match message {
                    Some(Message::Event(event)) => {
                        let buffer = client.as_ref().map(|_| (&mut pending, capacity));
                        deliver(&sinks, event, buffer, &metrics);
                    }
                    Some(Message::Flush(done)) => {
                        if let Some(exporter) = &client {
                            drain(exporter, [&mut logs, &mut points], &mut pending, &metrics)
                                .await;
                        }
                        let _ = done.send(());
                    }
                    None => break,
                }
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
    if let Some(exporter) = &client {
        drain(exporter, [&mut logs, &mut points], &mut pending, &metrics).await;
    }
}

/// Lets the requests in flight finish, then sends every waiting event and
/// the metrics once each, with a single attempt per request.
async fn drain(
    exporter: &Exporter,
    in_flight: [&mut Option<InFlight>; 2],
    pending: &mut VecDeque<Event>,
    metrics: &Metrics,
) {
    for (slot, signal) in in_flight.into_iter().zip([Signal::Logs, Signal::Metrics]) {
        if slot.is_some() {
            let (sent, count) = finished(slot).await;
            account(metrics, signal, sent, count);
            *slot = None;
        }
    }
    let mut exporter = exporter.clone();
    exporter.config.retry_for = Duration::ZERO;
    while !pending.is_empty() {
        let mut last = Some(exporter.send_logs(pending));
        let (sent, count) = finished(&mut last).await;
        account(metrics, Signal::Logs, sent, count);
    }
    let mut last = Some(exporter.send_metrics());
    let (sent, count) = finished(&mut last).await;
    account(metrics, Signal::Metrics, sent, count);
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
                Ok(response) if response.status().is_success() => match read_body(response).await {
                    Ok(body) => return accepted(path, &url, &body),
                    Err(Unread::Transport(error)) => (format!("{url}: {error}"), None),
                    Err(Unread::TooLarge) => {
                        return Sent::Failed(format!(
                            "{url}: a response over {MAX_RESPONSE} bytes"
                        ));
                    }
                },
                Ok(response) if retryable(response.status().as_u16()) => {
                    let wait = retry_after(&response);
                    (format!("{url}: {}", response.status()), wait)
                }
                Ok(response) => return Sent::Failed(format!("{url}: {}", response.status())),
                Err(error) => (format!("{url}: {error}"), None),
            };
            let asked = wait.is_some();
            let wait = wait.unwrap_or(delay);
            if tokio::time::Instant::now() + wait > give_up {
                return Sent::Failed(if asked {
                    format!(
                        "{problem}, and asked to wait {} s, beyond the time left to retry",
                        wait.as_secs()
                    )
                } else {
                    problem
                });
            }
            tokio::time::sleep(wait).await;
            delay = (delay * 2).min(Duration::from_secs(16));
        }
    }
}

/// Why a response's body was not read.
enum Unread {
    /// The connection failed while reading it.
    Transport(reqwest::Error),
    /// It is longer than [`MAX_RESPONSE`].
    TooLarge,
}

/// Reads a response's body, up to [`MAX_RESPONSE`].
async fn read_body(mut response: reqwest::Response) -> Result<Vec<u8>, Unread> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE as u64)
    {
        return Err(Unread::TooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(Unread::Transport)? {
        if body.len() + chunk.len() > MAX_RESPONSE {
            return Err(Unread::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// What a successful response to `path` says was accepted.
fn accepted(path: &str, url: &str, body: &[u8]) -> Sent {
    match otlp::rejected(body) {
        Ok((rejected, message)) => {
            if let Some(message) = message {
                tracing::warn!(
                    path,
                    rejected,
                    message,
                    "the collector rejected part of an export"
                );
            }
            Sent::Accepted { rejected }
        }
        Err(error) => Sent::Failed(format!("{url}: not an OTLP response: {error}")),
    }
}

/// Whether a response status is worth retrying, as the OTLP specification
/// lists them.
pub(crate) fn retryable(status: u16) -> bool {
    matches!(status, 429 | 502 | 503 | 504)
}

/// The delay a `Retry-After` header asks for, in seconds or as an HTTP
/// date; a date already past asks for none.
fn retry_after(response: &reqwest::Response) -> Option<Duration> {
    let value = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?;
    retry_delay(value, unix_nanos_now() / 1_000_000_000)
}

/// The delay `value`, a `Retry-After`, asks for when it is `now` in
/// seconds since the Unix epoch.
pub(crate) fn retry_delay(value: &str, now: u64) -> Option<Duration> {
    let value = value.trim();
    if let Ok(seconds) = value.parse() {
        return Some(Duration::from_secs(seconds));
    }
    let at = http_date(value)?;
    Some(Duration::from_secs(at.saturating_sub(now)))
}

/// Seconds since the Unix epoch of an HTTP date in its preferred form,
/// such as `Sun, 06 Nov 1994 08:49:37 GMT`. The two obsolete forms are
/// not read; a delay in them falls back to the exporter's own backoff.
pub(crate) fn http_date(text: &str) -> Option<u64> {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let (_, rest) = text.split_once(", ")?;
    let mut parts = rest.split(' ');
    let day: u64 = parts.next()?.parse().ok()?;
    let month = parts.next()?;
    let year: u64 = parts.next()?.parse().ok()?;
    let time = parts.next()?;
    if parts.next()? != "GMT" || parts.next().is_some() {
        return None;
    }
    let month = MONTHS.iter().position(|name| *name == month)? as u64 + 1;
    let mut clock = time.split(':').map(|part| part.parse::<u64>().ok());
    let (hour, minute, second) = (clock.next()??, clock.next()??, clock.next()??);
    if clock.next().is_some() || !(1..=31).contains(&day) || year < 1970 || hour > 23 {
        return None;
    }
    if minute > 59 || second > 60 {
        return None;
    }
    // Days since the epoch of a proleptic Gregorian date (Howard
    // Hinnant's `days_from_civil`).
    let (y, m) = if month <= 2 {
        (year - 1, month + 9)
    } else {
        (year, month - 3)
    };
    let era = y / 400;
    let of_era = y % 400;
    let of_year = (153 * m + 2) / 5 + day - 1;
    let of_cycle = of_era * 365 + of_era / 4 - of_era / 100 + of_year;
    let days = (era * 146_097 + of_cycle).checked_sub(719_468)?;
    Some(days * 86_400 + hour * 3600 + minute * 60 + second)
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
