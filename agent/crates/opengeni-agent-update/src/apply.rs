//! Atomic self-replace + rollback — the platform-honest headline.
//!
//! The replace is a same-filesystem rename dance so the worst power-loss outcome
//! is "old binary still in place" — NEVER a half-written live binary:
//!
//!   1. write the verified new bytes to a temp file ON THE SAME FILESYSTEM as the
//!      install path (so the later rename is atomic, not a cross-device copy);
//!   2. move the current binary aside to a `.bak` (Linux/macOS) / `.old`
//!      (Windows) BACKUP — kept until the new version proves healthy;
//!   3. rename the verified-new temp into the canonical path.
//!
//! On Linux/macOS the running ELF/Mach-O is held by its inode, so the on-disk path
//! can be replaced while running (the next exec picks up the new binary). On
//! Windows the loader holds an exclusive lock, so step 2 IS the rename-self-aside
//! that makes step 3 legal. We delegate the genuinely-hard running-exe replace to
//! the `self-replace` crate ([`replace_running_exe`]); the lower-level
//! [`swap_binary`] does the same rename dance on an ARBITRARY path so the
//! swap/rollback logic is unit-testable without being the live process.
//!
//! [`rollback`] restores the backup over the live path — the local safety net a
//! failed post-swap startup preflight consumes immediately.

use std::path::{Path, PathBuf};

use crate::error::{UpdateError, UpdateResult};

/// The backup suffix kept next to the live binary until the new version is healthy.
/// `.bak` on unix, `.old` on Windows (where the rename-self-aside uses it too).
#[cfg(not(windows))]
pub const BACKUP_SUFFIX: &str = "bak";
/// The backup suffix (Windows).
#[cfg(windows)]
pub const BACKUP_SUFFIX: &str = "old";

/// The backup path for an install path (`<path>.bak` / `<path>.old`).
#[must_use]
pub fn backup_path(install_path: &Path) -> PathBuf {
    let mut s = install_path.as_os_str().to_os_string();
    s.push(".");
    s.push(BACKUP_SUFFIX);
    PathBuf::from(s)
}

/// Atomically replaces the binary at `install_path` with `new_bytes`, keeping the
/// prior binary at [`backup_path`]. Returns the backup path so the caller can
/// promote (delete) it once healthy or [`rollback`] from it.
///
/// This is the testable core: it performs the EXACT rename dance the running-exe
/// path uses, but on an explicit path, so a unit test can drive a successful swap
/// AND a forced-failure rollback without being the live process.
///
/// # Errors
///
/// [`UpdateError::Io`] on any filesystem failure. On failure the function makes a
/// best effort to leave the original binary in place (it writes the temp first and
/// only renames once the temp is fully written), and never deletes the backup
/// until the new file is renamed into place.
pub fn swap_binary(install_path: &Path, new_bytes: &[u8]) -> UpdateResult<PathBuf> {
    let dir = install_path
        .parent()
        .ok_or_else(|| UpdateError::io(install_path.display().to_string(), no_parent()))?;

    // 1. Write the new bytes to a temp file on the SAME directory/filesystem.
    let tmp = temp_sibling(install_path);
    write_executable(&tmp, new_bytes)?;

    // 2. Move the current binary aside to the backup (if it exists).
    let backup = backup_path(install_path);
    if install_path.exists() {
        // Remove a stale backup first so the rename never fails on Windows.
        let _ = std::fs::remove_file(&backup);
        std::fs::rename(install_path, &backup)
            .map_err(|e| UpdateError::io(backup.display().to_string(), e))?;
    }

    // 3. Rename the verified-new temp into the canonical path.
    if let Err(e) = std::fs::rename(&tmp, install_path) {
        // Roll the backup back so we never end up with NO binary at the path.
        if backup.exists() {
            let _ = std::fs::rename(&backup, install_path);
        }
        let _ = std::fs::remove_file(&tmp);
        return Err(UpdateError::io(install_path.display().to_string(), e));
    }

    let _ = dir; // (parent existence already validated)
    Ok(backup)
}

/// Restores the backup over the live binary (the rollback the boot health-gate or
/// the service-manager recovery action triggers). After this the prior, known-good
/// binary is back at `install_path` and the backup is consumed.
///
/// # Errors
///
/// [`UpdateError::Io`] if the backup is missing or the restore rename fails.
pub fn rollback(install_path: &Path) -> UpdateResult<()> {
    let backup = backup_path(install_path);
    if !backup.exists() {
        return Err(UpdateError::io(
            backup.display().to_string(),
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no backup to roll back to (the update may have already promoted)",
            ),
        ));
    }
    // Remove the (broken) new binary, then move the backup back into place.
    let _ = std::fs::remove_file(install_path);
    std::fs::rename(&backup, install_path)
        .map_err(|e| UpdateError::io(install_path.display().to_string(), e))
}

/// Promotes a successful update by deleting the retained backup. Called once the
/// new binary passes the boot health gate.
///
/// # Errors
///
/// [`UpdateError::Io`] only if the backup exists and cannot be removed; a missing
/// backup is fine (already promoted).
pub fn promote(install_path: &Path) -> UpdateResult<()> {
    let backup = backup_path(install_path);
    if backup.exists() {
        std::fs::remove_file(&backup)
            .map_err(|e| UpdateError::io(backup.display().to_string(), e))?;
    }
    Ok(())
}

/// Replaces the CURRENTLY-RUNNING executable with `new_bytes`, delegating the
/// platform-honest atomic replace (incl. the Windows rename-self-aside) to the
/// `self-replace` crate. Keeps the backup the same way [`swap_binary`] does so the
/// boot health-gate can roll back.
///
/// Use this in the live agent; tests drive [`swap_binary`] on a temp path instead.
///
/// # Errors
///
/// [`UpdateError::Io`] if the current-exe path cannot be resolved or the replace
/// fails.
pub fn replace_running_exe(new_bytes: &[u8]) -> UpdateResult<PathBuf> {
    let exe = std::env::current_exe().map_err(|e| UpdateError::io("current_exe".to_string(), e))?;

    // Write the verified bytes to a same-dir temp, keep a backup, then let
    // self-replace atomically swap the temp over the live exe (handling the
    // running-exe lock on every OS).
    let tmp = temp_sibling(&exe);
    write_executable(&tmp, new_bytes)?;

    // Back up the current exe before the swap so rollback has a known-good copy.
    let backup = backup_path(&exe);
    let _ = std::fs::remove_file(&backup);
    std::fs::copy(&exe, &backup).map_err(|e| UpdateError::io(backup.display().to_string(), e))?;

    self_replace::self_replace(&tmp).map_err(|e| UpdateError::io(exe.display().to_string(), e))?;
    let _ = std::fs::remove_file(&tmp);
    Ok(backup)
}

/// Atomically replaces a Unix executable at its previously captured install path.
/// Keeps a copied rollback backup without ever moving the canonical file aside.
/// Unlike a late current_exe lookup, this remains valid after a prior apply or
/// rollback in the same process.
///
/// # Errors
///
/// Returns an I/O error if the existing install cannot be inspected, backed up,
/// or atomically replaced.
#[cfg(unix)]
pub fn replace_running_exe_at(install_path: &Path, new_bytes: &[u8]) -> UpdateResult<PathBuf> {
    let permissions = std::fs::metadata(install_path)
        .map_err(|error| UpdateError::io(install_path.display().to_string(), error))?
        .permissions();
    let tmp = temp_sibling(install_path);
    write_executable(&tmp, new_bytes)?;
    let backup = backup_path(install_path);
    let result = (|| {
        std::fs::set_permissions(&tmp, permissions)
            .map_err(|error| UpdateError::io(tmp.display().to_string(), error))?;
        let _ = std::fs::remove_file(&backup);
        std::fs::copy(install_path, &backup)
            .map_err(|error| UpdateError::io(backup.display().to_string(), error))?;
        std::fs::rename(&tmp, install_path)
            .map_err(|error| UpdateError::io(install_path.display().to_string(), error))?;
        Ok(backup)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// A temp file name sibling to `path` on the same directory/filesystem.
fn temp_sibling(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(".new");
    PathBuf::from(s)
}

/// Writes `bytes` to `path` and marks it executable (unix). On a failure the temp
/// is removed so a partial write never lingers.
fn write_executable(path: &Path, bytes: &[u8]) -> UpdateResult<()> {
    std::fs::write(path, bytes).map_err(|e| UpdateError::io(path.display().to_string(), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)) {
            let _ = std::fs::remove_file(path);
            return Err(UpdateError::io(path.display().to_string(), e));
        }
    }
    Ok(())
}

fn no_parent() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        "install path has no parent directory",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn read(path: &Path) -> Vec<u8> {
        fs::read(path).expect("read")
    }

    #[cfg(unix)]
    #[test]
    fn captured_install_replacement_preserves_permissions_and_rollback() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("agent");
        fs::write(&bin, b"old").unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o750)).unwrap();
        let backup = replace_running_exe_at(&bin, b"new").unwrap();
        assert_eq!(read(&bin), b"new");
        assert_eq!(read(&backup), b"old");
        assert_eq!(
            fs::metadata(&bin).unwrap().permissions().mode() & 0o777,
            0o750
        );
        rollback(&bin).unwrap();
        assert_eq!(read(&bin), b"old");
        replace_running_exe_at(&bin, b"retry").unwrap();
        promote(&bin).unwrap();
        assert_eq!(read(&bin), b"retry");
        assert!(!backup.exists());
        assert!(!temp_sibling(&bin).exists());
    }

    #[test]
    fn swap_replaces_and_keeps_a_backup() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bin = dir.path().join("opengeni-agent");
        fs::write(&bin, b"OLD-v1").expect("seed");

        let backup = swap_binary(&bin, b"NEW-v2").expect("swap");
        assert_eq!(read(&bin), b"NEW-v2", "new bytes are live");
        assert_eq!(read(&backup), b"OLD-v1", "old bytes are retained as backup");
        assert_eq!(backup, backup_path(&bin));
    }

    #[test]
    fn rollback_restores_the_prior_binary() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bin = dir.path().join("opengeni-agent");
        fs::write(&bin, b"OLD-v1").expect("seed");

        swap_binary(&bin, b"NEW-v2-broken").expect("swap");
        assert_eq!(read(&bin), b"NEW-v2-broken");

        // The new binary fails its health gate => roll back to v1.
        rollback(&bin).expect("rollback");
        assert_eq!(read(&bin), b"OLD-v1", "the known-good binary is restored");
        assert!(
            !backup_path(&bin).exists(),
            "the backup is consumed by rollback"
        );
    }

    #[test]
    fn rollback_without_a_backup_is_a_typed_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bin = dir.path().join("opengeni-agent");
        fs::write(&bin, b"only-v1").expect("seed");
        // No prior swap => no backup => rollback errors rather than nuking the binary.
        assert!(matches!(
            rollback(&bin).unwrap_err(),
            UpdateError::Io { .. }
        ));
        assert_eq!(read(&bin), b"only-v1", "the live binary is untouched");
    }

    #[test]
    fn promote_deletes_the_backup() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bin = dir.path().join("opengeni-agent");
        fs::write(&bin, b"OLD").expect("seed");
        swap_binary(&bin, b"NEW").expect("swap");
        assert!(backup_path(&bin).exists());
        promote(&bin).expect("promote");
        assert!(
            !backup_path(&bin).exists(),
            "the backup is gone after promote"
        );
        assert_eq!(read(&bin), b"NEW");
    }

    #[cfg(unix)]
    #[test]
    fn swapped_binary_is_executable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let bin = dir.path().join("opengeni-agent");
        fs::write(&bin, b"OLD").expect("seed");
        swap_binary(&bin, b"NEW").expect("swap");
        let mode = fs::metadata(&bin).expect("meta").permissions().mode();
        assert_eq!(mode & 0o111, 0o111, "the new binary must be executable");
    }

    #[test]
    fn swap_into_a_fresh_path_works_without_a_prior_binary() {
        // First-ever install (no existing binary, no backup) still places the file.
        let dir = tempfile::tempdir().expect("tempdir");
        let bin = dir.path().join("opengeni-agent");
        let backup = swap_binary(&bin, b"FIRST").expect("swap");
        assert_eq!(read(&bin), b"FIRST");
        assert!(!backup.exists(), "no backup when there was no prior binary");
    }
}
