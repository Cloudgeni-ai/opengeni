use compute_fleet::HostEpoch;
use compute_protocol::fleet::{Capacity as Reported, HostInfo as Described};

use super::*;
use crate::view::Target;

fn host(id: u64, name: &str, state: HostState) -> Known {
    Known {
        target: Target {
            host: HostId(id),
            name: name.to_owned(),
            address: format!("{name}:7443"),
            epoch: HostEpoch(1),
            seq: 1,
            class: "bare_metal/host".to_owned(),
        },
        info: Described {
            name: name.to_owned(),
            address: format!("{name}:7443"),
            zone: "zone-a".to_owned(),
            profile: "bare_metal".to_owned(),
            cpu_template: "host".to_owned(),
            memory_mib: 30_000,
            cpu_millis: 7_000,
            disk_mib: 100_000,
        },
        state,
        capacity: Reported {
            memory_free_mib: 29_000,
            memory_reclaimable_mib: 3_000,
            cpu_millis: 6_500,
            cpu_free_millis: 6_372,
            disk_free_mib: 90_000,
            ready: Vec::new(),
            awake: 2,
            sandboxes: 5,
        },
    }
}

/// The value of the one sample `line` starts with, if it is there.
fn value(text: &str, series: &str) -> Option<f64> {
    text.lines()
        .find_map(|line| line.strip_prefix(series)?.strip_prefix(' '))
        .map(|value| value.parse().unwrap())
}

#[test]
fn only_the_leader_reports_the_fleet() {
    let metrics = Metrics::default();
    let hosts = [host(1, "hosts-a", HostState::Live)];
    let text = metrics.render(&hosts);
    assert_eq!(value(&text, "compute_control_leader"), Some(0.0));
    assert!(
        !text.contains("# TYPE compute_fleet_") && !text.contains("\ncompute_fleet_"),
        "{text}"
    );

    metrics.leads(true);
    metrics.still([(HostId(1), Duration::from_millis(1500))]);
    let text = metrics.render(&hosts);
    assert_eq!(value(&text, "compute_control_leader"), Some(1.0));
    let free = value(
        &text,
        "compute_fleet_host_memory_free_bytes{host_name=\"hosts-a\"}",
    );
    assert_eq!(free, Some(29_000.0 * 1_048_576.0));
    let reclaimable = value(
        &text,
        "compute_fleet_host_memory_reclaimable_bytes{host_name=\"hosts-a\"}",
    );
    assert_eq!(reclaimable, Some(3_000.0 * 1_048_576.0));
    assert_eq!(
        value(
            &text,
            "compute_fleet_host_cpu_free_cores{host_name=\"hosts-a\"}"
        ),
        Some(6.372)
    );
    assert_eq!(
        value(
            &text,
            "compute_fleet_host_sandboxes_awake{host_name=\"hosts-a\"}"
        ),
        Some(2.0)
    );
    assert_eq!(
        value(
            &text,
            "compute_fleet_host_renewal_age_seconds{host_name=\"hosts-a\"}"
        ),
        Some(1.5)
    );

    // A replica that stops leading forgets what it knew as the leader.
    metrics.leads(false);
    metrics.leads(true);
    let text = metrics.render(&hosts);
    assert!(
        !text.contains("compute_fleet_host_renewal_age_seconds{"),
        "{text}"
    );
}

#[test]
fn a_lost_host_is_listed_but_reports_no_capacity() {
    let metrics = Metrics::default();
    metrics.leads(true);
    let hosts = [
        host(1, "hosts-a", HostState::Live),
        host(2, "hosts-b", HostState::Lost),
    ];
    let text = metrics.render(&hosts);
    assert!(text.contains("compute_fleet_host_info{host_name=\"hosts-b\",state=\"lost\""));
    assert!(!text.contains("compute_fleet_host_memory_free_bytes{host_name=\"hosts-b\"}"));
}

#[test]
fn requests_count_by_route_and_outcome_with_their_latency() {
    let metrics = Metrics::default();
    let route = "/v1/sandboxes/{id}/wake";
    metrics.request("POST", route, "ok", Duration::from_millis(30));
    metrics.request("POST", route, "no_capacity", Duration::from_secs(2));
    metrics.request("POST", route, "no_capacity", Duration::from_secs(90));
    let text = metrics.render(&[]);
    let labels = "method=\"POST\",route=\"/v1/sandboxes/{id}/wake\"";
    assert_eq!(
        value(
            &text,
            &format!("compute_control_requests_total{{{labels},outcome=\"no_capacity\"}}")
        ),
        Some(2.0)
    );
    let bucket = |le: &str| {
        value(
            &text,
            &format!("compute_control_request_duration_seconds_bucket{{{labels},le=\"{le}\"}}"),
        )
    };
    assert_eq!(bucket("0.025"), Some(0.0));
    assert_eq!(bucket("0.05"), Some(1.0));
    assert_eq!(bucket("2.5"), Some(2.0));
    assert_eq!(bucket("60"), Some(2.0));
    assert_eq!(bucket("+Inf"), Some(3.0));
    assert_eq!(
        value(
            &text,
            &format!("compute_control_request_duration_seconds_count{{{labels}}}")
        ),
        Some(3.0)
    );
}

#[test]
fn every_family_says_what_it_is_once() {
    let metrics = Metrics::default();
    metrics.leads(true);
    metrics.request("GET", "/v1/hosts", "ok", Duration::from_millis(1));
    metrics.group(GroupSeen {
        view: GroupView {
            hosts: 1,
            booting: 1,
            ..GroupView::default()
        },
        size: 2,
        max: 4,
    });
    let text = metrics.render(&[host(1, "hosts-a", HostState::Live)]);
    let mut families = Vec::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# TYPE ") {
            let name = rest.split(' ').next().unwrap();
            assert!(!families.contains(&name), "{name} twice");
            families.push(name);
        } else if !line.starts_with('#') {
            let series = line.split(['{', ' ']).next().unwrap();
            assert!(
                families
                    .iter()
                    .any(|family| series == *family || series.starts_with(&format!("{family}_"))),
                "{series} has no family"
            );
        }
    }
    assert_eq!(
        value(&text, "compute_fleet_group_hosts{state=\"booting\"}"),
        Some(1.0)
    );
    assert_eq!(value(&text, "compute_fleet_group_max_size"), Some(4.0));
}

#[test]
fn label_values_are_escaped() {
    let mut text = Text::default();
    text.sample("x", &[("route", "a\"b\\c\nd")], 1);
    assert_eq!(text.0, "x{route=\"a\\\"b\\\\c\\nd\"} 1\n");
}

#[test]
fn invented_methods_share_one_label() {
    use axum::http::Method;
    assert_eq!(method_label(&Method::POST), "POST");
    for invented in ["BREW", "PROPFIND", "X-ANYTHING"] {
        let method = Method::from_bytes(invented.as_bytes()).unwrap();
        assert_eq!(method_label(&method), "OTHER", "{invented}");
    }
}
