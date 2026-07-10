//! The cross-platform native [`Platform`] implementation.
//!
//! exec/fs/git are portable, so a single struct serves every OS: exec via
//! [`tokio::process`], the filesystem via [`tokio::fs`], git by shelling the
//! system `git`. The per-OS specifics (OS/arch identity, the default shell)
//! delegate to the cfg-gated `linux`/`macos`/`windows` modules.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use command_group::{AsyncCommandGroup, AsyncGroupChild};
use opengeni_agent_proto::v1;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use crate::desktop::{resolve_desktop, DesktopBackend};
use crate::error::{PlatformError, PlatformResult};
use crate::{HostIdentity, Platform, StreamRegistry};

/// The host-native platform: exec/fs/git against the machine the agent runs on,
/// plus the desktop backend (capture + computer-use input) and the optional relay
/// stream registrar that powers the M8 pty/desktop streams.
#[derive(Clone)]
pub struct NativePlatform {
    /// The working root reported to the control plane (the sandbox cwd). Defaults
    /// to the process's current directory at construction time.
    workspace_root: PathBuf,
    /// The host desktop backend (X11 on Linux, structured native on macOS/Windows,
    /// [`NoDesktop`](crate::NoDesktop) when headless). Resolved once at construction.
    desktop: Arc<dyn DesktopBackend>,
    /// The relay stream registrar that pumps pty/desktop channels, wired by the
    /// agent supervisor once it has a relay connection. `None` until then (and in
    /// unit contexts), in which case the stream ops report a clean `Unsupported`.
    stream_registry: Option<Arc<dyn StreamRegistry>>,
}

impl std::fmt::Debug for NativePlatform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativePlatform")
            .field("workspace_root", &self.workspace_root)
            .field("has_display", &self.desktop.probe().is_some())
            .field("has_stream_registry", &self.stream_registry.is_some())
            .finish()
    }
}

impl Default for NativePlatform {
    fn default() -> Self {
        Self::new()
    }
}

impl NativePlatform {
    /// Builds a platform rooted at the process's current working directory, with the
    /// host desktop backend resolved and no relay registrar yet (the supervisor
    /// wires one via [`with_stream_registry`](Self::with_stream_registry)).
    #[must_use]
    pub fn new() -> Self {
        let workspace_root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        Self {
            workspace_root,
            desktop: Arc::from(resolve_desktop()),
            stream_registry: None,
        }
    }

    /// Builds a platform rooted at an explicit directory (used in tests and when
    /// the user overrides the workspace root).
    #[must_use]
    pub fn with_root(workspace_root: impl Into<PathBuf>) -> Self {
        Self {
            workspace_root: workspace_root.into(),
            desktop: Arc::from(resolve_desktop()),
            stream_registry: None,
        }
    }

    /// Returns a copy of this platform with the relay stream registrar wired in,
    /// enabling the M8 pty/desktop stream ops. Called by the agent supervisor once
    /// it holds a relay connection.
    #[must_use]
    pub fn with_stream_registry(mut self, registry: Arc<dyn StreamRegistry>) -> Self {
        self.stream_registry = Some(registry);
        self
    }

    /// Overrides the desktop backend (used by `--virtual-desktop`, which spawns
    /// Xvfb and re-resolves the X11 backend against it, and by tests).
    #[must_use]
    pub fn with_desktop(mut self, desktop: Arc<dyn DesktopBackend>) -> Self {
        self.desktop = desktop;
        self
    }

    /// Resolves a request-supplied `cwd` against the workspace root: an empty
    /// `cwd` falls back to the root; a relative `cwd` is joined onto it; an
    /// absolute `cwd` is used as-is.
    fn resolve_cwd(&self, cwd: &str) -> PathBuf {
        if cwd.is_empty() {
            self.workspace_root.clone()
        } else {
            let p = Path::new(cwd);
            if p.is_absolute() {
                p.to_path_buf()
            } else {
                self.workspace_root.join(p)
            }
        }
    }
}

/// One native exec and every ordinary descendant it spawns, contained as a
/// POSIX process group on Unix or a Job Object on Windows.
///
/// `tokio::process::Command::kill_on_drop` terminates only the direct child. A
/// shell can therefore leave reparented grandchildren behind. Keeping the group
/// handle outside the wait future lets both an explicit process deadline and
/// cancellation of the entire exec future synchronously initiate group cleanup.
struct ExecProcessGroup {
    child: AsyncGroupChild,
    running: bool,
}

impl ExecProcessGroup {
    fn new(child: AsyncGroupChild) -> Self {
        Self {
            child,
            running: true,
        }
    }

    fn inner(&mut self) -> &mut tokio::process::Child {
        self.child.inner()
    }

    async fn wait_with_output(&mut self) -> std::io::Result<Output> {
        // Take the pipes before borrowing the group for `wait`. Reading both
        // concurrently avoids the usual stdout/stderr pipe deadlock while the
        // group wait ensures descendants have exited, not only the leader.
        let (stdin, stdout, stderr) = {
            let child = self.child.inner();
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        };
        drop(stdin);

        let (status, stdout, stderr) = tokio::try_join!(
            self.child.wait(),
            read_optional_pipe(stdout),
            read_optional_pipe(stderr),
        )?;
        self.running = false;
        Ok(Output {
            status,
            stdout,
            stderr,
        })
    }
}

impl Drop for ExecProcessGroup {
    fn drop(&mut self) {
        if !self.running {
            return;
        }
        let group_id = self.child.id();
        if let Err(error) = self.child.start_kill() {
            // A group that exited between cancellation and Drop is already clean.
            // Other failures matter because the caller can no longer observe the
            // command; log only identifiers/error metadata, never command text.
            if !matches!(
                error.kind(),
                std::io::ErrorKind::InvalidInput | std::io::ErrorKind::NotFound
            ) {
                tracing::warn!(?group_id, %error, "failed to terminate cancelled exec process group");
            }
        }
    }
}

async fn read_optional_pipe<R>(pipe: Option<R>) -> std::io::Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::new();
    if let Some(mut pipe) = pipe {
        pipe.read_to_end(&mut bytes).await?;
    }
    Ok(bytes)
}

#[async_trait]
impl Platform for NativePlatform {
    fn host_identity(&self) -> HostIdentity {
        crate::host_identity()
    }

    fn workspace_root(&self) -> String {
        self.workspace_root.to_string_lossy().into_owned()
    }

    fn desktop(&self) -> Arc<dyn DesktopBackend> {
        self.desktop.clone()
    }

    fn default_shell(&self) -> Vec<String> {
        crate::default_shell()
    }

    fn stream_registry(&self) -> Option<Arc<dyn StreamRegistry>> {
        self.stream_registry.clone()
    }

    async fn exec(&self, req: &v1::ExecRequest) -> PlatformResult<v1::ExecResponse> {
        if req.command.is_empty() {
            return Err(PlatformError::Os {
                message: "exec: empty command".to_string(),
                detail: BTreeMap::new(),
            });
        }

        let mut cmd = if req.shell {
            crate::shell_command(&req.command)
        } else {
            let mut c = tokio::process::Command::new(&req.command[0]);
            c.args(&req.command[1..]);
            c
        };

        cmd.current_dir(self.resolve_cwd(&req.cwd));
        for (k, v) in &req.env {
            cmd.env(k, v);
        }
        // Keep the direct-child backstop in addition to the group wrapper. The
        // builder's kill-on-drop enables Windows Job Object cleanup; on Unix the
        // wrapper's Drop sends SIGKILL to the POSIX process group.
        cmd.kill_on_drop(true);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let started = Instant::now();
        let child = cmd
            .group()
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| PlatformError::from_io(&format!("spawn {}", req.command[0]), &e))?;
        let mut child = ExecProcessGroup::new(child);

        // Feed stdin (if any) then drop the handle so the child sees EOF.
        if req.stdin.is_empty() {
            // Close stdin immediately so a child reading stdin does not hang.
            drop(child.inner().stdin.take());
        } else if let Some(mut stdin) = child.inner().stdin.take() {
            let _ = stdin.write_all(&req.stdin).await;
            let _ = stdin.shutdown().await;
        }

        let wait = child.wait_with_output();
        let output = if req.timeout_ms > 0 {
            let dur = std::time::Duration::from_millis(u64::from(req.timeout_ms));
            match tokio::time::timeout(dur, wait).await {
                Ok(out) => out.map_err(|e| PlatformError::from_io("exec wait", &e))?,
                Err(_) => {
                    // Dropping `child` below synchronously initiates process-group
                    // cleanup before this typed timeout becomes unobservable work.
                    return Ok(v1::ExecResponse {
                        exit_code: -1,
                        stdout: prost::bytes::Bytes::new(),
                        stderr: prost::bytes::Bytes::from_static(b"timed out"),
                        timed_out: true,
                        duration_ms: elapsed_millis(started),
                    });
                }
            }
        } else {
            wait.await
                .map_err(|e| PlatformError::from_io("exec wait", &e))?
        };

        Ok(v1::ExecResponse {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: prost::bytes::Bytes::from(output.stdout),
            stderr: prost::bytes::Bytes::from(output.stderr),
            timed_out: false,
            duration_ms: elapsed_millis(started),
        })
    }

    async fn fs_read(&self, req: &v1::FsReadRequest) -> PlatformResult<v1::FsReadResponse> {
        let path = self.resolve_cwd(&req.path);
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|e| PlatformError::from_io(&format!("read {}", path.display()), &e))?;
        let total_size = bytes.len() as u64;

        // Apply the optional ranged read over the in-memory buffer.
        let content = if req.offset == 0 && req.length == 0 {
            bytes
        } else {
            // Clamp the 64-bit wire offsets into the in-memory buffer; on a
            // 32-bit target an out-of-range offset simply saturates to the len.
            let start = usize::try_from(req.offset)
                .unwrap_or(usize::MAX)
                .min(bytes.len());
            let end = if req.length == 0 {
                bytes.len()
            } else {
                let len = usize::try_from(req.length).unwrap_or(usize::MAX);
                start.saturating_add(len).min(bytes.len())
            };
            bytes[start..end].to_vec()
        };

        Ok(v1::FsReadResponse {
            content: prost::bytes::Bytes::from(content),
            total_size,
        })
    }

    async fn fs_write(&self, req: &v1::FsWriteRequest) -> PlatformResult<v1::FsWriteResponse> {
        let path = self.resolve_cwd(&req.path);
        if req.create_parents {
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent).await.map_err(|e| {
                    PlatformError::from_io(&format!("mkdir -p {}", parent.display()), &e)
                })?;
            }
        }

        let mut opts = tokio::fs::OpenOptions::new();
        opts.write(true).create(true);
        if req.append {
            opts.append(true);
        } else {
            opts.truncate(true);
        }
        apply_mode(&mut opts, req.mode);

        let mut file = opts
            .open(&path)
            .await
            .map_err(|e| PlatformError::from_io(&format!("open {}", path.display()), &e))?;
        file.write_all(&req.content)
            .await
            .map_err(|e| PlatformError::from_io(&format!("write {}", path.display()), &e))?;
        file.flush()
            .await
            .map_err(|e| PlatformError::from_io(&format!("flush {}", path.display()), &e))?;

        Ok(v1::FsWriteResponse {
            bytes_written: req.content.len() as u64,
        })
    }

    async fn fs_list(&self, req: &v1::FsListRequest) -> PlatformResult<v1::FsListResponse> {
        let root = self.resolve_cwd(&req.path);
        let mut entries = Vec::new();
        list_dir(&root, &root, req.recursive, &mut entries).await?;
        Ok(v1::FsListResponse { entries })
    }

    async fn fs_mkdir(&self, req: &v1::FsMkdirRequest) -> PlatformResult<v1::FsMkdirResponse> {
        let path = self.resolve_cwd(&req.path);
        let result = if req.parents {
            tokio::fs::create_dir_all(&path).await
        } else {
            tokio::fs::create_dir(&path).await
        };
        result.map_err(|e| PlatformError::from_io(&format!("mkdir {}", path.display()), &e))?;
        set_mode(&path, req.mode).await?;
        Ok(v1::FsMkdirResponse {})
    }

    async fn fs_move(&self, req: &v1::FsMoveRequest) -> PlatformResult<v1::FsMoveResponse> {
        let from = self.resolve_cwd(&req.from);
        let to = self.resolve_cwd(&req.to);
        if !req.overwrite && tokio::fs::try_exists(&to).await.unwrap_or(false) {
            return Err(PlatformError::Os {
                message: format!("move: destination exists: {}", to.display()),
                detail: BTreeMap::new(),
            });
        }
        tokio::fs::rename(&from, &to).await.map_err(|e| {
            PlatformError::from_io(&format!("move {} -> {}", from.display(), to.display()), &e)
        })?;
        Ok(v1::FsMoveResponse {})
    }

    async fn fs_stat(&self, req: &v1::FsStatRequest) -> PlatformResult<v1::FsStatResponse> {
        let path = self.resolve_cwd(&req.path);
        match tokio::fs::symlink_metadata(&path).await {
            Ok(meta) => {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                Ok(v1::FsStatResponse {
                    exists: true,
                    entry: Some(metadata_to_entry(&name, &req.path, &meta)),
                })
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(v1::FsStatResponse {
                exists: false,
                entry: None,
            }),
            Err(e) => Err(PlatformError::from_io(
                &format!("stat {}", path.display()),
                &e,
            )),
        }
    }

    async fn fs_remove(&self, req: &v1::FsRemoveRequest) -> PlatformResult<v1::FsRemoveResponse> {
        let path = self.resolve_cwd(&req.path);
        let meta = tokio::fs::symlink_metadata(&path)
            .await
            .map_err(|e| PlatformError::from_io(&format!("stat {}", path.display()), &e))?;
        let result = if meta.is_dir() {
            if req.recursive {
                tokio::fs::remove_dir_all(&path).await
            } else {
                tokio::fs::remove_dir(&path).await
            }
        } else {
            tokio::fs::remove_file(&path).await
        };
        result.map_err(|e| PlatformError::from_io(&format!("remove {}", path.display()), &e))?;
        Ok(v1::FsRemoveResponse {})
    }

    async fn git(&self, req: &v1::GitRequest) -> PlatformResult<v1::GitResponse> {
        let cwd = self.resolve_cwd(&req.cwd);
        let args = git_args(req.op(), &req.args);

        let output = tokio::process::Command::new("git")
            .args(&args)
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await
            .map_err(|e| PlatformError::from_io("spawn git", &e))?;

        let exit_code = output.status.code().unwrap_or(-1);
        let status = if req.op() == v1::GitOp::Status && exit_code == 0 {
            Some(parse_porcelain_status(&output.stdout))
        } else {
            None
        };

        Ok(v1::GitResponse {
            exit_code,
            stdout: prost::bytes::Bytes::from(output.stdout),
            stderr: prost::bytes::Bytes::from(output.stderr),
            status,
        })
    }
}

/// Builds the git argv for an op. For [`v1::GitOp::Status`] we always use the
/// machine-readable porcelain-v2 + branch headers so [`parse_porcelain_status`]
/// can produce structured output; other ops pass through their `args` verbatim.
fn git_args(op: v1::GitOp, args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    match op {
        v1::GitOp::Status => {
            out.push("status".to_string());
            out.push("--porcelain=v2".to_string());
            out.push("--branch".to_string());
        }
        v1::GitOp::Diff => out.push("diff".to_string()),
        v1::GitOp::Log => out.push("log".to_string()),
        v1::GitOp::Add => out.push("add".to_string()),
        v1::GitOp::Commit => out.push("commit".to_string()),
        v1::GitOp::Branch => out.push("branch".to_string()),
        v1::GitOp::Checkout => out.push("checkout".to_string()),
        v1::GitOp::Pull => out.push("pull".to_string()),
        v1::GitOp::Push => out.push("push".to_string()),
        // RAW and the unspecified default pass through whatever args were given.
        v1::GitOp::Raw | v1::GitOp::Unspecified => {}
    }
    out.extend(args.iter().cloned());
    out
}

/// Parses `git status --porcelain=v2 --branch` into the structured
/// [`v1::GitStatus`]. Tolerant of fields it does not recognize.
fn parse_porcelain_status(stdout: &[u8]) -> v1::GitStatus {
    let text = String::from_utf8_lossy(stdout);
    let mut status = v1::GitStatus {
        clean: true,
        ..Default::default()
    };

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            status.branch = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            status.upstream = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // Format: "+<ahead> -<behind>".
            let mut parts = rest.split_whitespace();
            if let Some(a) = parts.next() {
                status.ahead = a.trim_start_matches('+').parse().unwrap_or(0);
            }
            if let Some(b) = parts.next() {
                status.behind = b.trim_start_matches('-').parse().unwrap_or(0);
            }
        } else if let Some(file) = parse_status_entry(line) {
            status.clean = false;
            status.files.push(file);
        }
    }
    status
}

/// Parses one porcelain-v2 entry line (ordinary `1`, renamed `2`, or untracked
/// `?`) into a [`v1::GitFileStatus`]. Returns `None` for header/unknown lines.
fn parse_status_entry(line: &str) -> Option<v1::GitFileStatus> {
    let mut parts = line.split_whitespace();
    match parts.next()? {
        "1" | "2" => {
            // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` — XY is the second field.
            let xy = parts.next()?;
            let path = line.split_whitespace().last()?.to_string();
            let staged = xy.starts_with(|c| c != '.');
            Some(v1::GitFileStatus {
                path,
                code: xy.to_string(),
                staged,
            })
        }
        "?" => {
            let path = parts.next()?.to_string();
            Some(v1::GitFileStatus {
                path,
                code: "??".to_string(),
                staged: false,
            })
        }
        _ => None,
    }
}

/// Recursively (or shallowly) lists a directory into `entries`, with each
/// entry's `path` relative to `root`.
fn list_dir<'a>(
    root: &'a Path,
    dir: &'a Path,
    recursive: bool,
    entries: &'a mut Vec<v1::FsEntry>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = PlatformResult<()>> + Send + 'a>> {
    Box::pin(async move {
        let mut rd = tokio::fs::read_dir(dir)
            .await
            .map_err(|e| PlatformError::from_io(&format!("readdir {}", dir.display()), &e))?;
        while let Some(de) = rd
            .next_entry()
            .await
            .map_err(|e| PlatformError::from_io(&format!("readdir {}", dir.display()), &e))?
        {
            let full = de.path();
            let meta = de
                .metadata()
                .await
                .map_err(|e| PlatformError::from_io(&format!("stat {}", full.display()), &e))?;
            let rel = full
                .strip_prefix(root)
                .unwrap_or(&full)
                .to_string_lossy()
                .into_owned();
            let name = de.file_name().to_string_lossy().into_owned();
            entries.push(metadata_to_entry(&name, &rel, &meta));
            if recursive && meta.is_dir() {
                list_dir(root, &full, recursive, entries).await?;
            }
        }
        Ok(())
    })
}

/// Converts filesystem metadata into a wire [`v1::FsEntry`].
fn metadata_to_entry(name: &str, rel_path: &str, meta: &std::fs::Metadata) -> v1::FsEntry {
    let kind = if meta.file_type().is_symlink() {
        v1::FsEntryKind::Symlink
    } else if meta.is_dir() {
        v1::FsEntryKind::Directory
    } else {
        v1::FsEntryKind::File
    };
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));

    v1::FsEntry {
        name: name.to_string(),
        path: rel_path.to_string(),
        kind: kind as i32,
        size: meta.len(),
        modified_ms,
        mode: file_mode(meta),
    }
}

// --- Per-OS mode helpers (POSIX permission bits where they exist) ------------

#[cfg(unix)]
fn file_mode(meta: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode()
}

#[cfg(not(unix))]
fn file_mode(_meta: &std::fs::Metadata) -> u32 {
    0
}

#[cfg(unix)]
fn apply_mode(opts: &mut tokio::fs::OpenOptions, mode: u32) {
    // `tokio::fs::OpenOptions` exposes `mode` as an inherent method on unix, so no
    // `OpenOptionsExt` import is needed (unlike `std::fs::OpenOptions`).
    if mode != 0 {
        opts.mode(mode);
    }
}

#[cfg(not(unix))]
fn apply_mode(_opts: &mut tokio::fs::OpenOptions, _mode: u32) {
    // POSIX modes are a no-op on non-unix targets.
}

#[cfg(unix)]
async fn set_mode(path: &Path, mode: u32) -> PlatformResult<()> {
    use std::os::unix::fs::PermissionsExt;
    if mode == 0 {
        return Ok(());
    }
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .await
        .map_err(|e| PlatformError::from_io(&format!("chmod {}", path.display()), &e))
}

#[cfg(not(unix))]
async fn set_mode(_path: &Path, _mode: u32) -> PlatformResult<()> {
    Ok(())
}

/// Milliseconds elapsed since `start`, saturated into a `u64` (so an absurdly
/// long-running op can never overflow the wire field). Centralizes the one cast
/// the exec path needs for `duration_ms`.
fn elapsed_millis(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use opengeni_agent_proto::v1::{
        ExecRequest, FsListRequest, FsMkdirRequest, FsMoveRequest, FsReadRequest, FsRemoveRequest,
        FsStatRequest, FsWriteRequest, GitOp, GitRequest,
    };

    /// A platform rooted at a fresh temp dir, plus the dir guard (kept alive so it
    /// is not reaped while the test runs).
    fn rooted() -> (NativePlatform, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let platform = NativePlatform::with_root(dir.path());
        (platform, dir)
    }

    /// TEST-ONLY NixOS-sandbox fork/exec transient-ENOENT mitigation.
    ///
    /// Under the default parallel `cargo test`, this NixOS sandbox intermittently
    /// fails a `fork`/`exec` of a *known-present* binary (git, `/bin/sh`) with
    /// `ENOENT` ("No such file or directory", os error 2) purely from concurrent
    /// subprocess churn — re-running the same test with `--test-threads=1` always
    /// passes. It is NOT a code bug (production agents on normal Linux never hit
    /// it), but a non-deterministic gate is unacceptable, so the test harness
    /// retries the spawn a few times when — and ONLY when — the failure is that
    /// transient spawn ENOENT for a binary the caller KNOWS is installed.
    ///
    /// This is strictly a `#[cfg(test)]` helper: production exec/git paths are
    /// untouched, so a user command that genuinely does not exist still returns
    /// `NotFound` immediately with no masking. Callers must only wrap spawns of
    /// binaries they have already confirmed are present (the `git`/exec tests gate
    /// on [`which_git`] / the platform shell); tests that deliberately assert
    /// `NotFound` for a missing target must NOT route through here.
    async fn retry_transient_spawn<T, F, Fut>(mut op: F) -> PlatformResult<T>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = PlatformResult<T>>,
    {
        const MAX_ATTEMPTS: u32 = 6;
        for attempt in 1..=MAX_ATTEMPTS {
            match op().await {
                Ok(value) => return Ok(value),
                Err(err) if attempt < MAX_ATTEMPTS && is_transient_spawn_enoent(&err) => {
                    tokio::time::sleep(std::time::Duration::from_millis(5 * u64::from(attempt)))
                        .await;
                }
                Err(err) => return Err(err),
            }
        }
        unreachable!("the loop returns on the final attempt")
    }

    /// True only for the NixOS-sandbox transient spawn `ENOENT` described on
    /// [`retry_transient_spawn`]: an error whose message is from a *spawn* context
    /// (`spawn git`, `spawn <cmd>`) and carries the os-error-2 signature. A genuine
    /// missing-file/missing-ref `NotFound` (e.g. an `fs_read` of a path that does
    /// not exist) has no `spawn` context and is therefore never matched, so those
    /// assertions keep failing/asserting immediately.
    fn is_transient_spawn_enoent(err: &PlatformError) -> bool {
        let message = match err {
            PlatformError::NotFound(m) => m.as_str(),
            PlatformError::Os { message, .. } => message.as_str(),
            _ => return false,
        };
        message.contains("spawn")
            && (message.contains("os error 2") || message.contains("No such file or directory"))
    }

    /// argv for a portable "print a fixed string" used by the exec tests.
    ///
    /// Uses the shell's `echo` BUILTIN (`shell = true`) rather than spawning
    /// `printf`/`echo` as a coreutil: on NixOS there is no `/bin/printf` (coreutils
    /// live in the nix profile) and, under heavy parallel test load, a coreutil
    /// fork/exec intermittently ENOENTs in this sandbox. A shell builtin needs no
    /// second fork, the platform shell is a stable absolute path (`/bin/sh`,
    /// `cmd.exe`), and the test still asserts real stdout capture (the callers use
    /// `contains`, tolerating `echo`'s trailing newline).
    fn echo_request(text: &str) -> ExecRequest {
        ExecRequest {
            command: vec![format!("echo {text}")],
            shell: true,
            ..Default::default()
        }
    }

    const EXEC_DESCENDANT_PID_FILE_ENV: &str = "OPENGENI_TEST_EXEC_DESCENDANT_PID_FILE";

    #[cfg(any(unix, windows))]
    fn descendant_command() -> Vec<String> {
        vec![
            std::env::current_exe()
                .expect("current test executable")
                .to_string_lossy()
                .into_owned(),
            "--ignored".to_string(),
            "--exact".to_string(),
            "native::tests::exec_descendant_parent_fixture".to_string(),
            "--nocapture".to_string(),
        ]
    }

    #[cfg(any(unix, windows))]
    fn descendant_exec_env(pid_file: &Path) -> std::collections::HashMap<String, String> {
        std::collections::HashMap::from([(
            EXEC_DESCENDANT_PID_FILE_ENV.to_string(),
            pid_file.to_string_lossy().into_owned(),
        )])
    }

    #[test]
    #[ignore = "process-tree parent fixture; invoked explicitly by exec tests"]
    fn exec_descendant_parent_fixture() {
        let status =
            std::process::Command::new(std::env::current_exe().expect("current test executable"))
                .args([
                    "--ignored",
                    "--exact",
                    "native::tests::exec_descendant_fixture",
                    "--nocapture",
                ])
                .status()
                .expect("spawn descendant fixture");
        panic!("descendant fixture exited unexpectedly: {status}");
    }

    #[test]
    #[ignore = "infinite child fixture; invoked explicitly by the parent fixture"]
    fn exec_descendant_fixture() {
        let pid_file = std::env::var_os(EXEC_DESCENDANT_PID_FILE_ENV)
            .expect("descendant fixture pid-file env");
        std::fs::write(pid_file, std::process::id().to_string())
            .expect("write descendant fixture pid");
        loop {
            std::thread::park();
        }
    }

    #[cfg(any(unix, windows))]
    async fn recorded_pid(pid_file: &Path) -> u32 {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if let Ok(raw_pid) = tokio::fs::read_to_string(pid_file).await {
                    break raw_pid.trim().parse::<u32>().expect("descendant pid");
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("descendant should publish its pid")
    }

    #[cfg(unix)]
    async fn process_exists(pid: u32) -> bool {
        tokio::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_ok_and(|status| status.success())
    }

    #[cfg(windows)]
    async fn process_exists(pid: u32) -> bool {
        let probe = format!(
            "if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 1 }}"
        );
        tokio::process::Command::new("powershell.exe")
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
            .arg(probe)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_ok_and(|status| status.success())
    }

    #[cfg(any(unix, windows))]
    async fn assert_process_exits(pid: u32, context: &str) {
        for _ in 0..100 {
            if !process_exists(pid).await {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        // Keep a failing regression test from becoming the orphan it detects.
        #[cfg(unix)]
        let _ = tokio::process::Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status()
            .await;
        #[cfg(windows)]
        let _ = tokio::process::Command::new("taskkill.exe")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .status()
            .await;
        panic!("{context} descendant {pid} survived process-group cleanup");
    }

    #[tokio::test]
    async fn exec_captures_stdout_and_exit_code() {
        let (platform, _dir) = rooted();
        // `/bin/sh` is known-present; retry the transient NixOS spawn ENOENT.
        let req = echo_request("hello");
        let resp = retry_transient_spawn(|| platform.exec(&req))
            .await
            .expect("exec");
        assert_eq!(resp.exit_code, 0);
        let out = String::from_utf8_lossy(&resp.stdout);
        assert!(out.contains("hello"), "stdout was {out:?}");
        assert!(!resp.timed_out);
    }

    #[tokio::test]
    async fn exec_nonzero_exit_is_reported_not_errored() {
        let (platform, _dir) = rooted();
        let req = ExecRequest {
            command: vec!["exit 7".to_string()],
            shell: true,
            ..Default::default()
        };
        // `/bin/sh` is known-present; retry the transient NixOS spawn ENOENT.
        let resp = retry_transient_spawn(|| platform.exec(&req))
            .await
            .expect("exec");
        assert_eq!(resp.exit_code, 7);
    }

    #[tokio::test]
    async fn exec_empty_command_is_os_error() {
        let (platform, _dir) = rooted();
        let err = platform
            .exec(&ExecRequest::default())
            .await
            .expect_err("empty command must error");
        assert!(matches!(err, PlatformError::Os { .. }));
    }

    #[tokio::test]
    async fn exec_stdin_is_fed_to_child() {
        let (platform, _dir) = rooted();
        // `cat` echoes stdin; portable on unix. Skip the assertion shape on Windows
        // where `cat` may be absent — there we just assert the call succeeds via
        // `more` is unreliable, so this test is unix-only.
        if cfg!(windows) {
            return;
        }
        // Read stdin with the shell's `read` BUILTIN + re-emit with the `echo`
        // builtin — no `cat` coreutil fork (which flakes under parallel load on
        // NixOS, where coreutils live in the nix profile). This still proves stdin
        // reaches the child; the callers tolerate `echo`'s trailing newline.
        let req = ExecRequest {
            command: vec!["IFS= read -r x; echo \"$x\"".to_string()],
            shell: true,
            stdin: prost::bytes::Bytes::from_static(b"piped-in\n"),
            ..Default::default()
        };
        // `/bin/sh` is known-present; retry the transient NixOS spawn ENOENT.
        let resp = retry_transient_spawn(|| platform.exec(&req))
            .await
            .expect("exec");
        let out = String::from_utf8_lossy(&resp.stdout);
        assert!(
            out.contains("piped-in"),
            "stdin should reach the child: {out:?}"
        );
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn exec_timeout_kills_and_flags() {
        let (platform, dir) = rooted();
        let pid_file = dir.path().join("timed-out-descendant.pid");
        // The direct exec helper launches a second ignored copy of this test
        // binary. Recording that grandchild PID catches the regression where
        // kill-on-drop terminated only the parent and reparented its child.
        let req = ExecRequest {
            command: descendant_command(),
            shell: false,
            env: descendant_exec_env(&pid_file),
            timeout_ms: 1_000,
            ..Default::default()
        };
        // Retry the transient NixOS spawn ENOENT. It happens before the timeout
        // path, so the retry cannot mask the deliberate timeout asserted below;
        // other platforms return on the first attempt.
        let resp = retry_transient_spawn(|| platform.exec(&req))
            .await
            .expect("exec");
        assert!(
            resp.timed_out,
            "the loop should be killed by the timeout: exit={} stdout={:?} stderr={:?}",
            resp.exit_code, resp.stdout, resp.stderr
        );
        assert_eq!(resp.exit_code, -1);
        let descendant_pid = recorded_pid(&pid_file).await;
        assert_process_exits(descendant_pid, "timed-out exec").await;
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn cancelling_exec_future_kills_descendant_tree() {
        let (platform, dir) = rooted();
        let pid_file = dir.path().join("cancelled-descendant.pid");
        let req = ExecRequest {
            command: descendant_command(),
            shell: false,
            env: descendant_exec_env(&pid_file),
            timeout_ms: 0,
            ..Default::default()
        };
        let platform = Arc::new(platform);
        let task_platform = platform.clone();
        let exec_task = tokio::spawn(async move { task_platform.exec(&req).await });

        let descendant_pid = recorded_pid(&pid_file).await;

        // `JoinSet::shutdown` aborts the dispatch task when a NATS connection
        // generation ends. Aborting this task exercises the same drop path: the
        // unbounded child must not outlive the caller that could observe it.
        exec_task.abort();
        let _ = exec_task.await;

        assert_process_exits(descendant_pid, "cancelled exec").await;
    }

    #[tokio::test]
    async fn fs_write_then_read_roundtrips() {
        let (platform, _dir) = rooted();
        let body = b"the quick brown fox";
        let written = platform
            .fs_write(&FsWriteRequest {
                path: "sub/dir/file.txt".to_string(),
                content: prost::bytes::Bytes::from_static(body),
                create_parents: true,
                ..Default::default()
            })
            .await
            .expect("write");
        assert_eq!(written.bytes_written, body.len() as u64);

        let read = platform
            .fs_read(&FsReadRequest {
                path: "sub/dir/file.txt".to_string(),
                ..Default::default()
            })
            .await
            .expect("read");
        assert_eq!(&read.content[..], body);
        assert_eq!(read.total_size, body.len() as u64);
    }

    #[tokio::test]
    async fn fs_read_ranged_slices_the_buffer() {
        let (platform, _dir) = rooted();
        platform
            .fs_write(&FsWriteRequest {
                path: "f".to_string(),
                content: prost::bytes::Bytes::from_static(b"0123456789"),
                ..Default::default()
            })
            .await
            .expect("write");
        let read = platform
            .fs_read(&FsReadRequest {
                path: "f".to_string(),
                offset: 3,
                length: 4,
            })
            .await
            .expect("read");
        assert_eq!(&read.content[..], b"3456");
        assert_eq!(read.total_size, 10);
    }

    #[tokio::test]
    async fn fs_read_missing_is_not_found() {
        let (platform, _dir) = rooted();
        let err = platform
            .fs_read(&FsReadRequest {
                path: "nope".to_string(),
                ..Default::default()
            })
            .await
            .expect_err("missing read must error");
        assert!(matches!(err, PlatformError::NotFound(_)));
    }

    #[tokio::test]
    async fn fs_write_append_extends() {
        let (platform, _dir) = rooted();
        let w = |body: &'static [u8], append: bool| FsWriteRequest {
            path: "log".to_string(),
            content: prost::bytes::Bytes::from_static(body),
            append,
            ..Default::default()
        };
        platform.fs_write(&w(b"a", false)).await.expect("write");
        platform.fs_write(&w(b"b", true)).await.expect("append");
        let read = platform
            .fs_read(&FsReadRequest {
                path: "log".to_string(),
                ..Default::default()
            })
            .await
            .expect("read");
        assert_eq!(&read.content[..], b"ab");
    }

    #[tokio::test]
    async fn fs_mkdir_list_stat_remove_lifecycle() {
        let (platform, _dir) = rooted();
        platform
            .fs_mkdir(&FsMkdirRequest {
                path: "a/b/c".to_string(),
                parents: true,
                ..Default::default()
            })
            .await
            .expect("mkdir");

        // Stat the directory exists.
        let stat = platform
            .fs_stat(&FsStatRequest {
                path: "a/b/c".to_string(),
            })
            .await
            .expect("stat");
        assert!(stat.exists);
        assert_eq!(stat.entry.unwrap().kind, v1::FsEntryKind::Directory as i32);

        // Drop a file in and list non-recursively from the root.
        platform
            .fs_write(&FsWriteRequest {
                path: "a/top.txt".to_string(),
                content: prost::bytes::Bytes::from_static(b"x"),
                ..Default::default()
            })
            .await
            .expect("write");
        let listing = platform
            .fs_list(&FsListRequest {
                path: "a".to_string(),
                recursive: false,
            })
            .await
            .expect("list");
        let names: Vec<_> = listing.entries.iter().map(|e| e.name.clone()).collect();
        assert!(names.contains(&"b".to_string()));
        assert!(names.contains(&"top.txt".to_string()));

        // Recursive list reaches the nested dir.
        let deep = platform
            .fs_list(&FsListRequest {
                path: "a".to_string(),
                recursive: true,
            })
            .await
            .expect("list recursive");
        assert!(deep.entries.iter().any(|e| e.path.contains('c')));

        // Remove recursively.
        platform
            .fs_remove(&FsRemoveRequest {
                path: "a".to_string(),
                recursive: true,
            })
            .await
            .expect("remove");
        let gone = platform
            .fs_stat(&FsStatRequest {
                path: "a".to_string(),
            })
            .await
            .expect("stat after remove");
        assert!(!gone.exists);
    }

    #[tokio::test]
    async fn fs_move_renames_and_guards_overwrite() {
        let (platform, _dir) = rooted();
        let write = |p: &str, b: &'static [u8]| FsWriteRequest {
            path: p.to_string(),
            content: prost::bytes::Bytes::from_static(b),
            ..Default::default()
        };
        platform.fs_write(&write("from", b"src")).await.expect("w");
        platform.fs_write(&write("to", b"dst")).await.expect("w");

        // Without overwrite, the move is refused.
        let err = platform
            .fs_move(&FsMoveRequest {
                from: "from".to_string(),
                to: "to".to_string(),
                overwrite: false,
            })
            .await
            .expect_err("must refuse overwrite");
        assert!(matches!(err, PlatformError::Os { .. }));

        // With overwrite it succeeds and the destination now holds the source.
        platform
            .fs_move(&FsMoveRequest {
                from: "from".to_string(),
                to: "to".to_string(),
                overwrite: true,
            })
            .await
            .expect("overwrite move");
        let read = platform
            .fs_read(&FsReadRequest {
                path: "to".to_string(),
                ..Default::default()
            })
            .await
            .expect("read");
        assert_eq!(&read.content[..], b"src");
    }

    #[tokio::test]
    async fn fs_stat_absent_path_succeeds_with_exists_false() {
        let (platform, _dir) = rooted();
        let stat = platform
            .fs_stat(&FsStatRequest {
                path: "ghost".to_string(),
            })
            .await
            .expect("stat must succeed for an absent path");
        assert!(!stat.exists);
        assert!(stat.entry.is_none());
    }

    /// Initializes a git repo in the platform root, returning the platform.
    async fn git_init(platform: &NativePlatform) {
        // Configure identity locally so commits work in CI with no global config.
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "agent@opengeni.test"],
            vec!["config", "user.name", "OpenGeni Agent"],
        ] {
            // git is gated as known-present by the callers' `which_git()` check, so
            // a spawn `NotFound` here is the transient NixOS fork/exec ENOENT — retry
            // it rather than fail the gate non-deterministically.
            let req = GitRequest {
                op: GitOp::Raw as i32,
                args: args.iter().map(ToString::to_string).collect(),
                ..Default::default()
            };
            let resp = retry_transient_spawn(|| platform.git(&req))
                .await
                .expect("git setup");
            assert_eq!(resp.exit_code, 0, "git {args:?} failed");
        }
    }

    #[tokio::test]
    async fn git_status_reports_structured_state() {
        let (platform, _dir) = rooted();
        if which_git().is_none() {
            return; // git absent on this host; the dispatch path is still covered.
        }
        git_init(&platform).await;

        // git is known-present here (guarded by `which_git` above), so each spawn
        // is retried against the transient NixOS fork/exec ENOENT.
        let status_req = GitRequest {
            op: GitOp::Status as i32,
            ..Default::default()
        };
        // Clean repo: status is clean.
        let clean = retry_transient_spawn(|| platform.git(&status_req))
            .await
            .expect("status");
        assert_eq!(clean.exit_code, 0);
        let st = clean.status.expect("structured status");
        assert!(st.clean, "fresh repo should be clean: {st:?}");

        // Add an untracked file → status reports it, not clean.
        platform
            .fs_write(&FsWriteRequest {
                path: "tracked.txt".to_string(),
                content: prost::bytes::Bytes::from_static(b"data"),
                ..Default::default()
            })
            .await
            .expect("write");
        let dirty = retry_transient_spawn(|| platform.git(&status_req))
            .await
            .expect("status");
        let st = dirty.status.expect("structured status");
        assert!(!st.clean);
        assert!(st.files.iter().any(|f| f.code == "??"));
    }

    #[tokio::test]
    async fn git_add_commit_then_status_clean() {
        let (platform, _dir) = rooted();
        if which_git().is_none() {
            return;
        }
        git_init(&platform).await;
        platform
            .fs_write(&FsWriteRequest {
                path: "a.txt".to_string(),
                content: prost::bytes::Bytes::from_static(b"hi"),
                ..Default::default()
            })
            .await
            .expect("write");
        // git is known-present here (guarded by `which_git` above), so each spawn
        // is retried against the transient NixOS fork/exec ENOENT.
        let add_req = GitRequest {
            op: GitOp::Add as i32,
            args: vec!["a.txt".to_string()],
            ..Default::default()
        };
        let add = retry_transient_spawn(|| platform.git(&add_req))
            .await
            .expect("add");
        assert_eq!(add.exit_code, 0);
        let commit_req = GitRequest {
            op: GitOp::Commit as i32,
            args: vec!["-m".to_string(), "init".to_string()],
            ..Default::default()
        };
        let commit = retry_transient_spawn(|| platform.git(&commit_req))
            .await
            .expect("commit");
        assert_eq!(
            commit.exit_code,
            0,
            "commit stderr: {}",
            String::from_utf8_lossy(&commit.stderr)
        );
        let status_req = GitRequest {
            op: GitOp::Status as i32,
            ..Default::default()
        };
        let status = retry_transient_spawn(|| platform.git(&status_req))
            .await
            .expect("status");
        assert!(status.status.expect("status").clean);
    }

    /// Returns `Some(())` if a `git` binary is resolvable on the host.
    fn which_git() -> Option<()> {
        std::process::Command::new("git")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok()
            .filter(std::process::ExitStatus::success)
            .map(|_| ())
    }

    #[tokio::test]
    async fn pty_open_without_relay_is_unsupported() {
        // Spawning a PTY succeeds, but with no relay registrar wired the op reports
        // a clean Unsupported (the registrar is wired by the agent supervisor).
        let (platform, _dir) = rooted();
        let err = platform
            .pty_open(&v1::PtyOpenRequest::default())
            .await
            .expect_err("no relay registrar");
        assert!(matches!(err, PlatformError::Unsupported(_)));
        assert_eq!(err.code(), v1::ErrorCode::Unsupported);
    }

    #[tokio::test]
    async fn desktop_ensure_is_unsupported_without_display_or_relay() {
        // Force a headless desktop so the test is deterministic regardless of the
        // host's $DISPLAY: no display => display_unavailable (Unsupported).
        let platform = NativePlatform::with_root("/")
            .with_desktop(std::sync::Arc::new(crate::desktop::NoDesktop));
        let err = platform
            .desktop_ensure(&v1::DesktopEnsureRequest::default())
            .await
            .expect_err("no display");
        assert!(matches!(err, PlatformError::Unsupported(_)));
    }

    #[tokio::test]
    async fn desktop_input_on_headless_is_unsupported() {
        let platform = NativePlatform::with_root("/")
            .with_desktop(std::sync::Arc::new(crate::desktop::NoDesktop));
        let err = platform
            .desktop_input(&v1::DesktopInput::default())
            .await
            .expect_err("no display");
        assert!(matches!(err, PlatformError::Unsupported(_)));
    }

    /// A desktop backend that records every injected input, so a test can assert the
    /// computer-use mapping (a `desktop_input` proto → the platform inject call).
    #[derive(Default)]
    struct RecordingDesktop {
        injected: std::sync::Mutex<Vec<v1::DesktopInput>>,
    }

    #[async_trait]
    impl crate::desktop::DesktopBackend for RecordingDesktop {
        fn probe(&self) -> Option<v1::Display> {
            Some(v1::Display {
                id: ":0".to_string(),
                width: 100,
                height: 100,
                r#virtual: false,
            })
        }
        async fn capture(&self) -> PlatformResult<crate::desktop::CapturedFrame> {
            Ok(crate::desktop::CapturedFrame {
                png: Vec::new(),
                width: 100,
                height: 100,
            })
        }
        async fn inject(&self, input: &v1::DesktopInput) -> PlatformResult<()> {
            self.injected.lock().unwrap().push(input.clone());
            Ok(())
        }
    }

    #[tokio::test]
    async fn desktop_input_proto_maps_to_the_platform_inject_call() {
        // The computer-use mapping: a DesktopInput proto routed through
        // Platform::desktop_input reaches the backend's inject verbatim.
        let recorder = std::sync::Arc::new(RecordingDesktop::default());
        let platform = NativePlatform::with_root("/").with_desktop(recorder.clone());

        let input = v1::DesktopInput {
            channel_id: "desk-1".to_string(),
            event: Some(v1::desktop_input::Event::Pointer(v1::PointerEvent {
                x: 42,
                y: 99,
                action: v1::PointerAction::Click as i32,
                button: v1::PointerButton::Right as i32,
            })),
        };
        platform.desktop_input(&input).await.expect("inject");

        let seen = recorder.injected.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0], input, "the proto must reach inject byte-identical");
    }
}
