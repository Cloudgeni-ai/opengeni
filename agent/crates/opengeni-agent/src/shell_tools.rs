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

/// Writes one generation under `root` and returns its directory. Each file
/// ends with exactly the embedded bytes and mode: a missing, modified or
/// wrongly-moded file is replaced atomically, so commands never run anything
/// else. Marks the generation as in use for [`prune_stale_generations`].
fn materialize_into(root: &Path, files: &[ToolFile<'_>]) -> PlatformResult<PathBuf> {
    let directory = root.join(&generation_digest(files)[..24]);
    create_shared_directory(root)?;
    create_shared_directory(&directory)?;
    for (name, bytes, mode) in files {
        materialize_file(&directory.join(name), bytes, *mode)?;
    }
    mark_in_use(&directory);
    Ok(directory)
}

/// Creates `path` and every missing parent, each readable by every user:
/// `run_as` users must reach the tools whatever the agent's umask is.
fn create_shared_directory(path: &Path) -> PlatformResult<()> {
    let mut missing = Vec::new();
    let mut cursor = Some(path);
    while let Some(candidate) = cursor {
        if std::fs::symlink_metadata(candidate).is_ok() {
            break;
        }
        missing.push(candidate.to_path_buf());
        cursor = candidate.parent();
    }
    std::fs::create_dir_all(path)
        .map_err(|error| PlatformError::from_io("create shell tools directory", &error))?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| PlatformError::from_io("inspect shell tools directory", &error))?;
    if !metadata.is_dir() {
        return Err(PlatformError::os(
            "shell tools directory must not be a link",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if !missing.iter().any(|created| created == path) {
            missing.push(path.to_path_buf());
        }
        for directory in missing {
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755)).map_err(
                |error| PlatformError::from_io("set shell tools directory mode", &error),
            )?;
        }
    }
    #[cfg(not(unix))]
    let _ = missing;
    Ok(())
}

fn materialize_file(path: &Path, expected: &[u8], mode: u32) -> PlatformResult<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && has_mode(&metadata, mode) => {
            match std::fs::read(path) {
                Ok(bytes) if blake3::hash(&bytes) == blake3::hash(expected) => return Ok(()),
                Ok(_) => tracing::warn!(
                    path = %path.display(),
                    "replacing a modified shell tool with the agent's own copy"
                ),
                Err(error) => return Err(PlatformError::from_io("inspect shell tool", &error)),
            }
        }
        Ok(_) | Err(_) => {}
    }
    let mut temporary = path.as_os_str().to_os_string();
    temporary.push(format!(".new.{}", std::process::id()));
    let temporary = PathBuf::from(temporary);
    // A leftover from an earlier crash of a process with the same id.
    let _ = std::fs::remove_file(&temporary);
    if let Err(error) = write_new_file(&temporary, expected, mode) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(PlatformError::from_io("install shell tool", &error));
    }
    Ok(())
}

/// Writes `bytes` to a file that must not exist yet, so a planted link is
/// never followed.
fn write_new_file(path: &Path, bytes: &[u8], mode: u32) -> PlatformResult<()> {
    use std::io::Write as _;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(mode);
    }
    let mut file = options
        .open(path)
        .map_err(|error| PlatformError::from_io("write shell tool", &error))?;
    file.write_all(bytes)
        .map_err(|error| PlatformError::from_io("write shell tool", &error))?;
    #[cfg(unix)]
    {
        // The umask may have narrowed the mode `open` applied.
        use std::os::unix::fs::PermissionsExt as _;
        file.set_permissions(std::fs::Permissions::from_mode(mode))
            .map_err(|error| PlatformError::from_io("set shell tool mode", &error))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    Ok(())
}

#[cfg(unix)]
fn has_mode(metadata: &std::fs::Metadata, mode: u32) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    metadata.permissions().mode() & 0o7777 == mode
}

#[cfg(not(unix))]
fn has_mode(_metadata: &std::fs::Metadata, _mode: u32) -> bool {
    true
}

/// The file whose modification time records when an agent last started with
/// a generation.
const IN_USE_MARKER: &str = ".in-use";

/// How long a generation no agent has started with is kept. Other agents on
/// the machine (another config directory, or commands an earlier release
/// handed over) may still have it on their `PATH`; agents restart with every
/// update, so a generation idle this long has no users left.
const UNUSED_GENERATION_RETENTION: std::time::Duration =
    std::time::Duration::from_secs(14 * 24 * 60 * 60);

fn mark_in_use(directory: &Path) {
    if let Err(error) = std::fs::write(directory.join(IN_USE_MARKER), b"") {
        tracing::debug!(%error, "could not mark the shell tools generation in use");
    }
}

/// Removes generations no agent has started with for
/// [`UNUSED_GENERATION_RETENTION`], beside this process's own. Only the agent
/// holding the instance lock calls this. Returns the number removed.
pub fn prune_stale_generations() -> usize {
    let Some(current) = CURRENT_GENERATION.get() else {
        return 0;
    };
    prune_generations_except(current, std::time::SystemTime::now())
}

fn prune_generations_except(current: &Path, now: std::time::SystemTime) -> usize {
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
        let path = entry.path();
        let last_used = std::fs::metadata(path.join(IN_USE_MARKER))
            .or_else(|_| std::fs::metadata(&path))
            .and_then(|metadata| metadata.modified());
        let idle = last_used
            .ok()
            .and_then(|at| now.duration_since(at).ok())
            .is_some_and(|idle| idle >= UNUSED_GENERATION_RETENTION);
        if !idle {
            continue;
        }
        match std::fs::remove_dir_all(&path) {
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
            assert_eq!(
                mode(&directory.join("THIRD-PARTY-NOTICES.txt")) & 0o777,
                0o644
            );
        }
        assert_eq!(
            materialize_into(root.path(), &FILES).expect("replay"),
            directory
        );
    }

    #[test]
    fn replaces_a_modified_or_wrongly_moded_tool() {
        let root = tempfile::tempdir().expect("root");
        let directory = materialize_into(root.path(), &FILES).expect("materialize");
        std::fs::write(directory.join("rg"), b"changed").expect("modify");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(directory.join("jq"), std::fs::Permissions::from_mode(0o644))
                .expect("chmod");
        }
        assert_eq!(
            materialize_into(root.path(), &FILES).expect("repair"),
            directory
        );
        assert_eq!(std::fs::read(directory.join("rg")).expect("rg"), FILES[0].1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(directory.join("jq"))
                .expect("jq")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o755);
        }
    }

    /// A link planted where a tool belongs is replaced, never written through.
    #[cfg(unix)]
    #[test]
    fn never_writes_through_a_planted_link() {
        let root = tempfile::tempdir().expect("root");
        let directory = materialize_into(root.path(), &FILES).expect("materialize");
        let target = root.path().join("elsewhere");
        std::fs::write(&target, b"untouched").expect("target");
        std::fs::remove_file(directory.join("rg")).expect("remove");
        std::os::unix::fs::symlink(&target, directory.join("rg")).expect("link");
        materialize_into(root.path(), &FILES).expect("repair");
        assert_eq!(std::fs::read(&target).expect("target"), b"untouched");
        assert!(std::fs::symlink_metadata(directory.join("rg"))
            .expect("rg")
            .is_file());
    }

    #[cfg(unix)]
    #[test]
    fn missing_parents_are_reachable_by_every_user() {
        use std::os::unix::fs::PermissionsExt as _;
        let root = tempfile::tempdir().expect("root");
        let nested = root.path().join("lib/opengeni/shell-tools");
        let directory = materialize_into(&nested, &FILES).expect("materialize");
        for path in [
            root.path().join("lib"),
            root.path().join("lib/opengeni"),
            nested.clone(),
            directory,
        ] {
            let mode = std::fs::metadata(&path).expect("mode").permissions().mode();
            assert_eq!(mode & 0o777, 0o755, "{}", path.display());
        }
    }

    #[test]
    fn prunes_only_generations_idle_past_retention() {
        let root = tempfile::tempdir().expect("root");
        let current = materialize_into(root.path(), &FILES).expect("materialize");
        let earlier = root.path().join("0123456789abcdef01234567");
        let unrelated = root.path().join("notes");
        for directory in [&earlier, &unrelated] {
            std::fs::create_dir_all(directory).expect("directory");
        }
        mark_in_use(&earlier);
        let now = std::time::SystemTime::now();
        // Recently used by some agent (a handover, another config directory).
        assert_eq!(prune_generations_except(&current, now), 0);
        assert!(earlier.is_dir());
        let later = now + UNUSED_GENERATION_RETENTION + std::time::Duration::from_secs(60);
        assert_eq!(prune_generations_except(&current, later), 1);
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
        assert!(std::fs::read_dir(root.path())
            .expect("root")
            .next()
            .is_none());
    }

    /// A release build materializes the exact embedded tools, which run.
    #[cfg(opengeni_embedded_shell_tools)]
    #[test]
    fn embedded_tools_materialize_and_run() {
        let files = embedded_files().expect("embedded");
        let root = tempfile::tempdir().expect("root");
        let directory = materialize_into(root.path(), &files).expect("materialize");
        for (name, flag) in [
            (executable_name("rg"), "--version"),
            (executable_name("jq"), "--version"),
        ] {
            let output = std::process::Command::new(directory.join(name))
                .arg(flag)
                .output()
                .expect("run embedded tool");
            assert!(output.status.success(), "{name} --version failed");
        }
    }
}
