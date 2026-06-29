//! Opt-in virtual desktop (Xvfb) for headless Linux boxes.
//!
//! A headless Linux machine has no `$DISPLAY`, so [`resolve_desktop`] reports
//! `display_unavailable` (dossier §3: Xvfb is off by default but trivially easy to
//! enable). When the user runs the agent with `--virtual-desktop`, [`VirtualXvfb`]
//! spawns an `Xvfb` server on a free display number and sets `$DISPLAY` so the
//! Linux X11 backend ([`crate::linux::LinuxDesktop`]) then captures + drives it
//! exactly as it would a real screen.
//!
//! The Xvfb child is owned by [`VirtualXvfb`]; dropping it kills the server (a
//! clean agent stop tears down the virtual display). This is Linux-only — on
//! macOS/Windows a "virtual desktop" is not the model (the user's real GUI session
//! is the desktop), so the type is cfg-gated to Linux.
//!
//! [`resolve_desktop`]: crate::desktop::resolve_desktop

use crate::error::{PlatformError, PlatformResult};

/// A spawned Xvfb virtual framebuffer. Holds the child process; dropping it kills
/// the server. The chosen `$DISPLAY` is published into the process environment so
/// the X11 desktop backend connects to it.
#[derive(Debug)]
pub struct VirtualXvfb {
    display: String,
    child: std::process::Child,
}

impl VirtualXvfb {
    /// Spawns an Xvfb server at `display` (e.g. `":99"`) with the given geometry
    /// and 24-bit depth, then exports `$DISPLAY` so subsequent X11 connections
    /// target it. Reclaims stale lock/socket remnants of a previously killed
    /// server, then waits for the new server to actually accept connections
    /// before returning.
    ///
    /// # Errors
    ///
    /// Returns [`PlatformError::Unsupported`] if `Xvfb` is not installed, or
    /// [`PlatformError::Os`] if it cannot be spawned or never becomes ready.
    pub fn spawn(display: &str, width: u32, height: u32) -> PlatformResult<Self> {
        // A prior Xvfb that was SIGKILL'd (no clean Drop) leaves BOTH a stale lock
        // (`/tmp/.XN-lock`) and a stale socket file (`/tmp/.X11-unix/XN`) behind.
        // Clear those remnants up front so this Xvfb can bind its socket, and so the
        // readiness wait below cannot be fooled by a leftover socket file.
        let num = display.trim_start_matches(':').split('.').next();
        if let Some(num) = num {
            reclaim_stale_display(num);
        }

        let geometry = format!("{width}x{height}x24");
        let mut child = std::process::Command::new("Xvfb")
            .arg(display)
            .arg("-screen")
            .arg("0")
            .arg(&geometry)
            .arg("-nolisten")
            .arg("tcp")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    PlatformError::Unsupported(
                        "Xvfb is not installed; install it to use --virtual-desktop".to_string(),
                    )
                } else {
                    PlatformError::os(format!("spawn Xvfb: {e}"))
                }
            })?;

        // Wait until the server is actually accepting connections (or dies trying).
        // A leftover socket FILE existing is not proof the server is listening, so we
        // probe with a real connect rather than a path check. If readiness never
        // arrives, kill + reap the child so we leave no orphan and report honestly.
        if let Err(e) = wait_for_x_ready(num, &mut child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }

        // Only publish DISPLAY once the server is confirmed ready, so the X11 backend
        // and any child processes (terminal, GUI apps) never point at a dead display.
        std::env::set_var("DISPLAY", display);

        Ok(Self {
            display: display.to_string(),
            child,
        })
    }

    /// The `$DISPLAY` value this virtual server listens on.
    #[must_use]
    pub fn display(&self) -> &str {
        &self.display
    }
}

impl Drop for VirtualXvfb {
    fn drop(&mut self) {
        // Best-effort teardown: kill the server and reap it so a clean agent stop
        // leaves no orphan Xvfb.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Removes stale lock + socket remnants of a previously killed Xvfb on display
/// `num` (the bare number, e.g. `"99"`), but only when no real server is listening.
///
/// When an Xvfb is `kill -9`'d it never runs its clean teardown, so it leaves both
/// `/tmp/.XN-lock` and `/tmp/.X11-unix/XN` behind. On the next start Xvfb refuses to
/// boot ("Server is already active for display N … remove /tmp/.XN-lock"), and a
/// path-only readiness check would also be fooled by the leftover socket file. We
/// distinguish "stale remnant" from "live server" by attempting a connect: a live
/// server accepts it (so we leave everything untouched — never clobber a running
/// display), whereas a stale socket refuses the connection, marking it safe to clear.
fn reclaim_stale_display(num: &str) {
    let socket = format!("/tmp/.X11-unix/X{num}");
    let lock = format!("/tmp/.X{num}-lock");

    // Nothing left behind → nothing to reclaim.
    if !std::path::Path::new(&socket).exists() && !std::path::Path::new(&lock).exists() {
        return;
    }

    // A successful connect means a REAL X server is already listening here — leave it
    // alone (removing its lock/socket would corrupt a running display).
    if std::os::unix::net::UnixStream::connect(&socket).is_ok() {
        return;
    }

    // No listener but the files exist → stale remnants of a killed server. Remove both
    // (best-effort) so the freshly spawned Xvfb can claim the display.
    let _ = std::fs::remove_file(&lock);
    let _ = std::fs::remove_file(&socket);
}

/// Waits up to ~4s for the Xvfb server on display `num` to actually accept a unix
/// connection, so a capture issued right after spawn does not race startup. Unlike a
/// path-existence check, a real connect cannot be fooled by a leftover socket file.
///
/// Also watches the spawned `child`: if Xvfb exits during startup (e.g. it could not
/// claim the display), we surface that immediately rather than waiting out the full
/// timeout.
///
/// # Errors
///
/// Returns [`PlatformError::Os`] if the child exits during startup or the server
/// never becomes connectable within the timeout.
fn wait_for_x_ready(num: Option<&str>, child: &mut std::process::Child) -> PlatformResult<()> {
    // Without a parseable display number we cannot probe the socket; treat the server
    // as ready and let the first real connection surface any problem.
    let Some(num) = num else {
        return Ok(());
    };
    let socket = format!("/tmp/.X11-unix/X{num}");
    for _ in 0..80 {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(PlatformError::os(format!(
                "Xvfb exited during startup: {status}"
            )));
        }
        if std::os::unix::net::UnixStream::connect(&socket).is_ok() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Err(PlatformError::os("Xvfb did not become ready within 4s"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_xvfb_is_unsupported_not_panic() {
        // Force a PATH with no Xvfb so the spawn reports a clean Unsupported rather
        // than panicking. (On a host that happens to have Xvfb on an absolute path
        // this still exercises the NotFound mapping for the bare-name lookup.)
        let saved = std::env::var_os("PATH");
        std::env::set_var("PATH", "/nonexistent-bin-dir-for-test");
        let result = VirtualXvfb::spawn(":99123", 640, 480);
        if let Some(path) = saved {
            std::env::set_var("PATH", path);
        }
        match result {
            Err(PlatformError::Unsupported(_)) => {}
            // If a host has Xvfb reachable regardless of PATH, just ensure no panic.
            Ok(v) => drop(v),
            other => panic!("expected Unsupported or Ok, got {other:?}"),
        }
    }

    #[test]
    fn reclaim_removes_stale_lock_and_socket() {
        // Use a high display number unlikely to collide with any real server. The
        // socket path gets a plain dummy file (NOT a live listener), so the connect
        // probe in `reclaim_stale_display` fails and the remnants are deemed stale.
        let num = "991";
        let socket = format!("/tmp/.X11-unix/X{num}");
        let lock = format!("/tmp/.X{num}-lock");

        std::fs::create_dir_all("/tmp/.X11-unix").expect("create /tmp/.X11-unix");
        std::fs::write(&lock, b"12345\n").expect("write stale lock");
        std::fs::write(&socket, b"not-a-real-socket").expect("write stale socket file");

        assert!(std::path::Path::new(&lock).exists());
        assert!(std::path::Path::new(&socket).exists());

        reclaim_stale_display(num);

        let lock_gone = !std::path::Path::new(&lock).exists();
        let socket_gone = !std::path::Path::new(&socket).exists();

        // Best-effort cleanup in case the assertions below fail.
        let _ = std::fs::remove_file(&lock);
        let _ = std::fs::remove_file(&socket);

        assert!(lock_gone, "stale lock with no live server should be removed");
        assert!(
            socket_gone,
            "stale socket file with no live server should be removed"
        );
    }
}
