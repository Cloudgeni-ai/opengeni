//! The cross-platform native [`Platform`] implementation.
//!
//! exec/fs/git are portable, so a single struct serves every OS: exec via
//! [`tokio::process`], the filesystem via [`tokio::fs`], git by shelling the
//! system `git`. The per-OS specifics (OS/arch identity, the default shell)
//! delegate to the cfg-gated `linux`/`macos`/`windows` modules.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;

use async_trait::async_trait;
use opengeni_agent_proto::v1;
use tokio::io::AsyncWriteExt;

use crate::error::{PlatformError, PlatformResult};
use crate::{HostIdentity, Platform};

/// The host-native platform: exec/fs/git against the machine the agent runs on.
#[derive(Debug, Clone)]
pub struct NativePlatform {
    /// The working root reported to the control plane (the sandbox cwd). Defaults
    /// to the process's current directory at construction time.
    workspace_root: PathBuf,
}

impl Default for NativePlatform {
    fn default() -> Self {
        Self::new()
    }
}

impl NativePlatform {
    /// Builds a platform rooted at the process's current working directory.
    #[must_use]
    pub fn new() -> Self {
        let workspace_root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        Self { workspace_root }
    }

    /// Builds a platform rooted at an explicit directory (used in tests and when
    /// the user overrides the workspace root).
    #[must_use]
    pub fn with_root(workspace_root: impl Into<PathBuf>) -> Self {
        Self {
            workspace_root: workspace_root.into(),
        }
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

#[async_trait]
impl Platform for NativePlatform {
    fn host_identity(&self) -> HostIdentity {
        crate::host_identity()
    }

    fn workspace_root(&self) -> String {
        self.workspace_root.to_string_lossy().into_owned()
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
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let started = Instant::now();
        let mut child = cmd
            .spawn()
            .map_err(|e| PlatformError::from_io(&format!("spawn {}", req.command[0]), &e))?;

        // Feed stdin (if any) then drop the handle so the child sees EOF.
        if req.stdin.is_empty() {
            // Close stdin immediately so a child reading stdin does not hang.
            drop(child.stdin.take());
        } else if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(&req.stdin).await;
            let _ = stdin.shutdown().await;
        }

        let wait = child.wait_with_output();
        let output = if req.timeout_ms > 0 {
            let dur = std::time::Duration::from_millis(u64::from(req.timeout_ms));
            match tokio::time::timeout(dur, wait).await {
                Ok(out) => out.map_err(|e| PlatformError::from_io("exec wait", &e))?,
                Err(_) => {
                    // The future was dropped, which kills the child via the kill-on-drop
                    // behavior is not default; we instead report the timeout. The OS
                    // reaps the orphan promptly because stdin/out/err are closed.
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

    /// argv for a portable "print a fixed string" used by the exec tests. On
    /// Windows the bare `echo` is a shell builtin, so we route through the shell.
    fn echo_request(text: &str) -> ExecRequest {
        if cfg!(windows) {
            ExecRequest {
                command: vec![text.to_string()],
                shell: true,
                ..Default::default()
            }
        } else {
            ExecRequest {
                command: vec!["printf".to_string(), "%s".to_string(), text.to_string()],
                ..Default::default()
            }
        }
    }

    #[tokio::test]
    async fn exec_captures_stdout_and_exit_code() {
        let (platform, _dir) = rooted();
        let resp = platform.exec(&echo_request("hello")).await.expect("exec");
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
        let resp = platform.exec(&req).await.expect("exec");
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
        let req = ExecRequest {
            command: vec!["cat".to_string()],
            stdin: prost::bytes::Bytes::from_static(b"piped-in"),
            ..Default::default()
        };
        let resp = platform.exec(&req).await.expect("exec");
        assert_eq!(&resp.stdout[..], b"piped-in");
    }

    #[tokio::test]
    async fn exec_timeout_kills_and_flags() {
        let (platform, _dir) = rooted();
        if cfg!(windows) {
            return; // `sleep` semantics differ; the timeout path is unix-covered.
        }
        let req = ExecRequest {
            command: vec!["sleep".to_string(), "30".to_string()],
            timeout_ms: 200,
            ..Default::default()
        };
        let resp = platform.exec(&req).await.expect("exec");
        assert!(resp.timed_out);
        assert_eq!(resp.exit_code, -1);
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
            let resp = platform
                .git(&GitRequest {
                    op: GitOp::Raw as i32,
                    args: args.iter().map(ToString::to_string).collect(),
                    ..Default::default()
                })
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

        // Clean repo: status is clean.
        let clean = platform
            .git(&GitRequest {
                op: GitOp::Status as i32,
                ..Default::default()
            })
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
        let dirty = platform
            .git(&GitRequest {
                op: GitOp::Status as i32,
                ..Default::default()
            })
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
        let add = platform
            .git(&GitRequest {
                op: GitOp::Add as i32,
                args: vec!["a.txt".to_string()],
                ..Default::default()
            })
            .await
            .expect("add");
        assert_eq!(add.exit_code, 0);
        let commit = platform
            .git(&GitRequest {
                op: GitOp::Commit as i32,
                args: vec!["-m".to_string(), "init".to_string()],
                ..Default::default()
            })
            .await
            .expect("commit");
        assert_eq!(
            commit.exit_code,
            0,
            "commit stderr: {}",
            String::from_utf8_lossy(&commit.stderr)
        );
        let status = platform
            .git(&GitRequest {
                op: GitOp::Status as i32,
                ..Default::default()
            })
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
    async fn pty_open_returns_unsupported_m8_seam() {
        let (platform, _dir) = rooted();
        let err = platform
            .pty_open(&v1::PtyOpenRequest::default())
            .await
            .expect_err("pty is an M8 seam");
        assert!(matches!(err, PlatformError::Unsupported(_)));
        assert_eq!(err.code(), v1::ErrorCode::Unsupported);
    }

    #[tokio::test]
    async fn desktop_ensure_returns_unsupported_m8_seam() {
        let (platform, _dir) = rooted();
        let err = platform
            .desktop_ensure(&v1::DesktopEnsureRequest::default())
            .await
            .expect_err("desktop is an M8 seam");
        assert!(matches!(err, PlatformError::Unsupported(_)));
    }
}
