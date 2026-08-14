//! Passive macOS input observation used to keep synthetic fallback subordinate
//! to the person at the machine.
//!
//! Every event OpenGeni posts is tagged with this helper process's private
//! marker. A listen-only Session event tap ignores those events and counts
//! physical input (and input from any other process). The caller can therefore
//! reject an operation before dispatch, or report an unknown outcome after
//! partial dispatch, instead of racing the user.

use core::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use objc2_core_foundation::{kCFRunLoopDefaultMode, CFMachPort, CFRunLoop};
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
    CGPreflightListenEventAccess,
};

use crate::MacFfiError;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(2);
const EVENT_TAP_POLL: Duration = Duration::from_millis(25);

#[derive(Debug)]
struct MonitorState {
    marker: AtomicI64,
    external_generation: AtomicU64,
    healthy: AtomicBool,
}

impl MonitorState {
    fn new(marker: i64) -> Self {
        Self {
            marker: AtomicI64::new(marker),
            external_generation: AtomicU64::new(0),
            healthy: AtomicBool::new(false),
        }
    }
}

/// Process-global passive observer. It contains only atomics and is safe to
/// query from the FFI callers; all CoreFoundation objects stay on their owning
/// event-tap thread.
#[derive(Debug, Clone)]
pub(super) struct InputActivityMonitor {
    state: Arc<MonitorState>,
}

impl InputActivityMonitor {
    fn start() -> Result<Self, MacFfiError> {
        if !CGPreflightListenEventAccess() {
            return Err(MacFfiError::PermissionDenied(
                "Input Monitoring permission is required so automated keyboard and pointer input yields to physical user input"
                    .to_string(),
            ));
        }

        let state = Arc::new(MonitorState::new(unique_marker()));
        let thread_state = Arc::clone(&state);
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("opengeni-input-monitor".to_string())
            .spawn(move || run_event_tap(&thread_state, &started_tx))
            .map_err(|error| {
                MacFfiError::Ffi(format!("failed to start physical-input monitor: {error}"))
            })?;

        match started_rx.recv_timeout(STARTUP_TIMEOUT) {
            Ok(Ok(())) => Ok(Self { state }),
            Ok(Err(message)) => Err(MacFfiError::Ffi(message)),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(MacFfiError::TimedOut(
                "physical-input monitor did not start within two seconds".to_string(),
            )),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(MacFfiError::Ffi(
                "physical-input monitor exited during startup".to_string(),
            )),
        }
    }

    pub(super) fn marker(&self) -> i64 {
        self.state.marker.load(Ordering::Acquire)
    }

    pub(super) fn external_generation(&self) -> Result<u64, MacFfiError> {
        if !self.state.healthy.load(Ordering::Acquire) {
            return Err(MacFfiError::Ffi(
                "physical-input monitor is unavailable; refusing synthetic input".to_string(),
            ));
        }
        Ok(self.state.external_generation.load(Ordering::Acquire))
    }
}

/// Obtain the live process monitor. Failed starts are deliberately not cached:
/// a helper that receives Input Monitoring permission while running can retry
/// successfully without a restart.
pub(super) fn input_activity_monitor() -> Result<InputActivityMonitor, MacFfiError> {
    static MONITOR: OnceLock<Mutex<Option<InputActivityMonitor>>> = OnceLock::new();
    let slot = MONITOR.get_or_init(|| Mutex::new(None));
    let mut guard = slot
        .lock()
        .map_err(|_| MacFfiError::Ffi("physical-input monitor lock was poisoned".to_string()))?;
    if let Some(monitor) = guard.as_ref() {
        // A disabled event tap is re-enabled by its owning run loop. Reuse that
        // one monitor so a transient gap cannot leak another event-tap thread.
        return Ok(monitor.clone());
    }
    let monitor = InputActivityMonitor::start()?;
    *guard = Some(monitor.clone());
    Ok(monitor)
}

fn unique_marker() -> i64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    let pid = u64::from(std::process::id());
    let mixed = now.rotate_left(17) ^ (pid << 32) ^ 0x4f47_454e_495f_4347;
    let marker = i64::from_ne_bytes(mixed.to_ne_bytes());
    if marker == 0 {
        1
    } else {
        marker
    }
}

fn observed_event_mask() -> u64 {
    [
        CGEventType::LeftMouseDown,
        CGEventType::LeftMouseUp,
        CGEventType::RightMouseDown,
        CGEventType::RightMouseUp,
        CGEventType::LeftMouseDragged,
        CGEventType::RightMouseDragged,
        CGEventType::KeyDown,
        CGEventType::KeyUp,
        CGEventType::FlagsChanged,
        CGEventType::ScrollWheel,
        CGEventType::OtherMouseDown,
        CGEventType::OtherMouseUp,
        CGEventType::OtherMouseDragged,
    ]
    .into_iter()
    .fold(0_u64, |mask, event_type| mask | (1_u64 << event_type.0))
}

fn run_event_tap(state: &Arc<MonitorState>, started_tx: &mpsc::SyncSender<Result<(), String>>) {
    let user_info = Arc::as_ptr(state).cast_mut().cast::<c_void>();
    // SAFETY: `event_tap_callback` has the exact CoreGraphics callback ABI and
    // `user_info` points to `state`, retained by this event-loop thread for its
    // entire lifetime.
    let tap = unsafe {
        CGEvent::tap_create(
            CGEventTapLocation::SessionEventTap,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            observed_event_mask(),
            Some(event_tap_callback),
            user_info,
        )
    };
    let Some(tap) = tap else {
        let _ = started_tx.send(Err(
            "CoreGraphics could not create the physical-input event tap".to_string(),
        ));
        return;
    };
    let Some(source) = CFMachPort::new_run_loop_source(None, Some(&tap), 0) else {
        let _ = started_tx.send(Err(
            "CoreFoundation could not create the physical-input run-loop source".to_string(),
        ));
        return;
    };
    let Some(run_loop) = CFRunLoop::current() else {
        let _ = started_tx.send(Err(
            "CoreFoundation returned no run loop for the physical-input monitor".to_string(),
        ));
        return;
    };
    // SAFETY: the CoreFoundation constant is process-global and immutable.
    let default_mode = unsafe { kCFRunLoopDefaultMode };
    run_loop.add_source(Some(&source), default_mode);
    CGEvent::tap_enable(&tap, true);
    if !CGEvent::tap_is_enabled(&tap) {
        let _ = started_tx.send(Err(
            "CoreGraphics created but could not enable the physical-input event tap".to_string(),
        ));
        return;
    }
    state.healthy.store(true, Ordering::Release);
    if started_tx.send(Ok(())).is_err() {
        state.healthy.store(false, Ordering::Release);
        return;
    }

    loop {
        CFRunLoop::run_in_mode(default_mode, EVENT_TAP_POLL.as_secs_f64(), true);
        if !CGEvent::tap_is_enabled(&tap) {
            // Treat a visibility gap as external activity. A caller in flight
            // will fail conservatively rather than continuing blind.
            state.healthy.store(false, Ordering::Release);
            state.external_generation.fetch_add(1, Ordering::AcqRel);
            CGEvent::tap_enable(&tap, true);
            state
                .healthy
                .store(CGEvent::tap_is_enabled(&tap), Ordering::Release);
        }
    }
}

unsafe extern "C-unwind" fn event_tap_callback(
    _proxy: objc2_core_graphics::CGEventTapProxy,
    event_type: CGEventType,
    event: NonNull<CGEvent>,
    user_info: *mut c_void,
) -> *mut CGEvent {
    if user_info.is_null() {
        return event.as_ptr();
    }
    // SAFETY: `run_event_tap` keeps the backing Arc alive for the lifetime of
    // the tap and supplies this exact pointer as `user_info`.
    let state = unsafe { &*user_info.cast::<MonitorState>() };
    if event_type == CGEventType::TapDisabledByTimeout
        || event_type == CGEventType::TapDisabledByUserInput
    {
        state.healthy.store(false, Ordering::Release);
        state.external_generation.fetch_add(1, Ordering::AcqRel);
        return event.as_ptr();
    }
    // SAFETY: CoreGraphics guarantees the event pointer is non-null and valid
    // for the callback duration.
    let event_ref = unsafe { event.as_ref() };
    let marker = CGEvent::integer_value_field(Some(event_ref), CGEventField::EventSourceUserData);
    if marker != state.marker.load(Ordering::Acquire) {
        state.external_generation.fetch_add(1, Ordering::AcqRel);
    }
    event.as_ptr()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_mask_contains_every_supported_input_family() {
        let mask = observed_event_mask();
        for event_type in [
            CGEventType::LeftMouseDown,
            CGEventType::OtherMouseDragged,
            CGEventType::KeyDown,
            CGEventType::FlagsChanged,
            CGEventType::ScrollWheel,
        ] {
            assert_ne!(mask & (1_u64 << event_type.0), 0);
        }
        // Passive cursor motion is not a conflicting interaction. Treating it
        // as one made targeted typing/paste fail whenever the person merely
        // moved their mouse while watching the agent. Clicks, drags, scrolls,
        // and keyboard input still preempt synthetic fallback.
        assert_eq!(mask & (1_u64 << CGEventType::MouseMoved.0), 0);
    }

    #[test]
    fn process_markers_are_nonzero() {
        assert_ne!(unique_marker(), 0);
    }
}
