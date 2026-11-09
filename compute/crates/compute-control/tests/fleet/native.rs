//! Sandboxes that run Opengeni's agent through the native API: creates
//! named by a request id, the init the guest is given, and the agent-link
//! tickets and host tokens the service signs.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use compute_control::link::Links;
use compute_guest::GATEWAY_PORT;
use compute_protocol::fleet::{Registered, Verdict};
use compute_protocol::host::{ErrorCode, Reply, Request};
use compute_protocol::link::AgentLink;
use ring::rand::SystemRandom;
use ring::signature::{ED25519, Ed25519KeyPair, UnparsedPublicKey};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _};

use super::support::{Act, FakeHost, Fleet, OTHER_KEY, TEAM, declare_gone, given_up, id};

const GATEWAY: &str = "wss://og.example/agent-link";

async fn linked_fleet() -> Fleet {
    let key = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
    let links = Links::new(
        key.as_ref(),
        &[],
        "fleet".into(),
        BTreeMap::from([(TEAM.to_owned(), GATEWAY.to_owned())]),
    )
    .unwrap();
    Fleet::start_with(None, |settings| settings.links = Some(Arc::new(links))).await
}

/// The inits a host's guests were given, in order.
type Inits = Arc<Mutex<Vec<Value>>>;

/// Has `host`'s guests take every init and answer `ok`.
fn take_inits(host: &FakeHost) -> Inits {
    let inits = Inits::default();
    let seen = Arc::clone(&inits);
    host.guest(Arc::new(move |_, port, mut stream| {
        let seen = Arc::clone(&seen);
        Box::pin(async move {
            assert_eq!(port, GATEWAY_PORT);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            let init = line.trim_end().strip_prefix("init ").unwrap();
            seen.lock()
                .unwrap()
                .push(serde_json::from_str(init).unwrap());
            stream.get_mut().write_all(b"ok\n").await.unwrap();
        })
    }));
    inits
}

fn create_body(request_id: &str, vcpus: u8) -> Value {
    json!({
        "request_id": request_id,
        "vcpus": vcpus,
        "memory_mib": 256,
        "metadata": {"opengeni.lease": "l1"},
        "init": {
            "env_vars": {"A": "1"},
            "default_workdir": "/workspace",
            "agent": {
                "workspace_id": "ws-1",
                "agent_id": "agent-1",
                "workspace_root": "/workspace",
                "desktop": true
            }
        }
    })
}

/// The links in the creates and adopts `host` was sent, in order.
fn links_sent(host: &FakeHost) -> Vec<AgentLink> {
    host.seen()
        .into_iter()
        .filter_map(|seen| match seen.envelope.request {
            Request::Create { config, .. } | Request::Adopt { config, .. } => config.link,
            _ => None,
        })
        .collect()
}

/// Checks a token against the keys the API lists, as a gateway would, and
/// gives its claims.
async fn verify(fleet: &Fleet, token: &str) -> Value {
    let (status, keys) = fleet.get("/v1/link/keys").await;
    assert_eq!(status, 200, "{keys}");
    assert_eq!(keys["team"], TEAM);
    let (signed, signature) = token.rsplit_once('.').unwrap();
    let header: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(signed.split_once('.').unwrap().0)
            .unwrap(),
    )
    .unwrap();
    let key = keys["keys"]
        .as_array()
        .unwrap()
        .iter()
        .find(|key| key["kid"] == header["kid"])
        .unwrap();
    UnparsedPublicKey::new(
        &ED25519,
        URL_SAFE_NO_PAD.decode(key["x"].as_str().unwrap()).unwrap(),
    )
    .verify(
        signed.as_bytes(),
        &URL_SAFE_NO_PAD.decode(signature).unwrap(),
    )
    .unwrap();
    serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(signed.split_once('.').unwrap().1)
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_agent_sandbox_is_given_its_init_and_a_ticket_for_each_host_it_lives_on() {
    let fleet = linked_fleet().await;
    let a = fleet.host("host-a.example").await;
    let inits = take_inits(&a);

    let (status, created) = fleet.post("/v1/sandboxes", create_body("lease-1", 1)).await;
    assert_eq!(status, 201, "{created}");
    assert_eq!(
        created["agent"],
        json!({"workspace": "ws-1", "agent": "agent-1"})
    );
    assert!(created["config"].get("link").is_none(), "{created}");
    let sandbox = created["id"].as_str().unwrap().to_owned();
    assert_eq!(
        inits.lock().unwrap().clone(),
        vec![json!({
            "envVars": {"A": "1"},
            "defaultWorkdir": "/workspace",
            "agent": {
                "workspaceId": "ws-1",
                "agentId": "agent-1",
                "workspaceRoot": "/workspace",
                "desktop": true
            }
        })]
    );
    let sent = links_sent(&a);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].gateway, GATEWAY);
    let ticket = verify(&fleet, &sent[0].ticket).await;
    assert_eq!(
        ticket,
        json!({
            "typ": "compute-sandbox", "iss": "fleet", "aud": GATEWAY, "sub": sandbox,
            "host": "host-a.example", "epoch": 1, "team": TEAM,
            "workspace": "ws-1", "agent": "agent-1"
        })
    );
    assert_eq!(created["owner_epoch"], 1);

    // A move gives the new host its own ticket, under the epoch it adopts
    // under: one past the hand-off's, which is one past the create's.
    let b = fleet.host("host-b.example").await;
    let (status, moved) = fleet
        .post(
            &format!("/v1/sandboxes/{sandbox}/move"),
            json!({"to": "host-b.example"}),
        )
        .await;
    assert_eq!(status, 200, "{moved}");
    assert_eq!(moved["host"], "host-b.example");
    let adopted = links_sent(&b);
    assert_eq!(adopted.len(), 1);
    let ticket = verify(&fleet, &adopted[0].ticket).await;
    assert_eq!(ticket["host"], "host-b.example");
    assert_eq!(ticket["epoch"], moved["owner_epoch"]);
    assert_eq!(ticket["epoch"], 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_request_id_answers_its_sandbox_refuses_another_create_and_is_gone_after_a_delete() {
    let fleet = linked_fleet().await;
    let a = fleet.host("host-a.example").await;
    let inits = take_inits(&a);

    let (status, first) = fleet.post("/v1/sandboxes", create_body("lease-1", 1)).await;
    assert_eq!(status, 201, "{first}");
    let (status, again) = fleet.post("/v1/sandboxes", create_body("lease-1", 1)).await;
    assert_eq!(status, 201, "{again}");
    assert_eq!(again["id"], first["id"]);
    assert_eq!(
        a.ops().iter().filter(|op| **op == "create").count(),
        1,
        "a retry makes no second sandbox"
    );
    assert_eq!(
        inits.lock().unwrap().len(),
        2,
        "a retry gives the init again"
    );

    let (status, refused) = fleet.post("/v1/sandboxes", create_body("lease-1", 2)).await;
    assert_eq!(
        (status, refused["code"].as_str()),
        (409, Some("request_mismatch"))
    );
    let (status, found) = fleet.get("/v1/requests/lease-1").await;
    assert_eq!((status, &found["id"]), (200, &first["id"]));
    let (status, missing) = fleet.get("/v1/requests/lease-9").await;
    assert_eq!((status, missing["code"].as_str()), (404, Some("not_found")));

    let sandbox = first["id"].as_str().unwrap();
    let (status, _) = fleet.delete(&format!("/v1/sandboxes/{sandbox}")).await;
    assert_eq!(status, 204);
    assert_eq!(a.holds(id(sandbox)), None);
    let (status, gone) = fleet.post("/v1/sandboxes", create_body("lease-1", 1)).await;
    assert_eq!((status, gone["code"].as_str()), (410, Some("request_gone")));
    let (status, _) = fleet.get("/v1/requests/lease-1").await;
    assert_eq!(status, 410);
    // Another team's request ids are its own.
    let (status, other) = fleet
        .call(
            reqwest::Method::GET,
            "/v1/requests/lease-1",
            Some(OTHER_KEY),
            None,
        )
        .await;
    assert_eq!(status, 404, "{other}");
}

/// A create its host failed leaves nothing anywhere. Retrying it asks the
/// host to wake it once, finds it nowhere and creates it again, rather
/// than asking again every moment until the wake gives up; a wake of it
/// answers at once that there is no such sandbox.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_create_its_host_failed_is_created_again_on_retry_not_woken_until_the_wake_gives_up() {
    let fleet = linked_fleet().await;
    let a = fleet.host("host-a.example").await;
    let _inits = take_inits(&a);
    let failing = Arc::new(AtomicBool::new(true));
    let fails = Arc::clone(&failing);
    a.behave(move |envelope| match envelope.request {
        Request::Create { .. } if fails.load(Ordering::SeqCst) => Act::Reply(Reply::Error {
            message: "the image could not be fetched".into(),
            code: ErrorCode::Internal,
        }),
        _ => Act::Ordinary,
    });
    let count = |op: &str| a.ops().iter().filter(|seen| **seen == op).count();

    let (status, failed) = fleet.post("/v1/sandboxes", create_body("lease-1", 1)).await;
    assert_eq!(
        (status, failed["code"].as_str()),
        (502, Some("host")),
        "{failed}"
    );
    let (status, row) = fleet.get("/v1/requests/lease-1").await;
    assert_eq!(status, 200, "{row}");
    let sandbox = row["id"].as_str().unwrap().to_owned();

    // The retry, as a client makes it, while the host still fails: one
    // wake, one more create, and the host's failure at once.
    let started = Instant::now();
    let (status, again) = fleet.post("/v1/sandboxes", create_body("lease-1", 1)).await;
    assert_eq!(
        (status, again["code"].as_str()),
        (502, Some("host")),
        "{again}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "answered after {:?}",
        started.elapsed()
    );
    assert_eq!((count("create"), count("wake")), (2, 1), "{:?}", a.ops());

    // Woken by id, it is not found, after one ask.
    let (status, missing) = fleet
        .post(&format!("/v1/sandboxes/{sandbox}/wake"), json!({}))
        .await;
    assert_eq!((status, missing["code"].as_str()), (404, Some("not_found")));
    assert_eq!(count("wake"), 2, "{:?}", a.ops());

    // Once the host can create it, the retry makes it, under the same id.
    failing.store(false, Ordering::SeqCst);
    let (status, made) = fleet.post("/v1/sandboxes", create_body("lease-1", 1)).await;
    assert_eq!(status, 201, "{made}");
    assert_eq!(made["id"], sandbox.as_str());
    assert_eq!(count("create"), 3, "{:?}", a.ops());
    assert!(a.holds(id(&sandbox)).is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_agent_sandbox_needs_its_team_to_have_a_link() {
    let fleet = linked_fleet().await;
    let _a = fleet.host("host-a.example").await;
    let (status, refused) = fleet
        .call(
            reqwest::Method::POST,
            "/v1/sandboxes",
            Some(OTHER_KEY),
            Some(create_body("lease-1", 1)),
        )
        .await;
    assert_eq!((status, refused["code"].as_str()), (400, Some("invalid")));
    let mut bad = create_body("lease-2", 1);
    bad["init"]["agent"]["agent_id"] = json!("a.b");
    let (status, refused) = fleet.post("/v1/sandboxes", bad).await;
    assert_eq!((status, refused["code"].as_str()), (400, Some("invalid")));
    let (status, refused) = fleet.post("/v1/sandboxes", create_body("a b", 1)).await;
    assert_eq!((status, refused["code"].as_str()), (400, Some("invalid")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hosts_get_link_tokens_only_for_their_own_name_and_known_gateways() {
    let fleet = linked_fleet().await;
    let a = fleet.host("host-a.example").await;
    let (status, tokens) = a.link_tokens("host-a.example", &[GATEWAY]).await;
    assert_eq!(status, 200, "{tokens}");
    let token = &tokens["tokens"][0];
    assert_eq!(token["gateway"], GATEWAY);
    let claims = verify(&fleet, token["token"].as_str().unwrap()).await;
    assert_eq!(claims["typ"], "compute-host");
    assert_eq!(claims["sub"], "host-a.example");
    assert_eq!(claims["aud"], GATEWAY);
    assert_eq!(
        claims["exp"].as_u64().unwrap() - claims["iat"].as_u64().unwrap(),
        3600
    );
    let (status, _) = a.link_tokens("host-b.example", &[GATEWAY]).await;
    assert_eq!(status, 403, "a host asks only under its own name");
    let (status, _) = a
        .link_tokens("host-a.example", &["wss://attacker.example"])
        .await;
    assert_eq!(status, 403, "only gateways a team uses are signed for");
}

/// A host declared gone gets back, when it registers again, the agent
/// sandbox nobody took meanwhile under a raised owner epoch, with the
/// ticket for that epoch in the ruling; a sandbox with no agent gets none.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_host_registering_again_is_given_its_kept_sandboxes_tickets_for_their_new_epochs() {
    let fleet = linked_fleet().await;
    let a = fleet.host("host-a.example").await;
    let _inits = take_inits(&a);
    let (status, created) = fleet.post("/v1/sandboxes", create_body("lease-1", 1)).await;
    assert_eq!(status, 201, "{created}");
    let agent_sandbox = created["id"].as_str().unwrap().to_owned();
    let plain = fleet.create(json!({})).await;

    a.renewing(false);
    given_up(&fleet, &a).await;
    declare_gone(&fleet, &a).await;
    let Registered::Registered { rulings, .. } = a.register().await else {
        panic!("a host declared gone registers afresh");
    };
    let ruled = |sandbox: &str| {
        rulings
            .iter()
            .find(|ruling| ruling.id == id(sandbox))
            .cloned()
            .unwrap()
    };
    let kept = ruled(&agent_sandbox);
    let Verdict::Keep { owner_epoch } = kept.verdict else {
        panic!("nobody took it: {kept:?}");
    };
    assert!(owner_epoch > 1, "under a raised epoch");
    let link = kept.link.expect("the kept agent sandbox's new ticket");
    assert_eq!(link.gateway, GATEWAY);
    let ticket = verify(&fleet, &link.ticket).await;
    assert_eq!(ticket["host"], "host-a.example");
    assert_eq!(ticket["epoch"], owner_epoch);
    assert_eq!(ticket["sub"], agent_sandbox.as_str());
    assert_eq!(ruled(&plain).link, None);

    // The same attempt answered again carries the same ticket.
    let Registered::Registered { rulings: again, .. } = a.register_again().await else {
        panic!("the same attempt is answered again");
    };
    let again = again
        .into_iter()
        .find(|ruling| ruling.id == id(&agent_sandbox))
        .unwrap();
    assert_eq!(again.link.unwrap().ticket, link.ticket);
}
