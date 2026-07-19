//! macOS-specific platform bits.
//!
//! Mirrors [`crate::linux`]: exec/fs/git are portable (in [`crate::native`]); this
//! module holds the macOS specifics — OS reporting, the POSIX shell command, and
//! the structured desktop backend ([`MacosDesktop`]). It is
//! `cfg(target_os = "macos")`-gated so it compiles only on macOS, but the
//! cross-platform CI matrix (dossier §23.3) builds + tests it there.
//!
//! # Desktop (experimental; stable release disabled)
//!
//! macOS computer-use is **CGEvent** (synthetic input) + **ScreenCaptureKit**
//! (capture), both **TCC-gated** (Screen Recording + Accessibility grants that
//! cannot be auto-clicked on an ephemeral CI runner — dossier §23.4/§24.3). The
//! source contains a ScreenCaptureKit/CGEvent implementation behind the
//! `macos-desktop` feature and confines Apple FFI to a dedicated leaf crate. Stable
//! release artifacts deliberately leave that feature off and use the honest stub:
//! `probe` returns no display and capture/input return typed `Unsupported`. Native
//! compilation is compatibility evidence only; the feature cannot ship until a
//! signed bundle on a logged-in, consenting Mac passes the live TCC/capture/input
//! and complete-bundle replacement gates.

use async_trait::async_trait;

use opengeni_agent_proto::v1::{self, Os};

use crate::desktop::{CapturedFrame, DesktopBackend};
use crate::error::{PlatformError, PlatformResult};

/// The OS family this build targets.
#[must_use]
pub(crate) fn os() -> Os {
    Os::Macos
}

/// Builds a command that runs `parts` through the user's POSIX shell (`$SHELL`,
/// falling back to `/bin/sh`). Identical contract to the Linux path — macOS ships
/// a POSIX shell, so the cross-platform exec path needs no special casing.
pub(crate) fn shell_command(parts: &[String]) -> tokio::process::Command {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = tokio::process::Command::new(shell);
    cmd.arg("-c").arg(parts.join(" "));
    cmd
}

/// The macOS desktop backend (CGEvent + ScreenCaptureKit).
///
/// A ZST: it stores nothing and constructs its native objects per call, because
/// the leaf FFI crate's objc2 `Retained` handles are `!Send` while this backend
/// is shared as `Arc<dyn DesktopBackend>` across the pump + input handler — the
/// same per-op posture the Linux X11 backend takes with its connection.
///
/// * With the `macos-desktop` feature **on**, `probe`/`capture`/`inject` call the
///   [`opengeni_agent_macos_ffi`] leaf crate (ScreenCaptureKit + CGEvent). `probe`
///   still returns `None` until Screen Recording is granted, so the desktop cell
///   degrades to `display_unavailable` exactly like a headless host.
/// * With the feature **off** (the default), it is a structured seam that reports
///   no display and refuses capture/input with a typed `Unsupported` — byte-for-
///   byte the pre-existing stub, so the default build is unchanged.
#[derive(Debug, Default, Clone, Copy)]
pub struct MacosDesktop;

impl MacosDesktop {
    /// Builds the macOS desktop backend.
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

// --- Real backend (feature `macos-desktop`) ---------------------------------

#[cfg(feature = "macos-desktop")]
use opengeni_agent_macos_ffi as macffi;

// --- TCC grant status + consent request (feature `macos-desktop`) -----------
//
// `MacosDesktop::probe`/`capture`/`inject` all fail closed until the two macOS
// TCC grants are in place: Screen Recording (probe + capture) and Accessibility
// (CGEvent input delivery). These small helpers let the agent's lifecycle code
// (`opengeni-agent`'s startup/enroll seam) READ the current grant state without
// prompting and fire the OS consent prompts ONCE, so a display-capable Mac can
// actually advertise its display. They are macOS + feature gated, so the default
// and non-macOS builds compile nothing here (byte-identical).

/// A non-prompting snapshot of the two macOS TCC grants the desktop backend needs.
#[cfg(feature = "macos-desktop")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DesktopGrants {
    /// Screen Recording (`kTCCServiceScreenCapture`) — required for probe + capture.
    pub screen_recording: bool,
    /// Accessibility (`AXIsProcessTrusted`) — required for CGEvent input delivery.
    pub accessibility: bool,
}

#[cfg(feature = "macos-desktop")]
impl DesktopGrants {
    /// Both grants are in place, so the backend can fully probe/capture/inject.
    #[must_use]
    pub fn all_granted(self) -> bool {
        self.screen_recording && self.accessibility
    }
}

/// Reads the current macOS TCC grant status WITHOUT prompting (the leaf crate's
/// non-prompting `CGPreflightScreenCaptureAccess` + `AXIsProcessTrusted`).
#[cfg(feature = "macos-desktop")]
#[must_use]
pub fn desktop_grants() -> DesktopGrants {
    DesktopGrants {
        screen_recording: macffi::screen_capture_granted(),
        accessibility: macffi::accessibility_trusted(),
    }
}

/// Fires the two macOS TCC consent prompts once (Screen Recording via
/// `CGRequestScreenCaptureAccess`, Accessibility via the prompting
/// `AXIsProcessTrustedWithOptions`) and deep-links to the Settings panes. Only the
/// on-machine process can trigger the prompts; the user still flips the toggles.
#[cfg(feature = "macos-desktop")]
pub fn request_desktop_grants() {
    macffi::request_grants();
}

/// How many times [`MacosDesktop::capture`] retries a TRANSIENT capture miss (a
/// null image / timeout on a warming ScreenCaptureKit stream) before giving up.
/// Small: a real capture lands on the first or second frame; more attempts just
/// add latency to a genuinely dead stream.
#[cfg(feature = "macos-desktop")]
const CAPTURE_MAX_ATTEMPTS: u32 = 3;

/// The backoff between capture retries — long enough for the stream to hand back
/// its next frame, short enough to stay well inside the RPC deadline.
#[cfg(feature = "macos-desktop")]
const CAPTURE_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(150);

#[cfg(feature = "macos-desktop")]
#[async_trait]
impl DesktopBackend for MacosDesktop {
    fn probe(&self) -> Option<v1::Display> {
        let info = macffi::probe_display()?;
        Some(v1::Display {
            id: info.id,
            width: info.width,
            height: info.height,
            // No clean "is this a virtual display" API on macOS; default false
            // (cosmetic only, same posture as the Linux heuristic).
            r#virtual: false,
        })
    }

    async fn capture(&self) -> PlatformResult<CapturedFrame> {
        // The leaf capture blocks on a ScreenCaptureKit completion handler; keep
        // it (and the PNG encode) off the async runtime like the Linux path does.
        tokio::task::spawn_blocking(|| {
            // A ScreenCaptureKit stream can hand back a null image / time out on the
            // FIRST frame right after the display wakes or the stream warms up — a
            // transient miss, not a real failure. Retry a bounded few times with a
            // short backoff so a warm-up flake doesn't surface to the model as a
            // blank/error. A MISSING GRANT is terminal (retrying can't fix it): skip
            // the retries in that case so the loop doesn't burn its whole budget
            // re-hitting the same denial before returning the permission error.
            let mut last_err: Option<PlatformError> = None;
            for attempt in 0..CAPTURE_MAX_ATTEMPTS {
                match macffi::capture_rgba() {
                    Ok(frame) => {
                        let png = encode_png(&frame.rgba, frame.width, frame.height)?;
                        return Ok(CapturedFrame {
                            png,
                            width: frame.width,
                            height: frame.height,
                        });
                    }
                    Err(err) => {
                        let terminal = !macffi::screen_capture_granted();
                        last_err = Some(map_ffi_err(err));
                        if terminal || attempt + 1 >= CAPTURE_MAX_ATTEMPTS {
                            break;
                        }
                        std::thread::sleep(CAPTURE_RETRY_DELAY);
                    }
                }
            }
            Err(last_err.unwrap_or_else(|| {
                PlatformError::os("macOS capture produced no frame and no error")
            }))
        })
        .await
        .map_err(|e| PlatformError::os(format!("macOS capture task join: {e}")))?
    }

    async fn inject(&self, input: &v1::DesktopInput) -> PlatformResult<()> {
        // Accessibility gate: without it CGEventPost is silently dropped, so
        // report a typed Unsupported rather than pretend the input landed.
        if !macffi::accessibility_trusted() {
            return Err(PlatformError::Unsupported(
                "macOS Accessibility permission not granted (computer-use input cannot be delivered)"
                    .to_string(),
            ));
        }
        let event = map_input(input)?;
        tokio::task::spawn_blocking(move || macffi::inject(&event).map_err(map_ffi_err))
            .await
            .map_err(|e| PlatformError::os(format!("macOS inject task join: {e}")))?
    }

    fn capture_blocked_reason(&self) -> Option<String> {
        // A Mac always has a display, but ScreenCaptureKit yields nothing without the
        // Screen Recording (TCC) grant — capture then errors and the model would see a
        // blank. Report the actionable reason at Hello (non-prompting preflight) so the
        // control plane withholds the desktop cell instead of advertising a capture it
        // cannot perform.
        if macffi::screen_capture_granted() {
            None
        } else {
            Some(
                "Screen Recording permission not granted — enable it for OpenGeni in \
                 System Settings → Privacy & Security → Screen & System Audio Recording, \
                 then reconnect the machine."
                    .to_string(),
            )
        }
    }
}

/// Maps a leaf [`MacFfiError`](macffi::MacFfiError) onto a [`PlatformError`].
#[cfg(feature = "macos-desktop")]
fn map_ffi_err(err: macffi::MacFfiError) -> PlatformError {
    match err {
        macffi::MacFfiError::Unsupported(message) => PlatformError::Unsupported(message),
        macffi::MacFfiError::Ffi(message) => PlatformError::os(message),
    }
}

/// Maps a wire [`DesktopInput`](v1::DesktopInput) onto the leaf crate's plain
/// [`InputEvent`](macffi::InputEvent), mirroring the Linux XTEST mapping.
#[cfg(feature = "macos-desktop")]
fn map_input(input: &v1::DesktopInput) -> PlatformResult<macffi::InputEvent> {
    let Some(event) = &input.event else {
        return Err(PlatformError::os("DesktopInput carried no event"));
    };
    Ok(match event {
        v1::desktop_input::Event::Pointer(p) => macffi::InputEvent::Pointer {
            x: p.x,
            y: p.y,
            button: match p.button() {
                v1::PointerButton::Right => macffi::PointerButton::Right,
                v1::PointerButton::Middle => macffi::PointerButton::Middle,
                v1::PointerButton::Left | v1::PointerButton::Unspecified => {
                    macffi::PointerButton::Left
                }
            },
            action: match p.action() {
                v1::PointerAction::Down => macffi::PointerAction::Down,
                v1::PointerAction::Up => macffi::PointerAction::Up,
                v1::PointerAction::Click => macffi::PointerAction::Click,
                v1::PointerAction::DoubleClick => macffi::PointerAction::DoubleClick,
                v1::PointerAction::Move | v1::PointerAction::Unspecified => {
                    macffi::PointerAction::Move
                }
            },
        },
        v1::desktop_input::Event::Key(k) => {
            let (text, named) = if k.is_text {
                (Some(k.key.clone()), None)
            } else {
                (None, Some(k.key.clone()))
            };
            macffi::InputEvent::Key {
                text,
                named,
                action: match k.action() {
                    v1::KeyAction::Down => macffi::KeyAction::Down,
                    v1::KeyAction::Up => macffi::KeyAction::Up,
                    v1::KeyAction::Press | v1::KeyAction::Unspecified => macffi::KeyAction::Press,
                },
            }
        }
        v1::desktop_input::Event::Scroll(s) => macffi::InputEvent::Scroll {
            dx: s.delta_x,
            dy: s.delta_y,
        },
    })
}

/// PNG-encodes a tightly-packed RGBA8 buffer. Duplicated from the Linux backend's
/// encoder (a stable ~10-line helper) so the macOS path shares no cross-platform
/// module and the default (feature-off) build compiles nothing extra.
#[cfg(feature = "macos-desktop")]
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

// --- Stub backend (default; feature `macos-desktop` off) --------------------

#[cfg(not(feature = "macos-desktop"))]
#[async_trait]
impl DesktopBackend for MacosDesktop {
    fn probe(&self) -> Option<v1::Display> {
        // No display reported until the ScreenCaptureKit backend is enabled +
        // live-verified on a real Mac (build with `--features macos-desktop`).
        None
    }

    async fn capture(&self) -> PlatformResult<CapturedFrame> {
        Err(PlatformError::Unsupported(
            "macOS desktop capture (ScreenCaptureKit) is not enabled in this build".to_string(),
        ))
    }

    async fn inject(&self, _input: &v1::DesktopInput) -> PlatformResult<()> {
        Err(PlatformError::Unsupported(
            "macOS computer-use input (CGEvent) is not enabled in this build".to_string(),
        ))
    }
}
