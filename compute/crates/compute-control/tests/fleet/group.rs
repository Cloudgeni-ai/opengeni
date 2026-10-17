//! The leader against a fake Compute Engine API: it grows the host group
//! before spare memory runs out, and fences a lapsed host of the group
//! (resetting it, or finding it stopped and starting it again after) before
//! it gives up on it.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use compute_control::group::GcpGroup;
use compute_control::leader::Scaling;
use compute_control::store::Store as _;
use compute_fleet::{HostId, ScalePolicy};
use compute_protocol::fleet::Capacity;
use serde_json::{Value, json};

use super::support::{FakeHost, Fleet, roomy, until};

const GROUP: &str = "projects/p/zones/z/instanceGroupManagers/hosts";

/// What the fake API holds and was asked.
#[derive(Default)]
struct Compute {
    target_size: AtomicU32,
    /// Instances by name, with their status.
    instances: Mutex<HashMap<String, String>>,
    /// What it was asked to do, in order: `resize N`, `reset NAME`,
    /// `start NAME`, `stop NAME`.
    asked: Mutex<Vec<String>>,
    /// Resets fail while set.
    fail_resets: AtomicBool,
    /// Operations stay running while set.
    hold_operations: AtomicBool,
}

impl Compute {
    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }

    fn note(&self, what: String) {
        self.asked.lock().unwrap().push(what);
    }
}

fn operation(name: &str, done: bool) -> Value {
    json!({ "name": name, "status": if done { "DONE" } else { "RUNNING" } })
}

async fn token() -> Json<Value> {
    Json(json!({ "access_token": "token", "expires_in": 3600 }))
}

async fn describe(State(compute): State<Arc<Compute>>) -> Json<Value> {
    Json(json!({
        "targetSize": compute.target_size.load(Ordering::SeqCst),
        "baseInstanceName": "hosts",
    }))
}

async fn group_action(
    State(compute): State<Arc<Compute>>,
    Path(action): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    match action.as_str() {
        "resize" => {
            let size: u32 = query["size"].parse().unwrap();
            compute.target_size.store(size, Ordering::SeqCst);
            compute.note(format!("resize {size}"));
            Json(operation("resize", true)).into_response()
        }
        "listManagedInstances" => {
            let instances = compute.instances.lock().unwrap().clone();
            let managed: Vec<Value> = instances
                .iter()
                .map(|(name, status)| {
                    json!({
                        "instance": format!("https://compute.example/compute/v1/projects/p/zones/z/instances/{name}"),
                        "instanceStatus": status,
                    })
                })
                .collect();
            Json(json!({ "managedInstances": managed })).into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn instance(State(compute): State<Arc<Compute>>, Path(name): Path<String>) -> Response {
    match compute.instances.lock().unwrap().get(&name) {
        Some(status) => Json(json!({ "name": name, "status": status })).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn instance_action(
    State(compute): State<Arc<Compute>>,
    Path((name, action)): Path<(String, String)>,
) -> Response {
    if action == "reset" && compute.fail_resets.load(Ordering::SeqCst) {
        compute.note(format!("failed reset {name}"));
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let status = match action.as_str() {
        "reset" | "start" => "RUNNING",
        "stop" => "TERMINATED",
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    compute
        .instances
        .lock()
        .unwrap()
        .insert(name.clone(), status.to_owned());
    compute.note(format!("{action} {name}"));
    let held = compute.hold_operations.load(Ordering::SeqCst);
    Json(operation(&format!("{action}-{name}"), !held)).into_response()
}

async fn zone_operation(
    State(compute): State<Arc<Compute>>,
    Path(name): Path<String>,
) -> Json<Value> {
    Json(operation(
        &name,
        !compute.hold_operations.load(Ordering::SeqCst),
    ))
}

/// Serves the fake API on loopback, returning its address.
async fn serve(compute: Arc<Compute>) -> String {
    let router = axum::Router::new()
        .route(
            "/computeMetadata/v1/instance/service-accounts/default/token",
            get(token),
        )
        .route(&format!("/compute/v1/{GROUP}"), get(describe))
        .route(
            &format!("/compute/v1/{GROUP}/{{action}}"),
            post(group_action),
        )
        .route(
            "/compute/v1/projects/p/zones/z/instances/{name}",
            get(instance),
        )
        .route(
            "/compute/v1/projects/p/zones/z/instances/{name}/{action}",
            post(instance_action),
        )
        .route(
            "/compute/v1/projects/p/zones/z/operations/{name}",
            get(zone_operation),
        )
        .with_state(compute);
    let listener = tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{address}")
}

/// A fleet whose leader sizes and fences the fake group, which has the
/// instances `instances` and asks for that many.
async fn fleet(instances: &[(&str, &str)]) -> (Fleet, Arc<Compute>) {
    let compute = Arc::new(Compute::default());
    compute
        .target_size
        .store(u32::try_from(instances.len()).unwrap(), Ordering::SeqCst);
    *compute.instances.lock().unwrap() = instances
        .iter()
        .map(|(name, status)| ((*name).to_owned(), (*status).to_owned()))
        .collect();
    let api = serve(Arc::clone(&compute)).await;
    let scaling = Scaling {
        group: Arc::new(GcpGroup::new(GROUP, &api, &api).unwrap()),
        policy: ScalePolicy {
            spare_per_mille: 200,
            spare_largest: 2,
            largest_mib: 4096,
            host_memory_mib: 65_536,
            min_hosts: 1,
            max_hosts: 10,
        },
        every: Duration::from_millis(200),
    };
    (Fleet::start_with(Some(scaling), |_| {}).await, compute)
}

/// Whether the fleet still counts on `host`.
async fn counted(fleet: &Fleet, host: &FakeHost) -> bool {
    fleet
        .store
        .renewals()
        .await
        .unwrap()
        .iter()
        .any(|(id, _)| *id == HostId(host.id()))
}

/// Longer than a lapse takes to be noticed: the term and margin, and a few
/// of the leader's looks.
fn past_lapse(fleet: &Fleet) -> Duration {
    fleet.terms.term + fleet.terms.margin + Duration::from_secs(1)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_group_grows_before_spare_memory_runs_out_and_only_once() {
    let (fleet, compute) = fleet(&[("hosts-a1b2", "RUNNING")]).await;
    let host = fleet.host("hosts-a1b2").await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(
        !compute
            .asked()
            .iter()
            .any(|asked| asked.starts_with("resize")),
        "{:?}",
        compute.asked()
    );
    // Its spare runs short as sandboxes fill it.
    host.set_capacity(Capacity {
        memory_free_mib: 1024,
        ..roomy()
    });
    until(Duration::from_secs(5), "the group grows", async || {
        compute.asked().contains(&"resize 2".to_owned())
    })
    .await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let resizes: Vec<String> = compute
        .asked()
        .into_iter()
        .filter(|asked| asked.starts_with("resize"))
        .collect();
    assert_eq!(resizes, ["resize 2"], "the booting host counts as coming");
}

/// A host of the group that stops renewing is reset before its sandboxes
/// lose their owner, and not given up on while the reset is under way.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lapsed_host_of_the_group_is_reset_before_it_is_given_up_on() {
    let (fleet, compute) = fleet(&[("hosts-a1b2", "RUNNING")]).await;
    let host = fleet.host("hosts-a1b2").await;
    let sandbox = fleet.create(json!({})).await;
    assert!(host.holds(super::support::id(&sandbox)).is_some());
    compute.hold_operations.store(true, Ordering::SeqCst);
    host.renewing(false);
    until(past_lapse(&fleet), "the host is reset", async || {
        compute.asked().contains(&"reset hosts-a1b2".to_owned())
    })
    .await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(
        counted(&fleet, &host).await,
        "given up on before its reset finished"
    );
    let (_, row) = fleet.get(&format!("/v1/sandboxes/{sandbox}")).await;
    assert_eq!(row["host"], "hosts-a1b2", "{row}");

    compute.hold_operations.store(false, Ordering::SeqCst);
    until(
        Duration::from_secs(5),
        "the host is given up on",
        async || !counted(&fleet, &host).await,
    )
    .await;
    assert!(
        !compute
            .asked()
            .iter()
            .any(|asked| asked.starts_with("start")),
        "a reset host boots by itself: {:?}",
        compute.asked()
    );
}

/// An instance on its way to running, as when it resumes from a suspend
/// with its memory kept, is not taken as fenced: the leader waits until it
/// runs, resets it, and only then gives up on its host.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_resuming_host_of_the_group_is_reset_once_it_runs_before_it_is_given_up_on() {
    let (fleet, compute) = fleet(&[("hosts-a1b2", "RUNNING")]).await;
    let host = fleet.host("hosts-a1b2").await;
    let set = |status: &str| {
        compute
            .instances
            .lock()
            .unwrap()
            .insert("hosts-a1b2".into(), status.into());
    };
    set("PROVISIONING");
    host.renewing(false);
    tokio::time::sleep(past_lapse(&fleet) + Duration::from_secs(2)).await;
    assert!(
        counted(&fleet, &host).await,
        "given up on while provisioning: {:?}",
        compute.asked()
    );
    set("STAGING");
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(
        counted(&fleet, &host).await,
        "given up on while staging: {:?}",
        compute.asked()
    );
    assert!(compute.asked().is_empty(), "{:?}", compute.asked());
    set("RUNNING");
    until(
        Duration::from_secs(10),
        "the host is given up on",
        async || !counted(&fleet, &host).await,
    )
    .await;
    assert_eq!(compute.asked(), ["reset hosts-a1b2"]);
}

/// While its fence fails, a host is never given up on; once one succeeds,
/// it is.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_host_whose_fence_fails_is_kept_until_one_succeeds() {
    let (fleet, compute) = fleet(&[("hosts-a1b2", "RUNNING")]).await;
    let host = fleet.host("hosts-a1b2").await;
    compute.fail_resets.store(true, Ordering::SeqCst);
    host.renewing(false);
    until(past_lapse(&fleet), "a reset is tried", async || {
        compute
            .asked()
            .contains(&"failed reset hosts-a1b2".to_owned())
    })
    .await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(counted(&fleet, &host).await, "given up on without a fence");
    compute.fail_resets.store(false, Ordering::SeqCst);
    until(
        Duration::from_secs(10),
        "the host is given up on",
        async || !counted(&fleet, &host).await,
    )
    .await;
    assert!(compute.asked().contains(&"reset hosts-a1b2".to_owned()));
}

/// A host whose instance is already stopped needs no reset: it is given up
/// on, then started again to register afresh.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stopped_host_of_the_group_is_given_up_on_and_started_again() {
    let (fleet, compute) = fleet(&[("hosts-a1b2", "RUNNING")]).await;
    let host = fleet.host("hosts-a1b2").await;
    host.renewing(false);
    compute
        .instances
        .lock()
        .unwrap()
        .insert("hosts-a1b2".into(), "TERMINATED".into());
    until(past_lapse(&fleet), "the host is given up on", async || {
        !counted(&fleet, &host).await
    })
    .await;
    until(Duration::from_secs(5), "it is started", async || {
        compute.asked().contains(&"start hosts-a1b2".to_owned())
    })
    .await;
    assert!(
        !compute
            .asked()
            .iter()
            .any(|asked| asked.starts_with("reset")),
        "{:?}",
        compute.asked()
    );
}

/// A stopped instance of the group whose host is gone is started again by
/// the group's next look, as after a leader that stopped between giving up
/// on a host and starting it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stopped_instance_whose_host_is_gone_is_started() {
    let (_fleet, compute) = fleet(&[("hosts-a1b2", "RUNNING"), ("hosts-c3d4", "TERMINATED")]).await;
    until(Duration::from_secs(5), "it is started", async || {
        compute.asked().contains(&"start hosts-c3d4".to_owned())
    })
    .await;
}

/// A host outside the group has no instance to fence: it is given up on
/// once its lease ran out, as without a group.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_host_outside_the_group_is_given_up_on_without_a_fence() {
    let (fleet, compute) = fleet(&[("hosts-a1b2", "RUNNING")]).await;
    let host = fleet.host("other-1.example").await;
    host.renewing(false);
    until(past_lapse(&fleet), "the host is given up on", async || {
        !counted(&fleet, &host).await
    })
    .await;
    assert!(
        !compute
            .asked()
            .iter()
            .any(|asked| asked.contains("other-1")),
        "{:?}",
        compute.asked()
    );
}
