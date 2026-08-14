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

mod cgroup;
mod desktop;
mod error;
mod native;
mod pty;
pub mod service;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

/// Opt-in Xvfb virtual desktop for headless Linux (`--virtual-desktop`). Linux-only
/// (a virtual framebuffer is not the macOS/Windows model).
#[cfg(target_os = "linux")]
pub mod virtual_desktop;

use std::sync::Arc;

use async_trait::async_trait;
use opengeni_agent_proto::v1;

pub use cgroup::{establish_oom_isolation, OpCgroupConfig, OpCgroupConfigError, OpCgroups};
pub use desktop::{
    fit_frame_to_budget, resolve_desktop, CapturedFrame, DesktopBackend, FittedFrame, NoDesktop,
};
#[cfg(target_os = "linux")]
pub use desktop::{
    validate_linux_named_key_chord, LinuxDesktop, LinuxRgbaFrame, LinuxWindow, LinuxWindowRect,
};
pub use error::{PlatformError, PlatformResult};
pub use native::{assemble_git_response, spawn_contained, ContainedExec, NativePlatform};
pub use pty::{spawn_pty, PtyProcess};

/// macOS TCC-grant helpers (feature `macos-desktop`, macOS-only): read the Screen
/// Recording + Accessibility + Input Monitoring state without prompting ([`desktop_grants`])
/// and fire the OS consent prompts once ([`request_desktop_grants`]). The agent's
/// startup/enroll seam uses these to request display capability on a real Mac; a
/// denied grant degrades cleanly to `display_unavailable`.
#[cfg(all(target_os = "macos", feature = "macos-desktop"))]
pub use macos::{desktop_grants, request_desktop_grants, DesktopGrants};

/// Reported OS/arch identity of the host the agent runs on, folded into the
/// connect [`Hello`](opengeni_agent_proto::v1::Hello).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostIdentity {
    /// The OS family.
    pub os: v1::Os,
    /// The CPU architecture.
    pub arch: v1::Arch,
}

/// Loopback endpoint of one agent-supervised browser controller sidecar.
///
/// This is deliberately process-local: the control plane never receives the
/// browserd authority or connects to this port directly. Browser control RPCs
/// reach it through the connected-machine execution adapter, while frame bytes
/// are copied into an authenticated relay channel by [`StreamRegistry`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserControlEndpoint {
    /// Loopback TCP port selected by browserd.
    pub port: u16,
    /// Changes whenever the supervised sidecar process is replaced.
    pub sidecar_generation: String,
}

/// Host-owned lifecycle seam for browserd.
///
/// The agent binary implements this because it owns installation paths,
/// configuration storage, and child-process shutdown. The platform and relay
/// crates depend only on this narrow capability, never on Bun/browserd details.
#[async_trait]
pub trait BrowserControlBackend: Send + Sync {
    /// Ensures the exact authority scope and attached-browser generation is live.
    async fn ensure(
        &self,
        req: &v1::BrowserControlEnsureRequest,
    ) -> PlatformResult<BrowserControlEndpoint>;

    /// Resolves an already-ensured endpoint, fenced by the exact scope generation.
    async fn resolve(
        &self,
        scope_id: &str,
        scope_generation: &str,
    ) -> PlatformResult<BrowserControlEndpoint>;
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

    /// Whether this running platform can enforce a per-operation resource
    /// policy. This is a live capability (e.g. delegated cgroup support), not an
    /// OS-name guess. The default is false for fakes and unsupported platforms.
    fn operation_resource_policy_supported(&self) -> bool {
        false
    }

    /// Whether this exact live platform additionally enforces the CPU quota
    /// field. Kept separate so memory-capable older runners cannot silently
    /// ignore an additive protobuf field.
    fn operation_cpu_quota_supported(&self) -> bool {
        false
    }

    // --- Channel-A: exec --------------------------------------------------

    /// Runs a command and collects its full output. Honors an optional
    /// wall-clock timeout (a timed-out process is killed and reported as
    /// [`PlatformError::Timeout`]). When `shell` is set, the command is run
    /// through the platform shell; otherwise `command[0]` is the program.
    async fn exec(&self, req: &v1::ExecRequest) -> PlatformResult<v1::ExecResponse>;

    /// Spawns the command described by an `ExecRequest` inside the shared
    /// containment primitive WITHOUT waiting or assembling a reply — the
    /// streaming job path: the caller (the op-engine pump) owns the returned
    /// [`ContainedExec`]'s stdio and lifecycle. Same command construction,
    /// cwd/env resolution, and containment as [`Platform::exec`] (which is
    /// implemented over this on the native platform).
    ///
    /// The default reports a typed `Unsupported` for platforms that cannot
    /// stream (test fakes).
    ///
    /// # Errors
    ///
    /// The spawn IO failure mapped to a typed [`PlatformError`] (missing
    /// program, empty command), or `Unsupported` from the default impl.
    fn spawn_exec(&self, req: &v1::ExecRequest) -> PlatformResult<ContainedExec> {
        let _ = req;
        Err(PlatformError::Unsupported(
            "streaming exec is not supported by this platform".to_string(),
        ))
    }

    /// Policy-aware streaming spawn. The default preserves existing platform
    /// implementations only for an unrestricted request and fails closed when a
    /// configured policy would otherwise be ignored.
    ///
    /// # Errors
    ///
    /// Returns [`PlatformError::Unsupported`] when a non-empty policy is supplied
    /// to the default implementation; otherwise forwards [`Platform::spawn_exec`]
    /// errors.
    fn spawn_exec_with_policy(
        &self,
        req: &v1::ExecRequest,
        policy: Option<&v1::OperationResourcePolicy>,
    ) -> PlatformResult<ContainedExec> {
        if policy.is_some_and(|policy| {
            policy.memory_max_bytes.is_some()
                || policy.memory_high_bytes.is_some()
                || policy.cpu_max_millicores.is_some()
        }) {
            return Err(PlatformError::Unsupported(
                "operation resource policy is not supported by this platform".to_string(),
            ));
        }
        self.spawn_exec(req)
    }

    /// Spawns the git invocation described by a `GitRequest` inside the shared
    /// containment primitive WITHOUT waiting or assembling a reply — the
    /// engine-job path for git. Same argv construction and cwd resolution as
    /// [`Platform::git`] (which is implemented over this on the native
    /// platform), so git children get the process-group kill AND the per-op
    /// OOM cgroup leaf (#351's flagged git-boundary follow-up: a clone's page
    /// cache bills to the op, not the runner).
    ///
    /// # Errors
    ///
    /// The spawn IO failure mapped to a typed [`PlatformError`], or
    /// `Unsupported` from the default impl.
    fn spawn_git(&self, req: &v1::GitRequest) -> PlatformResult<ContainedExec> {
        let _ = req;
        Err(PlatformError::Unsupported(
            "streaming git is not supported by this platform".to_string(),
        ))
    }

    /// Policy-aware git spawn. As with exec, an explicit policy is never silently
    /// dropped by a platform implementation that has not opted into enforcement.
    ///
    /// # Errors
    ///
    /// Returns [`PlatformError::Unsupported`] when a non-empty policy is supplied
    /// to the default implementation; otherwise forwards [`Platform::spawn_git`]
    /// errors.
    fn spawn_git_with_policy(
        &self,
        req: &v1::GitRequest,
        policy: Option<&v1::OperationResourcePolicy>,
    ) -> PlatformResult<ContainedExec> {
        if policy.is_some_and(|policy| {
            policy.memory_max_bytes.is_some()
                || policy.memory_high_bytes.is_some()
                || policy.cpu_max_millicores.is_some()
        }) {
            return Err(PlatformError::Unsupported(
                "operation resource policy is not supported by this platform".to_string(),
            ));
        }
        self.spawn_git(req)
    }

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

    // --- M8: terminal + desktop streams -----------------------------------
    //
    // pty/desktop bytes ride the relay stream plane (`opengeni-agent-stream`); the
    // control ops here ALLOCATE the resource (a PTY, a framebuffer source), hand it
    // to the stream registrar to pump over a relay channel, and return the channel
    // descriptor the viewer connects to. The default impls below are platform-
    // agnostic: they reach for [`Platform::desktop`], [`Platform::default_shell`],
    // and [`Platform::stream_registry`], so every OS shares one code path and the
    // mapping is testable with a fake registrar + fake desktop.

    /// The host's desktop backend (capture + computer-use input). A connected agent
    /// always has one; a headless host's backend reports no display and refuses
    /// capture/input, which the control plane degrades to `display_unavailable`.
    fn desktop(&self) -> Arc<dyn DesktopBackend>;

    /// The platform default login-shell argv, used when a PTY open names no command.
    fn default_shell(&self) -> Vec<String>;

    /// The relay stream registrar, if the agent wired one. `None` in unit contexts
    /// (no relay) — `pty_open`/`desktop_ensure` then report a clean `Unsupported`
    /// rather than panicking.
    fn stream_registry(&self) -> Option<Arc<dyn StreamRegistry>>;

    /// Agent-owned browser controller lifecycle, when browserd is installed.
    fn browser_control_backend(&self) -> Option<Arc<dyn BrowserControlBackend>> {
        None
    }

    /// Ensures one placement-scoped browser controller sidecar.
    async fn browser_control_ensure(
        &self,
        req: &v1::BrowserControlEnsureRequest,
    ) -> PlatformResult<v1::BrowserControlEnsureResponse> {
        let backend = self.browser_control_backend().ok_or_else(|| {
            PlatformError::Unsupported(
                "browser_control_ensure: browser controller sidecar is unavailable".to_string(),
            )
        })?;
        let endpoint = backend.ensure(req).await?;
        Ok(v1::BrowserControlEnsureResponse {
            port: u32::from(endpoint.port),
            sidecar_generation: endpoint.sidecar_generation,
        })
    }

    /// Opens a browser-native frame subscription over the existing relay plane.
    async fn browser_frames_open(
        &self,
        req: &v1::BrowserFramesOpenRequest,
    ) -> PlatformResult<v1::BrowserFramesOpenResponse> {
        let backend = self.browser_control_backend().ok_or_else(|| {
            PlatformError::Unsupported(
                "browser_frames_open: browser controller sidecar is unavailable".to_string(),
            )
        })?;
        let endpoint = backend
            .resolve(&req.scope_id, &req.scope_generation)
            .await?;
        let registry = self
            .stream_registry()
            .ok_or_else(|| no_relay("browser_frames_open"))?;
        let channel = registry.register_browser_frames(endpoint.port, req).await?;
        Ok(v1::BrowserFramesOpenResponse {
            channel: Some(channel),
        })
    }

    /// Opens a ComputerSession frame subscription over the same relay plane.
    async fn computer_frames_open(
        &self,
        req: &v1::ComputerFramesOpenRequest,
    ) -> PlatformResult<v1::ComputerFramesOpenResponse> {
        let backend = self.browser_control_backend().ok_or_else(|| {
            PlatformError::Unsupported(
                "computer_frames_open: interaction controller sidecar is unavailable".to_string(),
            )
        })?;
        let endpoint = backend
            .resolve(&req.scope_id, &req.scope_generation)
            .await?;
        let registry = self
            .stream_registry()
            .ok_or_else(|| no_relay("computer_frames_open"))?;
        let channel = registry
            .register_computer_frames(endpoint.port, req)
            .await?;
        Ok(v1::ComputerFramesOpenResponse {
            channel: Some(channel),
        })
    }

    /// Opens a pseudo-terminal and registers a relay PTY stream channel. Spawns the
    /// shell/command in a real PTY, hands it to the registrar to pump both
    /// directions over a [`StreamKind::Pty`](v1::StreamKind) channel, and returns
    /// the channel + a `pty_id` for subsequent resize/close.
    async fn pty_open(&self, req: &v1::PtyOpenRequest) -> PlatformResult<v1::PtyOpenResponse> {
        let registry = self.stream_registry().ok_or_else(|| no_relay("pty_open"))?;
        registry.open_pty(req, &self.default_shell()).await
    }

    /// Writes input bytes to an open PTY by id (the programmatic-injection control
    /// op; bulk interactive input normally rides the relay stream).
    async fn pty_write(&self, req: &v1::PtyWriteRequest) -> PlatformResult<v1::PtyWriteResponse> {
        let registry = self
            .stream_registry()
            .ok_or_else(|| no_relay("pty_write"))?;
        registry.pty_write(&req.pty_id, &req.data).await?;
        Ok(v1::PtyWriteResponse {
            bytes_written: req.data.len() as u64,
        })
    }

    /// Resizes an open PTY by id (the viewer reflowed its terminal).
    async fn pty_resize(
        &self,
        req: &v1::PtyResizeRequest,
    ) -> PlatformResult<v1::PtyResizeResponse> {
        let registry = self
            .stream_registry()
            .ok_or_else(|| no_relay("pty_resize"))?;
        let cols = u16::try_from(req.cols).unwrap_or(u16::MAX);
        let rows = u16::try_from(req.rows).unwrap_or(u16::MAX);
        registry.pty_resize(&req.pty_id, cols, rows).await?;
        Ok(v1::PtyResizeResponse {})
    }

    /// Closes an open PTY by id, returning the root process exit code if known.
    async fn pty_close(&self, req: &v1::PtyCloseRequest) -> PlatformResult<v1::PtyCloseResponse> {
        let registry = self
            .stream_registry()
            .ok_or_else(|| no_relay("pty_close"))?;
        let exit_code = registry.pty_close(&req.pty_id).await?;
        Ok(v1::PtyCloseResponse { exit_code })
    }

    /// Ensures a desktop framebuffer stream exists, registering a relay
    /// [`StreamKind::Desktop`](v1::StreamKind) channel that pumps captured frames
    /// out and feeds computer-use input back in. Idempotent at the registrar.
    ///
    /// Returns [`PlatformError::Unsupported`] when the host has no display
    /// (`display_unavailable`).
    async fn desktop_ensure(
        &self,
        req: &v1::DesktopEnsureRequest,
    ) -> PlatformResult<v1::DesktopEnsureResponse> {
        let desktop = self.desktop();
        // `probe()` does a synchronous x11rb connect + geometry round-trip; run it on
        // the blocking pool so a wedged/slow X server cannot stall this NATS-RPC task
        // (the desktop capture/inject calls already do the same, §10.6).
        let probed = {
            let desktop = Arc::clone(&desktop);
            tokio::task::spawn_blocking(move || desktop.probe())
                .await
                .map_err(|e| PlatformError::os(format!("desktop probe task join: {e}")))?
        };
        let display = probed.ok_or_else(|| {
            PlatformError::Unsupported(
                "no desktop display available on this host (display_unavailable)".to_string(),
            )
        })?;
        let registry = self
            .stream_registry()
            .ok_or_else(|| no_relay("desktop_ensure"))?;
        let channel = registry.register_desktop(desktop, &display, req).await?;
        Ok(v1::DesktopEnsureResponse {
            channel: Some(channel),
            display: Some(display),
        })
    }

    /// Injects one computer-use input event onto the desktop. Gated on the caller
    /// having verified `consented_screen_control`; a host with no display reports
    /// [`PlatformError::Unsupported`].
    async fn desktop_input(&self, input: &v1::DesktopInput) -> PlatformResult<()> {
        self.desktop().inject(input).await
    }
}

/// The relay stream registrar seam: the platform hands a freshly-allocated PTY or
/// desktop source to the registrar, which pumps it over a relay channel and
/// returns the channel descriptor. Implemented by `opengeni-agent-stream`'s relay
/// hub; faked in platform unit tests. Object-safe so it can live behind an `Arc`.
#[async_trait]
pub trait StreamRegistry: Send + Sync {
    /// Opens or reuses a PTY. A non-empty `scope_id` is idempotent: repeated and
    /// concurrent calls for that scope MUST return the same live PTY/channel.
    /// The default preserves the legacy new-process behavior for registries that
    /// do not implement scoped reuse; the relay hub overrides it atomically.
    async fn open_pty(
        &self,
        req: &v1::PtyOpenRequest,
        default_shell: &[String],
    ) -> PlatformResult<v1::PtyOpenResponse> {
        let process = spawn_pty(req, default_shell)?;
        self.register_pty(process).await
    }

    /// Pumps a spawned PTY over a new relay PTY channel; returns the open response
    /// (the `pty_id` + the channel the viewer connects to).
    async fn register_pty(&self, process: PtyProcess) -> PlatformResult<v1::PtyOpenResponse>;

    /// Pumps a desktop backend's captured frames over a new relay desktop channel
    /// (and feeds computer-use input back); returns the channel descriptor.
    async fn register_desktop(
        &self,
        desktop: Arc<dyn DesktopBackend>,
        display: &v1::Display,
        req: &v1::DesktopEnsureRequest,
    ) -> PlatformResult<v1::StreamChannel>;

    /// Copies one browserd WebSocket subscription into a fresh browser relay
    /// channel. The returned descriptor is what the control plane mints a viewer
    /// grant against; browserd itself remains loopback-only.
    async fn register_browser_frames(
        &self,
        browserd_port: u16,
        req: &v1::BrowserFramesOpenRequest,
    ) -> PlatformResult<v1::StreamChannel>;

    /// Copies one ComputerSession WebSocket subscription into a fresh relay
    /// channel. It intentionally shares browserd and the interaction stream
    /// transport while retaining distinct resource authority.
    async fn register_computer_frames(
        &self,
        browserd_port: u16,
        req: &v1::ComputerFramesOpenRequest,
    ) -> PlatformResult<v1::StreamChannel> {
        let _ = (browserd_port, req);
        Err(PlatformError::Unsupported(
            "computer frame relay is unavailable".to_string(),
        ))
    }

    /// Writes input bytes to an open PTY by id.
    ///
    /// # Errors
    ///
    /// [`PlatformError::NotFound`] if no PTY has that id.
    async fn pty_write(&self, pty_id: &str, data: &[u8]) -> PlatformResult<()>;

    /// Resizes an open PTY by id.
    ///
    /// # Errors
    ///
    /// [`PlatformError::NotFound`] if no PTY has that id, or [`PlatformError::Os`]
    /// if the resize syscall fails.
    async fn pty_resize(&self, pty_id: &str, cols: u16, rows: u16) -> PlatformResult<()>;

    /// Closes an open PTY by id, returning the root process exit code if known.
    ///
    /// # Errors
    ///
    /// [`PlatformError::NotFound`] if no PTY has that id.
    async fn pty_close(&self, pty_id: &str) -> PlatformResult<i32>;
}

/// The typed error returned when a stream op is attempted without a relay
/// registrar wired (e.g. a unit test with no relay). Surfaced as
/// [`ErrorCode::Unsupported`](opengeni_agent_proto::v1::ErrorCode).
fn no_relay(op: &str) -> PlatformError {
    PlatformError::Unsupported(format!("{op}: no relay stream registrar is wired"))
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

/// The platform's default login-shell argv (used when a PTY open names no
/// command): `$SHELL` (or `/bin/sh`) on unix, `cmd.exe` on Windows.
#[must_use]
pub(crate) fn default_shell() -> Vec<String> {
    #[cfg(unix)]
    {
        vec![std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())]
    }
    #[cfg(windows)]
    {
        vec![std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string())]
    }
    #[cfg(not(any(unix, windows)))]
    {
        vec!["/bin/sh".to_string()]
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
