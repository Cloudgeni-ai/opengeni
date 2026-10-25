//! A real X server whose cookie changes and which goes away and comes back,
//! the way a display manager's login looks to an agent that started first.
//!
//! Runs against a private `Xvfb` (from `$OPENGENI_XVFB`, else `Xvfb` on
//! `PATH`) and is skipped, saying so, when there is none.

#[cfg(target_os = "linux")]
mod linux {
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    use opengeni_agent_platform::{
        DesktopBackend as _, LinuxDesktop, ReopeningDesktop, X11Display,
    };

    fn xvfb() -> Option<PathBuf> {
        if let Some(path) = std::env::var_os("OPENGENI_XVFB") {
            return Some(PathBuf::from(path));
        }
        std::env::var_os("PATH").and_then(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join("Xvfb"))
                .find(|candidate| candidate.is_file())
        })
    }

    /// An authority file with one cookie for every display.
    fn write_authority(path: &Path, cookie: &[u8; 16]) {
        let mut bytes = 0xffff_u16.to_be_bytes().to_vec(); // FamilyWild
        for field in [&b""[..], b"", b"MIT-MAGIC-COOKIE-1", cookie] {
            bytes.extend(u16::try_from(field.len()).unwrap().to_be_bytes());
            bytes.extend(field);
        }
        std::fs::write(path, bytes).unwrap();
    }

    struct Server {
        child: Child,
    }

    impl Server {
        fn start(binary: &Path, number: u32, authority: &Path) -> Self {
            let child = Command::new(binary)
                .arg(format!(":{number}"))
                .args(["-auth"])
                .arg(authority)
                .args(["-nolisten", "tcp", "-screen", "0", "640x480x24"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("start Xvfb");
            let socket = PathBuf::from(format!("/tmp/.X11-unix/X{number}"));
            let deadline = Instant::now() + Duration::from_secs(10);
            while !socket.exists() {
                assert!(Instant::now() < deadline, "Xvfb did not start");
                std::thread::sleep(Duration::from_millis(50));
            }
            // The socket appears just before the server takes connections.
            std::thread::sleep(Duration::from_millis(200));
            Self { child }
        }

        fn stop(mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[test]
    fn a_desktop_follows_its_cookie_and_its_server() {
        let Some(binary) = xvfb() else {
            eprintln!("SKIP: no Xvfb (set OPENGENI_XVFB or put Xvfb on PATH)");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let number = 300 + std::process::id() % 600;
        let server_authority = dir.path().join("server.auth");
        let client_authority = dir.path().join("client.auth");
        write_authority(&server_authority, b"0123456789abcdef");
        // The agent's authority file still holds the previous login's cookie.
        write_authority(&client_authority, b"stale-cookie-000");
        let server = Server::start(&binary, number, &server_authority);
        let display = X11Display {
            name: format!(":{number}"),
            authority: Some(client_authority.clone()),
        };
        let desktop = ReopeningDesktop::new({
            let display = display.clone();
            move || LinuxDesktop::open_display(display.clone())
        });
        assert!(desktop.probe().is_none());
        let reason = desktop.capture_blocked_reason().unwrap_or_default();
        assert!(reason.contains("MIT-MAGIC-COOKIE-1"), "{reason}");

        // The login writes the session's cookie; the next check opens the desktop.
        write_authority(&client_authority, b"0123456789abcdef");
        std::thread::sleep(Duration::from_millis(1_100));
        let probed = desktop.probe().expect("desktop after the new cookie");
        assert_eq!(probed.id, display.name);
        assert_eq!((probed.width, probed.height), (640, 480));
        assert_eq!(desktop.capture_blocked_reason(), None);

        // The server goes away (sign-out): no desktop, with the reason.
        server.stop();
        assert!(desktop.probe().is_none());
        assert!(desktop.capture_blocked_reason().is_some());

        // A new login starts it again with a new cookie in the same file.
        write_authority(&server_authority, b"fedcba9876543210");
        write_authority(&client_authority, b"fedcba9876543210");
        let _server = Server::start(&binary, number, &server_authority);
        std::thread::sleep(Duration::from_millis(1_100));
        assert!(desktop.probe().is_some());
        assert_eq!(desktop.capture_blocked_reason(), None);
    }
}
