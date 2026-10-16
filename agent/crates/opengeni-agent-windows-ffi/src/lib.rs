//! Windows desktop FFI, wrapped behind a small **safe** API.
//!
//! This leaf crate lets the Opengeni agent's desktop backend drive the
//! interactive Windows desktop it runs on: probe the primary display, capture it
//! with GDI, and inject pointer, keyboard and wheel input with `SendInput`.
//!
//! # The `unsafe_code` boundary
//!
//! The agent workspace forbids `unsafe_code`. Win32 calls are inherently unsafe,
//! so this crate lowers itself to `deny` and confines every `unsafe` block to the
//! private `ffi` module. Callers, including `opengeni-agent-platform`, only see
//! the safe functions below.
//!
//! # Coordinates
//!
//! Everything is in **physical pixels of the primary display**, origin top-left.
//! Each call runs under a per-monitor-v2 DPI awareness context on its own thread,
//! so a scaled (125%, 150%) display reports, captures and receives clicks in the
//! same pixel space as the screenshot.
//!
//! # Portability
//!
//! On non-Windows targets the public functions are honest stubs (`None`, or
//! [`WinFfiError::Unsupported`]) so the workspace still builds everywhere. The
//! key-chord parser is plain Rust and is tested on every platform.

#[cfg(windows)]
#[allow(unsafe_code)]
mod ffi;

/// The primary display of the interactive session, in physical pixels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayInfo {
    /// A stable identifier for the display.
    pub id: String,
    /// Width in physical pixels.
    pub width: u32,
    /// Height in physical pixels.
    pub height: u32,
}

/// A captured frame: tightly packed RGBA8, top-down rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RgbaFrame {
    /// `width * height * 4` bytes of RGBA.
    pub rgba: Vec<u8>,
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
}

/// Which pointer button an event applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerButton {
    /// The primary button.
    Left,
    /// The secondary button.
    Right,
    /// The wheel button.
    Middle,
}

/// What a pointer event does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerAction {
    /// Move the pointer only.
    Move,
    /// Move, then press the button.
    Down,
    /// Move, then release the button.
    Up,
    /// Move, then press and release.
    Click,
    /// Move, then two press/release pairs.
    DoubleClick,
}

/// Down, up, or a full press of a key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAction {
    /// Press and hold.
    Down,
    /// Release.
    Up,
    /// Press and release.
    Press,
}

/// One synthetic input event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputEvent {
    /// A pointer move, press, release or click at a primary-display pixel.
    Pointer {
        /// X in primary-display pixels.
        x: i32,
        /// Y in primary-display pixels.
        y: i32,
        /// The button the action applies to.
        button: PointerButton,
        /// What to do.
        action: PointerAction,
    },
    /// Type verbatim text. Newlines press Enter and tabs press Tab.
    Text(String),
    /// A named key or chord such as `Enter`, `ctrl+c` or `ctrl+shift+Escape`.
    Key {
        /// The key or chord, `+`-separated, modifiers first.
        chord: String,
        /// Down, up or press.
        action: KeyAction,
    },
    /// Wheel clicks at a pixel. Positive `dy` scrolls down, positive `dx` right.
    Scroll {
        /// X in primary-display pixels.
        x: i32,
        /// Y in primary-display pixels.
        y: i32,
        /// Horizontal wheel clicks.
        dx: i32,
        /// Vertical wheel clicks.
        dy: i32,
    },
}

/// Errors from the Windows FFI leaf.
#[derive(Debug, thiserror::Error)]
pub enum WinFfiError {
    /// Not available on this target or in this session.
    #[error("Windows desktop unsupported: {0}")]
    Unsupported(String),
    /// The input is malformed, for example an unknown key name.
    #[error("invalid desktop input: {0}")]
    Invalid(String),
    /// A Win32 call failed.
    #[error("Windows desktop call failed: {0}")]
    Os(String),
}

/// The most wheel clicks one scroll event may emit per axis, matching the Linux
/// backend's bound against hostile deltas.
pub const MAX_SCROLL_CLICKS: u32 = 32;

/// Probes the primary display of the interactive session this process runs in.
///
/// Returns `None` when there is no interactive desktop: a service in session 0,
/// a non-interactive window station, or a zero-sized screen.
#[must_use]
pub fn probe_display() -> Option<DisplayInfo> {
    #[cfg(windows)]
    {
        ffi::probe_display()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Why the desktop cannot be captured or driven right now, or `None` when it can.
///
/// The interactive desktop is unavailable while the workstation is locked or a
/// secure desktop (sign-in, UAC prompt) owns the input.
#[must_use]
pub fn blocked_reason() -> Option<String> {
    #[cfg(windows)]
    {
        ffi::blocked_reason()
    }
    #[cfg(not(windows))]
    {
        Some("not a Windows desktop".to_string())
    }
}

/// Captures the primary display as RGBA.
///
/// # Errors
///
/// [`WinFfiError::Unsupported`] off Windows or without an interactive display,
/// [`WinFfiError::Os`] when a GDI call fails.
pub fn capture_rgba() -> Result<RgbaFrame, WinFfiError> {
    #[cfg(windows)]
    {
        ffi::capture_rgba()
    }
    #[cfg(not(windows))]
    {
        Err(WinFfiError::Unsupported(
            "not a Windows desktop".to_string(),
        ))
    }
}

/// Injects one input event into the interactive desktop.
///
/// Key names are validated before anything is sent, so an invalid chord sends
/// nothing.
///
/// # Errors
///
/// [`WinFfiError::Invalid`] for a malformed chord, [`WinFfiError::Os`] when
/// Windows rejects the input (for example when the foreground window belongs to
/// an elevated process).
pub fn inject(event: &InputEvent) -> Result<(), WinFfiError> {
    if let InputEvent::Key { chord, .. } = event {
        parse_chord(chord)?;
    }
    #[cfg(windows)]
    {
        ffi::inject(event)
    }
    #[cfg(not(windows))]
    {
        Err(WinFfiError::Unsupported(
            "not a Windows desktop".to_string(),
        ))
    }
}

/// Validates a named key or chord without sending anything.
///
/// # Errors
///
/// [`WinFfiError::Invalid`] when the chord is empty, repeats a modifier, has
/// modifiers but no key, or names an unknown key.
pub fn validate_chord(chord: &str) -> Result<(), WinFfiError> {
    parse_chord(chord).map(|_| ())
}

/// A modifier key in a chord.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) enum Modifier {
    Control,
    Shift,
    Alt,
    Win,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl Modifier {
    fn parse(name: &str) -> Option<Self> {
        match name.to_ascii_lowercase().as_str() {
            "control" | "ctrl" => Some(Self::Control),
            "shift" => Some(Self::Shift),
            "alt" | "option" => Some(Self::Alt),
            "meta" | "super" | "command" | "cmd" | "win" | "windows" => Some(Self::Win),
            _ => None,
        }
    }

    /// The Win32 virtual-key code and whether it is an extended key.
    pub(crate) fn vk(self) -> (u16, bool) {
        match self {
            Self::Control => (0x11, false),
            Self::Shift => (0x10, false),
            Self::Alt => (0x12, false),
            Self::Win => (0x5B, true),
        }
    }
}

/// The non-modifier key that ends a chord.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) enum BaseKey {
    /// A named key with a fixed virtual-key code (and the extended-key flag).
    Vk(u16, bool),
    /// A printable character, resolved through the active keyboard layout.
    Char(char),
}

/// A parsed chord: modifiers in order, then one base key.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) struct Chord {
    pub(crate) modifiers: Vec<Modifier>,
    pub(crate) key: BaseKey,
}

pub(crate) fn parse_chord(chord: &str) -> Result<Chord, WinFfiError> {
    // A lone "+" is the plus key, not an empty chord.
    if chord == "+" {
        return Ok(Chord {
            modifiers: Vec::new(),
            key: BaseKey::Char('+'),
        });
    }
    // Trim padding around names, but keep a component that is only whitespace
    // as the space key (`" "`, `"ctrl+ "`).
    let parts: Vec<&str> = chord
        .split('+')
        .map(|part| match part.trim() {
            "" if !part.is_empty() => " ",
            trimmed => trimmed,
        })
        .collect();
    if parts.iter().any(|part| part.is_empty()) {
        return Err(WinFfiError::Invalid(format!(
            "key chord `{chord}` contains an empty component"
        )));
    }
    let (last, modifier_names) = parts
        .split_last()
        .ok_or_else(|| WinFfiError::Invalid("key chord is empty".to_string()))?;
    let mut modifiers = Vec::with_capacity(modifier_names.len());
    for name in modifier_names {
        let modifier = Modifier::parse(name).ok_or_else(|| {
            WinFfiError::Invalid(format!(
                "key chord `{chord}` must end with exactly one non-modifier key"
            ))
        })?;
        if modifiers.contains(&modifier) {
            return Err(WinFfiError::Invalid(format!(
                "key chord `{chord}` repeats a modifier"
            )));
        }
        modifiers.push(modifier);
    }
    if Modifier::parse(last).is_some() {
        return Err(WinFfiError::Invalid(format!(
            "key chord `{chord}` has modifiers but no key"
        )));
    }
    let key = named_key(last)
        .ok_or_else(|| WinFfiError::Invalid(format!("unknown Windows key `{last}`")))?;
    Ok(Chord { modifiers, key })
}

/// Maps a key name to a [`BaseKey`]. Named keys are case-insensitive; a single
/// character keeps its case, so `A` means shift+a as on the other platforms.
fn named_key(name: &str) -> Option<BaseKey> {
    let mut chars = name.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return Some(if c == ' ' {
            BaseKey::Vk(0x20, false)
        } else {
            BaseKey::Char(c)
        });
    }
    let lower = name.to_ascii_lowercase();
    let (vk, extended) = match lower.as_str() {
        "enter" | "return" => (0x0D, false),
        "tab" => (0x09, false),
        "escape" | "esc" => (0x1B, false),
        "backspace" => (0x08, false),
        "space" => (0x20, false),
        "capslock" => (0x14, false),
        "delete" | "del" => (0x2E, true),
        "insert" => (0x2D, true),
        "home" => (0x24, true),
        "end" => (0x23, true),
        "pageup" => (0x21, true),
        "pagedown" => (0x22, true),
        "arrowleft" | "left" => (0x25, true),
        "arrowup" | "up" => (0x26, true),
        "arrowright" | "right" => (0x27, true),
        "arrowdown" | "down" => (0x28, true),
        "printscreen" => (0x2C, true),
        "contextmenu" | "apps" => (0x5D, true),
        _ => {
            let number = lower.strip_prefix('f')?.parse::<u16>().ok()?;
            if !(1..=24).contains(&number) {
                return None;
            }
            (0x70 + number - 1, false)
        }
    };
    Some(BaseKey::Vk(vk, extended))
}

/// Converts a primary-display pixel to the 0..=65535 absolute space `SendInput`
/// uses, clamped to the screen and aimed at the pixel's centre so rounding on
/// either side lands on the requested pixel. `extent` is the width or height.
#[must_use]
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn normalize_absolute(pixel: i32, extent: u32) -> i32 {
    let extent = i64::from(extent.max(1));
    let clamped = i64::from(pixel).clamp(0, extent - 1);
    let normalized = (clamped * 65536 + 32768) / extent;
    i32::try_from(normalized.clamp(0, 65535)).unwrap_or(65535)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_keys_and_chords_parse() {
        assert_eq!(
            parse_chord("Enter").unwrap(),
            Chord {
                modifiers: vec![],
                key: BaseKey::Vk(0x0D, false)
            }
        );
        assert_eq!(
            parse_chord("ctrl+shift+ArrowLeft").unwrap(),
            Chord {
                modifiers: vec![Modifier::Control, Modifier::Shift],
                key: BaseKey::Vk(0x25, true)
            }
        );
        assert_eq!(parse_chord("cmd+a").unwrap().modifiers, vec![Modifier::Win]);
        assert_eq!(parse_chord("F12").unwrap().key, BaseKey::Vk(0x7B, false));
        assert_eq!(parse_chord("A").unwrap().key, BaseKey::Char('A'));
        assert_eq!(parse_chord("+").unwrap().key, BaseKey::Char('+'));
        assert_eq!(parse_chord(" ").unwrap().key, BaseKey::Vk(0x20, false));
    }

    #[test]
    fn malformed_chords_are_refused_before_dispatch() {
        for chord in [
            "",
            "ctrl+",
            "ctrl",
            "ctrl+ctrl+a",
            "a+ctrl",
            "f25",
            "hyper+a",
            "ctrl++",
        ] {
            assert!(
                matches!(parse_chord(chord), Err(WinFfiError::Invalid(_))),
                "{chord:?} should be invalid"
            );
        }
    }

    #[test]
    fn absolute_coordinates_land_on_the_requested_pixel() {
        for extent in [768_i32, 1024, 1080, 1920, 2560] {
            for pixel in [0, 1, 383, extent / 2, extent - 1] {
                let n = i64::from(normalize_absolute(pixel, extent.unsigned_abs()));
                assert_eq!(
                    n * i64::from(extent) / 65536,
                    i64::from(pixel),
                    "{pixel}/{extent}"
                );
            }
        }
        assert_eq!(normalize_absolute(-50, 1920), normalize_absolute(0, 1920));
        assert_eq!(
            normalize_absolute(5000, 1920),
            normalize_absolute(1919, 1920)
        );
    }
}
