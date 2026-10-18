//! The fleet service end to end, over loopback: its public API, its host
//! API over mutual TLS, its leader and its store, against fake hosts that
//! speak the host protocol.

mod e2b;
mod group;
mod lease;
mod lifecycle;
mod moves;
mod native;
mod support;
