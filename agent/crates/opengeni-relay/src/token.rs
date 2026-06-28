//! Token verify — the Rust mirror of the TypeScript `ogs_`/`ogr_` HMAC mint.
//!
//! The relay must verify TWO independently-minted tokens:
//!
//! * the VIEWER's scoped stream token ([`verify_stream_token`], `ogs_` prefix),
//!   minted by the control plane (`signStreamToken`,
//!   `packages/runtime/src/sandbox/stream-token.ts` /
//!   `packages/contracts/src/index.ts`), carrying the lease-epoch fence;
//! * the AGENT's relay producer token ([`verify_relay_token`], `ogr_` prefix),
//!   minted at enrollment (`signRelayToken`, `packages/contracts/src/index.ts`),
//!   binding the workspace + agent so a producer can only register its own
//!   channels.
//!
//! # The single-source HMAC envelope (the §10.5 contract)
//!
//! BOTH the control plane (TypeScript) and this relay (Rust) MUST agree on the
//! exact wire shape, or a valid token would be rejected. The shape is, for a token
//! with prefix `P` and a JSON claims object `C`:
//!
//! ```text
//!   token        = "P" || encodedPayload || "." || signature
//!   encodedPayload = base64url_nopad( utf8( JSON.stringify(C) ) )
//!   signature      = base64url_nopad( HMAC_SHA256( secret_utf8, utf8(encodedPayload) ) )
//! ```
//!
//! Notes that make TS-mint and Rust-verify provably agree:
//!
//! * `base64url` is RFC 4648 url-safe (`-`/`_`) WITHOUT padding — matching Node's
//!   `Buffer.from(x).toString("base64url")` (which drops padding) and ts-proto's
//!   browser fallback.
//! * the HMAC input is the *encoded payload string's UTF-8 bytes*, NOT the raw JSON
//!   — i.e. we sign the already-base64url'd payload, exactly as
//!   `hmacSha256Base64Url(secret, encodedPayload)` does in TS.
//! * the signature comparison is constant-time over the base64url signature STRINGS
//!   (the TS `constantTimeEqual` compares the encoded strings too).
//! * the claims are decoded from `base64UrlDecode(encodedPayload)` and validated
//!   against the same field set + `exp >= now` the TS `verify*` does.
//!
//! The JSON field NAMES must match the TS schema exactly (camelCase: `workspaceId`,
//! `sessionId`, `viewerId`, `leaseEpoch`, `mode`, `port`, `exp`; `agentId`); the
//! cross-stack fixture (`tests/cross_stack_token.rs`) reads tokens the TS mint
//! produced and asserts this Rust verify accepts them, locking the agreement.

use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use subtle::ConstantTimeEq;

/// The prefix of a scoped viewer stream token.
pub const STREAM_TOKEN_PREFIX: &str = "ogs_";
/// The prefix of an agent relay producer token.
pub const RELAY_TOKEN_PREFIX: &str = "ogr_";

type HmacSha256 = Hmac<Sha256>;

/// The verified claims of a viewer `ogs_` stream token. Field names mirror the
/// TypeScript `StreamTokenPayload` (camelCase JSON keys).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct StreamTokenClaims {
    /// The workspace the token is scoped to.
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    /// The session the viewer is watching.
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// The viewer holder id the token is scoped to.
    #[serde(rename = "viewerId")]
    pub viewer_id: String,
    /// The lease/active epoch the token is fenced to — the relay's stale-viewer
    /// fence (dossier §10.6/§18).
    #[serde(rename = "leaseEpoch")]
    pub lease_epoch: u64,
    /// `"view"` (always, v1) or `"control"` (the never-granted raw-input plane).
    pub mode: String,
    /// The exposed stream port the token pins to.
    pub port: u32,
    /// Expiry, unix seconds.
    pub exp: i64,
}

/// The verified claims of an agent `ogr_` relay producer token. Field names mirror
/// the TypeScript `RelayTokenPayload`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RelayTokenClaims {
    /// The workspace the agent (and its channels) belong to.
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    /// The agent (machine) id — the relay asserts this equals the channel-key agent.
    #[serde(rename = "agentId")]
    pub agent_id: String,
    /// Expiry, unix seconds.
    pub exp: i64,
}

/// Why a token failed to verify (so the relay logs/acks a precise reason without
/// leaking the token).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenError {
    /// The token did not carry the expected prefix.
    BadPrefix,
    /// The `payload.signature` structure was malformed (no `.`, empty payload).
    Malformed,
    /// The HMAC signature did not match (wrong secret or tampered).
    BadSignature,
    /// The base64url payload did not decode, or the claims were schema-invalid.
    BadClaims,
    /// The token's `exp` is in the past.
    Expired,
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Self::BadPrefix => "token has the wrong prefix",
            Self::Malformed => "token is malformed",
            Self::BadSignature => "token signature is invalid",
            Self::BadClaims => "token claims are invalid",
            Self::Expired => "token is expired",
        };
        f.write_str(s)
    }
}

impl std::error::Error for TokenError {}

/// Verify a viewer `ogs_` stream token against `secret`, returning its claims.
///
/// `now_seconds` is the current unix time (injected so tests are deterministic).
/// Mirrors the TypeScript `verifyStreamToken` exactly (authenticity + freshness);
/// the lease-epoch fence + workspace/session scope are enforced by the caller
/// against the channel key (see [`registry`](crate::registry)).
///
/// # Errors
///
/// A [`TokenError`] describing which gate failed.
pub fn verify_stream_token(
    secret: &str,
    token: &str,
    now_seconds: i64,
) -> Result<StreamTokenClaims, TokenError> {
    let encoded_payload = verify_envelope(secret, token, STREAM_TOKEN_PREFIX)?;
    let claims: StreamTokenClaims = decode_claims(encoded_payload)?;
    if claims.exp < now_seconds {
        return Err(TokenError::Expired);
    }
    Ok(claims)
}

/// Verify an agent `ogr_` relay producer token against `secret`, returning its
/// claims. Mirrors the TypeScript `verifyRelayToken`; the channel-key (ws+agent)
/// scope is enforced by the caller.
///
/// # Errors
///
/// A [`TokenError`] describing which gate failed.
pub fn verify_relay_token(
    secret: &str,
    token: &str,
    now_seconds: i64,
) -> Result<RelayTokenClaims, TokenError> {
    let encoded_payload = verify_envelope(secret, token, RELAY_TOKEN_PREFIX)?;
    let claims: RelayTokenClaims = decode_claims(encoded_payload)?;
    if claims.exp < now_seconds {
        return Err(TokenError::Expired);
    }
    Ok(claims)
}

/// The shared envelope verify: strip the prefix, split `encodedPayload.signature`,
/// recompute the HMAC over the encoded payload, and constant-time-compare the
/// base64url signatures. Returns the `encodedPayload` for claim decoding.
fn verify_envelope<'t>(secret: &str, token: &'t str, prefix: &str) -> Result<&'t str, TokenError> {
    let without_prefix = token.strip_prefix(prefix).ok_or(TokenError::BadPrefix)?;
    // `lastIndexOf('.')`: the signature is base64url (no `.`), so the last dot
    // splits payload from signature — robust even though base64url has no dots.
    let dot = without_prefix.rfind('.').ok_or(TokenError::Malformed)?;
    if dot == 0 {
        // An empty payload (`.sig`) is malformed (TS requires dot > 0).
        return Err(TokenError::Malformed);
    }
    let (encoded_payload, rest) = without_prefix.split_at(dot);
    let signature = &rest[1..]; // skip the '.'

    let expected = hmac_sha256_base64url(secret, encoded_payload.as_bytes());
    // Constant-time compare over the base64url signature strings (TS parity). A
    // length mismatch short-circuits to non-equal without leaking via timing.
    let ok: bool = expected.as_bytes().ct_eq(signature.as_bytes()).into();
    if !ok {
        return Err(TokenError::BadSignature);
    }
    Ok(encoded_payload)
}

/// Decode the base64url(no-pad) JSON claims into `T`.
fn decode_claims<T: for<'de> Deserialize<'de>>(encoded_payload: &str) -> Result<T, TokenError> {
    let json = base64_url_decode(encoded_payload).ok_or(TokenError::BadClaims)?;
    serde_json::from_slice(&json).map_err(|_| TokenError::BadClaims)
}

/// `base64url_nopad( HMAC_SHA256(secret_utf8, message) )` — the TS
/// `hmacSha256Base64Url` mirror.
fn hmac_sha256_base64url(secret: &str, message: &[u8]) -> String {
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts a key of any length");
    mac.update(message);
    let bytes = mac.finalize().into_bytes();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Decode a base64url string, accepting both padded and unpadded input (Node's
/// `Buffer.from(x, "base64url")` tolerates padding; we accept either so a future TS
/// change to emit padding would not silently break verify).
fn base64_url_decode(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s.trim_end_matches('='))
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    // The Rust-side mint helpers used to prove verify accepts what mint produces.
    // The CROSS-STACK proof (a token the TypeScript mint produced) lives in
    // `tests/cross_stack_token.rs`, which reads a committed fixture.
    fn mint(prefix: &str, secret: &str, payload_json: &str) -> String {
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload_json);
        let sig = hmac_sha256_base64url(secret, encoded.as_bytes());
        format!("{prefix}{encoded}.{sig}")
    }

    fn stream_payload(epoch: u64, exp: i64) -> String {
        format!(
            r#"{{"workspaceId":"ws-1","sessionId":"sess-1","viewerId":"v-1","leaseEpoch":{epoch},"mode":"view","port":7681,"exp":{exp}}}"#
        )
    }

    #[test]
    fn verifies_a_well_formed_stream_token() {
        let token = mint(
            STREAM_TOKEN_PREFIX,
            "sekret",
            &stream_payload(3, 9_999_999_999),
        );
        let claims = verify_stream_token("sekret", &token, 1_000).expect("verify");
        assert_eq!(claims.workspace_id, "ws-1");
        assert_eq!(claims.lease_epoch, 3);
        assert_eq!(claims.port, 7681);
        assert_eq!(claims.mode, "view");
    }

    #[test]
    fn rejects_a_wrong_secret() {
        let token = mint(
            STREAM_TOKEN_PREFIX,
            "sekret",
            &stream_payload(3, 9_999_999_999),
        );
        assert_eq!(
            verify_stream_token("other", &token, 1_000).unwrap_err(),
            TokenError::BadSignature
        );
    }

    #[test]
    fn rejects_a_tampered_payload() {
        let token = mint(
            STREAM_TOKEN_PREFIX,
            "sekret",
            &stream_payload(3, 9_999_999_999),
        );
        // Flip one payload char; the signature no longer matches.
        let mut chars: Vec<char> = token.chars().collect();
        let i = STREAM_TOKEN_PREFIX.len() + 2;
        chars[i] = if chars[i] == 'A' { 'B' } else { 'A' };
        let tampered: String = chars.into_iter().collect();
        assert!(matches!(
            verify_stream_token("sekret", &tampered, 1_000),
            Err(TokenError::BadSignature | TokenError::BadClaims)
        ));
    }

    #[test]
    fn rejects_an_expired_token() {
        let token = mint(STREAM_TOKEN_PREFIX, "sekret", &stream_payload(3, 500));
        assert_eq!(
            verify_stream_token("sekret", &token, 1_000).unwrap_err(),
            TokenError::Expired
        );
    }

    #[test]
    fn rejects_a_wrong_prefix() {
        // An `ogr_` token presented where an `ogs_` is expected.
        let token = mint(
            RELAY_TOKEN_PREFIX,
            "sekret",
            &stream_payload(3, 9_999_999_999),
        );
        assert_eq!(
            verify_stream_token("sekret", &token, 1_000).unwrap_err(),
            TokenError::BadPrefix
        );
    }

    #[test]
    fn rejects_malformed_envelopes() {
        assert_eq!(
            verify_stream_token("s", "ogs_no-dot", 0).unwrap_err(),
            TokenError::Malformed
        );
        assert_eq!(
            verify_stream_token("s", "ogs_.sig", 0).unwrap_err(),
            TokenError::Malformed
        );
        assert_eq!(
            verify_stream_token("s", "not-a-token", 0).unwrap_err(),
            TokenError::BadPrefix
        );
    }

    #[test]
    fn verifies_a_relay_producer_token() {
        let payload = r#"{"workspaceId":"ws-1","agentId":"ag-1","exp":9999999999}"#;
        let token = mint(RELAY_TOKEN_PREFIX, "relaysecret", payload);
        let claims = verify_relay_token("relaysecret", &token, 1_000).expect("verify");
        assert_eq!(claims.workspace_id, "ws-1");
        assert_eq!(claims.agent_id, "ag-1");
    }
}
