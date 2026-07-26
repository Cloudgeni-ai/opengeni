//! The canonical cross-stack test corpus.
//!
//! These builders produce the EXACT same logical messages that the TypeScript
//! round-trip test builds (`packages/agent-proto/test/corpus.ts`). The round-trip
//! test encodes them in one language and decodes in the other, proving the two
//! generated stacks agree on the wire (the M0 "never drift" guarantee).
//!
//! Keep these in lock-step with the TS corpus. Two messages are exercised:
//!
//! * [`canonical_control_response`] — a map-free message used for the strict
//!   byte-for-byte cross-stack equality check (its proto3 encoding is canonical
//!   and deterministic across implementations).
//! * [`canonical_control_request`] — a richer message that also carries a `map`
//!   field; map field order is not guaranteed deterministic across stacks, so it
//!   is checked by decoded-field equality (with a single map entry) rather than
//!   byte equality.

use crate::v1;

/// A map-free `ControlResponse` carrying a structured git status. Used for the
/// strict byte-equality cross-stack check.
#[must_use]
pub fn canonical_control_response() -> v1::ControlResponse {
    v1::ControlResponse {
        request_id: "req-0001".to_string(),
        error: None,
        result: Some(v1::control_response::Result::Git(v1::GitResponse {
            exit_code: 0,
            stdout: prost::bytes::Bytes::from_static(b"on branch main\n"),
            stderr: prost::bytes::Bytes::new(),
            status: Some(v1::GitStatus {
                branch: "main".to_string(),
                upstream: "origin/main".to_string(),
                ahead: 2,
                behind: 0,
                files: vec![
                    v1::GitFileStatus {
                        path: "src/lib.rs".to_string(),
                        code: " M".to_string(),
                        staged: false,
                    },
                    v1::GitFileStatus {
                        path: "README.md".to_string(),
                        code: "??".to_string(),
                        staged: false,
                    },
                ],
                clean: false,
            }),
        })),
    }
}

/// A richer `ControlRequest` exercising strings, a u32, an enum, repeated
/// strings, bytes, and a single-entry map (via the wrapped `ExecRequest`).
#[must_use]
pub fn canonical_control_request() -> v1::ControlRequest {
    let mut env = std::collections::HashMap::new();
    env.insert("OPENGENI_AGENT".to_string(), "1".to_string());

    v1::ControlRequest {
        request_id: "req-0002".to_string(),
        epoch: 7,
        op: Some(v1::control_request::Op::Exec(v1::ExecRequest {
            command: vec!["echo".to_string(), "hello".to_string()],
            shell: false,
            cwd: "/home/user/repo".to_string(),
            env,
            stdin: prost::bytes::Bytes::from_static(b"piped-input"),
            timeout_ms: 5_000,
        })),
    }
}

/// A `Hello` exercising enums, a nested `Capabilities` + `Display`, and strings —
/// the connect handshake. Map-free, so also byte-equality-checkable.
#[must_use]
pub fn canonical_hello() -> v1::Hello {
    v1::Hello {
        agent_id: "agent-abc".to_string(),
        workspace_id: "ws-xyz".to_string(),
        agent_version: "0.1.0".to_string(),
        os: v1::Os::Linux as i32,
        arch: v1::Arch::X8664 as i32,
        machine_name: "buildbox".to_string(),
        workspace_root: "/home/user".to_string(),
        capabilities: Some(v1::Capabilities {
            exec: true,
            filesystem: true,
            git: true,
            pty: true,
            desktop: false,
            consented_whole_machine: true,
            consented_screen_control: false,
            display: Some(v1::Display {
                id: ":99".to_string(),
                width: 1920,
                height: 1080,
                r#virtual: true,
            }),
            // desktop:false + a display present + a reason mirrors the capture-blocked
            // case; a non-empty value here exercises the field's cross-stack round-trip.
            desktop_unavailable_reason: "screen recording not granted".to_string(),
            // Left at the proto3 default (false), so the canonical Hello's encoded
            // bytes are unchanged and the existing cross-stack fixtures stay valid.
            op_stream: false,
        }),
        update_channel: "stable".to_string(),
        resume_token: "resume-token-1".to_string(),
    }
}

#[cfg(test)]
mod roundtrip {
    //! The Rust side of the cross-stack round-trip proof.
    //!
    //! 1. Self-round-trip: every canonical message encodes and decodes back to
    //!    itself (sanity that the Rust codec is correct).
    //! 2. Cross-stack: if the TypeScript-produced fixture (`ts_encoded.txt`) is
    //!    present, decode each TS-encoded message with the Rust codec and assert
    //!    it equals the canonical value — proving a TS-encoded message decodes
    //!    correctly in Rust (one half of "no drift"). The other half (Rust → TS)
    //!    is proven by the TypeScript test reading the Rust-produced fixture.
    //! 3. Byte-equality: for the map-free messages, assert the bytes the Rust
    //!    codec produces are IDENTICAL to the bytes the TS codec produced — the
    //!    strongest form of agreement (canonical proto3 wire bytes match).

    use super::{canonical_control_request, canonical_control_response, canonical_hello};
    use crate::v1;
    use crate::Message;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn fixtures_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .map(|agent_root| agent_root.join("tests").join("fixtures"))
            .expect("resolve fixtures dir")
    }

    /// Parses a `name=hex\n` fixture file into a name → bytes map.
    fn load_fixture(name: &str) -> Option<HashMap<String, Vec<u8>>> {
        let path = fixtures_dir().join(name);
        let body = std::fs::read_to_string(&path).ok()?;
        let mut map = HashMap::new();
        for raw in body.lines() {
            let raw = raw.trim();
            if raw.is_empty() {
                continue;
            }
            let (key, hex) = raw.split_once('=').expect("fixture line is name=hex");
            let bytes = (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("valid hex"))
                .collect();
            map.insert(key.to_string(), bytes);
        }
        Some(map)
    }

    #[test]
    fn self_round_trip() {
        let resp = canonical_control_response();
        let decoded = v1::ControlResponse::decode(resp.encode_to_vec().as_slice()).unwrap();
        assert_eq!(resp, decoded);

        let req = canonical_control_request();
        let decoded = v1::ControlRequest::decode(req.encode_to_vec().as_slice()).unwrap();
        assert_eq!(req, decoded);

        let hello = canonical_hello();
        let decoded = v1::Hello::decode(hello.encode_to_vec().as_slice()).unwrap();
        assert_eq!(hello, decoded);
    }

    #[test]
    fn cross_stack_ts_to_rust() {
        let Some(ts) = load_fixture("ts_encoded.txt") else {
            // The TS fixture has not been generated in this checkout; the driver
            // (agent/scripts/roundtrip.sh) generates it. Skip rather than fail so
            // `cargo test` is green standalone, but assert it's present in CI via
            // the committed fixture.
            eprintln!("ts_encoded.txt absent — skipping cross-stack decode (run roundtrip.sh)");
            return;
        };

        // A TS-encoded message must decode correctly under the Rust codec.
        let resp = v1::ControlResponse::decode(ts["control_response"].as_slice())
            .expect("decode TS-encoded ControlResponse in Rust");
        assert_eq!(
            resp,
            canonical_control_response(),
            "TS-encoded ControlResponse did not decode to the canonical value in Rust"
        );

        let req = v1::ControlRequest::decode(ts["control_request"].as_slice())
            .expect("decode TS-encoded ControlRequest in Rust");
        assert_eq!(
            req,
            canonical_control_request(),
            "TS-encoded ControlRequest did not decode to the canonical value in Rust"
        );

        let hello =
            v1::Hello::decode(ts["hello"].as_slice()).expect("decode TS-encoded Hello in Rust");
        assert_eq!(
            hello,
            canonical_hello(),
            "TS-encoded Hello did not decode to the canonical value in Rust"
        );

        // Strongest check: for the map-free messages the wire bytes match exactly.
        assert_eq!(
            canonical_control_response().encode_to_vec(),
            ts["control_response"],
            "Rust and TS produced different wire bytes for ControlResponse"
        );
        assert_eq!(
            canonical_hello().encode_to_vec(),
            ts["hello"],
            "Rust and TS produced different wire bytes for Hello"
        );
    }
}
