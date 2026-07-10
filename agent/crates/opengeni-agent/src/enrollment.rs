//! Device-flow enrollment client (OAuth 2.0 device authorization, RFC 8628).
//!
//! This is the **single module that owns the enrollment HTTP wire shape** — the
//! reconciliation seam with the deployed M5 control-plane device-flow routes
//! (`apps/api/src/routes/enrollments.ts` + `apps/api/src/sandbox/enrollment.ts`).
//! The HTTP request/response structs ([`wire`]) are isolated here and match the
//! API's `@opengeni/contracts` Zod shapes EXACTLY: camelCase JSON keys, the
//! `/v1/...` paths, and the STRING poll-state enum the API returns. The structs
//! convert to/from the proto [`EnrollmentCredentials`](opengeni_agent_proto::v1::EnrollmentCredentials)
//! at their edges so the rest of the agent only ever sees proto types.
//!
//! ## Flow (dossier §10.1 / §23.1)
//!
//! 1. The agent loads its durable ed25519 install keypair from disk, generating
//!    it only once when absent; the FULL public key (base64) is the `publicKey`
//!    the enrollment binds to (non-transferable).
//! 2. `POST /v1/enrollments/device/start` with `{ workspaceId, publicKey, os, arch,
//!    machineName?, canOfferDisplay, requestsScreenControl }` (camelCase) → a
//!    `userCode` + `verificationUri` the human visits to consent + authorize.
//! 3. The agent prints the code/URL and polls `POST /v1/enrollments/device/poll`
//!    with `{ deviceCode }` until the state is `authorized` (carrying
//!    [`EnrollmentCredentials`]), `denied`, `expired`, or `disabled`, honoring the
//!    server's poll interval (the API rate-limits via HTTP 429, not `slow_down`).
//! 4. The caller persists the returned credentials `0600` (see
//!    [`crate::config::save_credentials`]).

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
#[cfg(test)]
use ed25519_dalek::Signer as _;
use ed25519_dalek::SigningKey;
use opengeni_agent_proto::v1::{Arch, EnrollmentCredentials, Os};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// The endpoint paths, appended to the configured API base URL. Kept as
/// constants beside the wire structs so a path rename is also a one-file change.
const START_PATH: &str = "/v1/enrollments/device/start";
const POLL_PATH: &str = "/v1/enrollments/device/poll";
/// The non-interactive token-exchange endpoint (headless / fleet enroll). The
/// caller-held enroll token IS the grant — there is no human approve step — so
/// this exchanges it directly for the SAME credential shape the `poll` authorized
/// branch returns (spec §A2.3).
const EXCHANGE_PATH: &str = "/v1/enrollments/token/exchange";
/// The authenticated self-revoke endpoint. It is deployment-key exempt: the
/// stored enrollment bearer is the sole credential and must only ever be sent in
/// the Authorization header.
const SELF_REVOKE_PATH: &str = "/v1/enrollments/self/revoke";
/// The durable machine-identity seed file inside the config dir. This is separate
/// from `credentials.json`: forced re-enrollment overwrites workspace credentials
/// but must not rotate the machine's ed25519 identity.
const INSTALL_IDENTITY_FILE: &str = "machine-identity.ed25519";
/// The serialized length of an ed25519 signing seed.
const INSTALL_IDENTITY_SEED_LEN: usize = 32;

/// What the user offered at install time, sent in the start request so the
/// consent page can present the right toggles.
#[derive(Debug, Clone, Copy)]
pub struct EnrollmentOffer {
    /// The host OS family.
    pub os: Os,
    /// The host CPU architecture.
    pub arch: Arch,
    /// Whether this machine can offer a graphical display (the API's
    /// `canOfferDisplay`; drives the screen-control consent toggle on the page).
    pub offers_display: bool,
    /// Whether the agent requests screen control / computer-use (the API's
    /// `requestsScreenControl`). The user's `allowScreenControl` at approve is the
    /// AUTHORITATIVE consent; this is only the agent's request. Default false.
    pub requests_screen_control: bool,
}

/// Inputs to a device-flow enrollment.
#[derive(Debug, Clone)]
pub struct EnrollmentRequest {
    /// The control-plane API base URL (e.g. `https://app.opengeni.ai`).
    pub api_base_url: String,
    /// The workspace (UUID) this machine enrolls into. REQUIRED by the API's
    /// device/start: the user who approves must hold a grant in THIS workspace, and
    /// that binding is what makes the (user-unauthenticated) start safe.
    pub workspace_id: String,
    /// A human-friendly machine name (hostname by default).
    pub machine_name: String,
    /// The OS/arch/display offer.
    pub offer: EnrollmentOffer,
}

/// Errors raised during enrollment.
#[derive(Debug, Error)]
pub enum EnrollmentError {
    /// The HTTP client could not be built or a request failed at the transport
    /// level (DNS, TLS, connection).
    #[error("enrollment transport error: {0}")]
    Transport(#[from] reqwest::Error),
    /// The server returned a non-success status for an enrollment request.
    #[error("enrollment endpoint {path} returned HTTP {status}: {body}")]
    Status {
        /// The endpoint path that failed.
        path: String,
        /// The HTTP status code.
        status: u16,
        /// The (truncated) response body for diagnosis.
        body: String,
    },
    /// The user explicitly denied the enrollment at the verification page.
    #[error("enrollment denied by the user")]
    Denied,
    /// The device code expired before the user authorized.
    #[error("enrollment expired before authorization (the user did not complete the flow)")]
    Expired,
    /// The server reported AUTHORIZED but omitted the credentials.
    #[error("server reported authorized but returned no credentials")]
    MissingCredentials,
    /// The credential plane is disabled for this deployment (the API returns the
    /// `disabled` state when it has no signing secret to mint a bearer) — the agent
    /// cannot complete enrollment until the deployment provisions it.
    #[error("the control plane's credential issuance is disabled for this deployment")]
    Disabled,
}

/// Errors from the self-revoke lifecycle request. None include the enrollment
/// bearer: callers must retain credentials and retry on every failure.
#[derive(Debug, Error)]
pub enum RevokeError {
    /// The request could not be completed or timed out, so remote state is
    /// ambiguous and local credentials must remain intact.
    #[error("could not confirm remote revoke ({0}); credentials were retained so you can retry")]
    Transport(String),
    /// A non-success response did not prove that the enrollment is revoked.
    #[error("remote revoke returned HTTP {status}; credentials were retained so you can retry")]
    Status { status: u16 },
    /// A successful HTTP status without the required idempotent response shape is
    /// not proof that the remote enrollment was revoked.
    #[error("remote revoke returned an invalid confirmation; credentials were retained so you can retry")]
    InvalidConfirmation,
}

/// Errors raised while loading or persisting the durable install identity.
#[derive(Debug, Error)]
pub enum InstallIdentityError {
    /// A filesystem operation on the config dir/file failed.
    #[error("install identity io error at {path}: {source}")]
    Io {
        /// The path the failing operation touched.
        path: PathBuf,
        /// The underlying IO error.
        source: std::io::Error,
    },
    /// The persisted key file was present but was not a 32-byte ed25519 seed.
    #[error("malformed install identity at {path}: expected 32 bytes, got {len}")]
    Malformed {
        /// The key file path.
        path: PathBuf,
        /// The number of bytes found on disk.
        len: usize,
    },
}

impl InstallIdentityError {
    fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}

/// A consent-printable summary the caller shows the human before polling.
#[derive(Debug, Clone)]
pub struct PendingAuthorization {
    /// The short code the user types at the verification URL.
    pub user_code: String,
    /// Where the user goes to authorize.
    pub verification_uri: String,
    /// A pre-filled convenience URL embedding the code.
    pub verification_uri_complete: String,
}

/// An ed25519 install identity. The private key never leaves the machine; its
/// full public key (base64) is sent to the control plane as the enrollment
/// `publicKey` — the machine identity the enrollment binds to.
pub struct InstallIdentity {
    signing_key: SigningKey,
}

impl InstallIdentity {
    /// Generates a fresh ed25519 install keypair from the OS CSPRNG.
    #[must_use]
    pub fn generate() -> Self {
        Self {
            signing_key: SigningKey::generate(&mut OsRng),
        }
    }

    /// Loads the durable machine identity from `config_dir`, or generates and
    /// persists it if this is the first enrollment on the machine.
    ///
    /// The stored bytes are the 32-byte ed25519 signing seed, written to
    /// `machine-identity.ed25519` with owner-only permissions on Unix. This file
    /// is separate from the enrollment credentials so `enroll --force` can refresh
    /// workspace grants without changing the machine public key.
    ///
    /// # Errors
    ///
    /// Returns [`InstallIdentityError`] when the key file cannot be read/written
    /// or is malformed.
    pub fn load_or_generate(config_dir: &Path) -> Result<Self, InstallIdentityError> {
        let path = config_dir.join(INSTALL_IDENTITY_FILE);
        match std::fs::read(&path) {
            Ok(bytes) => Self::from_seed_bytes(&path, &bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir_all(config_dir)
                    .map_err(|source| InstallIdentityError::io(config_dir, source))?;
                let generated = Self::generate();
                match create_identity_file(&path, &generated.signing_key.to_bytes()) {
                    Ok(()) => Ok(generated),
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                        let bytes = std::fs::read(&path)
                            .map_err(|source| InstallIdentityError::io(&path, source))?;
                        Self::from_seed_bytes(&path, &bytes)
                    }
                    Err(e) => Err(InstallIdentityError::io(&path, e)),
                }
            }
            Err(e) => Err(InstallIdentityError::io(path, e)),
        }
    }

    fn from_seed_bytes(path: &Path, bytes: &[u8]) -> Result<Self, InstallIdentityError> {
        let seed: [u8; INSTALL_IDENTITY_SEED_LEN] =
            bytes
                .try_into()
                .map_err(|_| InstallIdentityError::Malformed {
                    path: path.to_path_buf(),
                    len: bytes.len(),
                })?;
        Ok(Self {
            signing_key: SigningKey::from_bytes(&seed),
        })
    }

    /// The base64 (standard, no-pad) encoding of the FULL 32-byte ed25519 public
    /// key — the `publicKey` the API's device/start binds the enrollment to. This
    /// is the complete public key (not a hash/fingerprint of it).
    #[must_use]
    pub fn public_key_base64(&self) -> String {
        base64::engine::general_purpose::STANDARD_NO_PAD
            .encode(self.signing_key.verifying_key().to_bytes())
    }

    /// Signs a challenge with the install private key (base64-encoded), for
    /// proof-of-possession. The device flow does not currently require it, but
    /// the install key is the agent's stable identity and exposing the signing
    /// primitive keeps a challenge-response reconcilable with M5 without a wire
    /// change. Covered by [`tests::signature_round_trips_under_the_install_key`].
    #[cfg(test)]
    #[must_use]
    pub fn sign_base64(&self, challenge: &[u8]) -> String {
        let sig = self.signing_key.sign(challenge);
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(sig.to_bytes())
    }
}

fn create_identity_file(
    path: &Path,
    seed: &[u8; INSTALL_IDENTITY_SEED_LEN],
) -> std::io::Result<()> {
    use std::io::Write as _;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(seed)?;
    file.sync_all()?;
    restrict_identity_permissions(path)?;
    Ok(())
}

#[cfg(unix)]
fn restrict_identity_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrict_identity_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Drives a full device-flow enrollment: start → print code/URL via `on_prompt`
/// → poll to completion. Returns the issued [`EnrollmentCredentials`].
///
/// The `on_prompt` callback receives the [`PendingAuthorization`] so the CLI can
/// print the user code + URL exactly once before polling begins (keeping IO out
/// of this transport module).
///
/// # Errors
///
/// Returns an [`EnrollmentError`] on a transport failure, a non-success status, a
/// user denial, expiry, or a malformed authorized response.
pub async fn enroll(
    req: &EnrollmentRequest,
    identity: &InstallIdentity,
    mut on_prompt: impl FnMut(&PendingAuthorization),
) -> Result<EnrollmentCredentials, EnrollmentError> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("opengeni-agent/", env!("CARGO_PKG_VERSION")))
        .build()?;

    let start = start_device_auth(&client, req, identity).await?;
    let pending = PendingAuthorization {
        user_code: start.user_code.clone(),
        verification_uri: start.verification_uri.clone(),
        verification_uri_complete: start.verification_uri_complete.clone(),
    };
    on_prompt(&pending);

    poll_until_resolved(&client, req, &start).await
}

/// `POST /enrollments/device/start`. Isolated so the request/response field names
/// are reconcilable in one place against M5.
async fn start_device_auth(
    client: &reqwest::Client,
    req: &EnrollmentRequest,
    identity: &InstallIdentity,
) -> Result<wire::StartResponse, EnrollmentError> {
    let url = join_url(&req.api_base_url, START_PATH);
    let body = wire::StartRequest {
        workspace_id: req.workspace_id.clone(),
        public_key: identity.public_key_base64(),
        os: os_str(req.offer.os),
        arch: arch_str(req.offer.arch),
        machine_name: Some(req.machine_name.clone()),
        can_offer_display: req.offer.offers_display,
        requests_screen_control: req.offer.requests_screen_control,
    };
    let resp = client.post(&url).json(&body).send().await?;
    parse_json::<wire::StartResponse>(resp, START_PATH).await
}

/// Polls `POST /enrollments/device/poll` until the flow resolves, honoring the
/// server's poll interval. (The API rate-limits at the HTTP layer rather than
/// returning an RFC 8628 `slow_down` state, so there is no in-loop backoff bump.)
async fn poll_until_resolved(
    client: &reqwest::Client,
    req: &EnrollmentRequest,
    start: &wire::StartResponse,
) -> Result<EnrollmentCredentials, EnrollmentError> {
    let url = join_url(&req.api_base_url, POLL_PATH);
    let interval = Duration::from_secs(u64::from(start.poll_interval_seconds.max(1)));
    tracing::debug!(
        expires_in_seconds = start.expires_in_seconds,
        poll_interval_seconds = start.poll_interval_seconds,
        "polling for device authorization"
    );

    loop {
        tokio::time::sleep(interval).await;

        let body = wire::PollRequest {
            device_code: start.device_code.clone(),
        };
        let resp = client.post(&url).json(&body).send().await?;
        let poll = parse_json::<wire::PollResponse>(resp, POLL_PATH).await?;

        // The API returns a STRING state enum (`pending`/`authorized`/`denied`/
        // `expired`/`disabled`), NOT the proto's integer. We map it here; the API
        // has no `slow_down` state (it rate-limits at the HTTP layer → 429, which
        // surfaces as EnrollmentError::Status before we get here).
        match poll.state {
            wire::PollState::Authorized => {
                return poll
                    .credentials
                    .map(wire::Credentials::into_proto)
                    .ok_or(EnrollmentError::MissingCredentials);
            }
            wire::PollState::Pending => { /* keep polling at the current interval */ }
            wire::PollState::Denied => return Err(EnrollmentError::Denied),
            wire::PollState::Expired => return Err(EnrollmentError::Expired),
            wire::PollState::Disabled => return Err(EnrollmentError::Disabled),
        }
    }
}

/// Exchanges a non-interactive enroll token for credentials (headless / fleet
/// path, spec §A2.3/§A2.4). The token IS the grant — there is no human approve —
/// so this is a single `POST /v1/enrollments/token/exchange` carrying the SAME
/// identity fields the device flow sends to `device/start` (`publicKey`, `os`,
/// `arch`, `machineName?`, the display/screen-control offer), plus the opaque
/// `token`. The workspace is NOT sent: it is encoded in (and authorized by) the
/// token itself, so `req.workspace_id` is ignored on this path.
///
/// The response's `credentials` is the EXISTING [`wire::Credentials`] shape (the
/// API's `EnrollmentCredentialsResponse`), reusing [`Credentials::into_proto`] —
/// identical to the `poll` authorized branch.
///
/// # Errors
///
/// Returns an [`EnrollmentError`] on a transport failure, a non-success status
/// (e.g. a 401 for an invalid/expired token), or a malformed response.
pub async fn exchange_token(
    req: &EnrollmentRequest,
    identity: &InstallIdentity,
    token: &str,
) -> Result<EnrollmentCredentials, EnrollmentError> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("opengeni-agent/", env!("CARGO_PKG_VERSION")))
        .build()?;

    let url = join_url(&req.api_base_url, EXCHANGE_PATH);
    let body = wire::ExchangeRequest {
        token: token.to_string(),
        public_key: identity.public_key_base64(),
        os: os_str(req.offer.os),
        arch: arch_str(req.offer.arch),
        machine_name: Some(req.machine_name.clone()),
        can_offer_display: req.offer.offers_display,
        requests_screen_control: req.offer.requests_screen_control,
    };
    let resp = client.post(&url).json(&body).send().await?;
    let exchange = parse_json::<wire::ExchangeResponse>(resp, EXCHANGE_PATH).await?;
    Ok(exchange.credentials.into_proto())
}

/// Revokes the currently enrolled machine with its persisted `oge_` bearer.
///
/// Success includes an idempotent already-revoked response as defined by the
/// control-plane's `RevokeEnrollmentResponse`; every other status and every
/// transport failure remains ambiguous and is deliberately returned as an error.
/// The bearer is never interpolated into a URL, body, log, or error string.
pub async fn revoke_self(api_base_url: &str, bearer: &str) -> Result<(), RevokeError> {
    revoke_self_with_timeout(api_base_url, bearer, Duration::from_secs(10)).await
}

/// Implements [`revoke_self`] with an injectable timeout for local contract tests.
/// The enrollment bearer is deliberately accepted only as an Authorization header.
async fn revoke_self_with_timeout(
    api_base_url: &str,
    bearer: &str,
    timeout: Duration,
) -> Result<(), RevokeError> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .user_agent(concat!("opengeni-agent/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| RevokeError::Transport(e.to_string()))?;
    let url = join_url(api_base_url, SELF_REVOKE_PATH);
    let response = client
        .post(url)
        .bearer_auth(bearer)
        .send()
        .await
        .map_err(|e| RevokeError::Transport(e.to_string()))?;
    if response.status().is_success() {
        // Both `revoked: true` and `revoked: false` are a positive, idempotent
        // confirmation from the contract. A forged/malformed 2xx is ambiguous,
        // so fail closed and leave credentials available for a retry.
        response
            .json::<wire::RevokeResponse>()
            .await
            .map(|confirmation| {
                // `false` is the idempotent already-revoked confirmation. The
                // event deliberately has no agent id, URL, or bearer value.
                tracing::debug!(
                    already_revoked = !confirmation.revoked,
                    "remote revoke confirmed"
                );
            })
            .map_err(|_| RevokeError::InvalidConfirmation)
    } else {
        Err(RevokeError::Status {
            status: response.status().as_u16(),
        })
    }
}

/// Joins a base URL and a path without doubling or dropping the separating slash.
fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

/// Decodes a JSON response, turning a non-success status into a typed
/// [`EnrollmentError::Status`] with a truncated body for diagnosis.
async fn parse_json<T: for<'de> Deserialize<'de>>(
    resp: reqwest::Response,
    path: &str,
) -> Result<T, EnrollmentError> {
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(EnrollmentError::Status {
            path: path.to_string(),
            status: status.as_u16(),
            body: body.chars().take(512).collect(),
        });
    }
    Ok(resp.json::<T>().await?)
}

/// Lowercase OS string for the start request (`linux`/`macos`/`windows`).
fn os_str(os: Os) -> String {
    match os {
        Os::Linux => "linux",
        Os::Macos => "macos",
        Os::Windows => "windows",
        Os::Unspecified => "unknown",
    }
    .to_string()
}

/// CPU architecture string for the start request.
fn arch_str(arch: Arch) -> String {
    match arch {
        Arch::X8664 => "x86_64",
        Arch::Aarch64 => "aarch64",
        Arch::Unspecified => "unknown",
    }
    .to_string()
}

/// The HTTP wire shapes — **the reconciliation point with the deployed M5 API**.
///
/// Every JSON field name the agent sends/receives lives here and matches the API's
/// `@opengeni/contracts` Zod shapes EXACTLY: camelCase keys (the structs carry Rust
/// snake_case fields with `#[serde(rename_all = "camelCase")]`), and the STRING
/// poll-state enum the API returns. The structs convert to/from the proto messages
/// at their edges so the rest of the agent only ever sees proto types.
mod wire {
    use super::{Deserialize, EnrollmentCredentials, Serialize};

    /// Response of `POST /v1/enrollments/self/revoke`. `revoked: false` is the
    /// idempotent already-revoked result and still confirms safe local cleanup.
    #[derive(Debug, Deserialize)]
    pub(super) struct RevokeResponse {
        pub revoked: bool,
    }

    /// Body of `POST /v1/enrollments/device/start`. Matches the API's
    /// `DeviceEnrollmentStartRequest`. `exposure` defaults to `whole-machine`
    /// server-side (v1 only supports that), so we omit it.
    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct StartRequest {
        /// The workspace (UUID) this machine enrolls into (REQUIRED by the API).
        pub workspace_id: String,
        /// The agent's FULL ed25519 public key (base64) — the machine identity the
        /// enrollment binds to (the API's `publicKey`; NOT a fingerprint/hash).
        pub public_key: String,
        /// OS family (`linux`/`macos`/`windows`).
        pub os: String,
        /// CPU arch (`x86_64`/`aarch64`).
        pub arch: String,
        /// Human-friendly machine name (optional; serialized as `machineName`).
        #[serde(skip_serializing_if = "Option::is_none")]
        pub machine_name: Option<String>,
        /// Whether this machine can offer a display (the API's `canOfferDisplay`).
        pub can_offer_display: bool,
        /// Whether the agent requests screen control (the API's
        /// `requestsScreenControl`; the user's approve is the authoritative consent).
        pub requests_screen_control: bool,
    }

    /// Response of `POST /v1/enrollments/device/start`. Matches the API's
    /// `DeviceEnrollmentStartResponse` (camelCase). `intervalSeconds` is the poll
    /// cadence; `expiresInSeconds` is the device-code TTL.
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct StartResponse {
        pub user_code: String,
        pub device_code: String,
        pub verification_uri: String,
        #[serde(default)]
        pub verification_uri_complete: String,
        #[serde(default)]
        pub expires_in_seconds: u32,
        #[serde(default = "default_poll_interval", rename = "intervalSeconds")]
        pub poll_interval_seconds: u32,
    }

    fn default_poll_interval() -> u32 {
        5
    }

    /// Body of `POST /v1/enrollments/device/poll`. Matches the API's
    /// `DeviceEnrollmentPollRequest` (`deviceCode`).
    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct PollRequest {
        pub device_code: String,
    }

    /// The poll state the API returns — a STRING enum (the API's
    /// `DeviceEnrollmentState`), NOT the proto's integer. The API has no `slow_down`
    /// state (it rate-limits at the HTTP layer → 429).
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub(super) enum PollState {
        Pending,
        Authorized,
        Denied,
        Expired,
        /// The deployment's credential-issuance plane is off (no signing secret).
        Disabled,
    }

    /// Response of `POST /v1/enrollments/device/poll`. Matches the API's
    /// `DeviceEnrollmentPollResponse`; `credentials` is present only when authorized.
    #[derive(Debug, Deserialize)]
    pub(super) struct PollResponse {
        pub state: PollState,
        #[serde(default)]
        pub credentials: Option<Credentials>,
    }

    /// Body of `POST /v1/enrollments/token/exchange` (spec §A2.3). Carries the
    /// SAME identity fields as [`StartRequest`] — the agent's `publicKey`, `os`,
    /// `arch`, optional `machineName`, and the display/screen-control offer —
    /// plus the opaque enroll `token` that authorizes the exchange. The workspace
    /// is NOT sent: it is encoded in the token. Like `StartRequest`, `exposure`
    /// is omitted (the API defaults it to `whole-machine` server-side, the only
    /// v1 exposure).
    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct ExchangeRequest {
        /// The opaque, short-TTL enroll token (the `oget_` token) — the grant.
        pub token: String,
        /// The agent's FULL ed25519 public key (base64) — the machine identity the
        /// enrollment binds to (same as `StartRequest::public_key`).
        pub public_key: String,
        /// OS family (`linux`/`macos`/`windows`).
        pub os: String,
        /// CPU arch (`x86_64`/`aarch64`).
        pub arch: String,
        /// Human-friendly machine name (optional; serialized as `machineName`).
        #[serde(skip_serializing_if = "Option::is_none")]
        pub machine_name: Option<String>,
        /// Whether this machine can offer a display (the API's `canOfferDisplay`).
        pub can_offer_display: bool,
        /// Whether the agent requests screen control (the API's
        /// `requestsScreenControl`).
        pub requests_screen_control: bool,
    }

    /// Response of `POST /v1/enrollments/token/exchange` (spec §A2.3). The
    /// `credentials` object is the SAME [`Credentials`] shape (the API's
    /// `EnrollmentCredentialsResponse`) the `poll` authorized branch returns, so
    /// the exchange reuses [`Credentials::into_proto`].
    #[derive(Debug, Deserialize)]
    pub(super) struct ExchangeResponse {
        pub credentials: Credentials,
    }

    /// The credentials sub-object on an authorized poll. Matches the API's
    /// `EnrollmentCredentialsResponse` (camelCase). [`Credentials::into_proto`] is
    /// the single conversion site into the proto the agent consumes.
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(super) struct Credentials {
        pub agent_id: String,
        pub workspace_id: String,
        /// The signed `oge_` bearer the agent presents as the NATS connect
        /// auth-token (the API's `bearer`). This IS the credential — there is no
        /// per-machine creds file (the API's `natsAccountCreds` merely echoes it).
        pub bearer: String,
        #[serde(default)]
        pub nats_urls: Vec<String>,
        #[serde(default)]
        pub relay_url: String,
        /// The agent's relay PRODUCER token (the `ogr_` token; M8b/dossier §10.5),
        /// presented on a `StreamOpen` when the agent registers a pty/desktop relay
        /// channel. Empty when the relay-token plane is unconfigured for the
        /// deployment (the agent then presents an empty token the relay rejects).
        #[serde(default)]
        pub relay_token: String,
        /// The minisign public key pinned for self-update verification (the API's
        /// `updatePublicKey`).
        #[serde(default, rename = "updatePublicKey")]
        pub update_pubkey: String,
        #[serde(default)]
        pub consented_whole_machine: bool,
        #[serde(default)]
        pub consented_screen_control: bool,
    }

    impl Credentials {
        /// Converts the wire credentials into the proto message the rest of the
        /// agent consumes. The proto's `nats_credentials` field carries the connect
        /// bearer (M-AUTH), so the API's `bearer` maps straight into it.
        pub(super) fn into_proto(self) -> EnrollmentCredentials {
            EnrollmentCredentials {
                agent_id: self.agent_id,
                workspace_id: self.workspace_id,
                nats_credentials: self.bearer,
                nats_urls: self.nats_urls,
                relay_url: self.relay_url,
                relay_token: self.relay_token,
                update_pubkey: self.update_pubkey,
                consented_whole_machine: self.consented_whole_machine,
                consented_screen_control: self.consented_screen_control,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;

    #[test]
    fn install_public_key_is_stable_per_identity() {
        let id = InstallIdentity::generate();
        assert_eq!(id.public_key_base64(), id.public_key_base64());
        // 32-byte ed25519 pubkey -> 43 base64 (no-pad) chars.
        assert_eq!(id.public_key_base64().len(), 43);
    }

    #[test]
    fn distinct_identities_have_distinct_public_keys() {
        assert_ne!(
            InstallIdentity::generate().public_key_base64(),
            InstallIdentity::generate().public_key_base64()
        );
    }

    #[test]
    fn load_or_generate_returns_same_key_on_second_call() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = InstallIdentity::load_or_generate(dir.path()).expect("first identity");
        let key_path = dir.path().join(INSTALL_IDENTITY_FILE);
        let first_key_bytes = std::fs::read(&key_path).expect("persisted key");

        let second = InstallIdentity::load_or_generate(dir.path()).expect("second identity");
        let second_key_bytes = std::fs::read(&key_path).expect("persisted key");

        assert_eq!(first_key_bytes.len(), INSTALL_IDENTITY_SEED_LEN);
        assert_eq!(first_key_bytes, second_key_bytes);
        assert_eq!(first.public_key_base64(), second.public_key_base64());
    }

    #[test]
    fn force_reenroll_keeps_the_persisted_machine_key_bytes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let original = InstallIdentity::load_or_generate(dir.path()).expect("identity");
        let key_path = dir.path().join(INSTALL_IDENTITY_FILE);
        let original_key_bytes = std::fs::read(&key_path).expect("persisted key");

        // Simulate `enroll --force` replacing the workspace-scoped credentials
        // file. The machine identity lives in a separate file and must survive.
        std::fs::write(
            dir.path().join("credentials.json"),
            br#"{"agent_id":"new-agent","workspace_id":"new-workspace"}"#,
        )
        .expect("overwrite credentials");

        let after_force = InstallIdentity::load_or_generate(dir.path()).expect("identity");
        let after_force_key_bytes = std::fs::read(&key_path).expect("persisted key");

        assert_eq!(original_key_bytes, after_force_key_bytes);
        assert_eq!(
            original.public_key_base64(),
            after_force.public_key_base64()
        );
    }

    #[cfg(unix)]
    #[test]
    fn persisted_install_identity_is_0600() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        InstallIdentity::load_or_generate(dir.path()).expect("identity");
        let mode = std::fs::metadata(dir.path().join(INSTALL_IDENTITY_FILE))
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "install identity must be owner-only");
    }

    #[test]
    fn signature_round_trips_under_the_install_key() {
        use ed25519_dalek::{Signature, Verifier};
        let id = InstallIdentity::generate();
        let challenge = b"prove-possession";
        let sig_b64 = id.sign_base64(challenge);
        let sig_bytes = base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(sig_b64)
            .expect("base64");
        let sig = Signature::from_slice(&sig_bytes).expect("sig");
        assert!(id
            .signing_key
            .verifying_key()
            .verify(challenge, &sig)
            .is_ok());
    }

    #[test]
    fn join_url_normalizes_slashes() {
        assert_eq!(
            join_url("https://api.test/", "/enrollments/device/start"),
            "https://api.test/enrollments/device/start"
        );
        assert_eq!(
            join_url("https://api.test", "enrollments/device/start"),
            "https://api.test/enrollments/device/start"
        );
    }

    #[test]
    fn wire_credentials_convert_to_proto() {
        // The API's EnrollmentCredentialsResponse JSON (camelCase): `bearer` is the
        // connect token, `updatePublicKey` is the pinned self-update key.
        let json = r#"{
            "agentId": "a", "workspaceId": "w",
            "bearer": "oge_bearer", "subjectPrefix": "agent.w.a",
            "natsUrls": ["tls://x:4222"], "relayUrl": "https://r",
            "relayToken": "ogr_x", "natsAccountCreds": "oge_bearer",
            "updatePublicKey": "k",
            "consentedWholeMachine": true, "consentedScreenControl": false
        }"#;
        let wire: wire::Credentials = serde_json::from_str(json).expect("parse");
        let proto = wire.into_proto();
        assert_eq!(proto.agent_id, "a");
        // The API's `bearer` maps into the proto's `nats_credentials` (the connect
        // auth-token under M-AUTH).
        assert_eq!(proto.nats_credentials, "oge_bearer");
        assert_eq!(proto.nats_urls, vec!["tls://x:4222".to_string()]);
        assert_eq!(proto.relay_token, "ogr_x");
        assert_eq!(proto.update_pubkey, "k");
        assert!(proto.consented_whole_machine);
        assert!(!proto.consented_screen_control);
    }

    #[test]
    fn poll_response_parses_authorized_with_credentials() {
        // The API returns a STRING state and a camelCase credentials object.
        let json = r#"{
            "state": "authorized",
            "credentials": {
                "agentId": "a", "workspaceId": "w", "bearer": "c",
                "subjectPrefix": "agent.w.a", "natsUrls": [], "relayUrl": "",
                "relayToken": "", "natsAccountCreds": "c", "updatePublicKey": "",
                "consentedWholeMachine": true, "consentedScreenControl": false
            }
        }"#;
        let poll: wire::PollResponse = serde_json::from_str(json).expect("parse");
        assert_eq!(poll.state, wire::PollState::Authorized);
        assert!(poll.credentials.is_some());
    }

    #[test]
    fn poll_response_parses_each_string_state() {
        for (raw, expected) in [
            ("pending", wire::PollState::Pending),
            ("authorized", wire::PollState::Authorized),
            ("denied", wire::PollState::Denied),
            ("expired", wire::PollState::Expired),
            ("disabled", wire::PollState::Disabled),
        ] {
            let json = format!(r#"{{ "state": "{raw}" }}"#);
            let poll: wire::PollResponse = serde_json::from_str(&json).expect("parse");
            assert_eq!(poll.state, expected, "state {raw}");
        }
    }

    #[test]
    fn start_response_uses_default_poll_interval_when_absent() {
        // The API's start response is camelCase; `intervalSeconds` is the poll
        // cadence, but the agent defaults to 5s if it is somehow absent.
        let json = r#"{
            "userCode": "ABCD-1234",
            "deviceCode": "dev",
            "verificationUri": "https://app.opengeni.ai/device"
        }"#;
        let start: wire::StartResponse = serde_json::from_str(json).expect("parse");
        assert_eq!(start.poll_interval_seconds, 5);
        assert_eq!(start.user_code, "ABCD-1234");
        assert_eq!(start.device_code, "dev");
    }

    #[test]
    fn start_response_reads_camelcase_interval_seconds() {
        let json = r#"{
            "userCode": "ABCD-1234", "deviceCode": "dev",
            "verificationUri": "https://x/device",
            "verificationUriComplete": "https://x/device?user_code=ABCD-1234",
            "intervalSeconds": 7, "expiresInSeconds": 600
        }"#;
        let start: wire::StartResponse = serde_json::from_str(json).expect("parse");
        assert_eq!(start.poll_interval_seconds, 7);
        assert_eq!(start.expires_in_seconds, 600);
    }

    #[test]
    fn start_request_serializes_camelcase_for_the_api() {
        let body = wire::StartRequest {
            workspace_id: "11111111-1111-1111-1111-111111111111".to_string(),
            public_key: "pubkey-b64".to_string(),
            os: "linux".to_string(),
            arch: "x86_64".to_string(),
            machine_name: Some("my-box".to_string()),
            can_offer_display: false,
            requests_screen_control: false,
        };
        let value: serde_json::Value = serde_json::to_value(&body).expect("serialize");
        // The API reads camelCase keys; assert the exact wire shape.
        assert_eq!(value["workspaceId"], "11111111-1111-1111-1111-111111111111");
        assert_eq!(value["publicKey"], "pubkey-b64");
        assert_eq!(value["machineName"], "my-box");
        assert_eq!(value["canOfferDisplay"], false);
        assert_eq!(value["requestsScreenControl"], false);
        // Dropped fields the API does not read must NOT appear.
        assert!(value.get("installFingerprint").is_none());
        assert!(value.get("updateChannel").is_none());
        assert!(value.get("offersDisplay").is_none());
    }

    #[test]
    fn exchange_request_serializes_camelcase_for_the_api() {
        // The exchange body carries the same identity fields as start, plus the
        // opaque enroll token, and the API reads camelCase keys (spec §A2.3).
        let body = wire::ExchangeRequest {
            token: "oget_secret".to_string(),
            public_key: "pubkey-b64".to_string(),
            os: "linux".to_string(),
            arch: "x86_64".to_string(),
            machine_name: Some("fleet-box".to_string()),
            can_offer_display: false,
            requests_screen_control: false,
        };
        let value: serde_json::Value = serde_json::to_value(&body).expect("serialize");
        assert_eq!(value["token"], "oget_secret");
        assert_eq!(value["publicKey"], "pubkey-b64");
        assert_eq!(value["os"], "linux");
        assert_eq!(value["arch"], "x86_64");
        assert_eq!(value["machineName"], "fleet-box");
        assert_eq!(value["canOfferDisplay"], false);
        assert_eq!(value["requestsScreenControl"], false);
        // The workspace is encoded in the token, never sent on the wire; and
        // `exposure` is omitted (the API defaults it server-side).
        assert!(value.get("workspaceId").is_none());
        assert!(value.get("exposure").is_none());
    }

    #[test]
    fn exchange_request_omits_machine_name_when_absent() {
        let body = wire::ExchangeRequest {
            token: "oget_secret".to_string(),
            public_key: "pubkey-b64".to_string(),
            os: "macos".to_string(),
            arch: "aarch64".to_string(),
            machine_name: None,
            can_offer_display: false,
            requests_screen_control: false,
        };
        let value: serde_json::Value = serde_json::to_value(&body).expect("serialize");
        assert!(value.get("machineName").is_none());
    }

    #[test]
    fn exchange_response_parses_credentials_into_proto() {
        // The API returns `{ credentials: EnrollmentCredentialsResponse }` —
        // identical to the poll authorized branch — so the exchange reuses the
        // same wire::Credentials parsing + into_proto conversion (spec §A2.3).
        let json = r#"{
            "credentials": {
                "agentId": "a", "workspaceId": "w", "bearer": "oge_bearer",
                "subjectPrefix": "agent.w.a", "natsUrls": ["tls://x:4222"],
                "relayUrl": "https://r", "relayToken": "ogr_x",
                "natsAccountCreds": "oge_bearer", "updatePublicKey": "k",
                "consentedWholeMachine": true, "consentedScreenControl": true
            }
        }"#;
        let exchange: wire::ExchangeResponse = serde_json::from_str(json).expect("parse");
        let proto = exchange.credentials.into_proto();
        assert_eq!(proto.agent_id, "a");
        assert_eq!(proto.workspace_id, "w");
        assert_eq!(proto.nats_credentials, "oge_bearer");
        assert_eq!(proto.nats_urls, vec!["tls://x:4222".to_string()]);
        assert_eq!(proto.relay_token, "ogr_x");
        assert_eq!(proto.update_pubkey, "k");
        assert!(proto.consented_whole_machine);
        assert!(proto.consented_screen_control);
    }

    #[test]
    fn poll_request_serializes_camelcase_device_code() {
        let body = wire::PollRequest {
            device_code: "dev-123".to_string(),
        };
        let value: serde_json::Value = serde_json::to_value(&body).expect("serialize");
        assert_eq!(value["deviceCode"], "dev-123");
        assert!(value.get("device_code").is_none());
    }

    #[test]
    fn os_and_arch_strings_are_lowercase_target_triples() {
        assert_eq!(os_str(Os::Linux), "linux");
        assert_eq!(os_str(Os::Macos), "macos");
        assert_eq!(arch_str(Arch::X8664), "x86_64");
        assert_eq!(arch_str(Arch::Aarch64), "aarch64");
    }

    fn mock_once(status: u16, body: &'static str, expected_bearer: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let address = listener.local_addr().expect("address");
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            let count = socket.read(&mut request).expect("read request");
            let request = String::from_utf8_lossy(&request[..count]);
            assert!(request.starts_with("POST /v1/enrollments/self/revoke HTTP/1.1"));
            assert!(request
                .to_ascii_lowercase()
                .contains(&format!("authorization: bearer {expected_bearer}")));
            assert_eq!(
                request.matches(expected_bearer).count(),
                1,
                "bearer is only in Authorization"
            );
            socket
                .write_all(format!("HTTP/1.1 {status} test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes())
                .expect("reply");
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn revoke_uses_bearer_header_and_accepts_success_and_already_revoked() {
        for body in [r#"{"revoked":true}"#, r#"{"revoked":false}"#] {
            let base = mock_once(200, body, "oge_test_bearer");
            revoke_self(&base, "oge_test_bearer")
                .await
                .expect("revoked");
        }
    }

    #[tokio::test]
    async fn revoke_failure_never_leaks_the_bearer() {
        let secret = "oge_do_not_log";
        let base = mock_once(401, r#"{"error":"forged"}"#, secret);
        let error = revoke_self(&base, secret).await.expect_err("unauthorized");
        assert!(matches!(error, RevokeError::Status { status: 401 }));
        assert!(!error.to_string().contains(secret));
    }

    #[tokio::test]
    async fn revoke_rejects_forged_success_and_server_errors_without_leaking_bearer() {
        let secret = "oge_never_print_this";
        let malformed = mock_once(200, r#"{}"#, secret);
        let error = revoke_self(&malformed, secret)
            .await
            .expect_err("malformed success");
        assert!(matches!(error, RevokeError::InvalidConfirmation));
        assert!(!error.to_string().contains(secret));

        let unavailable = mock_once(503, r#"{"revoked":false}"#, secret);
        let error = revoke_self(&unavailable, secret)
            .await
            .expect_err("server failure");
        assert!(matches!(error, RevokeError::Status { status: 503 }));
        assert!(!error.to_string().contains(secret));
    }

    #[tokio::test]
    async fn revoke_timeout_is_ambiguous_and_never_exposes_the_bearer() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let address = listener.local_addr().expect("address");
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).expect("read request");
            std::thread::sleep(Duration::from_millis(100));
        });
        let secret = "oge_timeout_secret";
        let error = revoke_self_with_timeout(
            &format!("http://{address}"),
            secret,
            Duration::from_millis(10),
        )
        .await
        .expect_err("timeout");
        assert!(matches!(error, RevokeError::Transport(_)));
        assert!(!error.to_string().contains(secret));
    }
}
