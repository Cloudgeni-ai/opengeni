//! Windows-specific platform bits.
//!
//! exec/fs/git are portable (in [`crate::native`]); this module holds the Windows
//! specifics — OS reporting, building a shell command via `cmd.exe`, and the
//! structured desktop backend ([`WindowsDesktop`]). It is
//! `cfg(target_os = "windows")`-gated. The cross-platform CI matrix (design
//! §23.3) builds + `cargo test`s this on a `windows-latest` runner so it cannot
//! rot, even though the autonomous live matrix focuses on Linux.
//!
//! # Desktop
//!
//! Windows computer use is GDI capture of the primary display plus `SendInput`
//! for pointer, keyboard and wheel input, through the
//! [`opengeni_agent_windows_ffi`] leaf crate that owns every Win32 `unsafe`.
//! Unlike macOS there is no permission prompt: an agent running in a signed-in,
//! unlocked desktop session can capture and drive it. A service in session 0,
//! a locked workstation or a secure desktop (sign-in, UAC) reports a typed
//! reason instead, so the control plane withholds the desktop rather than
//! showing the model a blank screen.

use async_trait::async_trait;

use opengeni_agent_proto::v1::{self, Os};
use opengeni_agent_windows_ffi as winffi;

use crate::desktop::{CapturedFrame, DesktopBackend};
use crate::error::{PlatformError, PlatformResult};

/// The OS family this build targets.
#[must_use]
pub(crate) fn os() -> Os {
    Os::Windows
}

/// Builds a command that runs `parts` through `cmd.exe /C`.
///
/// Windows has no `$SHELL`; the platform shell is `cmd.exe`. As on the POSIX
/// path, opting into `shell = true` means the caller wants shell interpretation
/// of the joined line, so we pass it through without re-quoting.
pub(crate) fn shell_command(parts: &[String]) -> tokio::process::Command {
    let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    let mut cmd = tokio::process::Command::new(comspec);
    cmd.arg("/C").arg(parts.join(" "));
    cmd
}

/// The Windows desktop backend (GDI capture + `SendInput`).
///
/// A ZST: every call resolves the screen and its handles afresh on a blocking
/// thread, so a resolution or DPI change between calls is picked up without
/// any cached state.
#[derive(Debug, Default, Clone, Copy)]
pub struct WindowsDesktop;

impl WindowsDesktop {
    /// Builds the Windows desktop backend.
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl DesktopBackend for WindowsDesktop {
    fn can_offer_display(&self) -> bool {
        // A locked session still has a display the user can consent to; capture
        // and input stay gated by `capture_blocked_reason` until it unlocks.
        winffi::probe_display().is_some()
    }

    fn probe(&self) -> Option<v1::Display> {
        let info = winffi::probe_display()?;
        Some(v1::Display {
            id: info.id,
            width: info.width,
            height: info.height,
            r#virtual: false,
        })
    }

    async fn capture(&self) -> PlatformResult<CapturedFrame> {
        crate::spawn_blocking_reserved(|| {
            let frame = winffi::capture_rgba().map_err(map_ffi_err)?;
            let png = encode_png(&frame.rgba, frame.width, frame.height)?;
            Ok(CapturedFrame {
                png,
                width: frame.width,
                height: frame.height,
            })
        })
        .await
        .map_err(|e| PlatformError::os(format!("Windows capture task join: {e}")))?
    }

    async fn inject(&self, input: &v1::DesktopInput) -> PlatformResult<()> {
        let event = map_input(input)?;
        crate::spawn_blocking_reserved(move || winffi::inject(&event).map_err(map_ffi_err))
            .await
            .map_err(|e| PlatformError::os(format!("Windows inject task join: {e}")))?
    }

    fn capture_blocked_reason(&self) -> Option<String> {
        winffi::blocked_reason()
    }
}

/// Maps a leaf [`WinFfiError`](winffi::WinFfiError) onto a [`PlatformError`].
fn map_ffi_err(err: winffi::WinFfiError) -> PlatformError {
    match err {
        winffi::WinFfiError::Unsupported(message) => PlatformError::Unsupported(message),
        winffi::WinFfiError::Invalid(message) | winffi::WinFfiError::Os(message) => {
            PlatformError::os(message)
        }
    }
}

/// Maps a wire [`DesktopInput`](v1::DesktopInput) onto the leaf crate's plain
/// [`InputEvent`](winffi::InputEvent).
fn map_input(input: &v1::DesktopInput) -> PlatformResult<winffi::InputEvent> {
    let Some(event) = &input.event else {
        return Err(PlatformError::os("DesktopInput carried no event"));
    };
    Ok(match event {
        v1::desktop_input::Event::Pointer(p) => winffi::InputEvent::Pointer {
            x: p.x,
            y: p.y,
            button: match p.button() {
                v1::PointerButton::Right => winffi::PointerButton::Right,
                v1::PointerButton::Middle => winffi::PointerButton::Middle,
                v1::PointerButton::Left | v1::PointerButton::Unspecified => {
                    winffi::PointerButton::Left
                }
            },
            action: match p.action() {
                v1::PointerAction::Down => winffi::PointerAction::Down,
                v1::PointerAction::Up => winffi::PointerAction::Up,
                v1::PointerAction::Click => winffi::PointerAction::Click,
                v1::PointerAction::DoubleClick => winffi::PointerAction::DoubleClick,
                v1::PointerAction::Move | v1::PointerAction::Unspecified => {
                    winffi::PointerAction::Move
                }
            },
        },
        v1::desktop_input::Event::Key(k) => {
            let action = match k.action() {
                v1::KeyAction::Down => winffi::KeyAction::Down,
                v1::KeyAction::Up => winffi::KeyAction::Up,
                v1::KeyAction::Press | v1::KeyAction::Unspecified => winffi::KeyAction::Press,
            };
            if k.is_text && action == winffi::KeyAction::Press {
                winffi::InputEvent::Text(k.key.clone())
            } else if k.is_text && k.key.chars().count() != 1 {
                return Err(PlatformError::os(
                    "holding or releasing text needs exactly one character",
                ));
            } else {
                winffi::InputEvent::Key {
                    chord: k.key.clone(),
                    action,
                }
            }
        }
        v1::desktop_input::Event::Scroll(s) => winffi::InputEvent::Scroll {
            x: s.x,
            y: s.y,
            dx: s.delta_x,
            dy: s.delta_y,
        },
    })
}

/// PNG-encodes a tightly-packed RGBA8 buffer, like the Linux and macOS backends.
fn encode_png(rgba: &[u8], width: u32, height: u32) -> PlatformResult<Vec<u8>> {
    use image::ImageEncoder as _;
    let mut out = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut out);
    encoder
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| {
            let mut detail = std::collections::BTreeMap::new();
            detail.insert("stage".to_string(), "png-encode".to_string());
            PlatformError::Os {
                message: format!("png encode failed: {e}"),
                detail,
            }
        })?;
    Ok(out)
}
