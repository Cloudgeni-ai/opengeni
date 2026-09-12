//! Retained ScreenCaptureKit live capture.
//!
//! One `SCStream` is owned by one dedicated Rust thread. ScreenCaptureKit calls
//! the Objective-C output object on a private serial dispatch queue; that object
//! publishes only the newest tightly-packed RGBA frame into a bounded slot.
//! Consumers therefore cannot build an unbounded decode/copy queue.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AnyThread as _, DefinedClass as _};
use objc2_core_media::{CMSampleBuffer, CMTime};
use objc2_core_video::{
    kCVPixelFormatType_32BGRA, kCVReturnSuccess, CVPixelBufferGetBaseAddress,
    CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight, CVPixelBufferGetPixelFormatType,
    CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags,
    CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{
    SCContentFilter, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamDelegate,
    SCStreamOutput, SCStreamOutputType, SCWindow,
};

use super::{display_pixel_dims, fit_capture_size, window_backing_scale, MAX_CAPTURE_PIXELS};
use crate::{MacFfiError, MacRect, RgbaFrame};

const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);
const FRAME_TIMEOUT: Duration = Duration::from_secs(3);
const STOP_TIMEOUT: Duration = Duration::from_secs(3);
const LIVE_FRAMES_PER_SECOND: i32 = 12;

#[derive(Clone, Copy)]
enum CaptureSource {
    Display {
        display_id: u32,
    },
    Window {
        window_id: u32,
        expected_process_id: u32,
    },
}

#[derive(Default)]
struct FrameState {
    frame: Option<RgbaFrame>,
    failure: Option<String>,
    stopped: bool,
}

#[derive(Default)]
struct FrameSlot {
    state: Mutex<FrameState>,
    changed: Condvar,
}

impl FrameSlot {
    fn publish(&self, result: Result<RgbaFrame, String>) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        match result {
            Ok(frame) => {
                state.frame = Some(frame);
                state.failure = None;
            }
            Err(error) => state.failure = Some(error),
        }
        self.changed.notify_all();
    }

    fn fail(&self, error: String) {
        self.publish(Err(error));
    }

    fn stop(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.stopped = true;
            self.changed.notify_all();
        }
    }
}

struct OutputIvars {
    slot: Arc<FrameSlot>,
}

struct PixelBufferUnlock<'a>(&'a objc2_core_video::CVPixelBuffer, CVPixelBufferLockFlags);

impl Drop for PixelBufferUnlock<'_> {
    fn drop(&mut self) {
        // SAFETY: this guard exists only after the matching lock succeeded.
        let _ = unsafe { CVPixelBufferUnlockBaseAddress(self.0, self.1) };
    }
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements. The sole ivar is an
    // Arc containing synchronized Rust state and this class does not implement Drop.
    #[unsafe(super(NSObject))]
    #[name = "OpenGeniScreenCaptureOutput"]
    #[ivars = OutputIvars]
    struct CaptureOutput;

    // SAFETY: NSObjectProtocol has no additional invariants.
    unsafe impl NSObjectProtocol for CaptureOutput {}

    // SAFETY: the selector and argument types exactly match SCStreamOutput.
    unsafe impl SCStreamOutput for CaptureOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn did_output(
            &self,
            _stream: &SCStream,
            sample_buffer: &CMSampleBuffer,
            output_type: SCStreamOutputType,
        ) {
            crate::with_autorelease_pool(|| {
                if output_type == SCStreamOutputType::Screen {
                    match sample_to_rgba(sample_buffer) {
                        Ok(Some(frame)) => self.ivars().slot.publish(Ok(frame)),
                        Ok(None) => {}
                        Err(error) => self.ivars().slot.fail(error),
                    }
                }
            });
        }
    }

    // SAFETY: the selector and argument types exactly match SCStreamDelegate.
    unsafe impl SCStreamDelegate for CaptureOutput {
        #[unsafe(method(stream:didStopWithError:))]
        fn did_stop(&self, _stream: &SCStream, error: &NSError) {
            crate::with_autorelease_pool(|| {
                self.ivars()
                    .slot
                    .fail(format!("ScreenCaptureKit stream stopped: {error}"));
            });
        }
    }
);

impl CaptureOutput {
    fn new(slot: Arc<FrameSlot>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(OutputIvars { slot });
        // SAFETY: this invokes NSObject's designated initializer on a fresh object.
        unsafe { msg_send![super(this), init] }
    }
}

struct StreamRuntime {
    stream: Retained<SCStream>,
    output: Retained<CaptureOutput>,
    queue: DispatchRetained<DispatchQueue>,
    start_requested: bool,
    start_completion: Arc<StartCompletion>,
}

/// The second event owns teardown: completion after abandonment, or normal
/// abandonment after completion. Stopping a still-pending start is insufficient
/// because the OS may start producing frames after that stop returned an error.
#[derive(Default)]
struct StartCompletion(AtomicU8);

impl StartCompletion {
    fn complete(&self) -> bool {
        self.0.fetch_or(1, Ordering::AcqRel) & 2 != 0
    }

    fn abandon(&self) -> bool {
        self.0.fetch_or(2, Ordering::AcqRel) & 1 != 0
    }
}

impl Drop for StreamRuntime {
    fn drop(&mut self) {
        // Keep the native resources in the completion block until a pending
        // start finishes. That callback then owns the final stop and detach.
        if self.start_requested && !self.start_completion.abandon() {
            return;
        }
        if self.start_requested {
            let (stopped_tx, stopped_rx) = mpsc::channel();
            let stopped = block2::RcBlock::new(move |error: *mut NSError| {
                let _ = stopped_tx.send(error_message(error));
            });
            // SAFETY: only this owner calls start/stop after construction.
            unsafe {
                self.stream
                    .stopCaptureWithCompletionHandler(Some(&*stopped));
            }
            let _ = stopped_rx.recv_timeout(STOP_TIMEOUT);
        }
        let output: &ProtocolObject<dyn SCStreamOutput> = ProtocolObject::from_ref(&*self.output);
        // SAFETY: remove the exact output registered during construction. If
        // discovery completed after its receiver expired, capture never started.
        let _ = unsafe {
            self.stream
                .removeStreamOutput_type_error(output, SCStreamOutputType::Screen)
        };
    }
}

fn stop_abandoned_start(
    stream: &Retained<SCStream>,
    output: Retained<CaptureOutput>,
    queue: DispatchRetained<DispatchQueue>,
) {
    let stopped_stream = stream.clone();
    let stopped = block2::RcBlock::new(move |_error: *mut NSError| {
        crate::with_autorelease_pool(|| {
            let _keep_queue_alive = &queue;
            let output: &ProtocolObject<dyn SCStreamOutput> = ProtocolObject::from_ref(&*output);
            // SAFETY: the worker relinquished this exact stream while startup
            // was pending; only this late-completion path now owns teardown.
            let _ = unsafe {
                stopped_stream.removeStreamOutput_type_error(output, SCStreamOutputType::Screen)
            };
        });
    });
    // Do not block ScreenCaptureKit's completion queue waiting on itself.
    // The copied stop block retains the stream, output and queue until stopped.
    unsafe {
        stream.stopCaptureWithCompletionHandler(Some(&*stopped));
    }
}

/// ARC-backed ScreenCaptureKit objects are created on its discovery callback
/// and transferred exactly once to the dedicated owner thread. No stream method
/// is called before that transfer. If the owner abandons a pending start, the
/// completion callback retains the resources and takes exclusive teardown
/// ownership. Output callbacks touch only the synchronized `FrameSlot`.
struct OwnedRuntime(StreamRuntime);

// SAFETY: see `OwnedRuntime`'s ownership invariant above. This is the only
// cross-thread transfer of the otherwise-conservatively-!Send objc2 handles.
unsafe impl Send for OwnedRuntime {}

/// Safe handle to one retained ScreenCaptureKit producer.
pub(crate) struct CaptureStream {
    slot: Arc<FrameSlot>,
    stop: mpsc::Sender<()>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl CaptureStream {
    pub(crate) fn start_display(
        display_id: u32,
        max_size: (u32, u32),
    ) -> Result<Self, MacFfiError> {
        Self::start(CaptureSource::Display { display_id }, max_size)
    }

    pub(crate) fn start_window(
        window_id: u32,
        expected_process_id: u32,
        max_size: (u32, u32),
    ) -> Result<Self, MacFfiError> {
        Self::start(
            CaptureSource::Window {
                window_id,
                expected_process_id,
            },
            max_size,
        )
    }

    fn start(source: CaptureSource, max_size: (u32, u32)) -> Result<Self, MacFfiError> {
        let slot = Arc::new(FrameSlot::default());
        let worker_slot = Arc::clone(&slot);
        let (ready_tx, ready_rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("opengeni-sck-stream".to_string())
            .spawn(move || {
                crate::with_autorelease_pool(|| {
                    run_stream(source, max_size, &worker_slot, &ready_tx, &stop_rx);
                });
            })
            .map_err(|error| MacFfiError::Ffi(format!("start capture worker: {error}")))?;

        match ready_rx.recv_timeout(DISCOVERY_TIMEOUT) {
            Ok(Ok(())) => Ok(Self {
                slot,
                stop: stop_tx,
                worker: Mutex::new(Some(worker)),
            }),
            Ok(Err(error)) => {
                let _ = stop_tx.send(());
                let _ = worker.join();
                Err(classify_start_error(error))
            }
            Err(_) => {
                let _ = stop_tx.send(());
                let _ = worker.join();
                Err(MacFfiError::TimedOut(
                    "ScreenCaptureKit stream startup timed out".to_string(),
                ))
            }
        }
    }

    pub(crate) fn next_frame(&self) -> Result<RgbaFrame, MacFfiError> {
        let state = self
            .slot
            .state
            .lock()
            .map_err(|_| MacFfiError::Ffi("capture frame lock is poisoned".to_string()))?;
        let (state, timeout) = self
            .slot
            .changed
            .wait_timeout_while(state, FRAME_TIMEOUT, |state| {
                state.frame.is_none() && state.failure.is_none() && !state.stopped
            })
            .map_err(|_| MacFfiError::Ffi("capture frame lock is poisoned".to_string()))?;
        if let Some(error) = &state.failure {
            return Err(MacFfiError::Ffi(error.clone()));
        }
        if state.stopped {
            return Err(MacFfiError::Ffi(
                "ScreenCaptureKit stream stopped".to_string(),
            ));
        }
        let frame = state.frame.clone().ok_or_else(|| {
            if timeout.timed_out() {
                MacFfiError::TimedOut("ScreenCaptureKit produced no initial live frame".to_string())
            } else {
                MacFfiError::Ffi("ScreenCaptureKit published no frame".to_string())
            }
        })?;
        // ScreenCaptureKit updates this latest-only slot asynchronously. Once
        // the initial frame exists, consumers must never wait for a changed
        // frame: a static window is healthy and the caller owns its own cadence.
        Ok(frame)
    }

    pub(crate) fn stop(&self) {
        let _ = self.stop.send(());
        let worker = self.worker.lock().ok().and_then(|mut worker| worker.take());
        if let Some(worker) = worker {
            let _ = worker.join();
        }
    }
}

impl Drop for CaptureStream {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run_stream(
    source: CaptureSource,
    max_size: (u32, u32),
    slot: &Arc<FrameSlot>,
    ready: &mpsc::Sender<Result<(), String>>,
    stop: &mpsc::Receiver<()>,
) {
    let mut runtime = match discover_runtime(source, max_size, Arc::clone(slot)) {
        Ok(runtime) => runtime.0,
        Err(error) => {
            let _ = ready.send(Err(error));
            slot.stop();
            return;
        }
    };

    let (started_tx, started_rx) = mpsc::channel();
    let start_completion = Arc::clone(&runtime.start_completion);
    let late_stream = runtime.stream.clone();
    let late_output = runtime.output.clone();
    let late_queue = runtime.queue.clone();
    let started = block2::RcBlock::new(move |error: *mut NSError| {
        if start_completion.complete() {
            crate::with_autorelease_pool(|| {
                stop_abandoned_start(&late_stream, late_output.clone(), late_queue.clone());
            });
        }
        let _ = started_tx.send(error_message(error));
    });
    // SAFETY: runtime owns the stream for this thread and the copied block stays
    // alive until ScreenCaptureKit invokes it.
    runtime.start_requested = true;
    unsafe {
        runtime
            .stream
            .startCaptureWithCompletionHandler(Some(&*started));
    }
    match started_rx.recv_timeout(DISCOVERY_TIMEOUT) {
        Ok(None) => {
            let _ = ready.send(Ok(()));
        }
        Ok(Some(error)) => {
            let _ = ready.send(Err(format!("start ScreenCaptureKit stream: {error}")));
            slot.stop();
            return;
        }
        Err(_) => {
            let _ = ready.send(Err("start ScreenCaptureKit stream timed out".to_string()));
            slot.stop();
            return;
        }
    }

    let _ = stop.recv();
    drop(runtime);
    slot.stop();
}

fn discover_runtime(
    source: CaptureSource,
    max_size: (u32, u32),
    slot: Arc<FrameSlot>,
) -> Result<OwnedRuntime, String> {
    let (tx, rx) = mpsc::channel();
    let callback = block2::RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            if content.is_null() {
                let message = error_message(error).unwrap_or_else(|| {
                    "ScreenCaptureKit returned no shareable content".to_string()
                });
                let _ = tx.send(Err(message));
                return;
            }
            // SAFETY: SCK owns `content` for the callback duration; construction
            // retains every native object needed after this callback returns.
            let content = unsafe { &*content };
            let result = build_runtime(content, source, max_size, Arc::clone(&slot));
            let _ = tx.send(result.map(OwnedRuntime));
        },
    );
    // SAFETY: callback signature matches SCK and RcBlock is copied by the API.
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
            true,
            false,
            &callback,
        );
    }
    rx.recv_timeout(DISCOVERY_TIMEOUT)
        .map_err(|_| "ScreenCaptureKit content discovery timed out".to_string())?
}

fn build_runtime(
    content: &SCShareableContent,
    source: CaptureSource,
    max_size: (u32, u32),
    slot: Arc<FrameSlot>,
) -> Result<StreamRuntime, String> {
    let (filter, width, height, shows_cursor) = match source {
        CaptureSource::Display { display_id } => {
            // SAFETY: returned array and elements are retained for this scope.
            let displays = unsafe { content.displays() };
            let display = displays
                .iter()
                .find(|display| unsafe { display.displayID() } == display_id)
                .ok_or_else(|| "display not found".to_string())?;
            let excluded = NSArray::<SCWindow>::new();
            // SAFETY: filter retains the display/exclusion configuration.
            let filter = unsafe {
                SCContentFilter::initWithDisplay_excludingWindows(
                    SCContentFilter::alloc(),
                    &display,
                    &excluded,
                )
            };
            let native = display_pixel_dims(display_id).unwrap_or_else(|| {
                // SAFETY: these are immutable SCDisplay geometry properties.
                (
                    unsafe { display.width() }.max(1) as u32,
                    unsafe { display.height() }.max(1) as u32,
                )
            });
            let size = fit_capture_size(native.0, native.1, Some(max_size));
            (filter, size.0, size.1, true)
        }
        CaptureSource::Window {
            window_id,
            expected_process_id,
        } => {
            // SAFETY: returned array and elements are retained for this scope.
            let windows = unsafe { content.windows() };
            let window = windows
                .iter()
                .find(|window| unsafe { window.windowID() } == window_id)
                .ok_or_else(|| "window not found".to_string())?;
            let process_matches = unsafe { window.owningApplication() }
                .and_then(|application| u32::try_from(unsafe { application.processID() }).ok())
                .is_some_and(|process_id| process_id == expected_process_id);
            if !process_matches {
                return Err("window not found".to_string());
            }
            // SAFETY: immutable SCWindow geometry.
            let rect = unsafe { window.frame() };
            if !rect.size.width.is_finite()
                || !rect.size.height.is_finite()
                || rect.size.width <= 0.0
                || rect.size.height <= 0.0
            {
                return Err("window has invalid capture geometry".to_string());
            }
            let bounds = MacRect {
                x: rect.origin.x,
                y: rect.origin.y,
                width: rect.size.width,
                height: rect.size.height,
            };
            let scale = window_backing_scale(content, bounds);
            let native = (
                (bounds.width * scale.0).ceil().max(1.0) as u32,
                (bounds.height * scale.1).ceil().max(1.0) as u32,
            );
            let size = fit_capture_size(native.0, native.1, Some(max_size));
            // SAFETY: filter retains the selected desktop-independent window.
            let filter = unsafe {
                SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window)
            };
            (filter, size.0, size.1, false)
        }
    };

    if usize::try_from(width)
        .ok()
        .and_then(|width| {
            usize::try_from(height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .is_none_or(|pixels| pixels == 0 || pixels > MAX_CAPTURE_PIXELS)
    {
        return Err("live capture exceeds the 64 megapixel envelope".to_string());
    }

    // SAFETY: fresh configuration object; all values are bounded above.
    let configuration = unsafe { SCStreamConfiguration::new() };
    unsafe {
        configuration.setWidth(width as usize);
        configuration.setHeight(height as usize);
        configuration.setPixelFormat(kCVPixelFormatType_32BGRA);
        configuration.setMinimumFrameInterval(CMTime::new(1, LIVE_FRAMES_PER_SECOND));
        // Keep enough IOSurfaces for ScreenCaptureKit to publish a changed
        // window while the previous frame is copied on our serial callback
        // queue. A depth of one can permanently pin desktop-independent
        // window streams to their first surface on macOS.
        configuration.setQueueDepth(3);
        configuration.setScalesToFit(false);
        configuration.setPreservesAspectRatio(true);
        configuration.setShowsCursor(shows_cursor);
    }
    let output = CaptureOutput::new(slot);
    let delegate: &ProtocolObject<dyn SCStreamDelegate> = ProtocolObject::from_ref(&*output);
    // SAFETY: filter/config/delegate are live and SCK retains what the stream needs.
    let stream = unsafe {
        SCStream::initWithFilter_configuration_delegate(
            SCStream::alloc(),
            &filter,
            &configuration,
            Some(delegate),
        )
    };
    let queue = DispatchQueue::new("ai.opengeni.computer.capture", None);
    let stream_output: &ProtocolObject<dyn SCStreamOutput> = ProtocolObject::from_ref(&*output);
    // SAFETY: queue is retained in StreamRuntime and the output is synchronized.
    unsafe {
        stream
            .addStreamOutput_type_sampleHandlerQueue_error(
                stream_output,
                SCStreamOutputType::Screen,
                Some(&queue),
            )
            .map_err(|error| format!("attach ScreenCaptureKit output: {error}"))?;
    }
    Ok(StreamRuntime {
        stream,
        output,
        queue,
        start_requested: false,
        start_completion: Arc::default(),
    })
}

fn sample_to_rgba(sample: &CMSampleBuffer) -> Result<Option<RgbaFrame>, String> {
    // SAFETY: the sample buffer owns its image buffer for the callback duration;
    // objc2 returns a retained CoreVideo handle. ScreenCaptureKit also emits
    // ordinary idle/status samples with no image buffer; those are not stream
    // failures and must not poison the latest-frame slot.
    let Some(buffer) = (unsafe { sample.image_buffer() }) else {
        return Ok(None);
    };
    if CVPixelBufferGetPixelFormatType(&buffer) != kCVPixelFormatType_32BGRA {
        return Err("ScreenCaptureKit returned a non-BGRA pixel buffer".to_string());
    }
    let flags = CVPixelBufferLockFlags::ReadOnly;
    // SAFETY: `buffer` is a valid retained CVPixelBuffer and flags request
    // read-only CPU access; the matching unlock is guaranteed by the guard.
    if unsafe { CVPixelBufferLockBaseAddress(&buffer, flags) } != kCVReturnSuccess {
        return Err("could not lock ScreenCaptureKit pixel buffer".to_string());
    }
    let _unlock = PixelBufferUnlock(&buffer, flags);
    let width = CVPixelBufferGetWidth(&buffer);
    let height = CVPixelBufferGetHeight(&buffer);
    let row_bytes = CVPixelBufferGetBytesPerRow(&buffer);
    let pixels = width
        .checked_mul(height)
        .ok_or_else(|| "live frame dimensions overflow".to_string())?;
    if pixels == 0 || pixels > MAX_CAPTURE_PIXELS || row_bytes < width.saturating_mul(4) {
        return Err("live frame dimensions are invalid".to_string());
    }
    let byte_count = row_bytes
        .checked_mul(height)
        .ok_or_else(|| "live frame byte length overflows".to_string())?;
    let base = CVPixelBufferGetBaseAddress(&buffer).cast::<u8>();
    if base.is_null() {
        return Err("ScreenCaptureKit pixel buffer has no base address".to_string());
    }
    // SAFETY: the pixel buffer is locked for read access; byte_count is derived
    // from its reported stride and height and remains borrowed only until unlock.
    let native = unsafe { std::slice::from_raw_parts(base, byte_count) };
    let tight_row = width * 4;
    let mut rgba = Vec::with_capacity(tight_row * height);
    for row in 0..height {
        let start = row * row_bytes;
        let output_start = rgba.len();
        rgba.extend_from_slice(&native[start..start + tight_row]);
        for pixel in rgba[output_start..].chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }
    }
    Ok(Some(RgbaFrame {
        width: u32::try_from(width).map_err(|_| "live frame width is too large".to_string())?,
        height: u32::try_from(height).map_err(|_| "live frame height is too large".to_string())?,
        rgba,
    }))
}

fn error_message(error: *mut NSError) -> Option<String> {
    if error.is_null() {
        None
    } else {
        // SAFETY: NSError is borrowed only for the callback duration.
        Some(format!("{}", unsafe { &*error }))
    }
}

fn classify_start_error(error: String) -> MacFfiError {
    if error == "display not found" || error == "window not found" {
        MacFfiError::TargetStale(error)
    } else {
        MacFfiError::Ffi(error)
    }
}

#[cfg(test)]
mod tests {
    use super::StartCompletion;
    use std::sync::{Arc, Barrier};

    #[test]
    fn completed_start_is_stopped_by_its_owner() {
        let completion = StartCompletion::default();
        assert!(
            !completion.complete(),
            "a live owner still needs the stream"
        );
        assert!(
            completion.abandon(),
            "owner must stop before detaching output"
        );
    }

    #[test]
    fn timed_out_start_is_stopped_only_after_late_completion() {
        let completion = StartCompletion::default();
        assert!(
            !completion.abandon(),
            "cannot cancel a pending OS start with stop"
        );
        // Both success and error callbacks finish the outstanding OS operation;
        // only then can the abandoned stream be stopped and its output detached.
        assert!(
            completion.complete(),
            "late callback must own final cleanup"
        );
    }

    #[test]
    fn start_completion_racing_timeout_has_exactly_one_cleanup_owner() {
        for _ in 0..100 {
            let completion = Arc::new(StartCompletion::default());
            let gate = Arc::new(Barrier::new(2));
            let callback_completion = Arc::clone(&completion);
            let callback_gate = Arc::clone(&gate);
            let callback = std::thread::spawn(move || {
                callback_gate.wait();
                callback_completion.complete()
            });
            gate.wait();
            let owner_stops = completion.abandon();
            let callback_stops = callback.join().expect("start callback");
            assert_ne!(owner_stops, callback_stops);
        }
    }
}
