//! The control service end to end, over loopback: its public API, its host
//! API over TLS and the certificates it issues, its leader and its store,
//! against fake hosts that speak the host protocol.

mod certificates;
mod e2b;
mod group;
mod images;
mod lease;
mod lifecycle;
mod metrics;
mod moves;
mod native;
mod support;
