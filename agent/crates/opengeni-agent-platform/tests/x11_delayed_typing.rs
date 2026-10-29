//! A busy X11 client may process MappingNotify only after an input action
//! returned. A server round trip does not acknowledge client-side translation.
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

#[tokio::test]
async fn delayed_client_gets_exact_text_or_a_pre_input_refusal() {
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
            ] {
                let input = v1::DesktopInput {
                    channel_id: String::new(),
                    event: Some(v1::desktop_input::Event::Key(v1::KeyEvent {
                        key: text.into(),
                        is_text: true,
                        action: v1::KeyAction::Press.into(),
                    })),
                };
                let result = if guarded {
                    let activation = desktop
                        .current_window_activation(target.clone())
                        .await
                        .unwrap();
                    desktop
                        .inject_activated_window(activation, vec![input])
                        .await
                        .map_err(|error| {
                            assert!(!error.dispatched, "a refused batch must not send input");
                            error.error
                        })
                } else {
                    desktop.inject(&input).await
                };
                if text.is_ascii() {
                    assert!(result.is_ok(), "mapped text must still type: {result:?}");
                }
                // Equivalent to an application's mapping refresh after MappingNotify:
                // X11 returns the current map, not the historical map at event time.
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
                        let index = usize::from(key.detail - min)
                            * usize::from(mapping.keysyms_per_keycode)
                            + level;
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
                match result {
            Ok(()) => assert_eq!(
                actual, text,
                "input reported sent but client received different text (round {round}, guarded {guarded})"
            ),
            Err(PlatformError::Unsupported(message)) => {
                assert!(message.ends_with("; use clipboard paste"), "{message}");
                assert_eq!(pressed, 0, "refusal must not send even an ASCII prefix");
            }
            Err(error) => panic!("unexpected error: {error}"),
        }
            }
        }
    }
    eprintln!(
        "verified {} actions with the receiving client delayed",
        rounds * 12
    );
}
