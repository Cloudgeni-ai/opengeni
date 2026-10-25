//! Which apps are using a microphone right now, for the desktop app's call
//! detection: when a call app (Zoom, Teams, Slack, a browser) starts using
//! the microphone, the app offers to record the meeting.
//!
//! `--watch-microphone` runs this instead of a capture. It checks once a
//! second and writes one JSON object per line to stdout whenever the set of
//! apps changes (and once at the start):
//!
//! - `{"event":"microphone","users":[{"pid":812,"name":"zoom.us","path":"/Applications/zoom.us.app/Contents/MacOS/zoom.us","bundleId":"us.zoom.xos","owners":[]}]}`
//! - `{"event":"error","code":"sound_server_unavailable","message":"..."}`, once
//!   for each new failure; it keeps checking.
//!
//! `owners` lists the apps a user belongs to, nearest first: on macOS the app
//! responsible for it (Safari for its WebKit audio process), on Windows and
//! Linux its parent processes (Teams for the WebView2 process that holds its
//! microphone). The app decides which of them is a call app. It reads nothing
//! that is recorded and needs no permission. It stops when stdin closes.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

use std::io::{Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::CaptureError;
use crate::output::json_string;

const POLL: Duration = Duration::from_secs(1);
/// Enough to reach the app above a browser's or WebView's helper processes.
pub const MAX_OWNERS: usize = 4;

/// One process using a microphone.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct MicrophoneUser {
    pub pid: u32,
    /// The executable's file name, or the name the app gave its audio stream.
    pub name: String,
    pub path: Option<String>,
    /// macOS only.
    pub bundle_id: Option<String>,
    /// Executable paths of the apps it belongs to, nearest first.
    pub owners: Vec<String>,
}

/// The processes using a microphone now.
pub fn users() -> Result<Vec<MicrophoneUser>, CaptureError> {
    #[cfg(target_os = "macos")]
    return macos::users();
    #[cfg(target_os = "windows")]
    return windows::users();
    #[cfg(target_os = "linux")]
    return linux::users();
    #[allow(unreachable_code)]
    Err(CaptureError::new(
        "unsupported",
        "Microphone use can't be read on this platform.",
    ))
}

/// The last path component, on either separator.
pub fn file_name(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

fn optional(value: &Option<String>) -> String {
    value
        .as_deref()
        .map(json_string)
        .unwrap_or_else(|| "null".into())
}

pub fn render(users: &[MicrophoneUser]) -> String {
    let list: Vec<String> = users
        .iter()
        .map(|user| {
            let owners: Vec<String> = user.owners.iter().map(|owner| json_string(owner)).collect();
            format!(
                "{{\"pid\":{},\"name\":{},\"path\":{},\"bundleId\":{},\"owners\":[{}]}}",
                user.pid,
                json_string(&user.name),
                optional(&user.path),
                optional(&user.bundle_id),
                owners.join(",")
            )
        })
        .collect();
    format!("{{\"event\":\"microphone\",\"users\":[{}]}}", list.join(","))
}

fn line(text: &str) -> bool {
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{text}").is_ok() && stdout.flush().is_ok()
}

/// Report microphone use until stdin closes or stdout breaks.
pub fn watch() -> std::process::ExitCode {
    let stopping = Arc::new(AtomicBool::new(false));
    {
        let stopping = stopping.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 64];
            let mut stdin = std::io::stdin();
            loop {
                match stdin.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            stopping.store(true, Ordering::Relaxed);
        });
    }
    let own_pid = std::process::id();
    let mut last: Option<Vec<MicrophoneUser>> = None;
    let mut last_error: Option<&'static str> = None;
    while !stopping.load(Ordering::Relaxed) {
        match users() {
            Ok(mut now) => {
                last_error = None;
                now.retain(|user| user.pid != own_pid);
                now.sort();
                now.dedup();
                if last.as_ref() != Some(&now) {
                    if !line(&render(&now)) {
                        break;
                    }
                    last = Some(now);
                }
            }
            Err(error) => {
                if last_error != Some(error.code) {
                    last_error = Some(error.code);
                    let text = format!(
                        "{{\"event\":\"error\",\"code\":{},\"message\":{}}}",
                        json_string(error.code),
                        json_string(&error.message)
                    );
                    if !line(&text) {
                        break;
                    }
                }
                // Report "nobody" after a failure, so a stale list doesn't linger.
                if last.as_ref().is_some_and(|users| !users.is_empty()) {
                    if !line(&render(&[])) {
                        break;
                    }
                    last = Some(Vec::new());
                }
            }
        }
        std::thread::sleep(POLL);
    }
    std::process::ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_users() {
        let users = vec![MicrophoneUser {
            pid: 7,
            name: "Teams \"new\"".into(),
            path: Some("C:\\Program Files\\msedgewebview2.exe".into()),
            bundle_id: None,
            owners: vec!["C:\\Apps\\ms-teams.exe".into()],
        }];
        assert_eq!(
            render(&users),
            "{\"event\":\"microphone\",\"users\":[{\"pid\":7,\"name\":\"Teams \\\"new\\\"\",\"path\":\"C:\\\\Program Files\\\\msedgewebview2.exe\",\"bundleId\":null,\"owners\":[\"C:\\\\Apps\\\\ms-teams.exe\"]}]}"
        );
        assert_eq!(render(&[]), "{\"event\":\"microphone\",\"users\":[]}");
    }

    #[test]
    fn file_names() {
        assert_eq!(file_name("/usr/bin/zoom"), "zoom");
        assert_eq!(file_name("C:\\Apps\\Zoom.exe"), "Zoom.exe");
        assert_eq!(file_name("slack"), "slack");
    }
}
