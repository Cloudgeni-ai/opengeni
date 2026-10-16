//! The Opengeni compute host agent.
//!
//! It runs every sandbox on one machine as a microVM, puts idle sandboxes
//! to sleep through the levels of [`compute_core::Level`] and wakes them
//! the moment something needs them. The pure [`compute_core::Host`] decides
//! what to do; this crate does it with a [`compute_engine::Engine`] and a
//! [`Store`], and serves a small local API ([`protocol`]) on a Unix socket.
//!
//! The API's central request is `connect`: wake a sandbox and stream bytes
//! to a port inside it, keeping it awake while the stream is open. Commands,
//! terminals, file access and previews are all that one primitive.

mod agent;
mod chunked;
pub mod client;
pub mod guest_ports;
mod image;
mod layout;
#[cfg(target_os = "linux")]
mod lazy;
pub mod net;
#[cfg(target_os = "linux")]
mod paging;
mod pool;
pub mod protocol;
pub mod restore_notice;
mod server;
mod state;
mod step;
mod store;
mod working_set;

pub use agent::{BusyRule, Handle, HostAgent, HostConfig, HostError, Lease, PagerConfig};
pub use chunked::{CHUNK_BYTES, Chunked};
pub use guest_ports::{GuestPort, Route};
pub use pool::{Keep, PoolConfig, Shape};
pub use server::serve;
pub use store::{
    Archive, Directory, FetchInto, FetchedMemory, JailedFile, NoStore, Prefilled, Receipt,
    SavedFiles, SavedImage, Store,
};
