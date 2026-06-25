//! Per-OS platform abstraction for the OpenGeni self-hosted agent.
//!
//! This crate defines the [`Platform`] trait — the single seam between the
//! agent's transport/dispatch layer and the host operating system. Channel-A
//! operations (exec, the filesystem family, git) are implemented here against the
//! host; the agent's RPC dispatch ([`opengeni-agent`](../opengeni_agent/index.html))
//! decodes a wire [`ControlRequest`](opengeni_agent_proto::v1::ControlRequest),
//! calls the matching trait method, and encodes the result back.
//!
//! # Cross-platform posture
//!
//! exec/fs/git are portable: exec via [`tokio::process`], the filesystem via
//! [`tokio::fs`], and git by shelling the system `git`. The bulk therefore lives
//! in one [`NativePlatform`] usable on every OS. The cfg-gated modules
//! ([`linux`], [`macos`], [`windows`]) hold only the genuinely per-OS bits today
//! (OS/arch reporting, the default login shell). The desktop + terminal **stream**
//! methods are declared on the trait but return
//! [`PlatformError::Unsupported`] — they are the M8 seam (the relay-backed pty +
//! framebuffer pumps live in `opengeni-agent-stream` and the platform desktop
//! code). Keeping them on the trait now means M8 fills in bodies without
//! reshaping the dispatch table.
//!
//! # Errors
//!
//! Every fallible method returns a [`PlatformError`], which maps to the proto
//! [`AgentError`](opengeni_agent_proto::v1::AgentError) via
//! [`PlatformError::to_agent_error`]. A failed operation is therefore a typed
//! value the dispatch layer turns into a `ControlResponse` carrying an error —
//! never a panic.

#![doc(html_root_url = "https://docs.rs/opengeni-agent-platform")]

mod error;
mod native;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

use async_trait::async_trait;
use opengeni_agent_proto::v1;

pub use error::{PlatformError, PlatformResult};
pub use native::NativePlatform;

/// Reported OS/arch identity of the host the agent runs on, folded into the
/// connect [`Hello`](opengeni_agent_proto::v1::Hello).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostIdentity {
    /// The OS family.
    pub os: v1::Os,
    /// The CPU architecture.
    pub arch: v1::Arch,
}

/// The host-facing capability surface of a connected agent.
///
/// Channel-A (exec/fs/git) is always available on a connected agent. The
/// stream-backed surfaces (pty, desktop) are gated on platform support + the
/// consent grants captured at enrollment; until M8 wires the streams, `pty` and
/// `desktop` are reported `false`.
#[async_trait]
pub trait Platform: Send + Sync {
    // --- Identity ---------------------------------------------------------

    /// The host's OS family + CPU architecture, for the connect `Hello`.
    fn host_identity(&self) -> HostIdentity;

    /// The agent's working root (treated by the control plane as the sandbox cwd).
    /// Defaults to the process's current directory.
    fn workspace_root(&self) -> String;

    // --- Channel-A: exec --------------------------------------------------

    /// Runs a command and collects its full output. Honors an optional
    /// wall-clock timeout (a timed-out process is killed and reported as
    /// [`PlatformError::Timeout`]). When `shell` is set, the command is run
    /// through the platform shell; otherwise `command[0]` is the program.
    async fn exec(&self, req: &v1::ExecRequest) -> PlatformResult<v1::ExecResponse>;

    // --- Channel-A: filesystem -------------------------------------------

    /// Reads a file, optionally a byte range. Returns the read bytes plus the
    /// file's total size so a ranged read knows whether more remains.
    async fn fs_read(&self, req: &v1::FsReadRequest) -> PlatformResult<v1::FsReadResponse>;

    /// Writes (or appends to) a file, optionally creating parent directories and
    /// applying a POSIX mode.
    async fn fs_write(&self, req: &v1::FsWriteRequest) -> PlatformResult<v1::FsWriteResponse>;

    /// Lists a directory, optionally recursively.
    async fn fs_list(&self, req: &v1::FsListRequest) -> PlatformResult<v1::FsListResponse>;

    /// Creates a directory (optionally `mkdir -p`).
    async fn fs_mkdir(&self, req: &v1::FsMkdirRequest) -> PlatformResult<v1::FsMkdirResponse>;

    /// Moves/renames a path, optionally overwriting the destination.
    async fn fs_move(&self, req: &v1::FsMoveRequest) -> PlatformResult<v1::FsMoveResponse>;

    /// Stats a path. Succeeds even when the path is absent (`exists = false`).
    async fn fs_stat(&self, req: &v1::FsStatRequest) -> PlatformResult<v1::FsStatResponse>;

    /// Removes a path (optionally recursively for directories).
    async fn fs_remove(&self, req: &v1::FsRemoveRequest) -> PlatformResult<v1::FsRemoveResponse>;

    // --- Channel-A: git ---------------------------------------------------

    /// Runs a git operation against the repo rooted at the request's `cwd` (or
    /// the workspace root). Returns structured status for `GIT_OP_STATUS`,
    /// otherwise raw stdout/stderr.
    async fn git(&self, req: &v1::GitRequest) -> PlatformResult<v1::GitResponse>;

    // --- M8 seams: terminal + desktop streams -----------------------------
    //
    // Declared so the dispatch table is shaped today; the bodies (relay-backed
    // pty + framebuffer pumps and platform input synthesis) land in M8. The
    // default impls return Unsupported so a control plane that probes them gets a
    // clean typed error, never a panic.

    /// Opens a pseudo-terminal and registers a relay stream channel (M8 seam).
    async fn pty_open(&self, _req: &v1::PtyOpenRequest) -> PlatformResult<v1::PtyOpenResponse> {
        Err(unimplemented_stream("pty_open"))
    }

    /// Ensures a desktop framebuffer stream exists (M8 seam).
    async fn desktop_ensure(
        &self,
        _req: &v1::DesktopEnsureRequest,
    ) -> PlatformResult<v1::DesktopEnsureResponse> {
        Err(unimplemented_stream("desktop_ensure"))
    }
}

/// The typed error returned by the M8 stream seams until they are implemented.
/// Surfaced as [`ErrorCode::Unsupported`](opengeni_agent_proto::v1::ErrorCode)
/// so the control plane degrades the capability cleanly rather than crashing.
fn unimplemented_stream(op: &str) -> PlatformError {
    PlatformError::Unsupported(format!(
        "{op}: stream surfaces (pty/desktop) are not yet implemented (M8)"
    ))
}

// --- Per-OS dispatch --------------------------------------------------------
//
// exec/fs/git are portable so the bodies live in `native`; these two free
// functions are the only OS-specific seams the native implementation reaches
// for. They dispatch to the cfg-gated `linux`/`macos`/`windows` modules.

/// The host's OS family + CPU architecture, derived at compile time from the
/// target. Folded into the connect [`Hello`](opengeni_agent_proto::v1::Hello).
#[must_use]
pub fn host_identity() -> HostIdentity {
    HostIdentity {
        os: host_os(),
        arch: host_arch(),
    }
}

/// The host's OS family, resolved by the cfg-gated per-OS module. Targets we do
/// not specialize report [`Os::Unspecified`](opengeni_agent_proto::v1::Os).
#[must_use]
fn host_os() -> v1::Os {
    #[cfg(target_os = "linux")]
    {
        linux::os()
    }
    #[cfg(target_os = "macos")]
    {
        macos::os()
    }
    #[cfg(target_os = "windows")]
    {
        windows::os()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        v1::Os::Unspecified
    }
}

/// The host's CPU architecture, from the compile-time target. Architectures the
/// wire protocol does not enumerate report
/// [`Arch::Unspecified`](opengeni_agent_proto::v1::Arch).
#[must_use]
fn host_arch() -> v1::Arch {
    #[cfg(target_arch = "x86_64")]
    {
        v1::Arch::X8664
    }
    #[cfg(target_arch = "aarch64")]
    {
        v1::Arch::Aarch64
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        v1::Arch::Unspecified
    }
}

/// Builds a [`tokio::process::Command`] that runs `parts` through the platform
/// shell (`$SHELL`/`sh` on Unix, `cmd.exe` on Windows). Used by
/// [`NativePlatform::exec`](native::NativePlatform) when `ExecRequest.shell` is
/// set.
#[must_use]
pub(crate) fn shell_command(parts: &[String]) -> tokio::process::Command {
    #[cfg(target_os = "linux")]
    {
        linux::shell_command(parts)
    }
    #[cfg(target_os = "macos")]
    {
        macos::shell_command(parts)
    }
    #[cfg(target_os = "windows")]
    {
        windows::shell_command(parts)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        // A generic POSIX fallback for any other unix-like target.
        let mut cmd = tokio::process::Command::new("/bin/sh");
        cmd.arg("-c").arg(parts.join(" "));
        cmd
    }
}
