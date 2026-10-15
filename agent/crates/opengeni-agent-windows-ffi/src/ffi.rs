//! The only `unsafe` in this crate: GDI capture, `SendInput`, and the session
//! and desktop probes. Every Win32 handle is owned by a small RAII guard so an
//! early return can never leak a DC, bitmap or desktop handle.

use std::ffi::c_void;
use std::mem::size_of;
use std::ptr;

use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS,
    HBITMAP, HDC, HGDIOBJ, SRCCOPY,
};
use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows_sys::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_SWITCHDESKTOP, HDESK,
    UOI_NAME,
};
use windows_sys::Win32::System::Threading::GetCurrentProcessId;
use windows_sys::Win32::UI::HiDpi::{
    SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
    MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
    MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN, WHEEL_DELTA,
};

use crate::{
    normalize_absolute, parse_chord, BaseKey, DisplayInfo, InputEvent, KeyAction, PointerAction,
    PointerButton, RgbaFrame, WinFfiError, MAX_SCROLL_CLICKS,
};

const LOCKED_MESSAGE: &str = "This Windows session is locked or a secure desktop (sign-in or \
     UAC prompt) is showing. Unlock the session to use desktop capture and input.";

/// Runs the calling thread per-monitor-v2 DPI aware until dropped, so metrics,
/// capture and absolute input all use physical pixels. Restores the previous
/// context because blocking-pool threads are reused.
struct DpiScope(DPI_AWARENESS_CONTEXT);

impl DpiScope {
    fn enter() -> Self {
        // SAFETY: plain thread-local Win32 setter; a null return (unsupported
        // before Windows 10 1607) is stored and skipped on restore.
        Self(unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) })
    }
}

impl Drop for DpiScope {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: restores the context returned by the matching setter.
            unsafe { SetThreadDpiAwarenessContext(self.0) };
        }
    }
}

fn screen_size() -> Option<(u32, u32)> {
    // SAFETY: GetSystemMetrics has no preconditions.
    let (w, h) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
    Some((
        u32::try_from(w).ok().filter(|w| *w > 0)?,
        u32::try_from(h).ok().filter(|h| *h > 0)?,
    ))
}

fn in_service_session() -> bool {
    let mut session = 0_u32;
    // SAFETY: `session` is a valid out pointer for the duration of the call.
    let ok = unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &raw mut session) };
    ok == 0 || session == 0
}

pub(crate) fn probe_display() -> Option<DisplayInfo> {
    if in_service_session() {
        return None;
    }
    let _dpi = DpiScope::enter();
    let (width, height) = screen_size()?;
    Some(DisplayInfo {
        id: "primary".to_string(),
        width,
        height,
    })
}

struct Desktop(HDESK);

impl Drop for Desktop {
    fn drop(&mut self) {
        // SAFETY: the handle came from OpenInputDesktop and is closed once.
        unsafe { CloseDesktop(self.0) };
    }
}

pub(crate) fn blocked_reason() -> Option<String> {
    if in_service_session() {
        return Some(
            "The agent runs in a non-interactive Windows session. Run it in a signed-in \
             desktop session to use computer control."
                .to_string(),
        );
    }
    // SAFETY: plain call; a null handle means the input desktop is not ours to
    // open, which is exactly the lock-screen / secure-desktop case.
    let handle = unsafe { OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP) };
    if handle.is_null() {
        return Some(LOCKED_MESSAGE.to_string());
    }
    let desktop = Desktop(handle);
    let mut name = [0_u16; 64];
    let mut needed = 0_u32;
    // SAFETY: the buffer and its byte length match; `needed` is a valid out pointer.
    let ok = unsafe {
        GetUserObjectInformationW(
            desktop.0,
            UOI_NAME,
            name.as_mut_ptr().cast::<c_void>(),
            u32::try_from(size_of::<[u16; 64]>()).unwrap_or(128),
            &raw mut needed,
        )
    };
    if ok == 0 {
        return Some(LOCKED_MESSAGE.to_string());
    }
    let len = name.iter().position(|c| *c == 0).unwrap_or(name.len());
    if String::from_utf16_lossy(&name[..len]).eq_ignore_ascii_case("Default") {
        None
    } else {
        Some(LOCKED_MESSAGE.to_string())
    }
}

struct ScreenDc(HDC);

impl Drop for ScreenDc {
    fn drop(&mut self) {
        // SAFETY: obtained from GetDC(null) and released once.
        unsafe { ReleaseDC(ptr::null_mut(), self.0) };
    }
}

struct MemoryDc(HDC);

impl Drop for MemoryDc {
    fn drop(&mut self) {
        // SAFETY: created by CreateCompatibleDC and deleted once.
        unsafe { DeleteDC(self.0) };
    }
}

struct Bitmap(HBITMAP);

impl Drop for Bitmap {
    fn drop(&mut self) {
        // SAFETY: created by CreateCompatibleBitmap; deselected before drop.
        unsafe { DeleteObject(self.0 as HGDIOBJ) };
    }
}

/// Restores the memory DC's original bitmap so the captured one can be deleted.
struct Selection {
    dc: HDC,
    previous: HGDIOBJ,
}

impl Drop for Selection {
    fn drop(&mut self) {
        // SAFETY: puts back the object SelectObject returned for this DC.
        unsafe { SelectObject(self.dc, self.previous) };
    }
}

fn os_error(stage: &str) -> WinFfiError {
    WinFfiError::Os(format!("{stage}: {}", std::io::Error::last_os_error()))
}

pub(crate) fn capture_rgba() -> Result<RgbaFrame, WinFfiError> {
    if let Some(reason) = blocked_reason() {
        return Err(WinFfiError::Unsupported(reason));
    }
    let _dpi = DpiScope::enter();
    let (width, height) =
        screen_size().ok_or_else(|| WinFfiError::Unsupported("no primary display".to_string()))?;
    let (w, h) = (
        i32::try_from(width).map_err(|_| WinFfiError::Os("display too wide".into()))?,
        i32::try_from(height).map_err(|_| WinFfiError::Os("display too tall".into()))?,
    );

    // SAFETY: each handle is checked for null and owned by a guard that frees it
    // in reverse order (selection, bitmap, memory DC, screen DC).
    let screen = ScreenDc(unsafe { GetDC(ptr::null_mut()) });
    if screen.0.is_null() {
        return Err(os_error("GetDC"));
    }
    let memory = MemoryDc(unsafe { CreateCompatibleDC(screen.0) });
    if memory.0.is_null() {
        return Err(os_error("CreateCompatibleDC"));
    }
    let bitmap = Bitmap(unsafe { CreateCompatibleBitmap(screen.0, w, h) });
    if bitmap.0.is_null() {
        return Err(os_error("CreateCompatibleBitmap"));
    }
    let previous = unsafe { SelectObject(memory.0, bitmap.0 as HGDIOBJ) };
    if previous.is_null() {
        return Err(os_error("SelectObject"));
    }
    let selection = Selection {
        dc: memory.0,
        previous,
    };
    // SAFETY: both DCs are live and the rectangle is the screen's own size.
    if unsafe { BitBlt(memory.0, 0, 0, w, h, screen.0, 0, 0, SRCCOPY | CAPTUREBLT) } == 0 {
        return Err(os_error("BitBlt"));
    }
    // GetDIBits requires the bitmap not be selected into a DC.
    drop(selection);

    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: u32::try_from(size_of::<BITMAPINFOHEADER>()).unwrap_or(40),
            biWidth: w,
            // Negative height asks for top-down rows.
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..BITMAPINFOHEADER::default()
        },
        ..BITMAPINFO::default()
    };
    let row_bytes = width as usize * 4;
    let mut pixels = vec![0_u8; row_bytes * height as usize];
    // SAFETY: `pixels` holds exactly height rows of 32bpp width pixels, which is
    // what the header asks GetDIBits to write.
    let lines = unsafe {
        GetDIBits(
            memory.0,
            bitmap.0,
            0,
            height,
            pixels.as_mut_ptr().cast::<c_void>(),
            &raw mut info,
            DIB_RGB_COLORS,
        )
    };
    if lines <= 0 || u32::try_from(lines).ok() != Some(height) {
        return Err(os_error("GetDIBits"));
    }
    drop((bitmap, memory, screen));

    // GDI hands back BGRX; the X byte is undefined, so force opaque alpha.
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        pixel[3] = 0xFF;
    }
    Ok(RgbaFrame {
        rgba: pixels,
        width,
        height,
    })
}

fn mouse(dx: i32, dy: i32, data: u32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn key(vk: u16, scan: u16, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn vk_input(vk: u16, extended: bool, up: bool) -> INPUT {
    let mut flags = 0;
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    key(vk, 0, flags)
}

fn send(inputs: &[INPUT]) -> Result<(), WinFfiError> {
    if inputs.is_empty() {
        return Ok(());
    }
    let count = u32::try_from(inputs.len())
        .map_err(|_| WinFfiError::Invalid("too many input events".to_string()))?;
    let size = i32::try_from(size_of::<INPUT>()).unwrap_or(40);
    // SAFETY: `inputs` is a live slice of `count` initialized INPUT structs.
    let sent = unsafe { SendInput(count, inputs.as_ptr(), size) };
    if sent == count {
        Ok(())
    } else {
        Err(WinFfiError::Os(format!(
            "SendInput delivered {sent} of {count} events (input is blocked, for example by \
             an elevated foreground window or the lock screen): {}",
            std::io::Error::last_os_error()
        )))
    }
}

fn absolute_move(x: i32, y: i32) -> Result<INPUT, WinFfiError> {
    let (width, height) =
        screen_size().ok_or_else(|| WinFfiError::Unsupported("no primary display".to_string()))?;
    Ok(mouse(
        normalize_absolute(x, width),
        normalize_absolute(y, height),
        0,
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
    ))
}

fn button_flags(button: PointerButton) -> (MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS) {
    match button {
        PointerButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        PointerButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        PointerButton::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    }
}

fn text_inputs(text: &str) -> Vec<INPUT> {
    let mut inputs = Vec::with_capacity(text.len() * 2);
    for c in text.chars() {
        match c {
            '\r' => {}
            '\n' => inputs.extend([vk_input(0x0D, false, false), vk_input(0x0D, false, true)]),
            '\t' => inputs.extend([vk_input(0x09, false, false), vk_input(0x09, false, true)]),
            _ => {
                let mut units = [0_u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    inputs.push(key(0, *unit, KEYEVENTF_UNICODE));
                    inputs.push(key(0, *unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
                }
            }
        }
    }
    inputs
}

/// Resolves a chord to its key-down sequence: modifiers in order, then the key.
fn chord_downs(chord: &str) -> Result<Vec<(u16, bool)>, WinFfiError> {
    let parsed = parse_chord(chord)?;
    let mut downs: Vec<(u16, bool)> = parsed.modifiers.iter().map(|m| m.vk()).collect();
    let base = match parsed.key {
        BaseKey::Vk(vk, extended) => (vk, extended),
        BaseKey::Char(c) => {
            let mut units = [0_u16; 2];
            let encoded = c.encode_utf16(&mut units);
            if encoded.len() != 1 {
                return Err(WinFfiError::Invalid(format!(
                    "key `{c}` is not on this keyboard"
                )));
            }
            // SAFETY: plain layout lookup with no pointers.
            let scan = unsafe { VkKeyScanW(encoded[0]) };
            if scan == -1 {
                return Err(WinFfiError::Invalid(format!(
                    "key `{c}` is not on this keyboard"
                )));
            }
            let [vk, shift_state] = scan.to_le_bytes();
            // The high byte says which modifiers the layout needs for this
            // character (1 shift, 2 ctrl, 4 alt); add any the chord lacks.
            for (bit, vk_mod) in [(1_u8, 0x10_u16), (2, 0x11), (4, 0x12)] {
                if shift_state & bit != 0 && !downs.iter().any(|(v, _)| *v == vk_mod) {
                    downs.push((vk_mod, false));
                }
            }
            (u16::from(vk), false)
        }
    };
    downs.push(base);
    Ok(downs)
}

fn clamp_clicks(clicks: i32) -> i32 {
    let max = i32::try_from(MAX_SCROLL_CLICKS).unwrap_or(32);
    clicks.clamp(-max, max)
}

pub(crate) fn inject(event: &InputEvent) -> Result<(), WinFfiError> {
    if let Some(reason) = blocked_reason() {
        return Err(WinFfiError::Unsupported(reason));
    }
    let _dpi = DpiScope::enter();
    match event {
        InputEvent::Pointer {
            x,
            y,
            button,
            action,
        } => {
            let mut inputs = vec![absolute_move(*x, *y)?];
            let (down, up) = button_flags(*button);
            match action {
                PointerAction::Move => {}
                PointerAction::Down => inputs.push(mouse(0, 0, 0, down)),
                PointerAction::Up => inputs.push(mouse(0, 0, 0, up)),
                PointerAction::Click => {
                    inputs.extend([mouse(0, 0, 0, down), mouse(0, 0, 0, up)]);
                }
                PointerAction::DoubleClick => inputs.extend([
                    mouse(0, 0, 0, down),
                    mouse(0, 0, 0, up),
                    mouse(0, 0, 0, down),
                    mouse(0, 0, 0, up),
                ]),
            }
            send(&inputs)
        }
        InputEvent::Text(text) => send(&text_inputs(text)),
        InputEvent::Key { chord, action } => {
            let downs = chord_downs(chord)?;
            let mut inputs = Vec::with_capacity(downs.len() * 2);
            if matches!(action, KeyAction::Down | KeyAction::Press) {
                inputs.extend(downs.iter().map(|(vk, ext)| vk_input(*vk, *ext, false)));
            }
            if matches!(action, KeyAction::Up | KeyAction::Press) {
                inputs.extend(
                    downs
                        .iter()
                        .rev()
                        .map(|(vk, ext)| vk_input(*vk, *ext, true)),
                );
            }
            send(&inputs)
        }
        InputEvent::Scroll { x, y, dx, dy } => {
            let mut inputs = vec![absolute_move(*x, *y)?];
            let notch = i32::try_from(WHEEL_DELTA).unwrap_or(120);
            let (dx, dy) = (clamp_clicks(*dx), clamp_clicks(*dy));
            if dy != 0 {
                // Positive wheel data scrolls up; our positive `dy` scrolls down.
                inputs.push(mouse(
                    0,
                    0,
                    u32::from_ne_bytes((-dy * notch).to_ne_bytes()),
                    MOUSEEVENTF_WHEEL,
                ));
            }
            if dx != 0 {
                inputs.push(mouse(
                    0,
                    0,
                    u32::from_ne_bytes((dx * notch).to_ne_bytes()),
                    MOUSEEVENTF_HWHEEL,
                ));
            }
            send(&inputs)
        }
    }
}
