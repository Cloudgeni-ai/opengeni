//! Whether this login session's windows are on the Mac's screen.
//!
//! While the screen is locked, or another user's session is on it (fast user
//! switching), macOS still lists this session's windows, but nothing in them
//! can be read or clicked: Accessibility answers with placeholder windows and
//! input never reaches them. The session's own CoreGraphics dictionary is not
//! enough to tell: after a switch to another user it can still report this
//! session on the console and unlocked. The IORegistry root says what is
//! actually on screen: `IOConsoleUsers` lists every logged-in session and
//! marks the one on the console, and `IOConsoleLocked` says whether the screen
//! shows a lock or login window. The console device's owner is only a
//! fallback: it is the user who last logged in at the console, so a second
//! user logged in in the background can own it while this session is on
//! screen.

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

/// Whose session the IORegistry's `IOConsoleUsers` marks as on the console.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacConsoleSession {
    /// This user's session; `locked` is that entry's `CGSSessionScreenIsLocked`.
    ThisUser { locked: bool },
    /// Another user's session.
    OtherUser,
    /// No session: the login window.
    Nobody,
}

/// One entry of `IOConsoleUsers`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MacConsoleUser {
    /// `kCGSSessionUserIDKey`.
    pub user: u32,
    /// `kCGSSessionOnConsoleKey`.
    pub on_console: bool,
    /// `CGSSessionScreenIsLocked`; false when absent.
    pub screen_locked: bool,
}

/// Whose session `users` (the entries of `IOConsoleUsers`) marks as on the
/// console, as seen by `user`. Sessions logged in in the background are listed
/// too, off the console, and do not count.
#[must_use]
pub fn console_session(users: &[MacConsoleUser], user: u32) -> MacConsoleSession {
    let mut on_console = users.iter().filter(|entry| entry.on_console);
    if let Some(this) = on_console.clone().find(|entry| entry.user == user) {
        MacConsoleSession::ThisUser {
            locked: this.screen_locked,
        }
    } else if on_console.next().is_some() {
        MacConsoleSession::OtherUser
    } else {
        MacConsoleSession::Nobody
    }
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
    /// Whose session `IOConsoleUsers` marks as on the console; `None` when it
    /// cannot be read.
    pub console_session: Option<MacConsoleSession>,
    /// Owner of `/dev/console`: the user who last logged in at the console,
    /// or root at the login window. `None` when it cannot be read. Used only
    /// when `IOConsoleUsers` cannot be read.
    pub console_owner: Option<u32>,
    /// This process's user.
    pub user: u32,
}

/// Decides what is on screen. Another user's session wins over a lock: what
/// a person must do then is switch back to this user.
///
/// Known limitation: a Screen Sharing session that logs in as a different
/// user than the one at the physical screen gets its own virtual display and
/// can be usable, but it is off the console like a switched-away session, so
/// it is reported as `OtherUser`. No cheap signal that tells the two apart
/// has been verified.
#[must_use]
pub fn console_state(facts: &MacConsoleFacts) -> MacConsoleState {
    let locked = |entry_locked: bool| {
        if entry_locked || facts.session_locked || facts.console_locked {
            MacConsoleState::Locked
        } else {
            MacConsoleState::Available
        }
    };
    match facts.console_session {
        Some(MacConsoleSession::ThisUser {
            locked: entry_locked,
        }) => return locked(entry_locked),
        Some(MacConsoleSession::OtherUser) => return MacConsoleState::OtherUser,
        Some(MacConsoleSession::Nobody) => return MacConsoleState::Locked,
        None => {}
    }
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
        console_session: None,
        console_owner: Some(501),
        user: 501,
    };

    const fn entry(user: u32, on_console: bool) -> MacConsoleUser {
        MacConsoleUser {
            user,
            on_console,
            screen_locked: false,
        }
    }

    /// This session on screen as `IOConsoleUsers` lists it, with a second
    /// user logged in in the background who owns `/dev/console`.
    fn with_background_user() -> MacConsoleFacts {
        MacConsoleFacts {
            console_session: Some(console_session(&[entry(502, false), entry(501, true)], 501)),
            console_owner: Some(502),
            ..ON_SCREEN
        }
    }

    #[test]
    fn a_user_logged_in_in_the_background_does_not_take_the_screen() {
        assert_eq!(
            console_state(&with_background_user()),
            MacConsoleState::Available
        );
        // Neither does this session's own dictionary, which can lag.
        let lagging = MacConsoleFacts {
            session_on_console: false,
            ..with_background_user()
        };
        assert_eq!(console_state(&lagging), MacConsoleState::Available);
    }

    #[test]
    fn the_registry_decides_whose_session_is_on_screen() {
        // Another user's session on the console, whoever owns the device and
        // whatever this session's own dictionary says.
        for owner in [Some(501), Some(502), Some(0), None] {
            let switched = MacConsoleFacts {
                console_session: Some(console_session(&[entry(501, false), entry(502, true)], 501)),
                console_owner: owner,
                ..ON_SCREEN
            };
            assert_eq!(
                console_state(&switched),
                MacConsoleState::OtherUser,
                "{owner:?}"
            );
        }
        // No session on the console: the login window.
        for users in [&[entry(501, false), entry(502, false)][..], &[][..]] {
            let login_window = MacConsoleFacts {
                console_session: Some(console_session(users, 501)),
                ..ON_SCREEN
            };
            assert_eq!(console_state(&login_window), MacConsoleState::Locked);
        }
    }

    #[test]
    fn this_session_on_the_console_but_locked_is_locked() {
        let locked_entry = MacConsoleFacts {
            console_session: Some(console_session(
                &[
                    entry(502, false),
                    MacConsoleUser {
                        screen_locked: true,
                        ..entry(501, true)
                    },
                ],
                501,
            )),
            ..with_background_user()
        };
        for facts in [
            locked_entry,
            MacConsoleFacts {
                console_locked: true,
                ..with_background_user()
            },
            MacConsoleFacts {
                session_locked: true,
                ..with_background_user()
            },
        ] {
            assert_eq!(console_state(&facts), MacConsoleState::Locked, "{facts:?}");
        }
    }

    #[test]
    fn without_the_registry_the_console_owner_decides_as_before() {
        let fallback = MacConsoleFacts {
            console_session: None,
            ..with_background_user()
        };
        assert_eq!(console_state(&fallback), MacConsoleState::OtherUser);
        let own = MacConsoleFacts {
            console_session: None,
            ..ON_SCREEN
        };
        assert_eq!(console_state(&own), MacConsoleState::Available);
    }

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
