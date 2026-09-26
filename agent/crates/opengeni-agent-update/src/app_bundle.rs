//! Whole-bundle macOS updates. Never modify a sealed application's contents.

use std::fs::{self, File};
use std::io::{Read as _, Seek as _, Write as _};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use rustix::fs::{flock, renameat_with, FlockOperation, RenameFlags, CWD};

use crate::{sha256_hex, UpdateError, UpdateResult};

/// Signed manifest target for the complete notarized application ZIP.
pub const APP_BUNDLE_TARGET: &str = "universal-apple-darwin-app";
const EXECUTABLE: &str = "Contents/MacOS/opengeni-agent";

/// Recognizes the official app executable layout without following symlinks.
#[must_use]
pub fn app_bundle_root(executable: &Path) -> Option<&Path> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let app = contents.parent()?;
    (executable.file_name()? == "opengeni-agent"
        && macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && app.extension()? == "app")
        .then_some(app)
}

fn invalid(message: impl Into<String>) -> UpdateError {
    UpdateError::HealthCheck(message.into())
}

fn io(path: &Path, error: std::io::Error) -> UpdateError {
    UpdateError::io(path.display().to_string(), error)
}

// Output goes to owned files, avoiding pipe backpressure. The bounds apply to
// waiting and retained diagnostics, including an executable that never exits.
fn run(command: &mut Command, timeout: Duration) -> UpdateResult<String> {
    let mut output =
        tempfile::tempfile().map_err(|error| UpdateError::io("command output", error))?;
    let stdout = output
        .try_clone()
        .map_err(|error| UpdateError::io("command output", error))?;
    let stderr = output
        .try_clone()
        .map_err(|error| UpdateError::io("command output", error))?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .spawn()
        .map_err(|error| UpdateError::io("app verification command", error))?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(invalid(format!(
                    "app verification command timed out or failed: {result:?}"
                )));
            }
        }
    };
    output
        .rewind()
        .map_err(|error| UpdateError::io("command output", error))?;
    let mut bytes = Vec::new();
    output
        .take(65_536)
        .read_to_end(&mut bytes)
        .map_err(|error| UpdateError::io("command output", error))?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if !status.success() {
        return Err(invalid(format!(
            "app verification failed ({status}): {text}"
        )));
    }
    Ok(text)
}

fn plist(app: &Path, key: &str) -> UpdateResult<String> {
    run(
        Command::new("/usr/bin/plutil")
            .args(["-extract", key, "raw", "-o", "-"])
            .arg(app.join("Contents/Info.plist")),
        Duration::from_secs(10),
    )
    .map(|value| value.trim().to_string())
}

fn verify_signature(app: &Path) -> UpdateResult<String> {
    if !fs::symlink_metadata(app)
        .map_err(|error| io(app, error))?
        .file_type()
        .is_dir()
    {
        return Err(invalid("application must be a real directory"));
    }
    run(
        Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(app),
        Duration::from_secs(30),
    )?;
    let identity = run(
        Command::new("/usr/bin/codesign")
            .args(["-d", "--verbose=4"])
            .arg(app),
        Duration::from_secs(10),
    )?;
    let team = identity
        .lines()
        .find_map(|line| line.strip_prefix("TeamIdentifier="))
        .filter(|team| team.len() == 10 && team.bytes().all(|c| c.is_ascii_alphanumeric()))
        .ok_or_else(|| invalid("app has no Developer ID team; reinstall the signed application"))?;
    if plist(app, "CFBundleIdentifier")? != "ai.opengeni.agent"
        || plist(app, "CFBundleExecutable")? != "opengeni-agent"
    {
        return Err(invalid("unexpected signed application identity"));
    }
    let executable = app.join(EXECUTABLE);
    if fs::canonicalize(&executable).map_err(|error| io(&executable, error))? != executable {
        return Err(invalid(
            "application executable must not resolve outside its fixed path",
        ));
    }
    Ok(team.to_string())
}

fn verify_candidate(app: &Path, team: &str, version: &str) -> UpdateResult<String> {
    if verify_signature(app)? != team {
        return Err(invalid("application signing team changed"));
    }
    if plist(app, "CFBundleVersion")? != version
        || plist(app, "CFBundleShortVersionString")? != version
    {
        return Err(invalid(
            "application version differs from signed update manifest",
        ));
    }
    let binary = app.join(EXECUTABLE);
    let output = run(
        Command::new(&binary).arg("--version"),
        Duration::from_secs(10),
    )?;
    if output.trim() != format!("opengeni-agent {version}") {
        return Err(invalid("application executable failed version preflight"));
    }
    let bytes = fs::read(&binary).map_err(|error| io(&binary, error))?;
    Ok(sha256_hex(&bytes))
}

fn exchange(installed: &Path, staged: &Path) -> UpdateResult<()> {
    // macOS renameatx_np(RENAME_SWAP): neither pathname ever disappears, and
    // failure leaves both directories intact. No two-rename crash gap.
    renameat_with(CWD, installed, CWD, staged, RenameFlags::EXCHANGE)
        .map_err(|error| io(installed, error.into()))
}

fn exchange_and_commit(
    installed: &Path,
    staged: &Path,
    commit: impl FnOnce() -> UpdateResult<String>,
) -> UpdateResult<String> {
    exchange(installed, staged)?;
    match commit() {
        Ok(hash) => Ok(hash),
        Err(error) => {
            // On rollback failure leave BOTH whole bundles for operator recovery.
            exchange(installed, staged).map_err(|rollback| {
                invalid(format!(
                    "{error}; whole-app rollback failed: {rollback}; retained at {}",
                    staged.display()
                ))
            })?;
            Err(UpdateError::AppRolledBack(error.to_string()))
        }
    }
}

pub(crate) fn apply(
    executable: &Path,
    verified_zip: &[u8],
    version: &str,
    commit: impl FnOnce(&str) -> UpdateResult<()>,
) -> UpdateResult<String> {
    let app = app_bundle_root(executable).ok_or_else(|| invalid("not an app-bundle install"))?;
    let app = fs::canonicalize(app).map_err(|error| io(app, error))?;
    let parent = app
        .parent()
        .ok_or_else(|| invalid("application has no parent"))?;
    let lock_path = parent.join(format!(
        ".{}.update.lock",
        app.file_name().unwrap().to_string_lossy()
    ));
    let lock = rustix::fs::open(
        &lock_path,
        rustix::fs::OFlags::CREATE | rustix::fs::OFlags::RDWR | rustix::fs::OFlags::NOFOLLOW,
        rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
    )
    .map_err(|error| io(&lock_path, error.into()))?;
    flock(&lock, FlockOperation::NonBlockingLockExclusive)
        .map_err(|_| invalid("another application update is already running"))?;
    let team = verify_signature(&app)?;
    let stage = tempfile::Builder::new()
        .prefix(".opengeni-app-update-")
        .tempdir_in(parent)
        .map_err(|error| io(parent, error))?;
    let zip = stage.path().join("verified.zip");
    let mut file = File::create(&zip).map_err(|error| io(&zip, error))?;
    file.write_all(verified_zip)
        .and_then(|()| file.sync_all())
        .map_err(|error| io(&zip, error))?;
    drop(file);
    // Only artifact bytes already authenticated by minisign + signed-manifest
    // SHA reach ditto. Its extraction preserves sealed resources and helpers.
    run(
        Command::new("/usr/bin/ditto")
            .args(["-x", "-k"])
            .arg(&zip)
            .arg(stage.path()),
        Duration::from_secs(120),
    )?;
    fs::remove_file(&zip).map_err(|error| io(&zip, error))?;
    let staged = stage.path().join("OpenGeni Agent.app");
    let expected_hash = verify_candidate(&staged, &team, version)?;
    // Stop RAII cleanup BEFORE exchange. A crash, panic or rollback failure
    // must retain the old complete app, not delete the only recovery copy.
    let recovery_dir = stage.keep();
    let result = exchange_and_commit(&app, &staged, || {
        let actual_hash = verify_candidate(&app, &team, version)?;
        if actual_hash != expected_hash {
            return Err(invalid("installed application changed during update"));
        }
        commit(&actual_hash)?;
        Ok(actual_hash)
    });
    // A confirmed rollback needs no second copy of the failed candidate.
    // Ambiguous failures retain recovery material; future attempts never prune it.
    if result.is_ok() || matches!(&result, Err(UpdateError::AppRolledBack(_))) {
        if let Err(error) = fs::remove_dir_all(&recovery_dir) {
            tracing::warn!(%error, path = %recovery_dir.display(), "app transaction settled; backup cleanup failed");
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn binary_update_cannot_modify_a_sealed_app() {
        let pending = crate::PendingUpdate {
            version: "1.0.0".into(),
            force: false,
            bytes: b"replacement".to_vec(),
        };
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("OpenGeni Agent.app").join(EXECUTABLE);
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(&executable, "original").unwrap();
        assert!(pending
            .apply_to(&executable)
            .unwrap_err()
            .to_string()
            .contains("complete signed app"));
        assert!(pending.apply_running_at(&executable).is_err());
        assert_eq!(fs::read_to_string(executable).unwrap(), "original");
    }

    #[test]
    fn failed_receipt_restores_entire_app_including_helpers() {
        let dir = tempfile::tempdir().unwrap();
        let installed = dir.path().join("Installed.app");
        let staged = dir.path().join("Staged.app");
        for (path, version) in [(&installed, "old"), (&staged, "new")] {
            fs::create_dir_all(path.join("Contents/Helpers")).unwrap();
            fs::write(path.join("Contents/Helpers/browser"), version).unwrap();
            fs::write(path.join("seal"), version).unwrap();
        }
        let result = exchange_and_commit(&installed, &staged, || {
            assert_eq!(fs::read_to_string(installed.join("seal")).unwrap(), "new");
            Err(invalid("receipt disk full"))
        });
        assert!(result.unwrap_err().to_string().contains("rolled back"));
        assert_eq!(fs::read_to_string(installed.join("seal")).unwrap(), "old");
        assert_eq!(
            fs::read_to_string(installed.join("Contents/Helpers/browser")).unwrap(),
            "old"
        );
        assert_eq!(fs::read_to_string(staged.join("seal")).unwrap(), "new");
    }

    #[test]
    fn invalid_bundle_is_rejected_before_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("OpenGeni Agent.app");
        fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        let executable = app.join(EXECUTABLE);
        fs::write(&executable, "original").unwrap();
        assert!(apply(&executable, b"invalid zip", "1.0.0", |_| panic!(
            "must not commit"
        ))
        .is_err());
        assert_eq!(fs::read_to_string(executable).unwrap(), "original");
    }

    #[test]
    #[ignore = "requires official signed ZIP and installed app; operates only on a disposable copy"]
    fn official_signed_app_roundtrip_and_rollback() {
        let source = PathBuf::from(std::env::var_os("OPENGENI_TEST_SIGNED_APP").unwrap());
        let zip = fs::read(std::env::var_os("OPENGENI_TEST_SIGNED_APP_ZIP").unwrap()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(dir.path()).unwrap();
        let app = dir.join("OpenGeni Agent.app");
        run(
            Command::new("/usr/bin/ditto").arg(&source).arg(&app),
            Duration::from_secs(120),
        )
        .unwrap();
        let version = plist(&source, "CFBundleVersion").unwrap();
        let before = verify_candidate(&app, &verify_signature(&app).unwrap(), &version).unwrap();
        let hash = apply(&app.join(EXECUTABLE), &zip, &version, |hash| {
            assert_eq!(hash, before);
            Ok(())
        })
        .unwrap();
        assert_eq!(hash, before);
        assert!(apply(&app.join(EXECUTABLE), &zip, "99.0.0", |_| panic!(
            "must not commit"
        ))
        .unwrap_err()
        .to_string()
        .contains("version differs"));
        assert!(
            apply(&app.join(EXECUTABLE), &zip, &version, |_| Err(invalid(
                "receipt failure"
            )))
            .unwrap_err()
            .to_string()
            .contains("rolled back")
        );
        assert_eq!(
            verify_candidate(&app, &verify_signature(&app).unwrap(), &version).unwrap(),
            before
        );
    }
}
