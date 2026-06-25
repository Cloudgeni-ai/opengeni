//! macOS-specific platform bits.
//!
//! Mirrors [`crate::linux`]: exec/fs/git are portable (in [`crate::native`]); this
//! module holds only macOS specifics — OS reporting and the POSIX shell command.
//! It is `cfg(target_os = "macos")`-gated so it compiles only on macOS, but the
//! cross-platform CI matrix (dossier §23.3) builds + tests it there.
//!
//! Desktop capture/input (CGEvent + ScreenCaptureKit, TCC-gated) is the M8 seam.

use opengeni_agent_proto::v1::Os;

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
