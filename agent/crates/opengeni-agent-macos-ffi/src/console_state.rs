//! Whether this login session's windows are on the Mac's screen.
//!
//! While the screen is locked, or another user's session is on it (fast user
//! switching), macOS still lists this session's windows, but nothing in them
//! can be read or clicked: Accessibility answers with placeholder windows and
//! input never reaches them. The session's own CoreGraphics dictionary is not
//! enough to tell: after a switch to another user it can still report this
//! session on the console and unlocked. The console device's owner and the
//! IORegistry's `IOConsoleLocked` say what is actually on screen.

/// What is on the Mac's screen, as far as this login session is concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacConsoleState {
    /// This session is on screen and unlocked.
    Available,
    /// The screen is locked, or shows the login window.
    Locked,
    /// Another user's session is on screen.
    OtherUser,
}

/// The facts the console state is decided from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MacConsoleFacts {
    /// This session's `CGSSessionScreenIsLocked`.
    pub session_locked: bool,
    /// This session's `kCGSSessionOnConsoleKey`; true when absent.
    pub session_on_console: bool,
    /// The IORegistry root's `IOConsoleLocked`: the screen shows a lock or
    /// login window, whichever session it belongs to.
    pub console_locked: bool,
    /// Owner of `/dev/console`: the user whose session is on screen, or root
    /// at the login window. `None` when it cannot be read.
    pub console_owner: Option<u32>,
    /// This process's user.
    pub user: u32,
}

/// Decides what is on screen. Another user's session wins over a lock: what
/// a person must do then is switch back to this user.
#[must_use]
pub fn console_state(facts: &MacConsoleFacts) -> MacConsoleState {
    let other_owner = facts
        .console_owner
        .is_some_and(|owner| owner != facts.user && owner != 0);
    if other_owner || !facts.session_on_console {
        MacConsoleState::OtherUser
    } else if facts.session_locked || facts.console_locked || facts.console_owner == Some(0) {
        MacConsoleState::Locked
    } else {
        MacConsoleState::Available
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ON_SCREEN: MacConsoleFacts = MacConsoleFacts {
        session_locked: false,
        session_on_console: true,
        console_locked: false,
        console_owner: Some(501),
        user: 501,
    };

    #[test]
    fn this_session_on_screen_and_unlocked_is_available() {
        assert_eq!(console_state(&ON_SCREEN), MacConsoleState::Available);
        let unreadable_owner = MacConsoleFacts {
            console_owner: None,
            ..ON_SCREEN
        };
        assert_eq!(console_state(&unreadable_owner), MacConsoleState::Available);
    }

    #[test]
    fn a_locked_screen_or_the_login_window_is_locked() {
        for facts in [
            MacConsoleFacts {
                session_locked: true,
                ..ON_SCREEN
            },
            MacConsoleFacts {
                console_locked: true,
                ..ON_SCREEN
            },
            MacConsoleFacts {
                console_owner: Some(0),
                ..ON_SCREEN
            },
        ] {
            assert_eq!(console_state(&facts), MacConsoleState::Locked, "{facts:?}");
        }
    }

    #[test]
    fn another_users_session_on_screen_is_other_user_even_when_this_one_claims_the_console() {
        // After a switch to another user that then locked, this session's own
        // dictionary still says it is on the console and unlocked.
        let switched = MacConsoleFacts {
            console_locked: true,
            console_owner: Some(502),
            ..ON_SCREEN
        };
        assert_eq!(console_state(&switched), MacConsoleState::OtherUser);
        let off_console = MacConsoleFacts {
            session_on_console: false,
            ..ON_SCREEN
        };
        assert_eq!(console_state(&off_console), MacConsoleState::OtherUser);
    }
}
