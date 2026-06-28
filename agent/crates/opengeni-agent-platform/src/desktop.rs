//! The desktop capability seam: screen capture, computer-use input injection, and
//! display probing — the platform half of the M8 desktop stream.
//!
//! The [`DesktopBackend`] trait is the single abstraction the agent's
//! `desktop_ensure` / `desktop_input` ops reach for. A connected agent reports a
//! [`Display`](opengeni_agent_proto::v1::Display) only when a backend can probe
//! one (a real X11 screen, an Xvfb virtual framebuffer, or — on macOS/Windows — a
//! native session); otherwise the control plane degrades the desktop cell to
//! `display_unavailable` (a value, never a crash, dossier §5/§10.6).
//!
//! # Safety posture
//!
//! The workspace forbids `unsafe_code`. Every backend here is built on a **safe
//! binding crate**: Linux uses [`x11rb`] (safe X11 + the `XTEST` and `RANDR`
//! extensions) for both capture and synthetic input, so no `unsafe` is needed.
//! The macОS/Windows backends are compile-only structured seams that return
//! [`PlatformError::Unsupported`] until their native (CGEvent/ScreenCaptureKit,
//! SendInput/DXGI) code lands and is live-verified (dossier §10.4, deferred to
//! M12). Wiring them through safe crates (or a narrowly-scoped `allow(unsafe_code)`
//! module) is the M12 task; the trait shape is fixed now so nothing reshapes.
//!
//! # Frame encoding
//!
//! Captured frames are PNG-encoded ([`CapturedFrame`]) so the relay framebuffer
//! pump can ship a self-describing image chunk over a `StreamFrame` without a
//! bespoke pixel-format negotiation. PNG is lossless + universally decodable by
//! the browser viewer; a future codec swap (e.g. a video stream) is a change to
//! the pump, not this seam.

use async_trait::async_trait;

use opengeni_agent_proto::v1;

use crate::error::{PlatformError, PlatformResult};

#[cfg(target_os = "linux")]
pub use crate::linux::LinuxDesktop;

/// A captured desktop frame: PNG-encoded image bytes plus the geometry they were
/// captured at. The relay framebuffer pump ships `png` as the `StreamFrame.data`
/// payload; `width`/`height` let the viewer size its canvas without decoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedFrame {
    /// PNG-encoded image bytes (self-describing; the viewer decodes directly).
    pub png: Vec<u8>,
    /// Frame width in pixels.
    pub width: u32,
    /// Frame height in pixels.
    pub height: u32,
}

/// The platform's desktop capability: probe a display, capture frames, inject
/// computer-use input. Implemented per-OS; a headless host with no backend uses
/// [`NoDesktop`], which reports no display and refuses capture/input with a typed
/// `Unsupported`.
#[async_trait]
pub trait DesktopBackend: Send + Sync {
    /// Probes for an available display. Returns `Some(Display)` when a screen (real
    /// or virtual) is present and capturable, `None` on a headless host. A `None`
    /// here is what drives the control plane's `display_unavailable` capability
    /// reason — it is a value, not an error.
    fn probe(&self) -> Option<v1::Display>;

    /// Captures the current desktop framebuffer as a PNG-encoded [`CapturedFrame`].
    ///
    /// # Errors
    ///
    /// Returns [`PlatformError::Unsupported`] on a backend with no display, or
    /// [`PlatformError::Os`] if the capture call fails.
    async fn capture(&self) -> PlatformResult<CapturedFrame>;

    /// Injects one computer-use input event (pointer move/click, key, scroll).
    ///
    /// The caller is responsible for the consent gate
    /// ([`consented_screen_control`](v1::Capabilities::consented_screen_control));
    /// a backend with no display still returns [`PlatformError::Unsupported`].
    ///
    /// # Errors
    ///
    /// Returns [`PlatformError::Unsupported`] when the backend cannot inject, or
    /// [`PlatformError::Os`] if the synthetic-input call fails.
    async fn inject(&self, input: &v1::DesktopInput) -> PlatformResult<()>;
}

/// The headless / unsupported-platform desktop backend: no display, no capture, no
/// input. Used when no real backend is available (a headless Linux box without
/// `--virtual-desktop`, or an OS whose native desktop code is not yet wired).
#[derive(Debug, Default, Clone, Copy)]
pub struct NoDesktop;

#[async_trait]
impl DesktopBackend for NoDesktop {
    fn probe(&self) -> Option<v1::Display> {
        None
    }

    async fn capture(&self) -> PlatformResult<CapturedFrame> {
        Err(PlatformError::Unsupported(
            "no desktop display available on this host (headless; enable --virtual-desktop)"
                .to_string(),
        ))
    }

    async fn inject(&self, _input: &v1::DesktopInput) -> PlatformResult<()> {
        Err(PlatformError::Unsupported(
            "no desktop display available on this host (headless; enable --virtual-desktop)"
                .to_string(),
        ))
    }
}

/// Resolves the desktop backend for the current host.
///
/// On Linux, attempts to open the X11 display named by `$DISPLAY` (real screen or
/// an Xvfb virtual framebuffer the caller spawned via [`crate::virtual_desktop`]);
/// if none is reachable, falls back to [`NoDesktop`] (the host reports
/// `display_unavailable`). On macOS/Windows, returns the structured native backend
/// (which is `Unsupported` until M12). Other targets get [`NoDesktop`].
#[must_use]
pub fn resolve_desktop() -> Box<dyn DesktopBackend> {
    #[cfg(target_os = "linux")]
    {
        match LinuxDesktop::open_default() {
            Ok(desktop) => Box::new(desktop),
            Err(reason) => {
                tracing::info!(reason = %reason, "no X11 display reachable; desktop unavailable");
                Box::new(NoDesktop)
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        Box::new(crate::macos::MacosDesktop::new())
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(crate::windows::WindowsDesktop::new())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        Box::new(NoDesktop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn no_desktop_probes_none_and_refuses_capture_and_input() {
        let d = NoDesktop;
        assert!(d.probe().is_none());
        assert!(matches!(
            d.capture().await,
            Err(PlatformError::Unsupported(_))
        ));
        let input = v1::DesktopInput::default();
        assert!(matches!(
            d.inject(&input).await,
            Err(PlatformError::Unsupported(_))
        ));
    }
}
