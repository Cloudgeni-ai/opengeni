//! OTLP over HTTP with JSON encoding: the request bodies for
//! `/v1/logs` and `/v1/metrics`, and what their responses say.
//!
//! Field names are the protobuf names in lower camel case, 64-bit
//! integers are decimal strings, enums are numbers, and trace and span ids
//! are hex, as the OTLP specification's JSON mapping requires.

use serde::{Serialize, Serializer};

use super::event::{Event, Value};
use super::metrics::{BOUNDS, HistogramReading, Metrics, Visitor};

/// Cumulative aggregation, the only temporality sent.
const CUMULATIVE: u8 = 2;

/// A 64-bit integer as OTLP's JSON mapping writes it: a decimal string.
#[derive(Clone, Copy, Debug)]
struct Int(u64);

impl Serialize for Int {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&self.0)
    }
}

/// The same for a signed value.
#[derive(Clone, Copy, Debug)]
struct SignedInt(i64);

impl Serialize for SignedInt {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&self.0)
    }
}

#[derive(Serialize)]
enum AnyValue<'a> {
    #[serde(rename = "stringValue")]
    Text(&'a str),
    #[serde(rename = "intValue")]
    Int(SignedInt),
    #[serde(rename = "boolValue")]
    Bool(bool),
}

impl<'a> From<&'a Value> for AnyValue<'a> {
    fn from(value: &'a Value) -> Self {
        match value {
            Value::Str(text) => Self::Text(text),
            Value::Int(number) => Self::Int(SignedInt(*number)),
            Value::Bool(truth) => Self::Bool(*truth),
        }
    }
}

#[derive(Serialize)]
struct KeyValue<'a> {
    key: &'a str,
    value: AnyValue<'a>,
}

fn text<'a>(key: &'a str, value: &'a str) -> KeyValue<'a> {
    KeyValue {
        key,
        value: AnyValue::Text(value),
    }
}

/// Who is reporting: the OpenTelemetry resource and instrumentation scope.
#[derive(Clone, Debug)]
pub(crate) struct Origin {
    /// Resource attributes, semantic-convention names first.
    pub resource: Vec<(String, String)>,
    /// The instrumentation scope's version: the agent's build.
    pub version: String,
    /// When the agent started, which cumulative metrics count from, in
    /// nanoseconds since the Unix epoch.
    pub started_unix_nanos: u64,
}

#[derive(Serialize)]
struct Resource<'a> {
    attributes: Vec<KeyValue<'a>>,
}

#[derive(Serialize)]
struct Scope<'a> {
    name: &'static str,
    version: &'a str,
}

impl Origin {
    fn resource(&self) -> Resource<'_> {
        Resource {
            attributes: self
                .resource
                .iter()
                .map(|(key, value)| text(key, value))
                .collect(),
        }
    }

    fn scope(&self) -> Scope<'_> {
        Scope {
            name: "compute-host",
            version: &self.version,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogsRequest<'a> {
    resource_logs: [ResourceLogs<'a>; 1],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceLogs<'a> {
    resource: Resource<'a>,
    scope_logs: [ScopeLogs<'a>; 1],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScopeLogs<'a> {
    scope: Scope<'a>,
    log_records: Vec<LogRecord<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogRecord<'a> {
    time_unix_nano: Int,
    observed_time_unix_nano: Int,
    severity_number: u8,
    severity_text: &'static str,
    event_name: &'static str,
    body: AnyValue<'a>,
    attributes: Vec<KeyValue<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    span_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    flags: Option<u32>,
}

/// The body of a `/v1/logs` request carrying `events`, observed at
/// `observed_unix_nanos`.
pub(crate) fn logs(origin: &Origin, events: &[Event], observed_unix_nanos: u64) -> Vec<u8> {
    let records = events
        .iter()
        .map(|event| LogRecord {
            time_unix_nano: Int(event.unix_nanos),
            observed_time_unix_nano: Int(observed_unix_nanos),
            severity_number: event.severity.number(),
            severity_text: event.severity.text(),
            event_name: event.name,
            body: AnyValue::Text(event.name),
            attributes: event
                .attributes
                .iter()
                .map(|(key, value)| KeyValue {
                    key,
                    value: value.into(),
                })
                .collect(),
            trace_id: event.trace.map(|trace| trace.trace_hex()),
            span_id: event.trace.map(|trace| trace.span_hex()),
            flags: event.trace.map(|trace| u32::from(trace.flags)),
        })
        .collect();
    let request = LogsRequest {
        resource_logs: [ResourceLogs {
            resource: origin.resource(),
            scope_logs: [ScopeLogs {
                scope: origin.scope(),
                log_records: records,
            }],
        }],
    };
    // Serializing plain structs of strings and numbers cannot fail.
    serde_json::to_vec(&request).unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MetricsRequest<'a> {
    resource_metrics: [ResourceMetrics<'a>; 1],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceMetrics<'a> {
    resource: Resource<'a>,
    scope_metrics: [ScopeMetrics<'a>; 1],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScopeMetrics<'a> {
    scope: Scope<'a>,
    metrics: Vec<Metric>,
}

#[derive(Serialize)]
struct Metric {
    name: &'static str,
    unit: &'static str,
    description: &'static str,
    #[serde(flatten)]
    data: Data,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum Data {
    Sum(Sum),
    Gauge(Gauge),
    Histogram(Histogram),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Sum {
    data_points: Vec<NumberPoint>,
    aggregation_temporality: u8,
    is_monotonic: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Gauge {
    data_points: Vec<NumberPoint>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Histogram {
    data_points: Vec<HistogramPoint>,
    aggregation_temporality: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum Number {
    AsInt(Int),
    AsDouble(f64),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NumberPoint {
    attributes: Vec<Label>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_time_unix_nano: Option<Int>,
    time_unix_nano: Int,
    #[serde(flatten)]
    value: Number,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistogramPoint {
    attributes: Vec<Label>,
    start_time_unix_nano: Int,
    time_unix_nano: Int,
    count: Int,
    sum: f64,
    bucket_counts: Vec<Int>,
    explicit_bounds: &'static [f64],
}

/// A label: an attribute whose key and value are both fixed names.
struct Label(&'static str, &'static str);

impl Serialize for Label {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        text(self.0, self.1).serialize(serializer)
    }
}

fn labels(pairs: &[(&'static str, &'static str)]) -> Vec<Label> {
    pairs.iter().map(|(key, value)| Label(key, value)).collect()
}

/// A metric's unit and description, by name.
fn describe(name: &str) -> (&'static str, &'static str) {
    match name {
        "compute.step.count" => ("{step}", "Steps finished, by kind, cause and outcome."),
        "compute.step.duration" => ("s", "How long finished steps took."),
        "compute.step.in_flight" => ("{step}", "Steps running now."),
        "compute.step.oldest_age" => ("s", "How long the oldest unfinished step has run."),
        "compute.request.count" => ("{request}", "Requests answered, by kind and result."),
        "compute.request.duration" => ("s", "Time from a request to its reply."),
        "compute.stream.opened" => ("{stream}", "Streams into sandboxes established."),
        "compute.stream.closed" => ("{stream}", "Streams into sandboxes closed."),
        "compute.stream.open" => ("{stream}", "Streams into sandboxes open now."),
        "compute.stream.bytes" => ("By", "Bytes streams carried."),
        "compute.alarm.count" => ("{occurrence}", "Things that must never happen."),
        "compute.canary.count" => ("{run}", "Canary runs, by path and outcome."),
        "compute.canary.duration" => ("s", "How long canary runs took."),
        "compute.canary.last_run" => ("s", "When each canary path last ran, in Unix time."),
        "compute.export.dropped" => ("{record}", "Records and data points never exported."),
        "compute.sample.time" => ("s", "When the agent last sampled, in Unix time."),
        "compute.sample.age" => ("s", "Time since the agent last sampled."),
        "compute.sandbox.count" => ("{sandbox}", "Sandboxes per level."),
        "compute.sandbox.memory" => ("By", "Host memory sandboxes hold, per level."),
        "compute.sandbox.unhealthy" => ("{sandbox}", "Sandboxes broken, blocked or unsavable."),
        "compute.host.memory.available" => ("By", "Host memory available for guests."),
        "compute.host.zswap.stored" => ("By", "Compressed bytes zswap holds."),
        "compute.host.zswap.original" => ("By", "Memory zswap holds, before compression."),
        "compute.host.hugepages.free" => ("{page}", "Free pages in the huge-page pool."),
        "compute.host.pressure.stall" => ("us", "Host pressure stall time."),
        "compute.transfer.foreground" => ("{transfer}", "Object-storage transfers wakes wait on."),
        "compute.transfer.background" => ("{transfer}", "Background object-storage transfers."),
        "process.cpu.time" => ("s", "Processor time the agent used."),
        "process.memory.usage" => ("By", "The agent's resident memory."),
        _ => ("1", ""),
    }
}

/// Collects data points into metrics, one metric per name, in the order
/// names first appear.
struct Collect {
    now: u64,
    start: u64,
    metrics: Vec<Metric>,
    points: usize,
}

impl Collect {
    fn metric(&mut self, name: &'static str, empty: impl FnOnce() -> Data) -> &mut Data {
        let index = if let Some(index) = self.metrics.iter().position(|metric| metric.name == name)
        {
            index
        } else {
            let (unit, description) = describe(name);
            self.metrics.push(Metric {
                name,
                unit,
                description,
                data: empty(),
            });
            self.metrics.len() - 1
        };
        self.points += 1;
        &mut self.metrics[index].data
    }

    fn number(
        &mut self,
        name: &'static str,
        labels: &[(&'static str, &'static str)],
        value: Number,
    ) {
        let point = NumberPoint {
            attributes: self::labels(labels),
            start_time_unix_nano: None,
            time_unix_nano: Int(self.now),
            value,
        };
        if let Data::Gauge(gauge) = self.metric(name, || {
            Data::Gauge(Gauge {
                data_points: Vec::new(),
            })
        }) {
            gauge.data_points.push(point);
        }
    }
}

impl Visitor for Collect {
    fn sum(&mut self, name: &'static str, labels: &[(&'static str, &'static str)], value: u64) {
        let start = self.start;
        let point = NumberPoint {
            attributes: self::labels(labels),
            start_time_unix_nano: Some(Int(start)),
            time_unix_nano: Int(self.now),
            value: Number::AsInt(Int(value)),
        };
        let empty = || {
            Data::Sum(Sum {
                data_points: Vec::new(),
                aggregation_temporality: CUMULATIVE,
                is_monotonic: true,
            })
        };
        if let Data::Sum(sum) = self.metric(name, empty) {
            sum.data_points.push(point);
        }
    }

    fn gauge(&mut self, name: &'static str, labels: &[(&'static str, &'static str)], value: u64) {
        self.number(name, labels, Number::AsInt(Int(value)));
    }

    fn gauge_seconds(
        &mut self,
        name: &'static str,
        labels: &[(&'static str, &'static str)],
        value: f64,
    ) {
        self.number(name, labels, Number::AsDouble(value));
    }

    fn histogram(
        &mut self,
        name: &'static str,
        labels: &[(&'static str, &'static str)],
        reading: &HistogramReading,
    ) {
        let point = HistogramPoint {
            attributes: self::labels(labels),
            start_time_unix_nano: Int(self.start),
            time_unix_nano: Int(self.now),
            count: Int(reading.count),
            sum: reading.sum_seconds,
            bucket_counts: reading.buckets.iter().copied().map(Int).collect(),
            explicit_bounds: &BOUNDS,
        };
        let empty = || {
            Data::Histogram(Histogram {
                data_points: Vec::new(),
                aggregation_temporality: CUMULATIVE,
            })
        };
        if let Data::Histogram(histogram) = self.metric(name, empty) {
            histogram.data_points.push(point);
        }
    }
}

/// What the agent's own process uses, for `process.*` metrics.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Process {
    /// Processor time in seconds, user and system.
    pub cpu: [f64; 2],
    /// Resident memory in bytes.
    pub memory: u64,
}

/// The body of a `/v1/metrics` request with every data point of
/// `metrics` at `now_unix_nanos`, with how many data points it holds.
pub(crate) fn metrics(
    origin: &Origin,
    metrics: &Metrics,
    process: Option<Process>,
    now_unix_nanos: u64,
) -> (Vec<u8>, usize) {
    let mut collect = Collect {
        now: now_unix_nanos,
        start: origin.started_unix_nanos,
        metrics: Vec::with_capacity(32),
        points: 0,
    };
    metrics.visit(&mut collect);
    let sampled = metrics.gauges().sampled_unix_ms;
    if sampled > 0 {
        let now_ms = now_unix_nanos / 1_000_000;
        #[allow(clippy::cast_precision_loss)]
        let age = now_ms.saturating_sub(sampled) as f64 / 1e3;
        collect.gauge_seconds("compute.sample.age", &[], age);
    }
    if let Some(process) = process {
        for (state, seconds) in ["user", "system"].iter().zip(process.cpu) {
            let point = NumberPoint {
                attributes: labels(&[("cpu.mode", state)]),
                start_time_unix_nano: Some(Int(origin.started_unix_nanos)),
                time_unix_nano: Int(now_unix_nanos),
                value: Number::AsDouble(seconds),
            };
            let empty = || {
                Data::Sum(Sum {
                    data_points: Vec::new(),
                    aggregation_temporality: CUMULATIVE,
                    is_monotonic: true,
                })
            };
            if let Data::Sum(sum) = collect.metric("process.cpu.time", empty) {
                sum.data_points.push(point);
            }
        }
        collect.gauge("process.memory.usage", &[], process.memory);
    }
    let points = collect.points;
    let request = MetricsRequest {
        resource_metrics: [ResourceMetrics {
            resource: origin.resource(),
            scope_metrics: [ScopeMetrics {
                scope: origin.scope(),
                metrics: collect.metrics,
            }],
        }],
    };
    (serde_json::to_vec(&request).unwrap_or_default(), points)
}

/// How many records or data points a successful response says the
/// collector rejected: its `partialSuccess`, if any. A body that is empty
/// or not JSON (a collector may answer with nothing) rejected none.
pub(crate) fn rejected(body: &[u8]) -> (u64, Option<String>) {
    let Ok(response) = serde_json::from_slice::<serde_json::Value>(body) else {
        return (0, None);
    };
    let Some(partial) = response.get("partialSuccess") else {
        return (0, None);
    };
    let count = ["rejectedLogRecords", "rejectedDataPoints"]
        .iter()
        .find_map(|key| partial.get(*key))
        .and_then(|value| match value {
            serde_json::Value::String(text) => text.parse().ok(),
            other => other.as_u64(),
        })
        .unwrap_or(0);
    let message = partial
        .get("errorMessage")
        .and_then(serde_json::Value::as_str)
        .filter(|message| !message.is_empty())
        .map(str::to_owned);
    (count, message)
}

#[cfg(test)]
mod tests;
