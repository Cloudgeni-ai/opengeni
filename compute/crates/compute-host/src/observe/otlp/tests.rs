use std::time::Duration;

use serde_json::{Value as Json, json};

use super::super::metrics::{Alarm, CanaryOutcome, CanaryPath, Gauges};
use super::super::{Severity, TraceContext};
use super::*;

fn origin() -> Origin {
    Origin {
        resource: vec![
            ("service.name".into(), "compute-host".into()),
            ("host.name".into(), "lab-1".into()),
        ],
        version: "0.1.0".into(),
        started_unix_nanos: 1_000,
        booted_unix_nanos: Some(500),
    }
}

fn parse(body: &[u8]) -> Json {
    serde_json::from_slice(body).expect("the body is JSON")
}

/// The metric named `name` in a `/v1/metrics` body.
fn metric<'a>(body: &'a Json, name: &str) -> Option<&'a Json> {
    body["resourceMetrics"][0]["scopeMetrics"][0]["metrics"]
        .as_array()?
        .iter()
        .find(|metric| metric["name"] == name)
}

#[test]
fn log_records_use_the_otlp_json_mapping() {
    let trace: TraceContext = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
        .parse()
        .unwrap();
    let mut event = Event::new("compute.step", Severity::Warn)
        .with("compute.step", "wake")
        .with("compute.duration_us", 1_234_u64)
        .with("compute.warm", true)
        .traced(Some(trace));
    event.unix_nanos = 5_000_000_000_123;
    let plain = Event::new("compute.alarm", Severity::Error);
    let body = parse(&logs(&origin(), &[event, plain], 7));

    let resource = &body["resourceLogs"][0]["resource"]["attributes"];
    assert_eq!(
        resource[0],
        json!({"key": "service.name", "value": {"stringValue": "compute-host"}})
    );
    let scope = &body["resourceLogs"][0]["scopeLogs"][0];
    assert_eq!(
        scope["scope"],
        json!({"name": "compute-host", "version": "0.1.0"})
    );
    let record = &scope["logRecords"][0];
    // 64-bit integers are decimal strings; enums are numbers.
    assert_eq!(record["timeUnixNano"], "5000000000123");
    assert_eq!(record["observedTimeUnixNano"], "7");
    assert_eq!(record["severityNumber"], 13);
    assert_eq!(record["severityText"], "WARN");
    assert_eq!(record["eventName"], "compute.step");
    assert_eq!(record["traceId"], "0af7651916cd43dd8448eb211c80319c");
    assert_eq!(record["spanId"], "b7ad6b7169203331");
    assert_eq!(record["flags"], 1);
    assert_eq!(
        record["attributes"],
        json!([
            {"key": "compute.step", "value": {"stringValue": "wake"}},
            {"key": "compute.duration_us", "value": {"intValue": "1234"}},
            {"key": "compute.warm", "value": {"boolValue": true}},
        ])
    );
    let untraced = &scope["logRecords"][1];
    assert_eq!(untraced["severityNumber"], 17);
    for absent in ["traceId", "spanId", "flags"] {
        assert!(untraced.get(absent).is_none(), "{absent} is left out");
    }
}

#[test]
fn metrics_carry_sums_gauges_and_histograms() {
    let metrics = Metrics::default();
    metrics.alarm(Alarm::CopyLost);
    metrics.canary(
        CanaryPath::Resume,
        CanaryOutcome::Ok,
        Duration::from_millis(30),
        1_700_000_000_000,
    );
    metrics.set_gauges(&Gauges {
        sampled_unix_ms: 9_000,
        available: Some(4096),
        pressure: [[Some(10), Some(4)], [None, None], [Some(1), None]],
        ..Gauges::default()
    });
    let process = Process {
        cpu: [1.5, 0.25],
        memory: 3 << 20,
    };
    let (body, points) = super::metrics(&origin(), &metrics, Some(process), 10_000_000_000);
    let body = parse(&body);
    let all: usize = body["resourceMetrics"][0]["scopeMetrics"][0]["metrics"]
        .as_array()
        .unwrap()
        .iter()
        .map(|metric| {
            ["sum", "gauge", "histogram"]
                .iter()
                .filter_map(|kind| metric[kind]["dataPoints"].as_array())
                .map(Vec::len)
                .sum::<usize>()
        })
        .sum();
    assert_eq!(points, all, "the point count is what the body holds");

    let alarms = metric(&body, "compute.alarm.count").unwrap();
    assert_eq!(alarms["unit"], "{occurrence}");
    let sum = &alarms["sum"];
    assert_eq!(sum["aggregationTemporality"], 2);
    assert_eq!(sum["isMonotonic"], true);
    let points = sum["dataPoints"].as_array().unwrap();
    assert_eq!(points.len(), Alarm::ALL.len(), "every alarm, zero included");
    let lost = points
        .iter()
        .find(|point| point["attributes"][0]["value"]["stringValue"] == "copy_lost")
        .unwrap();
    assert_eq!(lost["asInt"], "1");
    assert_eq!(lost["startTimeUnixNano"], "1000");
    assert_eq!(lost["timeUnixNano"], "10000000000");

    let available = &metric(&body, "compute.host.memory.available").unwrap()["gauge"];
    assert_eq!(available["dataPoints"][0]["asInt"], "4096");
    assert!(
        available["dataPoints"][0]
            .get("startTimeUnixNano")
            .is_none()
    );
    assert!(
        metric(&body, "compute.host.zswap.stored").is_none(),
        "absent readings are left out, never zero"
    );
    let stall = metric(&body, "compute.host.pressure.stall").unwrap()["sum"]["dataPoints"]
        .as_array()
        .unwrap();
    assert_eq!(stall.len(), 3, "only the totals read");
    assert_eq!(
        stall[0]["startTimeUnixNano"], "500",
        "the kernel counts from the host's boot"
    );

    let age = &metric(&body, "compute.sample.age").unwrap()["gauge"]["dataPoints"][0];
    assert_eq!(age["asDouble"], 1.0, "sampled at 9 s, exported at 10 s");

    let canary = &metric(&body, "compute.canary.duration").unwrap()["histogram"];
    assert_eq!(canary["aggregationTemporality"], 2);
    let point = &canary["dataPoints"][0];
    assert_eq!(point["count"], "1");
    assert_eq!(
        point["bucketCounts"].as_array().unwrap().len(),
        point["explicitBounds"].as_array().unwrap().len() + 1
    );
    assert!(
        metric(&body, "compute.canary.count").unwrap()["sum"]["dataPoints"]
            .as_array()
            .unwrap()
            .iter()
            .all(|point| point["attributes"][0]["value"]["stringValue"] == "resume"),
        "paths never run are left out"
    );

    let cpu = &metric(&body, "process.cpu.time").unwrap()["sum"]["dataPoints"];
    assert_eq!(cpu[0]["asDouble"], 1.5);
    assert_eq!(cpu[1]["attributes"][0]["value"]["stringValue"], "system");
    let memory = &metric(&body, "process.memory.usage").unwrap()["gauge"];
    assert_eq!(memory["dataPoints"][0]["asInt"], (3 << 20).to_string());
}

#[test]
fn every_metric_has_a_unit_and_description() {
    let metrics = Metrics::default();
    metrics.set_gauges(&Gauges {
        sampled_unix_ms: 1,
        available: Some(1),
        zswap_stored: Some(1),
        zswap_original: Some(1),
        huge_pages_free: Some(1),
        pressure: [[Some(1); 2]; 3],
        transfers_foreground: Some(1),
        transfers_background: Some(1),
        ..Gauges::default()
    });
    metrics.canary(CanaryPath::Create, CanaryOutcome::Failed, Duration::ZERO, 1);
    let (body, _) = super::metrics(&origin(), &metrics, Some(Process::default()), 2_000_000);
    let body = parse(&body);
    for metric in body["resourceMetrics"][0]["scopeMetrics"][0]["metrics"]
        .as_array()
        .unwrap()
    {
        assert_ne!(metric["description"], "", "{} is described", metric["name"]);
        assert_ne!(metric["unit"], "1", "{} has a unit", metric["name"]);
    }
}

#[test]
fn partial_success_counts_what_was_rejected() {
    assert_eq!(rejected(b""), Ok((0, None)));
    assert_eq!(rejected(b"{}"), Ok((0, None)));
    assert_eq!(rejected(br#"{"partialSuccess":{}}"#), Ok((0, None)));
    assert_eq!(
        rejected(br#"{"partialSuccess":{"rejectedLogRecords":"3","errorMessage":"too big"}}"#),
        Ok((3, Some("too big".into())))
    );
    assert_eq!(
        rejected(br#"{"partialSuccess":{"rejectedDataPoints":2,"errorMessage":""}}"#),
        Ok((2, None))
    );
    // Not a response the collector meant: what it accepted is unknown.
    assert!(rejected(b"not json").is_err());
    assert!(rejected(br#"{"partialSuccess":{"rejectedLogRec"#).is_err());
    assert!(rejected(b"[]").is_err());
    assert!(rejected(br#"{"partialSuccess":{"rejectedLogRecords":"many"}}"#).is_err());
}
