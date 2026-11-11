//! Pastes text through a short-lived CLIPBOARD owner of our own, so the
//! caller can tell when the focused application has read the text and only
//! then put the person's previous clipboard back. A general clipboard library
//! cannot say when its contents were served, and restoring before the target
//! read them would paste the old clipboard instead.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use x11rb::connection::{Connection as _, RequestConnection as _};
use x11rb::protocol::res::ConnectionExt as _;
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ConnectionExt as _, CreateWindowAux, EventMask, PropMode, SelectionNotifyEvent,
    SelectionRequestEvent, Window, WindowClass, SELECTION_NOTIFY_EVENT,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

use crate::error::{PlatformError, PlatformResult};

use super::X11Display;

/// How an offered paste ended, as far as the X server can tell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinuxPasteOutcome {
    /// A client of the focused window read the text.
    Consumed,
    /// Another client took the clipboard first (the person copied something).
    Superseded,
    /// Neither happened yet.
    Pending,
}

/// The previous clipboard as seen when the offer took it over.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinuxPreviousClipboard {
    /// No client owned the clipboard.
    Empty,
    /// Some client owned it (its contents are read separately).
    Owned,
}

/// Owns CLIPBOARD with one text on a dedicated connection until dropped.
pub struct LinuxPasteOffer {
    previous: LinuxPreviousClipboard,
    state: Arc<(Mutex<LinuxPasteOutcome>, Condvar)>,
    stop: Arc<AtomicBool>,
    server: Option<JoinHandle<()>>,
}

impl LinuxPasteOffer {
    /// Who owned the clipboard before this offer.
    #[must_use]
    pub fn previous(&self) -> LinuxPreviousClipboard {
        self.previous
    }

    /// Waits up to `timeout` for the focused client to read the text or for
    /// another client to take the clipboard. The offer keeps serving after
    /// this returns, until it is dropped.
    #[must_use]
    pub fn wait(&self, timeout: Duration) -> LinuxPasteOutcome {
        let (outcome, changed) = &*self.state;
        let Ok(outcome) = outcome.lock() else {
            return LinuxPasteOutcome::Pending;
        };
        changed
            .wait_timeout_while(outcome, timeout, |outcome| {
                *outcome == LinuxPasteOutcome::Pending
            })
            .map_or(LinuxPasteOutcome::Pending, |(outcome, _)| *outcome)
    }
}

impl Drop for LinuxPasteOffer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(server) = self.server.take() {
            let _ = server.join();
        }
        // Closing the connection gives up ownership: the clipboard is empty
        // unless another owner has already taken it.
    }
}

struct Atoms {
    clipboard: Atom,
    targets: Atom,
    utf8: Atom,
    text: Atom,
    plain_utf8: Atom,
    stamp: Atom,
}

fn intern(conn: &RustConnection, name: &[u8]) -> PlatformResult<Atom> {
    Ok(conn
        .intern_atom(false, name)
        .map_err(offer_error)?
        .reply()
        .map_err(offer_error)?
        .atom)
}

fn offer_error(error: impl std::fmt::Display) -> PlatformError {
    PlatformError::Unsupported(format!("X11 paste offer is unavailable: {error}"))
}

/// Takes CLIPBOARD with `text`; dropping the offer gives it up.
pub(super) fn offer(display: &X11Display, text: String) -> PlatformResult<LinuxPasteOffer> {
    let (conn, screen) = display.connect().map_err(offer_error)?;
    // Text that does not fit one property would need the incremental
    // transfer protocol; such text is pasted without this offer.
    if text.len() + 1024 > conn.maximum_request_bytes() {
        return Err(PlatformError::Unsupported(
            "X11 paste offer text exceeds one request".into(),
        ));
    }
    let root = conn.setup().roots[screen].root;
    let atoms = Atoms {
        clipboard: intern(&conn, b"CLIPBOARD")?,
        targets: intern(&conn, b"TARGETS")?,
        utf8: intern(&conn, b"UTF8_STRING")?,
        text: intern(&conn, b"TEXT")?,
        plain_utf8: intern(&conn, b"text/plain;charset=utf-8")?,
        stamp: intern(&conn, b"_OPENGENI_PASTE_OFFER")?,
    };
    let window = conn.generate_id().map_err(offer_error)?;
    conn.create_window(
        0,
        window,
        root,
        -1,
        -1,
        1,
        1,
        0,
        WindowClass::INPUT_ONLY,
        0,
        &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
    )
    .map_err(offer_error)?
    .check()
    .map_err(offer_error)?;
    let previous = if conn
        .get_selection_owner(atoms.clipboard)
        .map_err(offer_error)?
        .reply()
        .map_err(offer_error)?
        .owner
        == x11rb::NONE
    {
        LinuxPreviousClipboard::Empty
    } else {
        LinuxPreviousClipboard::Owned
    };
    let time = server_time(&conn, window, atoms.stamp)?;
    conn.set_selection_owner(window, atoms.clipboard, time)
        .map_err(offer_error)?;
    if conn
        .get_selection_owner(atoms.clipboard)
        .map_err(offer_error)?
        .reply()
        .map_err(offer_error)?
        .owner
        != window
    {
        return Err(offer_error("another client kept the clipboard"));
    }
    let state = Arc::new((Mutex::new(LinuxPasteOutcome::Pending), Condvar::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let server = {
        let state = Arc::clone(&state);
        let stop = Arc::clone(&stop);
        std::thread::Builder::new()
            .name("x11-paste-offer".into())
            .spawn(move || serve(&conn, window, &atoms, time, &text, &state, &stop))
            .map_err(offer_error)?
    };
    Ok(LinuxPasteOffer {
        previous,
        state,
        stop,
        server: Some(server),
    })
}

/// A real server timestamp for the ownership claim, read from the
/// notification of a zero-length property append on our own window.
fn server_time(conn: &RustConnection, window: Window, stamp: Atom) -> PlatformResult<u32> {
    conn.change_property8(PropMode::APPEND, window, stamp, AtomEnum::STRING, &[])
        .map_err(offer_error)?;
    conn.flush().map_err(offer_error)?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match conn.poll_for_event().map_err(offer_error)? {
            Some(Event::PropertyNotify(event)) if event.window == window => return Ok(event.time),
            Some(_) => {}
            None if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(1)),
            None => return Err(offer_error("no server timestamp")),
        }
    }
}

fn serve(
    conn: &RustConnection,
    window: Window,
    atoms: &Atoms,
    time: u32,
    text: &str,
    state: &(Mutex<LinuxPasteOutcome>, Condvar),
    stop: &AtomicBool,
) {
    let settle = |outcome: LinuxPasteOutcome| {
        let (current, changed) = state;
        if let Ok(mut current) = current.lock() {
            if *current == LinuxPasteOutcome::Pending {
                *current = outcome;
                changed.notify_all();
            }
        }
    };
    while !stop.load(Ordering::Relaxed) {
        let event = match conn.poll_for_event() {
            Ok(Some(event)) => event,
            Ok(None) => {
                std::thread::sleep(Duration::from_millis(2));
                continue;
            }
            Err(_) => break,
        };
        match event {
            Event::SelectionClear(event) if event.selection == atoms.clipboard => {
                settle(LinuxPasteOutcome::Superseded);
            }
            Event::SelectionRequest(request) if request.owner == window => {
                let served = answer(conn, atoms, time, text, &request);
                if served && from_focused_client(conn, request.requestor) {
                    settle(LinuxPasteOutcome::Consumed);
                }
            }
            _ => {}
        }
    }
}

/// Answers one conversion request; true when it delivered the text itself.
fn answer(
    conn: &RustConnection,
    atoms: &Atoms,
    time: u32,
    text: &str,
    request: &SelectionRequestEvent,
) -> bool {
    // Obsolete clients name no property; the target is used instead.
    let property = if request.property == x11rb::NONE {
        request.target
    } else {
        request.property
    };
    let stale = request.time != x11rb::CURRENT_TIME && request.time < time;
    let delivered = if stale || request.selection != atoms.clipboard {
        None
    } else if request.target == atoms.targets {
        let targets = [atoms.targets, atoms.utf8, atoms.plain_utf8, atoms.text];
        conn.change_property32(
            PropMode::REPLACE,
            request.requestor,
            property,
            AtomEnum::ATOM,
            &targets,
        )
        .ok()
        .map(|_| false)
    } else if [atoms.utf8, atoms.plain_utf8, atoms.text].contains(&request.target) {
        let kind = if request.target == atoms.plain_utf8 {
            atoms.plain_utf8
        } else {
            atoms.utf8
        };
        conn.change_property8(
            PropMode::REPLACE,
            request.requestor,
            property,
            kind,
            text.as_bytes(),
        )
        .ok()
        .map(|_| true)
    } else {
        None
    };
    let notify = SelectionNotifyEvent {
        response_type: SELECTION_NOTIFY_EVENT,
        sequence: 0,
        time: request.time,
        requestor: request.requestor,
        selection: request.selection,
        target: request.target,
        property: if delivered.is_some() {
            property
        } else {
            x11rb::NONE
        },
    };
    let sent = conn
        .send_event(false, request.requestor, EventMask::NO_EVENT, notify)
        .is_ok()
        && conn.flush().is_ok();
    sent && delivered == Some(true)
}

/// Whether `requestor` belongs to the client that owns the input focus.
/// Clipboard managers read every new owner's text from their own windows,
/// which never counts as the paste.
fn from_focused_client(conn: &RustConnection, requestor: Window) -> bool {
    let Some(focus) = conn
        .get_input_focus()
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .map(|reply| reply.focus)
    else {
        return false;
    };
    // None and PointerRoot name no client.
    if focus <= 1 {
        return false;
    }
    let Some(clients) = conn
        .res_query_clients()
        .ok()
        .and_then(|cookie| cookie.reply().ok())
    else {
        return false;
    };
    super::same_x11_client(focus, requestor, &clients.clients)
}
