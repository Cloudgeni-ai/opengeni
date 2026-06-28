//! macOS-specific platform bits.
//!
//! Mirrors [`crate::linux`]: exec/fs/git are portable (in [`crate::native`]); this
//! module holds the macOS specifics — OS reporting, the POSIX shell command, and
//! the structured desktop backend ([`MacosDesktop`]). It is
//! `cfg(target_os = "macos")`-gated so it compiles only on macOS, but the
//! cross-platform CI matrix (dossier §23.3) builds + tests it there.
//!
//! # Desktop (structured, live-deferred to M12)
//!
//! macOS computer-use is **CGEvent** (synthetic input) + **ScreenCaptureKit**
//! (capture), both **TCC-gated** (Screen Recording + Accessibility grants that
//! cannot be auto-clicked on an ephemeral CI runner — dossier §23.4/§24.3). The
//! backend is therefore a compile-only structured seam: it has the exact
//! [`DesktopBackend`] shape so the dispatch + capability path are identical to
//! Linux, but `probe`/`capture`/`inject` report a typed `Unsupported`/no-display
//! until the native code lands and is verified on the user's real Mac (M12). The
//! ScreenCaptureKit/CGEvent calls require Apple FFI; when they are wired they will
//! go through a safe binding crate (e.g. `core-graphics`) or a narrowly-scoped
//! `allow(unsafe_code)` module with a justification — NOT a blanket relaxation.

use async_trait::async_trait;

use opengeni_agent_proto::v1::{self, Os};

use crate::desktop::{CapturedFrame, DesktopBackend};
use crate::error::{PlatformError, PlatformResult};

/// The OS family this build targets.
#[must_use]
pub(crate) fn os() -> Os {
    Os::Macos
}

/// Builds a command that runs `parts` through the user's POSIX shell (`$SHELL`,
/// falling back to `/bin/sh`). Identical contract to the Linux path — macOS ships
/// a POSIX shell, so the cross-platform exec path needs no special casing.
pub(crate) fn shell_command(parts: &[String]) -> tokio::process::Command {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = tokio::process::Command::new(shell);
    cmd.arg("-c").arg(parts.join(" "));
    cmd
}

/// The macOS desktop backend (CGEvent + ScreenCaptureKit). Structured seam:
/// reports no display and refuses capture/input with a typed `Unsupported` until
/// the TCC-gated native path is wired + live-verified on a real Mac (M12).
#[derive(Debug, Default, Clone, Copy)]
pub struct MacosDesktop;

impl MacosDesktop {
    /// Builds the structured macOS desktop backend.
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl DesktopBackend for MacosDesktop {
    fn probe(&self) -> Option<v1::Display> {
        // No display reported until ScreenCaptureKit capture is live (M12).
        None
    }

    async fn capture(&self) -> PlatformResult<CapturedFrame> {
        Err(PlatformError::Unsupported(
            "macOS desktop capture (ScreenCaptureKit) is not yet wired (M12)".to_string(),
        ))
    }

    async fn inject(&self, _input: &v1::DesktopInput) -> PlatformResult<()> {
        Err(PlatformError::Unsupported(
            "macOS computer-use input (CGEvent) is not yet wired (M12)".to_string(),
        ))
    }
}
