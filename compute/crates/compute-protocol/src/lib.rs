//! The wire types of Opengeni compute, shared by the host agent, the control
//! service and the tools that talk to them.
//!
//! - [`host`]: the host agent's API, one JSON request per line, on a Unix
//!   socket for local tools and over mutual TLS for the control service.
//! - [`fleet`]: how a host registers with the control service, renews its
//!   lease and reports what it can take on, and the envelope that bounds
//!   every request the service sends a host
//!   ([ADR 18](../../docs/adr/0018-the-control-service-leases-and-fences.md)).
//! - [`link`]: the frames between a host and an Opengeni agent gateway
//!   ([ADR 21](../../docs/adr/0021-opengeni-runs-natively-its-agent-behind-the-hosts-link.md)).

pub mod fleet;
pub mod host;
pub mod link;
