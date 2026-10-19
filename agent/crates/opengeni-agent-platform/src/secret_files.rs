//! Attempt-owned private files. Closing a scope is irreversible, not a directory delete.
//!
//! The stable lock and closed marker live outside the removable data directory.
//! Synchronous IO and the OS lock belong to the physical blocking worker, never
//! its cancellable async waiter. Markers contain no secret material and have no
//! time-based expiry: a delayed request must not reopen an old scope.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

use fs2::FileExt;

use crate::{PlatformError, PlatformResult};

pub(crate) const WIRE_ROOT: &str = "/tmp/opengeni-private/secrets";

#[derive(Clone)]
pub(crate) struct SecretFiles {
    root: PathBuf,
    state: PathBuf,
    available: bool,
}

fn failure(error: impl std::fmt::Display) -> PlatformError {
    PlatformError::os(format!("private file lifecycle: {error}"))
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_file_name(value: &str) -> bool {
    value != "."
        && value != ".."
        && !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

fn private_directory(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(io::Error::other(
            "private directory is not an ordinary directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != nix::unistd::geteuid().as_raw() {
            return Err(io::Error::other("private directory has another owner"));
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn private_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(nix::libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() || fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(io::Error::other("private file is not an ordinary file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = file.metadata()?;
        if metadata.uid() != nix::unistd::geteuid().as_raw() || metadata.nlink() != 1 {
            return Err(io::Error::other("private file ownership is ambiguous"));
        }
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

impl SecretFiles {
    pub fn open(root: PathBuf, state: PathBuf) -> PlatformResult<Self> {
        // Their parents are agent-owned configuration/private directories, not
        // arbitrary request paths. The data root may not exist until first use.
        private_directory(&state).map_err(failure)?;
        if let Some(parent) = state.parent() {
            sync_directory(parent).map_err(failure)?;
        }
        let store = Self {
            root,
            state,
            available: true,
        };
        // One damaged/temporarily inaccessible scope must not disable the
        // authoritative fence for every scope. Maintenance retries closure.
        if let Err(error) = store.recover() {
            tracing::warn!(%error, "private scope recovery remains pending");
        }
        Ok(store)
    }

    pub fn unavailable(root: PathBuf, state: PathBuf) -> Self {
        Self {
            root,
            state,
            available: false,
        }
    }

    pub fn available(&self) -> bool {
        self.available
    }

    /// Resolve existing aliases before classifying, while rejecting traversal.
    /// This also fences alternate managed mutation routes into the namespace.
    pub fn contains(&self, path: &Path) -> PlatformResult<bool> {
        self.intersects(path, false)
    }

    pub fn intersects(&self, path: &Path, ancestors: bool) -> PlatformResult<bool> {
        let overlaps = |candidate: &Path, protected: &Path| {
            candidate.starts_with(protected) || (ancestors && protected.starts_with(candidate))
        };
        if overlaps(path, &self.root) || overlaps(path, &self.state) {
            return Ok(true);
        }
        let canonical = canonical_with_missing_tail(path).map_err(failure)?;
        // An unavailable private tree must not break unrelated workspace IO.
        // An alias into that unavailable tree fails resolving `path` above.
        let root = canonical_with_missing_tail(&self.root).unwrap_or_else(|_| self.root.clone());
        let state = canonical_with_missing_tail(&self.state).unwrap_or_else(|_| self.state.clone());
        Ok(overlaps(&canonical, &root) || overlaps(&canonical, &state))
    }

    fn scope_path(&self, scope: &str) -> PlatformResult<PathBuf> {
        if !valid_name(scope) {
            return Err(failure("invalid private file scope"));
        }
        Ok(self.root.join(scope))
    }

    pub fn coordinates(&self, path: &Path) -> PlatformResult<(String, Option<String>)> {
        // Only canonical managed spellings are accepted for writes/closure.
        // Aliases are detected by contains(), then refused here.
        let relative = path.strip_prefix(&self.root).map_err(failure)?;
        let names: Vec<_> = relative.components().collect();
        if names.is_empty() || names.len() > 2 {
            return Err(failure("expected one scope and an optional file name"));
        }
        let Component::Normal(scope) = names[0] else {
            return Err(failure("invalid private file scope"));
        };
        let scope = scope
            .to_str()
            .ok_or_else(|| failure("invalid private file scope"))?;
        self.scope_path(scope)?;
        let name = match names.get(1) {
            None => None,
            Some(Component::Normal(name)) => Some(
                name.to_str()
                    .ok_or_else(|| failure("invalid private file name"))?
                    .to_string(),
            ),
            _ => return Err(failure("invalid private file name")),
        };
        if name.as_ref().is_some_and(|name| !valid_file_name(name)) {
            return Err(failure("invalid private file name"));
        }
        Ok((scope.to_string(), name))
    }

    fn lock(&self, scope: &str) -> PlatformResult<File> {
        if !self.available {
            return Err(failure("private file state is unavailable"));
        }
        self.scope_path(scope)?;
        let lock = private_file(&self.state.join(format!("{scope}.lock"))).map_err(failure)?;
        lock.lock_exclusive().map_err(failure)?;
        Ok(lock)
    }

    pub fn write(&self, scope: &str, name: &str, bytes: &[u8]) -> PlatformResult<u64> {
        self.write_with(scope, name, bytes, || {})
    }

    fn write_with(
        &self,
        scope: &str,
        name: &str,
        bytes: &[u8],
        admitted: impl FnOnce(),
    ) -> PlatformResult<u64> {
        if !valid_file_name(name) {
            return Err(failure("invalid private file name"));
        }
        let _lock = self.lock(scope)?;
        if self
            .state
            .join(format!("{scope}.closed"))
            .try_exists()
            .map_err(failure)?
        {
            return Err(failure("private file scope is closed"));
        }
        admitted();
        if let Some(parent) = self.root.parent() {
            private_directory(parent).map_err(failure)?;
        }
        private_directory(&self.root).map_err(failure)?;
        let directory = self.scope_path(scope)?;
        private_directory(&directory).map_err(failure)?;
        let mut file = private_file(&directory.join(name)).map_err(failure)?;
        file.set_len(0).map_err(failure)?;
        file.write_all(bytes).map_err(failure)?;
        file.sync_all().map_err(failure)?;
        Ok(bytes.len() as u64)
    }

    pub fn close(&self, scope: &str) -> PlatformResult<()> {
        let _lock = self.lock(scope)?;
        let marker = private_file(&self.state.join(format!("{scope}.closed"))).map_err(failure)?;
        marker.sync_all().map_err(failure)?;
        sync_directory(&self.state).map_err(failure)?;
        self.remove_data(scope)
    }

    fn remove_data(&self, scope: &str) -> PlatformResult<()> {
        // Do not follow a replaced namespace root while performing recovery.
        for directory in [self.root.parent(), Some(self.root.as_path())]
            .into_iter()
            .flatten()
        {
            match fs::symlink_metadata(directory) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Ok(_) => return Err(failure("private root is not an ordinary directory")),
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(failure(error)),
            }
        }
        let path = self.scope_path(scope)?;
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(&path).map_err(failure)?,
            Ok(_) => fs::remove_file(&path).map_err(failure)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(failure(error)),
        }
        sync_directory(&self.root).map_err(failure)
    }

    pub fn recover(&self) -> PlatformResult<()> {
        for entry in fs::read_dir(&self.state).map_err(failure)? {
            let entry = entry.map_err(failure)?;
            let name = entry.file_name();
            if let Some(scope) = name.to_str().and_then(|name| name.strip_suffix(".closed")) {
                if let Err(error) = self.close(scope) {
                    tracing::warn!(%error, "closed private scope removal remains pending");
                }
            }
        }
        Ok(())
    }
}

fn canonical_with_missing_tail(path: &Path) -> io::Result<PathBuf> {
    match fs::canonicalize(path) {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or(error)?;
            Ok(canonical_with_missing_tail(parent)?.join(
                path.file_name()
                    .ok_or_else(|| io::Error::other("invalid path"))?,
            ))
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc};

    fn fixture() -> (tempfile::TempDir, SecretFiles) {
        let temp = tempfile::tempdir().unwrap();
        let store = SecretFiles::open(
            temp.path().join("private/secrets"),
            temp.path().join("state"),
        )
        .unwrap();
        (temp, store)
    }

    #[test]
    fn closing_absent_scope_fences_a_late_write_and_is_idempotent() {
        let (_temp, store) = fixture();
        store.close("attempt-1").unwrap();
        assert!(store
            .write("attempt-1", "value.pem", b"test-material")
            .is_err());
        store.close("attempt-1").unwrap();
        assert!(!store.root.join("attempt-1").exists());
        let restarted = SecretFiles::open(store.root.clone(), store.state.clone()).unwrap();
        assert!(restarted.write("attempt-1", "value.pem", b"late").is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_waiter_does_not_release_physical_write_or_close_lock() {
        let (_temp, store) = fixture();
        let store = Arc::new(store);
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let writing = store.clone();
        let waiter = tokio::spawn(async move {
            crate::spawn_blocking_reserved(move || {
                writing.write_with("attempt", "file", b"material", || {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                })
            })
            .await
            .unwrap()
        });
        entered_rx.await.unwrap();
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        // Another store instance represents a reconnected transport/process:
        // it cannot bypass the same OS-backed physical writer lock.
        let contender = private_file(&store.state.join("attempt.lock")).unwrap();
        assert!(contender.try_lock_exclusive().is_err());
        let closing = store.clone();
        let close = crate::spawn_blocking_reserved(move || closing.close("attempt"));
        release_tx.send(()).unwrap();
        close.await.unwrap().unwrap();
        assert!(!store.root.join("attempt").exists());
        assert!(store.write("attempt", "file", b"replayed").is_err());
    }

    #[test]
    fn startup_recovers_closed_scope_without_deleting_live_handover_scope() {
        let (temp, store) = fixture();
        store.write("closed", "file", b"test-secret").unwrap();
        store.write("live", "file", b"live-test-secret").unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "secret_files::tests::crash_after_marker_child",
                "--nocapture",
            ])
            .env("OPENGENI_TEST_SECRET_STATE", temp.path())
            .status()
            .unwrap();
        assert!(status.success());
        assert!(
            store.root.join("closed/file").exists(),
            "child exited before removal"
        );
        let restarted = SecretFiles::open(store.root.clone(), store.state.clone()).unwrap();
        assert!(!restarted.root.join("closed").exists());
        assert!(restarted.root.join("live/file").exists());
        assert!(restarted
            .write("closed", "file", b"late-after-restart")
            .is_err());
    }

    #[test]
    fn crash_after_marker_child() {
        let Some(root) = std::env::var_os("OPENGENI_TEST_SECRET_STATE") else {
            return;
        };
        let state = PathBuf::from(root).join("state");
        let lock = private_file(&state.join("closed.lock")).unwrap();
        lock.lock_exclusive().unwrap();
        private_file(&state.join("closed.closed"))
            .unwrap()
            .sync_all()
            .unwrap();
        sync_directory(&state).unwrap();
        // Exit without returning through scope deletion or releasing Rust guards.
        std::process::exit(0);
    }

    #[test]
    fn another_process_retains_the_lock_until_its_physical_write_finishes() {
        use std::io::BufRead;
        use std::process::Stdio;
        let (temp, store) = fixture();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "secret_files::tests::physical_writer_child",
                "--nocapture",
            ])
            .env("OPENGENI_TEST_PHYSICAL_WRITER", temp.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = std::io::BufReader::new(child.stdout.take().unwrap());
        loop {
            let mut line = String::new();
            assert_ne!(output.read_line(&mut line).unwrap(), 0);
            if line.trim() == "LOCKED" {
                break;
            }
        }
        let contender = private_file(&store.state.join("attempt.lock")).unwrap();
        assert!(contender.try_lock_exclusive().is_err());
        let closer = store.clone();
        let closing = std::thread::spawn(move || closer.close("attempt"));
        // The other process's accepted worker survives loss of its caller;
        // release its simulated slow IO, then closure must win permanently.
        drop(child.stdin.take());
        assert!(child.wait().unwrap().success());
        closing.join().unwrap().unwrap();
        assert!(!store.root.join("attempt").exists());
        assert!(store.write("attempt", "file", b"replay").is_err());
    }

    #[test]
    fn physical_writer_child() {
        use std::io::Read;
        let Some(root) = std::env::var_os("OPENGENI_TEST_PHYSICAL_WRITER") else {
            return;
        };
        let root = PathBuf::from(root);
        let store = SecretFiles::open(root.join("private/secrets"), root.join("state")).unwrap();
        store
            .write_with("attempt", "file", b"synthetic-material", || {
                println!("LOCKED");
                std::io::stdout().flush().unwrap();
                let _ = std::io::stdin().read(&mut [0_u8; 1]).unwrap();
            })
            .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn failed_recovery_keeps_closed_scopes_fenced_and_retryable() {
        use std::os::unix::fs::symlink;
        let (_temp, store) = fixture();
        store.write("closed", "file", b"material").unwrap();
        private_file(&store.state.join("closed.closed"))
            .unwrap()
            .sync_all()
            .unwrap();
        let saved = store.root.with_extension("saved");
        fs::rename(&store.root, &saved).unwrap();
        symlink(&saved, &store.root).unwrap();
        let reopened = SecretFiles::open(store.root.clone(), store.state.clone()).unwrap();
        assert!(reopened.available());
        assert!(saved.join("closed/file").exists());
        assert!(reopened.write("closed", "file", b"late").is_err());
        // Repair the local filesystem, then maintenance can close without
        // restarting or losing protection of the retained markers.
        fs::remove_file(&store.root).unwrap();
        fs::rename(saved, &store.root).unwrap();
        reopened.close("closed").unwrap();
        assert!(!store.root.join("closed").exists());
    }

    #[cfg(unix)]
    #[test]
    fn directories_are_private_and_symlink_destinations_are_refused() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let (temp, store) = fixture();
        store.write("attempt", "file", b"test").unwrap();
        for directory in [&store.root, &store.root.join("attempt"), &store.state] {
            assert_eq!(
                fs::metadata(directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        assert_eq!(
            fs::metadata(store.root.join("attempt/file"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let unrelated = temp.path().join("unrelated");
        fs::write(&unrelated, b"unchanged").unwrap();
        symlink(&unrelated, store.root.join("attempt/link")).unwrap();
        assert!(store.write("attempt", "link", b"changed").is_err());
        symlink(&store.root, temp.path().join("alias")).unwrap();
        assert!(store
            .contains(&temp.path().join("alias/attempt/new"))
            .unwrap());
        assert_eq!(fs::read(&unrelated).unwrap(), b"unchanged");
        assert!(store.coordinates(&store.root.join("../elsewhere")).is_err());
    }
}
