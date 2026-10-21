//! One-shot macOS window commands for the CUA computer backend.
//!
//! CUA lists, reads and acts on windows, but it cannot say why a window is
//! not on screen, nor bring a minimized window or a hidden app's window back
//! without activating its app. `computer-native window presence` and
//! `computer-native window restore` do that natively: JSON in on stdin, JSON
//! out on stdout.

use serde::{Deserialize, Serialize};

/// A window as CUA lists it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowQuery {
    /// Owning process.
    pub process_id: u32,
    /// Listed title; may be empty.
    #[serde(default)]
    pub title: String,
    /// Listed bounds in global points.
    pub bounds: WindowBounds,
}

/// Window bounds in global points.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowBounds {
    /// Left edge.
    pub x: f64,
    /// Top edge.
    pub y: f64,
    /// Width.
    pub width: f64,
    /// Height.
    pub height: f64,
}

/// Why a window on the current Space is not on screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowPresence {
    /// Minimized to the Dock.
    Minimized,
    /// Its application is hidden.
    ApplicationHidden,
    /// Its application never shows it.
    NotShown,
    /// Not known.
    Unknown,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PresenceRequest {
    windows: Vec<WindowQuery>,
}

#[derive(Serialize)]
struct PresenceResponse {
    presences: Vec<WindowPresence>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreRequest {
    window: WindowQuery,
}

#[derive(Serialize)]
struct RestoreResponse {
    presence: WindowPresence,
}

/// Answers one window command. `presence` and `restore` are the native
/// operations; a window whose presence cannot be read is `unknown`, while a
/// failed restore fails the command.
///
/// # Errors
///
/// Returns a message for an unknown command, invalid input, or a failed
/// restore.
pub fn answer_window_command(
    command: &str,
    input: &str,
    presence: impl Fn(&WindowQuery) -> Result<WindowPresence, String>,
    restore: impl Fn(&WindowQuery) -> Result<WindowPresence, String>,
) -> Result<String, String> {
    let invalid = |error: serde_json::Error| format!("invalid window {command} request: {error}");
    let output = match command {
        "presence" => {
            let request: PresenceRequest = serde_json::from_str(input).map_err(invalid)?;
            serde_json::to_string(&PresenceResponse {
                presences: request
                    .windows
                    .iter()
                    .map(|window| presence(window).unwrap_or(WindowPresence::Unknown))
                    .collect(),
            })
        }
        "restore" => {
            let request: RestoreRequest = serde_json::from_str(input).map_err(invalid)?;
            serde_json::to_string(&RestoreResponse {
                presence: restore(&request.window)?,
            })
        }
        other => return Err(format!("unknown window command: {other}")),
    };
    output.map_err(|error| format!("window {command} response failed: {error}"))
}

/// Runs one window command against this Mac's windows.
///
/// # Errors
///
/// See [`answer_window_command`]; every command fails off macOS.
pub fn run_window_command(command: &str, input: &str) -> Result<String, String> {
    answer_window_command(command, input, native::presence, native::restore)
}

#[cfg(target_os = "macos")]
mod native {
    use super::{WindowPresence, WindowQuery};
    use opengeni_agent_macos_ffi::{MacRect, MacWindowPresence, MacWindowQuery};

    fn query(window: &WindowQuery) -> MacWindowQuery {
        MacWindowQuery {
            process_id: window.process_id,
            title: window.title.clone(),
            bounds: MacRect {
                x: window.bounds.x,
                y: window.bounds.y,
                width: window.bounds.width,
                height: window.bounds.height,
            },
        }
    }

    fn presence_of(presence: MacWindowPresence) -> WindowPresence {
        match presence {
            MacWindowPresence::Minimized => WindowPresence::Minimized,
            MacWindowPresence::ApplicationHidden => WindowPresence::ApplicationHidden,
            MacWindowPresence::NotShown => WindowPresence::NotShown,
            MacWindowPresence::Unknown => WindowPresence::Unknown,
        }
    }

    pub(super) fn presence(window: &WindowQuery) -> Result<WindowPresence, String> {
        opengeni_agent_macos_ffi::window_presence(&query(window))
            .map(presence_of)
            .map_err(|error| error.to_string())
    }

    pub(super) fn restore(window: &WindowQuery) -> Result<WindowPresence, String> {
        opengeni_agent_macos_ffi::restore_window_behind(&query(window))
            .map(presence_of)
            .map_err(|error| error.to_string())
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    use super::{WindowPresence, WindowQuery};

    #[allow(clippy::unnecessary_wraps)] // Matches the macOS signature.
    pub(super) fn presence(_window: &WindowQuery) -> Result<WindowPresence, String> {
        Err("window presence is available only on macOS".to_string())
    }

    #[allow(clippy::unnecessary_wraps)] // Matches the macOS signature.
    pub(super) fn restore(_window: &WindowQuery) -> Result<WindowPresence, String> {
        Err("window restore is available only on macOS".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTES: &str =
        r#"{"processId":42,"title":"Notes","bounds":{"x":213,"y":77,"width":656,"height":422}}"#;

    #[test]
    fn presence_reads_each_window_and_an_unreadable_one_is_unknown() {
        let input = format!(
            r#"{{"windows":[{NOTES},{{"processId":7,"bounds":{{"x":0,"y":0,"width":1,"height":1}}}}]}}"#
        );
        let output = answer_window_command(
            "presence",
            &input,
            |window| {
                if window.process_id == 42 {
                    assert_eq!(window.title, "Notes");
                    Ok(WindowPresence::Minimized)
                } else {
                    Err("gone".to_string())
                }
            },
            |_| unreachable!(),
        )
        .unwrap();
        assert_eq!(output, r#"{"presences":["minimized","unknown"]}"#);
    }

    #[test]
    fn restore_reports_what_the_window_was_and_fails_when_restore_fails() {
        let input = format!(r#"{{"window":{NOTES}}}"#);
        let output = answer_window_command(
            "restore",
            &input,
            |_| unreachable!(),
            |_| Ok(WindowPresence::ApplicationHidden),
        )
        .unwrap();
        assert_eq!(output, r#"{"presence":"application_hidden"}"#);
        let failed = answer_window_command(
            "restore",
            &input,
            |_| unreachable!(),
            |_| Err("not settable".to_string()),
        );
        assert_eq!(failed, Err("not settable".to_string()));
    }

    #[test]
    fn unknown_commands_and_fields_are_refused() {
        let ignore = |_: &WindowQuery| Ok(WindowPresence::Unknown);
        assert!(answer_window_command("focus", "{}", ignore, ignore).is_err());
        assert!(
            answer_window_command("presence", r#"{"windows":[],"x":1}"#, ignore, ignore).is_err()
        );
    }
}
