//! The host side of the agent link
//! ([ADR 21](../../docs/adr/0021-opengeni-runs-natively-its-agent-behind-the-hosts-link.md),
//! [contract](../../docs/agent-link.md)).
//!
//! Each sandbox that runs Opengeni's agent reaches its host on one vsock
//! port. The host answers there as a NATS server would, for the subset the
//! agent's client uses, and carries each sandbox's session over one
//! WebSocket link per Opengeni gateway, where the gateway bridges it to
//! Opengeni's own NATS. The agent holds no credential: the fleet's ticket
//! for the sandbox's placement, and the host's own token, let it in.
//!
//! - [`nats`]: the client protocol, from the server's side.
//! - [`core`]: what the host does, without input or output.
//! - [`Hub`]: runs it, with the links and the guest connections.
//! - [`saved`]: the session a host keeps on disk across its restarts.

pub mod core;
mod guest;
mod hub;
mod link;
pub mod nats;
pub mod saved;

pub use hub::{HostToken, Hub, HubConfig, Timing, Tokens, Wake};
