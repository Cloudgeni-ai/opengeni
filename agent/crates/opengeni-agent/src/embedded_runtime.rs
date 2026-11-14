//! Release-contained browser/computer helpers.
//!
//! A release agent embeds the exact browserd and native computer helper built
//! from the same source identity. This intentionally keeps
//! the historical one-file updater valid: after its atomic executable swap, the
//! new process materializes its own complete helper generation before use.
//!
//! The helpers are written out, or checked, when the first browser controller
//! starts, not when the agent starts: a release embeds some 230 MB of them,
//! and reading that back on every start delayed every agent by a second or
//! more on a cold disk. Their names and digests come from `build.rs`, so the
//! agent reads its own embedded copy only to write a helper out.

use std::path::{Path, PathBuf};

#[cfg(opengeni_embedded_runtime)]
use opengeni_agent_platform::PlatformError;
use opengeni_agent_platform::PlatformResult;

#[cfg(opengeni_embedded_runtime)]
const BROWSERD: &[u8] = include_bytes!(env!("OPENGENI_EMBEDDED_BROWSERD"));
#[cfg(opengeni_embedded_runtime)]
const COMPUTER_NATIVE: &[u8] = include_bytes!(env!("OPENGENI_EMBEDDED_COMPUTER_NATIVE"));

#[cfg(opengeni_embedded_cua)]
const CUA_RUNTIME: &[(&str, &[u8])] = &include!(env!("OPENGENI_EMBEDDED_CUA_RUNTIME"));

#[cfg(opengeni_embedded_runtime)]
mod digests {
    include!(concat!(env!("OUT_DIR"), "/embedded_runtime_digests.rs"));
}

#[cfg(opengeni_embedded_cua)]
const _: () = assert!(digests::CUA_DIGESTS.len() == CUA_RUNTIME.len());

/// Whether this build embeds the runtime: then [`materialize`] provides
/// browserd, and nothing needs to be looked up beside the agent.
pub const EMBEDDED: bool = cfg!(opengeni_embedded_runtime);

/// The directory this build's helper generation lives in under
/// `config_dir`, whether or not it was written out yet. `None` for a build
/// without an embedded runtime.
#[allow(clippy::missing_const_for_fn)]
fn generation_directory(config_dir: &Path) -> Option<PathBuf> {
    #[cfg(not(opengeni_embedded_runtime))]
    {
        let _ = config_dir;
        None
    }
    #[cfg(opengeni_embedded_runtime)]
    {
        Some(
            config_dir
                .join("interaction-runtime")
                .join(digests::GENERATION),
        )
    }
}

/// Materializes the release-contained runtime and returns its browserd path.
/// Development builds carry no payload and return `None`, preserving explicit
/// local/operator sidecar discovery. Reads every helper already written out
/// (some 230 MB in a release), so it runs once, before the first browser
/// controller starts.
#[allow(clippy::unnecessary_wraps)]
pub fn materialize(config_dir: &Path) -> PlatformResult<Option<PathBuf>> {
    #[cfg(not(opengeni_embedded_runtime))]
    {
        let _ = config_dir;
        Ok(None)
    }
    #[cfg(opengeni_embedded_runtime)]
    {
        let Some(directory) = generation_directory(config_dir) else {
            return Ok(None);
        };
        create_private_directory(&directory)?;
        for (name, bytes, digest) in [
            (
                companion_name(crate::browser_sidecar::BROWSERD_FILE),
                BROWSERD,
                &digests::BROWSERD_DIGEST,
            ),
            (
                companion_name(crate::browser_sidecar::COMPUTER_NATIVE_FILE),
                COMPUTER_NATIVE,
                &digests::COMPUTER_NATIVE_DIGEST,
            ),
        ] {
            materialize_executable(&directory.join(name), bytes, digest)?;
        }
        #[cfg(opengeni_embedded_cua)]
        for ((name, bytes), (digested, digest)) in CUA_RUNTIME.iter().zip(digests::CUA_DIGESTS) {
            if name != digested {
                return Err(PlatformError::os(
                    "embedded interaction runtime digests do not name its assets",
                ));
            }
            let path = directory.join(name);
            create_private_directory(path.parent().expect("CUA asset parent"))?;
            materialize_executable(&path, bytes, digest)?;
        }
        Ok(Some(directory.join(companion_name(
            crate::browser_sidecar::BROWSERD_FILE,
        ))))
    }
}

/// Removes the helper generations earlier agent releases materialized beside
/// this build's own under `config_dir`, written out yet or not. Each release
/// adds one (about 100-230 MB) and nothing else ever removes them.
///
/// Only the single running agent calls this, while it holds the instance lock,
/// so no agent uses the others. Processes an earlier agent left behind keep
/// their already-open executables on Unix. Windows refuses to delete a running
/// executable; that generation stays partly removed, and the next start
/// retries it. Returns the number of generations removed.
pub fn prune_stale_generations(config_dir: &Path) -> usize {
    let Some(current) = generation_directory(config_dir) else {
        return 0;
    };
    prune_generations_except(&current)
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

/// The generation the embedded bytes name, as `build.rs` computes it.
#[cfg(all(test, opengeni_embedded_runtime))]
fn runtime_digest() -> String {
    let mut hasher = blake3::Hasher::new();
    for bytes in [BROWSERD, COMPUTER_NATIVE] {
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
fn materialize_executable(path: &Path, expected: &[u8], digest: &[u8; 32]) -> PlatformResult<()> {
    let digest = blake3::Hash::from_bytes(*digest);
    match file_digest(path) {
        Ok(found) if found == digest => return Ok(()),
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
    // Writing reads the embedded copy anyway: it must be what was digested.
    if blake3::hash(expected) != digest {
        return Err(PlatformError::os(
            "embedded interaction runtime helper does not match its build digest",
        ));
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

/// The digest of the file at `path`, read in pieces rather than whole: the
/// largest helper is over 100 MB.
#[cfg(opengeni_embedded_runtime)]
fn file_digest(path: &Path) -> std::io::Result<blake3::Hash> {
    let mut hasher = blake3::Hasher::new();
    hasher.update_reader(std::fs::File::open(path)?)?;
    Ok(hasher.finalize())
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
            std::fs::read(
                directory.join(companion_name(crate::browser_sidecar::COMPUTER_NATIVE_FILE,))
            )
            .expect("computer-native"),
            COMPUTER_NATIVE
        );
        assert_eq!(materialize(root.path()).expect("replay"), Some(browserd));
    }

    /// What `build.rs` digested is what the agent embeds: the generation is
    /// the one the embedded bytes name, and each helper's digest is theirs.
    /// The runtime trusts these without hashing its embedded copy again.
    #[test]
    fn build_digests_name_and_check_the_embedded_bytes() {
        assert_eq!(digests::GENERATION, &runtime_digest()[..24]);
        assert_eq!(&digests::BROWSERD_DIGEST, blake3::hash(BROWSERD).as_bytes());
        assert_eq!(
            &digests::COMPUTER_NATIVE_DIGEST,
            blake3::hash(COMPUTER_NATIVE).as_bytes()
        );
        #[cfg(opengeni_embedded_cua)]
        for ((name, bytes), (digested, digest)) in CUA_RUNTIME.iter().zip(digests::CUA_DIGESTS) {
            assert_eq!(name, digested);
            assert_eq!(digest, blake3::hash(bytes).as_bytes());
        }
        let root = tempfile::tempdir().expect("runtime root");
        assert_eq!(
            materialize(root.path())
                .expect("materialize")
                .expect("embedded"),
            generation_directory(root.path())
                .expect("generation")
                .join(companion_name(crate::browser_sidecar::BROWSERD_FILE))
        );
    }

    /// Pruning needs no helper written out: it keeps this build's generation
    /// by name and removes the others.
    #[test]
    fn prunes_earlier_generations_before_this_one_is_written() {
        let root = tempfile::tempdir().expect("config root");
        let earlier = root
            .path()
            .join("interaction-runtime")
            .join("0123456789abcdef01234567");
        std::fs::create_dir_all(&earlier).expect("earlier generation");
        assert_eq!(prune_stale_generations(root.path()), 1);
        assert!(!earlier.exists());
        let browserd = materialize(root.path())
            .expect("materialize")
            .expect("embedded");
        assert_eq!(prune_stale_generations(root.path()), 0);
        assert!(browserd.is_file());
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
