//! The E2B front door against fake hosts and a fake guest: its REST API,
//! the lifecycle it records, and sandbox traffic through the guest's
//! gateway.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use compute_control::e2b::{self, Front, Settings};
use compute_control::store::{MemoryStore, Store as _};
use compute_guest::{ENVD_PORT, GATEWAY_PORT};
use compute_protocol::host::{Id, LevelName, Reply, Request};
use http_body_util::{Full, StreamBody};
use hyper::body::Frame;
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _};

use crate::support::{Act, FakeHost, Fleet, GuestStream, KEY, OTHER_KEY, until};

/// What the fake guest saw.
#[derive(Default)]
struct Seen {
    /// Every `init` given, as JSON.
    inits: Mutex<Vec<Value>>,
    /// Gateway streams opened to each port.
    dials: Mutex<HashMap<u16, usize>>,
    /// Requests served.
    requests: AtomicUsize,
    /// Streaming responses still open.
    streams: AtomicUsize,
}

/// Counts a streaming response while it is open.
struct Open(Arc<Seen>);

impl Drop for Open {
    fn drop(&mut self) {
        self.0.streams.fetch_sub(1, Ordering::SeqCst);
    }
}

type Body = http_body_util::combinators::BoxBody<Bytes, Infallible>;

fn full(text: &str) -> Body {
    use http_body_util::BodyExt as _;
    Full::new(Bytes::from(text.to_owned())).boxed()
}

/// envd on 49983 and a user server on 8080: `/stream` answers a tick every
/// 50 ms for as long as the caller reads; anything else names the port
/// and the access token it was sent.
fn http(
    seen: &Arc<Seen>,
    port: u16,
    request: &hyper::Request<hyper::body::Incoming>,
) -> hyper::Response<Body> {
    use http_body_util::BodyExt as _;
    seen.requests.fetch_add(1, Ordering::SeqCst);
    if request.uri().path() == "/stream" {
        seen.streams.fetch_add(1, Ordering::SeqCst);
        let open = Open(Arc::clone(seen));
        let ticks = futures::stream::unfold(open, |open| async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            Some((
                Ok::<_, Infallible>(Frame::data(Bytes::from_static(b"tick\n"))),
                open,
            ))
        });
        return hyper::Response::new(StreamBody::new(ticks).boxed());
    }
    let token = request
        .headers()
        .get("x-access-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    hyper::Response::new(full(&format!("port {port} token {token}")))
}

/// The guest's gateway: `init` and `tcp` headers, as compute-guest answers
/// them.
async fn gateway(seen: Arc<Seen>, mut stream: GuestStream) {
    let mut line = String::new();
    if stream.read_line(&mut line).await.unwrap_or(0) == 0 {
        return;
    }
    let line = line.trim_end();
    if let Some(init) = line.strip_prefix("init ") {
        seen.inits
            .lock()
            .unwrap()
            .push(serde_json::from_str(init).unwrap());
        let _ = stream.get_mut().write_all(b"ok\n").await;
        return;
    }
    let port: u16 = line.strip_prefix("tcp ").unwrap().parse().unwrap();
    *seen.dials.lock().unwrap().entry(port).or_default() += 1;
    if port != ENVD_PORT && port != 8080 {
        let _ = stream
            .get_mut()
            .write_all(b"error connection refused\n")
            .await;
        return;
    }
    stream.get_mut().write_all(b"ok\n").await.unwrap();
    let service = hyper::service::service_fn(move |request| {
        std::future::ready(Ok::<_, Infallible>(http(&seen, port, &request)))
    });
    let _ = hyper::server::conn::http1::Builder::new()
        .serve_connection(TokioIo::new(stream), service)
        .await;
}

/// What the fake host's sandboxes do, for its status.
#[derive(Default)]
struct Levels {
    at: HashMap<Id, LevelName>,
    holds: HashMap<Id, usize>,
    log: Vec<String>,
}

/// A host whose sandboxes run on connects and wakes, sleep as asked,
/// keep holds, report all of it in their status, and run the fake guest.
async fn host(fleet: &Fleet, seen: &Arc<Seen>) -> (FakeHost, Arc<Mutex<Levels>>) {
    let host = fleet.host("h1").await;
    let levels = Arc::new(Mutex::new(Levels::default()));
    let state = Arc::clone(&levels);
    host.behave(move |envelope| {
        let mut state = state.lock().unwrap();
        match &envelope.request {
            Request::Create { id, .. } | Request::Wake { id, .. } | Request::Connect { id, .. } => {
                state.at.insert(*id, LevelName::Running);
            }
            Request::Sleep { id, level, .. } => {
                state.at.insert(*id, *level);
                state.log.push(format!("sleep {level:?}"));
            }
            Request::Hold {
                id, hold, ttl_ms, ..
            } => {
                *state.holds.entry(*id).or_default() = 1;
                state.log.push(format!("hold {hold} {ttl_ms:?}"));
                return Act::Reply(Reply::Done);
            }
            Request::Release { id, hold, .. } => {
                state.holds.insert(*id, 0);
                state.log.push(format!("release {hold}"));
                return Act::Reply(Reply::Done);
            }
            Request::Status => {
                let sandboxes: Vec<Value> = state
                    .at
                    .iter()
                    .map(|(id, level)| {
                        json!({
                            "id": id.to_string(), "generation": 1, "revision": 1,
                            "level": level, "durability": "local", "memory_saved": true,
                            "step": null, "holds": state.holds.get(id).copied().unwrap_or(0),
                            "resident_bytes": null, "broken": false,
                        })
                    })
                    .collect();
                let status =
                    json!({ "sandboxes": sandboxes, "steps": [], "available_memory": null });
                return Act::Reply(Reply::Status(Box::new(
                    serde_json::from_value(status).unwrap(),
                )));
            }
            Request::Remove { id, .. } => {
                state.at.remove(id);
            }
            _ => {}
        }
        Act::Ordinary
    });
    let guest_seen = Arc::clone(seen);
    host.guest(Arc::new(move |_, port, stream| {
        let seen = Arc::clone(&guest_seen);
        Box::pin(async move {
            if port == GATEWAY_PORT {
                gateway(seen, stream).await;
            }
        })
    }));
    (host, levels)
}

/// A front door to `fleet` with a quick sweeper.
struct Door {
    address: SocketAddr,
    front: Arc<Front<MemoryStore>>,
    http: reqwest::Client,
}

impl Door {
    async fn start(fleet: &Fleet) -> Self {
        let settings = Settings {
            pause_within: Duration::from_secs(5),
            sweep_every: Duration::from_millis(100),
            ..Settings::default()
        };
        let front = Front::new(Arc::clone(&fleet.running.service), settings);
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let router = e2b::router(Arc::clone(&front));
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        tokio::spawn(e2b::ops::sweep(Arc::clone(&front)));
        Self {
            address,
            front,
            http: reqwest::Client::new(),
        }
    }

    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        key: &str,
        body: Option<Value>,
    ) -> (u16, Value) {
        let mut request = self
            .http
            .request(method, format!("http://{}{path}", self.address))
            .header("x-api-key", key);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        (
            status,
            serde_json::from_str(&text).unwrap_or(Value::String(text)),
        )
    }

    async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        self.call(reqwest::Method::POST, path, KEY, Some(body))
            .await
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        self.call(reqwest::Method::GET, path, KEY, None).await
    }

    async fn create(&self, body: Value) -> Value {
        let (status, sandbox) = self.post("/v2/sandboxes", body).await;
        assert_eq!(status, 201, "create: {sandbox}");
        sandbox
    }

    /// A request to `port` in sandbox `id`, named by E2B's headers.
    fn traffic(&self, id: &str, port: u16, path: &str) -> reqwest::RequestBuilder {
        self.http
            .get(format!("http://{}{path}", self.address))
            .header("e2b-sandbox-id", id)
            .header("e2b-sandbox-port", port.to_string())
    }

    async fn text(&self, request: reqwest::RequestBuilder) -> (u16, String) {
        let response = request.send().await.unwrap();
        (response.status().as_u16(), response.text().await.unwrap())
    }
}

async fn fleet_with_guest() -> (Fleet, FakeHost, Arc<Mutex<Levels>>, Arc<Seen>, Door) {
    let fleet = Fleet::start().await;
    let seen = Arc::new(Seen::default());
    let (host, levels) = host(&fleet, &seen).await;
    let door = Door::start(&fleet).await;
    (fleet, host, levels, seen, door)
}

#[tokio::test]
async fn an_e2b_sandbox_is_created_listed_for_its_team_and_killed() {
    let (_fleet, _host, levels, seen, door) = fleet_with_guest().await;
    let sandbox = door
        .create(json!({
            "templateID": "base", "timeout": 120, "metadata": {"user": "a b"},
            "envVars": {"GREETING": "hi"}, "secure": true,
        }))
        .await;
    let id = sandbox["sandboxID"].as_str().unwrap().to_owned();
    let token = sandbox["envdAccessToken"].as_str().unwrap().to_owned();
    assert_eq!(sandbox["templateID"], "base");
    assert_eq!(sandbox["domain"], "localhost");
    assert_eq!(sandbox["envdVersion"], e2b::ENVD_VERSION);
    assert_eq!(token.len(), 64);
    assert_eq!(sandbox["trafficAccessToken"], Value::Null);
    // envd got the sandbox's environment and token through the gateway.
    assert_eq!(
        *seen.inits.lock().unwrap(),
        [json!({"envVars": {"GREETING": "hi"}, "accessToken": token})]
    );

    let (status, detail) = door.get(&format!("/sandboxes/{id}")).await;
    assert_eq!(status, 200, "{detail}");
    assert_eq!(detail["state"], "running");
    assert_eq!(detail["metadata"], json!({"user": "a b"}));
    assert_eq!(
        detail["lifecycle"],
        json!({"autoResume": false, "onTimeout": "kill"})
    );
    // The list filter, encoded as the SDK encodes it.
    let (status, listed) = door
        .get("/v2/sandboxes?metadata=user%3Da%252520b&state=running")
        .await;
    assert_eq!(status, 200);
    assert_eq!(listed.as_array().unwrap().len(), 1, "{listed}");
    let (_, listed) = door.get("/v2/sandboxes?metadata=user%3Dnobody").await;
    assert_eq!(listed, json!([]));
    // Another team does not see it.
    let (status, _) = door
        .call(
            reqwest::Method::GET,
            &format!("/sandboxes/{id}"),
            OTHER_KEY,
            None,
        )
        .await;
    assert_eq!(status, 404);

    let (status, _) = door
        .call(
            reqwest::Method::DELETE,
            &format!("/sandboxes/{id}"),
            KEY,
            None,
        )
        .await;
    assert_eq!(status, 204);
    let (status, _) = door.get(&format!("/sandboxes/{id}")).await;
    assert_eq!(status, 404);
    let (status, _) = door
        .call(
            reqwest::Method::DELETE,
            &format!("/sandboxes/{id}"),
            KEY,
            None,
        )
        .await;
    assert_eq!(status, 404);
    assert!(!levels.lock().unwrap().at.contains_key(&id.parse().unwrap()));
}

#[tokio::test]
async fn a_pause_completes_at_saved_and_connect_resumes() {
    let (_fleet, _host, levels, _seen, door) = fleet_with_guest().await;
    let sandbox = door
        .create(json!({"templateID": "base", "timeout": 120}))
        .await;
    let id = sandbox["sandboxID"].as_str().unwrap().to_owned();
    let token = sandbox["envdAccessToken"].as_str().unwrap().to_owned();
    // A pause completes once the host reports the sandbox saved.
    let (status, body) = door
        .post(&format!("/sandboxes/{id}/pause"), json!({}))
        .await;
    assert_eq!(status, 204, "{body}");
    assert!(
        levels
            .lock()
            .unwrap()
            .log
            .contains(&"sleep Saved".to_owned())
    );
    let (_, detail) = door.get(&format!("/sandboxes/{id}")).await;
    assert_eq!(detail["state"], "paused");
    let (status, _) = door
        .post(&format!("/sandboxes/{id}/pause"), json!({}))
        .await;
    assert_eq!(status, 409);
    // Traffic does not wake a paused sandbox without auto-resume.
    let (status, body) = door.text(door.traffic(&id, ENVD_PORT, "/health")).await;
    assert_eq!(status, 502, "{body}");
    assert!(body.contains("The sandbox was not found"), "{body}");

    // Connect resumes it (201), then finds it running (200), and never
    // moves its timeout earlier.
    let (status, resumed) = door
        .post(
            &format!("/v2/sandboxes/{id}/connect"),
            json!({"timeout": 60}),
        )
        .await;
    assert_eq!(status, 201, "{resumed}");
    assert_eq!(resumed["envdAccessToken"], token);
    let (_, detail) = door.get(&format!("/sandboxes/{id}")).await;
    assert_eq!(detail["state"], "running");
    let end = detail["endAt"].clone();
    let (status, _) = door
        .post(
            &format!("/v2/sandboxes/{id}/connect"),
            json!({"timeout": 5}),
        )
        .await;
    assert_eq!(status, 200);
    let (_, detail) = door.get(&format!("/sandboxes/{id}")).await;
    assert_eq!(detail["endAt"], end);
    // Set-timeout moves it either way.
    let (status, _) = door
        .post(&format!("/sandboxes/{id}/timeout"), json!({"timeout": 5}))
        .await;
    assert_eq!(status, 204);
    let (_, detail) = door.get(&format!("/sandboxes/{id}")).await;
    assert_ne!(detail["endAt"], end);

    let (status, _) = door
        .call(
            reqwest::Method::DELETE,
            &format!("/sandboxes/{id}"),
            KEY,
            None,
        )
        .await;
    assert_eq!(status, 204);
    let (status, _) = door.get(&format!("/sandboxes/{id}")).await;
    assert_eq!(status, 404);
    let (status, _) = door
        .call(
            reqwest::Method::DELETE,
            &format!("/sandboxes/{id}"),
            KEY,
            None,
        )
        .await;
    assert_eq!(status, 404);
    assert!(!levels.lock().unwrap().at.contains_key(&id.parse().unwrap()));
}

#[tokio::test]
async fn creates_refuse_what_is_not_offered() {
    let (_fleet, _host, _levels, _seen, door) = fleet_with_guest().await;
    for (body, status) in [
        (json!({"templateID": "base", "mcp": {"x": {}}}), 400),
        (
            json!({"templateID": "base", "allow_internet_access": false}),
            400,
        ),
        (
            json!({"templateID": "base", "network": {"allowOut": ["1.1.1.1"]}}),
            400,
        ),
        (
            json!({"templateID": "base", "autoResume": {"enabled": true}}),
            400,
        ),
        (json!({"templateID": "base", "timeout": 0}), 400),
        (json!({"templateID": "nope"}), 404),
    ] {
        let (got, answer) = door.post("/v2/sandboxes", body.clone()).await;
        assert_eq!(got, status, "{body}: {answer}");
        assert_eq!(answer["code"], status, "{answer}");
    }
    let (status, _) = door
        .call(
            reqwest::Method::POST,
            "/v2/sandboxes",
            "no-such-key",
            Some(json!({"templateID": "base"})),
        )
        .await;
    assert_eq!(status, 401);
}

#[tokio::test]
async fn traffic_reaches_guest_ports_over_kept_streams() {
    let (_fleet, _host, _levels, seen, door) = fleet_with_guest().await;
    let sandbox = door.create(json!({"templateID": "base"})).await;
    let id = sandbox["sandboxID"].as_str().unwrap().to_owned();
    for _ in 0..3 {
        let (status, body) = door
            .text(
                door.traffic(&id, ENVD_PORT, "/health")
                    .header("x-access-token", "t"),
            )
            .await;
        assert_eq!((status, body.as_str()), (200, "port 49983 token t"));
    }
    // One stream carried all three.
    assert_eq!(seen.dials.lock().unwrap()[&ENVD_PORT], 1);
    assert_eq!(door.front.traffic().idle(id.parse().unwrap(), ENVD_PORT), 1);
    // By host name, as signed file URLs and getHost name it.
    let (status, body) = door
        .text(
            door.http
                .get(format!("http://{}/files", door.address))
                .header("host", format!("8080-{id}.localhost:3000")),
        )
        .await;
    assert_eq!((status, body.as_str()), (200, "port 8080 token "));
    // A port nothing listens on.
    let (status, body) = door.text(door.traffic(&id, 9000, "/")).await;
    assert_eq!(status, 502);
    assert!(body.contains("port is not open"), "{body}");
    // A sandbox that is not there.
    let (status, body) = door
        .text(door.traffic("0192a1b2c3d47e5f8a9b0c1d2e3f4a5b", ENVD_PORT, "/"))
        .await;
    assert_eq!(status, 502);
    assert!(body.contains("The sandbox was not found"), "{body}");
    // A kept stream holds the sandbox awake on its host, so it is dropped
    // once its idle time is up, with no request needed to notice.
    tokio::time::sleep(e2b::traffic::IDLE_FOR + Duration::from_millis(300)).await;
    assert_eq!(door.front.traffic().idle(id.parse().unwrap(), ENVD_PORT), 0);
}

#[tokio::test]
async fn user_ports_need_the_traffic_token_when_public_traffic_is_off() {
    let (_fleet, _host, _levels, _seen, door) = fleet_with_guest().await;
    let sandbox = door
        .create(json!({"templateID": "base", "network": {"allowPublicTraffic": false}}))
        .await;
    let id = sandbox["sandboxID"].as_str().unwrap().to_owned();
    let traffic = sandbox["trafficAccessToken"].as_str().unwrap().to_owned();
    let (status, body) = door.text(door.traffic(&id, 8080, "/")).await;
    assert_eq!(status, 403);
    assert!(body.contains("Missing traffic access token"), "{body}");
    let (status, body) = door
        .text(
            door.traffic(&id, 8080, "/")
                .header("e2b-traffic-access-token", "wrong"),
        )
        .await;
    assert_eq!(status, 403);
    assert!(body.contains("Invalid traffic access token"), "{body}");
    let (status, _) = door
        .text(
            door.traffic(&id, 8080, "/")
                .header("e2b-traffic-access-token", &traffic),
        )
        .await;
    assert_eq!(status, 200);
    // envd checks its own token, so its port needs none.
    let (status, _) = door.text(door.traffic(&id, ENVD_PORT, "/")).await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn traffic_resumes_a_paused_sandbox_with_auto_resume() {
    let (_fleet, _host, levels, _seen, door) = fleet_with_guest().await;
    let sandbox = door
        .create(json!({"templateID": "base", "autoPause": true, "autoResume": {"enabled": true}}))
        .await;
    let id = sandbox["sandboxID"].as_str().unwrap().to_owned();
    let (status, _) = door
        .post(&format!("/sandboxes/{id}/pause"), json!({}))
        .await;
    assert_eq!(status, 204);
    let (status, body) = door.text(door.traffic(&id, ENVD_PORT, "/health")).await;
    assert_eq!((status, body.as_str()), (200, "port 49983 token "));
    let (_, detail) = door.get(&format!("/sandboxes/{id}")).await;
    assert_eq!(detail["state"], "running");
    assert_eq!(
        levels.lock().unwrap().at[&id.parse::<Id>().unwrap()],
        LevelName::Running
    );
}

#[tokio::test]
async fn an_open_stream_holds_its_sandbox_until_it_ends_and_a_pause_cuts_it() {
    let (_fleet, _host, levels, seen, door) = fleet_with_guest().await;
    let sandbox = door.create(json!({"templateID": "base"})).await;
    let id = sandbox["sandboxID"].as_str().unwrap().to_owned();
    let log = |levels: &Arc<Mutex<Levels>>| levels.lock().unwrap().log.clone();

    // A stream read for a while, then dropped, as a background command
    // started and left behind.
    let mut response = door
        .traffic(&id, ENVD_PORT, "/stream")
        .header("content-type", "application/connect+json")
        .send()
        .await
        .unwrap();
    assert_eq!(response.chunk().await.unwrap().unwrap(), "tick\n");
    until(
        Duration::from_secs(5),
        "the stream holds its sandbox",
        async || {
            log(&levels)
                .iter()
                .any(|line| line.starts_with("hold e2b-streams Some(45000)"))
        },
    )
    .await;
    drop(response);
    until(
        Duration::from_secs(10),
        "the hold is released",
        async || log(&levels).contains(&"release e2b-streams".to_owned()),
    )
    .await;
    until(
        Duration::from_secs(5),
        "the guest's stream ends",
        async || seen.streams.load(Ordering::SeqCst) == 0,
    )
    .await;

    // A pause ends a stream that is still open.
    let mut response = door
        .traffic(&id, ENVD_PORT, "/stream")
        .header("content-type", "application/connect+json")
        .send()
        .await
        .unwrap();
    assert_eq!(response.chunk().await.unwrap().unwrap(), "tick\n");
    let (status, _) = door
        .post(&format!("/sandboxes/{id}/pause"), json!({}))
        .await;
    assert_eq!(status, 204);
    let ended = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match response.chunk().await {
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => return,
            }
        }
    })
    .await;
    assert!(ended.is_ok(), "the pause did not end the stream");
    until(
        Duration::from_secs(5),
        "the guest's stream ends",
        async || seen.streams.load(Ordering::SeqCst) == 0,
    )
    .await;
    assert_eq!(door.front.traffic().idle(id.parse().unwrap(), ENVD_PORT), 0);
}

#[tokio::test]
async fn timeouts_kill_or_pause() {
    let (fleet, _host, _levels, _seen, door) = fleet_with_guest().await;
    let killed = door
        .create(json!({"templateID": "base", "timeout": 1}))
        .await;
    let paused = door
        .create(json!({"templateID": "base", "timeout": 1, "autoPause": true}))
        .await;
    let killed = killed["sandboxID"].as_str().unwrap().to_owned();
    let paused = paused["sandboxID"].as_str().unwrap().to_owned();
    until(Duration::from_secs(10), "the timeouts pass", async || {
        let (gone, _) = door.get(&format!("/sandboxes/{killed}")).await;
        let (_, detail) = door.get(&format!("/sandboxes/{paused}")).await;
        gone == 404 && detail["state"] == "paused"
    })
    .await;
    // The killed one is gone from the fleet as well, its record too.
    assert!(
        fleet
            .store
            .sandbox(killed.parse().unwrap())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        fleet
            .store
            .lifecycle(killed.parse().unwrap())
            .await
            .unwrap()
            .is_none()
    );
    let record = fleet
        .store
        .lifecycle(paused.parse().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(record.record.state, e2b::lifecycle::State::Paused);
}

/// With a certificate for the API's host and `*.<domain>`, the front door
/// serves HTTPS itself: the API, and sandbox host names, as the SDK
/// reaches them.
#[tokio::test]
async fn the_front_door_serves_https_for_the_api_and_sandbox_host_names() {
    let fleet = Fleet::start().await;
    let seen = Arc::new(Seen::default());
    let (_host, _levels) = host(&fleet, &seen).await;
    let certified =
        rcgen::generate_simple_self_signed(vec!["api.e2b.test".into(), "*.e2b.test".into()])
            .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let (cert, key) = (dir.path().join("cert.pem"), dir.path().join("key.pem"));
    std::fs::write(&cert, certified.cert.pem()).unwrap();
    std::fs::write(&key, certified.key_pair.serialize_pem()).unwrap();
    let tls = compute_control::tls::public_server(&cert, &key).unwrap();
    let front = Front::new(
        Arc::clone(&fleet.running.service),
        Settings {
            domain: "e2b.test".into(),
            ..Settings::default()
        },
    );
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(e2b::listen::serve(
        listener,
        e2b::router(Arc::clone(&front)),
        Some(tls),
    ));
    let root = reqwest::Certificate::from_pem(certified.cert.pem().as_bytes()).unwrap();
    let client = |host: &str| {
        reqwest::Client::builder()
            .add_root_certificate(root.clone())
            .resolve(host, address)
            .build()
            .unwrap()
    };
    let port = address.port();
    let created = client("api.e2b.test")
        .post(format!("https://api.e2b.test:{port}/v2/sandboxes"))
        .header("x-api-key", KEY)
        .json(&json!({"templateID": "base", "timeout": 120}))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 201);
    let sandbox: Value = created.json().await.unwrap();
    let id = sandbox["sandboxID"].as_str().unwrap();
    let token = sandbox["envdAccessToken"].as_str().unwrap();
    let envd = format!("{ENVD_PORT}-{id}.e2b.test");
    let answered = client(&envd)
        .get(format!("https://{envd}:{port}/health"))
        .header("x-access-token", token)
        .send()
        .await
        .unwrap();
    assert_eq!(answered.status(), 200);
    assert_eq!(
        answered.text().await.unwrap(),
        format!("port {ENVD_PORT} token {token}")
    );
    // Plain HTTP to the same port gets nothing.
    assert!(
        reqwest::get(format!("http://{address}/v2/sandboxes"))
            .await
            .is_err()
    );
}
