//! Windows-specific platform bits.
//!
//! exec/fs/git are portable (in [`crate::native`]); this module holds the Windows
//! specifics — OS reporting, building a shell command via `cmd.exe`, and the
//! structured desktop backend ([`WindowsDesktop`]). It is
//! `cfg(target_os = "windows")`-gated. The cross-platform CI matrix (dossier
//! §23.3) builds + `cargo test`s this on a `windows-latest` runner so it cannot
//! rot, even though the autonomous live matrix focuses on Linux.
//!
//! # Desktop (structured, live-deferred to M12)
//!
//! Windows computer-use is **SendInput** (synthetic input) + **DXGI Desktop
//! Duplication** (capture). Unlike macOS there is NO TCC-style block — an
//! interactive console session gives full unattended access — so Windows is
//! ultimately FULLY live-testable on an autologon Azure VM (dossier §23.4). The
//! backend is a compile-only structured seam here with the exact
//! [`DesktopBackend`] shape; the SendInput/DXGI native calls are wired + verified
//! in M12. When wired they go through a safe binding crate (`windows`/`windows-rs`
//! or `scrap`) or a narrowly-scoped `allow(unsafe_code)` module with a
//! justification — NOT a blanket relaxation.

use async_trait::async_trait;

use opengeni_agent_proto::v1::{self, Os};

use crate::desktop::{CapturedFrame, DesktopBackend};
use crate::error::{PlatformError, PlatformResult};

/// The OS family this build targets.
#[must_use]
pub(crate) fn os() -> Os {
    Os::Windows
}

/// Builds a command that runs `parts` through `cmd.exe /C`.
///
/// Windows has no `$SHELL`; the platform shell is `cmd.exe`. As on the POSIX
/// path, opting into `shell = true` means the caller wants shell interpretation
/// of the joined line, so we pass it through without re-quoting.
pub(crate) fn shell_command(parts: &[String]) -> tokio::process::Command {
    let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    let mut cmd = tokio::process::Command::new(comspec);
    cmd.arg("/C").arg(parts.join(" "));
    cmd
}

/// The Windows desktop backend (SendInput + DXGI). Structured seam: reports no
/// display and refuses capture/input with a typed `Unsupported` until the native
/// path is wired + live-verified on an interactive Azure Windows VM (M12).
#[derive(Debug, Default, Clone, Copy)]
pub struct WindowsDesktop;

impl WindowsDesktop {
    /// Builds the structured Windows desktop backend.
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl DesktopBackend for WindowsDesktop {
    fn probe(&self) -> Option<v1::Display> {
        // No display reported until DXGI capture is live (M12).
        None
    }

    async fn capture(&self) -> PlatformResult<CapturedFrame> {
        Err(PlatformError::Unsupported(
            "Windows desktop capture (DXGI) is not yet wired (M12)".to_string(),
        ))
    }

    async fn inject(&self, _input: &v1::DesktopInput) -> PlatformResult<()> {
        Err(PlatformError::Unsupported(
            "Windows computer-use input (SendInput) is not yet wired (M12)".to_string(),
        ))
    }
}
