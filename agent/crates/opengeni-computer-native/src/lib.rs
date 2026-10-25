//! Native accessibility and capture adapter for Opengeni ComputerSessions.
//!
//! The placement-local Bun controller owns public session authority, durable
//! operation receipts, and media grants. This crate owns only the genuinely
//! native edge: Linux AT-SPI/X11 and macOS AX/ScreenCaptureKit. Its internal
//! protocol deliberately contains no account, workspace, or agent authority.

#![doc(html_root_url = "https://docs.rs/opengeni-computer-native")]

mod adapter;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod captured_frames;
mod clipboard;
mod desktop_session;
#[cfg(any(target_os = "linux", test))]
mod linux_pointer;
mod model;
mod rpc;
mod tree;
mod window_command;
#[cfg(any(target_os = "linux", test))]
mod window_input_fences;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
mod linux_gnome;
#[cfg(target_os = "macos")]
mod macos;

pub use adapter::{
    ComputerAdapter, NativeAdapterError, NativeAdapterErrorCode, NativeAdapterResult,
};
pub use desktop_session::{desktop_session_answer, run_desktop_session_command};
pub use model::*;
pub use rpc::{run_native_rpc, NativeRpcServerError, NATIVE_RPC_PROTOCOL_VERSION};
pub use tree::{RawSemanticNode, SemanticSnapshotIndex};
pub use window_command::{
    answer_window_command, run_window_command, ConsoleState, WindowBounds, WindowNative,
    WindowPresence, WindowQuery,
};

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
