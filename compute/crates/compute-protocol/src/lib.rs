//! The wire types of Opengeni compute, shared by the host agent, the fleet
//! service and the tools that talk to them.
//!
//! - [`host`]: the host agent's API, one JSON request per line, on a Unix
//!   socket for local tools and over mutual TLS for the fleet service.
//! - [`fleet`]: how a host registers with the fleet service, renews its
//!   lease and reports what it can take on, and the envelope that bounds
//!   every request the service sends a host
//!   ([ADR 18](../../docs/adr/0018-the-fleet-service-leases-and-fences.md)).

pub mod fleet;
pub mod host;
