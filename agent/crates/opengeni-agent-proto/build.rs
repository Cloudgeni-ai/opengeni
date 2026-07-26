//! Build script for `opengeni-agent-proto`.
//!
//! Compiles `agent/proto/opengeni_agent.proto` into Rust types at build time.
//!
//! We deliberately use [`protox`] (a pure-Rust protobuf compiler) to produce the
//! `FileDescriptorSet` and feed it to `prost-build`, rather than shelling out to
//! a `protoc` binary. This keeps `cargo build` hermetic — no external `protoc`
//! dependency — which matters on NixOS, where downloaded binaries don't run and
//! a system `protoc` may be absent. The TypeScript side of the codegen uses the
//! same `.proto` (see `agent/scripts/codegen.sh`), and the cross-stack
//! round-trip test proves the two generated stacks agree.

use std::path::PathBuf;

fn main() {
    let proto_root = workspace_proto_dir();
    let proto_file = proto_root.join("opengeni_agent.proto");

    // Recompile if the schema changes.
    println!("cargo:rerun-if-changed={}", proto_file.display());

    // Pure-Rust compile to a FileDescriptorSet (no `protoc` binary needed).
    let file_descriptors = protox::compile([&proto_file], [&proto_root])
        .expect("failed to compile opengeni_agent.proto with protox");

    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR not set"));

    prost_build::Config::new()
        .out_dir(&out_dir)
        // Derive Eq/Hash where prost allows, so generated types are ergonomic in
        // dispatch tables and tests.
        .bytes(["."])
        .compile_fds(file_descriptors)
        .expect("failed to generate Rust types from FileDescriptorSet");
}

/// Resolves `agent/proto/` relative to this crate (`agent/crates/opengeni-agent-proto`).
fn workspace_proto_dir() -> PathBuf {
    let manifest_dir =
        PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set"));
    // crates/opengeni-agent-proto -> crates -> agent, then /proto.
    manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|agent_root| agent_root.join("proto"))
        .expect("could not resolve agent/proto directory from CARGO_MANIFEST_DIR")
}
