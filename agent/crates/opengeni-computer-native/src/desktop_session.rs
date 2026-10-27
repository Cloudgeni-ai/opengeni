//! `desktop-session`: the person's desktop for a controller that has none.
//!
//! A per-user agent service can start before anyone signs in, so neither it
//! nor the controller it starts inherits `DISPLAY` or `XAUTHORITY`. The
//! controller asks this helper, which finds the session the same way the
//! agent does, before it opens a ComputerSession on the machine's screen.

use serde_json::{json, Value};

/// The answer for one lookup: `{"display", "xauthority"}` for a desktop that
/// accepted a connection, or `{"unavailable": reason}` in plain words.
#[must_use]
pub fn desktop_session_answer(found: Result<(String, Option<String>), String>) -> Value {
    match found {
        Ok((display, xauthority)) => json!({ "display": display, "xauthority": xauthority }),
        Err(reason) => json!({ "unavailable": reason }),
    }
}

/// Looks up the desktop of the user this helper runs as and answers in JSON.
#[must_use]
pub fn run_desktop_session_command() -> String {
    #[cfg(target_os = "linux")]
    let found = opengeni_agent_platform::LinuxDesktop::find_default_display().map(|display| {
        (
            display.name,
            display
                .authority
                .map(|path| path.to_string_lossy().into_owned()),
        )
    });
    #[cfg(not(target_os = "linux"))]
    let found = Err("desktop-session is only used on Linux".to_string());
    desktop_session_answer(found).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_with_the_display_or_the_plain_reason() {
        assert_eq!(
            desktop_session_answer(Ok((":0".into(), Some("/home/user/.Xauthority".into())))),
            json!({ "display": ":0", "xauthority": "/home/user/.Xauthority" })
        );
        assert_eq!(
            desktop_session_answer(Ok((":1".into(), None))),
            json!({ "display": ":1", "xauthority": null })
        );
        assert_eq!(
            desktop_session_answer(Err("No one is signed in.".into())),
            json!({ "unavailable": "No one is signed in." })
        );
    }
}
