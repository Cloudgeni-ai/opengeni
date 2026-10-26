//! GitHub (REST, the actions service and a scale set's message queue) and
//! compute's E2B API, faked in one HTTP server, as far as a pool uses them.

// Each test binary uses part of the fake.
#![allow(dead_code)]

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use tokio::sync::Notify;

/// A sandbox the fake holds.
#[derive(Clone, Debug)]
pub struct Sandbox {
    pub template: String,
    pub metadata: BTreeMap<String, String>,
    pub env: BTreeMap<String, String>,
}

/// A command run in a sandbox through its envd.
#[derive(Clone, Debug)]
pub struct Process {
    pub sandbox: String,
    pub user: String,
    pub script: String,
    pub env: BTreeMap<String, String>,
}

/// What the fake holds.
#[derive(Debug, Default)]
pub struct World {
    pub base: String,
    pub next: u64,
    pub sets: Vec<Value>,
    /// GitHub's runners: id to name and whether one has a job.
    pub runners: BTreeMap<u64, (String, bool)>,
    /// The open session's id and owner.
    pub session: Option<(String, String)>,
    pub sessions_closed: u32,
    pub queue_token: String,
    pub refreshes: u32,
    pub messages: VecDeque<Value>,
    pub deleted_messages: Vec<u64>,
    pub acquired: Vec<i64>,
    pub sandboxes: BTreeMap<String, Sandbox>,
    pub killed: Vec<String>,
    /// The repository's default branch's head.
    pub head: String,
    pub processes: Vec<Process>,
    /// Commands containing this exit 1.
    pub failing: Option<String>,
    /// Templates saved from sandboxes: id, name, the sandbox.
    pub templates: Vec<(String, String, String)>,
    pub deleted_templates: Vec<String>,
}

/// The fake, serving.
#[derive(Clone, Debug)]
pub struct Fake {
    world: Arc<Mutex<World>>,
    arrived: Arc<Notify>,
    pub base: String,
}

impl Fake {
    pub async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let fake = Self {
            world: Arc::new(Mutex::new(World {
                base: base.clone(),
                next: 100,
                queue_token: "queue-1".into(),
                ..World::default()
            })),
            arrived: Arc::new(Notify::new()),
            base,
        };
        let app = Router::new()
            .route(
                "/repos/acme/web/actions/runners/registration-token",
                post(registration),
            )
            .route("/actions/runner-registration", post(connection))
            .route(
                "/svc/_apis/runtime/runnerscalesets",
                get(sets).post(new_set),
            )
            .route(
                "/svc/_apis/runtime/runnerscalesets/{set}/generatejitconfig",
                post(jit),
            )
            .route(
                "/svc/_apis/runtime/runnerscalesets/{set}/sessions",
                post(open),
            )
            .route(
                "/svc/_apis/runtime/runnerscalesets/{set}/sessions/{id}",
                patch(refresh).delete(close),
            )
            .route(
                "/svc/_apis/runtime/runnerscalesets/{set}/acquirejobs",
                post(acquire),
            )
            .route("/svc/_apis/distributedtask/pools/0/agents", get(agents))
            .route(
                "/svc/_apis/distributedtask/pools/0/agents/{id}",
                delete(remove),
            )
            .route("/queue", get(poll))
            .route("/queue/{id}", delete(delete_message))
            .route("/v2/sandboxes", post(create).get(list))
            .route("/sandboxes/{id}", delete(kill))
            .route("/repos/acme/web", get(repository))
            .route("/repos/acme/web/commits/{branch}", get(commit))
            .route("/process.Process/Start", post(start_process))
            .route("/sandboxes/{id}/snapshots", post(snapshot))
            .route("/snapshots", get(snapshots))
            .route("/templates/{id}", delete(delete_template))
            .with_state(fake.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        fake
    }

    pub fn world(&self) -> MutexGuard<'_, World> {
        self.world.lock().unwrap()
    }

    /// Puts a message on the queue: `jobs` and the statistics GitHub
    /// would send with them.
    pub fn send(&self, jobs: &Value, assigned: u32) {
        {
            let mut world = self.world();
            world.next += 1;
            let id = world.next;
            world.messages.push_back(json!({
                "messageId": id,
                "messageType": "RunnerScaleSetJobMessages",
                "body": jobs.to_string(),
                "statistics": {"totalAssignedJobs": assigned},
            }));
        }
        self.arrived.notify_waiters();
    }

    /// Waits up to ten seconds for `check` to hold.
    pub async fn until(&self, what: &str, check: impl Fn(&World) -> bool) {
        let until = tokio::time::Instant::now() + Duration::from_secs(10);
        while !check(&self.world()) {
            assert!(
                tokio::time::Instant::now() < until,
                "waited in vain for {what}: {:#?}",
                self.world()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

/// A JSON Web Token good for an hour, as the actions service's tokens are
/// read (unsigned here).
fn jwt() -> String {
    let exp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3600;
    format!(
        "{}.{}.sig",
        URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#),
        URL_SAFE_NO_PAD.encode(json!({"exp": exp}).to_string())
    )
}

fn listing(values: &[Value]) -> Value {
    json!({"count": values.len(), "value": values})
}

async fn registration() -> Response {
    (
        StatusCode::CREATED,
        axum::Json(json!({"token": "registration"})),
    )
        .into_response()
}

async fn connection(State(fake): State<Fake>, headers: HeaderMap) -> Response {
    assert_eq!(headers["authorization"], "RemoteAuth registration");
    axum::Json(json!({"url": format!("{}/svc/", fake.base), "token": jwt()})).into_response()
}

async fn sets(State(fake): State<Fake>, Query(query): Query<BTreeMap<String, String>>) -> Response {
    let world = fake.world();
    let found = world
        .sets
        .iter()
        .filter(|set| set["name"] == query["name"])
        .cloned()
        .collect::<Vec<_>>();
    axum::Json(listing(&found)).into_response()
}

async fn new_set(State(fake): State<Fake>, axum::Json(mut set): axum::Json<Value>) -> Response {
    let mut world = fake.world();
    world.next += 1;
    set["id"] = json!(world.next);
    world.sets.push(set.clone());
    axum::Json(set).into_response()
}

async fn jit(State(fake): State<Fake>, axum::Json(setting): axum::Json<Value>) -> Response {
    let mut world = fake.world();
    world.next += 1;
    let id = world.next;
    let name = setting["name"].as_str().unwrap().to_owned();
    world.runners.insert(id, (name.clone(), false));
    axum::Json(json!({"runner": {"id": id, "name": name}, "encodedJITConfig": format!("jit-{id}")}))
        .into_response()
}

fn session(world: &World, id: &str) -> Value {
    json!({
        "sessionId": id,
        "messageQueueUrl": format!("{}/queue?sessionId={id}", world.base),
        "messageQueueAccessToken": world.queue_token,
        "statistics": {"totalAssignedJobs": 0},
    })
}

async fn open(State(fake): State<Fake>, axum::Json(body): axum::Json<Value>) -> Response {
    let mut world = fake.world();
    if world.session.is_some() {
        return StatusCode::CONFLICT.into_response();
    }
    world.next += 1;
    let id = format!("session-{}", world.next);
    world.session = Some((
        id.clone(),
        body["ownerName"].as_str().unwrap_or_default().into(),
    ));
    axum::Json(session(&world, &id)).into_response()
}

async fn refresh(State(fake): State<Fake>, Path((_, id)): Path<(u64, String)>) -> Response {
    let mut world = fake.world();
    world.refreshes += 1;
    world.queue_token = format!("queue-{}", world.refreshes + 1);
    axum::Json(session(&world, &id)).into_response()
}

async fn close(State(fake): State<Fake>, Path((_, id)): Path<(u64, String)>) -> StatusCode {
    let mut world = fake.world();
    if world.session.as_ref().is_some_and(|(open, _)| *open == id) {
        world.session = None;
        world.sessions_closed += 1;
    }
    StatusCode::NO_CONTENT
}

async fn acquire(State(fake): State<Fake>, axum::Json(ids): axum::Json<Vec<i64>>) -> Response {
    let mut world = fake.world();
    world.acquired.extend(&ids);
    axum::Json(listing(
        &ids.into_iter().map(Value::from).collect::<Vec<_>>(),
    ))
    .into_response()
}

async fn agents(
    State(fake): State<Fake>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Response {
    let world = fake.world();
    let found = world
        .runners
        .iter()
        .filter(|(_, (name, _))| *name == query["agentName"])
        .map(|(id, (name, _))| json!({"id": id, "name": name}))
        .collect::<Vec<_>>();
    axum::Json(listing(&found)).into_response()
}

async fn remove(State(fake): State<Fake>, Path(id): Path<u64>) -> StatusCode {
    let mut world = fake.world();
    match world.runners.get(&id) {
        None => StatusCode::NOT_FOUND,
        Some((_, true)) => StatusCode::BAD_REQUEST,
        Some(_) => {
            world.runners.remove(&id);
            StatusCode::NO_CONTENT
        }
    }
}

async fn poll(State(fake): State<Fake>, headers: HeaderMap) -> Response {
    let token = format!("Bearer {}", fake.world().queue_token);
    if headers["authorization"] != token.as_str() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let arrived = fake.arrived.notified();
    if let Some(message) = fake.world().messages.pop_front() {
        return axum::Json(message).into_response();
    }
    let _ = tokio::time::timeout(Duration::from_millis(100), arrived).await;
    match fake.world().messages.pop_front() {
        Some(message) => axum::Json(message).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

async fn delete_message(State(fake): State<Fake>, Path(id): Path<u64>) -> StatusCode {
    fake.world().deleted_messages.push(id);
    StatusCode::NO_CONTENT
}

fn strings(value: &Value) -> BTreeMap<String, String> {
    serde_json::from_value(value.clone()).unwrap_or_default()
}

async fn create(State(fake): State<Fake>, axum::Json(body): axum::Json<Value>) -> Response {
    let mut world = fake.world();
    world.next += 1;
    let id = format!("sbx{}", world.next);
    world.sandboxes.insert(
        id.clone(),
        Sandbox {
            template: body["templateID"].as_str().unwrap().into(),
            metadata: strings(&body["metadata"]),
            env: strings(&body["envVars"]),
        },
    );
    (
        StatusCode::CREATED,
        axum::Json(json!({"sandboxID": id, "envdAccessToken": "envd"})),
    )
        .into_response()
}

fn list_sandboxes(world: &World, metadata: &str) -> Vec<Value> {
    let wanted: Vec<(String, String)> = form_urlencoded::parse(metadata.as_bytes())
        .into_owned()
        .collect();
    world
        .sandboxes
        .iter()
        .filter(|(_, sandbox)| wanted.iter().all(|(key, value)| sandbox.metadata.get(key) == Some(value)))
        .map(|(id, sandbox)| json!({"sandboxID": id, "metadata": sandbox.metadata, "state": "running"}))
        .collect()
}

async fn list(State(fake): State<Fake>, Query(query): Query<Vec<(String, String)>>) -> Response {
    let metadata = query
        .iter()
        .find(|(name, _)| name == "metadata")
        .map(|(_, value)| value.clone())
        .unwrap_or_default();
    let world = fake.world.lock().unwrap();
    let found = list_sandboxes(&world, &metadata);
    axum::Json(Value::from(found)).into_response()
}

async fn kill(State(fake): State<Fake>, Path(id): Path<String>) -> StatusCode {
    let mut world = fake.world();
    if world.sandboxes.remove(&id).is_some() {
        world.killed.push(id);
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}

async fn repository() -> Response {
    axum::Json(json!({"default_branch": "main"})).into_response()
}

async fn commit(
    State(fake): State<Fake>,
    Path(branch): Path<String>,
    headers: HeaderMap,
) -> Response {
    assert_eq!(branch, "main");
    let accepted: Vec<_> = headers.get_all("accept").iter().collect();
    assert_eq!(
        accepted,
        ["application/vnd.github.sha"],
        "one media type, the commit alone"
    );
    fake.world().head.clone().into_response()
}

/// One Connect envelope.
fn envelope(flags: u8, message: &Value) -> Vec<u8> {
    let text = message.to_string();
    let mut frame = vec![flags];
    frame.extend_from_slice(&u32::try_from(text.len()).unwrap().to_be_bytes());
    frame.extend_from_slice(text.as_bytes());
    frame
}

async fn start_process(
    State(fake): State<Fake>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    use base64::engine::general_purpose::STANDARD;
    let request: Value = serde_json::from_slice(&body[5..]).unwrap();
    let basic = headers["authorization"]
        .to_str()
        .unwrap()
        .strip_prefix("Basic ")
        .unwrap();
    let user = String::from_utf8(STANDARD.decode(basic).unwrap()).unwrap();
    let process = Process {
        sandbox: headers["e2b-sandbox-id"].to_str().unwrap().into(),
        user: user.trim_end_matches(':').into(),
        script: request["process"]["args"][2].as_str().unwrap().into(),
        env: strings(&request["process"]["envs"]),
    };
    assert_eq!(headers["e2b-sandbox-port"], "49983");
    let mut world = fake.world();
    let exit = i32::from(
        world
            .failing
            .as_ref()
            .is_some_and(|failing| process.script.contains(failing.as_str())),
    );
    world.processes.push(process);
    let mut stream = envelope(0, &json!({"event": {"start": {"pid": 7}}}));
    stream.extend(envelope(
        0,
        &json!({"event": {"data": {"stdout": STANDARD.encode("working\n")}}}),
    ));
    stream.extend(envelope(
        0,
        &json!({"event": {"end": {"exitCode": exit, "exited": true}}}),
    ));
    stream.extend(envelope(2, &json!({})));
    stream.into_response()
}

async fn snapshot(
    State(fake): State<Fake>,
    Path(sandbox): Path<String>,
    axum::Json(body): axum::Json<Value>,
) -> Response {
    assert_eq!(body["memory"], false);
    let mut world = fake.world();
    world.next += 1;
    let id = format!("tpl{}", world.next);
    let name = body["name"].as_str().unwrap().to_owned();
    world.templates.push((id.clone(), name.clone(), sandbox));
    (
        StatusCode::CREATED,
        axum::Json(json!({"snapshotID": id, "names": [name]})),
    )
        .into_response()
}

async fn snapshots(State(fake): State<Fake>) -> Response {
    let world = fake.world();
    let all: Vec<Value> = world
        .templates
        .iter()
        .map(|(id, name, _)| json!({"snapshotID": id, "names": [name]}))
        .collect();
    axum::Json(Value::from(all)).into_response()
}

async fn delete_template(State(fake): State<Fake>, Path(id): Path<String>) -> StatusCode {
    let mut world = fake.world();
    world.templates.retain(|(kept, _, _)| *kept != id);
    world.deleted_templates.push(id);
    StatusCode::NO_CONTENT
}
