//! Native accessibility and capture adapter for OpenGeni ComputerSessions.
//!
//! The placement-local Bun controller owns public session authority, durable
//! operation receipts, and media grants. This crate owns only the genuinely
//! native edge: Linux AT-SPI/X11 and macOS AX/ScreenCaptureKit. Its internal
//! protocol deliberately contains no account, workspace, or agent authority.

#![doc(html_root_url = "https://docs.rs/opengeni-computer-native")]

mod adapter;
mod model;
mod rpc;
mod tree;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;

pub use adapter::{
    ComputerAdapter, NativeAdapterError, NativeAdapterErrorCode, NativeAdapterResult,
};
pub use model::*;
pub use rpc::{run_native_rpc, NativeRpcServerError, NATIVE_RPC_PROTOCOL_VERSION};
pub use tree::{RawSemanticNode, SemanticSnapshotIndex};

/// Opens the native adapter for the current desktop seat.
///
/// # Errors
///
/// Returns a typed unavailable/permission failure when no supported graphical
/// seat or accessibility service is reachable.
pub async fn open_native_adapter() -> NativeAdapterResult<Box<dyn ComputerAdapter>> {
    #[cfg(target_os = "linux")]
    {
        Ok(Box::new(linux::AtspiComputerAdapter::open().await?))
    }
    #[cfg(target_os = "macos")]
    {
        // Keep one async constructor across platforms; Linux performs an async
        // AT-SPI bus handshake while macOS currently opens native handles eagerly.
        tokio::task::yield_now().await;
        Ok(Box::new(macos::AxComputerAdapter::open()?))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        Err(NativeAdapterError::unsupported(
            "native semantic computer control is not available on this platform",
        ))
    }
}
