//! Fixture generator for the cross-stack round-trip test.
//!
//! Encodes the canonical corpus ([`opengeni_agent_proto::corpus`]) and writes the
//! bytes (hex-encoded, one `name=hex` line per message) to
//! `agent/tests/fixtures/rust_encoded.txt`. The TypeScript round-trip test reads
//! this file and decodes it; symmetrically, the Rust round-trip test reads the
//! TS-produced `ts_encoded.txt`. Run via `agent/scripts/roundtrip.sh`.
//!
//! Build with `--features test-corpus`.

use std::path::PathBuf;

use opengeni_agent_proto::{corpus, Message};

fn main() {
    let fixtures_dir = fixtures_dir();
    std::fs::create_dir_all(&fixtures_dir).expect("create fixtures dir");

    let mut out = String::new();
    out.push_str(&line(
        "control_response",
        &corpus::canonical_control_response().encode_to_vec(),
    ));
    out.push_str(&line(
        "control_request",
        &corpus::canonical_control_request().encode_to_vec(),
    ));
    out.push_str(&line("hello", &corpus::canonical_hello().encode_to_vec()));

    let path = fixtures_dir.join("rust_encoded.txt");
    std::fs::write(&path, out).expect("write rust fixture");
    println!("wrote {}", path.display());
}

/// Formats one `name=hex\n` fixture line.
fn line(name: &str, bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut hex = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(hex, "{b:02x}");
    }
    format!("{name}={hex}\n")
}

/// `agent/tests/fixtures` resolved from this crate.
fn fixtures_dir() -> PathBuf {
    let manifest_dir =
        PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|agent_root| agent_root.join("tests").join("fixtures"))
        .expect("resolve fixtures dir")
}
