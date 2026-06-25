//! Per-OS platform abstraction for the OpenGeni self-hosted agent.
//!
//! Stub for milestone M0. The real crate will define a `trait Platform`
//! (`exec`, `fs`, `git`, `terminal`, `desktop`, `metrics`) with `linux.rs`
//! (X11/XTEST/xdotool/scrot/Xvfb), `macos.rs` (CGEvent/ScreenCaptureKit), and
//! `windows.rs` (SendInput/DXGI) implementations, plus a `trait ServiceManager`
//! per OS — all driving the [`opengeni_agent_proto`] wire types. It is declared
//! now so the workspace compiles and the dependency graph is complete; its real
//! content lands in M6/M8/M11.

#![doc(html_root_url = "https://docs.rs/opengeni-agent-platform")]

/// Placeholder marker for the M0 skeleton; replaced by the `Platform` trait in M6.
#[derive(Debug, Default, Clone, Copy)]
pub struct PlatformStub;
