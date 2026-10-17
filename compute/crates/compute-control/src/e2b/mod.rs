//! The E2B-compatible front door
//! ([ADR 19](../../../../docs/adr/0019-e2b-compatible-front-door-and-guest-init.md)).
//!
//! One listener serves both of E2B's surfaces, so clients built for E2B,
//! its JS SDK 2.56.0 among them, use this fabric unchanged:
//!
//! - **The REST API** ([`api`]): create from a template, get, list, kill,
//!   pause, connect (which resumes), set the timeout, and list templates,
//!   for a team's `X-API-Key`.
//! - **Sandbox traffic** ([`traffic`]): a request that names a sandbox and
//!   port, by host name (`<port>-<id>.<domain>`) or by the
//!   `E2b-Sandbox-Id` and `E2b-Sandbox-Port` headers ([`route`]), goes to
//!   that port in the guest through the owner host's `connect` and the
//!   guest's gateway, over a small pool of streams per sandbox and port.
//!   envd, on port 49983, checks its own access token.
//!
//! A sandbox's E2B lifecycle is recorded beside its fleet row
//! ([`lifecycle`]); [`ops`] carries out creates, pauses, resumes and kills,
//! and a sweeper in every replica finishes the ones a crash cut short and
//! applies timeouts.
//!
//! The listener ([`listen`]) speaks plain HTTP behind a TLS terminator, or
//! HTTPS itself with a certificate for the API's name and `*.<domain>`:
//! the SDK reaches both surfaces over HTTPS.

pub mod api;
pub mod lifecycle;
pub mod listen;
pub mod ops;
pub mod route;
pub mod traffic;
pub mod wire;

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use compute_protocol::host::{Id, SleepConfig};
use tokio::time::Instant;
use tower::ServiceExt as _;

use crate::keys::Keys;
use crate::service::{Failure, Service};
use crate::store::{Store, StoreError};

/// The envd version the guest images carry: E2B's runtime at the commit
/// `guest/build.sh` pins.
pub const ENVD_VERSION: &str = "0.10.0";

/// A request refused, as E2B answers it: a status and a JSON body with
/// `code` and `message`.
#[derive(Debug)]
pub struct Refused {
    pub status: u16,
    pub message: String,
}

impl Refused {
    #[must_use]
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    /// 400.
    #[must_use]
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }

    /// 500.
    #[must_use]
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(500, message)
    }

    /// 404 for a sandbox.
    #[must_use]
    pub fn not_found(id: Id) -> Self {
        Self::new(404, format!("sandbox {id} not found"))
    }
}

impl From<Failure> for Refused {
    fn from(failure: Failure) -> Self {
        let status = match &failure {
            Failure::NotFound => 404,
            Failure::Invalid(_) => 400,
            Failure::Busy(_) => 409,
            Failure::NoCapacity | Failure::Unavailable(_) => 503,
            Failure::Unknown { .. } => 504,
            Failure::Host(_) => 502,
            Failure::Store(_) | Failure::Archive(_) => 500,
        };
        Self::new(status, failure.to_string())
    }
}

impl From<StoreError> for Refused {
    fn from(error: StoreError) -> Self {
        Self::internal(error.to_string())
    }
}

impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let body = wire::Error {
            code: status.as_u16(),
            message: self.message,
        };
        (status, axum::Json(body)).into_response()
    }
}

/// An E2B template: a fleet image and the shape its sandboxes get.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Template {
    /// The fleet's name for the image (see
    /// [`crate::service::Settings::images`]).
    pub image: String,
    pub vcpus: u8,
    pub memory_mib: u32,
    /// The disk size reported to callers.
    pub disk_mib: u64,
}

/// How the front door runs.
#[derive(Clone, Debug)]
pub struct Settings {
    /// The domain sandbox host names are under, and that answers carry.
    pub domain: String,
    /// The templates creates may name, by id.
    pub templates: BTreeMap<String, Template>,
    /// How E2B's sandboxes sleep while E2B calls them running.
    pub sleep: SleepConfig,
    /// The envd version answers report.
    pub envd_version: String,
    /// How long a pause may take before its caller is answered that it
    /// goes on in the background.
    pub pause_within: Duration,
    /// How often each replica looks for due timeouts, and for pauses and
    /// kills a crash cut short.
    pub sweep_every: Duration,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            domain: "localhost".into(),
            templates: BTreeMap::from([(
                "base".into(),
                Template {
                    image: "base".into(),
                    vcpus: 2,
                    memory_mib: 1024,
                    disk_mib: 4096,
                },
            )]),
            sleep: SleepConfig::RECOMMENDED,
            envd_version: ENVD_VERSION.into(),
            pause_within: Duration::from_secs(120),
            sweep_every: Duration::from_secs(1),
        }
    }
}

/// The front door's state, shared by its handlers and its sweeper.
pub struct Front<S> {
    pub service: Arc<Service<S>>,
    pub settings: Settings,
    keys: Keys,
    traffic: traffic::Traffic,
    /// Sandboxes the sweeper is working on, or should leave alone until
    /// the time given after a failure.
    sweeping: Mutex<HashMap<Id, Option<Instant>>>,
}

impl<S> std::fmt::Debug for Front<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Front")
            .field("domain", &self.settings.domain)
            .finish_non_exhaustive()
    }
}

impl<S: Store> Front<S> {
    /// A front door to `service`.
    #[must_use]
    pub fn new(service: Arc<Service<S>>, settings: Settings) -> Arc<Self> {
        Arc::new(Self {
            service,
            settings,
            keys: Keys::default(),
            traffic: traffic::Traffic::default(),
            sweeping: Mutex::new(HashMap::new()),
        })
    }

    /// Its sandbox traffic.
    #[must_use]
    pub fn traffic(&self) -> &traffic::Traffic {
        &self.traffic
    }

    /// The store it runs on.
    pub(crate) fn store(&self) -> &S {
        self.service.store()
    }
}

/// Every request: sandbox traffic when it names a sandbox, the REST API
/// otherwise.
async fn front_door<S: Store>(
    State((front, rest)): State<(Arc<Front<S>>, Router)>,
    request: Request,
) -> Response {
    match route::target(request.headers(), &front.settings.domain) {
        Some(target) => traffic::serve(&front, target, request).await,
        None => match rest.oneshot(request).await {
            Ok(response) => response,
            Err(never) => match never {},
        },
    }
}

/// The front door's routes: the REST API and sandbox traffic.
pub fn router<S: Store>(front: Arc<Front<S>>) -> Router {
    let rest = api::router(Arc::clone(&front));
    Router::new()
        .fallback(front_door::<S>)
        .with_state((front, rest))
}
