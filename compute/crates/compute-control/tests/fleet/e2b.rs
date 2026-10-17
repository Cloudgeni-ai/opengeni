//! The E2B front door against fake hosts and a fake guest: its REST API,
//! the lifecycle it records, and sandbox traffic through the guest's
//! gateway.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use compute_control::e2b::{self, Front, Settings, Template};
use compute_control::store::{MemoryStore, Store as _};
use compute_guest::{ENVD_PORT, GATEWAY_PORT};
use compute_protocol::host::{ErrorCode, Id, LevelName, Reply, Request};
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
    /// Ports 8081 (which then opens) and 8082 (which then refuses) answer
    /// their gateway header only once this is notified, as a slow connect
    /// would.
    slow: tokio::sync::Notify,
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
    if port == 8081 || port == 8082 {
        seen.slow.notified().await;
    }
    if port != ENVD_PORT && port != 8080 && port != 8081 {
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
    holds: HashMap<Id, BTreeSet<String>>,
    /// Sandboxes that never go to sleep, though their sleeps are answered.
    stuck: HashSet<Id>,
    /// Sandboxes whose wakes and connects are answered busy.
    busy: HashSet<Id>,
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
            Request::Wake { id, .. } | Request::Connect { id, .. } if state.busy.contains(id) => {
                return Act::Reply(Reply::Error {
                    message: "busy".into(),
                    code: ErrorCode::Busy,
                });
            }
            Request::Create { id, .. } | Request::Wake { id, .. } | Request::Connect { id, .. } => {
                state.at.insert(*id, LevelName::Running);
            }
            Request::Sleep { id, level, .. } => {
                if state.stuck.contains(id) {
                    return Act::Reply(Reply::Done);
                }
                state.at.insert(*id, *level);
                state.log.push(format!("sleep {level:?}"));
            }
            Request::Hold {
                id, hold, ttl_ms, ..
            } => {
                state.holds.entry(*id).or_default().insert(hold.clone());
                state.log.push(format!("hold {hold} {ttl_ms:?}"));
                return Act::Reply(Reply::Done);
            }
            Request::Release { id, hold, .. } => {
                state.holds.entry(*id).or_default().remove(hold);
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
                            "step": null, "holds": state.holds.get(id).map_or(0, BTreeSet::len),
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
        Self::start_with(fleet, Settings::default()).await
    }

    /// A front door with `settings`, but a quick sweeper and short pauses.
    async fn start_with(fleet: &Fleet, settings: Settings) -> Self {
        let settings = Settings {
            pause_within: Duration::from_secs(5),
            sweep_every: Duration::from_millis(100),
            check_paused_every: Duration::from_millis(300),
            ..settings
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
    let (_fleet, _host, levels, _seen, door) = fleet_with_guest().await;
    let sandbox = door
        .create(json!({
            "templateID": "base",
            "network": {"allowPublicTraffic": false},
            "autoPause": true,
            "autoResume": {"enabled": true},
        }))
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

    // A request without the token does not resume a paused sandbox.
    let (status, _) = door
        .post(&format!("/sandboxes/{id}/pause"), json!({}))
        .await;
    assert_eq!(status, 204);
    let (status, _) = door.text(door.traffic(&id, 8080, "/")).await;
    assert_eq!(status, 403);
    let (_, detail) = door.get(&format!("/sandboxes/{id}")).await;
    assert_eq!(detail["state"], "paused");
    assert_eq!(
        levels.lock().unwrap().at[&id.parse::<Id>().unwrap()],
        LevelName::Saved
    );
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
                .any(|line| line.starts_with("hold e2b-streams-") && line.ends_with(" Some(45000)"))
        },
    )
    .await;
    drop(response);
    until(
        Duration::from_secs(10),
        "the hold is released",
        async || {
            log(&levels)
                .iter()
                .any(|line| line.starts_with("release e2b-streams-"))
        },
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

/// Two replicas each keep their own hold for their streams: one replica's
/// stream ending leaves the other's hold in place, and a pause through
/// either releases both.
#[tokio::test]
async fn each_replica_holds_a_sandbox_for_its_own_streams() {
    let (fleet, _host, levels, _seen, a) = fleet_with_guest().await;
    let b = Door::start(&fleet).await;
    let sandbox = a.create(json!({"templateID": "base"})).await;
    let id = sandbox["sandboxID"].as_str().unwrap().to_owned();
    let sandbox_id: Id = id.parse().unwrap();
    let holds = || {
        levels
            .lock()
            .unwrap()
            .holds
            .get(&sandbox_id)
            .cloned()
            .unwrap_or_default()
    };
    let both = BTreeSet::from([
        a.front.stream_hold().to_owned(),
        b.front.stream_hold().to_owned(),
    ]);
    assert_ne!(a.front.stream_hold(), b.front.stream_hold());
    let mut streams = Vec::new();
    for door in [&a, &b] {
        let mut response = door
            .traffic(&id, ENVD_PORT, "/stream")
            .header("content-type", "application/connect+json")
            .send()
            .await
            .unwrap();
        assert_eq!(response.chunk().await.unwrap().unwrap(), "tick\n");
        streams.push(response);
    }
    until(
        Duration::from_secs(5),
        "both replicas hold it",
        async || holds() == both,
    )
    .await;
    // A's stream ends: only A's hold goes.
    drop(streams.remove(0));
    until(
        Duration::from_secs(10),
        "A's hold is released",
        async || holds() == BTreeSet::from([b.front.stream_hold().to_owned()]),
    )
    .await;
    // A pause through A ends B's stream and releases B's hold too.
    let (status, _) = a.post(&format!("/sandboxes/{id}/pause"), json!({})).await;
    assert_eq!(status, 204);
    assert!(holds().is_empty());
    assert_eq!(levels.lock().unwrap().at[&sandbox_id], LevelName::Saved);
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
    // A pause under way already shows as paused: wait for it to finish.
    until(Duration::from_secs(10), "the timeouts pass", async || {
        let (gone, _) = door.get(&format!("/sandboxes/{killed}")).await;
        let (_, detail) = door.get(&format!("/sandboxes/{paused}")).await;
        let state = fleet
            .store
            .lifecycle(paused.parse().unwrap())
            .await
            .unwrap()
            .map(|row| row.record.state);
        gone == 404 && detail["state"] == "paused" && state == Some(e2b::lifecycle::State::Paused)
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

/// A sweeper with more pauses it cannot finish than it reads at a time
/// still applies a later timeout: every round reads past them.
#[tokio::test]
async fn pauses_that_cannot_finish_do_not_hold_up_later_timeouts() {
    let fleet = Fleet::start().await;
    let seen = Arc::new(Seen::default());
    let (_host, levels) = host(&fleet, &seen).await;
    let mut settings = Settings::default();
    settings.templates.insert(
        "small".into(),
        Template {
            image: "base".into(),
            vcpus: 1,
            memory_mib: 256,
            disk_mib: 1024,
        },
    );
    let door = Door::start_with(&fleet, settings).await;
    // More pauses under way than the sweeper reads at a time, each due
    // before any timeout, none of which the host ever finishes.
    for _ in 0..65 {
        let sandbox = door.create(json!({"templateID": "small"})).await;
        let id: Id = sandbox["sandboxID"].as_str().unwrap().parse().unwrap();
        levels.lock().unwrap().stuck.insert(id);
        let mut row = fleet.store.lifecycle(id).await.unwrap().unwrap();
        row.record
            .set(e2b::lifecycle::State::Pausing, e2b::ops::now_ms());
        assert!(
            compute_control::store::replace_lifecycle(&*fleet.store, &mut row)
                .await
                .unwrap()
        );
    }
    let killed = door
        .create(json!({"templateID": "small", "timeout": 1}))
        .await;
    let killed = killed["sandboxID"].as_str().unwrap().to_owned();
    until(
        Duration::from_secs(10),
        "the timeout kills it",
        async || door.get(&format!("/sandboxes/{killed}")).await.0 == 404,
    )
    .await;
}

/// A request whose connect is slow while another replica pauses the
/// sandbox, and that wakes it again, is not forwarded, whether its stream
/// opens (8081) or the port refuses it (8082); the pause is carried out
/// again, and the sandbox ends paused and saved.
#[tokio::test]
async fn a_request_whose_connect_outlasts_a_pause_leaves_it_paused() {
    let (fleet, _host, levels, seen, door) = fleet_with_guest().await;
    for (port, status) in [(8081, 409), (8082, 502)] {
        let sandbox = door.create(json!({"templateID": "base"})).await;
        let id = sandbox["sandboxID"].as_str().unwrap().to_owned();
        let sandbox_id: Id = id.parse().unwrap();
        let served = seen.requests.load(Ordering::SeqCst);
        let request = tokio::spawn({
            let call = door.traffic(&id, port, "/work");
            async move { call.send().await.unwrap().status().as_u16() }
        });
        until(
            Duration::from_secs(5),
            "the connect reaches the guest",
            async || seen.dials.lock().unwrap().get(&port).copied() == Some(1),
        )
        .await;
        // Another replica's pause completes meanwhile; the connect has
        // woken the sandbox again (the fake host runs it on connects).
        let mut row = fleet.store.lifecycle(sandbox_id).await.unwrap().unwrap();
        row.record
            .set(e2b::lifecycle::State::Paused, e2b::ops::now_ms());
        assert!(
            compute_control::store::replace_lifecycle(&*fleet.store, &mut row)
                .await
                .unwrap()
        );
        assert_eq!(levels.lock().unwrap().at[&sandbox_id], LevelName::Running);
        seen.slow.notify_one();
        assert_eq!(request.await.unwrap(), status, "port {port}");
        assert_eq!(seen.requests.load(Ordering::SeqCst), served);
        until(
            Duration::from_secs(10),
            "the pause is carried out again",
            async || {
                let state = fleet
                    .store
                    .lifecycle(sandbox_id)
                    .await
                    .unwrap()
                    .map(|row| row.record.state);
                state == Some(e2b::lifecycle::State::Paused)
                    && levels.lock().unwrap().at[&sandbox_id] == LevelName::Saved
            },
        )
        .await;
    }
}

/// Pause work read before a pause finished and the sandbox resumed (a
/// sweep's copy of the record, say) neither cuts nor saves the running
/// sandbox.
#[tokio::test]
async fn pause_work_from_before_a_resume_leaves_the_sandbox_running() {
    let (fleet, _host, levels, _seen, door) = fleet_with_guest().await;
    let sandbox = door
        .create(json!({"templateID": "base", "autoPause": true}))
        .await;
    let id = sandbox["sandboxID"].as_str().unwrap().to_owned();
    let sandbox_id: Id = id.parse().unwrap();
    let (status, _) = door
        .post(&format!("/sandboxes/{id}/pause"), json!({}))
        .await;
    assert_eq!(status, 204);
    // As a sweep read it while the pause was under way.
    let mut stale = fleet.store.lifecycle(sandbox_id).await.unwrap().unwrap();
    stale
        .record
        .set(e2b::lifecycle::State::Pausing, e2b::ops::now_ms());
    let (status, _) = door
        .post(&format!("/v2/sandboxes/{id}/connect"), json!({}))
        .await;
    assert_eq!(status, 201);
    let saves = |levels: &Arc<Mutex<Levels>>| {
        levels
            .lock()
            .unwrap()
            .log
            .iter()
            .filter(|line| *line == "sleep Saved")
            .count()
    };
    let before = saves(&levels);
    e2b::ops::sweep_row(&door.front, stale).await.unwrap();
    assert_eq!(saves(&levels), before);
    assert_eq!(levels.lock().unwrap().at[&sandbox_id], LevelName::Running);
    let (_, detail) = door.get(&format!("/sandboxes/{id}")).await;
    assert_eq!(detail["state"], "running");
}

/// Paused sandboxes' hosts are checked again and again: sandboxes found
/// awake (woken by calls that started before their pauses and landed
/// after, from replicas that have stopped since, say) are paused again;
/// ones kept saved are left alone.
#[tokio::test]
async fn paused_sandboxes_found_awake_are_paused_again() {
    let (fleet, _host, levels, _seen, door) = fleet_with_guest().await;
    let saves = |levels: &Arc<Mutex<Levels>>| {
        let levels = levels.lock().unwrap();
        levels
            .log
            .iter()
            .filter(|line| *line == "sleep Saved")
            .count()
    };
    let mut ids = Vec::new();
    for _ in 0..3 {
        let sandbox = door.create(json!({"templateID": "base"})).await;
        let id = sandbox["sandboxID"].as_str().unwrap().to_owned();
        let (status, _) = door
            .post(&format!("/sandboxes/{id}/pause"), json!({}))
            .await;
        assert_eq!(status, 204);
        ids.push(id.parse::<Id>().unwrap());
    }
    // Late wakes land on two of them.
    let before = saves(&levels);
    for id in &ids[..2] {
        levels.lock().unwrap().at.insert(*id, LevelName::Running);
    }
    until(
        Duration::from_secs(10),
        "the awake ones are paused again",
        async || {
            let levels = levels.lock().unwrap();
            ids.iter().all(|id| levels.at[id] == LevelName::Saved)
        },
    )
    .await;
    // Over several more checks, nothing else is saved again.
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(saves(&levels), before + 2);
    for id in &ids {
        let row = fleet.store.lifecycle(*id).await.unwrap().unwrap();
        assert_eq!(row.record.state, e2b::lifecycle::State::Paused);
    }
}

/// A paused sandbox found awake whose host never saves it again holds up
/// neither the sweeper's timeouts nor later checks.
#[tokio::test]
async fn a_pause_again_that_cannot_finish_holds_up_no_timeout() {
    let (fleet, _host, levels, _seen, door) = fleet_with_guest().await;
    let sandbox = door.create(json!({"templateID": "base"})).await;
    let stuck = sandbox["sandboxID"].as_str().unwrap().to_owned();
    let stuck_id: Id = stuck.parse().unwrap();
    let (status, _) = door
        .post(&format!("/sandboxes/{stuck}/pause"), json!({}))
        .await;
    assert_eq!(status, 204);
    {
        let mut levels = levels.lock().unwrap();
        levels.at.insert(stuck_id, LevelName::Running);
        levels.stuck.insert(stuck_id);
    }
    until(
        Duration::from_secs(5),
        "the awake one is pausing again",
        async || {
            fleet
                .store
                .lifecycle(stuck_id)
                .await
                .unwrap()
                .is_some_and(|row| row.record.state == e2b::lifecycle::State::Pausing)
        },
    )
    .await;
    let killed = door
        .create(json!({"templateID": "base", "timeout": 1}))
        .await;
    let killed = killed["sandboxID"].as_str().unwrap().to_owned();
    until(
        Duration::from_secs(3),
        "the timeout is applied meanwhile",
        async || door.get(&format!("/sandboxes/{killed}")).await.0 == 404,
    )
    .await;
    let row = fleet.store.lifecycle(stuck_id).await.unwrap().unwrap();
    assert_eq!(row.record.state, e2b::lifecycle::State::Pausing);
}

/// An explicit connect whose wake lands only after a later pause
/// completed does not leave the sandbox running under a paused record:
/// the connect sees the pause, and resumes the sandbox again.
#[tokio::test]
async fn a_connect_whose_wake_outlasts_a_later_pause_resumes_again() {
    let (fleet, _host, levels, _seen, door) = fleet_with_guest().await;
    let sandbox = door.create(json!({"templateID": "base"})).await;
    let id = sandbox["sandboxID"].as_str().unwrap().to_owned();
    let sandbox_id: Id = id.parse().unwrap();
    let (status, _) = door
        .post(&format!("/sandboxes/{id}/pause"), json!({}))
        .await;
    assert_eq!(status, 204);
    levels.lock().unwrap().busy.insert(sandbox_id);
    let connect = tokio::spawn({
        let call = door
            .http
            .post(format!("http://{}/v2/sandboxes/{id}/connect", door.address))
            .header("x-api-key", KEY)
            .json(&json!({"timeout": 600}));
        async move { call.send().await.unwrap().status().as_u16() }
    });
    until(
        Duration::from_secs(5),
        "the connect records the resume",
        async || {
            fleet
                .store
                .lifecycle(sandbox_id)
                .await
                .unwrap()
                .is_some_and(|row| row.record.state == e2b::lifecycle::State::Running)
        },
    )
    .await;
    // A later pause completes while the connect's wake is held up.
    let (status, _) = door
        .post(&format!("/sandboxes/{id}/pause"), json!({}))
        .await;
    assert_eq!(status, 204);
    levels.lock().unwrap().busy.remove(&sandbox_id);
    assert_eq!(connect.await.unwrap(), 201);
    let (_, detail) = door.get(&format!("/sandboxes/{id}")).await;
    assert_eq!(detail["state"], "running");
    assert_eq!(levels.lock().unwrap().at[&sandbox_id], LevelName::Running);
}

/// A sweep that read a sandbox when its timeout had passed, and runs only
/// after a client moved the timeout, leaves it running.
#[tokio::test]
async fn a_sweep_of_a_record_read_before_the_timeout_moved_changes_nothing() {
    let (fleet, _host, _levels, _seen, door) = fleet_with_guest().await;
    for body in [
        json!({"templateID": "base", "timeout": 600}),
        json!({"templateID": "base", "timeout": 600, "autoPause": true}),
    ] {
        let sandbox = door.create(body).await;
        let id = sandbox["sandboxID"].as_str().unwrap().to_owned();
        // As the sweeper read it: due, at the version before the move.
        let mut stale = fleet
            .store
            .lifecycle(id.parse().unwrap())
            .await
            .unwrap()
            .unwrap();
        stale.record.end_ms = 0;
        let (status, _) = door
            .post(&format!("/sandboxes/{id}/timeout"), json!({"timeout": 900}))
            .await;
        assert_eq!(status, 204);
        e2b::ops::sweep_row(&door.front, stale).await.unwrap();
        let (status, detail) = door.get(&format!("/sandboxes/{id}")).await;
        assert_eq!((status, detail["state"].as_str()), (200, Some("running")));
    }
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
