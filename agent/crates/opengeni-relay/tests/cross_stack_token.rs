//! Cross-stack token-contract proof (the §10.5 single-source guarantee).
//!
//! The control plane mints the viewer `ogs_` stream token and the agent `ogr_`
//! relay producer token in TypeScript (`packages/contracts` `signStreamToken` /
//! `signRelayToken`). The relay verifies them in Rust (`opengeni_relay::token`).
//! For a real viewer/agent dial to be accepted, the two stacks MUST agree on the
//! exact HMAC envelope. This test reads tokens the TS mint actually produced
//! (committed fixture) and asserts the Rust verify accepts them with the right
//! claims — so any drift in either stack fails CI loudly.
//!
//! Regenerate the fixture with
//! `bun run agent/crates/opengeni-relay/scripts/mint-fixtures.ts`.

use std::collections::HashMap;
use std::path::PathBuf;

use opengeni_relay::token::{verify_relay_token, verify_stream_token, TokenError};

/// Parse the `key=value` fixture into a map.
fn load_fixture() -> HashMap<String, String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("ts_minted_tokens.txt");
    let body = std::fs::read_to_string(&path).expect("read fixture");
    let mut map = HashMap::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            map.insert(k.to_string(), v.to_string());
        }
    }
    map
}

#[test]
fn rust_verifies_a_ts_minted_stream_token() {
    let f = load_fixture();
    let secret = &f["secret"];
    let token = &f["ogs"];
    // A time before the fixture's exp (2100-01-01).
    let now = 1_700_000_000;
    let claims = verify_stream_token(secret, token, now)
        .expect("the Rust relay must accept a TS-minted ogs_ token");
    assert_eq!(claims.workspace_id, f["workspaceId"]);
    assert_eq!(claims.session_id, f["sessionId"]);
    assert_eq!(claims.viewer_id, f["viewerId"]);
    assert_eq!(claims.lease_epoch, f["leaseEpoch"].parse::<u64>().unwrap());
    assert_eq!(claims.port, f["port"].parse::<u32>().unwrap());
    assert_eq!(claims.mode, "view");
}

#[test]
fn rust_verifies_a_ts_minted_relay_token() {
    let f = load_fixture();
    let secret = &f["secret"];
    let token = &f["ogr"];
    let claims = verify_relay_token(secret, token, 1_700_000_000)
        .expect("the Rust relay must accept a TS-minted ogr_ token");
    assert_eq!(claims.workspace_id, f["workspaceId"]);
    assert_eq!(claims.agent_id, f["agentId"]);
}

#[test]
fn rust_rejects_a_ts_token_under_a_wrong_secret() {
    // The negative half: a token minted by TS under the real secret must NOT verify
    // under a different secret (the relay only trusts its configured secret).
    let f = load_fixture();
    assert_eq!(
        verify_stream_token("a-different-secret", &f["ogs"], 1_700_000_000).unwrap_err(),
        TokenError::BadSignature
    );
}
