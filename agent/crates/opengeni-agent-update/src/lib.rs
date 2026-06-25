//! Self-update for the OpenGeni self-hosted agent.
//!
//! Stub for milestone M0. The real crate will consume the signed channel
//! [`opengeni_agent_proto::v1::UpdateManifest`] (codegen'd from the same IDL so
//! the TS publisher and Rust consumer never drift), verify artifacts with
//! minisign + sha256 against the embedded pinned key, atomically self-replace
//! (incl. the Windows rename-self-aside), restart via the platform service
//! manager, and roll back on a failed boot health-gate. Declared now so the
//! workspace compiles; real content in M11b.

#![doc(html_root_url = "https://docs.rs/opengeni-agent-update")]

/// Placeholder marker for the M0 skeleton; replaced by the updater in M11b.
#[derive(Debug, Default, Clone, Copy)]
pub struct UpdateStub;
