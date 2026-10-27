//! A real X server whose cookie changes and which goes away and comes back,
//! the way a display manager's login looks to an agent that started first.
//!
//! Runs against a private `Xvfb` (from `$OPENGENI_XVFB`, else `Xvfb` on
//! `PATH`) and is skipped, saying so, when there is none.

#[cfg(target_os = "linux")]
mod linux {
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    use opengeni_agent_platform::{
        linux_layout_text_keysyms, linux_named_key_chord_keys, CompositorKey, CompositorLayout,
        DesktopBackend as _, KeymapNames, LinuxDesktop, ReopeningDesktop, X11Display, XServerCheck,
    };
    use x11rb::connection::Connection as _;
    use x11rb::protocol::xkb::{self, ConnectionExt as _};
    use x11rb::protocol::xproto::ConnectionExt as _;

    fn xvfb() -> Option<PathBuf> {
        if let Some(path) = std::env::var_os("OPENGENI_XVFB") {
            return Some(PathBuf::from(path));
        }
        std::env::var_os("PATH").and_then(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join("Xvfb"))
                .find(|candidate| candidate.is_file())
        })
    }

    /// An authority file with one cookie for every display.
    fn write_authority(path: &Path, cookie: &[u8; 16]) {
        let mut bytes = 0xffff_u16.to_be_bytes().to_vec(); // FamilyWild
        for field in [&b""[..], b"", b"MIT-MAGIC-COOKIE-1", cookie] {
            bytes.extend(u16::try_from(field.len()).unwrap().to_be_bytes());
            bytes.extend(field);
        }
        std::fs::write(path, bytes).unwrap();
    }

    struct Server {
        child: Child,
    }

    impl Server {
        fn start(binary: &Path, number: u32, authority: &Path) -> Self {
            let mut command = Command::new(binary);
            command.arg("-auth").arg(authority);
            Self::spawn(command, number)
        }

        /// A server that admits every local client, as Xwayland admits its
        /// own user.
        fn start_open(binary: &Path, number: u32) -> Self {
            Self::spawn(Command::new(binary), number)
        }

        fn spawn(mut command: Command, number: u32) -> Self {
            let child = command
                .arg(format!(":{number}"))
                // No server reset when the last client leaves, as on a real
                // desktop: a reset drops clients that connect meanwhile.
                .args(["-noreset", "-nolisten", "tcp", "-screen", "0", "640x480x24"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("start Xvfb");
            let socket = PathBuf::from(format!("/tmp/.X11-unix/X{number}"));
            let deadline = Instant::now() + Duration::from_secs(10);
            while !socket.exists() {
                assert!(Instant::now() < deadline, "Xvfb did not start");
                std::thread::sleep(Duration::from_millis(50));
            }
            // The socket appears just before the server takes connections.
            std::thread::sleep(Duration::from_millis(200));
            Self { child }
        }

        fn stop(mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[test]
    fn a_desktop_follows_its_cookie_and_its_server() {
        let Some(binary) = xvfb() else {
            eprintln!("SKIP: no Xvfb (set OPENGENI_XVFB or put Xvfb on PATH)");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let number = 300 + std::process::id() % 600;
        let server_authority = dir.path().join("server.auth");
        let client_authority = dir.path().join("client.auth");
        write_authority(&server_authority, b"0123456789abcdef");
        // The agent's authority file still holds the previous login's cookie.
        write_authority(&client_authority, b"stale-cookie-000");
        let server = Server::start(&binary, number, &server_authority);
        let display = X11Display {
            name: format!(":{number}"),
            authority: Some(client_authority.clone()),
            session: None,
            // The test's own Xvfb: the checked connect path, socket file only.
            server: XServerCheck::AgentUser,
        };
        let desktop = ReopeningDesktop::new({
            let display = display.clone();
            move || LinuxDesktop::open_display(display.clone())
        });
        assert!(desktop.probe().is_none());
        let reason = desktop.capture_blocked_reason().unwrap_or_default();
        assert!(reason.contains("MIT-MAGIC-COOKIE-1"), "{reason}");

        // The login writes the session's cookie; the next check opens the desktop.
        write_authority(&client_authority, b"0123456789abcdef");
        std::thread::sleep(Duration::from_millis(1_100));
        let probed = desktop.probe().expect("desktop after the new cookie");
        assert_eq!(probed.id, display.name);
        assert_eq!((probed.width, probed.height), (640, 480));
        assert_eq!(desktop.capture_blocked_reason(), None);

        // The server goes away (sign-out): no desktop, with the reason.
        server.stop();
        assert!(desktop.probe().is_none());
        assert!(desktop.capture_blocked_reason().is_some());

        // A new login starts it again with a new cookie in the same file.
        write_authority(&server_authority, b"fedcba9876543210");
        write_authority(&client_authority, b"fedcba9876543210");
        let _server = Server::start(&binary, number, &server_authority);
        std::thread::sleep(Duration::from_millis(1_100));
        assert!(desktop.probe().is_some());
        assert_eq!(desktop.capture_blocked_reason(), None);
    }

    #[test]
    fn typing_reads_the_layout_display_through_the_checked_connect() {
        let Some(binary) = xvfb() else {
            eprintln!("SKIP: no Xvfb (set OPENGENI_XVFB or put Xvfb on PATH)");
            return;
        };
        let number = 1_000 + std::process::id() % 600;
        let _server = Server::start_open(&binary, number);
        let display = format!(":{number}");
        // The server can take a moment to accept clients after its socket
        // appears; the keymap lookup silently falls back while it does, so
        // first wait until a checked connect to it succeeds.
        let checked = X11Display {
            server: XServerCheck::AgentUser,
            ..X11Display::named(display.clone())
        };
        let deadline = Instant::now() + Duration::from_secs(20);
        let connected = loop {
            match checked.connect() {
                Ok(_) => break Ok(()),
                Err(error) if Instant::now() >= deadline => break Err(error),
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        };
        assert!(connected.is_ok(), "checked connect: {connected:?}");
        // The layout has Latin letters and no Cyrillic, which can only be
        // known once its keymap was read.
        assert_eq!(
            linux_layout_text_keysyms(Some(&display), &CompositorLayout::default(), "a").unwrap(),
            vec![0x61]
        );
        assert!(
            linux_layout_text_keysyms(Some(&display), &CompositorLayout::default(), "\u{416}")
                .is_err()
        );
        // Without a layout display every character maps unchecked.
        assert!(linux_layout_text_keysyms(None, &CompositorLayout::default(), "\u{416}").is_ok());
        // Named keys are checked against the same layout: F2 is on it, F13
        // is not, and the compositor would drop it while reporting success.
        assert_eq!(
            linux_named_key_chord_keys(Some(&display), &CompositorLayout::default(), "Alt+F2")
                .unwrap(),
            vec![CompositorKey::Keysym(0xffe9), CompositorKey::Keysym(0xffbf)]
        );
        let missing =
            linux_named_key_chord_keys(Some(&display), &CompositorLayout::default(), "F13")
                .unwrap_err();
        assert!(
            missing
                .to_string()
                .contains("X11 keymap does not expose named key/chord component 0xffca"),
            "{missing}"
        );
        assert!(linux_named_key_chord_keys(None, &CompositorLayout::default(), "F13").is_ok());
        layout_groups_and_levels(&display, &checked);
        caps_lock_text(&display);
    }

    fn compositor(active_group: Option<u32>, keymap: Option<KeymapNames>) -> CompositorLayout {
        CompositorLayout {
            active_group,
            locked_modifiers: None,
            keymap,
        }
    }

    /// Text under a locked Caps Lock, checked against the server's own key
    /// types: a letter is sent as the keysym of its other case, which the
    /// compositor presses with or without Shift so that Caps Lock turns it
    /// back into the requested case.
    fn caps_lock_text(display: &str) {
        let display = display.to_string();
        let caps = CompositorLayout {
            locked_modifiers: Some(0x02),
            ..CompositorLayout::default()
        };
        assert_eq!(
            linux_layout_text_keysyms(Some(&display), &caps, "Hello, 1!").unwrap(),
            vec![0x68, 0x45, 0x4c, 0x4c, 0x4f, 0x2c, 0x20, 0x31, 0x21]
        );
        // Num Lock (Mod2) leaves text alone.
        let num = CompositorLayout {
            locked_modifiers: Some(0x10),
            ..CompositorLayout::default()
        };
        assert_eq!(
            linux_layout_text_keysyms(Some(&display), &num, "Hello").unwrap(),
            vec![0x48, 0x65, 0x6c, 0x6c, 0x6f]
        );
    }

    /// Text and chords on a running layout display, checked the way a
    /// compositor resolving keysyms per group and level delivers them.
    fn layout_groups_and_levels(display: &str, checked: &X11Display) {
        let display = display.to_string();
        // Text is checked per layout group and shift level, the way the
        // compositor resolves keysyms. `¦` is only on the fourth level of the
        // extra key, which the compositor would send unshifted as `<`.
        assert!(
            linux_layout_text_keysyms(Some(&display), &CompositorLayout::default(), "\u{a6}")
                .is_err()
        );
        assert_eq!(
            linux_layout_text_keysyms(Some(&display), &CompositorLayout::default(), "|").unwrap(),
            vec![0x7c]
        );
        // A second group: a spare key with `ж` in the first and `é` in the
        // second. Each types only while its group is active, and neither when
        // the active group is unknown; keys with one group serve both.
        let (conn, _) = checked.connect().unwrap();
        conn.change_keyboard_mapping(1, 200, 4, &[0x6d6, 0x6f6, 0xe9, 0xc9])
            .unwrap()
            .check()
            .unwrap();
        let text = |active: Option<u32>, text: &str| {
            let layout = compositor(active, None);
            linux_layout_text_keysyms(Some(&display), &layout, text).map_err(|e| e.to_string())
        };
        assert_eq!(text(Some(1), "aé"), Ok(vec![0x61, 0xe9]));
        assert_eq!(text(Some(0), "aж"), Ok(vec![0x61, 0x6d6]));
        for (active, refused) in [(Some(1), "ж"), (Some(0), "é"), (None, "ж"), (None, "é")] {
            let error = text(active, refused).unwrap_err();
            assert!(
                error.contains("the active keyboard layout cannot type"),
                "{active:?} {refused}: {error}"
            );
        }
        assert_eq!(text(None, "a"), Ok(vec![0x61]));
        // A chord key only another group has is sent as the physical key
        // that gives it there (evdev keycode 192 is X11 keycode 200).
        let chord = |active: Option<u32>, name: &str| {
            let layout = compositor(active, None);
            linux_named_key_chord_keys(Some(&display), &layout, name).map_err(|e| e.to_string())
        };
        assert_eq!(
            chord(Some(1), "Ctrl+é"),
            Ok(vec![
                CompositorKey::Keysym(0xffe3),
                CompositorKey::Keysym(0xe9)
            ])
        );
        for active in [Some(0), None] {
            assert_eq!(
                chord(active, "Ctrl+é"),
                Ok(vec![
                    CompositorKey::Keysym(0xffe3),
                    CompositorKey::Keycode(192)
                ]),
                "{active:?}"
            );
        }
        // The display's keymap stands in for the compositor's only once it
        // carries the compositor's keymap names; until then typing waits, and
        // then fails as retryable rather than checking a stale layout.
        let names = display_keymap_names(&conn);
        let synced = compositor(Some(1), Some(names));
        assert_eq!(
            linux_layout_text_keysyms(Some(&display), &synced, "é").unwrap(),
            vec![0xe9]
        );
        let other = CompositorLayout {
            active_group: Some(1),
            locked_modifiers: None,
            keymap: Some(KeymapNames::from_keymap_text(
                "xkb_symbols \"pc+ru+us:2\" {\n\tname[1]=\"Russian\";\n\tname[2]=\"English (US)\";\n};",
            )),
        };
        let started = Instant::now();
        let error = linux_layout_text_keysyms(Some(&display), &other, "é").unwrap_err();
        assert!(error.retryable(), "{error}");
        assert!(
            error
                .to_string()
                .contains("the keyboard layout is not ready yet; retry, or use clipboard paste"),
            "{error}"
        );
        assert!(started.elapsed() >= Duration::from_millis(900));
        // A chord whose key is a character waits the same way, while keys that
        // are not characters do not depend on the layout and never wait, even
        // when the display's keymap never takes the compositor's names.
        let error = linux_named_key_chord_keys(Some(&display), &other, "Ctrl+a").unwrap_err();
        assert!(error.retryable(), "{error}");
        let started = Instant::now();
        for (name, keysyms) in [
            ("Return", &[0xff0d][..]),
            ("Escape", &[0xff1b]),
            ("Ctrl+Shift+ArrowLeft", &[0xffe3, 0xffe1, 0xff51]),
            ("Alt+F2", &[0xffe9, 0xffbf]),
            ("Super", &[0xffeb]),
        ] {
            let keys: Vec<_> = keysyms.iter().copied().map(CompositorKey::Keysym).collect();
            assert_eq!(
                linux_named_key_chord_keys(Some(&display), &other, name).unwrap(),
                keys,
                "{name}"
            );
        }
        // F13 is still checked against the keymap the display has.
        assert!(linux_named_key_chord_keys(Some(&display), &other, "F13").is_err());
        assert!(started.elapsed() < Duration::from_millis(900));
    }

    /// The display's keymap names in the text form a compositor hands out.
    fn display_keymap_names(conn: &impl x11rb::connection::Connection) -> KeymapNames {
        use std::fmt::Write as _;
        use x11rb::protocol::xkb::{self, ConnectionExt as _};
        conn.xkb_use_extension(1, 0).unwrap().reply().unwrap();
        let reply = conn
            .xkb_get_names(
                xkb::ID::USE_CORE_KBD.into(),
                xkb::NameDetail::SYMBOLS | xkb::NameDetail::GROUP_NAMES,
            )
            .unwrap()
            .reply()
            .unwrap();
        let atom = |atom: u32| {
            String::from_utf8(conn.get_atom_name(atom).unwrap().reply().unwrap().name).unwrap()
        };
        let mut text = format!(
            "xkb_symbols \"{}\" {{\n",
            atom(reply.value_list.symbols_name.unwrap())
        );
        for (index, group) in reply.value_list.groups.unwrap().into_iter().enumerate() {
            if group != 0 {
                writeln!(text, "\tname[{}]=\"{}\";", index + 1, atom(group)).unwrap();
            }
        }
        text.push_str("};\n");
        let names = KeymapNames::from_keymap_text(&text);
        assert!(!names.is_empty(), "{text}");
        names
    }

    /// Locks `mods` and group `group` on the server's core keyboard.
    fn lock_keyboard(conn: &impl x11rb::connection::Connection, mods: u16, group: xkb::Group) {
        use x11rb::protocol::xproto::ModMask;
        conn.xkb_latch_lock_state(
            xkb::ID::USE_CORE_KBD.into(),
            ModMask::from(0xff_u16),
            ModMask::from(mods),
            true,
            group,
            ModMask::from(0_u16),
            false,
            0,
        )
        .unwrap()
        .check()
        .unwrap();
    }

    /// The (keycode, modifier and group state) of each key press the focused
    /// window received for one typed text, apart from Shift's own presses.
    fn typed_presses(
        conn: &impl x11rb::connection::Connection,
        runtime: &tokio::runtime::Runtime,
        desktop: &LinuxDesktop,
        text: &str,
        shift: u8,
    ) -> Vec<(u8, u16)> {
        use opengeni_agent_proto::v1;
        use x11rb::protocol::Event;
        let input = v1::DesktopInput {
            event: Some(v1::desktop_input::Event::Key(v1::KeyEvent {
                key: text.into(),
                is_text: true,
                action: v1::KeyAction::Press.into(),
            })),
            ..Default::default()
        };
        runtime.block_on(desktop.inject(&input)).unwrap();
        let mut presses = Vec::new();
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline {
            match conn.poll_for_event().unwrap() {
                Some(Event::KeyPress(press)) if press.detail != shift => {
                    presses.push((press.detail, u16::from(press.state)));
                }
                Some(_) => {}
                None => std::thread::sleep(Duration::from_millis(10)),
            }
        }
        presses
    }

    #[test]
    fn locked_and_grouped_text_is_pressed_as_it_arrives() {
        use x11rb::protocol::xproto::{CreateWindowAux, EventMask, InputFocus, WindowClass};
        let Some(binary) = xvfb() else {
            eprintln!("SKIP: no Xvfb (set OPENGENI_XVFB or put Xvfb on PATH)");
            return;
        };
        let number = 1_600 + std::process::id() % 300;
        let _server = Server::start_open(&binary, number);
        let display = X11Display {
            server: XServerCheck::AgentUser,
            ..X11Display::named(format!(":{number}"))
        };
        let deadline = Instant::now() + Duration::from_secs(20);
        let (conn, screen) = loop {
            match display.connect() {
                Ok(connected) => break connected,
                Err(error) => assert!(Instant::now() < deadline, "connect: {error}"),
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        conn.xkb_use_extension(1, 0).unwrap().reply().unwrap();
        let root = conn.setup().roots[screen].root;
        let window = conn.generate_id().unwrap();
        conn.create_window(
            0,
            window,
            root,
            0,
            0,
            100,
            100,
            0,
            WindowClass::INPUT_OUTPUT,
            0,
            &CreateWindowAux::new().event_mask(EventMask::KEY_PRESS),
        )
        .unwrap();
        conn.map_window(window).unwrap();
        conn.get_input_focus().unwrap().reply().unwrap();
        conn.set_input_focus(InputFocus::PARENT, window, x11rb::CURRENT_TIME)
            .unwrap()
            .check()
            .unwrap();
        let keycode_of = |keysym: u32| {
            let setup = conn.setup();
            let count = setup.max_keycode - setup.min_keycode + 1;
            let map = conn
                .get_keyboard_mapping(setup.min_keycode, count)
                .unwrap()
                .reply()
                .unwrap();
            let per = usize::from(map.keysyms_per_keycode);
            let index = map.keysyms.iter().position(|&k| k == keysym).unwrap() / per;
            setup.min_keycode + u8::try_from(index).unwrap()
        };
        let (a, b, shift) = (keycode_of(0x61), keycode_of(0x62), keycode_of(0xffe1));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let desktop = LinuxDesktop::open_display(display.clone()).unwrap();
        let typed = |text: &str| typed_presses(&conn, &runtime, &desktop, text, shift);
        // Caps Lock: the small letter is pressed with Shift, the capital
        // without, so that each arrives as typed.
        lock_keyboard(&conn, 0x02, xkb::Group::M1);
        assert_eq!(typed("aB"), [(a, 0x03), (b, 0x02)]);
        // Num Lock alone (Mod2 on this server) leaves text alone.
        lock_keyboard(&conn, 0x10, xkb::Group::M1);
        assert_eq!(typed("aB"), [(a, 0x10), (b, 0x11)]);
        // A second group gives `ф` and `Ф` on the `a` key. While it is
        // active, `ф` is pressed there, and `a` is not pressed on a key that
        // would give `ф` (it goes to a spare keycode, bound for the press).
        conn.change_keyboard_mapping(1, a, 4, &[0x61, 0x41, 0x6c6, 0x6e6])
            .unwrap()
            .check()
            .unwrap();
        lock_keyboard(&conn, 0, xkb::Group::M2);
        assert_eq!(typed("ф"), [(a, 0x2000)]);
        let presses = typed("a");
        assert_eq!(presses.len(), 1, "{presses:?}");
        assert_ne!(presses[0].0, a, "{presses:?}");
    }
}
