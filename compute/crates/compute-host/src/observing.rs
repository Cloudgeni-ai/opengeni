//! The agent's command-line settings for what it reports (see
//! [`compute_host::observe`]).

use std::path::Path;
use std::time::Duration;

use anyhow::Context;
use clap::Args;
use compute_host::fleet::FleetConfig;
use compute_host::observe::canary::{CanaryConfig, CanaryIds};
use compute_host::observe::{ExportConfig, ObserveConfig, Observer};
use compute_host::protocol::About;

/// How long one request with the host's metrics to the control service
/// may take, as for a collector.
const METRICS_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Args)]
pub struct ObserveArgs {
    /// Send events and metrics to this OpenTelemetry collector, over
    /// OTLP/HTTP with JSON encoding, such as `http://127.0.0.1:4318`.
    /// Without it events stay on the host, and metrics too unless
    /// `--otlp-metrics-to-control` sends them to the control service.
    #[arg(long)]
    otlp_endpoint: Option<String>,
    /// A header every export to the collector carries, as `name=value`,
    /// such as an authorization. Repeatable.
    #[arg(long = "otlp-header", value_parser = parse_header)]
    otlp_headers: Vec<(String, String)>,
    /// Send metrics to the fleet's control service, over the fleet's
    /// mutual TLS, which passes them on to its metrics store; the host
    /// needs no collector or credentials of its own for them. Needs a
    /// fleet. Events still go to `--otlp-endpoint`, if set.
    #[arg(long)]
    otlp_metrics_to_control: bool,
    /// How often metrics are exported.
    #[arg(long, default_value = "10s", value_parser = parse_period)]
    otlp_metrics_every: Duration,
    /// Do not also write each event to the agent's log.
    #[arg(long)]
    no_journal_events: bool,
    /// Run the canary (see ADR 16), starting a run this often. Off when
    /// unset.
    #[arg(long, value_parser = parse_period)]
    canary_every: Option<Duration>,
    /// How long one canary run may take.
    #[arg(long, default_value = "5m", value_parser = parse_period)]
    canary_timeout: Duration,
    /// A guest port each canary wake connects to, so the guest has to
    /// answer.
    #[arg(long)]
    canary_port: Option<u32>,
}

fn parse_header(text: &str) -> Result<(String, String), String> {
    let (name, value) = text
        .split_once('=')
        .ok_or_else(|| format!("expected name=value, got {text:?}"))?;
    Ok((name.trim().to_owned(), value.trim().to_owned()))
}

/// A duration that is more than zero: a period of zero would never end.
fn parse_period(text: &str) -> Result<Duration, String> {
    let period = crate::parse_duration(text)?;
    if period.is_zero() {
        return Err("must be more than zero".to_owned());
    }
    Ok(period)
}

impl ObserveArgs {
    /// Starts reporting for the agent described by `about`, a host in
    /// `fleet` if it is in one.
    pub fn observer(&self, about: &About, fleet: Option<&FleetConfig>) -> anyhow::Result<Observer> {
        if let Some(endpoint) = &self.otlp_endpoint {
            reqwest::Url::parse(endpoint).with_context(|| format!("--otlp-endpoint {endpoint}"))?;
        }
        let control = if self.otlp_metrics_to_control {
            let fleet = fleet
                .context("--otlp-metrics-to-control sends metrics to a fleet's control service")?;
            Some(fleet.metrics_route(METRICS_TIMEOUT)?)
        } else {
            None
        };
        // The control service accepts a host's metrics only under its
        // name in the fleet.
        let host = match &control {
            Some(route) => route.name.clone(),
            None => std::fs::read_to_string("/proc/sys/kernel/hostname")
                .map(|name| name.trim().to_owned())
                .unwrap_or_default(),
        };
        let base = match (&self.otlp_endpoint, control) {
            (endpoint, Some(route)) => Some(ExportConfig {
                endpoint: endpoint
                    .as_ref()
                    .map(|endpoint| endpoint.trim_end_matches('/').to_owned()),
                ..ExportConfig::to_control(route.url, route.client)
            }),
            (Some(endpoint), None) => Some(ExportConfig::new(endpoint.clone())),
            (None, None) => None,
        };
        let export = base.map(|base| ExportConfig {
            headers: self.otlp_headers.clone(),
            metrics_every: self.otlp_metrics_every,
            ..base
        });
        // As the semantic conventions name processor architectures.
        let arch = match std::env::consts::ARCH {
            "x86_64" => "amd64",
            "aarch64" => "arm64",
            other => other,
        };
        let resource = [
            ("service.name", "compute-host".to_owned()),
            ("service.version", about.build.clone()),
            ("service.instance.id", host.clone()),
            ("host.name", host),
            ("host.arch", arch.to_owned()),
            ("os.type", std::env::consts::OS.to_owned()),
            ("compute.memory_profile", about.memory_profile.clone()),
        ]
        .into_iter()
        .filter(|(_, value)| !value.is_empty())
        .map(|(key, value)| (key.to_owned(), value))
        .collect();
        Ok(Observer::start(ObserveConfig {
            export,
            resource,
            version: about.build.clone(),
            journal: !self.no_journal_events,
            ..ObserveConfig::default()
        }))
    }

    /// The canary's settings, if it runs, for the agent with state `root`;
    /// `remote` is whether the host has a store.
    pub fn canary(&self, root: &Path, remote: bool) -> anyhow::Result<Option<CanaryConfig>> {
        let Some(every) = self.canary_every else {
            return Ok(None);
        };
        let ids = CanaryIds::for_host(root)
            .with_context(|| format!("the canary's ids in {}", root.display()))?;
        Ok(Some(CanaryConfig {
            timeout: self.canary_timeout,
            port: self.canary_port,
            ..CanaryConfig::new(every, remote, ids)
        }))
    }
}
