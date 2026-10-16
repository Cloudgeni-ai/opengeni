//! Release-contained browser/computer helpers.
//!
//! A release agent embeds the exact browserd, pinned agent-browser, and native
//! computer helper built from the same source identity. This intentionally keeps
//! the historical one-file updater valid: after its atomic executable swap, the
//! new process materializes its own complete helper generation before use.

use std::path::{Path, PathBuf};

#[cfg(opengeni_embedded_runtime)]
use opengeni_agent_platform::PlatformError;
use opengeni_agent_platform::PlatformResult;

#[cfg(opengeni_embedded_runtime)]
const BROWSERD: &[u8] = include_bytes!(env!("OPENGENI_EMBEDDED_BROWSERD"));
#[cfg(opengeni_embedded_runtime)]
const AGENT_BROWSER: &[u8] = include_bytes!(env!("OPENGENI_EMBEDDED_AGENT_BROWSER"));
#[cfg(opengeni_embedded_runtime)]
const COMPUTER_NATIVE: &[u8] = include_bytes!(env!("OPENGENI_EMBEDDED_COMPUTER_NATIVE"));

#[cfg(opengeni_embedded_cua)]
const CUA_RUNTIME: &[(&str, &[u8])] = &include!(env!("OPENGENI_EMBEDDED_CUA_RUNTIME"));

/// The helper generation this process materialized, once it has.
static CURRENT_GENERATION: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Materializes the release-contained runtime and returns its browserd path.
/// Development builds carry no payload and return `None`, preserving explicit
/// local/operator sidecar discovery.
#[allow(clippy::unnecessary_wraps)]
pub fn materialize(config_dir: &Path) -> PlatformResult<Option<PathBuf>> {
    #[cfg(not(opengeni_embedded_runtime))]
    {
        let _ = config_dir;
        Ok(None)
    }
    #[cfg(opengeni_embedded_runtime)]
    {
        let generation = runtime_digest();
        let directory = config_dir
            .join("interaction-runtime")
            .join(&generation[..24]);
        create_private_directory(&directory)?;
        for (name, bytes) in [
            (companion_name("opengeni-browserd"), BROWSERD),
            (companion_name("agent-browser"), AGENT_BROWSER),
            (companion_name("opengeni-computer-native"), COMPUTER_NATIVE),
        ] {
            materialize_executable(&directory.join(name), bytes)?;
        }
        #[cfg(opengeni_embedded_cua)]
        for (name, bytes) in CUA_RUNTIME {
            let path = directory.join(name);
            create_private_directory(path.parent().expect("CUA asset parent"))?;
            materialize_executable(&path, bytes)?;
        }
        let _ = CURRENT_GENERATION.set(directory.clone());
        Ok(Some(directory.join(companion_name("opengeni-browserd"))))
    }
}

/// Removes the helper generations earlier agent releases materialized beside
/// this process's own. Each release adds one (about 100-170 MB) and nothing
/// else ever removes them.
///
/// Only the single running agent calls this, while it holds the instance lock
/// and after materializing its own generation, so no agent uses the others.
/// Processes an earlier agent left behind keep their already-open executables
/// on Unix. Windows refuses to delete a running executable; that generation
/// stays partly removed, and the next start retries it. Returns the number of
/// generations removed.
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
        if name == current_name || !is_generation_name(&name) {
            continue;
        }
        // Never follow a link out of the runtime directory.
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        match std::fs::remove_dir_all(entry.path()) {
            Ok(()) => removed += 1,
            Err(error) => tracing::warn!(
                %error,
                generation = %name.to_string_lossy(),
                "could not remove an earlier interaction runtime generation"
            ),
        }
    }
    removed
}

/// Generation directories are the first 24 hex digits of the runtime digest.
fn is_generation_name(name: &std::ffi::OsStr) -> bool {
    name.to_str()
        .is_some_and(|name| name.len() == 24 && name.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

#[cfg(opengeni_embedded_runtime)]
fn runtime_digest() -> String {
    let mut hasher = blake3::Hasher::new();
    for bytes in [BROWSERD, AGENT_BROWSER, COMPUTER_NATIVE] {
        hasher.update(&(bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    }
    #[cfg(opengeni_embedded_cua)]
    for (name, bytes) in CUA_RUNTIME {
        hasher.update(&(name.len() as u64).to_le_bytes());
        hasher.update(name.as_bytes());
        hasher.update(&(bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    }
    hasher.finalize().to_hex().to_string()
}

#[cfg(opengeni_embedded_runtime)]
fn create_private_directory(path: &Path) -> PlatformResult<()> {
    std::fs::create_dir_all(path)
        .map_err(|error| PlatformError::from_io("create embedded runtime directory", &error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| PlatformError::from_io("secure embedded runtime directory", &error))?;
    }
    Ok(())
}

#[cfg(opengeni_embedded_runtime)]
fn materialize_executable(path: &Path, expected: &[u8]) -> PlatformResult<()> {
    match std::fs::read(path) {
        Ok(bytes) if blake3::hash(&bytes) == blake3::hash(expected) => return Ok(()),
        Ok(_) => {
            return Err(PlatformError::os(
                "embedded interaction runtime helper failed its immutable digest",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(PlatformError::from_io(
                "inspect embedded runtime helper",
                &error,
            ));
        }
    }
    let mut temporary = path.as_os_str().to_os_string();
    temporary.push(format!(".new.{}", std::process::id()));
    let temporary = PathBuf::from(temporary);
    std::fs::write(&temporary, expected)
        .map_err(|error| PlatformError::from_io("write embedded runtime helper", &error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| PlatformError::from_io("secure embedded runtime helper", &error))?;
    }
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(PlatformError::from_io(
            "install embedded runtime helper",
            &error,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod prune_tests {
    use super::*;

    #[test]
    fn removes_only_earlier_generation_directories() {
        let root = tempfile::tempdir().expect("runtime root");
        let current = root.path().join("aaaaaaaaaaaaaaaaaaaaaaaa");
        let earlier = root.path().join("0123456789abcdef01234567");
        let older = root.path().join("fedcba9876543210fedcba98");
        let unrelated = root.path().join("notes");
        let hex_file = root.path().join("bbbbbbbbbbbbbbbbbbbbbbbb");
        for directory in [&current, &earlier, &older, &unrelated] {
            std::fs::create_dir_all(directory.join("node_modules")).expect("directory");
            std::fs::write(directory.join("opengeni-browserd"), b"helper").expect("helper");
        }
        std::fs::write(&hex_file, b"file").expect("file");

        assert_eq!(prune_generations_except(&current), 2);
        assert!(current.join("opengeni-browserd").is_file());
        assert!(!earlier.exists());
        assert!(!older.exists());
        assert!(unrelated.join("opengeni-browserd").is_file());
        assert!(hex_file.is_file());
        assert_eq!(prune_generations_except(&current), 0);
    }
}

#[cfg(all(test, opengeni_embedded_runtime))]
mod tests {
    use super::*;

    #[test]
    fn materializes_the_exact_complete_runtime_idempotently() {
        let root = tempfile::tempdir().expect("runtime root");
        let browserd = materialize(root.path())
            .expect("materialize runtime")
            .expect("embedded runtime");
        let directory = browserd.parent().expect("runtime directory");
        assert_eq!(std::fs::read(&browserd).expect("browserd"), BROWSERD);
        assert_eq!(
            std::fs::read(directory.join(companion_name("agent-browser"))).expect("agent-browser"),
            AGENT_BROWSER
        );
        assert_eq!(
            std::fs::read(directory.join(companion_name("opengeni-computer-native")))
                .expect("computer-native"),
            COMPUTER_NATIVE
        );
        assert_eq!(materialize(root.path()).expect("replay"), Some(browserd));
    }

    #[cfg(opengeni_embedded_cua)]
    #[test]
    fn embeds_cua_assets_and_refuses_modified_materialized_code() {
        let root = tempfile::tempdir().expect("runtime root");
        let browserd = materialize(root.path())
            .expect("materialize")
            .expect("embedded");
        let directory = browserd.parent().expect("runtime directory");
        for (name, bytes) in CUA_RUNTIME {
            assert_eq!(
                std::fs::read(directory.join(name)).expect("CUA asset"),
                *bytes
            );
        }
        let (name, _) = CUA_RUNTIME.first().expect("CUA SDK asset");
        std::fs::write(directory.join(name), b"changed SDK").expect("modify SDK");
        assert!(materialize(root.path()).is_err());
    }
}

#[cfg(all(opengeni_embedded_runtime, windows))]
fn companion_name(stem: &str) -> String {
    format!("{stem}.exe")
}

#[cfg(all(opengeni_embedded_runtime, not(windows)))]
fn companion_name(stem: &str) -> String {
    stem.to_string()
}
