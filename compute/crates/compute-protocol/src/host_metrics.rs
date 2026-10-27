//! The metrics a host sends the control service
//! ([`crate::fleet::METRICS_PATH`]), named once for both ends: each
//! metric's name, kind, unit, description and labels, and each label's
//! values. The host exports exactly these. The service passes on only data
//! points that keep to them, under the sending host's own name, so a host
//! speaks only for itself and cannot add series beyond what is listed here.
//! [`check`] is that test: it rebuilds an export from what keeps to this
//! list, and nothing else of what the host sent goes on.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// How a metric aggregates, as OTLP names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// A cumulative, monotonic count.
    Sum,
    /// A reading.
    Gauge,
    /// A cumulative histogram over [`BOUNDS`].
    Histogram,
}

/// A label and every value it takes.
#[derive(Clone, Copy, Debug)]
pub struct Label {
    /// Its name, an OTLP attribute key.
    pub name: &'static str,
    /// Its values.
    pub values: &'static [&'static str],
}

/// One metric.
#[derive(Clone, Copy, Debug)]
pub struct Metric {
    /// Its OTLP name.
    pub name: &'static str,
    /// How it aggregates.
    pub kind: Kind,
    /// Its unit, in UCUM as OTLP writes it.
    pub unit: &'static str,
    /// What it measures.
    pub description: &'static str,
    /// Its labels: every data point carries each of them and no other.
    pub labels: &'static [Label],
}

/// Every duration histogram's bucket bounds, in seconds.
pub const BOUNDS: [f64; 16] = [
    0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 300.0,
];

/// Steps, as [`crate::host::step_name`] names them, in
/// [`compute_core::Step::ALL`] order.
pub const STEPS: [&str; 12] = [
    "resume",
    "restore",
    "boot",
    "fetch",
    "pause",
    "drop",
    "compress",
    "save",
    "archive",
    "checkpoint",
    "evict",
    "forget",
];
/// Why a step started.
pub const CAUSES: [&str; 5] = ["request", "idle", "pressure", "recovery", "schedule"];
/// How a step ended.
pub const STEP_OUTCOMES: [&str; 8] = [
    "done",
    "cancelled",
    "transient",
    "untrusted",
    "remote_untrusted",
    "memory_lost",
    "unsavable",
    "fatal",
];
/// How a step ended, in classes: what step durations are kept by.
pub const OUTCOME_CLASSES: [&str; 3] = ["done", "cancelled", "failed"];
/// The kinds of request the host answers.
pub const REQUESTS: [&str; 14] = [
    "create", "remove", "touch", "wake", "connect", "sleep", "hold", "release", "status", "adopt",
    "hand_off", "prepare", "capture", "invalid",
];
/// What a request's answer was: `ok`, or its error code.
pub const RESULTS: [&str; 14] = [
    "ok",
    "invalid",
    "not_found",
    "exists",
    "busy",
    "broken",
    "blocked",
    "removed",
    "stale",
    "unreachable",
    "host_full",
    "unavailable",
    "expired",
    "internal",
];
/// Which way a stream's bytes went.
pub const DIRECTIONS: [&str; 2] = ["to_guest", "to_client"];
/// Things that must never happen.
pub const ALARMS: [&str; 6] = [
    "only_copy_kept",
    "verification_failed",
    "quarantined",
    "copy_lost",
    "broken",
    "programs_lost",
];
/// The paths the canary runs.
pub const CANARY_PATHS: [&str; 4] = ["resume", "restore", "remote", "create"];
/// How a canary run ended.
pub const CANARY_OUTCOMES: [&str; 3] = ["ok", "failed", "timed_out"];
/// What the exporter sends.
pub const SIGNALS: [&str; 2] = ["logs", "metrics"];
/// Why the exporter dropped records or data points.
pub const DROP_REASONS: [&str; 3] = ["buffer_full", "rejected", "failed"];
/// A sandbox's levels, as events and metrics name them.
pub const LEVELS: [&str; 6] = [
    "running",
    "paused",
    "compressed",
    "saved",
    "archived",
    "remote",
];
/// What is wrong with an unhealthy sandbox.
pub const HEALTH: [&str; 3] = ["broken", "blocked", "unsavable"];
/// The resources the kernel reports pressure stalls for.
pub const PRESSURE_RESOURCES: [&str; 3] = ["memory", "io", "cpu"];
/// Whether some or all tasks stalled.
pub const PRESSURES: [&str; 2] = ["some", "full"];
/// The agent's processor time, by mode.
pub const CPU_MODES: [&str; 2] = ["user", "system"];

const STEP: Label = Label {
    name: "compute.step",
    values: &STEPS,
};
const CANARY_PATH: Label = Label {
    name: "compute.canary.path",
    values: &CANARY_PATHS,
};
const LEVEL: Label = Label {
    name: "compute.level",
    values: &LEVELS,
};

const fn sum(name: &'static str, unit: &'static str, description: &'static str) -> Metric {
    Metric {
        name,
        kind: Kind::Sum,
        unit,
        description,
        labels: &[],
    }
}

const fn gauge(name: &'static str, unit: &'static str, description: &'static str) -> Metric {
    Metric {
        name,
        kind: Kind::Gauge,
        unit,
        description,
        labels: &[],
    }
}

const fn histogram(name: &'static str, description: &'static str) -> Metric {
    Metric {
        name,
        kind: Kind::Histogram,
        unit: "s",
        description,
        labels: &[],
    }
}

const fn by(metric: Metric, labels: &'static [Label]) -> Metric {
    Metric { labels, ..metric }
}

/// Every metric a host exports: its own, and its process's as
/// OpenTelemetry's semantic conventions name them.
pub const METRICS: [Metric; 29] = [
    by(
        sum(
            "compute.step.count",
            "{step}",
            "Steps finished, by kind, cause and outcome.",
        ),
        &[
            STEP,
            Label {
                name: "compute.cause",
                values: &CAUSES,
            },
            Label {
                name: "compute.outcome",
                values: &STEP_OUTCOMES,
            },
        ],
    ),
    by(
        histogram("compute.step.duration", "How long finished steps took."),
        &[
            STEP,
            Label {
                name: "compute.outcome",
                values: &OUTCOME_CLASSES,
            },
        ],
    ),
    by(
        gauge("compute.step.in_flight", "{step}", "Steps running now."),
        &[STEP],
    ),
    by(
        gauge(
            "compute.step.oldest_age",
            "s",
            "How long the oldest unfinished step has run.",
        ),
        &[STEP],
    ),
    by(
        sum(
            "compute.request.count",
            "{request}",
            "Requests answered, by kind and result.",
        ),
        &[
            Label {
                name: "compute.request",
                values: &REQUESTS,
            },
            Label {
                name: "compute.result",
                values: &RESULTS,
            },
        ],
    ),
    by(
        histogram(
            "compute.request.duration",
            "Time from a request to its reply.",
        ),
        &[Label {
            name: "compute.request",
            values: &REQUESTS,
        }],
    ),
    sum(
        "compute.stream.opened",
        "{stream}",
        "Streams into sandboxes established.",
    ),
    sum(
        "compute.stream.closed",
        "{stream}",
        "Streams into sandboxes closed.",
    ),
    gauge(
        "compute.stream.open",
        "{stream}",
        "Streams into sandboxes open now.",
    ),
    by(
        sum("compute.stream.bytes", "By", "Bytes streams carried."),
        &[Label {
            name: "compute.direction",
            values: &DIRECTIONS,
        }],
    ),
    by(
        sum(
            "compute.alarm.count",
            "{occurrence}",
            "Things that must never happen.",
        ),
        &[Label {
            name: "compute.alarm",
            values: &ALARMS,
        }],
    ),
    by(
        sum(
            "compute.canary.count",
            "{run}",
            "Canary runs, by path and outcome.",
        ),
        &[
            CANARY_PATH,
            Label {
                name: "compute.outcome",
                values: &CANARY_OUTCOMES,
            },
        ],
    ),
    by(
        histogram("compute.canary.duration", "How long canary runs took."),
        &[CANARY_PATH],
    ),
    by(
        gauge(
            "compute.canary.last_run",
            "s",
            "When each canary path last ran, in Unix time.",
        ),
        &[CANARY_PATH],
    ),
    by(
        sum(
            "compute.export.dropped",
            "{record}",
            "Records and data points never exported.",
        ),
        &[
            Label {
                name: "compute.signal",
                values: &SIGNALS,
            },
            Label {
                name: "compute.reason",
                values: &DROP_REASONS,
            },
        ],
    ),
    gauge(
        "compute.sample.time",
        "s",
        "When the agent last sampled, in Unix time.",
    ),
    gauge(
        "compute.sample.age",
        "s",
        "Time since the agent last sampled.",
    ),
    by(
        gauge("compute.sandbox.count", "{sandbox}", "Sandboxes per level."),
        &[LEVEL],
    ),
    by(
        gauge(
            "compute.sandbox.memory",
            "By",
            "Host memory sandboxes hold, per level.",
        ),
        &[LEVEL],
    ),
    by(
        gauge(
            "compute.sandbox.unhealthy",
            "{sandbox}",
            "Sandboxes broken, blocked or unsavable.",
        ),
        &[Label {
            name: "compute.health",
            values: &HEALTH,
        }],
    ),
    gauge(
        "compute.host.memory.available",
        "By",
        "Host memory available for guests.",
    ),
    gauge(
        "compute.host.zswap.stored",
        "By",
        "Compressed bytes zswap holds.",
    ),
    gauge(
        "compute.host.zswap.original",
        "By",
        "Memory zswap holds, before compression.",
    ),
    gauge(
        "compute.host.hugepages.free",
        "{page}",
        "Free pages in the huge-page pool.",
    ),
    by(
        sum(
            "compute.host.pressure.stall",
            "us",
            "Host pressure stall time.",
        ),
        &[
            Label {
                name: "compute.resource",
                values: &PRESSURE_RESOURCES,
            },
            Label {
                name: "compute.pressure",
                values: &PRESSURES,
            },
        ],
    ),
    gauge(
        "compute.transfer.foreground",
        "{transfer}",
        "Object-storage transfers wakes wait on.",
    ),
    gauge(
        "compute.transfer.background",
        "{transfer}",
        "Background object-storage transfers.",
    ),
    by(
        sum("process.cpu.time", "s", "Processor time the agent used."),
        &[Label {
            name: "cpu.mode",
            values: &CPU_MODES,
        }],
    ),
    gauge("process.memory.usage", "By", "The agent's resident memory."),
];

/// The metric named `name`, if a host exports it.
#[must_use]
pub fn metric(name: &str) -> Option<&'static Metric> {
    METRICS.iter().find(|metric| metric.name == name)
}

/// The only resource attributes the control service passes on with a
/// host's metrics, all of which it sets itself: the service
/// (`service.name`) and the host's name as its certificate proved it
/// (`service.instance.id`, `host.name`). Whatever else a host says about
/// itself is left out, so a host cannot add series by varying it; what
/// the fleet registered about a host, such as its memory profile, is on
/// the control service's own `compute_fleet_host_info`.
pub const RESOURCE: [&str; 3] = ["service.name", "service.instance.id", "host.name"];

/// The instrumentation scope a host's metrics come under, and its
/// `service.name`.
pub const SERVICE: &str = "compute-host";

/// What [`check`] kept of an export.
#[derive(Debug)]
pub struct Checked {
    /// The export to pass on, an OTLP/HTTP metrics export in JSON: the
    /// data points that keep to [`METRICS`], under the host's own name.
    pub export: Vec<u8>,
    /// How many data points it kept.
    pub kept: u64,
    /// How many it left out.
    pub rejected: u64,
    /// Why the first one left out was.
    pub problem: Option<String>,
}

/// Why [`check`] refused an export whole.
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// It is not an OTLP metrics export in JSON, or does not say which
    /// host it is from.
    Malformed(String),
    /// It is from a host the sender is not.
    OtherHost(String),
}

/// Checks `export`, an OTLP/HTTP metrics export in JSON from a host that
/// proved it is one of `names`. Every resource must name that host in
/// `host.name`, or leave it out when there is only one. What keeps to
/// [`METRICS`] is rebuilt under the host's name, with the service's own
/// name and scope and only the [`RESOURCE`] attributes, so the series a
/// host's metrics make depend on nothing but its name and what keeps to
/// the list.
///
/// # Errors
///
/// [`Refused`] when the export is not one, or speaks for another host.
pub fn check(export: &[u8], names: &[String]) -> Result<Checked, Refused> {
    let export: In = serde_json::from_slice(export).map_err(|error| {
        Refused::Malformed(format!("not an OTLP metrics export in JSON: {error}"))
    })?;
    let mut checked = Checking::default();
    let mut resources = Vec::with_capacity(export.resource_metrics.len());
    for resource in export.resource_metrics {
        let host = host_of(&resource.resource.attributes, names)?;
        let attributes = vec![
            text("service.name", SERVICE),
            text("service.instance.id", &host),
            text("host.name", &host),
        ];
        let metrics = resource
            .scope_metrics
            .into_iter()
            .flat_map(|scope| scope.metrics)
            .filter_map(|metric| checked.metric(metric))
            .collect::<Vec<_>>();
        resources.push(OutResource {
            resource: OutAttributes { attributes },
            scope_metrics: vec![OutScope {
                scope: OutScopeName { name: SERVICE },
                metrics,
            }],
        });
    }
    let export = serde_json::to_vec(&Out {
        resource_metrics: resources,
    })
    .unwrap_or_default();
    Ok(Checked {
        export,
        kept: checked.kept,
        rejected: checked.rejected,
        problem: checked.problem,
    })
}

/// The host a resource is from.
fn host_of(attributes: &[KeyValue], names: &[String]) -> Result<String, Refused> {
    let claimed = attributes
        .iter()
        .find(|attribute| attribute.key == "host.name")
        .map(|attribute| attribute.value.string_value.as_deref().unwrap_or_default());
    match (claimed, names) {
        (Some(host), _) if names.iter().any(|name| name == host) => Ok(host.to_owned()),
        (Some(host), _) => Err(Refused::OtherHost(format!(
            "the certificate does not name {host}"
        ))),
        (None, [only]) => Ok(only.clone()),
        (None, _) => Err(Refused::Malformed(
            "every resource names its host in host.name".to_owned(),
        )),
    }
}

/// What is kept and left out so far.
#[derive(Default)]
struct Checking {
    kept: u64,
    rejected: u64,
    problem: Option<String>,
}

impl Checking {
    fn reject(&mut self, points: usize, problem: impl FnOnce() -> String) {
        if points == 0 {
            return;
        }
        self.rejected += points as u64;
        if self.problem.is_none() {
            self.problem = Some(problem());
        }
    }

    /// The part of `metric` that keeps to its listing, if any does.
    fn metric(&mut self, metric: InMetric) -> Option<OutMetric> {
        let points = metric.points();
        let Some(listed) = self::metric(&metric.name) else {
            self.reject(points, || format!("hosts do not export {}", metric.name));
            return None;
        };
        let data = match (listed.kind, metric.sum, metric.gauge, metric.histogram) {
            (Kind::Sum, Some(sum), None, None)
                if sum.aggregation_temporality == CUMULATIVE && sum.is_monotonic =>
            {
                let data_points = self.numbers(listed, sum.data_points, true);
                (!data_points.is_empty()).then_some(OutData::Sum {
                    data_points,
                    aggregation_temporality: CUMULATIVE,
                    is_monotonic: true,
                })
            }
            (Kind::Gauge, None, Some(gauge), None) => {
                let data_points = self.numbers(listed, gauge.data_points, false);
                (!data_points.is_empty()).then_some(OutData::Gauge { data_points })
            }
            (Kind::Histogram, None, None, Some(histogram))
                if histogram.aggregation_temporality == CUMULATIVE =>
            {
                let data_points = self.histograms(listed, histogram.data_points);
                (!data_points.is_empty()).then_some(OutData::Histogram {
                    data_points,
                    aggregation_temporality: CUMULATIVE,
                })
            }
            _ => {
                self.reject(points, || {
                    format!("{} is not a cumulative {:?}", listed.name, listed.kind)
                });
                None
            }
        }?;
        Some(OutMetric {
            name: listed.name,
            unit: listed.unit,
            description: listed.description,
            data,
        })
    }

    fn numbers(&mut self, listed: &Metric, points: Vec<InNumber>, count: bool) -> Vec<OutNumber> {
        let mut kept = Vec::with_capacity(points.len());
        for point in points {
            let value = match (point.as_int, point.as_double) {
                (Some(Int(whole)), None) if !count || whole >= 0 => {
                    Some(OutValue::AsInt(Int(whole)))
                }
                (None, Some(real)) if real.is_finite() && (!count || real >= 0.0) => {
                    Some(OutValue::AsDouble(real))
                }
                _ => None,
            };
            let Some(value) = value else {
                self.reject(1, || {
                    format!("a {} data point has no plain value", listed.name)
                });
                continue;
            };
            let Some(attributes) = self.labels(listed, &point.attributes) else {
                continue;
            };
            self.kept += 1;
            kept.push(OutNumber {
                attributes,
                start_time_unix_nano: point.start_time_unix_nano,
                time_unix_nano: point.time_unix_nano,
                value,
            });
        }
        kept
    }

    fn histograms(&mut self, listed: &Metric, points: Vec<InHistogram>) -> Vec<OutHistogram> {
        let mut kept = Vec::with_capacity(points.len());
        for point in points {
            let counted = point
                .bucket_counts
                .iter()
                .try_fold(0u64, |total, Int(count)| {
                    u64::try_from(*count)
                        .ok()
                        .and_then(|count| total.checked_add(count))
                });
            let shaped = point.explicit_bounds == BOUNDS
                && point.bucket_counts.len() == BOUNDS.len() + 1
                && counted.is_some()
                && u64::try_from(point.count.0).ok() == counted
                && point.sum.is_none_or(|sum| sum.is_finite() && sum >= 0.0);
            if !shaped {
                self.reject(1, || {
                    format!(
                        "a {} data point is not a histogram over the duration bounds",
                        listed.name
                    )
                });
                continue;
            }
            let Some(attributes) = self.labels(listed, &point.attributes) else {
                continue;
            };
            self.kept += 1;
            kept.push(OutHistogram {
                attributes,
                start_time_unix_nano: point.start_time_unix_nano,
                time_unix_nano: point.time_unix_nano,
                count: point.count,
                sum: point.sum,
                bucket_counts: point.bucket_counts,
                explicit_bounds: &BOUNDS,
            });
        }
        kept
    }

    /// A data point's labels, when they are exactly the metric's, each
    /// with one of its values.
    fn labels(&mut self, listed: &Metric, attributes: &[KeyValue]) -> Option<Vec<KeyValue>> {
        let mut kept = Vec::with_capacity(listed.labels.len());
        for label in listed.labels {
            let mut values = attributes
                .iter()
                .filter(|attribute| attribute.key == label.name);
            let value = match (values.next(), values.next()) {
                (Some(attribute), None) => attribute.value.string_value.as_deref(),
                _ => None,
            };
            match value {
                Some(value) if label.values.contains(&value) => kept.push(text(label.name, value)),
                _ => {
                    self.reject(1, || {
                        format!(
                            "a {} data point's {} is not one of its values",
                            listed.name, label.name
                        )
                    });
                    return None;
                }
            }
        }
        if attributes.len() != listed.labels.len() {
            self.reject(1, || {
                format!(
                    "a {} data point has labels beyond {:?}",
                    listed.name,
                    label_names(listed)
                )
            });
            return None;
        }
        Some(kept)
    }
}

fn label_names(metric: &Metric) -> Vec<&'static str> {
    metric.labels.iter().map(|label| label.name).collect()
}

/// Cumulative aggregation, OTLP's `AGGREGATION_TEMPORALITY_CUMULATIVE`,
/// the only temporality hosts send.
pub const CUMULATIVE: u8 = 2;

/// A 64-bit integer, which OTLP's JSON mapping writes as a decimal string
/// and decoders also accept as a number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Int(i64);

impl<'de> Deserialize<'de> for Int {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Either {
            Text(String),
            Number(i64),
        }
        match Either::deserialize(deserializer)? {
            Either::Number(number) => Ok(Self(number)),
            Either::Text(text) => text.parse().map(Self).map_err(serde::de::Error::custom),
        }
    }
}

impl Serialize for Int {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&self.0)
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnyValue {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    string_value: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct KeyValue {
    key: String,
    #[serde(default)]
    value: AnyValue,
}

fn text(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.to_owned(),
        value: AnyValue {
            string_value: Some(value.to_owned()),
        },
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct In {
    resource_metrics: Vec<InResource>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InResource {
    #[serde(default)]
    resource: InAttributes,
    #[serde(default)]
    scope_metrics: Vec<InScope>,
}

#[derive(Default, Deserialize)]
struct InAttributes {
    #[serde(default)]
    attributes: Vec<KeyValue>,
}

#[derive(Deserialize)]
struct InScope {
    #[serde(default)]
    metrics: Vec<InMetric>,
}

#[derive(Deserialize)]
struct InMetric {
    name: String,
    sum: Option<InSum>,
    gauge: Option<InGauge>,
    histogram: Option<InHistograms>,
}

impl InMetric {
    /// How many data points it holds, of whatever kinds.
    fn points(&self) -> usize {
        self.sum.as_ref().map_or(0, |sum| sum.data_points.len())
            + self
                .gauge
                .as_ref()
                .map_or(0, |gauge| gauge.data_points.len())
            + self
                .histogram
                .as_ref()
                .map_or(0, |histogram| histogram.data_points.len())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InSum {
    #[serde(default)]
    data_points: Vec<InNumber>,
    #[serde(default)]
    aggregation_temporality: u8,
    #[serde(default)]
    is_monotonic: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InGauge {
    #[serde(default)]
    data_points: Vec<InNumber>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InHistograms {
    #[serde(default)]
    data_points: Vec<InHistogram>,
    #[serde(default)]
    aggregation_temporality: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InNumber {
    #[serde(default)]
    attributes: Vec<KeyValue>,
    start_time_unix_nano: Option<Int>,
    time_unix_nano: Int,
    as_int: Option<Int>,
    as_double: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InHistogram {
    #[serde(default)]
    attributes: Vec<KeyValue>,
    start_time_unix_nano: Option<Int>,
    time_unix_nano: Int,
    count: Int,
    sum: Option<f64>,
    #[serde(default)]
    bucket_counts: Vec<Int>,
    #[serde(default)]
    explicit_bounds: Vec<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Out {
    resource_metrics: Vec<OutResource>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutResource {
    resource: OutAttributes,
    scope_metrics: Vec<OutScope>,
}

#[derive(Serialize)]
struct OutAttributes {
    attributes: Vec<KeyValue>,
}

#[derive(Serialize)]
struct OutScope {
    scope: OutScopeName,
    metrics: Vec<OutMetric>,
}

#[derive(Serialize)]
struct OutScopeName {
    name: &'static str,
}

#[derive(Serialize)]
struct OutMetric {
    name: &'static str,
    unit: &'static str,
    description: &'static str,
    #[serde(flatten)]
    data: OutData,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum OutData {
    #[serde(rename_all = "camelCase")]
    Sum {
        data_points: Vec<OutNumber>,
        aggregation_temporality: u8,
        is_monotonic: bool,
    },
    #[serde(rename_all = "camelCase")]
    Gauge { data_points: Vec<OutNumber> },
    #[serde(rename_all = "camelCase")]
    Histogram {
        data_points: Vec<OutHistogram>,
        aggregation_temporality: u8,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum OutValue {
    AsInt(Int),
    AsDouble(f64),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutNumber {
    attributes: Vec<KeyValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_time_unix_nano: Option<Int>,
    time_unix_nano: Int,
    #[serde(flatten)]
    value: OutValue,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutHistogram {
    attributes: Vec<KeyValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_time_unix_nano: Option<Int>,
    time_unix_nano: Int,
    count: Int,
    #[serde(skip_serializing_if = "Option::is_none")]
    sum: Option<f64>,
    bucket_counts: Vec<Int>,
    explicit_bounds: &'static [f64],
}

#[cfg(test)]
mod tests;
