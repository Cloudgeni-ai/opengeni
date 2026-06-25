//! The OpenGeni self-hosted agent binary.
//!
//! Stub for milestone M0 — the real implementation (enrollment device-flow, NATS
//! dial + RPC dispatch over the [`opengeni_agent_proto`] wire types, the
//! resiliency supervisor with full-jitter backoff, the foreground run model, and
//! the `service`/`enroll`/`uninstall`/`update` subcommands) arrives in later
//! milestones (M6/M11). For now this exists so the workspace builds and the
//! crate graph is wired end to end.

use opengeni_agent_proto::{v1, Message};

/// Entry point. A no-op until the supervisor lands in M6.
fn main() {
    // Exercise the generated wire types so the dependency edge is real and any
    // drift in the generated code surfaces at build time here too.
    let hello = v1::PingRequest { nonce: 0 };
    let encoded_len = hello.encoded_len();
    println!(
        "opengeni-agent {} (M0 skeleton; proto wire types linked, ping={encoded_len}B)",
        env!("CARGO_PKG_VERSION"),
    );
}
