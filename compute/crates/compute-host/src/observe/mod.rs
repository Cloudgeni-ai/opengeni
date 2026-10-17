//! What the host tells about itself ([ADR 16]): one wide event per step,
//! request and stream, metrics with bounded cardinality, zero alarms, a
//! canary, and an exporter of its own that speaks OTLP over HTTP with
//! JSON encoding.
//!
//! The agent hands events to an [`Observer`] without waiting: they queue
//! for one task that writes each to the local journal and sends them to the
//! collector, if one is set. When the queue is full an event is dropped and
//! counted. Counters are atomics, gauges are written once per sample.
//!
//! [ADR 16]: https://github.com/Cloudgeni-ai/opengeni/blob/main/compute/docs/adr/0016-observability.md

use std::sync::Arc;

use tokio::sync::{mpsc, oneshot};

use export::Message;

pub mod canary;
mod event;
mod export;
mod metrics;
pub(crate) mod notes;
mod otlp;
pub(crate) mod served;
mod trace;

pub use event::{Event, Severity, Value, unix_nanos_now};
pub use export::ExportConfig;
pub use metrics::{
    Alarm, CanaryOutcome, CanaryPath, Cause, DropReason, Gauges, Metrics, RequestKind, Signal,
    level_index, level_name, outcome_name, result_name,
};
pub use trace::TraceContext;

/// How a host reports.
#[derive(Clone, Debug)]
pub struct ObserveConfig {
    /// Where to send events and metrics; `None` keeps them on the host.
    pub export: Option<ExportConfig>,
    /// Resource attributes describing the host and agent, such as
    /// `service.name` and `host.name`.
    pub resource: Vec<(String, String)>,
    /// The agent's build, as the instrumentation scope's version.
    pub version: String,
    /// Whether every event is also written to the agent's log, one JSON
    /// line each, which the journal keeps under systemd.
    pub journal: bool,
    /// Events waiting for the exporter task at most.
    pub queue: usize,
    /// Also delivers every event here, dropping those it has no room for:
    /// for tests and in-process consumers.
    pub tap: Option<mpsc::Sender<Event>>,
}

impl Default for ObserveConfig {
    fn default() -> Self {
        Self {
            export: None,
            resource: vec![("service.name".into(), "compute-host".into())],
            version: String::new(),
            journal: true,
            queue: 1024,
            tap: None,
        }
    }
}

/// Takes the host's events and metrics. Cheap to clone.
///
/// The default observer keeps metrics and drops events: for tools and
/// tests that do not watch them.
#[derive(Clone, Debug, Default)]
pub struct Observer {
    metrics: Arc<Metrics>,
    events: Option<mpsc::Sender<Message>>,
}

impl Observer {
    /// Starts the task that journals and exports events, which ends once
    /// every clone of the observer is dropped, after sending what is left.
    /// Must be called within a Tokio runtime.
    #[must_use]
    pub fn start(config: ObserveConfig) -> Self {
        let metrics = Arc::new(Metrics::default());
        let (events, receiver) = mpsc::channel(config.queue.max(1));
        let sinks = export::Sinks {
            origin: otlp::Origin {
                resource: config.resource,
                version: config.version,
                started_unix_nanos: unix_nanos_now(),
                booted_unix_nanos: booted_unix_nanos(),
            },
            export: config.export,
            journal: config.journal,
            tap: config.tap,
        };
        tokio::spawn(export::run(sinks, Arc::clone(&metrics), receiver));
        Self {
            metrics,
            events: Some(events),
        }
    }

    /// Hands `event` on without waiting; if the queue is full it is
    /// dropped and counted.
    pub fn emit(&self, event: Event) {
        if let Some(events) = &self.events
            && events.try_send(Message::Event(event)).is_err()
        {
            self.metrics.dropped(Signal::Logs, DropReason::Full, 1);
        }
    }

    /// Sends every event emitted so far, and the metrics, to the collector
    /// now, each with a single attempt; returns once they went or failed.
    /// For an agent about to stop, which bounds how long it waits.
    pub async fn flush(&self) {
        let Some(events) = &self.events else { return };
        let (done, sent) = oneshot::channel();
        if events.send(Message::Flush(done)).await.is_ok() {
            let _ = sent.await;
        }
    }

    /// Counts `alarm` and emits its event, naming what it happened to.
    pub fn alarm(&self, alarm: Alarm, event: Event) {
        self.metrics.alarm(alarm);
        self.emit(event.with("compute.alarm", alarm.name()));
    }

    /// The host's metrics.
    #[must_use]
    pub fn metrics(&self) -> &Metrics {
        &self.metrics
    }
}

/// When the host booted, from `btime` in `/proc/stat`.
fn booted_unix_nanos() -> Option<u64> {
    let stat = std::fs::read_to_string("/proc/stat").ok()?;
    let seconds: u64 = stat
        .lines()
        .find_map(|line| line.strip_prefix("btime "))?
        .trim()
        .parse()
        .ok()?;
    seconds.checked_mul(1_000_000_000)
}

/// An alarm event: severity error, with `what` as its message.
#[must_use]
pub fn alarm_event(what: impl Into<String>) -> Event {
    Event::new("compute.alarm", Severity::Error).with("compute.message", what.into())
}

/// Raises the alarms of an object a store found bad and quarantined. The
/// object names no sandbox, since chunks are shared: its key does.
#[derive(Debug)]
pub struct StoreAlarms(pub Observer);

impl compute_storage::store::QuarantineWatch for StoreAlarms {
    fn quarantined(&self, key: &str, why: &str) {
        for alarm in [Alarm::VerificationFailed, Alarm::Quarantined] {
            let event = alarm_event(format!("stored object: {why}"))
                .with("compute.object.key", key.to_owned());
            self.0.alarm(alarm, event);
        }
    }
}
