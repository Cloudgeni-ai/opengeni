//! What a replica tells Prometheus: `GET /metrics` on a listener of its
//! own (`--metrics-listen`), in Prometheus's text format.
//!
//! Every replica reports its own work: the public API's requests by route
//! and outcome, with their latency; the hosts' metrics it passed on
//! ([`crate::hostapi`], `--host-metrics-to`); and whether it leads. Only
//! the replica that leads reports the fleet, so a Prometheus that scrapes
//! every replica stores each fleet series once: each host as the
//! replica's view last read it (its state, what it has for sandboxes and
//! can still promise, the sandboxes it holds and runs, and how long its
//! renewal count has stood still), the hosts it gave up on and the fences
//! that failed, and the host group as it last sized it.
//!
//! Labels are bounded: routes are the API's route templates, outcomes its
//! error codes, hosts the fleet's own names. Nothing names a sandbox or a
//! team.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::{MatchedPath, Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use compute_fleet::{GroupView, HostId, HostState};

use crate::view::{Known, View};

/// The text format's content type.
pub const CONTENT_TYPE: &str = "text/plain; version=0.0.4; charset=utf-8";

/// Upper bounds of the request latency histogram's buckets, in seconds.
/// A wake waits for its host up to `--wake-within-s`, a minute by default.
const BOUNDS: [f64; 12] = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 15.0, 60.0,
];

/// A response's outcome for [`Metrics`]: the public API's error code, set
/// by the error's response. A response without one is `ok` when it
/// succeeded and `rejected` when axum refused the request before a
/// handler ran (a body or path that does not parse).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outcome(pub &'static str);

/// How passing on one host's metrics ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Passed {
    /// The metrics store took them.
    Forwarded,
    /// The host's request was refused: not metrics, not its own, or
    /// holding none of the metrics hosts send.
    Refused,
    /// The metrics store did not take them, or could not be reached.
    Failed,
}

impl Passed {
    const ALL: [Self; 3] = [Self::Forwarded, Self::Refused, Self::Failed];

    fn label(self) -> &'static str {
        match self {
            Self::Forwarded => "forwarded",
            Self::Refused => "refused",
            Self::Failed => "failed",
        }
    }
}

/// Why the leader gave up on a host whose lease ran out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GaveUp {
    /// It was live, or still had sandboxes: the host was lost.
    Lost,
    /// It was draining with no sandboxes left: removed as planned.
    Removed,
}

impl GaveUp {
    const ALL: [Self; 2] = [Self::Lost, Self::Removed];

    fn label(self) -> &'static str {
        match self {
            Self::Lost => "lost",
            Self::Removed => "removed",
        }
    }
}

/// The host group as the leader last saw it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GroupSeen {
    pub view: GroupView,
    /// The group's size, as its manager has it.
    pub size: u32,
    /// The most hosts it may have.
    pub max: u32,
}

#[derive(Debug, Default)]
struct Latency {
    buckets: [u64; BOUNDS.len()],
    count: u64,
    sum: f64,
}

/// What only the leader knows, kept while it leads.
#[derive(Debug, Default)]
struct Led {
    still: BTreeMap<HostId, Duration>,
    group: Option<GroupSeen>,
}

/// A route: its method and template.
type Route = (String, String);

/// One replica's metrics.
#[derive(Debug, Default)]
pub struct Metrics {
    requests: Mutex<BTreeMap<(Route, &'static str), u64>>,
    latency: Mutex<BTreeMap<Route, Latency>>,
    passed: [AtomicU64; 3],
    points_left_out: AtomicU64,
    leading: AtomicBool,
    led: Mutex<Led>,
    given_up: [AtomicU64; 2],
    give_up_failures: AtomicU64,
    group_failures: AtomicU64,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Metrics {
    /// Counts one answered request.
    pub fn request(&self, method: &str, route: &str, outcome: &'static str, took: Duration) {
        let key = (method.to_owned(), route.to_owned());
        *locked(&self.requests)
            .entry((key.clone(), outcome))
            .or_default() += 1;
        let seconds = took.as_secs_f64();
        let mut latency = locked(&self.latency);
        let latency = latency.entry(key).or_default();
        if let Some(bucket) = BOUNDS.iter().position(|bound| seconds <= *bound) {
            latency.buckets[bucket] += 1;
        }
        latency.count += 1;
        latency.sum += seconds;
    }

    /// Counts one host's metrics passed on, or not.
    pub fn passed(&self, passed: Passed) {
        self.passed[passed as usize].fetch_add(1, Ordering::Relaxed);
    }

    /// Counts data points of hosts' metrics left out of what was passed
    /// on: not among the metrics hosts send, or not as they send them.
    pub fn left_out(&self, points: u64) {
        self.points_left_out.fetch_add(points, Ordering::Relaxed);
    }

    /// Notes whether this replica leads; one that stops forgets what it
    /// knew as the leader.
    pub fn leads(&self, leads: bool) {
        self.leading.store(leads, Ordering::Relaxed);
        if !leads {
            *locked(&self.led) = Led::default();
        }
    }

    /// Notes how long each host's renewal count has stood still.
    pub fn still(&self, still: impl IntoIterator<Item = (HostId, Duration)>) {
        locked(&self.led).still = still.into_iter().collect();
    }

    /// Notes a host given up on, and why.
    pub fn gave_up(&self, why: GaveUp) {
        self.given_up[why as usize].fetch_add(1, Ordering::Relaxed);
    }

    /// Notes a give-up that failed, in its fence or in the store.
    pub fn give_up_failed(&self) {
        self.give_up_failures.fetch_add(1, Ordering::Relaxed);
    }

    /// Notes how the host group looked when it was last sized.
    pub fn group(&self, seen: GroupSeen) {
        locked(&self.led).group = Some(seen);
    }

    /// Notes a sizing of the host group that failed.
    pub fn group_failed(&self) {
        self.group_failures.fetch_add(1, Ordering::Relaxed);
    }

    /// The metrics in the text format, with `hosts` as the view has them.
    #[must_use]
    pub fn render(&self, hosts: &[Known]) -> String {
        let mut out = Text::default();
        self.render_requests(&mut out);
        out.family(
            "compute_control_host_metrics_total",
            "counter",
            "Host metric exports this replica passed on to the metrics store, or did not, by outcome.",
        );
        for passed in Passed::ALL {
            out.sample(
                "compute_control_host_metrics_total",
                &[("outcome", passed.label())],
                self.passed[passed as usize].load(Ordering::Relaxed),
            );
        }
        out.family(
            "compute_control_host_metric_points_left_out_total",
            "counter",
            "Data points of host metric exports this replica left out of what it passed on: not among the metrics hosts send, or not as they send them.",
        );
        out.sample(
            "compute_control_host_metric_points_left_out_total",
            &[],
            self.points_left_out.load(Ordering::Relaxed),
        );
        let leading = self.leading.load(Ordering::Relaxed);
        out.family(
            "compute_control_leader",
            "gauge",
            "1 while this replica leads: it alone reports the compute_fleet_ series.",
        );
        out.sample("compute_control_leader", &[], u64::from(leading));
        out.family(
            "compute_control_hosts_given_up_total",
            "counter",
            "Hosts this replica gave up on while it led, their leases run out, by cause: lost (live, or still holding sandboxes) or removed (drained and empty, as planned).",
        );
        for why in GaveUp::ALL {
            out.sample(
                "compute_control_hosts_given_up_total",
                &[("cause", why.label())],
                self.given_up[why as usize].load(Ordering::Relaxed),
            );
        }
        for (name, help, value) in [
            (
                "compute_control_give_up_failures_total",
                "Give-ups of lapsed hosts that failed while this replica led, in their fence or in the store; each is tried again.",
                &self.give_up_failures,
            ),
            (
                "compute_control_group_failures_total",
                "Sizings of the host group that failed while this replica led.",
                &self.group_failures,
            ),
        ] {
            out.family(name, "counter", help);
            out.sample(name, &[], value.load(Ordering::Relaxed));
        }
        if leading {
            let led = locked(&self.led);
            render_fleet(&mut out, hosts, &led);
        }
        out.0
    }

    fn render_requests(&self, out: &mut Text) {
        out.family(
            "compute_control_requests_total",
            "counter",
            "Public API requests this replica answered, by route and outcome (ok, rejected or the API's error code).",
        );
        for (((method, route), outcome), count) in locked(&self.requests).iter() {
            out.sample(
                "compute_control_requests_total",
                &[("method", method), ("route", route), ("outcome", outcome)],
                *count,
            );
        }
        out.family(
            "compute_control_request_duration_seconds",
            "histogram",
            "How long this replica took to answer public API requests, by route; a connect until its stream starts.",
        );
        for ((method, route), latency) in locked(&self.latency).iter() {
            let labels = [("method", method.as_str()), ("route", route.as_str())];
            let mut cumulative = 0;
            for (bound, count) in BOUNDS.iter().zip(latency.buckets) {
                cumulative += count;
                let le = bound.to_string();
                out.sample(
                    "compute_control_request_duration_seconds_bucket",
                    &[labels[0], labels[1], ("le", &le)],
                    cumulative,
                );
            }
            out.sample(
                "compute_control_request_duration_seconds_bucket",
                &[labels[0], labels[1], ("le", "+Inf")],
                latency.count,
            );
            out.float(
                "compute_control_request_duration_seconds_sum",
                &labels,
                latency.sum,
            );
            out.sample(
                "compute_control_request_duration_seconds_count",
                &labels,
                latency.count,
            );
        }
    }
}

fn state_label(state: HostState) -> &'static str {
    match state {
        HostState::Live => "live",
        HostState::Draining => "draining",
        HostState::Lost => "lost",
    }
}

const MIB: u64 = 1 << 20;

/// A gauge's value, written exactly.
#[derive(Clone, Copy, Debug)]
enum Num {
    Whole(u64),
    /// Thousandths: millicores as cores.
    Thousandths(u64),
}

/// A host's gauge: its name, help, and value.
type HostGauge = (&'static str, &'static str, fn(&Known) -> Num);

fn bytes(mib: u64) -> Num {
    Num::Whole(mib.saturating_mul(MIB))
}

/// The gauges each host the service counts on has.
fn host_gauges() -> [HostGauge; 10] {
    [
        (
            "compute_fleet_host_memory_bytes",
            "Memory a host gives sandboxes in all.",
            |host| bytes(host.info.memory_mib),
        ),
        (
            "compute_fleet_host_memory_free_bytes",
            "Memory a host can still promise to sandboxes that wake, beyond its buffer, as it last reported.",
            |host| bytes(host.capacity.memory_free_mib),
        ),
        (
            "compute_fleet_host_memory_reclaimable_bytes",
            "Memory a host frees at once for a wake by ending idle VM processes whose state is saved, which placement counts as free, as it last reported.",
            |host| bytes(host.capacity.memory_reclaimable_mib),
        ),
        (
            "compute_fleet_host_cpu_cores",
            "Processor time a host guaranteed sandboxes at once when it registered, in cores.",
            |host| Num::Thousandths(host.info.cpu_millis),
        ),
        (
            "compute_fleet_host_cpu_guaranteed_cores",
            "Processor time a host guarantees sandboxes at once now, in cores, as it last reported.",
            |host| Num::Thousandths(host.capacity.cpu_millis),
        ),
        (
            "compute_fleet_host_cpu_free_cores",
            "Processor time a wake can still reserve on a host, in cores, as it last reported.",
            |host| Num::Thousandths(host.capacity.cpu_free_millis),
        ),
        (
            "compute_fleet_host_disk_bytes",
            "Disk a host gives sandboxes in all.",
            |host| bytes(host.info.disk_mib),
        ),
        (
            "compute_fleet_host_disk_free_bytes",
            "Disk free for sandboxes on a host, as it last reported.",
            |host| bytes(host.capacity.disk_free_mib),
        ),
        (
            "compute_fleet_host_sandboxes",
            "Sandboxes a host holds, awake or asleep on it, as it last reported.",
            |host| Num::Whole(u64::from(host.capacity.sandboxes)),
        ),
        (
            "compute_fleet_host_sandboxes_awake",
            "Sandboxes whose VM runs on a host, as it last reported.",
            |host| Num::Whole(u64::from(host.capacity.awake)),
        ),
    ]
}

/// The fleet's series, which only the leader reports.
fn render_fleet(out: &mut Text, hosts: &[Known], led: &Led) {
    out.family(
        "compute_fleet_host_info",
        "gauge",
        "1 for each host the service knows, with its state, zone, memory profile and CPU template.",
    );
    for host in hosts {
        out.sample(
            "compute_fleet_host_info",
            &[
                ("host_name", &host.target.name),
                ("state", state_label(host.state)),
                ("zone", &host.info.zone),
                ("profile", &host.info.profile),
                ("cpu_template", &host.info.cpu_template),
            ],
            1,
        );
    }
    let counted: Vec<&Known> = hosts
        .iter()
        .filter(|host| host.state != HostState::Lost)
        .collect();
    for (name, help, value) in host_gauges() {
        out.family(name, "gauge", help);
        for host in &counted {
            out.num(name, &[("host_name", &host.target.name)], value(host));
        }
    }
    out.family(
        "compute_fleet_host_renewal_age_seconds",
        "gauge",
        "How long a host's renewal count has stood still, as the leader watched it: about how long ago its lease was last renewed.",
    );
    for host in &counted {
        if let Some(still) = led.still.get(&host.target.host) {
            out.float(
                "compute_fleet_host_renewal_age_seconds",
                &[("host_name", &host.target.name)],
                still.as_secs_f64(),
            );
        }
    }
    if let Some(group) = &led.group {
        render_group(out, group);
    }
}

/// The host group's series, as the leader last sized it.
fn render_group(out: &mut Text, group: &GroupSeen) {
    out.family(
        "compute_fleet_group_hosts",
        "gauge",
        "The host group's members as the leader last sized it, by state: live, booting (not registered yet), draining, or stalled (not registered in time).",
    );
    for (state, count) in [
        ("live", group.view.hosts),
        ("booting", group.view.booting),
        ("draining", group.view.draining),
        ("stalled", group.view.stalled),
    ] {
        out.sample(
            "compute_fleet_group_hosts",
            &[("state", state)],
            u64::from(count),
        );
    }
    for (name, help, value) in [
        (
            "compute_fleet_group_size",
            "The host group's size as its manager had it when the leader last sized it, before any resize.",
            group.size,
        ),
        (
            "compute_fleet_group_max_size",
            "The most hosts the group may have (--scale-max).",
            group.max,
        ),
    ] {
        out.family(name, "gauge", help);
        out.sample(name, &[], u64::from(value));
    }
}

/// The text format, as it is written.
#[derive(Default)]
struct Text(String);

impl Text {
    fn family(&mut self, name: &str, kind: &str, help: &str) {
        let _ = writeln!(self.0, "# HELP {name} {help}");
        let _ = writeln!(self.0, "# TYPE {name} {kind}");
    }

    fn labels(&mut self, name: &str, labels: &[(&str, &str)]) {
        self.0.push_str(name);
        if labels.is_empty() {
            return;
        }
        self.0.push('{');
        for (index, (key, value)) in labels.iter().enumerate() {
            if index > 0 {
                self.0.push(',');
            }
            let _ = write!(self.0, "{key}=\"");
            for character in value.chars() {
                match character {
                    '\\' => self.0.push_str("\\\\"),
                    '"' => self.0.push_str("\\\""),
                    '\n' => self.0.push_str("\\n"),
                    other => self.0.push(other),
                }
            }
            self.0.push('"');
        }
        self.0.push('}');
    }

    fn sample(&mut self, name: &str, labels: &[(&str, &str)], value: u64) {
        self.labels(name, labels);
        let _ = writeln!(self.0, " {value}");
    }

    fn float(&mut self, name: &str, labels: &[(&str, &str)], value: f64) {
        self.labels(name, labels);
        let _ = writeln!(self.0, " {value}");
    }

    fn num(&mut self, name: &str, labels: &[(&str, &str)], value: Num) {
        self.labels(name, labels);
        let _ = match value {
            Num::Whole(value) => writeln!(self.0, " {value}"),
            Num::Thousandths(value) => writeln!(self.0, " {}.{:03}", value / 1000, value % 1000),
        };
    }
}

/// Counts each public API request it wraps: a route layer, so the route's
/// template is known.
pub async fn track(State(metrics): State<Arc<Metrics>>, request: Request, next: Next) -> Response {
    let method = method_label(request.method()).to_owned();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map_or_else(String::new, |path| path.as_str().to_owned());
    let started = Instant::now();
    let response = next.run(request).await;
    let outcome = response.extensions().get::<Outcome>().map_or_else(
        || {
            let status = response.status();
            if status.is_success() || status == StatusCode::SWITCHING_PROTOCOLS {
                "ok"
            } else {
                "rejected"
            }
        },
        |outcome| outcome.0,
    );
    metrics.request(&method, &route, outcome, started.elapsed());
    response
}

/// A request's method as a label: the standard methods by name and any
/// other as `OTHER`, so a caller cannot add series by inventing methods.
fn method_label(method: &axum::http::Method) -> &'static str {
    use axum::http::Method;
    match *method {
        Method::GET => "GET",
        Method::POST => "POST",
        Method::PUT => "PUT",
        Method::PATCH => "PATCH",
        Method::DELETE => "DELETE",
        Method::HEAD => "HEAD",
        Method::OPTIONS => "OPTIONS",
        _ => "OTHER",
    }
}

struct Scrape {
    metrics: Arc<Metrics>,
    view: Arc<View>,
}

async fn scrape(State(scrape): State<Arc<Scrape>>) -> impl IntoResponse {
    let hosts = scrape.view.hosts();
    (
        [(header::CONTENT_TYPE, CONTENT_TYPE)],
        scrape.metrics.render(&hosts),
    )
}

/// The metrics listener's routes: `GET /metrics`.
pub fn router(metrics: Arc<Metrics>, view: Arc<View>) -> Router {
    Router::new()
        .route("/metrics", get(scrape))
        .with_state(Arc::new(Scrape { metrics, view }))
}

/// Serves `router` over plain HTTP on `listener`: Prometheus scrapes it
/// from inside the cluster.
pub async fn serve(listener: tokio::net::TcpListener, router: Router) {
    let address: Option<SocketAddr> = listener.local_addr().ok();
    if let Err(error) = axum::serve(listener, router).await {
        tracing::error!(%error, ?address, "the metrics listener stopped");
    }
}

#[cfg(test)]
mod tests;
