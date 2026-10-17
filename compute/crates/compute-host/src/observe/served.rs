//! One API request or stream, as its event and metrics tell it.

use std::time::Duration;

use tokio::time::Instant;

use super::{Event, Observer, RequestKind, Severity, TraceContext, result_name};
use crate::agent::Lease;
use crate::protocol::{ErrorCode, Id, Reply, Request, step_name};

/// What kind of request `request` is.
pub(crate) fn kind(request: &Request) -> RequestKind {
    match request {
        Request::Create { .. } => RequestKind::Create,
        Request::Remove { .. } => RequestKind::Remove,
        Request::Touch { .. } => RequestKind::Touch,
        Request::Wake { .. } => RequestKind::Wake,
        Request::Connect { .. } => RequestKind::Connect,
        Request::Sleep { .. } => RequestKind::Sleep,
        Request::Hold { .. } => RequestKind::Hold,
        Request::Release { .. } => RequestKind::Release,
        Request::Status => RequestKind::Status,
    }
}

/// The sandbox `request` is about, and the generation it names.
fn about(request: &Request) -> (Option<Id>, Option<u64>) {
    match request {
        Request::Create { id, .. } => (Some(*id), None),
        Request::Remove { id, generation }
        | Request::Touch { id, generation, .. }
        | Request::Wake { id, generation, .. }
        | Request::Connect { id, generation, .. }
        | Request::Sleep { id, generation, .. }
        | Request::Hold { id, generation, .. }
        | Request::Release { id, generation, .. } => (Some(*id), *generation),
        Request::Status => (None, None),
    }
}

/// A request being served: counted when it is answered, with an event
/// unless it changed nothing.
pub(crate) struct Served {
    observer: Observer,
    kind: RequestKind,
    started: Instant,
    sandbox: Option<Id>,
    trace: Option<TraceContext>,
    event: Event,
    /// Whether it changed nothing, such as a hold renewed or a status
    /// read: then it is only counted.
    counted_only: bool,
}

impl Served {
    /// A request that arrived at `started`.
    pub fn new(
        observer: &Observer,
        request: &Request,
        trace: Option<TraceContext>,
        started: Instant,
    ) -> Self {
        let kind = kind(request);
        let (sandbox, generation) = about(request);
        let mut event = Event::new("compute.request", Severity::Info)
            .with("compute.request", kind.name())
            .with_some("compute.sandbox.id", sandbox.map(|id| id.to_string()))
            .with_some("compute.generation.asked", generation)
            .traced(trace);
        if let Request::Connect { port, .. } = request {
            event = event.with("compute.port", *port);
        }
        if let Request::Sleep { level, .. } = request {
            event = event.with(
                "compute.level.requested",
                format!("{level:?}").to_lowercase(),
            );
        }
        Self {
            observer: observer.clone(),
            kind,
            started,
            sandbox,
            trace,
            event,
            counted_only: matches!(kind, RequestKind::Status),
        }
    }

    /// A request that could not be read, answered with `reply`.
    pub fn invalid(observer: &Observer, started: Instant, reply: &Reply) {
        observer
            .metrics()
            .request(RequestKind::Invalid, result_of(reply).0, started.elapsed());
    }

    /// It changed nothing, so it is only counted.
    pub fn only_count(&mut self) {
        self.counted_only = true;
    }

    /// It woke the sandbox, or found it awake, as `lease` says.
    pub fn woke(&mut self, lease: &Lease) {
        self.note("compute.waited_us", lease.waited());
        self.note("compute.generation", lease.generation());
        if let Some(during) = lease.during() {
            self.note("compute.during", step_name(during));
        }
        if let Some(op) = lease.op() {
            self.note("compute.op.id", op.0);
        }
    }

    /// Adds `value` as `key` to its event.
    pub fn note(&mut self, key: &'static str, value: impl Into<super::Value>) {
        self.event.push(key, value);
    }

    /// The event of a stream it opened, to be finished when the stream
    /// closes.
    pub fn stream(&self) -> Stream {
        let mut event = Event::new("compute.stream", Severity::Info)
            .with_some("compute.sandbox.id", self.sandbox.map(|id| id.to_string()))
            .traced(self.trace);
        for key in ["compute.port", "compute.generation"] {
            if let Some(value) = self.event.get(key) {
                event = event.with(key, value.clone());
            }
        }
        self.observer.metrics().stream_opened();
        Stream {
            observer: self.observer.clone(),
            event,
            opened: Instant::now(),
        }
    }

    /// It was answered with `reply`, which the client now has.
    pub fn finish(self, reply: &Reply) {
        let took = self.started.elapsed();
        let (result, message) = result_of(reply);
        self.observer.metrics().request(self.kind, result, took);
        if self.counted_only {
            return;
        }
        let mut event = self
            .event
            .with("compute.result", result_name(result))
            .with("compute.latency_us", took)
            .with_some("compute.error", message.map(str::to_owned));
        if result.is_some() {
            event.severity = Severity::Warn;
        }
        self.observer.emit(event);
    }

    /// The client hung up before its answer: not counted, since it got
    /// none, but told.
    pub fn hung_up(self) {
        let event = self
            .event
            .with("compute.result", "hung_up")
            .with("compute.latency_us", self.started.elapsed());
        self.observer.emit(event);
    }
}

fn result_of(reply: &Reply) -> (Option<ErrorCode>, Option<&str>) {
    match reply {
        Reply::Error { message, code } => (Some(*code), Some(message)),
        _ => (None, None),
    }
}

/// A stream into a sandbox, told once when it closes.
pub(crate) struct Stream {
    observer: Observer,
    event: Event,
    opened: Instant,
}

/// How a stream ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Ended {
    /// Both sides finished.
    Finished,
    /// The sandbox slept while the stream had let it go, closing the
    /// guest's end.
    Slept,
    /// Reading or writing failed.
    Failed,
}

impl Stream {
    /// It closed as `ended` after moving `to_guest` and `to_client` bytes.
    pub fn closed(self, ended: Ended, to_guest: u64, to_client: u64, error: Option<String>) {
        self.observer.metrics().stream_closed(to_guest, to_client);
        let took: Duration = self.opened.elapsed();
        let event = self
            .event
            .with(
                "compute.stream.end",
                match ended {
                    Ended::Finished => "finished",
                    Ended::Slept => "slept",
                    Ended::Failed => "failed",
                },
            )
            .with("compute.bytes.to_guest", to_guest)
            .with("compute.bytes.to_client", to_client)
            .with("compute.duration_us", took)
            .with_some("compute.error", error);
        self.observer.emit(event);
    }
}
