//! One-shot macOS window commands for the CUA computer backend.
//!
//! CUA lists, reads and acts on windows, but it cannot say why a window is
//! not on screen, nor bring a minimized window or a hidden app's window back
//! without activating its app. `computer-native window presence` and
//! `computer-native window restore` do that natively: JSON in on stdin, JSON
//! out on stdout. `computer-native window console` says whether this login
//! session's windows are on the screen at all: not while it is locked or
//! another user's session is on it.

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

/// Whether this login session's windows are on the Mac's screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsoleState {
    /// On screen and unlocked.
    Available,
    /// The screen is locked, or shows the login window.
    Locked,
    /// Another user's session is on screen.
    OtherUser,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConsoleRequest {}

#[derive(Serialize)]
struct ConsoleResponse {
    console: ConsoleState,
}

/// The native operations a window command runs.
pub struct WindowNative<P, R, C> {
    /// Why a window is not on screen.
    pub presence: P,
    /// Brings a window back on screen; returns what it was.
    pub restore: R,
    /// What is on the Mac's screen.
    pub console: C,
}

/// Answers one window command. A window whose presence cannot be read is
/// `unknown`, while a failed restore or console read fails the command.
///
/// # Errors
///
/// Returns a message for an unknown command, invalid input, or a failed
/// restore or console read.
pub fn answer_window_command<P, R, C>(
    command: &str,
    input: &str,
    native: &WindowNative<P, R, C>,
) -> Result<String, String>
where
    P: Fn(&WindowQuery) -> Result<WindowPresence, String>,
    R: Fn(&WindowQuery) -> Result<WindowPresence, String>,
    C: Fn() -> Result<ConsoleState, String>,
{
    let invalid = |error: serde_json::Error| format!("invalid window {command} request: {error}");
    let output = match command {
        "presence" => {
            let request: PresenceRequest = serde_json::from_str(input).map_err(invalid)?;
            serde_json::to_string(&PresenceResponse {
                presences: request
                    .windows
                    .iter()
                    .map(|window| (native.presence)(window).unwrap_or(WindowPresence::Unknown))
                    .collect(),
            })
        }
        "restore" => {
            let request: RestoreRequest = serde_json::from_str(input).map_err(invalid)?;
            serde_json::to_string(&RestoreResponse {
                presence: (native.restore)(&request.window)?,
            })
        }
        "console" => {
            let _: ConsoleRequest = serde_json::from_str(input).map_err(invalid)?;
            serde_json::to_string(&ConsoleResponse {
                console: (native.console)()?,
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
    answer_window_command(
        command,
        input,
        &WindowNative {
            presence: native::presence,
            restore: native::restore,
            console: native::console,
        },
    )
}

#[cfg(target_os = "macos")]
mod native {
    use super::{ConsoleState, WindowPresence, WindowQuery};
    use opengeni_agent_macos_ffi::{MacConsoleState, MacRect, MacWindowPresence, MacWindowQuery};

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

    pub(super) fn console() -> Result<ConsoleState, String> {
        opengeni_agent_macos_ffi::read_console_state()
            .map(|state| match state {
                MacConsoleState::Available => ConsoleState::Available,
                MacConsoleState::Locked => ConsoleState::Locked,
                MacConsoleState::OtherUser => ConsoleState::OtherUser,
            })
            .map_err(|error| error.to_string())
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    use super::{ConsoleState, WindowPresence, WindowQuery};

    #[allow(clippy::unnecessary_wraps)] // Matches the macOS signature.
    pub(super) fn presence(_window: &WindowQuery) -> Result<WindowPresence, String> {
        Err("window presence is available only on macOS".to_string())
    }

    #[allow(clippy::unnecessary_wraps)] // Matches the macOS signature.
    pub(super) fn restore(_window: &WindowQuery) -> Result<WindowPresence, String> {
        Err("window restore is available only on macOS".to_string())
    }

    #[allow(clippy::unnecessary_wraps)] // Matches the macOS signature.
    pub(super) fn console() -> Result<ConsoleState, String> {
        Err("window console is available only on macOS".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTES: &str =
        r#"{"processId":42,"title":"Notes","bounds":{"x":213,"y":77,"width":656,"height":422}}"#;

    type Answer = Result<WindowPresence, String>;
    type WindowFn = fn(&WindowQuery) -> Answer;
    type ConsoleFn = fn() -> Result<ConsoleState, String>;

    fn natives(
        presence: WindowFn,
        restore: WindowFn,
        console: ConsoleFn,
    ) -> WindowNative<WindowFn, WindowFn, ConsoleFn> {
        WindowNative {
            presence,
            restore,
            console,
        }
    }

    #[test]
    fn presence_reads_each_window_and_an_unreadable_one_is_unknown() {
        let input = format!(
            r#"{{"windows":[{NOTES},{{"processId":7,"bounds":{{"x":0,"y":0,"width":1,"height":1}}}}]}}"#
        );
        let output = answer_window_command(
            "presence",
            &input,
            &natives(
                |window| {
                    if window.process_id == 42 {
                        assert_eq!(window.title, "Notes");
                        Ok(WindowPresence::Minimized)
                    } else {
                        Err("gone".to_string())
                    }
                },
                |_| unreachable!(),
                || unreachable!(),
            ),
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
            &natives(
                |_| unreachable!(),
                |_| Ok(WindowPresence::ApplicationHidden),
                || unreachable!(),
            ),
        )
        .unwrap();
        assert_eq!(output, r#"{"presence":"application_hidden"}"#);
        let failed = answer_window_command(
            "restore",
            &input,
            &natives(
                |_| unreachable!(),
                |_| Err("not settable".to_string()),
                || unreachable!(),
            ),
        );
        assert_eq!(failed, Err("not settable".to_string()));
    }

    #[test]
    fn console_reports_what_is_on_screen_and_fails_when_it_cannot_be_read() {
        let unused = |_: &WindowQuery| -> Answer { unreachable!() };
        let output = answer_window_command(
            "console",
            "{}",
            &natives(unused, unused, || Ok(ConsoleState::OtherUser)),
        )
        .unwrap();
        assert_eq!(output, r#"{"console":"other_user"}"#);
        let failed = answer_window_command(
            "console",
            "{}",
            &natives(unused, unused, || Err("no session".to_string())),
        );
        assert_eq!(failed, Err("no session".to_string()));
    }

    #[test]
    fn unknown_commands_and_fields_are_refused() {
        let ignore = |_: &WindowQuery| Ok(WindowPresence::Unknown);
        let native = natives(ignore, ignore, || Ok(ConsoleState::Available));
        assert!(answer_window_command("focus", "{}", &native).is_err());
        assert!(answer_window_command("presence", r#"{"windows":[],"x":1}"#, &native).is_err());
        assert!(answer_window_command("console", r#"{"x":1}"#, &native).is_err());
    }
}
