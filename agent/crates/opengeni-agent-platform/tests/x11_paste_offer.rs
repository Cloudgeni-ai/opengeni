//! A paste offer owns CLIPBOARD until dropped and reports when the focused
//! window's client, not a clipboard manager, has read its text.
//! Run with OPENGENI_XVFB naming Xvfb; each test owns its private display.

#![cfg(target_os = "linux")]

use std::io::{BufRead as _, BufReader};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use opengeni_agent_platform::{
    LinuxDesktop, LinuxPasteOutcome, LinuxPreviousClipboard, X11Display,
};
use x11rb::connection::Connection as _;
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ConnectionExt as _, CreateWindowAux, InputFocus, Window, WindowClass,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;

struct Server(Child);

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start_server() -> Option<(Server, String)> {
    let binary = std::env::var("OPENGENI_XVFB").unwrap_or_else(|_| "Xvfb".into());
    let child = Command::new(&binary)
        .args([
            "-displayfd",
            "1",
            "-noreset",
            "-nolisten",
            "tcp",
            "-screen",
            "0",
            "640x480x24",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(child) = child else {
        assert!(
            std::env::var_os("OPENGENI_XVFB").is_none(),
            "configured Xvfb must run"
        );
        eprintln!("SKIP: no Xvfb; set OPENGENI_XVFB");
        return None;
    };
    let mut server = Server(child);
    let mut number = String::new();
    BufReader::new(server.0.stdout.take().unwrap())
        .read_line(&mut number)
        .unwrap();
    Some((server, format!(":{}", number.trim())))
}

/// A client with one window; `focus` gives that window the input focus.
fn client(display: &str, focus: bool) -> (RustConnection, Window) {
    let (conn, screen) = x11rb::connect(Some(display)).unwrap();
    let root = conn.setup().roots[screen].root;
    let window = conn.generate_id().unwrap();
    conn.create_window(
        0,
        window,
        root,
        0,
        0,
        200,
        100,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new(),
    )
    .unwrap()
    .check()
    .unwrap();
    if focus {
        conn.map_window(window).unwrap().check().unwrap();
        conn.set_input_focus(InputFocus::PARENT, window, x11rb::CURRENT_TIME)
            .unwrap()
            .check()
            .unwrap();
    }
    (conn, window)
}

fn atom(conn: &RustConnection, name: &[u8]) -> Atom {
    conn.intern_atom(false, name).unwrap().reply().unwrap().atom
}

/// Reads CLIPBOARD as UTF8_STRING into `window`, as a pasting app does.
fn read_clipboard(conn: &RustConnection, window: Window) -> Option<String> {
    let (clipboard, utf8, property) = (
        atom(conn, b"CLIPBOARD"),
        atom(conn, b"UTF8_STRING"),
        atom(conn, b"PASTED"),
    );
    conn.convert_selection(window, clipboard, utf8, property, x11rb::CURRENT_TIME)
        .unwrap()
        .check()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match conn.poll_for_event().unwrap() {
            Some(Event::SelectionNotify(event)) if event.requestor == window => {
                if event.property == x11rb::NONE {
                    return None;
                }
                let reply = conn
                    .get_property(true, window, property, AtomEnum::ANY, 0, u32::MAX / 4)
                    .unwrap()
                    .reply()
                    .unwrap();
                return Some(String::from_utf8(reply.value).unwrap());
            }
            Some(_) => {}
            None => {
                assert!(Instant::now() < deadline, "no selection reply");
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    }
}

fn owner(conn: &RustConnection) -> Window {
    let clipboard = atom(conn, b"CLIPBOARD");
    conn.get_selection_owner(clipboard)
        .unwrap()
        .reply()
        .unwrap()
        .owner
}

#[test]
fn the_focused_client_reading_the_text_completes_the_paste() {
    let Some((_server, display)) = start_server() else {
        return;
    };
    let desktop = LinuxDesktop::open_display(X11Display::named(display.clone())).unwrap();
    let (target, target_window) = client(&display, true);
    let (manager, manager_window) = client(&display, false);

    let offer = desktop.offer_paste_text("Søren 密 ✓".into()).unwrap();
    assert_eq!(offer.previous(), LinuxPreviousClipboard::Empty);
    assert_ne!(owner(&target), x11rb::NONE);
    // A clipboard manager reading the new owner's text is not the paste.
    assert_eq!(
        read_clipboard(&manager, manager_window).as_deref(),
        Some("Søren 密 ✓")
    );
    assert_eq!(
        offer.wait(Duration::from_millis(200)),
        LinuxPasteOutcome::Pending
    );
    assert_eq!(
        read_clipboard(&target, target_window).as_deref(),
        Some("Søren 密 ✓")
    );
    assert_eq!(
        offer.wait(Duration::from_secs(2)),
        LinuxPasteOutcome::Consumed
    );
    drop(offer);
    assert_eq!(
        owner(&target),
        x11rb::NONE,
        "dropping gives the clipboard up"
    );
}

#[test]
fn a_new_copy_supersedes_the_offer_and_an_earlier_owner_is_reported() {
    let Some((_server, display)) = start_server() else {
        return;
    };
    let desktop = LinuxDesktop::open_display(X11Display::named(display.clone())).unwrap();
    let (person, person_window) = client(&display, true);
    let clipboard = atom(&person, b"CLIPBOARD");
    person
        .set_selection_owner(person_window, clipboard, x11rb::CURRENT_TIME)
        .unwrap()
        .check()
        .unwrap();

    let offer = desktop.offer_paste_text("pasted".into()).unwrap();
    assert_eq!(offer.previous(), LinuxPreviousClipboard::Owned);
    assert_eq!(
        offer.wait(Duration::from_millis(100)),
        LinuxPasteOutcome::Pending
    );
    // The person copies something new before the paste is read.
    person
        .set_selection_owner(person_window, clipboard, x11rb::CURRENT_TIME)
        .unwrap()
        .check()
        .unwrap();
    assert_eq!(
        offer.wait(Duration::from_secs(2)),
        LinuxPasteOutcome::Superseded
    );
    drop(offer);
    assert_eq!(owner(&person), person_window, "the new copy stays");
}
