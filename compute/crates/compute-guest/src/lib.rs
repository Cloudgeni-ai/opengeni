//! `compute-guest`, PID 1 inside a sandbox built from an OCI image.
//!
//! The host agent reaches the guest only through vsock. This init keeps the
//! contract the lab image's services keep, so the host treats both images
//! the same, and adds a gateway to the guest's TCP ports:
//!
//! - [`NOTICE_PORT`] takes restore notices (see [`notice`]): the time, the
//!   sandbox id and a random seed. The guest answers only once envd has
//!   taken its `/init` for the restore, and then tells Opengeni's agent to
//!   reconnect. It also answers the host's `activity` question with the
//!   count the agent registers (see [`agent`]).
//! - [`READY_PORT`] accepts connections once envd is up and its first
//!   `/init` succeeded, or at boot in an image without envd. Template
//!   builders wait on it.
//! - [`GATEWAY_PORT`] takes one header line (see [`gateway`]): `tcp <port>`
//!   relays the stream to that TCP port on the guest's loopback, envd's
//!   [`ENVD_PORT`] included (see [`relay`]); `init <json>` gives the
//!   sandbox its own environment and access token, as a create does.
//!
//! Inside, it mounts the basics, sets up the network from the kernel's
//! `ip=` argument, starts and supervises envd when the image has it, runs
//! the image's command as one supervised process under the image's user
//! once the sandbox has its own identity and init, and likewise Opengeni's
//! agent when the init names one and the image has it, with its link to
//! the host on [`AGENT_LINK_PORT`]. It reaps orphans and shuts down
//! cleanly. The parsers and state machines live in the portable modules
//! here; the system calls live under `linux`.

pub mod agent;
pub mod cmdline;
pub mod config;
pub mod envd;
pub mod gateway;
pub mod given;
pub mod identity;
pub mod notice;
pub mod relay;
pub mod users;

#[cfg(target_os = "linux")]
pub mod linux;

/// The vsock port restore notices arrive on, as with the lab image.
pub const NOTICE_PORT: u32 = 53;

/// The vsock port that accepts connections once the guest is ready.
pub const READY_PORT: u32 = 54;

/// The vsock port of the gateway to the guest's TCP ports.
pub const GATEWAY_PORT: u32 = 57;

/// The host's vsock port for the guest's Opengeni agent (see [`agent`]),
/// as `compute-protocol`'s `link::AGENT_LINK_PORT` names it.
pub const AGENT_LINK_PORT: u32 = 58;

/// The TCP port envd listens on, E2B's own.
pub const ENVD_PORT: u16 = 49983;
