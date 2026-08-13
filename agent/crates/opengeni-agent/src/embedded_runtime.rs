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

/// Materializes the release-contained runtime and returns its browserd path.
/// Development builds carry no payload and return `None`, preserving explicit
/// local/operator sidecar discovery.
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
        Ok(Some(directory.join(companion_name("opengeni-browserd"))))
    }
}

#[cfg(opengeni_embedded_runtime)]
fn runtime_digest() -> String {
    let mut hasher = blake3::Hasher::new();
    for bytes in [BROWSERD, AGENT_BROWSER, COMPUTER_NATIVE] {
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
}

#[cfg(all(opengeni_embedded_runtime, windows))]
fn companion_name(stem: &str) -> String {
    format!("{stem}.exe")
}

#[cfg(all(opengeni_embedded_runtime, not(windows)))]
fn companion_name(stem: &str) -> String {
    stem.to_string()
}
