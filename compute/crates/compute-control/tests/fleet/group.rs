//! The leader against a fake Compute Engine API: it grows the host group
//! before spare memory runs out, and fences a lapsed host of the group
//! (resetting it, or finding it stopped and starting it again after) before
//! it gives up on it.

use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use compute_control::group::{Credentials, GcpGroup, ServiceAccountKey};
use compute_control::leader::Scaling;
use compute_control::store::Store as _;
use compute_fleet::{HostId, ScalePolicy};
use compute_protocol::fleet::Capacity;
use serde_json::{Value, json};

use super::support::{FakeHost, Fleet, OPERATOR_KEY, roomy, until};

const GROUP: &str = "projects/p/zones/z/instanceGroupManagers/hosts";
/// How long a member without a host counts as booting.
const BOOT_WITHIN: Duration = Duration::from_secs(3);

/// What the fake API holds and was asked.
#[derive(Default)]
struct Compute {
    target_size: AtomicU32,
    /// Instances by name, with their status.
    instances: Mutex<HashMap<String, String>>,
    /// What the group itself is doing to an instance, by name; `NONE` for
    /// one not named.
    actions: Mutex<HashMap<String, String>>,
    /// Instances the group lists but has deleted: an action on one fails
    /// as not found.
    deleted: Mutex<HashSet<String>>,
    /// What it was asked to do, in order: `resize N`, `reset NAME`,
    /// `start NAME`, `stop NAME`, `gone ACTION NAME`.
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
            let actions = compute.actions.lock().unwrap().clone();
            let managed: Vec<Value> = instances
                .iter()
                .map(|(name, status)| {
                    json!({
                        "instance": format!("https://compute.example/compute/v1/projects/p/zones/z/instances/{name}"),
                        "instanceStatus": status,
                        "currentAction": actions.get(name).map_or("NONE", String::as_str),
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
    if compute.deleted.lock().unwrap().contains(&name) {
        compute.note(format!("gone {action} {name}"));
        return StatusCode::NOT_FOUND.into_response();
    }
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
    fleet_with(instances, |_| {}).await
}

/// [`fleet`], with the fake group set up further by `setup` before the
/// leader first looks at it.
async fn fleet_with(
    instances: &[(&str, &str)],
    setup: impl FnOnce(&Compute),
) -> (Fleet, Arc<Compute>) {
    let compute = Arc::new(Compute::default());
    compute
        .target_size
        .store(u32::try_from(instances.len()).unwrap(), Ordering::SeqCst);
    *compute.instances.lock().unwrap() = instances
        .iter()
        .map(|(name, status)| ((*name).to_owned(), (*status).to_owned()))
        .collect();
    setup(&compute);
    let api = serve(Arc::clone(&compute)).await;
    let scaling = Scaling {
        group: Arc::new(GcpGroup::new(GROUP, &api, Credentials::Metadata(api.clone())).unwrap()),
        policy: ScalePolicy {
            spare_per_mille: 200,
            spare_largest: 2,
            largest_mib: 4096,
            largest_cpu_millis: 2000,
            host_memory_mib: 65_536,
            min_hosts: 1,
            max_hosts: 10,
        },
        every: Duration::from_millis(200),
        boot_within: BOOT_WITHIN,
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

/// A stopped instance the group is recreating itself, as its autohealing
/// does, is left to the group; once the group is done with it and it is
/// still stopped, it is started.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stopped_instance_the_group_is_recreating_is_left_to_it() {
    let (_fleet, compute) = fleet_with(
        &[("hosts-a1b2", "RUNNING"), ("hosts-c3d4", "TERMINATED")],
        |compute| {
            compute
                .actions
                .lock()
                .unwrap()
                .insert("hosts-c3d4".into(), "RECREATING".into());
        },
    )
    .await;
    // Several of the group's looks.
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(
        !compute
            .asked()
            .iter()
            .any(|asked| asked.contains("hosts-c3d4")),
        "{:?}",
        compute.asked()
    );
    compute.actions.lock().unwrap().remove("hosts-c3d4");
    until(Duration::from_secs(5), "it is started", async || {
        compute.asked().contains(&"start hosts-c3d4".to_owned())
    })
    .await;
}

/// A stopped instance the group deletes before the leader's start reaches
/// it is no failure, and once it has stood without a host past the boot
/// allowance it no longer counts as coming: the group grows past it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stopped_instance_deleted_before_its_start_keeps_the_group_growing() {
    let (fleet, compute) = fleet_with(
        &[("hosts-a1b2", "RUNNING"), ("hosts-c3d4", "TERMINATED")],
        |compute| {
            compute.deleted.lock().unwrap().insert("hosts-c3d4".into());
        },
    )
    .await;
    let host = fleet.host("hosts-a1b2").await;
    until(Duration::from_secs(5), "its start is tried", async || {
        compute
            .asked()
            .contains(&"gone start hosts-c3d4".to_owned())
    })
    .await;
    host.set_capacity(Capacity {
        memory_free_mib: 1024,
        ..roomy()
    });
    until(
        BOOT_WITHIN + Duration::from_secs(5),
        "the group grows",
        async || compute.asked().contains(&"resize 3".to_owned()),
    )
    .await;
    assert!(
        !compute.asked().contains(&"resize 2".to_owned()),
        "the stalled member keeps its place: {:?}",
        compute.asked()
    );
}

/// A member the group never gets running, as when it cannot create the
/// instance, counts as coming only for the boot allowance; past it the
/// group grows around it rather than waiting on it for good.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_member_that_never_registers_stops_counting_as_coming() {
    let (fleet, compute) = fleet_with(
        &[("hosts-a1b2", "RUNNING"), ("hosts-c3d4", "PROVISIONING")],
        |compute| {
            compute
                .actions
                .lock()
                .unwrap()
                .insert("hosts-c3d4".into(), "CREATING".into());
        },
    )
    .await;
    let host = fleet.host("hosts-a1b2").await;
    host.set_capacity(Capacity {
        memory_free_mib: 1024,
        ..roomy()
    });
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(
        !compute
            .asked()
            .iter()
            .any(|asked| asked.starts_with("resize")),
        "a booting member counts as coming: {:?}",
        compute.asked()
    );
    until(
        BOOT_WITHIN + Duration::from_secs(5),
        "the group grows past it",
        async || compute.asked().contains(&"resize 3".to_owned()),
    )
    .await;
    assert!(
        !compute
            .asked()
            .iter()
            .any(|asked| asked.contains("hosts-c3d4")),
        "left to the group: {:?}",
        compute.asked()
    );
}

/// A registered host the group's listing does not name yet takes the
/// place asked for: it is not counted again as coming, so the group grows
/// when that host runs short.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_host_the_listing_does_not_name_yet_counts_once() {
    let (fleet, compute) = fleet_with(&[], |compute| {
        compute.target_size.store(1, Ordering::SeqCst);
    })
    .await;
    let host = fleet.host("hosts-a1b2").await;
    host.set_capacity(Capacity {
        memory_free_mib: 1024,
        ..roomy()
    });
    until(Duration::from_secs(5), "the group grows", async || {
        compute.asked().contains(&"resize 2".to_owned())
    })
    .await;
}

/// A draining host and a stalled member each keep their place in the
/// group: growth asks for the usable host it is short on top of both.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn growth_counts_the_places_draining_and_stalled_hosts_hold() {
    let (fleet, compute) = fleet_with(
        &[
            ("hosts-a1b2", "RUNNING"),
            ("hosts-c3d4", "RUNNING"),
            ("hosts-e5f6", "PROVISIONING"),
        ],
        |compute| {
            compute
                .actions
                .lock()
                .unwrap()
                .insert("hosts-e5f6".into(), "CREATING".into());
        },
    )
    .await;
    let host = fleet.host("hosts-a1b2").await;
    let _draining = fleet.host("hosts-c3d4").await;
    let (status, drained) = fleet
        .call(
            reqwest::Method::POST,
            "/v1/hosts/hosts-c3d4/drain",
            Some(OPERATOR_KEY),
            None,
        )
        .await;
    assert_eq!(status, 200, "{drained}");
    host.set_capacity(Capacity {
        memory_free_mib: 1024,
        ..roomy()
    });
    until(
        BOOT_WITHIN + Duration::from_secs(5),
        "the group grows past both",
        async || compute.asked().contains(&"resize 4".to_owned()),
    )
    .await;
    assert!(
        !compute.asked().contains(&"resize 3".to_owned()),
        "{:?}",
        compute.asked()
    );
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

/// A key made for the tests alone (PKCS #1 DER in base64), the one the
/// identity tests sign with: it signs nothing else.
const TEST_KEY: &str = include_str!("../../src/testdata/token-signer.rsa.b64");

/// DER's length of `len` bytes.
fn der_len(len: usize) -> Vec<u8> {
    match u16::try_from(len) {
        Ok(short) if short < 0x80 => vec![u8::try_from(short).unwrap()],
        Ok(long) if long <= 0xff => vec![0x81, u8::try_from(long).unwrap()],
        Ok(long) => {
            let [high, low] = long.to_be_bytes();
            vec![0x82, high, low]
        }
        Err(_) => unreachable!("a test key"),
    }
}

/// The test key in PKCS #8, as Google's key files hold one.
fn test_key_pkcs8() -> Vec<u8> {
    use base64::Engine as _;
    let pkcs1 = base64::engine::general_purpose::STANDARD
        .decode(TEST_KEY.split_whitespace().collect::<String>())
        .unwrap();
    let mut body = vec![0x02, 0x01, 0x00];
    // rsaEncryption, no parameters.
    body.extend([
        0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
    ]);
    body.push(0x04);
    body.extend(der_len(pkcs1.len()));
    body.extend(pkcs1);
    let mut der = vec![0x30];
    der.extend(der_len(body.len()));
    der.extend(body);
    der
}

/// A key file as `gcloud iam service-accounts keys create` writes one,
/// whose token endpoint is `token_uri`.
fn key_file(token_uri: &str) -> Vec<u8> {
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(test_key_pkcs8());
    let lines: Vec<&str> = encoded
        .as_bytes()
        .chunks(64)
        .map(|line| std::str::from_utf8(line).unwrap())
        .collect();
    let pem = format!(
        "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
        lines.join("\n")
    );
    serde_json::to_vec(&json!({
        "type": "service_account",
        "project_id": "p",
        "private_key_id": "key-1",
        "private_key": pem,
        "client_email": "control@p.iam.gserviceaccount.com",
        "client_id": "1",
        "token_uri": token_uri,
    }))
    .unwrap()
}

/// What the fake token endpoint was sent and gave out.
#[derive(Default)]
struct Grants {
    /// Token requests whose assertion verified, with its claims.
    granted: Mutex<Vec<Value>>,
}

/// Grants a token for an assertion the test key signed, and only then.
async fn grant(State(grants): State<Arc<Grants>>, body: String) -> Response {
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let form: HashMap<String, String> = form_urlencoded::parse(body.as_bytes())
        .into_owned()
        .collect();
    if form.get("grant_type").map(String::as_str)
        != Some("urn:ietf:params:oauth:grant-type:jwt-bearer")
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let assertion = &form["assertion"];
    let (signed, signature) = assertion.rsplit_once('.').unwrap();
    let key = ring::signature::RsaKeyPair::from_pkcs8(&test_key_pkcs8()).unwrap();
    let public = ring::signature::UnparsedPublicKey::new(
        &ring::signature::RSA_PKCS1_2048_8192_SHA256,
        ring::signature::KeyPair::public_key(&key).as_ref().to_vec(),
    );
    if public
        .verify(
            signed.as_bytes(),
            &URL_SAFE_NO_PAD.decode(signature).unwrap(),
        )
        .is_err()
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let (header, claims) = signed.split_once('.').unwrap();
    let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).unwrap()).unwrap();
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(claims).unwrap()).unwrap();
    assert_eq!(
        header,
        json!({"alg": "RS256", "typ": "JWT", "kid": "key-1"})
    );
    grants.granted.lock().unwrap().push(claims);
    Json(json!({ "access_token": "keyed", "expires_in": 3600, "token_type": "Bearer" }))
        .into_response()
}

/// Answers the group only with the token the key got.
async fn describe_keyed(headers: axum::http::HeaderMap) -> Response {
    if headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        != Some("Bearer keyed")
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(json!({ "targetSize": 1, "baseInstanceName": "hosts" })).into_response()
}

/// A service off Google Cloud signs its own token requests with a service
/// account's key, for the Compute Engine API, and calls the API with the
/// token it got, until that nears its expiry.
#[tokio::test]
async fn a_service_off_google_cloud_gets_its_tokens_with_a_key() {
    let grants = Arc::new(Grants::default());
    let router = axum::Router::new()
        .route("/token", post(grant))
        .route(&format!("/compute/v1/{GROUP}"), get(describe_keyed))
        .with_state(Arc::clone(&grants));
    let listener = tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .await
        .unwrap();
    let api = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

    let token_uri = format!("{api}/token");
    let key = ServiceAccountKey::from_json(&key_file(&token_uri)).unwrap();
    assert!(!format!("{key:?}").contains("PRIVATE"), "{key:?}");
    let group = GcpGroup::new(GROUP, &api, Credentials::Key(Box::new(key))).unwrap();
    for _ in 0..2 {
        let described = group.describe().await.unwrap();
        assert_eq!(
            (described.target_size, described.base_instance_name.as_str()),
            (1, "hosts")
        );
    }
    let granted = grants.granted.lock().unwrap().clone();
    assert_eq!(granted.len(), 1, "one token, used until it nears expiry");
    let claims = &granted[0];
    assert_eq!(claims["iss"], "control@p.iam.gserviceaccount.com");
    assert_eq!(claims["scope"], "https://www.googleapis.com/auth/compute");
    assert_eq!(claims["aud"], token_uri.as_str());
    let issued = claims["iat"].as_u64().unwrap();
    assert_eq!(claims["exp"].as_u64().unwrap(), issued + 3600);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    assert!(issued.abs_diff(now) < 60, "{issued} vs {now}");
}

/// Only a service account's key file is taken: other credential files,
/// such as workload identity federation's, are refused when the service
/// starts, not on the first fence.
#[test]
fn other_credential_files_are_refused() {
    let mut file: Value =
        serde_json::from_slice(&key_file("https://oauth2.example/token")).unwrap();
    file["type"] = "external_account".into();
    let error = ServiceAccountKey::from_json(&serde_json::to_vec(&file).unwrap()).unwrap_err();
    assert!(error.to_string().contains("external_account"), "{error:#}");
    file["type"] = "service_account".into();
    file["private_key"] = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n".into();
    assert!(ServiceAccountKey::from_json(&serde_json::to_vec(&file).unwrap()).is_err());
    assert!(ServiceAccountKey::from_json(b"{}").is_err());
}
