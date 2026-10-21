//! Why a window on the current Space is not on screen, decided from what
//! Accessibility reports about its application's windows.
//!
//! The window server lists every window an app has, including ones the app
//! never shows (a closed popover kept for reuse, a panel shown only while its
//! app is active, a headless browser's window). Accessibility lists only the
//! windows a person can bring back: shown, minimized, or in a hidden app. The
//! decision is kept free of AppKit so it is testable on every platform.

use crate::MacRect;

/// A top-level window as the window server lists it, to find again through
/// Accessibility.
#[derive(Debug, Clone, PartialEq)]
pub struct MacWindowQuery {
    /// Owning process.
    pub process_id: u32,
    /// Window title as listed; may be empty.
    pub title: String,
    /// Window bounds in global points as listed.
    pub bounds: MacRect,
}

/// Why a window on the current Space is not on screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacWindowPresence {
    /// Minimized to the Dock; it can be restored without activating its app.
    Minimized,
    /// Its application is hidden; unhiding shows it without activating the app.
    ApplicationHidden,
    /// Its application shows no such window: the window server keeps it, but
    /// a person never sees it.
    NotShown,
    /// Accessibility cannot say (no permission, an unresponsive app, or more
    /// than one window that could be it).
    Unknown,
}

/// What Accessibility reports about one window of the queried process.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AxWindowFacts {
    pub(crate) bounds: Option<MacRect>,
    pub(crate) title: Option<String>,
    pub(crate) minimized: bool,
}

/// Classifies a window from its application's complete Accessibility window
/// list and returns the index of the matching Accessibility window, if any.
///
/// A window is matched by its bounds; equal bounds are told apart only by an
/// exact title, and a remaining tie is never guessed.
pub(crate) fn classify_window(
    query: &MacWindowQuery,
    windows: &[AxWindowFacts],
    application_hidden: bool,
) -> (MacWindowPresence, Option<usize>) {
    let same_place: Vec<usize> = windows
        .iter()
        .enumerate()
        .filter(|(_, window)| {
            window
                .bounds
                .is_some_and(|bounds| near(bounds, query.bounds))
        })
        .map(|(index, _)| index)
        .collect();
    let matched = match same_place.as_slice() {
        [] => return (MacWindowPresence::NotShown, None),
        [only] => *only,
        several => {
            let title = query.title.trim();
            let titled: Vec<usize> = several
                .iter()
                .copied()
                .filter(|index| {
                    !title.is_empty()
                        && windows[*index]
                            .title
                            .as_deref()
                            .is_some_and(|candidate| candidate.trim() == title)
                })
                .collect();
            match titled.as_slice() {
                [only] => *only,
                _ => return (MacWindowPresence::Unknown, None),
            }
        }
    };
    let presence = if windows[matched].minimized {
        MacWindowPresence::Minimized
    } else if application_hidden {
        MacWindowPresence::ApplicationHidden
    } else {
        MacWindowPresence::Unknown
    };
    (presence, Some(matched))
}

fn near(left: MacRect, right: MacRect) -> bool {
    const TOLERANCE: f64 = 2.0;
    (left.x - right.x).abs() <= TOLERANCE
        && (left.y - right.y).abs() <= TOLERANCE
        && (left.width - right.width).abs() <= TOLERANCE
        && (left.height - right.height).abs() <= TOLERANCE
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64) -> MacRect {
        MacRect {
            x,
            y,
            width: 656.0,
            height: 422.0,
        }
    }

    fn query(title: &str, bounds: MacRect) -> MacWindowQuery {
        MacWindowQuery {
            process_id: 42,
            title: title.to_string(),
            bounds,
        }
    }

    fn window(title: &str, bounds: MacRect, minimized: bool) -> AxWindowFacts {
        AxWindowFacts {
            bounds: Some(bounds),
            title: Some(title.to_string()),
            minimized,
        }
    }

    #[test]
    fn a_window_accessibility_does_not_list_is_never_shown() {
        let windows = [window("Notes", rect(10.0, 10.0), false)];
        assert_eq!(
            classify_window(&query("", rect(416.0, 1128.0)), &windows, false),
            (MacWindowPresence::NotShown, None)
        );
        assert_eq!(
            classify_window(&query("Notes", rect(416.0, 1128.0)), &[], true),
            (MacWindowPresence::NotShown, None)
        );
    }

    #[test]
    fn minimized_wins_over_a_hidden_application() {
        let windows = [
            window("Other", rect(10.0, 10.0), false),
            window("Notes", rect(213.0, 77.0), true),
        ];
        assert_eq!(
            classify_window(&query("Notes", rect(213.5, 77.0)), &windows, true),
            (MacWindowPresence::Minimized, Some(1))
        );
    }

    #[test]
    fn a_shown_window_of_a_hidden_application_is_application_hidden() {
        let windows = [window("Notes", rect(213.0, 77.0), false)];
        assert_eq!(
            classify_window(&query("Notes", rect(213.0, 77.0)), &windows, true),
            (MacWindowPresence::ApplicationHidden, Some(0))
        );
    }

    #[test]
    fn a_listed_window_that_is_neither_minimized_nor_hidden_is_unknown() {
        let windows = [window("Notes", rect(213.0, 77.0), false)];
        assert_eq!(
            classify_window(&query("Notes", rect(213.0, 77.0)), &windows, false),
            (MacWindowPresence::Unknown, Some(0))
        );
    }

    #[test]
    fn equal_bounds_are_told_apart_only_by_an_exact_title() {
        let windows = [
            window("Notes", rect(213.0, 77.0), true),
            window("Draft", rect(213.0, 77.0), false),
        ];
        assert_eq!(
            classify_window(&query("Notes", rect(213.0, 77.0)), &windows, false),
            (MacWindowPresence::Minimized, Some(0))
        );
        assert_eq!(
            classify_window(&query("", rect(213.0, 77.0)), &windows, false),
            (MacWindowPresence::Unknown, None)
        );
        let twins = [
            window("Notes", rect(213.0, 77.0), true),
            window("Notes", rect(213.0, 77.0), true),
        ];
        assert_eq!(
            classify_window(&query("Notes", rect(213.0, 77.0)), &twins, false),
            (MacWindowPresence::Unknown, None)
        );
    }
}
