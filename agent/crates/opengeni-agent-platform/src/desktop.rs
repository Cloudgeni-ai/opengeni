//! The desktop capability seam: screen capture, computer-use input injection, and
//! display probing — the platform half of the M8 desktop stream.
//!
//! The [`DesktopBackend`] trait is the single abstraction the agent's
//! `desktop_ensure` / `desktop_input` ops reach for. A connected agent reports a
//! [`Display`](opengeni_agent_proto::v1::Display) only when a backend can probe
//! one (a real X11 screen, an Xvfb virtual framebuffer, or — on macOS/Windows — a
//! native session); otherwise the control plane degrades the desktop cell to
//! `display_unavailable` (a value, never a crash, dossier §5/§10.6).
//!
//! # Safety posture
//!
//! The workspace forbids `unsafe_code`. Every backend here is built on a **safe
//! binding crate**: Linux uses [`x11rb`] (safe X11 + the `XTEST` and `RANDR`
//! extensions) for both capture and synthetic input, so no `unsafe` is needed.
//! The macОS/Windows backends are compile-only structured seams that return
//! [`PlatformError::Unsupported`] until their native (CGEvent/ScreenCaptureKit,
//! SendInput/DXGI) code lands and is live-verified (dossier §10.4, deferred to
//! M12). Wiring them through safe crates (or a narrowly-scoped `allow(unsafe_code)`
//! module) is the M12 task; the trait shape is fixed now so nothing reshapes.
//!
//! # Frame encoding
//!
//! Captured frames are PNG-encoded ([`CapturedFrame`]) so the relay framebuffer
//! pump can ship a self-describing image chunk over a `StreamFrame` without a
//! bespoke pixel-format negotiation. PNG is lossless + universally decodable by
//! the browser viewer; a future codec swap (e.g. a video stream) is a change to
//! the pump, not this seam.

use async_trait::async_trait;

use opengeni_agent_proto::v1;

use crate::error::{PlatformError, PlatformResult};

#[cfg(target_os = "linux")]
pub use crate::linux::LinuxDesktop;

/// A captured desktop frame: PNG-encoded image bytes plus the geometry they were
/// captured at. The relay framebuffer pump ships `png` as the `StreamFrame.data`
/// payload; `width`/`height` let the viewer size its canvas without decoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedFrame {
    /// PNG-encoded image bytes (self-describing; the viewer decodes directly).
    pub png: Vec<u8>,
    /// Frame width in pixels.
    pub width: u32,
    /// Frame height in pixels.
    pub height: u32,
}

/// A [`CapturedFrame`] fitted under a byte budget for the control-plane reply, with
/// the ORIGINAL capture geometry preserved so the computer-use coordinate mapping
/// can scale model clicks (in the encoded pixel space) back to native pixels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FittedFrame {
    /// The (possibly re-encoded/downscaled) PNG bytes to publish.
    pub png: Vec<u8>,
    /// The ENCODED image's width — what the model/viewer sees.
    pub width: u32,
    /// The ENCODED image's height.
    pub height: u32,
    /// The ORIGINAL (pre-downscale) capture width; equals `width` when no downscale.
    pub native_width: u32,
    /// The ORIGINAL (pre-downscale) capture height; equals `height` when no downscale.
    pub native_height: u32,
    /// Whether a downscale was applied (the PNG differs from the raw capture).
    pub downscaled: bool,
}

/// The smallest edge we will shrink a screenshot to before giving up — below this a
/// downscaled screen is useless for computer-use. If even this floor exceeds the
/// budget the frame is returned anyway (the wire-seam backstop converts the
/// un-publishable reply into a structured error).
const MIN_FIT_EDGE: u32 = 320;
/// Cap on re-encode attempts so a pathological compressor can never spin.
const MAX_FIT_ITERS: usize = 8;

/// Fit a captured frame's PNG under `budget` bytes so the control-plane reply can be
/// published. A full-resolution capture of a busy or Retina display can exceed the
/// transport's max payload (NATS defaults to 1 MiB); the reply publish then fails
/// agent-side and the caller times out with no cause. When the PNG is over budget we
/// DOWNSCALE the image (lossless PNG kept — JPEG artifacts hurt the model's text
/// reading) to the largest geometry that fits, reporting both the encoded and the
/// native geometry. A `budget` of 0 means "no known bound" → pass through untouched.
///
/// PNG size is content-dependent, so the first geometry guess (from the byte ratio)
/// is verified and shrunk further if still over — bounded by [`MAX_FIT_ITERS`] and a
/// [`MIN_FIT_EDGE`] floor.
#[must_use]
pub fn fit_frame_to_budget(frame: CapturedFrame, budget: usize) -> FittedFrame {
    let native_width = frame.width;
    let native_height = frame.height;
    let passthrough = |png: Vec<u8>, w: u32, h: u32, downscaled: bool| FittedFrame {
        png,
        width: w,
        height: h,
        native_width,
        native_height,
        downscaled,
    };

    if budget == 0 || frame.png.len() <= budget {
        return passthrough(frame.png, native_width, native_height, false);
    }

    // Decode once; if the PNG is somehow undecodable we cannot downscale — return it
    // as-is and let the wire-seam backstop surface a structured error.
    let decoded = match image::load_from_memory_with_format(&frame.png, image::ImageFormat::Png) {
        Ok(img) => img,
        Err(err) => {
            tracing::warn!(error = %err, "screenshot over budget but PNG undecodable; cannot downscale");
            return passthrough(frame.png, native_width, native_height, false);
        }
    };

    // Initial geometry guess: pixel count scales ~linearly with byte size for a given
    // image, so a linear-edge scale of sqrt(budget/len) targets the budget; 0.9 leaves
    // headroom for PNG's non-linear compression. Shrink 0.8× per miss thereafter.
    // The byte-length → f64 and scaled-dim → u32 casts below are inherently lossy but
    // bounded (dims are screen-sized, scale is clamped to [0.05, 1.0], and `.max(1)`
    // floors the result), so the precision/truncation is deliberate and harmless.
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss
    )]
    let mut scale = (budget as f64 / frame.png.len() as f64).sqrt() * 0.9;
    let mut best: Option<(Vec<u8>, u32, u32)> = None;
    for _ in 0..MAX_FIT_ITERS {
        scale = scale.clamp(0.05, 1.0);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let w = ((f64::from(native_width) * scale) as u32).max(1);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let h = ((f64::from(native_height) * scale) as u32).max(1);
        let resized = decoded.resize_exact(w, h, image::imageops::FilterType::Triangle);
        let mut png = Vec::new();
        if let Err(err) =
            resized.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        {
            tracing::warn!(error = %err, "re-encode of downscaled screenshot failed");
            break;
        }
        let fits = png.len() <= budget;
        best = Some((png, w, h));
        if fits {
            break;
        }
        if w <= MIN_FIT_EDGE || h <= MIN_FIT_EDGE {
            tracing::warn!(
                encoded_len = best.as_ref().map_or(0, |b| b.0.len()),
                budget,
                "screenshot still exceeds the transport budget at the minimum size; \
                 the reply will surface as a structured error"
            );
            break;
        }
        scale *= 0.8;
    }

    match best {
        Some((png, w, h)) => passthrough(png, w, h, true),
        // No re-encode succeeded at all → hand back the original (backstop errors it).
        None => passthrough(frame.png, native_width, native_height, false),
    }
}

/// The platform's desktop capability: probe a display, capture frames, inject
/// computer-use input. Implemented per-OS; a headless host with no backend uses
/// [`NoDesktop`], which reports no display and refuses capture/input with a typed
/// `Unsupported`.
#[async_trait]
pub trait DesktopBackend: Send + Sync {
    /// Probes for an available display. Returns `Some(Display)` when a screen (real
    /// or virtual) is present and capturable, `None` on a headless host. A `None`
    /// here is what drives the control plane's `display_unavailable` capability
    /// reason — it is a value, not an error.
    fn probe(&self) -> Option<v1::Display>;

    /// Captures the current desktop framebuffer as a PNG-encoded [`CapturedFrame`].
    ///
    /// # Errors
    ///
    /// Returns [`PlatformError::Unsupported`] on a backend with no display, or
    /// [`PlatformError::Os`] if the capture call fails.
    async fn capture(&self) -> PlatformResult<CapturedFrame>;

    /// Injects one computer-use input event (pointer move/click, key, scroll).
    ///
    /// The caller is responsible for the consent gate
    /// ([`consented_screen_control`](v1::Capabilities::consented_screen_control));
    /// a backend with no display still returns [`PlatformError::Unsupported`].
    ///
    /// # Errors
    ///
    /// Returns [`PlatformError::Unsupported`] when the backend cannot inject, or
    /// [`PlatformError::Os`] if the synthetic-input call fails.
    async fn inject(&self, input: &v1::DesktopInput) -> PlatformResult<()>;
}

/// The headless / unsupported-platform desktop backend: no display, no capture, no
/// input. Used when no real backend is available (a headless Linux box without
/// `--virtual-desktop`, or an OS whose native desktop code is not yet wired).
#[derive(Debug, Default, Clone, Copy)]
pub struct NoDesktop;

#[async_trait]
impl DesktopBackend for NoDesktop {
    fn probe(&self) -> Option<v1::Display> {
        None
    }

    async fn capture(&self) -> PlatformResult<CapturedFrame> {
        Err(PlatformError::Unsupported(
            "no desktop display available on this host (headless; enable --virtual-desktop)"
                .to_string(),
        ))
    }

    async fn inject(&self, _input: &v1::DesktopInput) -> PlatformResult<()> {
        Err(PlatformError::Unsupported(
            "no desktop display available on this host (headless; enable --virtual-desktop)"
                .to_string(),
        ))
    }
}

/// Resolves the desktop backend for the current host.
///
/// On Linux, attempts to open the X11 display named by `$DISPLAY` (real screen or
/// an Xvfb virtual framebuffer the caller spawned via [`crate::virtual_desktop`]);
/// if none is reachable, falls back to [`NoDesktop`] (the host reports
/// `display_unavailable`). On macOS/Windows, returns the structured native backend
/// (which is `Unsupported` until M12). Other targets get [`NoDesktop`].
#[must_use]
pub fn resolve_desktop() -> Box<dyn DesktopBackend> {
    #[cfg(target_os = "linux")]
    {
        match LinuxDesktop::open_default() {
            Ok(desktop) => Box::new(desktop),
            Err(reason) => {
                tracing::info!(reason = %reason, "no X11 display reachable; desktop unavailable");
                Box::new(NoDesktop)
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        Box::new(crate::macos::MacosDesktop::new())
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(crate::windows::WindowsDesktop::new())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        Box::new(NoDesktop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn no_desktop_probes_none_and_refuses_capture_and_input() {
        let d = NoDesktop;
        assert!(d.probe().is_none());
        assert!(matches!(
            d.capture().await,
            Err(PlatformError::Unsupported(_))
        ));
        let input = v1::DesktopInput::default();
        assert!(matches!(
            d.inject(&input).await,
            Err(PlatformError::Unsupported(_))
        ));
    }

    /// Encodes a `w`×`h` PNG whose pixels are pseudo-random (so it does NOT compress
    /// to near-nothing the way a solid fill would) — a realistic stand-in for a busy
    /// desktop capture, so the byte budget actually bites.
    fn noisy_png(w: u32, h: u32) -> Vec<u8> {
        let mut buf = image::RgbaImage::new(w, h);
        let mut state: u32 = 0x1234_5678;
        for px in buf.pixels_mut() {
            // A cheap xorshift so adjacent pixels differ (defeats PNG filtering).
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let b = state.to_le_bytes();
            *px = image::Rgba([b[0], b[1], b[2], 255]);
        }
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(buf)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .expect("encode test png");
        out
    }

    #[test]
    fn fit_frame_passes_through_when_under_budget_or_unbounded() {
        let png = noisy_png(64, 48);
        let frame = CapturedFrame {
            png: png.clone(),
            width: 64,
            height: 48,
        };
        // budget 0 = no known bound → untouched.
        let fitted = fit_frame_to_budget(frame.clone(), 0);
        assert!(!fitted.downscaled);
        assert_eq!(fitted.png, png);
        assert_eq!((fitted.width, fitted.height), (64, 48));
        assert_eq!((fitted.native_width, fitted.native_height), (64, 48));

        // A generous budget → untouched, and native == encoded (scale factor 1.0,
        // the no-regression guarantee).
        let fitted = fit_frame_to_budget(frame, png.len() + 1);
        assert!(!fitted.downscaled);
        assert_eq!((fitted.native_width, fitted.native_height), (64, 48));
        assert_eq!((fitted.width, fitted.height), (64, 48));
    }

    #[test]
    fn fit_frame_downscales_to_fit_and_preserves_native_geometry() {
        let png = noisy_png(400, 300);
        let native_len = png.len();
        let budget = native_len / 4;
        let frame = CapturedFrame {
            png,
            width: 400,
            height: 300,
        };
        let fitted = fit_frame_to_budget(frame, budget);
        assert!(fitted.downscaled, "an over-budget frame must be downscaled");
        // Native geometry is preserved so the server can scale clicks back.
        assert_eq!((fitted.native_width, fitted.native_height), (400, 300));
        // The encoded image is strictly smaller than native.
        assert!(fitted.width < 400 && fitted.height < 300);
        assert!(fitted.width >= 1 && fitted.height >= 1);
        // It actually fits the budget (this geometry is well above the MIN_FIT_EDGE
        // floor, so the loop converges rather than bottoming out).
        assert!(
            fitted.png.len() <= budget,
            "downscaled png {} must fit budget {budget}",
            fitted.png.len()
        );
        // And it is still a decodable PNG at the reported geometry.
        let decoded = image::load_from_memory_with_format(&fitted.png, image::ImageFormat::Png)
            .expect("downscaled png must decode");
        assert_eq!(decoded.width(), fitted.width);
        assert_eq!(decoded.height(), fitted.height);
    }
}
