//! A busy X11 client may process MappingNotify only after an input action
//! returned. A server round trip does not acknowledge client-side translation,
//! so spare-keycode bindings last for the session: the receiving client here
//! reads the keymap only after every action, and must still get exact text.
//! Run with OPENGENI_XVFB naming Xvfb; each test owns its private display.

#![cfg(target_os = "linux")]

use std::io::{BufRead as _, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use opengeni_agent_platform::{DesktopBackend as _, LinuxDesktop, PlatformError, X11Display};
use opengeni_agent_proto::v1;
use x11rb::connection::Connection as _;
use x11rb::protocol::xproto::{
    AtomEnum, ConnectionExt as _, CreateWindowAux, EventMask, InputFocus, PropMode, WindowClass,
};
use x11rb::protocol::Event;
use x11rb::wrapper::ConnectionExt as _;

struct Server(Child);

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

// Optional concurrent X11 request pressure while the receiver remains delayed.
// Owned threads stop on failure too; no process-name kills or shared display.
struct Load {
    stop: Arc<AtomicBool>,
    threads: Vec<std::thread::JoinHandle<()>>,
}

impl Load {
    fn start(display: &str) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let count = if std::env::var_os("OPENGENI_X11_TYPING_LOAD").is_some() {
            4
        } else {
            0
        };
        let threads = (0..count)
            .map(|_| {
                let display = display.to_string();
                let stop = stop.clone();
                std::thread::spawn(move || {
                    let (conn, _) = x11rb::connect(Some(&display)).unwrap();
                    while !stop.load(Ordering::Relaxed) {
                        let setup = conn.setup();
                        let reply = conn
                            .get_keyboard_mapping(
                                setup.min_keycode,
                                setup.max_keycode - setup.min_keycode + 1,
                            )
                            .unwrap()
                            .reply()
                            .unwrap();
                        std::hint::black_box(reply);
                    }
                })
            })
            .collect();
        Self { stop, threads }
    }
}

impl Drop for Load {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
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
    let display = format!(":{}", number.trim());
    Some((server, display))
}

fn focused_client(display: &str) -> (x11rb::rust_connection::RustConnection, u32) {
    let (client, screen) = x11rb::connect(Some(display)).unwrap();
    let root = client.setup().roots[screen].root;
    let window = client.generate_id().unwrap();
    client
        .create_window(
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
            &CreateWindowAux::new().event_mask(EventMask::KEY_PRESS | EventMask::KEY_RELEASE),
        )
        .unwrap()
        .check()
        .unwrap();
    client.map_window(window).unwrap().check().unwrap();
    let pid = client
        .intern_atom(false, b"_NET_WM_PID")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    client
        .change_property32(
            PropMode::REPLACE,
            window,
            pid,
            AtomEnum::CARDINAL,
            &[std::process::id()],
        )
        .unwrap()
        .check()
        .unwrap();
    client
        .set_input_focus(InputFocus::PARENT, window, x11rb::CURRENT_TIME)
        .unwrap()
        .check()
        .unwrap();
    (client, window)
}

fn text_input(text: &str) -> v1::DesktopInput {
    v1::DesktopInput {
        channel_id: String::new(),
        event: Some(v1::desktop_input::Event::Key(v1::KeyEvent {
            key: text.into(),
            is_text: true,
            action: v1::KeyAction::Press.into(),
        })),
    }
}

/// What the delayed client received since it last looked, translated with
/// the keymap as it is now, the way an application that handles
/// MappingNotify late does. Also returns the number of key presses.
fn received(client: &x11rb::rust_connection::RustConnection) -> (String, usize) {
    let min = client.setup().min_keycode;
    let count = client.setup().max_keycode - min + 1;
    let mapping = client
        .get_keyboard_mapping(min, count)
        .unwrap()
        .reply()
        .unwrap();
    let mut actual = String::new();
    let mut pressed = 0;
    while let Some(event) = client.poll_for_event().unwrap() {
        if let Event::KeyPress(key) = event {
            pressed += 1;
            let level = usize::from(u16::from(key.state) & 1 != 0);
            let index =
                usize::from(key.detail - min) * usize::from(mapping.keysyms_per_keycode) + level;
            let symbol = mapping.keysyms[index];
            let scalar = if symbol & 0xff00_0000 == 0x0100_0000 {
                symbol & 0x00ff_ffff
            } else {
                symbol
            };
            if scalar != 0 && scalar < 0xff00 {
                actual.push(char::from_u32(scalar).unwrap());
            }
        }
    }
    (actual, pressed)
}

fn keymap(display: &str) -> Vec<u32> {
    let (conn, _) = x11rb::connect(Some(display)).unwrap();
    let min = conn.setup().min_keycode;
    let count = conn.setup().max_keycode - min + 1;
    conn.get_keyboard_mapping(min, count)
        .unwrap()
        .reply()
        .unwrap()
        .keysyms
}

fn claims_property(display: &str) -> Vec<u32> {
    let (conn, screen) = x11rb::connect(Some(display)).unwrap();
    let root = conn.setup().roots[screen].root;
    let atom = conn
        .intern_atom(false, b"_OPENGENI_KEY_BINDINGS")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    conn.get_property(false, root, atom, AtomEnum::CARDINAL, 0, 1 << 16)
        .unwrap()
        .reply()
        .unwrap()
        .value32()
        .map(Iterator::collect)
        .unwrap_or_default()
}

/// Keycodes with no keysym in the given core keymap.
fn spare_keycodes(conn: &x11rb::rust_connection::RustConnection, keymap: &[u32]) -> Vec<u8> {
    let min = conn.setup().min_keycode;
    let per = usize::from(
        conn.get_keyboard_mapping(min, 1)
            .unwrap()
            .reply()
            .unwrap()
            .keysyms_per_keycode,
    );
    keymap
        .chunks(per)
        .enumerate()
        .filter(|(_, row)| row.iter().all(|symbol| *symbol == 0))
        .map(|(index, _)| min + u8::try_from(index).unwrap())
        .collect()
}

/// An unmapped window that lives exactly as long as `conn`.
fn owner_window(conn: &x11rb::rust_connection::RustConnection, root: u32) -> u32 {
    let window = conn.generate_id().unwrap();
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
        &CreateWindowAux::new(),
    )
    .unwrap()
    .check()
    .unwrap();
    window
}

#[tokio::test]
async fn delayed_client_gets_exact_text() {
    let Some((_server, display)) = start_server() else {
        return;
    };
    let (client, window) = focused_client(&display);
    let desktop = LinuxDesktop::open_display(X11Display::named(display.clone())).unwrap();
    let target = desktop
        .windows()
        .await
        .unwrap()
        .into_iter()
        .find(|candidate| candidate.id == window)
        .unwrap();
    let _load = Load::start(&display);
    let rounds: usize =
        std::env::var("OPENGENI_X11_TYPING_ROUNDS").map_or(8, |value| value.parse().unwrap());

    // This is a real X11 client, intentionally not consuming its event queue
    // while the server delivers. No probabilistic scheduler race or sleep:
    // even the first MappingNotify is processed only after injection returns.
    for round in 0..rounds {
        for guarded in [false, true] {
            for text in [
                "密",
                "π",
                "abc密",
                "Hello",
                "1!Aa",
                "abcdefghijklmnopqrstuvwxyz密",
                "Søren1!",
                "éøåüæÆ",
            ] {
                let input = text_input(text);
                let result = if guarded {
                    let activation = desktop
                        .current_window_activation(target.clone())
                        .await
                        .unwrap();
                    desktop
                        .inject_activated_window(activation, vec![input])
                        .await
                        .map_err(|error| error.error)
                } else {
                    desktop.inject(&input).await
                };
                // Every glyph here fits the spare keycodes: none is refused.
                result.unwrap_or_else(|error| {
                    panic!("{text:?} refused (round {round}, guarded {guarded}): {error}")
                });
                let (actual, _) = received(&client);
                assert_eq!(
                    actual, text,
                    "client received different text (round {round}, guarded {guarded})"
                );
            }
        }
    }
    eprintln!(
        "verified {} actions with the receiving client delayed",
        rounds * 16
    );
}

#[tokio::test]
async fn an_accented_batch_types_on_a_us_keymap() {
    let Some((_server, display)) = start_server() else {
        return;
    };
    let (client, window) = focused_client(&display);
    let desktop = LinuxDesktop::open_display(X11Display::named(display.clone())).unwrap();
    let target = desktop
        .windows()
        .await
        .unwrap()
        .into_iter()
        .find(|candidate| candidate.id == window)
        .unwrap();
    let parts = ["Name: ", "Søren Ødegård", ", city: ", "Zürich", " – café"];
    let activation = desktop
        .current_window_activation(target.clone())
        .await
        .unwrap();
    desktop
        .inject_activated_window(
            activation,
            parts.iter().map(|part| text_input(part)).collect(),
        )
        .await
        .map_err(|error| error.error)
        .unwrap();
    assert_eq!(received(&client).0, parts.concat());
}

#[tokio::test]
async fn distinct_glyphs_beyond_the_spare_keycodes_are_refused_before_input() {
    let Some((_server, display)) = start_server() else {
        return;
    };
    let (client, _window) = focused_client(&display);
    let desktop = LinuxDesktop::open_display(X11Display::named(display.clone())).unwrap();
    let glyphs: Vec<String> = (0x4e00..0x4e00 + 300)
        .filter_map(char::from_u32)
        .map(String::from)
        .collect();
    let mut typed = 0;
    let mut refused = 0;
    for glyph in &glyphs {
        let result = desktop.inject(&text_input(glyph)).await;
        let (actual, pressed) = received(&client);
        match result {
            Ok(()) => {
                assert_eq!(
                    refused, 0,
                    "{glyph} typed after an earlier glyph was refused"
                );
                assert_eq!(&actual, glyph);
                typed += 1;
            }
            Err(PlatformError::Unsupported(message)) => {
                assert!(message.ends_with("; use clipboard paste"), "{message}");
                assert_eq!(pressed, 0, "a refusal sends no key");
                refused += 1;
            }
            Err(error) => panic!("unexpected error: {error}"),
        }
    }
    assert!(typed > 0 && refused > 0, "typed {typed}, refused {refused}");
    // Glyphs bound earlier keep typing, also in one batch and with mapped text.
    let again: String = glyphs[..typed].concat();
    desktop.inject(&text_input(&again)).await.unwrap();
    assert_eq!(received(&client).0, again);
    desktop.inject(&text_input("abc")).await.unwrap();
    assert_eq!(received(&client).0, "abc");
    eprintln!("{typed} distinct glyphs typed, {refused} refused before input");
}

#[tokio::test]
async fn bindings_last_until_the_last_session_using_them_ends() {
    let Some((_server, display)) = start_server() else {
        return;
    };
    let (client, _window) = focused_client(&display);
    let before = keymap(&display);
    let first = LinuxDesktop::open_display(X11Display::named(display.clone())).unwrap();
    let second = LinuxDesktop::open_display(X11Display::named(display.clone())).unwrap();
    first.inject(&text_input("é密")).await.unwrap();
    assert_eq!(received(&client).0, "é密");
    let bound = keymap(&display);
    assert_ne!(bound, before);
    // The second session types the same glyphs through the same bindings.
    second.inject(&text_input("密é")).await.unwrap();
    assert_eq!(received(&client).0, "密é");
    assert_eq!(keymap(&display), bound);
    drop(first);
    assert_eq!(keymap(&display), bound, "still used by the second session");
    second.inject(&text_input("é")).await.unwrap();
    assert_eq!(received(&client).0, "é");
    drop(second);
    assert_eq!(keymap(&display), before, "restored with the last session");
    assert!(claims_property(&display).is_empty());
}

#[tokio::test]
async fn bindings_of_an_ended_process_are_restored_when_the_next_session_starts() {
    let Some((_server, display)) = start_server() else {
        return;
    };
    let before = keymap(&display);
    // Two sessions bind a glyph each; one then ends without releasing (as a
    // crashed process does), the other is still running.
    let (live, screen) = x11rb::connect(Some(&display)).unwrap();
    let root = live.setup().roots[screen].root;
    let spares = spare_keycodes(&live, &before);
    let (crashed_key, live_key) = (spares[spares.len() - 1], spares[spares.len() - 2]);
    let atom = live
        .intern_atom(false, b"_OPENGENI_KEY_BINDINGS")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    let owner = |conn: &x11rb::rust_connection::RustConnection| owner_window(conn, root);
    let live_owner = owner(&live);
    let (crashed, _) = x11rb::connect(Some(&display)).unwrap();
    let crashed_owner = owner(&crashed);
    for (key, symbol) in [(crashed_key, 0x0100_5bc6), (live_key, 0xe9)] {
        live.change_keyboard_mapping(1, key, 2, &[symbol, symbol])
            .unwrap()
            .check()
            .unwrap();
    }
    live.change_property32(
        PropMode::REPLACE,
        root,
        atom,
        AtomEnum::CARDINAL,
        &[
            crashed_owner,
            u32::from(crashed_key),
            0x0100_5bc6,
            live_owner,
            u32::from(live_key),
            0xe9,
        ],
    )
    .unwrap()
    .check()
    .unwrap();
    drop(crashed);
    // The X server destroys the ended process's owner window with it.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while live
        .get_window_attributes(crashed_owner)
        .unwrap()
        .reply()
        .is_ok()
    {
        assert!(
            std::time::Instant::now() < deadline,
            "owner window outlived its client"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let row = |key: u8| {
        let reply = live.get_keyboard_mapping(key, 1).unwrap().reply().unwrap();
        reply.keysyms
    };
    assert!(row(crashed_key).contains(&0x0100_5bc6));

    let desktop = LinuxDesktop::open_display(X11Display::named(display.clone())).unwrap();
    assert!(
        row(crashed_key).iter().all(|symbol| *symbol == 0),
        "restored"
    );
    assert!(
        row(live_key).contains(&0xe9),
        "a live session's binding stays"
    );
    assert_eq!(
        claims_property(&display),
        [live_owner, u32::from(live_key), 0xe9]
    );
    drop(desktop);
}
