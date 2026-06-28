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
//! 1. The agent generates an ed25519 install keypair locally; the FULL public key
//!    (base64) is the `publicKey` the enrollment binds to (non-transferable).
//! 2. `POST /v1/enrollments/device/start` with `{ workspaceId, publicKey, os, arch,
//!    machineName?, canOfferDisplay, requestsScreenControl }` (camelCase) → a
//!    `userCode` + `verificationUri` the human visits to consent + authorize.
//! 3. The agent prints the code/URL and polls `POST /v1/enrollments/device/poll`
//!    with `{ deviceCode }` until the state is `authorized` (carrying
//!    [`EnrollmentCredentials`]), `denied`, `expired`, or `disabled`, honoring the
//!    server's poll interval (the API rate-limits via HTTP 429, not `slow_down`).
//! 4. The caller persists the returned credentials `0600` (see
//!    [`crate::config::save_credentials`]).

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
    /// The control-plane API base URL (e.g. `https://api.opengeni.ai`).
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
            "verificationUri": "https://get.opengeni.ai/device"
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
}
