//! Live X11 proof that desktop typing reaches a real text widget for text the
//! keyboard layout cannot type (design BR-5): `ÆØÅ–π密` and a non-Latin
//! password typed into a GTK entry through both XTEST delivery paths, with the
//! temporary spare-keycode bindings restored afterwards.
//!
//! # Why it is environment-gated
//!
//! It needs an X server with XTEST, `python3` with GTK 3 bindings, and must own
//! the display's keyboard focus. Without `OPENGENI_X11_TYPING_E2E=1` it SKIPS
//! LOUDLY. Run it on a private Xvfb, for example:
//!
//! ```text
//! OPENGENI_X11_TYPING_E2E=1 xvfb-run -a -n 171 -s '-screen 0 1024x768x24' \
//!   cargo test -p opengeni-agent-platform --test x11_unicode_typing -- --nocapture
//! ```
//!
//! `OPENGENI_X11_TYPING_EVIDENCE=<dir>` additionally saves a PNG of the entry.

#[cfg(not(target_os = "linux"))]
#[test]
fn x11_unicode_typing_is_linux_only() {
    eprintln!("SKIP: X11 keysym remapping is Linux-only");
}

#[cfg(target_os = "linux")]
mod live {
    use std::io::{BufRead as _, BufReader, Write as _};
    use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
    use std::time::{Duration, Instant};

    use opengeni_agent_platform::{DesktopBackend as _, LinuxDesktop, LinuxWindow, PlatformError};
    use opengeni_agent_proto::v1;
    use x11rb::connection::Connection as _;
    use x11rb::protocol::xproto::ConnectionExt as _;

    const TITLE: &str = "Opengeni Unicode typing fixture";
    const TEXT: &str = "ÆØÅ–π密";
    const PASSWORD: &str = "pÆss–wørd密π!";

    const FIXTURE: &str = r#"
import json, sys, gi
gi.require_version("Gtk", "3.0")
from gi.repository import GLib, Gtk
window = Gtk.Window(title=sys.argv[1])
entry = Gtk.Entry()
entry.modify_font(__import__("gi.repository.Pango", fromlist=["Pango"]).FontDescription("Sans 28"))
window.add(entry)
window.set_default_size(720, 90)
window.move(40, 40)
def ready():
    window.get_window().focus(0)
    entry.grab_focus()
    print("READY", flush=True)
    return False
def mapped(*_):
    GLib.timeout_add(300, ready)
    return False
def command(fd, condition):
    line = sys.stdin.readline().strip()
    if not line or line == "quit":
        Gtk.main_quit()
        return False
    if line == "clear":
        entry.set_text("")
    print(json.dumps(entry.get_text()), flush=True)
    return True
window.connect("map-event", mapped)
window.connect("destroy", Gtk.main_quit)
GLib.io_add_watch(sys.stdin.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP, command)
window.show_all()
Gtk.main()
"#;

    struct Fixture {
        child: Child,
        stdin: ChildStdin,
        stdout: BufReader<ChildStdout>,
    }

    impl Fixture {
        fn spawn() -> Self {
            let mut child = Command::new("python3")
                .args(["-c", FIXTURE, TITLE])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .expect("spawn the GTK fixture");
            let stdin = child.stdin.take().expect("fixture stdin");
            let mut stdout = BufReader::new(child.stdout.take().expect("fixture stdout"));
            let mut line = String::new();
            stdout.read_line(&mut line).expect("fixture readiness");
            assert_eq!(line.trim(), "READY", "GTK fixture did not start");
            Self {
                child,
                stdin,
                stdout,
            }
        }

        fn command(&mut self, command: &str) -> String {
            writeln!(self.stdin, "{command}").expect("fixture command");
            let mut line = String::new();
            self.stdout.read_line(&mut line).expect("fixture reply");
            decode_json_string(line.trim())
        }

        /// The entry text once it equals `expected`, or the last text seen.
        fn text_eventually(&mut self, expected: &str) -> String {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let text = self.command("dump");
                if text == expected || Instant::now() > deadline {
                    return text;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = writeln!(self.stdin, "quit");
            std::thread::sleep(Duration::from_millis(200));
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    /// Decodes the fixture's `json.dumps` output (ASCII with `\uXXXX` escapes).
    fn decode_json_string(encoded: &str) -> String {
        let inner = encoded
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .expect("fixture reply is a JSON string");
        let mut units = Vec::new();
        let mut chars = inner.chars();
        while let Some(character) = chars.next() {
            if character != '\\' {
                units.push(u16::try_from(u32::from(character)).expect("ASCII JSON"));
                continue;
            }
            match chars.next().expect("JSON escape") {
                'u' => {
                    let hex: String = chars.by_ref().take(4).collect();
                    units.push(u16::from_str_radix(&hex, 16).expect("JSON \\u escape"));
                }
                escaped => units.push(u16::try_from(u32::from(escaped)).expect("JSON escape")),
            }
        }
        String::from_utf16(&units).expect("UTF-16 text")
    }

    fn key_input(key: &str, is_text: bool) -> v1::DesktopInput {
        v1::DesktopInput {
            channel_id: String::new(),
            event: Some(v1::desktop_input::Event::Key(v1::KeyEvent {
                key: key.into(),
                is_text,
                action: v1::KeyAction::Press.into(),
            })),
        }
    }

    fn text_input(text: &str) -> v1::DesktopInput {
        key_input(text, true)
    }

    fn core_keymap(display: &str) -> (u8, Vec<u32>) {
        let (conn, _) = x11rb::connect(Some(display)).expect("connect for keymap");
        let min = conn.setup().min_keycode;
        let count = conn.setup().max_keycode - min + 1;
        let reply = conn
            .get_keyboard_mapping(min, count)
            .expect("keymap request")
            .reply()
            .expect("keymap reply");
        (reply.keysyms_per_keycode, reply.keysyms)
    }

    async fn fixture_window(desktop: &LinuxDesktop) -> LinuxWindow {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let windows = desktop.windows().await.expect("list windows");
            if let Some(window) = windows.into_iter().find(|window| window.title == TITLE) {
                return window;
            }
            assert!(Instant::now() < deadline, "fixture window never appeared");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn non_latin_text_reaches_a_gtk_entry_and_the_keymap_is_restored() {
        if std::env::var("OPENGENI_X11_TYPING_E2E").as_deref() != Ok("1") {
            eprintln!("SKIP: set OPENGENI_X11_TYPING_E2E=1 and run on a private Xvfb");
            return;
        }
        let display = std::env::var("DISPLAY").expect("DISPLAY names the private X server");
        let keymap_before = core_keymap(&display);
        let mut fixture = Fixture::spawn();
        let desktop = LinuxDesktop::open_default().expect("open X11 desktop");
        let window = fixture_window(&desktop).await;

        // Whole-desktop XTEST delivery (connected-machine and viewer input).
        desktop.inject(&text_input(TEXT)).await.expect("type text");
        assert_eq!(fixture.text_eventually(TEXT), TEXT);
        assert_eq!(core_keymap(&display), keymap_before, "keymap restored");
        eprintln!("desktop path typed {TEXT:?}");

        // Exact-window guarded delivery (managed desktops through the native
        // computer adapter), with a mixed ASCII/non-Latin password.
        assert_eq!(fixture.command("clear"), "");
        let activation = desktop
            .current_window_activation(window.clone())
            .await
            .expect("read window activation");
        desktop
            .inject_activated_window(activation, vec![text_input(PASSWORD)])
            .await
            .map_err(|failure| failure.error)
            .expect("type password into the exact window");
        assert_eq!(fixture.text_eventually(PASSWORD), PASSWORD);
        assert_eq!(core_keymap(&display), keymap_before, "keymap restored");
        eprintln!("exact-window path typed {PASSWORD:?}");

        // Named chords keep their exact-window route proof: select all, then
        // replace the selection with text that needs spare keycodes again.
        for input in [key_input("Control+a", false), text_input(TEXT)] {
            let activation = desktop
                .current_window_activation(window.clone())
                .await
                .expect("read window activation");
            desktop
                .inject_activated_window(activation, vec![input])
                .await
                .map_err(|failure| failure.error)
                .expect("deliver into the exact window");
        }
        assert_eq!(fixture.text_eventually(TEXT), TEXT);

        // More distinct glyphs than spare keycodes: refused before any key,
        // with the keymap and the entry untouched (the browserd driver then
        // pastes the text).
        let glyphs: String = (0x4e00..0x4f00).filter_map(char::from_u32).collect();
        let refusal = desktop.inject(&text_input(&glyphs)).await;
        assert!(
            matches!(&refusal, Err(PlatformError::Unsupported(message)) if message.ends_with("; use clipboard paste")),
            "{refusal:?}"
        );
        assert_eq!(fixture.command("dump"), TEXT);
        assert_eq!(core_keymap(&display), keymap_before, "keymap untouched");

        // Leave the acceptance text visible for the screenshot.
        assert_eq!(fixture.command("clear"), "");
        desktop.inject(&text_input(TEXT)).await.expect("type text");
        assert_eq!(fixture.text_eventually(TEXT), TEXT);
        if let Ok(directory) = std::env::var("OPENGENI_X11_TYPING_EVIDENCE") {
            let frame = desktop
                .capture_window(window.id)
                .await
                .expect("capture the fixture window");
            let path = std::path::Path::new(&directory).join("gtk-entry-typed.png");
            std::fs::write(&path, frame.png).expect("write screenshot");
            eprintln!("screenshot: {}", path.display());
        }
        assert_eq!(core_keymap(&display), keymap_before, "keymap restored");
    }
}
