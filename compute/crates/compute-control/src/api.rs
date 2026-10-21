//! The public API, version 1: sandboxes for a team's API key, and hosts for
//! the operator's.
//!
//! - `POST /v1/sandboxes` creates one, idempotently when it names a
//!   `request_id`; `GET` lists a team's, filtered by metadata given as
//!   query pairs.
//! - `GET /v1/requests/{request_id}` answers the sandbox a create with that
//!   request id made.
//! - `GET` and `DELETE /v1/sandboxes/{id}`.
//! - `GET /v1/sandboxes/{id}/state` asks its host how it is now: its level
//!   and any step under way.
//! - `POST /v1/sandboxes/{id}/wake`, `/sleep` and `/move`.
//! - `GET /v1/sandboxes/{id}/connect/{port}` with `Upgrade: compute-stream`
//!   turns the connection into a byte stream to the guest port.
//! - `GET /v1/link/keys` lists the keys agent-link tokens are signed with
//!   ([`docs/agent-link.md`](../../../docs/agent-link.md)).
//! - `GET /v1/hosts`, `POST /v1/hosts/{name}/drain` and `/undrain`, for the
//!   operator team.
//!
//! Every request names its key in `X-API-Key`; the store holds only the
//! key's digest. Errors are `{"code": "...", "message": "..."}`.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::Router;
use axum::extract::{Json, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use compute_fleet::HostState;
use compute_guest::envd::{AgentInit, InitData};
use compute_protocol::host::{Id, LevelName, PriorityName, Reply, SandboxConfig, SleepConfig};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};

use crate::init::InitError;
use crate::keys::Keys;
pub use crate::keys::key_digest;
use crate::link::LinkKeys;
use crate::metrics::{Metrics, Outcome, track};
use crate::service::{Drained, Failure, Service, request_digest};
use crate::store::{AgentRef, SandboxRow, Spec, Store};

/// The protocol name a connect upgrades to.
pub const STREAM_PROTOCOL: &str = "compute-stream";

/// A failure as a response: its status, a stable code and a message.
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
}

impl From<Failure> for ApiError {
    fn from(failure: Failure) -> Self {
        let (status, code) = match &failure {
            Failure::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            Failure::Invalid(_) => (StatusCode::BAD_REQUEST, "invalid"),
            Failure::Busy(_) => (StatusCode::CONFLICT, "busy"),
            Failure::Mismatch(_) => (StatusCode::CONFLICT, "request_mismatch"),
            Failure::Gone(_) => (StatusCode::GONE, "request_gone"),
            Failure::NoCapacity => (StatusCode::SERVICE_UNAVAILABLE, "no_capacity"),
            Failure::Unavailable(_) => (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
            Failure::Unknown { .. } => (StatusCode::GATEWAY_TIMEOUT, "unknown_outcome"),
            Failure::Host(_) => (StatusCode::BAD_GATEWAY, "host"),
            Failure::Store(_) | Failure::Archive(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal")
            }
        };
        Self::new(status, code, failure.to_string())
    }
}

impl From<InitError> for ApiError {
    fn from(error: InitError) -> Self {
        match error {
            InitError::Reach(failure) => failure.into(),
            InitError::Refused(why) => Self::new(StatusCode::BAD_GATEWAY, "init_failed", why),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        #[derive(Serialize)]
        struct Body {
            code: &'static str,
            message: String,
        }
        let body = Body {
            code: self.code,
            message: self.message,
        };
        let mut response = (self.status, Json(body)).into_response();
        response.extensions_mut().insert(Outcome(self.code));
        response
    }
}

struct Inner<S> {
    service: Arc<Service<S>>,
    operator: String,
    keys: Keys,
}

/// The public API's state.
pub struct Api<S>(Arc<Inner<S>>);

impl<S> std::fmt::Debug for Api<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Api")
            .field("operator", &self.0.operator)
            .finish_non_exhaustive()
    }
}

impl<S> Clone for Api<S> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

impl<S: Store> Api<S> {
    /// The team of the request's key.
    async fn team(&self, headers: &HeaderMap) -> Result<String, ApiError> {
        self.0
            .keys
            .team(&**self.0.service.store(), headers)
            .await
            .map_err(Failure::from)?
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::UNAUTHORIZED,
                    "unauthorized",
                    "a valid X-API-Key is needed",
                )
            })
    }

    async fn operator(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        if self.team(headers).await? == self.0.operator {
            Ok(())
        } else {
            Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "forbidden",
                "for the operator only",
            ))
        }
    }
}

/// A sandbox as callers see it.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SandboxView {
    pub id: Id,
    pub image: String,
    pub config: SandboxConfig,
    pub metadata: BTreeMap<String, String>,
    /// The Opengeni agent it runs, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentRef>,
    /// The host that owns it, if one does.
    pub host: Option<String>,
    pub owner_epoch: u64,
    pub created_ms: u64,
}

impl SandboxView {
    fn of<S: Store>(service: &Service<S>, row: SandboxRow) -> Self {
        let host = row
            .ownership
            .owner
            .and_then(|host| service.view().target(host))
            .map(|target| target.name);
        Self {
            id: row.id,
            image: row.spec.image,
            config: row.spec.config,
            metadata: row.metadata,
            agent: row.spec.agent,
            host,
            owner_epoch: row.ownership.epoch.0,
            created_ms: row.created_ms,
        }
    }
}

/// A create.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateBody {
    /// Makes the create idempotent for the team: the same id with the same
    /// body answers the same sandbox.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// The image to start from; the fleet's default when omitted.
    #[serde(default)]
    pub image: Option<String>,
    pub vcpus: u8,
    pub memory_mib: u32,
    #[serde(default)]
    pub memory_request_mib: Option<u32>,
    #[serde(default)]
    pub cpu_request_millis: Option<u32>,
    /// How it sleeps; the fleet's default when omitted (see
    /// [`crate::service::DEFAULT_SLEEP`]). Taken as given otherwise: one
    /// without `checkpoint_every_ms` takes no checkpoints.
    #[serde(default)]
    pub sleep: Option<SleepConfig>,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
    /// What the sandbox is given before the create answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub init: Option<CreateInit>,
}

/// A create's init: the sandbox's own environment and defaults, and the
/// Opengeni agent it runs. It holds no secret.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateInit {
    #[serde(default)]
    pub env_vars: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_workdir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<CreateAgent>,
}

/// The agent a create names: its enrollment's ids.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateAgent {
    pub workspace_id: String,
    pub agent_id: String,
    /// Where its workspace is in the sandbox.
    pub workspace_root: String,
    /// Whether it starts a virtual desktop.
    #[serde(default)]
    pub desktop: bool,
}

impl CreateInit {
    /// What the guest is given.
    fn guest(&self) -> InitData {
        InitData {
            env_vars: self.env_vars.clone(),
            access_token: None,
            default_user: self.default_user.clone(),
            default_workdir: self.default_workdir.clone(),
            agent: self.agent.as_ref().map(|agent| AgentInit {
                workspace_id: agent.workspace_id.clone(),
                agent_id: agent.agent_id.clone(),
                workspace_root: agent.workspace_root.clone(),
                desktop: agent.desktop,
            }),
        }
    }
}

/// A wake's answer.
#[derive(Debug, Serialize, Deserialize)]
pub struct WokenView {
    pub waited_us: u64,
    /// Its execution on its owner, as in [`StateView::generation`].
    pub generation: u64,
    pub host: Option<String>,
}

/// How a sandbox is now, as its host says.
#[derive(Debug, Serialize, Deserialize)]
pub struct StateView {
    /// The host that owns it; none when it is in the store alone.
    pub host: Option<String>,
    /// Where its state lives: `remote` with no host.
    pub level: LevelName,
    /// The step under way, such as a save or a restore, if any: `level`
    /// stays where it was until the step finishes.
    pub step: Option<String>,
    /// Its execution on its owner: raised by every boot there, kept by
    /// pausing, saving and restoring there. Each owner numbers afresh, so
    /// two compare only under one owner epoch. None with no host.
    pub generation: Option<u64>,
}

/// A wake or connect.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WakeBody {
    #[serde(default)]
    pub priority: PriorityName,
}

/// A sleep.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SleepBody {
    pub level: LevelName,
}

/// A move.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MoveBody {
    /// The host to adopt it; the next wake places it when omitted.
    #[serde(default)]
    pub to: Option<String>,
}

/// A host as the operator sees it.
#[derive(Debug, Serialize, Deserialize)]
pub struct HostView {
    pub name: String,
    pub zone: String,
    pub profile: String,
    pub cpu_template: String,
    pub state: String,
    pub epoch: u64,
    pub memory_mib: u64,
    pub memory_free_mib: u64,
    /// Processor time in millicores it guarantees sandboxes at once now.
    pub cpu_millis: u64,
    /// Processor time in millicores a wake can still reserve on it.
    pub cpu_free_millis: u64,
    pub disk_free_mib: u64,
    pub sandboxes: u32,
    pub awake: u32,
}

fn parse_id(id: &str) -> Result<Id, ApiError> {
    id.parse()
        .map_err(|error: String| ApiError::new(StatusCode::BAD_REQUEST, "invalid", error))
}

async fn create<S: Store>(
    State(api): State<Api<S>>,
    headers: HeaderMap,
    Json(body): Json<CreateBody>,
) -> Result<(StatusCode, Json<SandboxView>), ApiError> {
    let team = api.team(&headers).await?;
    let service = &api.0.service;
    let digest = body.request_id.as_ref().map(|_| request_digest(&body));
    let init = body.init.clone();
    let config = SandboxConfig {
        vcpus: body.vcpus,
        memory_mib: body.memory_mib,
        memory_request_mib: body.memory_request_mib,
        cpu_request_millis: body.cpu_request_millis,
        sleep: body.sleep.unwrap_or(service.settings().sleep),
        // Set by the service from the image the create names.
        image: None,
        link: None,
    };
    let agent = init
        .as_ref()
        .and_then(|init| init.agent.as_ref())
        .map(|agent| AgentRef {
            workspace: agent.workspace_id.clone(),
            agent: agent.agent_id.clone(),
        });
    let spec = Spec {
        image: body
            .image
            .unwrap_or_else(|| service.settings().image.clone()),
        config,
        agent,
    };
    let row = match (&body.request_id, &digest) {
        (Some(request_id), Some(digest)) => {
            service
                .create_requested(&team, request_id, digest, spec, body.metadata)
                .await?
        }
        _ => service.create(&team, spec, body.metadata).await?,
    };
    if let Some(init) = &init {
        crate::init::give(service, &team, row.id, &init.guest()).await?;
    }
    Ok((StatusCode::CREATED, Json(SandboxView::of(service, row))))
}

async fn requested<S: Store>(
    State(api): State<Api<S>>,
    headers: HeaderMap,
    Path(request_id): Path<String>,
) -> Result<Json<SandboxView>, ApiError> {
    let team = api.team(&headers).await?;
    let service = &api.0.service;
    let row = service.requested(&team, &request_id).await?;
    Ok(Json(SandboxView::of(service, row)))
}

async fn link_keys<S: Store>(
    State(api): State<Api<S>>,
    headers: HeaderMap,
) -> Result<Json<LinkKeys>, ApiError> {
    let team = api.team(&headers).await?;
    let links = api.0.service.settings().links.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "this fleet runs no agent links",
        )
    })?;
    Ok(Json(LinkKeys {
        team,
        keys: links.keys(),
    }))
}

async fn list<S: Store>(
    State(api): State<Api<S>>,
    headers: HeaderMap,
    Query(metadata): Query<BTreeMap<String, String>>,
) -> Result<Json<Vec<SandboxView>>, ApiError> {
    let team = api.team(&headers).await?;
    let service = &api.0.service;
    let rows = service.list(&team, &metadata).await?;
    Ok(Json(
        rows.into_iter()
            .map(|row| SandboxView::of(service, row))
            .collect(),
    ))
}

async fn one<S: Store>(
    State(api): State<Api<S>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<SandboxView>, ApiError> {
    let team = api.team(&headers).await?;
    let service = &api.0.service;
    let row = service.get(&team, parse_id(&id)?).await?;
    Ok(Json(SandboxView::of(service, row)))
}

async fn state<S: Store>(
    State(api): State<Api<S>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<StateView>, ApiError> {
    let team = api.team(&headers).await?;
    let view = match api.0.service.state(&team, parse_id(&id)?).await? {
        Some((host, status)) => StateView {
            host: Some(host),
            level: status.level,
            step: status.step,
            generation: Some(status.generation),
        },
        None => StateView {
            host: None,
            level: LevelName::Remote,
            step: None,
            generation: None,
        },
    };
    Ok(Json(view))
}

async fn delete<S: Store>(
    State(api): State<Api<S>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let team = api.team(&headers).await?;
    api.0.service.delete(&team, parse_id(&id)?).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn wake<S: Store>(
    State(api): State<Api<S>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Option<Json<WakeBody>>,
) -> Result<Json<WokenView>, ApiError> {
    let team = api.team(&headers).await?;
    let service = &api.0.service;
    let priority = body.map(|Json(body)| body.priority).unwrap_or_default();
    let reached = service.wake(&team, parse_id(&id)?, priority).await?;
    let (waited_us, generation) = match reached.answered.answer.reply {
        Reply::Woken {
            waited_us,
            generation,
            ..
        } => (waited_us, generation),
        _ => (0, 0),
    };
    let host = SandboxView::of(service, reached.row).host;
    Ok(Json(WokenView {
        waited_us,
        generation,
        host,
    }))
}

async fn sleep<S: Store>(
    State(api): State<Api<S>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<SleepBody>,
) -> Result<StatusCode, ApiError> {
    let team = api.team(&headers).await?;
    api.0
        .service
        .sleep(&team, parse_id(&id)?, body.level)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn move_to<S: Store>(
    State(api): State<Api<S>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Option<Json<MoveBody>>,
) -> Result<Json<SandboxView>, ApiError> {
    let team = api.team(&headers).await?;
    let service = &api.0.service;
    let to = body.and_then(|Json(body)| body.to);
    let row = service
        .move_to(&team, parse_id(&id)?, to.as_deref())
        .await?;
    Ok(Json(SandboxView::of(service, row)))
}

async fn connect<S: Store>(
    State(api): State<Api<S>>,
    Path((id, port)): Path<(String, u32)>,
    mut request: Request,
) -> Result<Response, ApiError> {
    let team = api.team(request.headers()).await?;
    let upgrade = request
        .headers()
        .get(header::UPGRADE)
        .and_then(|value| value.to_str().ok());
    if upgrade != Some(STREAM_PROTOCOL) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid",
            format!("a connect upgrades to {STREAM_PROTOCOL}"),
        ));
    }
    let on_upgrade = hyper::upgrade::on(&mut request);
    let reached = api
        .0
        .service
        .connect(&team, parse_id(&id)?, port, PriorityName::default())
        .await?;
    let (waited_us, connect_us) = match reached.answered.answer.reply {
        Reply::Connected {
            waited_us,
            connect_us,
            ..
        } => (waited_us, connect_us),
        _ => (0, 0),
    };
    let mut guest = reached.answered.stream;
    tokio::spawn(async move {
        match on_upgrade.await {
            Ok(upgraded) => {
                let mut caller = TokioIo::new(upgraded);
                let _ = tokio::io::copy_bidirectional(&mut caller, &mut guest).await;
            }
            Err(error) => tracing::debug!(%error, "a connect's upgrade failed"),
        }
    });
    let mut response = StatusCode::SWITCHING_PROTOCOLS.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
    headers.insert(header::UPGRADE, HeaderValue::from_static(STREAM_PROTOCOL));
    headers.insert("x-compute-waited-us", HeaderValue::from(waited_us));
    headers.insert("x-compute-connect-us", HeaderValue::from(connect_us));
    Ok(response)
}

async fn hosts<S: Store>(
    State(api): State<Api<S>>,
    headers: HeaderMap,
) -> Result<Json<Vec<HostView>>, ApiError> {
    api.operator(&headers).await?;
    let hosts = api
        .0
        .service
        .view()
        .hosts()
        .into_iter()
        .map(|known| HostView {
            name: known.target.name,
            zone: known.info.zone,
            profile: known.info.profile,
            cpu_template: known.info.cpu_template,
            state: match known.state {
                HostState::Live => "live",
                HostState::Draining => "draining",
                HostState::Lost => "lost",
            }
            .into(),
            epoch: known.target.epoch.0,
            memory_mib: known.info.memory_mib,
            memory_free_mib: known.capacity.memory_free_mib,
            cpu_millis: known.capacity.cpu_millis,
            cpu_free_millis: known.capacity.cpu_free_millis,
            disk_free_mib: known.capacity.disk_free_mib,
            sandboxes: known.capacity.sandboxes,
            awake: known.capacity.awake,
        })
        .collect();
    Ok(Json(hosts))
}

async fn drain<S: Store>(
    State(api): State<Api<S>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<Drained>, ApiError> {
    api.operator(&headers).await?;
    Ok(Json(api.0.service.drain(&name).await?))
}

async fn undrain<S: Store>(
    State(api): State<Api<S>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<StatusCode, ApiError> {
    api.operator(&headers).await?;
    api.0.service.undrain(&name).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The public API's routes, with `operator` the team that manages hosts,
/// each request counted in `metrics`.
pub fn router<S: Store>(
    service: Arc<Service<S>>,
    operator: String,
    metrics: Arc<Metrics>,
) -> Router {
    let api = Api(Arc::new(Inner {
        service,
        operator,
        keys: Keys::default(),
    }));
    Router::new()
        .route("/v1/sandboxes", post(create::<S>).get(list::<S>))
        .route("/v1/requests/{request_id}", get(requested::<S>))
        .route("/v1/link/keys", get(link_keys::<S>))
        .route("/v1/sandboxes/{id}", get(one::<S>).delete(delete::<S>))
        .route("/v1/sandboxes/{id}/state", get(state::<S>))
        .route("/v1/sandboxes/{id}/wake", post(wake::<S>))
        .route("/v1/sandboxes/{id}/sleep", post(sleep::<S>))
        .route("/v1/sandboxes/{id}/move", post(move_to::<S>))
        .route("/v1/sandboxes/{id}/connect/{port}", get(connect::<S>))
        .route("/v1/hosts", get(hosts::<S>))
        .route("/v1/hosts/{name}/drain", post(drain::<S>))
        .route("/v1/hosts/{name}/undrain", post(undrain::<S>))
        .route_layer(axum::middleware::from_fn_with_state(metrics, track))
        .with_state(api)
}
