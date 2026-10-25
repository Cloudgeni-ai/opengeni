//! The desktop capability seam: screen capture, computer-use input injection, and
//! display probing — the platform half of the M8 desktop stream.
//!
//! The [`DesktopBackend`] trait is the single abstraction the agent's
//! `desktop_ensure` / `desktop_input` ops reach for. A connected agent reports a
//! [`Display`](opengeni_agent_proto::v1::Display) only when a backend can probe
//! one (a real X11 screen, an Xvfb virtual framebuffer, or — on macOS/Windows — a
//! native session); otherwise the control plane degrades the desktop cell to
//! `display_unavailable` (a value, never a crash).
//!
//! # Safety posture
//!
//! The workspace forbids `unsafe_code`. Linux uses [`x11rb`] (safe X11 + the
//! `XTEST` and `RANDR` extensions) for capture and synthetic input. macOS and
//! Windows reach their native APIs (ScreenCaptureKit/CGEvent, GDI/`SendInput`)
//! through leaf FFI crates that confine every `unsafe` behind a safe API, so this
//! crate keeps `unsafe_code` forbidden.
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
pub use crate::linux::{
    linux_layout_text_keysyms, linux_named_key_chord_keysyms, validate_linux_named_key_chord,
    LinuxDesktop, LinuxRgbaFrame, LinuxWindow, LinuxWindowRect, X11Display, XServerCheck,
};

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

    /// Whether enrollment can offer screen-control consent. This reports display
    /// presence, not permission to capture it. Capture/input remain independently
    /// gated after the user approves the connection.
    fn can_offer_display(&self) -> bool {
        self.probe().is_some()
    }

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

    /// A CAPABILITY PREFLIGHT: when a display physically exists but the OS withholds
    /// the screen-CAPTURE grant (macOS Screen Recording / TCC), returns a human,
    /// actionable reason. `None` when capture is permitted OR the platform has no
    /// separate capture grant (Linux/x11 capture works whenever the display does).
    ///
    /// This is a NON-PROMPTING, cheap check (macOS `CGPreflightScreenCaptureAccess`).
    /// The supervisor calls it at Hello/reconnect so the control plane can degrade the
    /// desktop cell with a legible hint instead of advertising a desktop the agent
    /// cannot actually capture (which surfaces to the model as a blank screen — the
    /// 0.1.3 TCC-denied incident). Default `None` keeps every non-macOS backend
    /// unchanged.
    fn capture_blocked_reason(&self) -> Option<String> {
        None
    }
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

/// The desktop backend of a computer whose owner turned screen control off on
/// the computer itself (in the desktop app that runs this agent). It never
/// touches the screen: no probe, no capture, no input, so the system is never
/// asked for Screen Recording or Accessibility either. `reason` is what the
/// control plane shows instead of the screen.
#[derive(Debug, Clone)]
pub struct TurnedOffDesktop {
    reason: String,
}

impl TurnedOffDesktop {
    /// A turned-off desktop that reports `reason` instead of the screen.
    #[must_use]
    pub fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }
}

#[async_trait]
impl DesktopBackend for TurnedOffDesktop {
    fn probe(&self) -> Option<v1::Display> {
        None
    }

    fn can_offer_display(&self) -> bool {
        false
    }

    async fn capture(&self) -> PlatformResult<CapturedFrame> {
        Err(PlatformError::Unsupported(self.reason.clone()))
    }

    async fn inject(&self, _input: &v1::DesktopInput) -> PlatformResult<()> {
        Err(PlatformError::Unsupported(self.reason.clone()))
    }

    fn capture_blocked_reason(&self) -> Option<String> {
        Some(self.reason.clone())
    }
}

/// The least time between two attempts to open a desktop that is not there,
/// so a burst of callers (a probe, then a capture) makes one attempt. The
/// agent's desktop status refresh probes every few seconds, so a desktop that
/// appears is found within that refresh.
const REOPEN_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// A desktop that comes and goes while the agent runs: the person signs in
/// after a per-user service started, signs out, or the display manager writes
/// a new cookie at login. Every probe, capture and input opens it again when
/// it is not open, and a probe that finds the open one gone drops it and looks
/// again, so availability follows the machine both ways without restarting
/// the agent. While none opens, [`DesktopBackend::capture_blocked_reason`]
/// says why in plain words.
pub struct ReopeningDesktop<D> {
    inner: std::sync::Arc<ReopeningInner<D>>,
}

type DesktopOpener<D> = Box<dyn Fn() -> Result<D, String> + Send + Sync>;

struct ReopeningInner<D> {
    open: DesktopOpener<D>,
    state: std::sync::Mutex<ReopenState<D>>,
    /// Held while opening, so concurrent callers make one attempt.
    opening: std::sync::Mutex<()>,
}

struct ReopenState<D> {
    /// The open desktop and the generation it was opened in.
    current: Option<(u64, D)>,
    generation: u64,
    /// Why the last attempt found no desktop.
    reason: Option<String>,
    attempted: Option<std::time::Instant>,
}

impl<D: DesktopBackend + Clone + 'static> ReopeningDesktop<D> {
    /// A desktop opened by `open`, tried once now and again whenever it is
    /// needed and not open.
    pub fn new(open: impl Fn() -> Result<D, String> + Send + Sync + 'static) -> Self {
        let desktop = Self {
            inner: std::sync::Arc::new(ReopeningInner {
                open: Box::new(open),
                state: std::sync::Mutex::new(ReopenState {
                    current: None,
                    generation: 0,
                    reason: None,
                    attempted: None,
                }),
                opening: std::sync::Mutex::new(()),
            }),
        };
        let _ = desktop.inner.ensure();
        desktop
    }
}

impl<D: DesktopBackend + Clone> ReopeningInner<D> {
    fn lock(&self) -> std::sync::MutexGuard<'_, ReopenState<D>> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The open desktop, opening it when there is none. Blocking.
    fn ensure(&self) -> Result<(u64, D), String> {
        if let Some(current) = self.lock().current.clone() {
            return Ok(current);
        }
        let _opening = self
            .opening
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        {
            let state = self.lock();
            if let Some(current) = state.current.clone() {
                return Ok(current);
            }
            if let (Some(reason), Some(attempted)) = (&state.reason, state.attempted) {
                if attempted.elapsed() < REOPEN_MIN_INTERVAL {
                    return Err(reason.clone());
                }
            }
        }
        let opened = (self.open)();
        let mut state = self.lock();
        state.attempted = Some(std::time::Instant::now());
        match opened {
            Ok(desktop) => {
                state.generation += 1;
                let current = (state.generation, desktop);
                state.current = Some(current.clone());
                if state.reason.take().is_some() {
                    tracing::info!("desktop is available again");
                }
                Ok(current)
            }
            Err(reason) => {
                if state.reason.as_deref() != Some(reason.as_str()) {
                    tracing::info!(reason = %reason, "desktop unavailable");
                }
                state.reason = Some(reason.clone());
                Err(reason)
            }
        }
    }

    /// Drops the desktop opened in `generation`, which no longer answers.
    fn lost(&self, generation: u64) {
        let mut state = self.lock();
        if state
            .current
            .as_ref()
            .is_some_and(|(open, _)| *open == generation)
        {
            state.current = None;
            // The next attempt runs at once, not after the minimum interval.
            state.attempted = None;
        }
    }
}

impl<D: DesktopBackend + Clone + 'static> ReopeningDesktop<D> {
    /// The open desktop and its generation, opened on the blocking pool when
    /// there is none.
    async fn ensure_async(&self) -> PlatformResult<(u64, D)> {
        if let Some(current) = self.inner.lock().current.clone() {
            return Ok(current);
        }
        let inner = std::sync::Arc::clone(&self.inner);
        crate::spawn_blocking_reserved(move || inner.ensure())
            .await
            .map_err(|error| PlatformError::os(format!("desktop open task join: {error}")))?
            .map_err(PlatformError::Unsupported)
    }

    /// After a capture or input failed: when the desktop opened in
    /// `generation` no longer answers, drops it and looks for the current
    /// one. `None` while the failed desktop still answers (the failure was the
    /// operation's own), else the desktop found now or why there is none.
    async fn recheck_after_failure(
        &self,
        generation: u64,
        failed: D,
    ) -> Option<PlatformResult<(u64, D)>> {
        let answering = crate::spawn_blocking_reserved(move || failed.probe().is_some())
            .await
            .unwrap_or(false);
        if answering {
            return None;
        }
        self.inner.lost(generation);
        Some(self.ensure_async().await)
    }
}

#[async_trait]
impl<D: DesktopBackend + Clone + 'static> DesktopBackend for ReopeningDesktop<D> {
    fn probe(&self) -> Option<v1::Display> {
        let (generation, desktop) = self.inner.ensure().ok()?;
        if let Some(display) = desktop.probe() {
            return Some(display);
        }
        // The desktop went away (sign-out, a restarted display server): look
        // for the current one.
        self.inner.lost(generation);
        let (_, desktop) = self.inner.ensure().ok()?;
        desktop.probe()
    }

    async fn capture(&self) -> PlatformResult<CapturedFrame> {
        let (generation, desktop) = self.ensure_async().await?;
        let error = match desktop.capture().await {
            Ok(frame) => return Ok(frame),
            Err(error) => error,
        };
        match self.recheck_after_failure(generation, desktop).await {
            None => Err(error),
            // A capture of whichever desktop is there now is still a capture.
            Some(Ok((_, current))) => current.capture().await,
            Some(Err(reason)) => Err(reason),
        }
    }

    async fn inject(&self, input: &v1::DesktopInput) -> PlatformResult<()> {
        let (generation, desktop) = self.ensure_async().await?;
        let error = match desktop.inject(input).await {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };
        match self.recheck_after_failure(generation, desktop).await {
            // Input meant for the lost desktop is never replayed on another.
            None | Some(Ok(_)) => Err(error),
            Some(Err(reason)) => Err(reason),
        }
    }

    fn capture_blocked_reason(&self) -> Option<String> {
        let state = self.inner.lock();
        match &state.current {
            Some((_, desktop)) => desktop.capture_blocked_reason(),
            None => state.reason.clone(),
        }
    }
}

/// Resolves the desktop backend for the current host.
///
/// On Linux, opens the desktop of the user the agent runs as: `$DISPLAY` when it
/// is set (a real screen, or an Xvfb virtual framebuffer the caller spawned via
/// [`crate::virtual_desktop`]), otherwise the display of that user's graphical
/// login session. The desktop is opened again whenever it is needed and not
/// open ([`ReopeningDesktop`]), so an agent started before the person signs in
/// finds the desktop once they do. On macOS/Windows, returns the native backend,
/// which probes the signed-in session's display. Other targets get
/// [`NoDesktop`].
#[must_use]
pub fn resolve_desktop() -> Box<dyn DesktopBackend> {
    #[cfg(target_os = "linux")]
    {
        Box::new(ReopeningDesktop::new(LinuxDesktop::open_default))
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
    async fn no_desktop_has_no_capture_grant_concept() {
        // The capture-preflight default is None on every non-macOS backend (Linux/x11
        // capture works whenever the display does — there is no separate grant), so the
        // supervisor never withholds `desktop` for a phantom grant reason off macOS.
        assert!(NoDesktop.capture_blocked_reason().is_none());
    }

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

    #[tokio::test]
    async fn turned_off_desktop_never_offers_captures_or_injects_and_says_why() {
        let d = TurnedOffDesktop::new("Screen control is turned off on this computer.");
        assert!(d.probe().is_none());
        assert!(!d.can_offer_display());
        assert_eq!(
            d.capture_blocked_reason().as_deref(),
            Some("Screen control is turned off on this computer.")
        );
        assert!(matches!(
            d.capture().await,
            Err(PlatformError::Unsupported(reason)) if reason.contains("turned off")
        ));
        assert!(matches!(
            d.inject(&v1::DesktopInput::default()).await,
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

    /// REGRESSION GUARD (blank-screenshot incident): fitting NEVER yields empty or
    /// blank bytes from a VALID capture — the whole "Mac screenshot came back blank"
    /// class of failure cannot originate in `fit_frame_to_budget`. Uses the EXACT
    /// macOS wire encoding (a tightly-packed RGBA8 buffer through `PngEncoder`, same
    /// as `macos::encode_png`) at a Retina-ish size, forces an aggressive downscale,
    /// and asserts the result is a non-empty, decodable, NON-degenerate image.
    #[test]
    fn fit_never_produces_empty_or_degenerate_bytes_from_a_valid_macos_capture() {
        use image::ImageEncoder as _;

        // Encode a 1600×1000 pseudo-random RGBA8 buffer the macOS way (PngEncoder,
        // Rgba8) — a realistic busy-desktop stand-in that will not compress to nothing.
        let (w, h) = (1600u32, 1000u32);
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        let mut state: u32 = 0x9E37_79B9;
        for chunk in rgba.chunks_exact_mut(4) {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let b = state.to_le_bytes();
            chunk.copy_from_slice(&[b[0], b[1], b[2], 0xFF]);
        }
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&rgba, w, h, image::ExtendedColorType::Rgba8)
            .expect("encode macOS-style png");
        assert_ne!(png.len(), 0);

        // Force a hard downscale: budget a fraction of the native PNG size.
        let budget = png.len() / 8;
        let fitted = fit_frame_to_budget(
            CapturedFrame {
                png,
                width: w,
                height: h,
            },
            budget,
        );

        // The core regression assertions: bytes are NEVER empty, geometry NEVER
        // collapses to a degenerate 1×1, native geometry is preserved, and the bytes
        // decode back to a real image at the reported size.
        assert!(!fitted.png.is_empty(), "fit must never emit empty bytes");
        assert!(fitted.downscaled);
        assert_eq!((fitted.native_width, fitted.native_height), (w, h));
        assert!(fitted.width >= MIN_FIT_EDGE || fitted.height >= MIN_FIT_EDGE);
        let decoded = image::load_from_memory_with_format(&fitted.png, image::ImageFormat::Png)
            .expect("fitted macOS png must decode");
        assert_eq!(decoded.width(), fitted.width);
        assert_eq!(decoded.height(), fitted.height);
    }

    /// A machine's screen as the agent finds it: what the next open returns,
    /// and whether the display opened last still answers.
    #[derive(Default)]
    struct Screen {
        /// `Ok(display name)` or `Err(reason)` for the next open.
        next_open: std::sync::Mutex<Option<Result<String, String>>>,
        answering: std::sync::atomic::AtomicBool,
        opens: std::sync::atomic::AtomicUsize,
    }

    #[derive(Clone)]
    struct ScreenDesktop {
        name: String,
        screen: std::sync::Arc<Screen>,
    }

    #[async_trait]
    impl DesktopBackend for ScreenDesktop {
        fn probe(&self) -> Option<v1::Display> {
            self.screen
                .answering
                .load(std::sync::atomic::Ordering::SeqCst)
                .then(|| v1::Display {
                    id: self.name.clone(),
                    width: 1280,
                    height: 800,
                    r#virtual: false,
                })
        }

        async fn capture(&self) -> PlatformResult<CapturedFrame> {
            if self.probe().is_none() {
                return Err(PlatformError::os("the display stopped answering"));
            }
            Ok(CapturedFrame {
                png: self.name.clone().into_bytes(),
                width: 1280,
                height: 800,
            })
        }

        async fn inject(&self, _input: &v1::DesktopInput) -> PlatformResult<()> {
            match self.probe() {
                Some(_) => Ok(()),
                None => Err(PlatformError::os("the display stopped answering")),
            }
        }
    }

    impl Screen {
        fn set(&self, next: Result<&str, &str>) {
            *self.next_open.lock().unwrap() =
                Some(next.map(str::to_string).map_err(str::to_string));
        }

        fn desktop(self: &std::sync::Arc<Self>) -> ReopeningDesktop<ScreenDesktop> {
            let screen = std::sync::Arc::clone(self);
            ReopeningDesktop::new(move || {
                screen
                    .opens
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let name = screen
                    .next_open
                    .lock()
                    .unwrap()
                    .clone()
                    .expect("scripted open")?;
                screen
                    .answering
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(ScreenDesktop {
                    name,
                    screen: std::sync::Arc::clone(&screen),
                })
            })
        }

        fn opens(&self) -> usize {
            self.opens.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    /// Waits out the least time between attempts to open a missing desktop.
    fn after_reopen_interval() {
        std::thread::sleep(REOPEN_MIN_INTERVAL + std::time::Duration::from_millis(50));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_refused_cookie_at_startup_clears_once_the_login_writes_the_new_one() {
        // The agent's service starts a moment before the display manager writes
        // the session's cookie: the first open is refused.
        let screen = std::sync::Arc::new(Screen::default());
        screen.set(Err(
            "The desktop on display :0 could not be opened: X11 setup failed: 'Invalid MIT-MAGIC-COOKIE-1 key'.",
        ));
        let desktop = screen.desktop();
        assert!(desktop.probe().is_none());
        assert!(desktop
            .capture_blocked_reason()
            .is_some_and(|reason| reason.contains("Invalid MIT-MAGIC-COOKIE-1 key")));
        assert!(matches!(
            desktop.capture().await,
            Err(PlatformError::Unsupported(reason)) if reason.contains("MIT-MAGIC-COOKIE-1")
        ));
        // A burst of callers makes one attempt.
        assert_eq!(screen.opens(), 1);
        // The login writes the new cookie; the next check opens the desktop.
        screen.set(Ok(":0"));
        after_reopen_interval();
        assert_eq!(
            desktop.probe().map(|display| display.id).as_deref(),
            Some(":0")
        );
        assert_eq!(desktop.capture_blocked_reason(), None);
        assert_eq!(desktop.capture().await.unwrap().png, b":0");
        // An open desktop is reused, not opened again.
        assert!(desktop.probe().is_some());
        assert_eq!(screen.opens(), 2);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_desktop_that_appears_later_is_found_by_capture_and_input_too() {
        let screen = std::sync::Arc::new(Screen::default());
        screen.set(Err("No one is signed in to a desktop on this machine."));
        let desktop = screen.desktop();
        assert!(!desktop.can_offer_display());
        screen.set(Ok(":1"));
        after_reopen_interval();
        // Capture and input open it on demand, without waiting for a probe.
        assert_eq!(desktop.capture().await.unwrap().png, b":1");
        desktop.inject(&v1::DesktopInput::default()).await.unwrap();
        assert!(desktop.can_offer_display());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_desktop_that_goes_away_is_reported_with_the_reason_and_found_again() {
        let screen = std::sync::Arc::new(Screen::default());
        screen.set(Ok(":0"));
        let desktop = screen.desktop();
        assert!(desktop.probe().is_some());
        // The person signs out: the display stops answering and no session is left.
        screen
            .answering
            .store(false, std::sync::atomic::Ordering::SeqCst);
        screen.set(Err("No one is signed in to a desktop on this machine."));
        assert!(desktop.probe().is_none());
        assert_eq!(
            desktop.capture_blocked_reason().as_deref(),
            Some("No one is signed in to a desktop on this machine.")
        );
        assert!(matches!(
            desktop.capture().await,
            Err(PlatformError::Unsupported(reason)) if reason.starts_with("No one is signed in")
        ));
        // They sign in again, on another display.
        screen.set(Ok(":1"));
        after_reopen_interval();
        assert_eq!(
            desktop.probe().map(|display| display.id).as_deref(),
            Some(":1")
        );
        assert_eq!(desktop.capture_blocked_reason(), None);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failing_capture_or_input_drops_a_desktop_that_went_away() {
        let screen = std::sync::Arc::new(Screen::default());
        screen.set(Ok(":0"));
        let desktop = screen.desktop();
        // The person signs out between two captures: the capture fails, the
        // dead desktop is dropped at once, and the error says why.
        screen
            .answering
            .store(false, std::sync::atomic::Ordering::SeqCst);
        screen.set(Err("No one is signed in to a desktop on this machine."));
        assert!(matches!(
            desktop.capture().await,
            Err(PlatformError::Unsupported(reason)) if reason.starts_with("No one is signed in")
        ));
        assert_eq!(screen.opens(), 2);
        assert!(desktop.capture_blocked_reason().is_some());
        // They sign in again: the next capture finds the new desktop.
        screen.set(Ok(":1"));
        after_reopen_interval();
        assert_eq!(desktop.capture().await.unwrap().png, b":1");
        // Input to a desktop that went away fails and is not replayed on the
        // desktop found in its place, which becomes the current one.
        screen
            .answering
            .store(false, std::sync::atomic::Ordering::SeqCst);
        screen.set(Ok(":2"));
        assert!(matches!(
            desktop.inject(&v1::DesktopInput::default()).await,
            Err(PlatformError::Os { .. })
        ));
        assert_eq!(
            desktop.probe().map(|display| display.id).as_deref(),
            Some(":2")
        );
        // A failure while the desktop still answers is the operation's own and
        // does not reopen anything.
        let opens = screen.opens();
        assert!(desktop.capture().await.is_ok());
        assert_eq!(screen.opens(), opens);
    }
}
