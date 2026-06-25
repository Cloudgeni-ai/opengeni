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
    /// target it. Waits briefly for the server socket to appear.
    ///
    /// # Errors
    ///
    /// Returns [`PlatformError::Unsupported`] if `Xvfb` is not installed, or
    /// [`PlatformError::Os`] if it cannot be spawned.
    pub fn spawn(display: &str, width: u32, height: u32) -> PlatformResult<Self> {
        let geometry = format!("{width}x{height}x24");
        let child = std::process::Command::new("Xvfb")
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

        // Export DISPLAY for the X11 backend and any child processes (the terminal,
        // GUI apps the agent launches). Wait briefly for the X socket to appear so a
        // capture issued immediately after spawn does not race the server's startup.
        std::env::set_var("DISPLAY", display);
        wait_for_x_socket(display);

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

/// Waits up to ~2s for the X11 unix socket of `display` to exist, so a capture
/// issued right after spawn does not race Xvfb's startup. A miss is non-fatal (the
/// first capture simply retries the connection).
fn wait_for_x_socket(display: &str) {
    let Some(num) = display.trim_start_matches(':').split('.').next() else {
        return;
    };
    let socket = format!("/tmp/.X11-unix/X{num}");
    for _ in 0..40 {
        if std::path::Path::new(&socket).exists() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
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
}
