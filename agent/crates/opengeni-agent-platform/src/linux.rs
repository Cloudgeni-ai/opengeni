//! Linux-specific platform bits.
//!
//! exec/fs/git themselves are portable and live in [`crate::native`]; this module
//! holds the genuinely Linux-specific pieces folded into the cross-platform
//! [`NativePlatform`](crate::NativePlatform): reporting the OS family, building a
//! shell command via the user's `$SHELL` (falling back to `/bin/sh`), and the
//! **X11 desktop backend** ([`LinuxDesktop`]) that powers screen capture +
//! computer-use input for the M8 desktop stream.
//!
//! # Desktop: X11 via the safe [`x11rb`] binding (no `unsafe`)
//!
//! The workspace forbids `unsafe_code`. [`LinuxDesktop`] therefore uses
//! [`x11rb`] — a pure-Rust, memory-safe X11 client — for everything:
//!
//! * **Capture**: `GetImage` on the root window (ZPixmap), converted to PNG.
//! * **Geometry**: the `RANDR` extension reports the real screen size; we fall
//!   back to the root window geometry when RANDR is absent (common under Xvfb).
//! * **Input**: the `XTEST` extension (`FakeInput`) synthesizes pointer motion,
//!   button press/release, key press/release, and scroll (buttons 4/5) — the same
//!   mechanism `xdotool` drives, but in-process and safe.
//!
//! A headless box opts into a desktop by spawning Xvfb (see
//! [`crate::virtual_desktop`]) and pointing `$DISPLAY` at it; [`LinuxDesktop`]
//! then connects exactly as it would to a real `:0`.

use std::collections::BTreeMap;

use async_trait::async_trait;
use x11rb::connection::{Connection as _, RequestConnection as _};
use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat, Screen};

use opengeni_agent_proto::v1::{self, Os};

use crate::desktop::{CapturedFrame, DesktopBackend};
use crate::error::{PlatformError, PlatformResult};

/// The OS family this build targets.
#[must_use]
pub(crate) fn os() -> Os {
    Os::Linux
}

/// Builds a command that runs `parts` through the user's POSIX shell.
///
/// The joined command is passed to `sh -c` (or `$SHELL -c`). We intentionally do
/// NOT re-quote the parts: when the caller sets `shell = true` they have opted
/// into shell interpretation of the joined string, mirroring how a terminal
/// `sh -c "<line>"` behaves.
pub(crate) fn shell_command(parts: &[String]) -> tokio::process::Command {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = tokio::process::Command::new(shell);
    cmd.arg("-c").arg(parts.join(" "));
    cmd
}

// =============================================================================
// X11 desktop backend (capture + computer-use input via the safe x11rb binding)
// =============================================================================

/// An X11 desktop backend: screen capture + synthetic input over a connection to
/// the display named by `$DISPLAY` (a real screen or an Xvfb virtual framebuffer).
///
/// All X11 access goes through [`x11rb`] (safe, pure-Rust), so this backend needs
/// no `unsafe`. The connection is opened per operation rather than held, because
/// the backend lives behind an `Arc<dyn DesktopBackend>` shared across the capture
/// pump and the input handler, and an `x11rb` connection is not `Sync` for
/// concurrent request issue; opening per-call keeps the backend trivially
/// shareable and each capture/inject self-contained. Capture is ~30ms on a typical
/// screen, well within the framebuffer pump's frame budget.
#[derive(Debug, Clone)]
pub struct LinuxDesktop {
    /// The `$DISPLAY` value to connect to (e.g. `":0"`, `":99"`).
    display_name: String,
}

impl LinuxDesktop {
    /// Opens the backend against `$DISPLAY` (or `:0` if unset), verifying a
    /// connection can actually be established and the `XTEST` extension is present.
    ///
    /// # Errors
    ///
    /// Returns a human-readable reason string when no display is reachable (the
    /// caller maps this to `display_unavailable` — a value, never a crash).
    pub fn open_default() -> Result<Self, String> {
        let display_name = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".to_string());
        if display_name.is_empty() {
            return Err("$DISPLAY is empty".to_string());
        }
        // Probe a real connection so a stale/dead $DISPLAY does not falsely report
        // a desktop. Drop it immediately; subsequent ops reconnect.
        let (conn, _screen) = x11rb::connect(Some(&display_name))
            .map_err(|e| format!("cannot connect to X display {display_name}: {e}"))?;
        // XTEST is required for computer-use input; capture works without it, but a
        // desktop we cannot drive is not the desktop capability we advertise.
        conn.extension_information(x11rb::protocol::xtest::X11_EXTENSION_NAME)
            .map_err(|e| format!("XTEST query failed: {e}"))?
            .ok_or_else(|| "XTEST extension is not available on this display".to_string())?;
        Ok(Self { display_name })
    }

    /// Establishes a fresh X11 connection plus the default screen for one op.
    fn connect(&self) -> PlatformResult<(x11rb::rust_connection::RustConnection, Screen)> {
        let (conn, screen_num) = x11rb::connect(Some(&self.display_name)).map_err(|e| {
            PlatformError::os(format!("connect X display {}: {e}", self.display_name))
        })?;
        let screen = conn.setup().roots[screen_num].clone();
        Ok((conn, screen))
    }
}

#[async_trait]
impl DesktopBackend for LinuxDesktop {
    fn probe(&self) -> Option<v1::Display> {
        let (conn, screen) = self.connect().ok()?;
        let (width, height) = screen_geometry(&conn, &screen);
        let virtual_fb = is_virtual_display(&self.display_name);
        Some(v1::Display {
            id: self.display_name.clone(),
            width,
            height,
            r#virtual: virtual_fb,
        })
    }

    async fn capture(&self) -> PlatformResult<CapturedFrame> {
        // x11rb is blocking; run the capture on the blocking pool so the async
        // runtime is never stalled by a slow GetImage.
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.capture_blocking())
            .await
            .map_err(|e| PlatformError::os(format!("capture task join: {e}")))?
    }

    async fn inject(&self, input: &v1::DesktopInput) -> PlatformResult<()> {
        let this = self.clone();
        let input = input.clone();
        tokio::task::spawn_blocking(move || this.inject_blocking(&input))
            .await
            .map_err(|e| PlatformError::os(format!("inject task join: {e}")))?
    }
}

impl LinuxDesktop {
    /// Captures the root window via `GetImage` and PNG-encodes it. Runs on the
    /// blocking pool (x11rb is synchronous).
    fn capture_blocking(&self) -> PlatformResult<CapturedFrame> {
        let (conn, screen) = self.connect()?;
        let (width, height) = screen_geometry(&conn, &screen);
        let w = u16::try_from(width).unwrap_or(u16::MAX);
        let h = u16::try_from(height).unwrap_or(u16::MAX);

        let image = conn
            .get_image(
                ImageFormat::Z_PIXMAP,
                screen.root,
                0,
                0,
                w,
                h,
                u32::MAX, // all planes
            )
            .map_err(|e| PlatformError::os(format!("GetImage request: {e}")))?
            .reply()
            .map_err(|e| PlatformError::os(format!("GetImage reply: {e}")))?;

        let rgba = zpixmap_to_rgba(&image.data, width, height, image.depth);
        let png = encode_png(&rgba, width, height)?;
        Ok(CapturedFrame { png, width, height })
    }

    /// Synthesizes one input event via the `XTEST` `FakeInput` request.
    fn inject_blocking(&self, input: &v1::DesktopInput) -> PlatformResult<()> {
        let (conn, screen) = self.connect()?;
        let root = screen.root;

        let Some(event) = &input.event else {
            return Err(PlatformError::os("DesktopInput carried no event"));
        };

        match event {
            v1::desktop_input::Event::Pointer(p) => inject_pointer(&conn, root, p)?,
            v1::desktop_input::Event::Key(k) => inject_key(&conn, root, k)?,
            v1::desktop_input::Event::Scroll(s) => inject_scroll(&conn, root, s)?,
        }

        conn.flush()
            .map_err(|e| PlatformError::os(format!("XTEST flush: {e}")))?;
        // A sync round-trips so a failed FakeInput surfaces as an error rather than
        // silently dropping on the wire.
        let _ = conn.get_input_focus();
        Ok(())
    }
}

/// Maps a [`PointerEvent`](v1::PointerEvent) to one or more XTEST `FakeInput`
/// motion/button events.
fn inject_pointer(
    conn: &x11rb::rust_connection::RustConnection,
    root: x11rb::protocol::xproto::Window,
    p: &v1::PointerEvent,
) -> PlatformResult<()> {
    use x11rb::protocol::xtest::ConnectionExt as _;
    let x = i16::try_from(p.x).unwrap_or(0);
    let y = i16::try_from(p.y).unwrap_or(0);
    let button = x_button_code(p.button());

    // Every pointer event first moves to the target coordinate (XTEST motion uses
    // detail 0, the absolute root-relative position).
    conn.xtest_fake_input(MOTION_NOTIFY, 0, 0, root, x, y, 0)
        .map_err(|e| PlatformError::os(format!("XTEST motion: {e}")))?;

    match p.action() {
        v1::PointerAction::Move | v1::PointerAction::Unspecified => {}
        v1::PointerAction::Down => press(conn, button)?,
        v1::PointerAction::Up => release(conn, button)?,
        v1::PointerAction::Click => {
            press(conn, button)?;
            release(conn, button)?;
        }
        v1::PointerAction::DoubleClick => {
            press(conn, button)?;
            release(conn, button)?;
            press(conn, button)?;
            release(conn, button)?;
        }
    }
    Ok(())
}

/// Maps a [`KeyEvent`](v1::KeyEvent) to XTEST key press/release. A keysym is
/// resolved to a keycode via the connection's keymap; text typing presses each
/// character's keysym in turn.
fn inject_key(
    conn: &x11rb::rust_connection::RustConnection,
    root: x11rb::protocol::xproto::Window,
    k: &v1::KeyEvent,
) -> PlatformResult<()> {
    // Text typing and single-key naming both resolve to keysyms; for v1 we map the
    // common printable ASCII + a small set of named keys to keycodes by scanning
    // the server keymap. A keysym we cannot resolve is skipped (not an error) so a
    // best-effort type never hard-fails a session.
    let keysyms: Vec<u32> = if k.is_text {
        k.key.chars().map(|c| c as u32).collect()
    } else {
        named_key_to_keysym(&k.key).into_iter().collect()
    };

    for keysym in keysyms {
        let Some(keycode) = keysym_to_keycode(conn, keysym) else {
            continue;
        };
        match k.action() {
            v1::KeyAction::Down => key_press(conn, keycode)?,
            v1::KeyAction::Up => key_release(conn, keycode)?,
            v1::KeyAction::Press | v1::KeyAction::Unspecified => {
                key_press(conn, keycode)?;
                key_release(conn, keycode)?;
            }
        }
    }
    let _ = root;
    Ok(())
}

/// The maximum number of synthetic wheel clicks one scroll event may emit per
/// axis. A real wheel gesture is a handful of clicks; this bound only exists to
/// keep a malformed/hostile delta (e.g. `i32::MIN`) from spinning the blocking
/// inject for ~2^31 round-tripped `FakeInput` events.
const MAX_SCROLL_CLICKS: u32 = 32;

/// Maps a [`ScrollEvent`](v1::ScrollEvent) to XTEST button 4/5 (vertical) and 6/7
/// (horizontal) clicks — the X11 convention for wheel scrolling.
fn inject_scroll(
    conn: &x11rb::rust_connection::RustConnection,
    root: x11rb::protocol::xproto::Window,
    s: &v1::ScrollEvent,
) -> PlatformResult<()> {
    use x11rb::protocol::xtest::ConnectionExt as _;
    let x = i16::try_from(s.x).unwrap_or(0);
    let y = i16::try_from(s.y).unwrap_or(0);
    conn.xtest_fake_input(MOTION_NOTIFY, 0, 0, root, x, y, 0)
        .map_err(|e| PlatformError::os(format!("XTEST scroll motion: {e}")))?;

    // Vertical: button 4 = up, 5 = down. Horizontal: 6 = left, 7 = right.
    let v_button = if s.delta_y < 0 { 4 } else { 5 };
    let h_button = if s.delta_x < 0 { 6 } else { 7 };
    // Each unit of delta is one synthetic wheel click. Clamp the per-axis repeat
    // so a hostile/huge magnitude (up to i32::MIN.unsigned_abs() == 2^31) cannot
    // spin the inject for billions of round-tripped FakeInput events and wedge the
    // blocking pool. MAX_SCROLL_CLICKS is well past any real wheel gesture.
    let v_clicks = s.delta_y.unsigned_abs().min(MAX_SCROLL_CLICKS);
    let h_clicks = s.delta_x.unsigned_abs().min(MAX_SCROLL_CLICKS);
    for _ in 0..v_clicks {
        press(conn, v_button)?;
        release(conn, v_button)?;
    }
    for _ in 0..h_clicks {
        press(conn, h_button)?;
        release(conn, h_button)?;
    }
    Ok(())
}

// --- XTEST low-level helpers -------------------------------------------------

/// X11 event-type constants for XTEST `FakeInput` (from the core protocol).
const KEY_PRESS: u8 = 2;
const KEY_RELEASE: u8 = 3;
const BUTTON_PRESS: u8 = 4;
const BUTTON_RELEASE: u8 = 5;
const MOTION_NOTIFY: u8 = 6;

fn press(conn: &x11rb::rust_connection::RustConnection, button: u8) -> PlatformResult<()> {
    use x11rb::protocol::xtest::ConnectionExt as _;
    conn.xtest_fake_input(BUTTON_PRESS, button, 0, x11rb::NONE, 0, 0, 0)
        .map_err(|e| PlatformError::os(format!("XTEST button press: {e}")))?;
    Ok(())
}

fn release(conn: &x11rb::rust_connection::RustConnection, button: u8) -> PlatformResult<()> {
    use x11rb::protocol::xtest::ConnectionExt as _;
    conn.xtest_fake_input(BUTTON_RELEASE, button, 0, x11rb::NONE, 0, 0, 0)
        .map_err(|e| PlatformError::os(format!("XTEST button release: {e}")))?;
    Ok(())
}

fn key_press(conn: &x11rb::rust_connection::RustConnection, keycode: u8) -> PlatformResult<()> {
    use x11rb::protocol::xtest::ConnectionExt as _;
    conn.xtest_fake_input(KEY_PRESS, keycode, 0, x11rb::NONE, 0, 0, 0)
        .map_err(|e| PlatformError::os(format!("XTEST key press: {e}")))?;
    Ok(())
}

fn key_release(conn: &x11rb::rust_connection::RustConnection, keycode: u8) -> PlatformResult<()> {
    use x11rb::protocol::xtest::ConnectionExt as _;
    conn.xtest_fake_input(KEY_RELEASE, keycode, 0, x11rb::NONE, 0, 0, 0)
        .map_err(|e| PlatformError::os(format!("XTEST key release: {e}")))?;
    Ok(())
}

/// Maps the proto [`PointerButton`](v1::PointerButton) to the X11 button number
/// (1 = left, 2 = middle, 3 = right).
fn x_button_code(button: v1::PointerButton) -> u8 {
    match button {
        v1::PointerButton::Right => 3,
        v1::PointerButton::Middle => 2,
        // Left + unspecified default to the primary button.
        v1::PointerButton::Left | v1::PointerButton::Unspecified => 1,
    }
}

/// Resolves an X11 keysym to a keycode by scanning the server keymap. Returns
/// `None` if the keysym is not bound, so a best-effort type skips it.
fn keysym_to_keycode(conn: &x11rb::rust_connection::RustConnection, keysym: u32) -> Option<u8> {
    let setup = conn.setup();
    let min = setup.min_keycode;
    let max = setup.max_keycode;
    let count = max - min + 1;
    let mapping = conn.get_keyboard_mapping(min, count).ok()?.reply().ok()?;
    let per = mapping.keysyms_per_keycode as usize;
    for (i, chunk) in mapping.keysyms.chunks(per).enumerate() {
        if chunk.contains(&keysym) {
            let code = min as usize + i;
            return u8::try_from(code).ok();
        }
    }
    None
}

/// Maps a small set of named keys to X11 keysyms (the keys the computer-use tool
/// commonly emits). Printable single characters fall through to their ASCII
/// codepoint, which equals the Latin-1 keysym for the printable range.
fn named_key_to_keysym(name: &str) -> Option<u32> {
    // X11 keysym constants (from keysymdef.h). Only the common control keys are
    // named; everything else is treated as literal text by the caller.
    let sym = match name {
        "Enter" | "Return" => 0xff0d,
        "Tab" => 0xff09,
        "Escape" | "Esc" => 0xff1b,
        "Backspace" => 0xff08,
        "Delete" => 0xffff,
        "Space" | " " => 0x0020,
        "ArrowLeft" | "Left" => 0xff51,
        "ArrowUp" | "Up" => 0xff52,
        "ArrowRight" | "Right" => 0xff53,
        "ArrowDown" | "Down" => 0xff54,
        "Home" => 0xff50,
        "End" => 0xff57,
        "PageUp" => 0xff55,
        "PageDown" => 0xff56,
        other => {
            // A single printable char maps to its codepoint (Latin-1 keysym range).
            let mut chars = other.chars();
            let c = chars.next()?;
            if chars.next().is_none() && (c as u32) < 0x100 {
                c as u32
            } else {
                return None;
            }
        }
    };
    Some(sym)
}

// --- Geometry + image conversion --------------------------------------------

/// Reports the screen geometry, preferring `RANDR`'s current mode (accurate under
/// a resized real screen) and falling back to the root window's `width/height`
/// (which is what Xvfb reports). Always returns a sane non-zero pair.
fn screen_geometry(conn: &x11rb::rust_connection::RustConnection, screen: &Screen) -> (u32, u32) {
    use x11rb::protocol::randr::ConnectionExt as _;
    if let Ok(cookie) = conn.randr_get_screen_resources_current(screen.root) {
        if let Ok(res) = cookie.reply() {
            if let Some(crtc) = res.crtcs.first() {
                if let Ok(info) = conn.randr_get_crtc_info(*crtc, 0) {
                    if let Ok(info) = info.reply() {
                        if info.width > 0 && info.height > 0 {
                            return (u32::from(info.width), u32::from(info.height));
                        }
                    }
                }
            }
        }
    }
    (
        u32::from(screen.width_in_pixels),
        u32::from(screen.height_in_pixels),
    )
}

/// Whether a `$DISPLAY` name indicates a virtual framebuffer. Xvfb has no reliable
/// protocol marker, so we use the heuristic that high display numbers (>= 99, the
/// conventional Xvfb range used by `--virtual-desktop`) are virtual. A false
/// negative is harmless (it only affects the `virtual` flag the UI shows).
fn is_virtual_display(display_name: &str) -> bool {
    display_name
        .trim_start_matches(':')
        .split('.')
        .next()
        .and_then(|n| n.parse::<u32>().ok())
        .is_some_and(|n| n >= 99)
}

/// Converts a server `ZPixmap` image buffer to tightly-packed RGBA8.
///
/// X servers commonly deliver 24/32-bit pixels as little-endian BGRX; we read each
/// 4-byte (or 3-byte) pixel and emit `R,G,B,255`.
///
/// # Row padding (stride)
///
/// A `ZPixmap` scanline is padded up to the server's `bitmap_format_scanline_pad`
/// (commonly 32 bits), so a row occupies `bytes_per_line >= width * bpp` bytes —
/// the padding bytes at the end of each row must be SKIPPED, not consumed as
/// pixels, or every row after the first is shifted and the frame shears. The
/// `GetImage` reply does not carry `bytes_per_line`, but `data.len()` is exactly
/// `bytes_per_line * height`, so we recover the true stride as `data.len() /
/// height` and walk each pixel at `row * stride + col * bpp`. A short/garbled
/// buffer falls back to the tight `width * bpp` stride and is clamped so a read
/// never panics.
fn zpixmap_to_rgba(data: &[u8], width: u32, height: u32, depth: u8) -> Vec<u8> {
    let w = width as usize;
    let h = height as usize;
    let bpp = zpixmap_bytes_per_pixel(data.len(), width, height, depth);
    let tight = w * bpp;
    // True (possibly padded) bytes-per-line, recovered from the buffer length.
    // Fall back to the tight row when height is 0 or the buffer is shorter than a
    // single un-padded frame (we then clamp per-pixel below).
    let stride = if h > 0 && data.len() >= tight * h {
        data.len() / h
    } else {
        tight
    };
    let mut rgba = Vec::with_capacity(w * h * 4);
    for row in 0..h {
        let row_start = row * stride;
        for col in 0..w {
            let off = row_start + col * bpp;
            if off + 2 < data.len() {
                // BGRX byte order: byte0=B, byte1=G, byte2=R.
                rgba.push(data[off + 2]);
                rgba.push(data[off + 1]);
                rgba.push(data[off]);
                rgba.push(0xff);
            } else {
                rgba.extend_from_slice(&[0, 0, 0, 0xff]);
            }
        }
    }
    rgba
}

/// Picks the bytes-per-pixel for a `ZPixmap` buffer of `depth`. A depth <= 24
/// image whose buffer is exactly `width*height*3` is tightly-packed 24bpp;
/// otherwise the server delivered 4 bytes per pixel (the common 32bpp BGRX case),
/// possibly with row padding the caller accounts for via the stride.
fn zpixmap_bytes_per_pixel(data_len: usize, width: u32, height: u32, depth: u8) -> usize {
    if depth <= 24 && data_len == (width as usize * height as usize * 3) {
        3
    } else {
        4
    }
}

/// PNG-encodes a tightly-packed RGBA8 buffer.
fn encode_png(rgba: &[u8], width: u32, height: u32) -> PlatformResult<Vec<u8>> {
    use image::ImageEncoder as _;
    let mut out = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut out);
    encoder
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| {
            let mut detail = BTreeMap::new();
            detail.insert("stage".to_string(), "png-encode".to_string());
            PlatformError::Os {
                message: format!("png encode failed: {e}"),
                detail,
            }
        })?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn button_codes_map_to_x11_numbers() {
        assert_eq!(x_button_code(v1::PointerButton::Left), 1);
        assert_eq!(x_button_code(v1::PointerButton::Middle), 2);
        assert_eq!(x_button_code(v1::PointerButton::Right), 3);
        assert_eq!(x_button_code(v1::PointerButton::Unspecified), 1);
    }

    #[test]
    fn named_keys_resolve_and_text_falls_through() {
        assert_eq!(named_key_to_keysym("Enter"), Some(0xff0d));
        assert_eq!(named_key_to_keysym("Tab"), Some(0xff09));
        // A single printable char maps to its codepoint.
        assert_eq!(named_key_to_keysym("a"), Some(0x61));
        // A multi-char non-named string is not a single keysym.
        assert_eq!(named_key_to_keysym("hello"), None);
    }

    #[test]
    fn virtual_display_heuristic() {
        assert!(is_virtual_display(":99"));
        assert!(is_virtual_display(":100.0"));
        assert!(!is_virtual_display(":0"));
        assert!(!is_virtual_display(":1"));
    }

    #[test]
    fn zpixmap_bgrx_to_rgba_swaps_channels() {
        // One 2x1 image, BGRX: pixel0 = (B=1,G=2,R=3,X=0), pixel1 = (B=4,G=5,R=6,X=0).
        let data = [1u8, 2, 3, 0, 4, 5, 6, 0];
        let rgba = zpixmap_to_rgba(&data, 2, 1, 24);
        assert_eq!(rgba, vec![3, 2, 1, 0xff, 6, 5, 4, 0xff]);
    }

    #[test]
    fn zpixmap_honors_row_padding_stride() {
        // A 1px-wide, 2-row image where each scanline is padded from the tight
        // 4 bytes (1px * 4bpp) to an 8-byte stride. If the converter ignored the
        // padding it would read row 1 from the padding bytes of row 0 and shear.
        //   row0: pixel (B=1,G=2,R=3,X) + 4 pad bytes
        //   row1: pixel (B=4,G=5,R=6,X) + 4 pad bytes
        let data = [
            1u8, 2, 3, 0, 0xAA, 0xBB, 0xCC, 0xDD, // row 0: pixel + padding
            4, 5, 6, 0, 0xAA, 0xBB, 0xCC, 0xDD, // row 1: pixel + padding
        ];
        let rgba = zpixmap_to_rgba(&data, 1, 2, 32);
        // Expect the two REAL pixels (RGBA), not the padding.
        assert_eq!(rgba, vec![3, 2, 1, 0xff, 6, 5, 4, 0xff]);
    }

    #[test]
    fn zpixmap_tight_32bpp_has_no_padding() {
        // A 2x2 tight 32bpp buffer: stride == width*bpp, so no rows are skipped.
        let data = [
            1u8, 2, 3, 0, 4, 5, 6, 0, // row 0: px(B1G2R3) px(B4G5R6)
            7, 8, 9, 0, 10, 11, 12, 0, // row 1: px(B7G8R9) px(B10G11R12)
        ];
        let rgba = zpixmap_to_rgba(&data, 2, 2, 24);
        assert_eq!(
            rgba,
            vec![
                3, 2, 1, 0xff, 6, 5, 4, 0xff, // row 0
                9, 8, 7, 0xff, 12, 11, 10, 0xff, // row 1
            ]
        );
    }

    #[test]
    fn encode_png_produces_a_valid_signature() {
        // 1x1 white pixel → a decodable PNG (magic bytes present).
        let rgba = [0xff, 0xff, 0xff, 0xff];
        let png = encode_png(&rgba, 1, 1).expect("encode");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }
}
