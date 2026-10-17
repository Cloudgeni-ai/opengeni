//! The public API, version 1: sandboxes for a team's API key, and hosts for
//! the operator's.
//!
//! - `POST /v1/sandboxes` creates one; `GET` lists a team's, filtered by
//!   metadata given as query pairs.
//! - `GET` and `DELETE /v1/sandboxes/{id}`.
//! - `POST /v1/sandboxes/{id}/wake`, `/sleep` and `/move`.
//! - `GET /v1/sandboxes/{id}/connect/{port}` with `Upgrade: compute-stream`
//!   turns the connection into a byte stream to the guest port.
//! - `GET /v1/hosts`, `POST /v1/hosts/{name}/drain` and `/undrain`, for the
//!   operator team.
//!
//! Every request names its key in `X-API-Key`; the store holds only the
//! key's digest.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::Router;
use axum::extract::{Json, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use compute_fleet::HostState;
use compute_protocol::host::{Id, LevelName, PriorityName, Reply, SandboxConfig, SleepConfig};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};

use crate::keys::Keys;
pub use crate::keys::key_digest;
use crate::service::{Drained, Failure, Service};
use crate::store::{SandboxRow, Spec, Store};

/// The protocol name a connect upgrades to.
pub const STREAM_PROTOCOL: &str = "compute-stream";

/// A failure as a response.
#[derive(Debug)]
pub struct ApiError(StatusCode, String);

impl From<Failure> for ApiError {
    fn from(failure: Failure) -> Self {
        let status = match &failure {
            Failure::NotFound => StatusCode::NOT_FOUND,
            Failure::Invalid(_) => StatusCode::BAD_REQUEST,
            Failure::Busy(_) => StatusCode::CONFLICT,
            Failure::NoCapacity | Failure::Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Failure::Unknown { .. } => StatusCode::GATEWAY_TIMEOUT,
            Failure::Host(_) => StatusCode::BAD_GATEWAY,
            Failure::Store(_) | Failure::Archive(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self(status, failure.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        #[derive(Serialize)]
        struct Body {
            code: u16,
            message: String,
        }
        let body = Body {
            code: self.0.as_u16(),
            message: self.1,
        };
        (self.0, Json(body)).into_response()
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
                ApiError(
                    StatusCode::UNAUTHORIZED,
                    "a valid X-API-Key is needed".into(),
                )
            })
    }

    async fn operator(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        if self.team(headers).await? == self.0.operator {
            Ok(())
        } else {
            Err(ApiError(
                StatusCode::FORBIDDEN,
                "for the operator only".into(),
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
            host,
            owner_epoch: row.ownership.epoch.0,
            created_ms: row.created_ms,
        }
    }
}

/// A create.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateBody {
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
}

/// A wake's answer.
#[derive(Debug, Serialize, Deserialize)]
pub struct WokenView {
    pub waited_us: u64,
    pub generation: u64,
    pub host: Option<String>,
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
    pub disk_free_mib: u64,
    pub sandboxes: u32,
    pub awake: u32,
}

fn parse_id(id: &str) -> Result<Id, ApiError> {
    id.parse()
        .map_err(|error: String| ApiError(StatusCode::BAD_REQUEST, error))
}

async fn create<S: Store>(
    State(api): State<Api<S>>,
    headers: HeaderMap,
    Json(body): Json<CreateBody>,
) -> Result<(StatusCode, Json<SandboxView>), ApiError> {
    let team = api.team(&headers).await?;
    let service = &api.0.service;
    let config = SandboxConfig {
        vcpus: body.vcpus,
        memory_mib: body.memory_mib,
        memory_request_mib: body.memory_request_mib,
        cpu_request_millis: body.cpu_request_millis,
        sleep: body.sleep.unwrap_or(service.settings().sleep),
        // Set by the service from the image the create names.
        image: None,
    };
    let spec = Spec {
        image: body
            .image
            .unwrap_or_else(|| service.settings().image.clone()),
        config,
    };
    let row = service.create(&team, spec, body.metadata).await?;
    Ok((StatusCode::CREATED, Json(SandboxView::of(service, row))))
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
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
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

/// The public API's routes, with `operator` the team that manages hosts.
pub fn router<S: Store>(service: Arc<Service<S>>, operator: String) -> Router {
    let api = Api(Arc::new(Inner {
        service,
        operator,
        keys: Keys::default(),
    }));
    Router::new()
        .route("/v1/sandboxes", post(create::<S>).get(list::<S>))
        .route("/v1/sandboxes/{id}", get(one::<S>).delete(delete::<S>))
        .route("/v1/sandboxes/{id}/wake", post(wake::<S>))
        .route("/v1/sandboxes/{id}/sleep", post(sleep::<S>))
        .route("/v1/sandboxes/{id}/move", post(move_to::<S>))
        .route("/v1/sandboxes/{id}/connect/{port}", get(connect::<S>))
        .route("/v1/hosts", get(hosts::<S>))
        .route("/v1/hosts/{name}/drain", post(drain::<S>))
        .route("/v1/hosts/{name}/undrain", post(undrain::<S>))
        .with_state(api)
}
