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
//! ScreenCaptureKit calls construct native objects locally and bridge their two
//! completion handlers to an `mpsc` channel carrying only `Send` payloads
//! (`Vec<u8>` + dimensions). Stateful AX objects live only inside one dedicated
//! worker/run loop per process; callers exchange plain safe snapshots/selectors.
//! No retained native object crosses its owning thread boundary.

#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::cast_possible_wrap,
    clippy::similar_names,
    clippy::too_many_lines
)]

use core::ffi::{c_ulong, c_void};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

mod ax;
mod ax_element;
mod input_monitor;
mod stream;

use block2::RcBlock;
use core_foundation::base::{CFType, TCFType as _};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::string::CFString;
use objc2::AnyThread;
use objc2_core_foundation::{CFRetained, CGPoint};
use objc2_core_graphics::{
    CGDataProvider, CGDisplayBounds, CGDisplayPixelsHigh, CGDisplayPixelsWide, CGError, CGEvent,
    CGEventField, CGEventFlags, CGEventSource, CGEventSourceStateID, CGEventTapLocation,
    CGEventType, CGGetActiveDisplayList, CGImage, CGMainDisplayID, CGMouseButton,
    CGPreflightListenEventAccess, CGPreflightScreenCaptureAccess, CGRequestListenEventAccess,
    CGRequestScreenCaptureAccess, CGScrollEventUnit,
};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSNumber, NSString};
use objc2_screen_capture_kit::{
    SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration, SCWindow,
};

use crate::{
    DisplayInfo, InputEvent, KeyAction, MacFfiError, MacRect, MacTargetInfo, MacWindowFrame,
    PointerAction, PointerButton, RgbaFrame,
};

pub(crate) use ax::MacAxControllerImpl;
use input_monitor::{input_activity_monitor, InputActivityMonitor};
pub(crate) use stream::CaptureStream;

const MAX_CAPTURE_PIXELS: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone)]
pub(super) struct ShareableWindow {
    pub(super) window_id: u32,
    pub(super) process_id: u32,
    pub(super) application_id: Option<String>,
    pub(super) application_name: String,
    pub(super) title: String,
    pub(super) bounds: MacRect,
    pub(super) focused: bool,
    pub(super) on_screen: bool,
}

// Accessibility trust lives in ApplicationServices (HIServices), which the objc2
// framework crates we depend on do not wrap. `Boolean` is `unsigned char`, so we
// bind it as `u8` and compare `!= 0` (ABI-exact; avoids the bool-niche question).
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> u8;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
}

/// Screen Recording preflight (non-prompting).
pub(super) fn screen_capture_granted() -> bool {
    CGPreflightScreenCaptureAccess()
}

/// Accessibility trust (required for `CGEventPost` delivery).
pub(super) fn accessibility_trusted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

pub(super) fn input_monitoring_granted() -> bool {
    CGPreflightListenEventAccess()
}

pub(super) fn machine_locked() -> Result<bool, MacFfiError> {
    let raw = unsafe { CGSessionCopyCurrentDictionary() };
    if raw.is_null() {
        return Err(MacFfiError::Ffi(
            "CoreGraphics returned no current login-session state".to_string(),
        ));
    }
    let session: CFDictionary<CFString, CFType> =
        unsafe { CFDictionary::wrap_under_create_rule(raw) };
    let key = CFString::new("CGSSessionScreenIsLocked");
    Ok(session
        .find(&key)
        .and_then(|value| value.downcast::<CFBoolean>())
        .is_some_and(bool::from))
}

/// Fires the Screen Recording + Accessibility system prompts once.
pub(super) fn request_grants() {
    let _ = CGRequestScreenCaptureAccess();
    let _ = CGRequestListenEventAccess();
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

const MAX_ACTIVE_DISPLAYS: usize = 32;

/// Enumerate every active physical/virtual display and its exact global logical
/// placement. CoreGraphics exposes this without Screen Recording permission.
pub(super) fn list_displays() -> Result<Vec<DisplayInfo>, MacFfiError> {
    let mut ids = [0_u32; MAX_ACTIVE_DISPLAYS];
    let mut count = 0_u32;
    let result = unsafe {
        CGGetActiveDisplayList(
            u32::try_from(ids.len()).expect("display envelope fits u32"),
            ids.as_mut_ptr(),
            &raw mut count,
        )
    };
    if result != CGError::Success {
        return Err(MacFfiError::Ffi(format!(
            "CGGetActiveDisplayList failed with code {}",
            result.0
        )));
    }
    let count = usize::try_from(count)
        .unwrap_or(MAX_ACTIVE_DISPLAYS)
        .min(MAX_ACTIVE_DISPLAYS);
    let main = CGMainDisplayID();
    let mut displays = Vec::with_capacity(count);
    for did in ids.into_iter().take(count) {
        let Some((width, height)) = display_pixel_dims(did) else {
            continue;
        };
        let bounds = CGDisplayBounds(did);
        if !bounds.origin.x.is_finite()
            || !bounds.origin.y.is_finite()
            || !bounds.size.width.is_finite()
            || !bounds.size.height.is_finite()
            || bounds.size.width <= 0.0
            || bounds.size.height <= 0.0
        {
            continue;
        }
        displays.push(DisplayInfo {
            id: did.to_string(),
            width,
            height,
            point_width: bounds.size.width,
            point_height: bounds.size.height,
            point_x: bounds.origin.x,
            point_y: bounds.origin.y,
            is_main: did == main,
        });
    }
    displays.sort_by(|left, right| {
        right
            .is_main
            .cmp(&left.is_main)
            .then_with(|| left.point_y.total_cmp(&right.point_y))
            .then_with(|| left.point_x.total_cmp(&right.point_x))
            .then_with(|| left.id.cmp(&right.id))
    });
    if displays.is_empty() {
        return Err(MacFfiError::Ffi(
            "CoreGraphics reported no usable active displays".to_string(),
        ));
    }
    Ok(displays)
}

/// Probe the main display for legacy framebuffer consumers (`None` if Screen
/// Recording is not granted or no current display is available).
pub(super) fn probe_display() -> Option<DisplayInfo> {
    if !CGPreflightScreenCaptureAccess() {
        return None;
    }
    list_displays()
        .ok()?
        .into_iter()
        .find(|display| display.is_main)
}

/// Backing pixel dimensions of one active display.
fn display_pixel_dims(did: u32) -> Option<(u32, u32)> {
    let w = CGDisplayPixelsWide(did);
    let h = CGDisplayPixelsHigh(did);
    if w == 0 || h == 0 {
        None
    } else {
        Some((w as u32, h as u32))
    }
}

/// Per-axis pixel/point scale (backing scale factor) for pixel→point conversion.
fn display_scale(did: u32) -> (f64, f64) {
    if let Some((pw, ph)) = display_pixel_dims(did) {
        let bounds = CGDisplayBounds(did);
        let sx = if bounds.size.width > 0.0 {
            f64::from(pw) / bounds.size.width
        } else {
            1.0
        };
        let sy = if bounds.size.height > 0.0 {
            f64::from(ph) / bounds.size.height
        } else {
            1.0
        };
        (sx, sy)
    } else {
        (1.0, 1.0)
    }
}

pub(super) fn list_targets() -> Result<Vec<MacTargetInfo>, MacFfiError> {
    let windows = if CGPreflightScreenCaptureAccess() {
        shareable_windows()?
    } else {
        Vec::new()
    };
    Ok(ax::list_targets(&windows))
}

fn shareable_windows() -> Result<Vec<ShareableWindow>, MacFfiError> {
    let (tx, rx) = mpsc::channel::<Result<Vec<ShareableWindow>, String>>();
    let block = RcBlock::new(
        move |content: *mut SCShareableContent, _error: *mut NSError| {
            if content.is_null() {
                let _ = tx.send(Err(
                    "ScreenCaptureKit returned no shareable content".to_string()
                ));
                return;
            }
            let content: &SCShareableContent = unsafe { &*content };
            let windows = unsafe { content.windows() };
            let mut plain = Vec::new();
            for window in &windows {
                let Some(application) = (unsafe { window.owningApplication() }) else {
                    continue;
                };
                let process_id = unsafe { application.processID() };
                if process_id <= 0 || unsafe { window.windowLayer() } != 0 {
                    continue;
                }
                let frame = unsafe { window.frame() };
                if !frame.origin.x.is_finite()
                    || !frame.origin.y.is_finite()
                    || !frame.size.width.is_finite()
                    || !frame.size.height.is_finite()
                    || frame.size.width <= 1.0
                    || frame.size.height <= 1.0
                {
                    continue;
                }
                let Ok(process_id) = u32::try_from(process_id) else {
                    continue;
                };
                let application_name = unsafe { application.applicationName() }.to_string();
                let application_id = {
                    let value = unsafe { application.bundleIdentifier() }.to_string();
                    (!value.is_empty()).then_some(value)
                };
                let title = unsafe { window.title() }
                    .map_or_else(|| application_name.clone(), |value| value.to_string());
                plain.push(ShareableWindow {
                    window_id: unsafe { window.windowID() },
                    process_id,
                    application_id,
                    application_name,
                    title,
                    bounds: MacRect {
                        x: frame.origin.x,
                        y: frame.origin.y,
                        width: frame.size.width,
                        height: frame.size.height,
                    },
                    focused: unsafe { window.isActive() },
                    on_screen: unsafe { window.isOnScreen() },
                });
            }
            let _ = tx.send(Ok(plain));
        },
    );
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
            true, false, &block,
        );
    }
    match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(windows)) => Ok(windows),
        Ok(Err(message)) => Err(MacFfiError::Ffi(message)),
        Err(_) => Err(MacFfiError::TimedOut(
            "window discovery waited more than 15 seconds for ScreenCaptureKit".to_string(),
        )),
    }
}

pub(super) fn focus_target(target: &MacTargetInfo) -> Result<(), MacFfiError> {
    ax::focus_target(target)
}

pub(super) fn launch_application(application_id: &str) -> Result<(), MacFfiError> {
    ax::launch_application(application_id)
}

pub(super) fn run_background_application(
    application_bundle: &str,
    arguments: &[String],
    pid_file: Option<&std::path::Path>,
) -> Result<(), MacFfiError> {
    ax::run_background_application(application_bundle, arguments, pid_file)
}

/// Capture the main display as pixel-sized RGBA via a one-shot `SCScreenshotManager`.
pub(super) fn capture_rgba() -> Result<RgbaFrame, MacFfiError> {
    capture_display_rgba(CGMainDisplayID())
}

pub(super) fn capture_display_rgba(display_id: u32) -> Result<RgbaFrame, MacFfiError> {
    capture_display_rgba_sized(display_id, None)
}

pub(super) fn capture_display_rgba_sized(
    display_id: u32,
    max_size: Option<(u32, u32)>,
) -> Result<RgbaFrame, MacFfiError> {
    if !CGPreflightScreenCaptureAccess() {
        return Err(MacFfiError::PermissionDenied(
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
            capture_from_content(content, display_id, max_size, &tx);
        },
    );

    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
            true, false, &outer,
        );
    }

    match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(frame)) => Ok(frame),
        Ok(Err(message)) if message == "display not found" => {
            Err(MacFfiError::TargetStale(message))
        }
        Ok(Err(msg)) => Err(MacFfiError::Ffi(msg)),
        Err(_) => Err(MacFfiError::TimedOut(
            "capture timed out waiting for ScreenCaptureKit".to_string(),
        )),
    }
}

pub(super) fn capture_window_rgba(
    window_id: u32,
    expected_process_id: u32,
) -> Result<MacWindowFrame, MacFfiError> {
    capture_window_rgba_sized(window_id, expected_process_id, None)
}

pub(super) fn capture_window_rgba_sized(
    window_id: u32,
    expected_process_id: u32,
    max_size: Option<(u32, u32)>,
) -> Result<MacWindowFrame, MacFfiError> {
    if !CGPreflightScreenCaptureAccess() {
        return Err(MacFfiError::PermissionDenied(
            "Screen Recording permission is required for window capture".to_string(),
        ));
    }

    let (tx, rx) = mpsc::channel::<Result<MacWindowFrame, String>>();
    let outer = RcBlock::new(
        move |content: *mut SCShareableContent, _error: *mut NSError| {
            if content.is_null() {
                let _ = tx.send(Err(
                    "ScreenCaptureKit returned no shareable content".to_string()
                ));
                return;
            }
            let content: &SCShareableContent = unsafe { &*content };
            capture_window_from_content(content, window_id, expected_process_id, max_size, &tx);
        },
    );
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
            true, false, &outer,
        );
    }
    match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(frame)) => Ok(frame),
        Ok(Err(message)) if message == "window not found" => Err(MacFfiError::TargetStale(message)),
        Ok(Err(message)) => Err(MacFfiError::Ffi(message)),
        Err(_) => Err(MacFfiError::TimedOut(
            "window capture waited more than 15 seconds for ScreenCaptureKit".to_string(),
        )),
    }
}

fn capture_window_from_content(
    content: &SCShareableContent,
    window_id: u32,
    expected_process_id: u32,
    max_size: Option<(u32, u32)>,
    tx: &mpsc::Sender<Result<MacWindowFrame, String>>,
) {
    let windows = unsafe { content.windows() };
    let Some(window) = windows
        .iter()
        .find(|window| unsafe { window.windowID() } == window_id)
    else {
        let _ = tx.send(Err("window not found".to_string()));
        return;
    };
    let process_matches = unsafe { window.owningApplication() }
        .and_then(|application| u32::try_from(unsafe { application.processID() }).ok())
        .is_some_and(|process_id| process_id == expected_process_id);
    if !process_matches {
        let _ = tx.send(Err("window not found".to_string()));
        return;
    }
    let rect = unsafe { window.frame() };
    if !rect.size.width.is_finite()
        || !rect.size.height.is_finite()
        || rect.size.width <= 0.0
        || rect.size.height <= 0.0
    {
        let _ = tx.send(Err("window has invalid capture geometry".to_string()));
        return;
    }
    let bounds = MacRect {
        x: rect.origin.x,
        y: rect.origin.y,
        width: rect.size.width,
        height: rect.size.height,
    };
    let (scale_x, scale_y) = window_backing_scale(content, bounds);
    let native_width = (bounds.width * scale_x).ceil().max(1.0) as u32;
    let native_height = (bounds.height * scale_y).ceil().max(1.0) as u32;
    let (pixel_width, pixel_height) = fit_capture_size(native_width, native_height, max_size);
    let pixel_width = pixel_width as usize;
    let pixel_height = pixel_height as usize;
    if pixel_width
        .checked_mul(pixel_height)
        .is_none_or(|pixels| pixels > MAX_CAPTURE_PIXELS)
    {
        let _ = tx.send(Err(
            "window capture exceeds the 64 megapixel envelope".to_string()
        ));
        return;
    }

    let filter = unsafe {
        SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window)
    };
    let config = unsafe { SCStreamConfiguration::new() };
    unsafe {
        config.setWidth(pixel_width);
        config.setHeight(pixel_height);
        config.setShowsCursor(false);
    }
    let tx2 = tx.clone();
    let inner = RcBlock::new(move |image: *mut CGImage, _error: *mut NSError| {
        if image.is_null() {
            let _ = tx2.send(Err(
                "ScreenCaptureKit returned a null window image".to_string()
            ));
            return;
        }
        let image: &CGImage = unsafe { &*image };
        let result = cgimage_to_rgba(image).map(|frame| MacWindowFrame {
            window_id,
            bounds,
            frame,
        });
        let _ = tx2.send(result);
    });
    unsafe {
        SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
            &filter,
            &config,
            Some(&*inner),
        );
    }
}

fn window_backing_scale(content: &SCShareableContent, window: MacRect) -> (f64, f64) {
    let displays = unsafe { content.displays() };
    let mut best = None;
    for display in &displays {
        let frame = unsafe { display.frame() };
        let overlap_width = (window.x + window.width).min(frame.origin.x + frame.size.width)
            - window.x.max(frame.origin.x);
        let overlap_height = (window.y + window.height).min(frame.origin.y + frame.size.height)
            - window.y.max(frame.origin.y);
        let area = overlap_width.max(0.0) * overlap_height.max(0.0);
        if area <= 0.0 {
            continue;
        }
        let display_id = unsafe { display.displayID() };
        let (pixel_width, pixel_height) = display_pixel_dims(display_id).unwrap_or((
            unsafe { display.width() }.max(1) as u32,
            unsafe { display.height() }.max(1) as u32,
        ));
        let point_width = frame.size.width.max(1.0);
        let point_height = frame.size.height.max(1.0);
        let candidate = (
            area,
            f64::from(pixel_width) / point_width,
            f64::from(pixel_height) / point_height,
        );
        if best.is_none_or(|(best_area, _, _)| area > best_area) {
            best = Some(candidate);
        }
    }
    best.map_or((1.0, 1.0), |(_, x, y)| (x.max(1.0), y.max(1.0)))
}

/// Builds the filter+config for one exact display and kicks off the screenshot,
/// wiring its completion handler to `tx`.
fn capture_from_content(
    content: &SCShareableContent,
    display_id: u32,
    max_size: Option<(u32, u32)>,
    tx: &mpsc::Sender<Result<RgbaFrame, String>>,
) {
    let displays = unsafe { content.displays() };

    let mut chosen = None;
    for display in &displays {
        if unsafe { display.displayID() } == display_id {
            chosen = Some(display);
            break;
        }
    }
    let Some(display) = chosen else {
        let _ = tx.send(Err("display not found".to_string()));
        return;
    };

    let windows = NSArray::<SCWindow>::new();
    let filter = unsafe {
        SCContentFilter::initWithDisplay_excludingWindows(
            SCContentFilter::alloc(),
            &display,
            &windows,
        )
    };

    let (native_width, native_height) = display_pixel_dims(display_id).unwrap_or_else(|| {
        let w = unsafe { display.width() };
        let h = unsafe { display.height() };
        (w.max(0) as u32, h.max(0) as u32)
    });
    let (pw, ph) = fit_capture_size(native_width, native_height, max_size);

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

fn fit_capture_size(width: u32, height: u32, max_size: Option<(u32, u32)>) -> (u32, u32) {
    let Some((max_width, max_height)) = max_size else {
        return (width, height);
    };
    if width <= max_width && height <= max_height {
        return (width, height);
    }
    let scale =
        (f64::from(max_width) / f64::from(width)).min(f64::from(max_height) / f64::from(height));
    (
        (f64::from(width) * scale).floor().max(1.0) as u32,
        (f64::from(height) * scale).floor().max(1.0) as u32,
    )
}

/// Convert a captured BGRA `CGImage` to tightly-packed RGBA8, honoring the image's
/// row stride (`bytes_per_row`) exactly like the Linux ZPixmap path.
fn cgimage_to_rgba(image: &CGImage) -> Result<RgbaFrame, String> {
    let width = CGImage::width(Some(image));
    let height = CGImage::height(Some(image));
    let bytes_per_row = CGImage::bytes_per_row(Some(image));
    let pixels = width
        .checked_mul(height)
        .ok_or_else(|| "captured image dimensions overflow".to_string())?;
    if pixels == 0 || pixels > MAX_CAPTURE_PIXELS {
        return Err("captured image exceeds the 64 megapixel envelope".to_string());
    }

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

    let capacity = pixels
        .checked_mul(4)
        .ok_or_else(|| "captured RGBA size overflows".to_string())?;
    let mut rgba = Vec::with_capacity(capacity);
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

const MAX_INPUT_BATCH: usize = 16;
const MAX_TEXT_UTF16_UNITS: usize = 16 * 1024;
const MAX_PREPARED_EVENTS: usize = 128;
const INPUT_CONFIRM_TIMEOUT: Duration = Duration::from_millis(250);
const INPUT_CONFIRM_POLL: Duration = Duration::from_millis(1);

static INPUT_SEAT: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy)]
struct WindowInputGeometry {
    logical_bounds: MacRect,
    frame_width: u32,
    frame_height: u32,
}

struct PreparedInput {
    events: Vec<CFRetained<CGEvent>>,
    monitor: InputActivityMonitor,
    external_generation: u64,
}

/// Inject one input event via CGEvent, posted at the HID event tap.
pub(super) fn inject(event: &InputEvent) -> Result<(), MacFfiError> {
    inject_batch(std::slice::from_ref(event))
}

/// Validate and construct an entire bounded input operation before posting any
/// native event. `CGEventPost` has no failure return, so once posting begins the
/// prepared operation contains no remaining fallible work.
pub(super) fn inject_batch(events: &[InputEvent]) -> Result<(), MacFfiError> {
    let _seat = lock_input_seat()?;
    let prepared = prepare_batch(events, None)?;
    post_prepared(&prepared)
}

pub(super) fn inject_display_batch(
    display: &DisplayInfo,
    frame_width: u32,
    frame_height: u32,
    events: &[InputEvent],
) -> Result<(), MacFfiError> {
    let _seat = lock_input_seat()?;
    let prepared = prepare_batch(
        events,
        Some(WindowInputGeometry {
            logical_bounds: MacRect {
                x: display.point_x,
                y: display.point_y,
                width: display.point_width,
                height: display.point_height,
            },
            frame_width,
            frame_height,
        }),
    )?;
    post_prepared(&prepared)
}

pub(super) fn inject_window(
    event: &InputEvent,
    logical_bounds: MacRect,
    frame_width: u32,
    frame_height: u32,
) -> Result<(), MacFfiError> {
    let _seat = lock_input_seat()?;
    let prepared = prepare_batch(
        std::slice::from_ref(event),
        Some(WindowInputGeometry {
            logical_bounds,
            frame_width,
            frame_height,
        }),
    )?;
    post_prepared(&prepared)
}

pub(super) fn inject_window_batch(
    events: &[InputEvent],
    logical_bounds: MacRect,
    frame_width: u32,
    frame_height: u32,
) -> Result<(), MacFfiError> {
    let _seat = lock_input_seat()?;
    let prepared = prepare_batch(
        events,
        Some(WindowInputGeometry {
            logical_bounds,
            frame_width,
            frame_height,
        }),
    )?;
    post_prepared(&prepared)
}

pub(super) fn focus_and_inject_window(
    target: &MacTargetInfo,
    expected_bounds: MacRect,
    frame_width: u32,
    frame_height: u32,
    inputs: &[InputEvent],
) -> Result<(), MacFfiError> {
    let _seat = lock_input_seat()?;
    // Build the whole operation against the exact captured frame before focus
    // changes foreground state. Construction failures are therefore definite
    // pre-dispatch failures rather than ambiguous partial input.
    let prepared = prepare_batch(
        inputs,
        Some(WindowInputGeometry {
            logical_bounds: expected_bounds,
            frame_width,
            frame_height,
        }),
    )?;
    ax::focus_target(target)?;
    let current = ax::current_target_bounds(target).map_err(|error| {
        MacFfiError::OutcomeUnknown(format!(
            "window was focused but its placement could not be rechecked: {error}"
        ))
    })?;
    if !rect_nearly_equal(current, expected_bounds, 2.0) {
        return Err(MacFfiError::OutcomeUnknown(
            "window was focused but moved or resized after its captured frame".to_string(),
        ));
    }
    ensure_accessibility().map_err(|error| {
        MacFfiError::OutcomeUnknown(format!(
            "window was focused but Accessibility permission changed before input: {error}"
        ))
    })?;
    post_prepared(&prepared)
}

pub(super) fn focus_and_inject_target(
    target: &MacTargetInfo,
    inputs: &[InputEvent],
) -> Result<(), MacFfiError> {
    let _seat = lock_input_seat()?;
    let prepared = prepare_batch(inputs, None)?;
    ax::focus_target(target)?;
    ensure_accessibility().map_err(|error| {
        MacFfiError::OutcomeUnknown(format!(
            "target was focused but Accessibility permission changed before input: {error}"
        ))
    })?;
    post_prepared(&prepared)
}

fn lock_input_seat() -> Result<std::sync::MutexGuard<'static, ()>, MacFfiError> {
    INPUT_SEAT
        .lock()
        .map_err(|_| MacFfiError::Ffi("macOS synthetic-input seat lock was poisoned".to_string()))
}

fn rect_nearly_equal(left: MacRect, right: MacRect, tolerance: f64) -> bool {
    (left.x - right.x).abs() <= tolerance
        && (left.y - right.y).abs() <= tolerance
        && (left.width - right.width).abs() <= tolerance
        && (left.height - right.height).abs() <= tolerance
}

fn valid_rect(rect: MacRect) -> bool {
    rect.x.is_finite()
        && rect.y.is_finite()
        && rect.width.is_finite()
        && rect.height.is_finite()
        && rect.width > 0.0
        && rect.height > 0.0
}

fn ensure_accessibility() -> Result<(), MacFfiError> {
    if accessibility_trusted() {
        Ok(())
    } else {
        Err(MacFfiError::PermissionDenied(
            "Accessibility permission is required for CGEvent input".to_string(),
        ))
    }
}

fn prepare_batch(
    inputs: &[InputEvent],
    window: Option<WindowInputGeometry>,
) -> Result<PreparedInput, MacFfiError> {
    if inputs.is_empty() || inputs.len() > MAX_INPUT_BATCH {
        return Err(MacFfiError::Invalid(format!(
            "input batch must contain between 1 and {MAX_INPUT_BATCH} events"
        )));
    }
    if let Some(geometry) = window {
        if !valid_rect(geometry.logical_bounds)
            || geometry.frame_width == 0
            || geometry.frame_height == 0
        {
            return Err(MacFfiError::Invalid(
                "window input requires finite positive capture geometry".to_string(),
            ));
        }
    }
    ensure_accessibility()?;
    let monitor = input_activity_monitor()?;
    let external_generation = monitor.external_generation()?;
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState);
    let src = source.as_deref();
    let mut prepared = Vec::new();
    for input in inputs {
        prepare_input(src, input, window, &mut prepared)?;
        if prepared.len() > MAX_PREPARED_EVENTS {
            return Err(MacFfiError::Invalid(format!(
                "input operation expands beyond {MAX_PREPARED_EVENTS} native events"
            )));
        }
    }
    let marker = monitor.marker();
    for event in &prepared {
        CGEvent::set_integer_value_field(Some(event), CGEventField::EventSourceUserData, marker);
    }
    Ok(PreparedInput {
        events: prepared,
        monitor,
        external_generation,
    })
}

fn prepare_input(
    src: Option<&CGEventSource>,
    input: &InputEvent,
    window: Option<WindowInputGeometry>,
    prepared: &mut Vec<CFRetained<CGEvent>>,
) -> Result<(), MacFfiError> {
    match input {
        InputEvent::Pointer {
            x,
            y,
            button,
            action,
        } => prepare_pointer(
            src,
            pointer_point(*x, *y, window)?,
            *button,
            *action,
            prepared,
        ),
        InputEvent::Key {
            text,
            named,
            action,
        } => prepare_key(src, text.as_deref(), named.as_deref(), *action, prepared),
        InputEvent::Scroll { dx, dy } => {
            prepared.push(prepare_scroll(src, *dx, *dy)?);
            Ok(())
        }
    }
}

fn pointer_point(
    x: i32,
    y: i32,
    window: Option<WindowInputGeometry>,
) -> Result<CGPoint, MacFfiError> {
    if let Some(geometry) = window {
        if x < 0
            || y < 0
            || u32::try_from(x).map_or(true, |x| x >= geometry.frame_width)
            || u32::try_from(y).map_or(true, |y| y >= geometry.frame_height)
        {
            return Err(MacFfiError::Invalid(
                "window pointer coordinate is outside its exact captured frame".to_string(),
            ));
        }
        return Ok(CGPoint::new(
            geometry.logical_bounds.x
                + f64::from(x) * geometry.logical_bounds.width / f64::from(geometry.frame_width),
            geometry.logical_bounds.y
                + f64::from(y) * geometry.logical_bounds.height / f64::from(geometry.frame_height),
        ));
    }
    let (sx, sy) = display_scale(CGMainDisplayID());
    Ok(CGPoint::new(
        if sx > 0.0 {
            f64::from(x) / sx
        } else {
            f64::from(x)
        },
        if sy > 0.0 {
            f64::from(y) / sy
        } else {
            f64::from(y)
        },
    ))
}

fn prepare_pointer(
    src: Option<&CGEventSource>,
    point: CGPoint,
    button: PointerButton,
    action: PointerAction,
    prepared: &mut Vec<CFRetained<CGEvent>>,
) -> Result<(), MacFfiError> {
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
    prepared.push(prepare_mouse(
        src,
        CGEventType::MouseMoved,
        point,
        cg_button,
        0,
    )?);
    match action {
        PointerAction::Move => {}
        PointerAction::Down => prepared.push(prepare_mouse(src, down_type, point, cg_button, 1)?),
        PointerAction::Up => prepared.push(prepare_mouse(src, up_type, point, cg_button, 1)?),
        PointerAction::Click => {
            prepared.push(prepare_mouse(src, down_type, point, cg_button, 1)?);
            prepared.push(prepare_mouse(src, up_type, point, cg_button, 1)?);
        }
        PointerAction::DoubleClick => {
            prepared.push(prepare_mouse(src, down_type, point, cg_button, 1)?);
            prepared.push(prepare_mouse(src, up_type, point, cg_button, 1)?);
            prepared.push(prepare_mouse(src, down_type, point, cg_button, 2)?);
            prepared.push(prepare_mouse(src, up_type, point, cg_button, 2)?);
        }
    }
    Ok(())
}

fn prepare_mouse(
    src: Option<&CGEventSource>,
    ty: CGEventType,
    point: CGPoint,
    button: CGMouseButton,
    click_state: i64,
) -> Result<CFRetained<CGEvent>, MacFfiError> {
    let event = CGEvent::new_mouse_event(src, ty, point, button)
        .ok_or_else(|| MacFfiError::Ffi("CGEventCreateMouseEvent returned null".to_string()))?;
    if click_state > 0 {
        CGEvent::set_integer_value_field(
            Some(&event),
            CGEventField::MouseEventClickState,
            click_state,
        );
    }
    Ok(event)
}

/// Clamp on the per-axis line count so a hostile/huge delta cannot flood the tap.
const MAX_SCROLL_LINES: i32 = 100;

fn prepare_scroll(
    src: Option<&CGEventSource>,
    dx: i32,
    dy: i32,
) -> Result<CFRetained<CGEvent>, MacFfiError> {
    let vertical = dy.clamp(-MAX_SCROLL_LINES, MAX_SCROLL_LINES);
    let horizontal = dx.clamp(-MAX_SCROLL_LINES, MAX_SCROLL_LINES);
    // wheel1 = vertical (+ scrolls up), wheel2 = horizontal. We negate the incoming
    // deltas so a positive "scroll down/right" request moves content down/right.
    CGEvent::new_scroll_wheel_event2(src, CGScrollEventUnit::Line, 2, -vertical, -horizontal, 0)
        .ok_or_else(|| MacFfiError::Ffi("CGEventCreateScrollWheelEvent2 returned null".to_string()))
}

fn prepare_key(
    src: Option<&CGEventSource>,
    text: Option<&str>,
    named: Option<&str>,
    action: KeyAction,
    prepared: &mut Vec<CFRetained<CGEvent>>,
) -> Result<(), MacFfiError> {
    match (text, named) {
        (Some(text), None) => prepare_text(src, text, action, prepared),
        (None, Some(named)) => prepare_named_key(src, named, action, prepared),
        _ => Err(MacFfiError::Invalid(
            "key input requires exactly one of text or named".to_string(),
        )),
    }
}

fn prepare_text(
    src: Option<&CGEventSource>,
    text: &str,
    action: KeyAction,
    prepared: &mut Vec<CFRetained<CGEvent>>,
) -> Result<(), MacFfiError> {
    if text.is_empty() {
        return Err(MacFfiError::Invalid(
            "typed text cannot be empty".to_string(),
        ));
    }
    let utf16: Vec<u16> = text.encode_utf16().collect();
    if utf16.len() > MAX_TEXT_UTF16_UNITS {
        return Err(MacFfiError::Invalid(format!(
            "typed text exceeds {MAX_TEXT_UTF16_UNITS} UTF-16 units"
        )));
    }
    match action {
        KeyAction::Down => prepared.push(prepare_unicode_event(src, &utf16, true)?),
        KeyAction::Up => prepared.push(prepare_unicode_event(src, &utf16, false)?),
        KeyAction::Press => {
            prepared.push(prepare_unicode_event(src, &utf16, true)?);
            prepared.push(prepare_unicode_event(src, &utf16, false)?);
        }
    }
    Ok(())
}

fn prepare_unicode_event(
    src: Option<&CGEventSource>,
    utf16: &[u16],
    down: bool,
) -> Result<CFRetained<CGEvent>, MacFfiError> {
    // virtual key 0: the character is carried by the Unicode string, not a keycode.
    let event = CGEvent::new_keyboard_event(src, 0, down)
        .ok_or_else(|| MacFfiError::Ffi("CGEventCreateKeyboardEvent returned null".to_string()))?;
    let len = c_ulong::try_from(utf16.len()).map_err(|_| {
        MacFfiError::Invalid("typed text length overflows UniCharCount".to_string())
    })?;
    // SAFETY: the slice is alive for this synchronous call; CGEvent copies the
    // Unicode string into its retained event object.
    unsafe {
        CGEvent::keyboard_set_unicode_string(Some(&event), len, utf16.as_ptr());
    }
    Ok(event)
}

#[derive(Debug, Clone, Copy)]
struct KeyStroke {
    code: u16,
    flags: CGEventFlags,
    modifier: Option<CGEventFlags>,
}

fn prepare_named_key(
    src: Option<&CGEventSource>,
    named: &str,
    action: KeyAction,
    prepared: &mut Vec<CFRetained<CGEvent>>,
) -> Result<(), MacFfiError> {
    let strokes = parse_key_chord(named)?;
    match action {
        KeyAction::Down => {
            for stroke in &strokes {
                prepared.push(prepare_keycode(src, stroke.code, true, stroke.flags)?);
            }
        }
        KeyAction::Up => {
            for stroke in strokes.iter().rev() {
                prepared.push(prepare_keycode(
                    src,
                    stroke.code,
                    false,
                    released_flags(*stroke),
                )?);
            }
        }
        KeyAction::Press => {
            for stroke in &strokes {
                prepared.push(prepare_keycode(src, stroke.code, true, stroke.flags)?);
            }
            for stroke in strokes.iter().rev() {
                prepared.push(prepare_keycode(
                    src,
                    stroke.code,
                    false,
                    released_flags(*stroke),
                )?);
            }
        }
    }
    Ok(())
}

fn released_flags(stroke: KeyStroke) -> CGEventFlags {
    stroke
        .modifier
        .map_or(stroke.flags, |modifier| stroke.flags.difference(modifier))
}

fn prepare_keycode(
    src: Option<&CGEventSource>,
    code: u16,
    down: bool,
    flags: CGEventFlags,
) -> Result<CFRetained<CGEvent>, MacFfiError> {
    let event = CGEvent::new_keyboard_event(src, code, down)
        .ok_or_else(|| MacFfiError::Ffi("CGEventCreateKeyboardEvent returned null".to_string()))?;
    CGEvent::set_flags(Some(&event), flags);
    Ok(event)
}

fn parse_key_chord(named: &str) -> Result<Vec<KeyStroke>, MacFfiError> {
    let parts: Vec<&str> = named.split('+').map(str::trim).collect();
    if parts.is_empty() || parts.iter().any(|part| part.is_empty()) {
        return Err(MacFfiError::Invalid(
            "named key/chord contains an empty component".to_string(),
        ));
    }
    let mut flags = CGEventFlags::empty();
    let mut strokes = Vec::with_capacity(parts.len());
    let mut base_seen = false;
    for (index, part) in parts.iter().enumerate() {
        if let Some((code, flag)) = modifier_key(part) {
            if base_seen || strokes.iter().any(|stroke: &KeyStroke| stroke.code == code) {
                return Err(MacFfiError::Invalid(format!(
                    "invalid or repeated modifier in key chord `{named}`"
                )));
            }
            flags.insert(flag);
            strokes.push(KeyStroke {
                code,
                flags,
                modifier: Some(flag),
            });
            continue;
        }
        if base_seen || index + 1 != parts.len() {
            return Err(MacFfiError::Invalid(format!(
                "key chord `{named}` must end with exactly one non-modifier key"
            )));
        }
        let code = named_key_to_keycode(part)
            .ok_or_else(|| MacFfiError::Invalid(format!("unknown macOS named key `{part}`")))?;
        base_seen = true;
        strokes.push(KeyStroke {
            code,
            flags,
            modifier: None,
        });
    }
    if !base_seen && strokes.len() > 1 {
        return Err(MacFfiError::Invalid(format!(
            "key chord `{named}` has modifiers but no key"
        )));
    }
    if strokes.is_empty() {
        return Err(MacFfiError::Invalid(
            "named key cannot be empty".to_string(),
        ));
    }
    Ok(strokes)
}

fn modifier_key(name: &str) -> Option<(u16, CGEventFlags)> {
    match name.to_ascii_lowercase().as_str() {
        "command" | "cmd" | "meta" => Some((0x37, CGEventFlags::MaskCommand)),
        "shift" => Some((0x38, CGEventFlags::MaskShift)),
        "option" | "alt" => Some((0x3A, CGEventFlags::MaskAlternate)),
        "control" | "ctrl" => Some((0x3B, CGEventFlags::MaskControl)),
        "fn" | "function" => Some((0x3F, CGEventFlags::MaskSecondaryFn)),
        _ => None,
    }
}

/// Maps named and printable ANSI keys to macOS virtual keycodes from
/// `<HIToolbox/Events.h>`. Unknown names are rejected before dispatch.
fn named_key_to_keycode(name: &str) -> Option<u16> {
    let normalized = name.to_ascii_lowercase();
    let code: u16 = match normalized.as_str() {
        "a" => 0x00,
        "s" => 0x01,
        "d" => 0x02,
        "f" => 0x03,
        "h" => 0x04,
        "g" => 0x05,
        "z" => 0x06,
        "x" => 0x07,
        "c" => 0x08,
        "v" => 0x09,
        "b" => 0x0B,
        "q" => 0x0C,
        "w" => 0x0D,
        "e" => 0x0E,
        "r" => 0x0F,
        "y" => 0x10,
        "t" => 0x11,
        "1" => 0x12,
        "2" => 0x13,
        "3" => 0x14,
        "4" => 0x15,
        "6" => 0x16,
        "5" => 0x17,
        "=" | "equal" => 0x18,
        "9" => 0x19,
        "7" => 0x1A,
        "-" | "minus" => 0x1B,
        "8" => 0x1C,
        "0" => 0x1D,
        "]" | "bracketright" => 0x1E,
        "o" => 0x1F,
        "u" => 0x20,
        "[" | "bracketleft" => 0x21,
        "i" => 0x22,
        "p" => 0x23,
        "enter" | "return" => 0x24,
        "l" => 0x25,
        "j" => 0x26,
        "'" | "quote" => 0x27,
        "k" => 0x28,
        ";" | "semicolon" => 0x29,
        "\\" | "backslash" => 0x2A,
        "," | "comma" => 0x2B,
        "/" | "slash" => 0x2C,
        "n" => 0x2D,
        "m" => 0x2E,
        "." | "period" => 0x2F,
        "tab" => 0x30,
        "space" | " " => 0x31,
        "`" | "backquote" => 0x32,
        "backspace" => 0x33,
        "escape" | "esc" => 0x35,
        "capslock" => 0x39,
        "f5" => 0x60,
        "f6" => 0x61,
        "f7" => 0x62,
        "f3" => 0x63,
        "f8" => 0x64,
        "f9" => 0x65,
        "f11" => 0x67,
        "f13" => 0x69,
        "f16" => 0x6A,
        "f14" => 0x6B,
        "f10" => 0x6D,
        "f12" => 0x6F,
        "f15" => 0x71,
        "home" => 0x73,
        "pageup" => 0x74,
        "delete" => 0x75,
        "f4" => 0x76,
        "end" => 0x77,
        "f2" => 0x78,
        "pagedown" => 0x79,
        "f1" => 0x7A,
        "arrowleft" | "left" => 0x7B,
        "arrowright" | "right" => 0x7C,
        "arrowdown" | "down" => 0x7D,
        "arrowup" | "up" => 0x7E,
        _ => return None,
    };
    Some(code)
}

fn post_prepared(prepared: &PreparedInput) -> Result<(), MacFfiError> {
    let initial_external = prepared.external_generation;
    if prepared.monitor.external_generation()? != initial_external {
        return Err(MacFfiError::InputInterrupted(
            "physical input occurred while automated input was being prepared; nothing was dispatched"
                .to_string(),
        ));
    }
    let initial_synthetic = prepared.monitor.synthetic_generation()?;
    for (posted, event) in prepared.events.iter().enumerate() {
        if prepared.monitor.external_generation()? != initial_external {
            return if posted == 0 {
                Err(MacFfiError::InputInterrupted(
                    "physical input took priority before automated input was dispatched"
                        .to_string(),
                ))
            } else {
                Err(MacFfiError::OutcomeUnknown(
                    "physical input interrupted a partially dispatched automated input batch"
                        .to_string(),
                ))
            };
        }
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(event));
    }

    let expected = initial_synthetic.saturating_add(prepared.events.len() as u64);
    let deadline = Instant::now() + INPUT_CONFIRM_TIMEOUT;
    while prepared.monitor.synthetic_generation()? < expected {
        if prepared.monitor.external_generation()? != initial_external {
            return Err(MacFfiError::OutcomeUnknown(
                "physical input overlapped an automated input batch after dispatch".to_string(),
            ));
        }
        if Instant::now() >= deadline {
            return Err(MacFfiError::OutcomeUnknown(
                "CoreGraphics did not confirm the complete automated input batch".to_string(),
            ));
        }
        thread::sleep(INPUT_CONFIRM_POLL);
    }
    if prepared.monitor.external_generation()? != initial_external {
        return Err(MacFfiError::OutcomeUnknown(
            "physical input overlapped an automated input batch".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod input_tests {
    use super::*;

    #[test]
    fn parses_command_chord_with_accumulated_flags() {
        let strokes = parse_key_chord("Command+Shift+A").expect("valid chord");
        assert_eq!(strokes.len(), 3);
        assert!(strokes[0].flags.contains(CGEventFlags::MaskCommand));
        assert!(strokes[1].flags.contains(CGEventFlags::MaskShift));
        assert_eq!(strokes[2].code, 0x00);
        assert!(strokes[2].flags.contains(CGEventFlags::MaskCommand));
        assert!(strokes[2].flags.contains(CGEventFlags::MaskShift));
        assert!(released_flags(strokes[2]).contains(CGEventFlags::MaskShift));
        assert!(!released_flags(strokes[1]).contains(CGEventFlags::MaskShift));
        assert!(released_flags(strokes[1]).contains(CGEventFlags::MaskCommand));
        assert!(!released_flags(strokes[0]).contains(CGEventFlags::MaskCommand));
    }

    #[test]
    fn rejects_unknown_or_malformed_chords() {
        assert!(parse_key_chord("Command+DefinitelyNotAKey").is_err());
        assert!(parse_key_chord("Command+").is_err());
        assert!(parse_key_chord("A+B").is_err());
        assert!(parse_key_chord("Command+Command+A").is_err());
    }
}
