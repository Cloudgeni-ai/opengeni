//! Windows-specific platform bits.
//!
//! exec/fs/git are portable (in [`crate::native`]); this module holds only the
//! Windows specifics — OS reporting and building a shell command via `cmd.exe`.
//! It is `cfg(target_os = "windows")`-gated. The cross-platform CI matrix (dossier
//! §23.3) builds + `cargo test`s this on a `windows-latest` runner so it cannot
//! rot, even though the autonomous live matrix focuses on Linux.
//!
//! Desktop capture/input (SendInput + DXGI) is the M8 seam, live-tested on an
//! interactive Azure Windows VM console session (no TCC equivalent).

use opengeni_agent_proto::v1::Os;

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
