//! Atomic self-replace + rollback — the platform-honest headline (dossier §23.2).
//!
//! The replace is a same-filesystem rename dance so the worst power-loss outcome
//! is "old binary still in place" — NEVER a half-written live binary:
//!
//!   1. write the verified new bytes to a temp file ON THE SAME FILESYSTEM as the
//!      install path (so the later rename is atomic, not a cross-device copy);
//!   2. move the current binary aside to a `.bak` (Linux) / `.old`
//!      (Windows) BACKUP — kept until the new version proves healthy;
//!   3. rename the verified-new temp into the canonical path.
//!
//! On Linux the running ELF is held by its inode, so the on-disk path can be
//! replaced while running. On Windows the loader holds an exclusive lock, so step
//! 2 is the rename-self-aside that makes step 3 legal. macOS is intentionally
//! different: replacing only a signed `.app`'s `Contents/MacOS/opengeni-agent`
//! invalidates the bundle signature and TCC identity. Running-executable apply
//! fails before any write and requires a complete bundle reinstall. We delegate
//! supported running-exe replacement to the `self-replace` crate
//! ([`replace_running_exe`]); the lower-level
//! [`swap_binary`] does the same rename dance on an ARBITRARY path so the
//! swap/rollback logic is unit-testable without being the live process.
//!
//! [`rollback`] restores the backup over the live path — the local safety net a
//! crash-looping new binary triggers via the service manager's recovery action
//! (`--restore-last-known-good`).

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

/// Replaces the CURRENTLY-RUNNING executable with `new_bytes` on Linux/Windows,
/// delegating the platform-honest atomic replace (incl. the Windows
/// rename-self-aside) to the `self-replace` crate. Keeps the backup the same way
/// [`swap_binary`] does so the boot health-gate can roll back.
///
/// On macOS this returns [`UpdateError::BundleReinstallRequired`] before creating a
/// temp file or backup. A signed `.app` must be updated as one verified bundle.
///
/// Use this in the live agent; tests drive [`swap_binary`] on a temp path instead.
///
/// # Errors
///
/// [`UpdateError::Io`] if the current-exe path cannot be resolved or the replace
/// fails.
pub fn replace_running_exe(new_bytes: &[u8]) -> UpdateResult<PathBuf> {
    let exe = std::env::current_exe().map_err(|e| UpdateError::io("current_exe".to_string(), e))?;
    ensure_running_update_supported(std::env::consts::OS, &exe)?;

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

/// Rejects running-executable mutation on macOS before the caller creates any
/// sibling temp/backup file. `target_os` is explicit so the policy is portable-
/// unit-testable from Linux; production always passes [`std::env::consts::OS`].
fn ensure_running_update_supported(target_os: &str, exe: &Path) -> UpdateResult<()> {
    if target_os == "macos" {
        return Err(UpdateError::BundleReinstallRequired {
            path: exe.display().to_string(),
        });
    }
    Ok(())
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

    #[test]
    fn macos_running_update_requires_bundle_reinstall_before_any_write() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app_exe = dir
            .path()
            .join("OpenGeni Agent.app/Contents/MacOS/opengeni-agent");
        let error = ensure_running_update_supported("macos", &app_exe)
            .expect_err("macOS apply must fail closed");
        assert!(matches!(error, UpdateError::BundleReinstallRequired { .. }));
        assert!(error.to_string().contains("no files were changed"));
        assert!(error
            .to_string()
            .contains("complete signed OpenGeni Agent.app bundle"));
        assert!(!temp_sibling(&app_exe).exists());
        assert!(!backup_path(&app_exe).exists());
    }

    #[test]
    fn linux_and_windows_running_update_policy_remains_enabled() {
        let exe = Path::new("/opt/opengeni-agent");
        assert!(ensure_running_update_supported("linux", exe).is_ok());
        assert!(ensure_running_update_supported("windows", exe).is_ok());
    }
}
