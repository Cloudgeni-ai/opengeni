//! Device-flow enrollment client (OAuth 2.0 device authorization, RFC 8628).
//!
//! This is the **single module that owns the enrollment HTTP wire shape** — the
//! one-file reconciliation seam with the M5 control-plane work (dossier §M6 task,
//! item 2). M5 is finalizing the exact JSON field names of the
//! `/enrollments/device/{start,poll}` endpoints concurrently against the SAME
//! contract; everything here is coded against the proto messages
//! ([`EnrollmentCredentials`](opengeni_agent_proto::v1::EnrollmentCredentials),
//! [`DeviceAuthState`](opengeni_agent_proto::v1::DeviceAuthState)) and these
//! paths, with the HTTP request/response structs ([`wire`]) isolated here so a
//! field-name delta at integration is a change to this file alone.
//!
//! ## Flow (dossier §10.1 / §23.1)
//!
//! 1. The agent generates an ed25519 install keypair locally (the fingerprint
//!    binds the issued credentials to this install — they are non-transferable).
//! 2. `POST /enrollments/device/start` with the pubkey fingerprint + os/arch +
//!    machine name + the display/screen-control offer → a `user_code` +
//!    `verification_uri` the human visits to consent + authorize.
//! 3. The agent prints the code/URL and polls `POST /enrollments/device/poll`
//!    until the state is AUTHORIZED (carrying [`EnrollmentCredentials`]), DENIED,
//!    or EXPIRED, honoring the server's poll interval + SLOW_DOWN backoff.
//! 4. The caller persists the returned credentials `0600` (see
//!    [`crate::config::save_credentials`]).

use std::time::Duration;

use base64::Engine as _;
#[cfg(test)]
use ed25519_dalek::Signer as _;
use ed25519_dalek::SigningKey;
use opengeni_agent_proto::v1::{Arch, DeviceAuthState, EnrollmentCredentials, Os};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// The endpoint paths, appended to the configured API base URL. Kept as
/// constants beside the wire structs so a path rename is also a one-file change.
const START_PATH: &str = "/enrollments/device/start";
const POLL_PATH: &str = "/enrollments/device/poll";

/// What the user offered at install time, sent in the start request so the
/// consent page can present the right toggles.
#[derive(Debug, Clone, Copy)]
pub struct EnrollmentOffer {
    /// The host OS family.
    pub os: Os,
    /// The host CPU architecture.
    pub arch: Arch,
    /// Whether this machine can offer a graphical display (drives the
    /// screen-control consent toggle on the page).
    pub offers_display: bool,
}

/// Inputs to a device-flow enrollment.
#[derive(Debug, Clone)]
pub struct EnrollmentRequest {
    /// The control-plane API base URL (e.g. `https://api.opengeni.ai`).
    pub api_base_url: String,
    /// A human-friendly machine name (hostname by default).
    pub machine_name: String,
    /// The update channel selected at install (`stable`|`beta`).
    pub update_channel: String,
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
    /// The server returned a state value the agent does not understand.
    #[error("server returned an unknown device-auth state: {0}")]
    UnknownState(i32),
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
/// public-key fingerprint is sent to the control plane to bind the credentials
/// to this install.
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

    /// The base64 (standard, no-pad) encoding of the 32-byte ed25519 public key —
    /// the install fingerprint sent to the control plane.
    #[must_use]
    pub fn fingerprint(&self) -> String {
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
        install_fingerprint: identity.fingerprint(),
        os: os_str(req.offer.os),
        arch: arch_str(req.offer.arch),
        machine_name: req.machine_name.clone(),
        update_channel: req.update_channel.clone(),
        offers_display: req.offer.offers_display,
    };
    let resp = client.post(&url).json(&body).send().await?;
    parse_json::<wire::StartResponse>(resp, START_PATH).await
}

/// Polls `POST /enrollments/device/poll` until the flow resolves, honoring the
/// server's poll interval and SLOW_DOWN throttling.
async fn poll_until_resolved(
    client: &reqwest::Client,
    req: &EnrollmentRequest,
    start: &wire::StartResponse,
) -> Result<EnrollmentCredentials, EnrollmentError> {
    let url = join_url(&req.api_base_url, POLL_PATH);
    let mut interval = Duration::from_secs(u64::from(start.poll_interval_seconds.max(1)));
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

        match DeviceAuthState::try_from(poll.state).unwrap_or(DeviceAuthState::Unspecified) {
            DeviceAuthState::Authorized => {
                return poll
                    .credentials
                    .map(wire::Credentials::into_proto)
                    .ok_or(EnrollmentError::MissingCredentials);
            }
            DeviceAuthState::Pending => { /* keep polling at the current interval */ }
            DeviceAuthState::SlowDown => {
                // RFC 8628: increase the interval by 5s on SLOW_DOWN.
                interval += Duration::from_secs(5);
            }
            DeviceAuthState::Denied => return Err(EnrollmentError::Denied),
            DeviceAuthState::Expired => return Err(EnrollmentError::Expired),
            DeviceAuthState::Unspecified => return Err(EnrollmentError::UnknownState(poll.state)),
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

/// The HTTP wire shapes — **the single reconciliation point with M5**.
///
/// Every JSON field name the agent sends/receives lives here. M5 is finalizing
/// the exact endpoint payloads concurrently; if a field is renamed at
/// integration, the change is a `#[serde(rename = "...")]` (or a field rename) in
/// THIS module and nothing else. The structs convert to/from the proto messages
/// at their edges so the rest of the agent only ever sees proto types.
mod wire {
    use super::{Deserialize, EnrollmentCredentials, Serialize};

    /// Body of `POST /enrollments/device/start`.
    #[derive(Debug, Serialize)]
    pub(super) struct StartRequest {
        /// The ed25519 install public-key fingerprint (base64).
        pub install_fingerprint: String,
        /// OS family (`linux`/`macos`/`windows`).
        pub os: String,
        /// CPU arch (`x86_64`/`aarch64`).
        pub arch: String,
        /// Human-friendly machine name.
        pub machine_name: String,
        /// Update channel (`stable`/`beta`).
        pub update_channel: String,
        /// Whether this machine can offer a display (screen-control consent).
        pub offers_display: bool,
    }

    /// Response of `POST /enrollments/device/start`.
    #[derive(Debug, Deserialize)]
    pub(super) struct StartResponse {
        pub user_code: String,
        pub device_code: String,
        pub verification_uri: String,
        #[serde(default)]
        pub verification_uri_complete: String,
        #[serde(default)]
        pub expires_in_seconds: u32,
        #[serde(default = "default_poll_interval")]
        pub poll_interval_seconds: u32,
    }

    fn default_poll_interval() -> u32 {
        5
    }

    /// Body of `POST /enrollments/device/poll`.
    #[derive(Debug, Serialize)]
    pub(super) struct PollRequest {
        pub device_code: String,
    }

    /// Response of `POST /enrollments/device/poll`. `state` is the integer value
    /// of the proto `DeviceAuthState` enum; `credentials` is present only when
    /// authorized.
    #[derive(Debug, Deserialize)]
    pub(super) struct PollResponse {
        pub state: i32,
        #[serde(default)]
        pub credentials: Option<Credentials>,
    }

    /// The credentials sub-object on an authorized poll. Mirrors the proto
    /// [`EnrollmentCredentials`] field-for-field; [`Credentials::into_proto`] is
    /// the single conversion site.
    // `nats_credentials` ends with the struct name, but the field name is the
    // load-bearing JSON wire key (the M5 contract) — renaming it would break the
    // single reconciliation point this module exists to be. Allow is correct.
    #[allow(clippy::struct_field_names)]
    #[derive(Debug, Deserialize)]
    pub(super) struct Credentials {
        pub agent_id: String,
        pub workspace_id: String,
        pub nats_credentials: String,
        #[serde(default)]
        pub nats_urls: Vec<String>,
        #[serde(default)]
        pub relay_url: String,
        #[serde(default)]
        pub update_pubkey: String,
        #[serde(default)]
        pub consented_whole_machine: bool,
        #[serde(default)]
        pub consented_screen_control: bool,
    }

    impl Credentials {
        /// Converts the wire credentials into the proto message the rest of the
        /// agent consumes.
        pub(super) fn into_proto(self) -> EnrollmentCredentials {
            EnrollmentCredentials {
                agent_id: self.agent_id,
                workspace_id: self.workspace_id,
                nats_credentials: self.nats_credentials,
                nats_urls: self.nats_urls,
                relay_url: self.relay_url,
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
    fn install_fingerprint_is_stable_per_identity() {
        let id = InstallIdentity::generate();
        assert_eq!(id.fingerprint(), id.fingerprint());
        // 32-byte ed25519 pubkey -> 43 base64 (no-pad) chars.
        assert_eq!(id.fingerprint().len(), 43);
    }

    #[test]
    fn distinct_identities_have_distinct_fingerprints() {
        assert_ne!(
            InstallIdentity::generate().fingerprint(),
            InstallIdentity::generate().fingerprint()
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
        let json = r#"{
            "agent_id": "a", "workspace_id": "w",
            "nats_credentials": "creds", "nats_urls": ["tls://x:4222"],
            "relay_url": "https://r", "update_pubkey": "k",
            "consented_whole_machine": true, "consented_screen_control": false
        }"#;
        let wire: wire::Credentials = serde_json::from_str(json).expect("parse");
        let proto = wire.into_proto();
        assert_eq!(proto.agent_id, "a");
        assert_eq!(proto.nats_urls, vec!["tls://x:4222".to_string()]);
        assert!(proto.consented_whole_machine);
        assert!(!proto.consented_screen_control);
    }

    #[test]
    fn poll_response_parses_authorized_with_credentials() {
        let json = r#"{
            "state": 2,
            "credentials": {
                "agent_id": "a", "workspace_id": "w", "nats_credentials": "c"
            }
        }"#;
        let poll: wire::PollResponse = serde_json::from_str(json).expect("parse");
        assert_eq!(poll.state, DeviceAuthState::Authorized as i32);
        assert!(poll.credentials.is_some());
    }

    #[test]
    fn start_response_uses_default_poll_interval_when_absent() {
        let json = r#"{
            "user_code": "ABCD-1234",
            "device_code": "dev",
            "verification_uri": "https://get.opengeni.ai/device"
        }"#;
        let start: wire::StartResponse = serde_json::from_str(json).expect("parse");
        assert_eq!(start.poll_interval_seconds, 5);
    }

    #[test]
    fn os_and_arch_strings_are_lowercase_target_triples() {
        assert_eq!(os_str(Os::Linux), "linux");
        assert_eq!(os_str(Os::Macos), "macos");
        assert_eq!(arch_str(Arch::X8664), "x86_64");
        assert_eq!(arch_str(Arch::Aarch64), "aarch64");
    }
}
