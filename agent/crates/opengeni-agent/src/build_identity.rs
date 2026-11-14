//! The running executable's SHA-256, which the agent reports in its hello so
//! the control plane knows exactly which binary serves a link (and can tell
//! that an update completed).
//!
//! A release agent is a few hundred megabytes, so hashing it is a whole read
//! of the file and a fraction of a second of CPU on every start: on a freshly
//! booted sandbox, whose page cache is empty, the longest single step before
//! the agent connects. The bytes only change when the file does, so the digest
//! is remembered in the agent's owner-only configuration directory beside the
//! identity of the file it was read from: device, inode, size, modification
//! and change times. A start that finds the same identity reuses the digest.
//!
//! The change time cannot be set from userspace and moves with every write,
//! truncation, rename or permission change, and an update installs its binary
//! by rename, as a new inode. A remembered digest therefore always belongs to
//! the unchanged file it names; anything else is hashed again.

use std::io::Read as _;
use std::path::Path;

use sha2::{Digest as _, Sha256};
use tracing::{debug, warn};

/// File in the configuration directory holding `<identity> <digest>`.
const CACHE_FILE: &str = "running-binary.sha256";

/// Hash the exact executable mapped for this process once at startup,
/// remembering it in `cache_dir` when given. A failure is loud in logs and
/// leaves an empty digest (older/unknown truth), never a fabricated value
/// that could falsely complete an update.
pub(crate) fn running_binary_sha256(cache_dir: Option<&Path>) -> String {
    let Ok(path) = std::env::current_exe() else {
        warn!("could not resolve running executable for build identity");
        return String::new();
    };
    file_sha256(&path, cache_dir)
}

fn file_sha256(path: &Path, cache_dir: Option<&Path>) -> String {
    let Ok(mut file) = std::fs::File::open(path) else {
        warn!(path = %path.display(), "could not open running executable for build identity");
        return String::new();
    };
    // The identity of the opened file, so it names the bytes hashed below.
    let identity = file.metadata().ok().as_ref().and_then(identity);
    let cache = cache_dir.map(|dir| dir.join(CACHE_FILE));
    if let (Some(cache), Some(identity)) = (&cache, &identity) {
        if let Some(digest) = remembered(cache, identity) {
            return digest;
        }
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 128 * 1024].into_boxed_slice();
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => hasher.update(&buffer[..read]),
            Err(error) => {
                warn!(path = %path.display(), %error, "could not hash running executable");
                return String::new();
            }
        }
    }
    let digest = format!("{:x}", hasher.finalize());
    if let (Some(cache), Some(identity)) = (&cache, &identity) {
        remember(cache, identity, &digest);
    }
    digest
}

#[cfg(unix)]
#[allow(clippy::unnecessary_wraps)] // the same signature as elsewhere, where there is none
fn identity(metadata: &std::fs::Metadata) -> Option<String> {
    use std::os::unix::fs::MetadataExt as _;
    Some(format!(
        "{}:{}:{}:{}.{:09}:{}.{:09}",
        metadata.dev(),
        metadata.ino(),
        metadata.size(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec(),
    ))
}

/// Without a change time that userspace cannot set, every start hashes.
#[cfg(not(unix))]
fn identity(_metadata: &std::fs::Metadata) -> Option<String> {
    None
}

fn remembered(cache: &Path, identity: &str) -> Option<String> {
    let text = std::fs::read_to_string(cache).ok()?;
    let (stored, digest) = text.trim_end().split_once(' ')?;
    let valid = digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    (stored == identity && valid).then(|| digest.to_string())
}

/// Best effort: a digest that is not remembered is computed again next time.
fn remember(cache: &Path, identity: &str, digest: &str) {
    let staging = cache.with_extension(format!("{}.tmp", std::process::id()));
    let written = std::fs::write(&staging, format!("{identity} {digest}\n"))
        .and_then(|()| std::fs::rename(&staging, cache));
    if let Err(error) = written {
        let _ = std::fs::remove_file(&staging);
        debug!(path = %cache.display(), %error, "could not remember the running executable's digest");
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn sha256(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn a_start_reuses_the_digest_of_the_unchanged_executable() {
        let dir = tempfile::tempdir().expect("dir");
        let binary = dir.path().join("agent");
        std::fs::write(&binary, b"first release").expect("binary");
        let first = file_sha256(&binary, Some(dir.path()));
        assert_eq!(first, sha256(b"first release"));

        // A later start reads the remembered digest, not the file: replace
        // the remembered value and the unchanged file answers with it.
        let cache = dir.path().join(CACHE_FILE);
        let text = std::fs::read_to_string(&cache).expect("remembered");
        let (identity, _) = text.trim_end().split_once(' ').expect("identity");
        let marker = "ab".repeat(32);
        std::fs::write(&cache, format!("{identity} {marker}\n")).expect("rewrite");
        assert_eq!(file_sha256(&binary, Some(dir.path())), marker);
        assert_eq!(file_sha256(&binary, None), first, "no cache, no reuse");
    }

    #[test]
    fn a_changed_or_replaced_executable_is_hashed_again() {
        let dir = tempfile::tempdir().expect("dir");
        let binary = dir.path().join("agent");
        std::fs::write(&binary, b"first release").expect("binary");
        file_sha256(&binary, Some(dir.path()));

        // Same size, rewritten in place. File times advance with the coarse
        // kernel clock, a few milliseconds per tick.
        std::thread::sleep(std::time::Duration::from_millis(50));
        std::fs::write(&binary, b"other release").expect("rewrite");
        assert_eq!(
            file_sha256(&binary, Some(dir.path())),
            sha256(b"other release")
        );

        // Installed by rename, as an update does.
        let staged = dir.path().join("agent.new");
        std::fs::write(&staged, b"third release").expect("staged");
        std::fs::rename(&staged, &binary).expect("install");
        assert_eq!(
            file_sha256(&binary, Some(dir.path())),
            sha256(b"third release")
        );
    }

    #[test]
    fn a_damaged_cache_is_ignored() {
        let dir = tempfile::tempdir().expect("dir");
        let binary = dir.path().join("agent");
        std::fs::write(&binary, b"release").expect("binary");
        for damaged in ["", "garbage", "x not-a-digest\n"] {
            std::fs::write(dir.path().join(CACHE_FILE), damaged).expect("damage");
            assert_eq!(file_sha256(&binary, Some(dir.path())), sha256(b"release"));
        }
        let missing = dir.path().join("absent").join("dir");
        assert_eq!(file_sha256(&binary, Some(&missing)), sha256(b"release"));
    }
}
