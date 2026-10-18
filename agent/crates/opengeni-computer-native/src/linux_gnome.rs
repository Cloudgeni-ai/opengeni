//! GNOME on Wayland: whole-screen capture and input through Mutter.
//!
//! Wayland gives ordinary clients no way to read the screen or inject input,
//! and on GNOME the Xwayland root window cannot be captured either. Mutter's
//! own `org.gnome.Mutter.RemoteDesktop` and `org.gnome.Mutter.ScreenCast`
//! D-Bus services (the ones GNOME Remote Desktop uses) need no consent dialog
//! for a process in the user's session: one remote-desktop session records the
//! primary monitor as a PipeWire stream and accepts pointer and keyboard input
//! in that stream's pixel coordinates.
//!
//! The session starts when the computer is first used and stops after
//! [`IDLE_CLOSE`] without use. While it runs GNOME shows its screen-sharing
//! indicator, so the person always sees when an agent is looking at the screen.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, PoisonError, Weak};
use std::time::{Duration, Instant};

use futures::StreamExt as _;
use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder as _};
use opengeni_agent_pipewire_ffi::{FrameWait, PipeWireError, ScreenCastStream};
use opengeni_agent_platform::{
    linux_layout_text_keysyms, linux_named_key_chord_keysyms, CapturedFrame, LinuxRgbaFrame,
    PlatformError, PlatformResult,
};
use opengeni_agent_proto::v1;
use tokio::sync::Mutex;
use zbus::proxy::CacheProperties;
use zbus::zvariant::{OwnedObjectPath, Value};
use zbus::{Connection, Proxy};

const REMOTE_DESKTOP: &str = "org.gnome.Mutter.RemoteDesktop";
const REMOTE_DESKTOP_SESSION: &str = "org.gnome.Mutter.RemoteDesktop.Session";
const SCREEN_CAST: &str = "org.gnome.Mutter.ScreenCast";
const SCREEN_CAST_SESSION: &str = "org.gnome.Mutter.ScreenCast.Session";
const SCREEN_CAST_STREAM: &str = "org.gnome.Mutter.ScreenCast.Stream";

/// A running session that has not been used for this long is stopped, which
/// also removes GNOME's screen-sharing indicator.
const IDLE_CLOSE: Duration = Duration::from_secs(60);
const IDLE_CHECK: Duration = Duration::from_secs(10);
const SESSION_START: Duration = Duration::from_secs(5);
const FIRST_FRAME: Duration = Duration::from_secs(3);
/// After input, wait for the compositor to show its effect and for any
/// animation it started to pause. Mutter only sends frames when the screen
/// changes, so an unchanged screen returns the last frame after `first`.
const AFTER_INPUT: FrameWait = FrameWait {
    first: Duration::from_millis(150),
    // Longer than one frame at MAX_FPS, so a running animation is followed.
    quiet: Duration::from_millis(70),
    settle: Duration::from_millis(400),
};
/// Frame-rate cap requested from Mutter; frames are only read on demand.
const MAX_FPS: u32 = 20;
const MAX_SCROLL_STEPS: i32 = 32;

const BTN_LEFT: i32 = 0x110;
const BTN_RIGHT: i32 = 0x111;
const BTN_MIDDLE: i32 = 0x112;

/// What the current graphical session offers for whole-screen control.
pub(crate) enum WaylandScreen {
    /// Not a Wayland session; the X11 backend applies.
    NotWayland,
    /// GNOME on Wayland with Mutter's remote-desktop services.
    Gnome(Arc<GnomeScreen>),
    /// A Wayland session this adapter cannot see or control, with the reason.
    Unsupported(String),
}

fn is_wayland_session() -> bool {
    match std::env::var("XDG_SESSION_TYPE") {
        Ok(kind) if !kind.is_empty() => kind == "wayland",
        _ => std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var_os("DISPLAY").is_none(),
    }
}

fn current_desktop() -> String {
    std::env::var("XDG_CURRENT_DESKTOP")
        .ok()
        .filter(|desktop| !desktop.is_empty())
        .unwrap_or_else(|| "an unidentified desktop".to_string())
}

/// Detects the session type and, on GNOME Wayland, starts the first session so
/// the screen geometry is known and the first screenshot is immediate.
pub(crate) async fn detect() -> WaylandScreen {
    if !is_wayland_session() {
        return WaylandScreen::NotWayland;
    }
    let desktop = current_desktop();
    let bus = match Connection::session().await {
        Ok(bus) => bus,
        Err(error) => {
            return WaylandScreen::Unsupported(format!(
                "this Wayland session's D-Bus is unreachable ({error}), so the screen cannot be captured"
            ))
        }
    };
    if !(has_owner(&bus, REMOTE_DESKTOP).await && has_owner(&bus, SCREEN_CAST).await) {
        return WaylandScreen::Unsupported(format!(
            "seeing and controlling the screen on Wayland currently works on GNOME only, and this session runs {desktop}; sign in to a GNOME or an X11 session to use it"
        ));
    }
    let screen = Arc::new(GnomeScreen {
        bus,
        session: Mutex::new(None),
        geometry: StdMutex::new(None),
        last_used: StdMutex::new(Instant::now()),
        layout_display: std::env::var("DISPLAY")
            .ok()
            .filter(|value| !value.is_empty()),
        display_id: std::env::var("WAYLAND_DISPLAY")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "wayland-0".to_string()),
    });
    if let Err(error) = screen.session().await {
        return WaylandScreen::Unsupported(format!(
            "GNOME screen sharing could not start: {error}"
        ));
    }
    tokio::spawn(close_when_idle(Arc::downgrade(&screen)));
    WaylandScreen::Gnome(screen)
}

async fn has_owner(bus: &Connection, name: &'static str) -> bool {
    let Ok(dbus) = zbus::fdo::DBusProxy::new(bus).await else {
        return false;
    };
    let Ok(name) = zbus::names::BusName::try_from(name) else {
        return false;
    };
    dbus.name_has_owner(name).await.unwrap_or(false)
}

async fn close_when_idle(screen: Weak<GnomeScreen>) {
    loop {
        tokio::time::sleep(IDLE_CHECK).await;
        let Some(screen) = screen.upgrade() else {
            return;
        };
        if screen.idle_for() < IDLE_CLOSE {
            continue;
        }
        let session = screen.session.lock().await.take();
        if let Some(session) = session {
            session.stop().await;
        }
    }
}

fn os(context: &str, error: impl std::fmt::Display) -> PlatformError {
    PlatformError::os(format!("{context}: {error}"))
}

async fn proxy(
    bus: &Connection,
    destination: &'static str,
    path: OwnedObjectPath,
    interface: &'static str,
) -> PlatformResult<Proxy<'static>> {
    zbus::proxy::Builder::new(bus)
        .destination(destination)
        .and_then(|builder| builder.path(path))
        .and_then(|builder| builder.interface(interface))
        .map_err(|error| os("build Mutter D-Bus proxy", error))?
        .cache_properties(CacheProperties::No)
        .build()
        .await
        .map_err(|error| os("open Mutter D-Bus proxy", error))
}

fn object_path(path: &'static str) -> OwnedObjectPath {
    OwnedObjectPath::try_from(path).expect("constant D-Bus object path")
}

/// One running Mutter remote-desktop session with its screen-cast stream.
struct Session {
    remote_desktop: Proxy<'static>,
    stream_path: String,
    video: Arc<ScreenCastStream>,
    closed: Arc<AtomicBool>,
    /// Captures after input want a frame at least this new.
    input_floor: AtomicU64,
}

impl Session {
    fn alive(&self) -> bool {
        !self.closed.load(Ordering::Acquire) && self.video.failure().is_none()
    }

    async fn stop(&self) {
        if !self.closed.swap(true, Ordering::AcqRel) {
            let _ = self.remote_desktop.call_method("Stop", &()).await;
        }
    }

    async fn call(
        &self,
        method: &str,
        body: &(impl serde::Serialize + zbus::zvariant::DynamicType),
    ) -> PlatformResult<()> {
        self.remote_desktop
            .call_method(method, body)
            .await
            .map(|_| ())
            .map_err(|error| os(&format!("GNOME remote desktop {method}"), error))
    }

    async fn button(&self, button: i32, pressed: bool) -> PlatformResult<()> {
        self.call("NotifyPointerButton", &(button, pressed)).await
    }

    async fn keysym(&self, keysym: u32, pressed: bool) -> PlatformResult<()> {
        self.call("NotifyKeyboardKeysym", &(keysym, pressed)).await
    }

    async fn move_to(&self, x: i32, y: i32) -> PlatformResult<()> {
        self.call(
            "NotifyPointerMotionAbsolute",
            &(self.stream_path.as_str(), f64::from(x), f64::from(y)),
        )
        .await
    }
}

/// Whole-screen capture and input on GNOME Wayland.
pub(crate) struct GnomeScreen {
    bus: Connection,
    session: Mutex<Option<Arc<Session>>>,
    geometry: StdMutex<Option<(u32, u32)>>,
    last_used: StdMutex<Instant>,
    /// The Xwayland display whose keymap mirrors the compositor's layout.
    layout_display: Option<String>,
    display_id: String,
}

impl GnomeScreen {
    fn idle_for(&self) -> Duration {
        self.last_used
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .elapsed()
    }

    fn touch(&self) {
        *self
            .last_used
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Instant::now();
    }

    /// The recorded monitor, as of the latest frame.
    pub(crate) fn probe(&self) -> Option<v1::Display> {
        let (width, height) = (*self.geometry.lock().unwrap_or_else(PoisonError::into_inner))?;
        Some(v1::Display {
            id: self.display_id.clone(),
            width,
            height,
            r#virtual: false,
        })
    }

    async fn session(&self) -> PlatformResult<Arc<Session>> {
        self.touch();
        let mut slot = self.session.lock().await;
        if let Some(session) = slot.as_ref().filter(|session| session.alive()) {
            return Ok(Arc::clone(session));
        }
        if let Some(stale) = slot.take() {
            stale.stop().await;
        }
        let session = Arc::new(self.start().await?);
        *slot = Some(Arc::clone(&session));
        Ok(session)
    }

    async fn start(&self) -> PlatformResult<Session> {
        let root = proxy(
            &self.bus,
            REMOTE_DESKTOP,
            object_path("/org/gnome/Mutter/RemoteDesktop"),
            REMOTE_DESKTOP,
        )
        .await?;
        let remote_path: OwnedObjectPath = root
            .call("CreateSession", &())
            .await
            .map_err(|error| os("create GNOME remote desktop session", error))?;
        let remote_desktop = proxy(
            &self.bus,
            REMOTE_DESKTOP,
            remote_path,
            REMOTE_DESKTOP_SESSION,
        )
        .await?;
        let session_id: String = remote_desktop
            .get_property("SessionId")
            .await
            .map_err(|error| os("read GNOME remote desktop session id", error))?;
        let cast_root = proxy(
            &self.bus,
            SCREEN_CAST,
            object_path("/org/gnome/Mutter/ScreenCast"),
            SCREEN_CAST,
        )
        .await?;
        let options = HashMap::from([("remote-desktop-session-id", Value::from(session_id))]);
        let cast_path: OwnedObjectPath = cast_root
            .call("CreateSession", &(options,))
            .await
            .map_err(|error| os("create GNOME screen cast session", error))?;
        let cast = proxy(&self.bus, SCREEN_CAST, cast_path, SCREEN_CAST_SESSION).await?;
        // cursor-mode 0: the pointer is not painted into frames, as on X11.
        let record = HashMap::from([("cursor-mode", Value::U32(0))]);
        let stream_path: OwnedObjectPath = cast
            .call("RecordMonitor", &("", record))
            .await
            .map_err(|error| os("record the primary monitor", error))?;
        let stream = proxy(
            &self.bus,
            SCREEN_CAST,
            stream_path.clone(),
            SCREEN_CAST_STREAM,
        )
        .await?;
        let mut added = stream
            .receive_signal("PipeWireStreamAdded")
            .await
            .map_err(|error| os("watch the screen cast stream", error))?;
        let mut closed_signal = remote_desktop
            .receive_signal("Closed")
            .await
            .map_err(|error| os("watch the remote desktop session", error))?;
        remote_desktop
            .call_method("Start", &())
            .await
            .map_err(|error| os("start GNOME remote desktop session", error))?;
        let closed = Arc::new(AtomicBool::new(false));
        let video = match self.connect_video(&mut added).await {
            Ok(video) => video,
            Err(error) => {
                let _ = remote_desktop.call_method("Stop", &()).await;
                return Err(error);
            }
        };
        let watcher = Arc::clone(&closed);
        tokio::spawn(async move {
            let _ = closed_signal.next().await;
            watcher.store(true, Ordering::Release);
        });
        Ok(Session {
            remote_desktop,
            stream_path: stream_path.as_str().to_string(),
            video,
            closed,
            input_floor: AtomicU64::new(0),
        })
    }

    /// Waits for the stream's PipeWire node, connects to it and reads the
    /// first frame, which fixes the geometry that screen targets report.
    async fn connect_video(
        &self,
        added: &mut zbus::proxy::SignalStream<'_>,
    ) -> PlatformResult<Arc<ScreenCastStream>> {
        let node = tokio::time::timeout(SESSION_START, added.next())
            .await
            .ok()
            .flatten()
            .ok_or_else(|| {
                PlatformError::Timeout("GNOME did not publish the screen cast stream".into())
            })?
            .body()
            .deserialize::<u32>()
            .map_err(|error| os("read the screen cast PipeWire node", error))?;
        let (video, frame) = tokio::task::spawn_blocking(move || {
            let video = ScreenCastStream::connect(node, MAX_FPS)?;
            let frame = video.frame(1, FrameWait::first(FIRST_FRAME))?;
            Ok::<_, PipeWireError>((video, frame))
        })
        .await
        .map_err(|error| os("PipeWire connect task", error))?
        .map_err(pipewire_error)?;
        *self.geometry.lock().unwrap_or_else(PoisonError::into_inner) =
            Some((frame.width, frame.height));
        Ok(Arc::new(video))
    }

    /// Captures the recorded monitor as RGBA. After input it waits briefly for
    /// a frame that shows the input's effect.
    pub(crate) async fn capture_rgba(&self) -> PlatformResult<LinuxRgbaFrame> {
        match self.capture_once().await {
            Ok(frame) => Ok(frame),
            Err(PlatformError::Unsupported(message)) => Err(PlatformError::Unsupported(message)),
            // A failed capture stops its session. The person may have stopped
            // sharing from GNOME's indicator or the compositor restarted, so
            // one fresh session is worth trying.
            Err(_) => self.capture_once().await,
        }
    }

    async fn capture_once(&self) -> PlatformResult<LinuxRgbaFrame> {
        let session = self.session().await?;
        // Only the first capture after input waits for its effect.
        let floor = session.input_floor.swap(0, Ordering::AcqRel);
        let wait = if floor == 0 {
            FrameWait::first(FIRST_FRAME)
        } else {
            AFTER_INPUT
        };
        let video = Arc::clone(&session.video);
        let frame = tokio::task::spawn_blocking(move || video.frame(floor, wait))
            .await
            .map_err(|error| os("screen cast frame task", error))?;
        let frame = match frame {
            Ok(frame) => frame,
            Err(error) => {
                session.stop().await;
                return Err(pipewire_error(error));
            }
        };
        *self.geometry.lock().unwrap_or_else(PoisonError::into_inner) =
            Some((frame.width, frame.height));
        Ok(LinuxRgbaFrame {
            rgba: frame.rgba,
            width: frame.width,
            height: frame.height,
        })
    }

    /// Captures the recorded monitor as PNG.
    pub(crate) async fn capture(&self) -> PlatformResult<CapturedFrame> {
        let frame = self.capture_rgba().await?;
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(
                &frame.rgba,
                frame.width,
                frame.height,
                ExtendedColorType::Rgba8,
            )
            .map_err(|error| os("encode GNOME screen capture", error))?;
        Ok(CapturedFrame {
            png,
            width: frame.width,
            height: frame.height,
        })
    }

    /// Delivers one pointer, scroll or keyboard input in frame pixel coordinates.
    pub(crate) async fn inject(&self, input: &v1::DesktopInput) -> PlatformResult<()> {
        // Resolve keys before anything is sent, so unsupported text fails cleanly.
        let keysyms = match input.event.as_ref() {
            Some(v1::desktop_input::Event::Key(key)) if key.is_text => {
                let display = self.layout_display.clone();
                let text = key.key.clone();
                tokio::task::spawn_blocking(move || {
                    linux_layout_text_keysyms(display.as_deref(), &text)
                })
                .await
                .map_err(|error| os("keyboard layout task", error))??
            }
            Some(v1::desktop_input::Event::Key(key)) => linux_named_key_chord_keysyms(&key.key)?,
            Some(_) => Vec::new(),
            None => return Err(PlatformError::os("DesktopInput carried no event")),
        };
        let session = self.session().await?;
        let delivered = deliver(&session, input, &keysyms).await;
        session
            .input_floor
            .store(session.video.latest_sequence() + 1, Ordering::Release);
        delivered
    }
}

async fn deliver(
    session: &Session,
    input: &v1::DesktopInput,
    keysyms: &[u32],
) -> PlatformResult<()> {
    match input.event.as_ref() {
        Some(v1::desktop_input::Event::Pointer(pointer)) => {
            session.move_to(pointer.x, pointer.y).await?;
            let button = match pointer.button() {
                v1::PointerButton::Right => BTN_RIGHT,
                v1::PointerButton::Middle => BTN_MIDDLE,
                v1::PointerButton::Left | v1::PointerButton::Unspecified => BTN_LEFT,
            };
            let clicks = match pointer.action() {
                v1::PointerAction::Move | v1::PointerAction::Unspecified => 0,
                v1::PointerAction::Down => return session.button(button, true).await,
                v1::PointerAction::Up => return session.button(button, false).await,
                v1::PointerAction::Click => 1,
                v1::PointerAction::DoubleClick => 2,
            };
            for _ in 0..clicks {
                session.button(button, true).await?;
                session.button(button, false).await?;
            }
            Ok(())
        }
        Some(v1::desktop_input::Event::Scroll(scroll)) => {
            session.move_to(scroll.x, scroll.y).await?;
            // Discrete axis 0 is vertical, 1 horizontal; positive steps scroll
            // down/right, matching the X11 wheel-button convention.
            for (axis, delta) in [(0_u32, scroll.delta_y), (1, scroll.delta_x)] {
                let steps = delta.clamp(-MAX_SCROLL_STEPS, MAX_SCROLL_STEPS);
                if steps != 0 {
                    session
                        .call("NotifyPointerAxisDiscrete", &(axis, steps))
                        .await?;
                }
            }
            Ok(())
        }
        Some(v1::desktop_input::Event::Key(key)) => {
            let action = key.action();
            if key.is_text {
                for &keysym in keysyms {
                    if action != v1::KeyAction::Up {
                        session.keysym(keysym, true).await?;
                    }
                    if action != v1::KeyAction::Down {
                        session.keysym(keysym, false).await?;
                    }
                }
                return Ok(());
            }
            if action != v1::KeyAction::Up {
                for &keysym in keysyms {
                    session.keysym(keysym, true).await?;
                }
            }
            if action != v1::KeyAction::Down {
                for &keysym in keysyms.iter().rev() {
                    session.keysym(keysym, false).await?;
                }
            }
            Ok(())
        }
        None => Err(PlatformError::os("DesktopInput carried no event")),
    }
}

fn pipewire_error(error: PipeWireError) -> PlatformError {
    match error {
        PipeWireError::Unavailable(message) => PlatformError::Unsupported(format!(
            "GNOME screen capture needs the PipeWire client library: {message}"
        )),
        PipeWireError::Timeout(wait) => {
            PlatformError::Timeout(format!("GNOME sent no screen frame within {wait:?}"))
        }
        PipeWireError::Failed(message) => os("GNOME screen cast", message),
    }
}
