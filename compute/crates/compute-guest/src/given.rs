//! What a create gave the sandbox, kept on its disk so a guest booted
//! again from that disk gives envd the same.
//!
//! The guest answers a create's `init` only once this is on disk for
//! good: written to a new file, synced, renamed over the old one, and
//! the directory synced. A file that is there but cannot be read is not
//! taken for "nothing given": the guest then holds envd back, rather than
//! start it without the sandbox's access token, until a new `init`
//! replaces the file.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::path::Path;

use crate::envd::InitData;

/// Where the guest keeps it. Only root may read it: it holds the access
/// token.
pub const GIVEN_FILE: &str = "/opengeni/init-data.json";

/// What the disk says the sandbox was given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Given {
    /// No create gave it anything yet.
    Nothing,
    Kept(InitData),
    /// The file is there but could not be read: why.
    Unreadable(String),
}

/// Reads what `path` keeps.
#[must_use]
pub fn load(path: &Path) -> Given {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(data) => Given::Kept(data),
            Err(error) => Given::Unreadable(format!("{}: {error}", path.display())),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Given::Nothing,
        Err(error) => Given::Unreadable(format!("{}: {error}", path.display())),
    }
}

/// Keeps `given` at `path`, for good once this returns.
///
/// # Errors
///
/// When any step fails; `path` then still holds what it held.
pub fn keep(path: &Path, given: &InitData) -> io::Result<()> {
    let bytes = serde_json::to_vec(given).map_err(io::Error::other)?;
    write_durably(path, &bytes, 0o600)
}

/// Replaces the file at `path` with `bytes` and `mode`, so that after a
/// crash at any point it holds either the old or the new contents. The
/// staging file is always a new one this call makes, with `mode` set on
/// it before anything is written: whatever an earlier attempt left at its
/// name (a partial file, a link) is removed first, never reused.
///
/// # Errors
///
/// When any step fails.
pub fn write_durably(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    let mut staged = path.as_os_str().to_owned();
    staged.push(".new");
    match fs::remove_file(&staged) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    // Exclusive creation fails on anything at the name, a link included,
    // so the file written is the one made here.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(&staged)?;
    // The process's umask may have narrowed `mode`; set it exactly.
    file.set_permissions(fs::Permissions::from_mode(mode))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&staged, path)?;
    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    File::open(parent)?.sync_all()
}

#[cfg(test)]
mod tests {

    use super::*;

    fn given(token: &str) -> InitData {
        InitData {
            env_vars: [("FOO".to_owned(), "bar".to_owned())].into(),
            access_token: Some(token.to_owned()),
            ..InitData::default()
        }
    }

    #[test]
    fn kept_data_reads_back_and_only_root_may_read_it() {
        let dir = tempdir();
        let path = dir.join("init-data.json");
        assert_eq!(load(&path), Given::Nothing);
        keep(&path, &given("one")).unwrap();
        assert_eq!(load(&path), Given::Kept(given("one")));
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        keep(&path, &given("two")).unwrap();
        assert_eq!(load(&path), Given::Kept(given("two")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_crash_before_the_rename_leaves_the_old_data() {
        let dir = tempdir();
        let path = dir.join("init-data.json");
        keep(&path, &given("old")).unwrap();
        // What a crash part way through the next write leaves behind.
        fs::write(dir.join("init-data.json.new"), b"{\"envVa").unwrap();
        assert_eq!(load(&path), Given::Kept(given("old")));
        keep(&path, &given("new")).unwrap();
        assert_eq!(load(&path), Given::Kept(given("new")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn what_an_earlier_attempt_left_at_the_staging_name_is_not_reused() {
        let dir = tempdir();
        let path = dir.join("init-data.json");
        let staged = dir.join("init-data.json.new");
        // A partial file with wider permissions.
        fs::write(&staged, b"{\"envVa").unwrap();
        fs::set_permissions(&staged, fs::Permissions::from_mode(0o644)).unwrap();
        keep(&path, &given("one")).unwrap();
        assert_eq!(load(&path), Given::Kept(given("one")));
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        // A link at the name: replaced, and what it named is untouched.
        let elsewhere = dir.join("elsewhere");
        fs::write(&elsewhere, b"unchanged").unwrap();
        fs::set_permissions(&elsewhere, fs::Permissions::from_mode(0o644)).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &staged).unwrap();
        keep(&path, &given("two")).unwrap();
        assert_eq!(load(&path), Given::Kept(given("two")));
        assert_eq!(fs::read(&elsewhere).unwrap(), b"unchanged");
        assert_eq!(
            fs::metadata(&elsewhere).unwrap().permissions().mode() & 0o777,
            0o644
        );
        assert!(fs::symlink_metadata(&path).unwrap().file_type().is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_data_is_not_taken_for_none() {
        let dir = tempdir();
        let path = dir.join("init-data.json");
        fs::write(&path, b"{\"accessToken\": tru").unwrap();
        assert!(matches!(load(&path), Given::Unreadable(_)));
        fs::write(&path, b"{\"unknownField\": 1}").unwrap();
        assert!(matches!(load(&path), Given::Unreadable(_)));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_write_reports_it_and_keeps_the_old_data() {
        let dir = tempdir();
        let path = dir.join("init-data.json");
        keep(&path, &given("old")).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).unwrap();
        if fs::write(dir.join("probe"), b"").is_ok() {
            // Root writes into a read-only directory anyway.
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
            let _ = fs::remove_dir_all(&dir);
            return;
        }
        assert!(keep(&path, &given("new")).is_err());
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(load(&path), Given::Kept(given("old")));
        let _ = fs::remove_dir_all(&dir);
    }

    fn tempdir() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "compute-guest-given-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
