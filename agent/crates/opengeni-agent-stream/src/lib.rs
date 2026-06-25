//! Relay-edge stream transport for the OpenGeni self-hosted agent.
//!
//! Stub for milestone M0. The real crate will dial the stateless relay edge
//! (QUIC/WebTransport preferred, `wss` fallback), register stream channels keyed
//! by `{workspaceId, agentId, port}`, and pump pty + framebuffer bytes as
//! [`opengeni_agent_proto::v1::StreamFrame`]s with bounded buffers, backpressure,
//! and resume-from-seq. Declared now so the workspace compiles; real content in M8.

#![doc(html_root_url = "https://docs.rs/opengeni-agent-stream")]

/// Placeholder marker for the M0 skeleton; replaced by the relay client in M8.
#[derive(Debug, Default, Clone, Copy)]
pub struct StreamStub;
