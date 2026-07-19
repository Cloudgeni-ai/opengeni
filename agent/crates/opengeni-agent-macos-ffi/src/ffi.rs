//! The single audited `unsafe` boundary for the macOS desktop backend.
//!
//! Every `objc2` message send, C function call, and pointer handoff in this crate
//! lives here. The module is declared `#[allow(unsafe_code)]` in `lib.rs`; the
//! crate is otherwise `unsafe_code = "deny"`, so this file is the whole surface a
//! reviewer must audit. It is compiled only on `target_os = "macos"`.
//!
//! # Why each `unsafe` is sound
//!
//! * **objc2 method calls** (`SCShareableContent::getShareableContent…`,
//!   `content.displays()`, `SCContentFilter::init…`, `SCScreenshotManager::capture…`,
//!   `SCDisplay::displayID`) are `unsafe fn` purely because objc message sends are
//!   `unsafe` in objc2; we pass correctly-typed, non-dangling arguments and use the
//!   returned `Retained`/`CFRetained` smart pointers, so ARC is upheld.
//! * **CGEvent / CoreGraphics** creators return `Option<CFRetained<…>>` (null →
//!   `None`, handled); `keyboard_set_unicode_string` is `unsafe` because it takes a
//!   raw `*const UniChar` — we pass a pointer to a live stack `[u16]` that outlives
//!   the synchronous call.
//! * **Raw pointer deref** of the completion-handler args (`&*content`, `&*img`)
//!   borrows objects ScreenCaptureKit owns for the callback's duration; we extract
//!   all data synchronously inside the callback and never retain past it.
//! * **`AXIsProcessTrusted*`** are a tiny `extern "C"` into ApplicationServices
//!   (HIServices), which the objc2 framework crates we depend on do not cover.
//!
//! # Threading
//!
//! `MacosDesktop` stores nothing; every call constructs its objc objects fresh,
//! because `Retained`/`CFRetained` are `!Send`. Capture bridges ScreenCaptureKit's
//! two completion handlers to an `mpsc` channel carrying only `Send` payloads
//! (`Vec<u8>` + dims), so no `!Send` object crosses the callback thread boundary.

#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::cast_possible_wrap,
    clippy::similar_names,
    clippy::too_many_lines
)]

use core::ffi::{c_ulong, c_void};
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::AnyThread;
use objc2_core_foundation::CGPoint;
use objc2_core_graphics::{
    CGDataProvider, CGDisplayCopyDisplayMode, CGDisplayMode, CGEvent, CGEventSource,
    CGEventSourceStateID, CGEventTapLocation, CGEventType, CGImage, CGMainDisplayID, CGMouseButton,
    CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess, CGScrollEventUnit,
};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSNumber, NSString};
use objc2_screen_capture_kit::{
    SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration, SCWindow,
};

use crate::{
    DisplayInfo, InputEvent, KeyAction, MacFfiError, PointerAction, PointerButton, RgbaFrame,
};

// Accessibility trust lives in ApplicationServices (HIServices), which the objc2
// framework crates we depend on do not wrap. `Boolean` is `unsigned char`, so we
// bind it as `u8` and compare `!= 0` (ABI-exact; avoids the bool-niche question).
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> u8;
}

/// Screen Recording preflight (non-prompting).
pub(super) fn screen_capture_granted() -> bool {
    CGPreflightScreenCaptureAccess()
}

/// Accessibility trust (required for `CGEventPost` delivery).
pub(super) fn accessibility_trusted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

/// Fires the Screen Recording + Accessibility system prompts once.
pub(super) fn request_grants() {
    let _ = CGRequestScreenCaptureAccess();
    // AXIsProcessTrustedWithOptions({ kAXTrustedCheckOptionPrompt: true }). The
    // key's documented value is the literal CFString "AXTrustedCheckOptionPrompt";
    // an NSDictionary is toll-free bridged to CFDictionaryRef, so we build one and
    // pass its pointer — no need to link the extern CFString global.
    let key = NSString::from_str("AXTrustedCheckOptionPrompt");
    let value = NSNumber::numberWithBool(true);
    let options: objc2::rc::Retained<NSDictionary<NSString, NSNumber>> =
        NSDictionary::from_slices(&[&*key], &[&*value]);
    // Toll-free bridge: an NSDictionary* IS a CFDictionaryRef. Pass its object pointer.
    let dict: &NSDictionary<NSString, NSNumber> = &options;
    let ptr = core::ptr::from_ref(dict).cast::<c_void>();
    unsafe {
        let _ = AXIsProcessTrustedWithOptions(ptr);
    }
}

/// Probe the main display for its id + pixel geometry (`None` if Screen Recording
/// is not granted or no mode is available).
pub(super) fn probe_display() -> Option<DisplayInfo> {
    if !CGPreflightScreenCaptureAccess() {
        return None;
    }
    let did = CGMainDisplayID();
    let (width, height) = display_pixel_dims(did)?;
    Some(DisplayInfo {
        id: did.to_string(),
        width,
        height,
    })
}

/// The main display's backing pixel dimensions from its current `CGDisplayMode`.
fn display_pixel_dims(did: u32) -> Option<(u32, u32)> {
    let mode = CGDisplayCopyDisplayMode(did)?;
    let w = CGDisplayMode::pixel_width(Some(&mode));
    let h = CGDisplayMode::pixel_height(Some(&mode));
    if w == 0 || h == 0 {
        None
    } else {
        Some((w as u32, h as u32))
    }
}

/// Per-axis pixel/point scale (backing scale factor) for pixel→point conversion.
fn display_scale(did: u32) -> (f64, f64) {
    if let Some(mode) = CGDisplayCopyDisplayMode(did) {
        let pw = CGDisplayMode::pixel_width(Some(&mode));
        let ph = CGDisplayMode::pixel_height(Some(&mode));
        let ptw = CGDisplayMode::width(Some(&mode));
        let pth = CGDisplayMode::height(Some(&mode));
        let sx = if ptw > 0 { pw as f64 / ptw as f64 } else { 1.0 };
        let sy = if pth > 0 { ph as f64 / pth as f64 } else { 1.0 };
        (sx, sy)
    } else {
        (1.0, 1.0)
    }
}

/// Capture the main display as pixel-sized RGBA via a one-shot `SCScreenshotManager`.
pub(super) fn capture_rgba() -> Result<RgbaFrame, MacFfiError> {
    if !CGPreflightScreenCaptureAccess() {
        return Err(MacFfiError::Ffi(
            "Screen Recording permission is not granted".to_string(),
        ));
    }

    let (tx, rx) = mpsc::channel::<Result<RgbaFrame, String>>();

    // SCShareableContent + SCScreenshotManager both call back on an internal
    // ScreenCaptureKit queue; the closures run there, do the pixel copy, and send
    // the `Send` result (Vec<u8> + dims) back. `outer` stays on this stack until
    // after `recv`, and ScreenCaptureKit `Block_copy`s it for its own use.
    let outer = RcBlock::new(
        move |content: *mut SCShareableContent, _err: *mut NSError| {
            if content.is_null() {
                let _ = tx.send(Err(
                    "no shareable content (Screen Recording denied?)".to_string()
                ));
                return;
            }
            let content: &SCShareableContent = unsafe { &*content };
            capture_from_content(content, &tx);
        },
    );

    unsafe {
        // `&*outer` derefs the RcBlock to `&Block` (= `&DynBlock`) explicitly, so
        // the call never leans on deref-coercion at the argument site.
        SCShareableContent::getShareableContentWithCompletionHandler(&*outer);
    }

    match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(frame)) => Ok(frame),
        Ok(Err(msg)) => Err(MacFfiError::Ffi(msg)),
        Err(_) => Err(MacFfiError::Ffi(
            "capture timed out waiting for ScreenCaptureKit".to_string(),
        )),
    }
}

/// Builds the filter+config for the main display and kicks off the screenshot,
/// wiring its completion handler to `tx`.
fn capture_from_content(
    content: &SCShareableContent,
    tx: &mpsc::Sender<Result<RgbaFrame, String>>,
) {
    let main_id = CGMainDisplayID();
    let displays = unsafe { content.displays() };

    let mut chosen = None;
    for display in displays.iter() {
        if unsafe { display.displayID() } == main_id {
            chosen = Some(display);
            break;
        }
    }
    let display = match chosen.or_else(|| displays.firstObject()) {
        Some(d) => d,
        None => {
            let _ = tx.send(Err("no capturable display found".to_string()));
            return;
        }
    };

    let windows = NSArray::<SCWindow>::new();
    let filter = unsafe {
        SCContentFilter::initWithDisplay_excludingWindows(
            SCContentFilter::alloc(),
            &display,
            &windows,
        )
    };

    let (pw, ph) = display_pixel_dims(main_id).unwrap_or_else(|| {
        let w = unsafe { display.width() };
        let h = unsafe { display.height() };
        (w.max(0) as u32, h.max(0) as u32)
    });

    let config = unsafe { SCStreamConfiguration::new() };
    unsafe {
        config.setWidth(pw as usize);
        config.setHeight(ph as usize);
    }

    let tx2 = tx.clone();
    let inner = RcBlock::new(move |img: *mut CGImage, _err: *mut NSError| {
        if img.is_null() {
            let _ = tx2.send(Err("ScreenCaptureKit returned a null image".to_string()));
            return;
        }
        let image: &CGImage = unsafe { &*img };
        let _ = tx2.send(cgimage_to_rgba(image));
    });

    unsafe {
        SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
            &filter,
            &config,
            // `&*inner` = `&DynBlock`, wrapped in the nullable `Option` the API takes.
            Some(&*inner),
        );
    }
}

/// Convert a captured BGRA `CGImage` to tightly-packed RGBA8, honoring the image's
/// row stride (`bytes_per_row`) exactly like the Linux ZPixmap path.
fn cgimage_to_rgba(image: &CGImage) -> Result<RgbaFrame, String> {
    let width = CGImage::width(Some(image));
    let height = CGImage::height(Some(image));
    let bytes_per_row = CGImage::bytes_per_row(Some(image));

    let provider = CGImage::data_provider(Some(image))
        .ok_or_else(|| "CGImage has no data provider".to_string())?;
    let data = CGDataProvider::data(Some(&provider))
        .ok_or_else(|| "CGDataProvider returned no data".to_string())?;
    // SAFETY: the CFData is alive for the duration of this borrow; we only read it.
    let bytes: &[u8] = unsafe { data.as_bytes_unchecked() };

    let bpp = 4usize;
    let tight = width * bpp;
    let stride = if bytes_per_row >= tight {
        bytes_per_row
    } else {
        tight
    };

    let mut rgba = Vec::with_capacity(width * height * 4);
    for row in 0..height {
        let row_start = row * stride;
        for col in 0..width {
            let off = row_start + col * bpp;
            if off + 3 < bytes.len() {
                // Memory order is B, G, R, A (32-bit little-endian BGRA) → R, G, B, 255.
                rgba.push(bytes[off + 2]);
                rgba.push(bytes[off + 1]);
                rgba.push(bytes[off]);
                rgba.push(0xff);
            } else {
                rgba.extend_from_slice(&[0, 0, 0, 0xff]);
            }
        }
    }

    Ok(RgbaFrame {
        rgba,
        width: width as u32,
        height: height as u32,
    })
}

/// Inject one input event via CGEvent, posted at the HID event tap.
pub(super) fn inject(event: &InputEvent) -> Result<(), MacFfiError> {
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState);
    let src = source.as_deref();
    match event {
        InputEvent::Pointer {
            x,
            y,
            button,
            action,
        } => inject_pointer(src, *x, *y, *button, *action),
        InputEvent::Key {
            text,
            named,
            action,
        } => inject_key(src, text.as_deref(), named.as_deref(), *action),
        InputEvent::Scroll { dx, dy } => inject_scroll(src, *dx, *dy),
    }
}

fn inject_pointer(
    src: Option<&CGEventSource>,
    x: i32,
    y: i32,
    button: PointerButton,
    action: PointerAction,
) -> Result<(), MacFfiError> {
    let (sx, sy) = display_scale(CGMainDisplayID());
    let px = if sx > 0.0 {
        f64::from(x) / sx
    } else {
        f64::from(x)
    };
    let py = if sy > 0.0 {
        f64::from(y) / sy
    } else {
        f64::from(y)
    };
    let point = CGPoint::new(px, py);

    let cg_button = match button {
        PointerButton::Left => CGMouseButton::Left,
        PointerButton::Right => CGMouseButton::Right,
        PointerButton::Middle => CGMouseButton::Center,
    };
    let down_type = match button {
        PointerButton::Left => CGEventType::LeftMouseDown,
        PointerButton::Right => CGEventType::RightMouseDown,
        PointerButton::Middle => CGEventType::OtherMouseDown,
    };
    let up_type = match button {
        PointerButton::Left => CGEventType::LeftMouseUp,
        PointerButton::Right => CGEventType::RightMouseUp,
        PointerButton::Middle => CGEventType::OtherMouseUp,
    };

    // Every action first moves the cursor to the target (updates hover/tracking),
    // mirroring the Linux XTEST motion-then-act ordering.
    post_mouse(src, CGEventType::MouseMoved, point, cg_button)?;
    match action {
        PointerAction::Move => {}
        PointerAction::Down => post_mouse(src, down_type, point, cg_button)?,
        PointerAction::Up => post_mouse(src, up_type, point, cg_button)?,
        PointerAction::Click => {
            post_mouse(src, down_type, point, cg_button)?;
            post_mouse(src, up_type, point, cg_button)?;
        }
        PointerAction::DoubleClick => {
            post_mouse(src, down_type, point, cg_button)?;
            post_mouse(src, up_type, point, cg_button)?;
            post_mouse(src, down_type, point, cg_button)?;
            post_mouse(src, up_type, point, cg_button)?;
        }
    }
    Ok(())
}

fn post_mouse(
    src: Option<&CGEventSource>,
    ty: CGEventType,
    point: CGPoint,
    button: CGMouseButton,
) -> Result<(), MacFfiError> {
    let event = CGEvent::new_mouse_event(src, ty, point, button)
        .ok_or_else(|| MacFfiError::Ffi("CGEventCreateMouseEvent returned null".to_string()))?;
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
    Ok(())
}

/// Clamp on the per-axis line count so a hostile/huge delta cannot flood the tap.
const MAX_SCROLL_LINES: i32 = 100;

fn inject_scroll(src: Option<&CGEventSource>, dx: i32, dy: i32) -> Result<(), MacFfiError> {
    let vertical = dy.clamp(-MAX_SCROLL_LINES, MAX_SCROLL_LINES);
    let horizontal = dx.clamp(-MAX_SCROLL_LINES, MAX_SCROLL_LINES);
    // wheel1 = vertical (+ scrolls up), wheel2 = horizontal. We negate the incoming
    // deltas so a positive "scroll down/right" request moves content down/right.
    let event = CGEvent::new_scroll_wheel_event2(
        src,
        CGScrollEventUnit::Line,
        2,
        -vertical,
        -horizontal,
        0,
    )
    .ok_or_else(|| MacFfiError::Ffi("CGEventCreateScrollWheelEvent2 returned null".to_string()))?;
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
    Ok(())
}

fn inject_key(
    src: Option<&CGEventSource>,
    text: Option<&str>,
    named: Option<&str>,
    action: KeyAction,
) -> Result<(), MacFfiError> {
    if let Some(text) = text {
        for ch in text.chars() {
            type_char(src, ch, action)?;
        }
        return Ok(());
    }
    if let Some(named) = named {
        if let Some(code) = named_key_to_keycode(named) {
            press_keycode(src, code, action)?;
        } else if let Some(ch) = single_char(named) {
            // A single printable "named" key falls through to Unicode typing, the
            // same best-effort posture as the Linux keysym fall-through.
            type_char(src, ch, action)?;
        }
        // An unknown multi-char named key is skipped (best-effort, never a hard error).
    }
    Ok(())
}

/// Type one character via the Unicode-string path (no keycode table needed).
fn type_char(src: Option<&CGEventSource>, ch: char, action: KeyAction) -> Result<(), MacFfiError> {
    let mut buf = [0u16; 2];
    let utf16 = ch.encode_utf16(&mut buf);
    let len = utf16.len() as c_ulong;
    let ptr = utf16.as_ptr();
    match action {
        KeyAction::Down => set_unicode_and_post(src, len, ptr, true),
        KeyAction::Up => set_unicode_and_post(src, len, ptr, false),
        KeyAction::Press => {
            set_unicode_and_post(src, len, ptr, true)?;
            set_unicode_and_post(src, len, ptr, false)
        }
    }
}

fn set_unicode_and_post(
    src: Option<&CGEventSource>,
    len: c_ulong,
    ptr: *const u16,
    down: bool,
) -> Result<(), MacFfiError> {
    // virtual key 0: the character is carried by the Unicode string, not a keycode.
    let event = CGEvent::new_keyboard_event(src, 0, down)
        .ok_or_else(|| MacFfiError::Ffi("CGEventCreateKeyboardEvent returned null".to_string()))?;
    // SAFETY: `ptr` points at a live `[u16]` on the caller's stack that outlives
    // this synchronous call; CGEvent copies the string internally.
    unsafe {
        CGEvent::keyboard_set_unicode_string(Some(&event), len, ptr);
    }
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
    Ok(())
}

fn press_keycode(
    src: Option<&CGEventSource>,
    code: u16,
    action: KeyAction,
) -> Result<(), MacFfiError> {
    match action {
        KeyAction::Down => post_key(src, code, true),
        KeyAction::Up => post_key(src, code, false),
        KeyAction::Press => {
            post_key(src, code, true)?;
            post_key(src, code, false)
        }
    }
}

fn post_key(src: Option<&CGEventSource>, code: u16, down: bool) -> Result<(), MacFfiError> {
    let event = CGEvent::new_keyboard_event(src, code, down)
        .ok_or_else(|| MacFfiError::Ffi("CGEventCreateKeyboardEvent returned null".to_string()))?;
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
    Ok(())
}

/// Maps the named keys the computer-use tool commonly emits to macOS ANSI virtual
/// keycodes (from `<HIToolbox/Events.h>`). Unknown names return `None`.
fn named_key_to_keycode(name: &str) -> Option<u16> {
    let code: u16 = match name {
        "Enter" | "Return" => 0x24,
        "Tab" => 0x30,
        "Space" | " " => 0x31,
        "Backspace" => 0x33,
        "Delete" => 0x75, // forward delete (matches the Linux "Delete" → forward-delete)
        "Escape" | "Esc" => 0x35,
        "ArrowLeft" | "Left" => 0x7B,
        "ArrowRight" | "Right" => 0x7C,
        "ArrowDown" | "Down" => 0x7D,
        "ArrowUp" | "Up" => 0x7E,
        "Home" => 0x73,
        "End" => 0x77,
        "PageUp" => 0x74,
        "PageDown" => 0x79,
        _ => return None,
    };
    Some(code)
}

/// Returns the single `char` of a one-character string, else `None`.
fn single_char(s: &str) -> Option<char> {
    let mut it = s.chars();
    let c = it.next()?;
    if it.next().is_none() {
        Some(c)
    } else {
        None
    }
}
