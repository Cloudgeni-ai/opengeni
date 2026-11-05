//! Release-contained ripgrep and jq for the commands this agent runs.
//!
//! Release builds embed the official, checksum-pinned binaries for their own
//! target (see `scripts/fetch-shell-tools.ts`). At start the agent writes them
//! to one immutable generation directory and appends that directory to the
//! end of every command's `PATH` (`opengeni_agent_platform::shell_tools`), so
//! a copy the machine already has always wins. Nothing is downloaded: the
//! bytes travel inside the agent executable. Development builds embed nothing
//! and leave commands untouched.

use std::path::{Path, PathBuf};

use opengeni_agent_platform::{PlatformError, PlatformResult};

#[cfg(opengeni_embedded_shell_tools)]
const RG: &[u8] = include_bytes!(env!("OPENGENI_EMBEDDED_RG"));
#[cfg(opengeni_embedded_shell_tools)]
const JQ: &[u8] = include_bytes!(env!("OPENGENI_EMBEDDED_JQ"));
#[cfg(opengeni_embedded_shell_tools)]
const NOTICES: &[u8] = include_bytes!(env!("OPENGENI_EMBEDDED_SHELL_TOOLS_NOTICES"));

/// Where a root agent on Linux keeps the tools: `run_as` users must be able to
/// reach them, and root's own config directory is private.
const SHARED_ROOT: &str = "/var/lib/opengeni/shell-tools";

/// One file of a generation: name, bytes and Unix mode.
type ToolFile<'a> = (&'a str, &'a [u8], u32);

/// The generation directory this process materialized, once it has.
static CURRENT_GENERATION: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Materializes the embedded tools and records their directory for command
/// `PATH`s. Returns `None` for a build without tools. Errors leave commands
/// unchanged; the caller only logs them.
pub fn install(config_dir: Option<&Path>) -> PlatformResult<Option<PathBuf>> {
    let Some(files) = embedded_files() else {
        return Ok(None);
    };
    let mut roots = Vec::new();
    if opengeni_agent_platform::run_as::supported() {
        roots.push(PathBuf::from(SHARED_ROOT));
    }
    if let Some(config_dir) = config_dir {
        roots.push(config_dir.join("shell-tools"));
    }
    let mut last_error = None;
    for root in roots {
        match materialize_into(&root, &files) {
            Ok(directory) => {
                let _ = CURRENT_GENERATION.set(directory.clone());
                opengeni_agent_platform::set_shell_tools_directory(directory.clone());
                return Ok(Some(directory));
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error
        .unwrap_or_else(|| PlatformError::os("no directory available for the agent's shell tools")))
}

#[cfg(opengeni_embedded_shell_tools)]
fn embedded_files() -> Option<[ToolFile<'static>; 3]> {
    Some([
        (executable_name("rg"), RG, 0o755),
        (executable_name("jq"), JQ, 0o755),
        ("THIRD-PARTY-NOTICES.txt", NOTICES, 0o644),
    ])
}

#[cfg(not(opengeni_embedded_shell_tools))]
fn embedded_files() -> Option<[ToolFile<'static>; 3]> {
    None
}

#[cfg(opengeni_embedded_shell_tools)]
const fn executable_name(stem: &'static str) -> &'static str {
    if cfg!(windows) {
        match stem.as_bytes() {
            b"rg" => "rg.exe",
            _ => "jq.exe",
        }
    } else {
        stem
    }
}

fn generation_digest(files: &[ToolFile<'_>]) -> String {
    let mut hasher = blake3::Hasher::new();
    for (name, bytes, mode) in files {
        hasher.update(&(name.len() as u64).to_le_bytes());
        hasher.update(name.as_bytes());
        hasher.update(&mode.to_le_bytes());
        hasher.update(&(bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    }
    hasher.finalize().to_hex().to_string()
}

/// Writes one immutable generation under `root` and returns its directory.
/// A file that already exists must match exactly; a modified tool is refused
/// rather than run.
fn materialize_into(root: &Path, files: &[ToolFile<'_>]) -> PlatformResult<PathBuf> {
    let directory = root.join(&generation_digest(files)[..24]);
    create_shared_directory(root)?;
    create_shared_directory(&directory)?;
    for (name, bytes, mode) in files {
        materialize_file(&directory.join(name), bytes, *mode)?;
    }
    Ok(directory)
}

fn create_shared_directory(path: &Path) -> PlatformResult<()> {
    std::fs::create_dir_all(path)
        .map_err(|error| PlatformError::from_io("create shell tools directory", &error))?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| PlatformError::from_io("inspect shell tools directory", &error))?;
    if !metadata.is_dir() {
        return Err(PlatformError::os("shell tools directory must not be a link"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| PlatformError::from_io("set shell tools directory mode", &error))?;
    }
    Ok(())
}

fn materialize_file(path: &Path, expected: &[u8], mode: u32) -> PlatformResult<()> {
    match std::fs::read(path) {
        Ok(bytes) if blake3::hash(&bytes) == blake3::hash(expected) => return Ok(()),
        Ok(_) => {
            return Err(PlatformError::os(
                "a materialized shell tool failed its immutable digest",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(PlatformError::from_io("inspect shell tool", &error)),
    }
    let mut temporary = path.as_os_str().to_os_string();
    temporary.push(format!(".new.{}", std::process::id()));
    let temporary = PathBuf::from(temporary);
    std::fs::write(&temporary, expected)
        .map_err(|error| PlatformError::from_io("write shell tool", &error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(mode))
            .map_err(|error| PlatformError::from_io("set shell tool mode", &error))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(PlatformError::from_io("install shell tool", &error));
    }
    Ok(())
}

/// Removes generations earlier agent releases left beside this process's own.
/// Only the agent holding the instance lock calls this. Returns the number
/// removed.
pub fn prune_stale_generations() -> usize {
    let Some(current) = CURRENT_GENERATION.get() else {
        return 0;
    };
    prune_generations_except(current)
}

fn prune_generations_except(current: &Path) -> usize {
    let (Some(root), Some(current_name)) = (current.parent(), current.file_name()) else {
        return 0;
    };
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let is_generation = name
            .to_str()
            .is_some_and(|name| name.len() == 24 && name.bytes().all(|b| b.is_ascii_hexdigit()));
        if name == current_name || !is_generation {
            continue;
        }
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        match std::fs::remove_dir_all(entry.path()) {
            Ok(()) => removed += 1,
            Err(error) => tracing::warn!(
                %error,
                generation = %name.to_string_lossy(),
                "could not remove an earlier shell tools generation"
            ),
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILES: [ToolFile<'static>; 3] = [
        ("rg", b"#!/bin/sh\necho ripgrep\n", 0o755),
        ("jq", b"#!/bin/sh\necho jq\n", 0o755),
        ("THIRD-PARTY-NOTICES.txt", b"notices\n", 0o644),
    ];

    #[test]
    fn materializes_one_generation_idempotently() {
        let root = tempfile::tempdir().expect("root");
        let directory = materialize_into(root.path(), &FILES).expect("materialize");
        assert_eq!(directory.parent(), Some(root.path()));
        for (name, bytes, _) in FILES {
            assert_eq!(std::fs::read(directory.join(name)).expect("file"), bytes);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = |path: &Path| std::fs::metadata(path).expect("mode").permissions().mode();
            assert_eq!(mode(&directory) & 0o777, 0o755);
            assert_eq!(mode(&directory.join("rg")) & 0o777, 0o755);
            assert_eq!(mode(&directory.join("THIRD-PARTY-NOTICES.txt")) & 0o777, 0o644);
        }
        assert_eq!(materialize_into(root.path(), &FILES).expect("replay"), directory);
    }

    #[test]
    fn refuses_a_modified_tool() {
        let root = tempfile::tempdir().expect("root");
        let directory = materialize_into(root.path(), &FILES).expect("materialize");
        std::fs::write(directory.join("rg"), b"changed").expect("modify");
        assert!(materialize_into(root.path(), &FILES).is_err());
    }

    #[test]
    fn prunes_only_earlier_generations() {
        let root = tempfile::tempdir().expect("root");
        let current = materialize_into(root.path(), &FILES).expect("materialize");
        let earlier = root.path().join("0123456789abcdef01234567");
        let unrelated = root.path().join("notes");
        for directory in [&earlier, &unrelated] {
            std::fs::create_dir_all(directory).expect("directory");
        }
        assert_eq!(prune_generations_except(&current), 1);
        assert!(current.join("rg").is_file());
        assert!(!earlier.exists());
        assert!(unrelated.is_dir());
    }

    /// A build without embedded tools (every development build) installs
    /// nothing, so commands keep exactly the environment they asked for.
    #[cfg(not(opengeni_embedded_shell_tools))]
    #[test]
    fn a_build_without_tools_changes_nothing() {
        let root = tempfile::tempdir().expect("root");
        assert!(install(Some(root.path())).expect("install").is_none());
        assert!(opengeni_agent_platform::shell_tools_directory().is_none());
        assert!(std::fs::read_dir(root.path()).expect("root").next().is_none());
    }

    /// A release build materializes the exact embedded tools, which run.
    #[cfg(opengeni_embedded_shell_tools)]
    #[test]
    fn embedded_tools_materialize_and_run() {
        let files = embedded_files().expect("embedded");
        let root = tempfile::tempdir().expect("root");
        let directory = materialize_into(root.path(), &files).expect("materialize");
        for (name, flag) in [(executable_name("rg"), "--version"), (executable_name("jq"), "--version")] {
            let output = std::process::Command::new(directory.join(name))
                .arg(flag)
                .output()
                .expect("run embedded tool");
            assert!(output.status.success(), "{name} --version failed");
        }
    }
}
