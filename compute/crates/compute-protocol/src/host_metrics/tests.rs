use super::*;
use compute_core::Step;
use serde_json::{Value as Json, json};

#[test]
fn steps_are_named_as_the_wire_names_them() {
    let named: Vec<&str> = Step::ALL
        .iter()
        .map(|step| crate::host::step_name(*step))
        .collect();
    assert_eq!(named, STEPS);
}

#[test]
fn every_metric_is_named_once_and_each_label_once() {
    for (index, metric) in METRICS.iter().enumerate() {
        assert!(
            METRICS[..index]
                .iter()
                .all(|other| other.name != metric.name),
            "{} is listed twice",
            metric.name
        );
        for (at, label) in metric.labels.iter().enumerate() {
            assert!(
                !label.values.is_empty(),
                "{} {} has no values",
                metric.name,
                label.name
            );
            assert!(
                metric.labels[..at]
                    .iter()
                    .all(|other| other.name != label.name),
                "{} has {} twice",
                metric.name,
                label.name
            );
            assert!(
                !DESCRIBED_BY.contains(&label.name)
                    && !["host.name", "service.name", "service.instance.id"].contains(&label.name),
                "{} labels data points with a resource attribute",
                metric.name
            );
        }
    }
}

fn attributes(pairs: &[(&str, &str)]) -> Json {
    pairs
        .iter()
        .map(|(key, value)| json!({"key": key, "value": {"stringValue": value}}))
        .collect()
}

fn number(labels: &[(&str, &str)], value: &Json) -> Json {
    let mut point =
        json!({"attributes": attributes(labels), "timeUnixNano": "1700000000000000000"});
    point
        .as_object_mut()
        .unwrap()
        .extend(value.as_object().unwrap().clone());
    point
}

fn sum(name: &str, points: &[Json]) -> Json {
    json!({"name": name, "sum": {"dataPoints": points, "aggregationTemporality": 2, "isMonotonic": true}})
}

fn gauge(name: &str, points: &[Json]) -> Json {
    json!({"name": name, "gauge": {"dataPoints": points}})
}

fn histogram(name: &str, labels: &[(&str, &str)], bounds: &[f64]) -> Json {
    let buckets: Vec<String> = (0..=bounds.len())
        .map(|index| if index == 0 { "2" } else { "0" }.to_owned())
        .collect();
    json!({"name": name, "histogram": {"aggregationTemporality": 2, "dataPoints": [{
        "attributes": attributes(labels),
        "startTimeUnixNano": "1600000000000000000",
        "timeUnixNano": "1700000000000000000",
        "count": "2",
        "sum": 0.0015,
        "bucketCounts": buckets,
        "explicitBounds": bounds,
    }]}})
}

fn export(resource: &[(&str, &str)], metrics: &[Json]) -> Vec<u8> {
    serde_json::to_vec(&json!({"resourceMetrics": [{
        "resource": {"attributes": attributes(resource)},
        "scopeMetrics": [{"scope": {"name": "anything", "version": "x"}, "metrics": metrics}],
    }]}))
    .unwrap()
}

fn names(hosts: &[&str]) -> Vec<String> {
    hosts.iter().map(|host| (*host).to_owned()).collect()
}

fn resource_of(checked: &Checked) -> Vec<(String, String)> {
    let out: Json = serde_json::from_slice(&checked.export).unwrap();
    out["resourceMetrics"][0]["resource"]["attributes"]
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
        .collect()
}

fn metric_names(checked: &Checked) -> Vec<String> {
    let out: Json = serde_json::from_slice(&checked.export).unwrap();
    out["resourceMetrics"][0]["scopeMetrics"][0]["metrics"]
        .as_array()
        .unwrap()
        .iter()
        .map(|metric| metric["name"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn what_keeps_to_the_list_goes_on_under_the_hosts_own_name() {
    let sent = export(
        &[
            ("host.name", "hosts-a"),
            ("service.name", "pretender"),
            ("service.instance.id", "hosts-b"),
            ("service.version", "0.0.0-sha.abc123"),
            ("compute.memory_profile", "bare_metal"),
            ("team", "someone-elses"),
        ],
        &[
            sum(
                "compute.alarm.count",
                &[number(
                    &[("compute.alarm", "broken")],
                    &json!({"asInt": "0"}),
                )],
            ),
            gauge(
                "compute.sandbox.count",
                &[
                    number(&[("compute.level", "running")], &json!({"asInt": "3"})),
                    number(&[("compute.level", "paused")], &json!({"asInt": 1})),
                ],
            ),
            histogram(
                "compute.request.duration",
                &[("compute.request", "wake")],
                &BOUNDS,
            ),
        ],
    );
    let checked = check(&sent, &names(&["hosts-a"])).unwrap();
    assert_eq!((checked.kept, checked.rejected), (4, 0));
    assert_eq!(
        resource_of(&checked),
        [
            ("service.name", "compute-host"),
            ("service.instance.id", "hosts-a"),
            ("host.name", "hosts-a"),
            ("service.version", "0.0.0-sha.abc123"),
            ("compute.memory_profile", "bare_metal"),
        ]
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
    );
    let out: Json = serde_json::from_slice(&checked.export).unwrap();
    let scope = &out["resourceMetrics"][0]["scopeMetrics"][0];
    assert_eq!(
        scope["scope"],
        json!({"name": "compute-host", "version": "0.0.0-sha.abc123"})
    );
    assert_eq!(scope["metrics"][1]["unit"], "{sandbox}");
    assert_eq!(scope["metrics"][1]["gauge"]["dataPoints"][1]["asInt"], "1");
}

#[test]
fn a_host_cannot_speak_for_another() {
    let sent = export(&[("host.name", "hosts-b")], &[]);
    assert_eq!(
        check(&sent, &names(&["hosts-a"])).unwrap_err(),
        Refused::OtherHost("the certificate does not name hosts-b".to_owned())
    );
    let unnamed = export(&[], &[]);
    let checked = check(&unnamed, &names(&["hosts-a"])).unwrap();
    assert_eq!(
        resource_of(&checked)[2],
        ("host.name".to_owned(), "hosts-a".to_owned())
    );
    assert!(matches!(
        check(&unnamed, &names(&["hosts-a", "hosts-c"])),
        Err(Refused::Malformed(_))
    ));
    assert!(matches!(
        check(b"{\"resourceMetrics\": 3}", &names(&["hosts-a"])),
        Err(Refused::Malformed(_))
    ));
}

#[test]
fn the_services_own_metrics_and_unlisted_ones_never_go_on() {
    let sent = export(
        &[("host.name", "hosts-a")],
        &[
            gauge(
                "compute.fleet.host.info",
                &[number(&[("state", "live")], &json!({"asInt": "1"}))],
            ),
            sum(
                "compute_control_hosts_given_up_total",
                &[number(&[], &json!({"asInt": "1"}))],
            ),
            gauge(
                "compute.stream.open",
                &[number(&[], &json!({"asInt": "2"}))],
            ),
        ],
    );
    let checked = check(&sent, &names(&["hosts-a"])).unwrap();
    assert_eq!((checked.kept, checked.rejected), (1, 2));
    assert_eq!(metric_names(&checked), ["compute.stream.open"]);
    assert_eq!(
        checked.problem.as_deref(),
        Some("hosts do not export compute.fleet.host.info")
    );
}

#[test]
fn a_data_point_carries_exactly_its_labels_with_listed_values() {
    let sent = export(
        &[("host.name", "hosts-a")],
        &[gauge(
            "compute.sandbox.count",
            &[
                number(&[("compute.level", "running")], &json!({"asInt": "1"})),
                number(
                    &[("compute.level", "running"), ("compute.sandbox", "abc")],
                    &json!({"asInt": "1"}),
                ),
                number(&[("compute.level", "chat-123")], &json!({"asInt": "1"})),
                number(&[("host.name", "hosts-b")], &json!({"asInt": "1"})),
                number(&[], &json!({"asInt": "1"})),
                number(
                    &[("compute.level", "paused"), ("compute.level", "saved")],
                    &json!({"asInt": "1"}),
                ),
            ],
        )],
    );
    let checked = check(&sent, &names(&["hosts-a"])).unwrap();
    assert_eq!((checked.kept, checked.rejected), (1, 5));
}

#[test]
fn values_and_shapes_are_what_hosts_send() {
    let sent = export(
        &[("host.name", "hosts-a")],
        &[
            // A gauge sent as a count, and a count that went down.
            sum(
                "compute.stream.open",
                &[number(&[], &json!({"asInt": "2"}))],
            ),
            sum(
                "compute.stream.opened",
                &[number(&[], &json!({"asInt": "-1"}))],
            ),
            gauge("compute.sample.age", &[number(&[], &json!({}))]),
            gauge(
                "compute.sample.age",
                &[number(&[], &json!({"asInt": "1", "asDouble": 1.0}))],
            ),
            // Bounds other than the hosts' own.
            histogram(
                "compute.request.duration",
                &[("compute.request", "wake")],
                &[1.0, 2.0],
            ),
            json!({"name": "compute.stream.opened", "sum": {
                "dataPoints": [number(&[], &json!({"asInt": "1"}))],
                "aggregationTemporality": 1, "isMonotonic": true,
            }}),
        ],
    );
    let checked = check(&sent, &names(&["hosts-a"])).unwrap();
    assert_eq!((checked.kept, checked.rejected), (0, 6));
    assert_eq!(metric_names(&checked), Vec::<String>::new());
}

#[test]
fn only_short_plain_values_describe_a_host() {
    let long = "v".repeat(65);
    let sent = export(
        &[
            ("host.name", "hosts-a"),
            ("service.version", &long),
            ("host.arch", "amd64"),
            ("os.type", "linux\"} 1\nforged"),
        ],
        &[],
    );
    let checked = check(&sent, &names(&["hosts-a"])).unwrap();
    assert_eq!(
        resource_of(&checked).last(),
        Some(&("host.arch".to_owned(), "amd64".to_owned()))
    );
    assert_eq!(resource_of(&checked).len(), 4);
}
