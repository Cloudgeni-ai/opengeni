//! Linux-specific platform bits.
//!
//! exec/fs/git themselves are portable and live in [`crate::native`]; this module
//! holds only the genuinely Linux-specific pieces folded into the cross-platform
//! [`NativePlatform`](crate::NativePlatform): reporting the OS family and building
//! a shell command via the user's `$SHELL` (falling back to `/bin/sh`).
//!
//! Desktop capture/input (XTEST/xdotool/scrot, Xvfb) is the M8 seam and lives in
//! `opengeni-agent-stream` plus the M8 desktop code — not here.

use opengeni_agent_proto::v1::Os;

/// The OS family this build targets.
#[must_use]
pub(crate) fn os() -> Os {
    Os::Linux
}

/// Builds a command that runs `parts` through the user's POSIX shell.
///
/// The joined command is passed to `sh -c` (or `$SHELL -c`). We intentionally do
/// NOT re-quote the parts: when the caller sets `shell = true` they have opted
/// into shell interpretation of the joined string, mirroring how a terminal
/// `sh -c "<line>"` behaves.
pub(crate) fn shell_command(parts: &[String]) -> tokio::process::Command {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = tokio::process::Command::new(shell);
    cmd.arg("-c").arg(parts.join(" "));
    cmd
}
