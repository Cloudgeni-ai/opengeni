//! The complete PipeWire `unsafe` surface.
//!
//! libpipewire is resolved once with `dlopen` and never closed, so every
//! resolved function pointer stays valid for the process lifetime. One
//! [`Stream`] owns a private PipeWire thread loop; its callbacks run on that
//! loop with the loop lock held, and readers take the same lock before touching
//! a buffer the stream may recycle.

use std::ffi::{c_char, c_int, c_void, CStr};
use std::ptr;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Instant;

use crate::pod::{self, VideoFormat};
use crate::{FrameWait, PipeWireError, VideoFrame};

const LIBRARY: &CStr = c"libpipewire-0.3.so.0";
const STREAM_NAME: &CStr = c"opengeni-screen-cast";
const STREAM_PROPERTIES: &CStr = c"media.type=Video media.category=Capture media.role=Screen";

const SPA_DIRECTION_INPUT: c_int = 0;
const PW_STREAM_FLAG_AUTOCONNECT: c_int = 1 << 0;
const PW_STREAM_FLAG_MAP_BUFFERS: c_int = 1 << 2;
const PW_STREAM_FLAG_DONT_RECONNECT: c_int = 1 << 7;
const PW_STREAM_STATE_ERROR: c_int = -1;
const PW_STREAM_STATE_UNCONNECTED: c_int = 0;
const SPA_CHUNK_FLAG_CORRUPTED: i32 = 1;

#[repr(C)]
struct SpaHook {
    link_next: *mut c_void,
    link_prev: *mut c_void,
    callbacks_funcs: *const c_void,
    callbacks_data: *mut c_void,
    removed: *mut c_void,
    private: *mut c_void,
}

/// Only the leading field of `struct pw_buffer` is read.
#[repr(C)]
struct PwBuffer {
    buffer: *mut SpaBuffer,
}

#[repr(C)]
struct SpaBuffer {
    n_metas: u32,
    n_datas: u32,
    metas: *mut c_void,
    datas: *mut SpaData,
}

#[repr(C)]
struct SpaData {
    kind: u32,
    flags: u32,
    fd: i64,
    mapoffset: u32,
    maxsize: u32,
    data: *mut c_void,
    chunk: *mut SpaChunk,
}

#[repr(C)]
struct SpaChunk {
    offset: u32,
    size: u32,
    stride: i32,
    flags: i32,
}

/// `struct pw_stream_events`, version 0 (through `drained`).
#[repr(C)]
struct StreamEvents {
    version: u32,
    destroy: Option<unsafe extern "C" fn(*mut c_void)>,
    state_changed: Option<unsafe extern "C" fn(*mut c_void, c_int, c_int, *const c_char)>,
    control_info: Option<unsafe extern "C" fn(*mut c_void, u32, *const c_void)>,
    io_changed: Option<unsafe extern "C" fn(*mut c_void, u32, *mut c_void, u32)>,
    param_changed: Option<unsafe extern "C" fn(*mut c_void, u32, *const c_void)>,
    add_buffer: Option<unsafe extern "C" fn(*mut c_void, *mut PwBuffer)>,
    remove_buffer: Option<unsafe extern "C" fn(*mut c_void, *mut PwBuffer)>,
    process: Option<unsafe extern "C" fn(*mut c_void)>,
    drained: Option<unsafe extern "C" fn(*mut c_void)>,
}

static EVENTS: StreamEvents = StreamEvents {
    version: 0,
    destroy: None,
    state_changed: Some(on_state_changed),
    control_info: None,
    io_changed: None,
    param_changed: Some(on_param_changed),
    add_buffer: None,
    remove_buffer: Some(on_remove_buffer),
    process: Some(on_process),
    drained: None,
};

type Opaque = *mut c_void;

struct Api {
    init: unsafe extern "C" fn(*mut c_int, *mut *mut *mut c_char),
    thread_loop_new: unsafe extern "C" fn(*const c_char, *const c_void) -> Opaque,
    thread_loop_destroy: unsafe extern "C" fn(Opaque),
    thread_loop_start: unsafe extern "C" fn(Opaque) -> c_int,
    thread_loop_stop: unsafe extern "C" fn(Opaque),
    thread_loop_lock: unsafe extern "C" fn(Opaque),
    thread_loop_unlock: unsafe extern "C" fn(Opaque),
    thread_loop_get_loop: unsafe extern "C" fn(Opaque) -> Opaque,
    context_new: unsafe extern "C" fn(Opaque, Opaque, usize) -> Opaque,
    context_destroy: unsafe extern "C" fn(Opaque),
    context_connect: unsafe extern "C" fn(Opaque, Opaque, usize) -> Opaque,
    core_disconnect: unsafe extern "C" fn(Opaque) -> c_int,
    properties_new_string: unsafe extern "C" fn(*const c_char) -> Opaque,
    stream_new: unsafe extern "C" fn(Opaque, *const c_char, Opaque) -> Opaque,
    stream_destroy: unsafe extern "C" fn(Opaque),
    stream_add_listener: unsafe extern "C" fn(Opaque, *mut SpaHook, *const StreamEvents, Opaque),
    stream_connect:
        unsafe extern "C" fn(Opaque, c_int, u32, c_int, *mut *const c_void, u32) -> c_int,
    stream_dequeue_buffer: unsafe extern "C" fn(Opaque) -> *mut PwBuffer,
    stream_queue_buffer: unsafe extern "C" fn(Opaque, *mut PwBuffer) -> c_int,
}

static API: OnceLock<Result<Api, String>> = OnceLock::new();

fn api() -> Result<&'static Api, PipeWireError> {
    API.get_or_init(load)
        .as_ref()
        .map_err(|error| PipeWireError::Unavailable(error.clone()))
}

fn dl_error() -> String {
    // SAFETY: dlerror returns null or a NUL-terminated thread-local string that
    // is copied before any other dl call on this thread.
    let message = unsafe { libc::dlerror() };
    if message.is_null() {
        "unknown dynamic loader error".to_string()
    } else {
        // SAFETY: non-null dlerror results are valid C strings.
        unsafe { CStr::from_ptr(message) }
            .to_string_lossy()
            .into_owned()
    }
}

/// # Safety
///
/// `T` must be the exact `extern "C"` function pointer type of `name`.
unsafe fn symbol<T: Copy>(handle: *mut c_void, name: &CStr) -> Result<T, String> {
    debug_assert_eq!(std::mem::size_of::<T>(), std::mem::size_of::<*mut c_void>());
    // SAFETY: the handle came from a successful dlopen and name is NUL-terminated.
    let address = unsafe { libc::dlsym(handle, name.as_ptr()) };
    if address.is_null() {
        return Err(format!("libpipewire-0.3 lacks {}", name.to_string_lossy()));
    }
    // SAFETY: the caller names the matching function type; pointer sizes match.
    Ok(unsafe { std::mem::transmute_copy::<*mut c_void, T>(&address) })
}

fn load() -> Result<Api, String> {
    // SAFETY: constant NUL-terminated soname. The handle is intentionally never
    // closed, so every resolved symbol remains valid for the process lifetime.
    let handle = unsafe { libc::dlopen(LIBRARY.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
    if handle.is_null() {
        return Err(format!("cannot load libpipewire-0.3.so.0: {}", dl_error()));
    }
    // SAFETY: each field type mirrors the libpipewire 0.3 / 1.x C prototype.
    let api = unsafe {
        Api {
            init: symbol(handle, c"pw_init")?,
            thread_loop_new: symbol(handle, c"pw_thread_loop_new")?,
            thread_loop_destroy: symbol(handle, c"pw_thread_loop_destroy")?,
            thread_loop_start: symbol(handle, c"pw_thread_loop_start")?,
            thread_loop_stop: symbol(handle, c"pw_thread_loop_stop")?,
            thread_loop_lock: symbol(handle, c"pw_thread_loop_lock")?,
            thread_loop_unlock: symbol(handle, c"pw_thread_loop_unlock")?,
            thread_loop_get_loop: symbol(handle, c"pw_thread_loop_get_loop")?,
            context_new: symbol(handle, c"pw_context_new")?,
            context_destroy: symbol(handle, c"pw_context_destroy")?,
            context_connect: symbol(handle, c"pw_context_connect")?,
            core_disconnect: symbol(handle, c"pw_core_disconnect")?,
            properties_new_string: symbol(handle, c"pw_properties_new_string")?,
            stream_new: symbol(handle, c"pw_stream_new")?,
            stream_destroy: symbol(handle, c"pw_stream_destroy")?,
            stream_add_listener: symbol(handle, c"pw_stream_add_listener")?,
            stream_connect: symbol(handle, c"pw_stream_connect")?,
            stream_dequeue_buffer: symbol(handle, c"pw_stream_dequeue_buffer")?,
            stream_queue_buffer: symbol(handle, c"pw_stream_queue_buffer")?,
        }
    };
    // SAFETY: pw_init accepts null argc/argv and is idempotent.
    unsafe { (api.init)(ptr::null_mut(), ptr::null_mut()) };
    Ok(api)
}

#[derive(Clone, Copy)]
struct BufferPtr(*mut PwBuffer);

// SAFETY: the pointer is only dereferenced on the PipeWire loop or while the
// loop lock is held, which serialises it with every buffer recycle.
unsafe impl Send for BufferPtr {}

struct State {
    held: BufferPtr,
    format: Option<VideoFormat>,
    sequence: u64,
    failure: Option<String>,
}

struct Shared {
    api: &'static Api,
    stream: AtomicPtr<c_void>,
    state: Mutex<State>,
    changed: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn fail(&self, message: String) {
        let mut state = self.lock();
        if state.failure.is_none() {
            state.failure = Some(message);
        }
        drop(state);
        self.changed.notify_all();
    }
}

unsafe extern "C" fn on_state_changed(
    data: *mut c_void,
    old: c_int,
    state: c_int,
    error: *const c_char,
) {
    // SAFETY: data is the Shared registered with this listener; it outlives the stream.
    let shared = unsafe { &*data.cast::<Shared>() };
    if state == PW_STREAM_STATE_ERROR {
        let message = if error.is_null() {
            "stream error".to_string()
        } else {
            // SAFETY: PipeWire passes a valid C string for the error.
            unsafe { CStr::from_ptr(error) }
                .to_string_lossy()
                .into_owned()
        };
        shared.fail(message);
    } else if state == PW_STREAM_STATE_UNCONNECTED && old != PW_STREAM_STATE_UNCONNECTED {
        shared.fail("the compositor ended the screen cast".to_string());
    }
}

unsafe extern "C" fn on_param_changed(data: *mut c_void, id: u32, param: *const c_void) {
    if id != pod::SPA_PARAM_FORMAT {
        return;
    }
    // SAFETY: see on_state_changed.
    let shared = unsafe { &*data.cast::<Shared>() };
    let format = if param.is_null() {
        None
    } else {
        // SAFETY: a spa_pod starts with its u32 body size; the pod is valid for
        // header + body bytes for the duration of this callback.
        let size = unsafe { ptr::read_unaligned(param.cast::<u32>()) };
        let length = usize::try_from(size).unwrap_or(0).saturating_add(8);
        // SAFETY: as above.
        let bytes = unsafe { std::slice::from_raw_parts(param.cast::<u8>(), length) };
        pod::parse_video_format(bytes)
    };
    let mut state = shared.lock();
    state.format = format;
    if format.is_none() && !param.is_null() {
        state.failure = Some("the compositor negotiated an unsupported pixel format".to_string());
    }
    drop(state);
    shared.changed.notify_all();
}

unsafe extern "C" fn on_remove_buffer(data: *mut c_void, buffer: *mut PwBuffer) {
    // SAFETY: see on_state_changed.
    let shared = unsafe { &*data.cast::<Shared>() };
    let mut state = shared.lock();
    if state.held.0 == buffer {
        state.held = BufferPtr(ptr::null_mut());
    }
}

/// Whether a dequeued buffer carries a readable, uncorrupted frame.
///
/// # Safety
///
/// `buffer` must be a live buffer dequeued from the stream.
unsafe fn has_frame(buffer: *mut PwBuffer) -> bool {
    // SAFETY: the caller guarantees a live buffer; every pointer is null-checked.
    unsafe {
        let spa = (*buffer).buffer;
        if spa.is_null() || (*spa).n_datas == 0 || (*spa).datas.is_null() {
            return false;
        }
        let data = &*(*spa).datas;
        if data.data.is_null() || data.chunk.is_null() {
            return false;
        }
        let chunk = &*data.chunk;
        chunk.size > 0 && chunk.flags & SPA_CHUNK_FLAG_CORRUPTED == 0
    }
}

unsafe extern "C" fn on_process(data: *mut c_void) {
    // SAFETY: see on_state_changed.
    let shared = unsafe { &*data.cast::<Shared>() };
    let api = shared.api;
    let stream = shared.stream.load(Ordering::Acquire);
    if stream.is_null() {
        return;
    }
    // Keep only the newest frame; hand every older one straight back.
    let mut newest: *mut PwBuffer = ptr::null_mut();
    loop {
        // SAFETY: called on the stream's own loop thread.
        let buffer = unsafe { (api.stream_dequeue_buffer)(stream) };
        if buffer.is_null() {
            break;
        }
        if !newest.is_null() {
            // SAFETY: newest was dequeued from this stream and is not held.
            unsafe { (api.stream_queue_buffer)(stream, newest) };
        }
        newest = buffer;
    }
    if newest.is_null() {
        return;
    }
    // SAFETY: newest is a live dequeued buffer.
    if !unsafe { has_frame(newest) } {
        // SAFETY: as above.
        unsafe { (api.stream_queue_buffer)(stream, newest) };
        return;
    }
    let previous = {
        let mut state = shared.lock();
        state.sequence += 1;
        std::mem::replace(&mut state.held, BufferPtr(newest))
    };
    if !previous.0.is_null() {
        // SAFETY: the previously held buffer is still owned by this consumer.
        unsafe { (api.stream_queue_buffer)(stream, previous.0) };
    }
    shared.changed.notify_all();
}

struct LoopLock {
    api: &'static Api,
    thread_loop: Opaque,
}

impl LoopLock {
    fn new(api: &'static Api, thread_loop: Opaque) -> Self {
        // SAFETY: thread_loop is a live thread loop owned by the caller's Stream.
        unsafe { (api.thread_loop_lock)(thread_loop) };
        Self { api, thread_loop }
    }
}

impl Drop for LoopLock {
    fn drop(&mut self) {
        // SAFETY: paired with the lock taken in new on the same thread.
        unsafe { (self.api.thread_loop_unlock)(self.thread_loop) };
    }
}

pub(crate) struct Stream {
    api: &'static Api,
    thread_loop: Opaque,
    context: Opaque,
    core: Opaque,
    video: Opaque,
    shared: Box<Shared>,
    hook: Box<SpaHook>,
}

// SAFETY: every PipeWire object is touched only under the thread-loop lock or
// after the loop is stopped in Drop; Shared is internally synchronised.
unsafe impl Send for Stream {}
// SAFETY: as above.
unsafe impl Sync for Stream {}

impl Stream {
    pub(crate) fn connect(node_id: u32, max_fps: u32) -> Result<Self, PipeWireError> {
        let api = api()?;
        // SAFETY: valid name, null properties.
        let thread_loop = unsafe { (api.thread_loop_new)(STREAM_NAME.as_ptr(), ptr::null()) };
        if thread_loop.is_null() {
            return Err(PipeWireError::Unavailable(
                "cannot create a PipeWire thread loop".to_string(),
            ));
        }
        let mut this = Self::unconnected(api, thread_loop);
        // SAFETY: thread_loop is live; null properties are allowed.
        this.context = unsafe {
            (api.context_new)((api.thread_loop_get_loop)(thread_loop), ptr::null_mut(), 0)
        };
        if this.context.is_null() {
            return Err(PipeWireError::Unavailable(
                "cannot create a PipeWire context".to_string(),
            ));
        }
        // SAFETY: live thread loop.
        if unsafe { (api.thread_loop_start)(thread_loop) } < 0 {
            return Err(PipeWireError::Unavailable(
                "cannot start the PipeWire thread loop".to_string(),
            ));
        }
        let guard = LoopLock::new(api, thread_loop);
        // SAFETY: live context, under the loop lock.
        this.core = unsafe { (api.context_connect)(this.context, ptr::null_mut(), 0) };
        if this.core.is_null() {
            return Err(PipeWireError::Unavailable(
                "cannot connect to the session PipeWire daemon".to_string(),
            ));
        }
        // The node is chosen by `target_id` in pw_stream_connect; Mutter's ids
        // are global ids, which `target.object` would misread as serials.
        // SAFETY: valid C string; the stream takes ownership of the properties.
        this.video = unsafe {
            (api.stream_new)(
                this.core,
                STREAM_NAME.as_ptr(),
                (api.properties_new_string)(STREAM_PROPERTIES.as_ptr()),
            )
        };
        if this.video.is_null() {
            return Err(PipeWireError::Failed(
                "cannot create a PipeWire video stream".to_string(),
            ));
        }
        this.shared.stream.store(this.video, Ordering::Release);
        let shared: *const Shared = ptr::addr_of!(*this.shared);
        // SAFETY: hook and shared are boxed and outlive the stream (destroyed first in Drop).
        unsafe {
            (api.stream_add_listener)(
                this.video,
                ptr::addr_of_mut!(*this.hook),
                ptr::addr_of!(EVENTS),
                shared.cast_mut().cast(),
            );
        }
        let format = pod::enum_format(max_fps);
        let mut params = [format.as_ptr().cast::<c_void>()];
        // SAFETY: the format pod is a valid, 8-byte aligned spa_pod that PipeWire
        // copies before returning.
        let result = unsafe {
            (api.stream_connect)(
                this.video,
                SPA_DIRECTION_INPUT,
                node_id,
                PW_STREAM_FLAG_AUTOCONNECT
                    | PW_STREAM_FLAG_MAP_BUFFERS
                    | PW_STREAM_FLAG_DONT_RECONNECT,
                params.as_mut_ptr(),
                1,
            )
        };
        drop(guard);
        if result < 0 {
            return Err(PipeWireError::Failed(format!(
                "cannot connect to screen-cast node {node_id}: {}",
                std::io::Error::from_raw_os_error(-result)
            )));
        }
        Ok(this)
    }

    fn unconnected(api: &'static Api, thread_loop: Opaque) -> Self {
        Self {
            api,
            thread_loop,
            context: ptr::null_mut(),
            core: ptr::null_mut(),
            video: ptr::null_mut(),
            shared: Box::new(Shared {
                api,
                stream: AtomicPtr::new(ptr::null_mut()),
                state: Mutex::new(State {
                    held: BufferPtr(ptr::null_mut()),
                    format: None,
                    sequence: 0,
                    failure: None,
                }),
                changed: Condvar::new(),
            }),
            hook: Box::new(SpaHook {
                link_next: ptr::null_mut(),
                link_prev: ptr::null_mut(),
                callbacks_funcs: ptr::null(),
                callbacks_data: ptr::null_mut(),
                removed: ptr::null_mut(),
                private: ptr::null_mut(),
            }),
        }
    }

    pub(crate) fn latest_sequence(&self) -> u64 {
        self.shared.lock().sequence
    }

    pub(crate) fn failure(&self) -> Option<String> {
        self.shared.lock().failure.clone()
    }

    pub(crate) fn frame(
        &self,
        min_sequence: u64,
        wait: FrameWait,
    ) -> Result<VideoFrame, PipeWireError> {
        let started = Instant::now();
        let first_deadline = started + wait.first;
        let settle_deadline = started + wait.first.max(wait.settle);
        let wanted = min_sequence.max(1);
        let mut state = self.shared.lock();
        let mut reached = false;
        loop {
            if let Some(failure) = &state.failure {
                return Err(PipeWireError::Failed(failure.clone()));
            }
            let now = Instant::now();
            let until = if state.sequence >= wanted {
                // Keep following an animation until it pauses for `quiet`.
                reached = true;
                (now + wait.quiet).min(settle_deadline)
            } else {
                if now >= first_deadline {
                    if state.sequence == 0 {
                        return Err(PipeWireError::Timeout(wait.first));
                    }
                    break;
                }
                first_deadline
            };
            if reached && now >= until {
                break;
            }
            let before = state.sequence;
            state = self
                .shared
                .changed
                .wait_timeout(state, until.saturating_duration_since(now))
                .unwrap_or_else(PoisonError::into_inner)
                .0;
            if reached && state.sequence == before && state.failure.is_none() {
                break;
            }
        }
        drop(state);
        // The loop lock stops the stream recycling the held buffer while it is read.
        let _guard = LoopLock::new(self.api, self.thread_loop);
        let state = self.shared.lock();
        let format = state.format.ok_or_else(|| {
            PipeWireError::Failed("the screen-cast format is not negotiated".to_string())
        })?;
        let held = state.held.0;
        if held.is_null() {
            return Err(PipeWireError::Failed(
                "the screen-cast frame was released by the compositor".to_string(),
            ));
        }
        // SAFETY: held is a live dequeued buffer, pinned by the loop lock; all
        // pointers are null-checked and the slice stays inside maxsize.
        let rgba = unsafe {
            let spa = &*(*held).buffer;
            let data = &*spa.datas;
            let chunk = &*data.chunk;
            let maxsize = usize::try_from(data.maxsize).unwrap_or(0);
            let offset = usize::try_from(chunk.offset).unwrap_or(0) % maxsize.max(1);
            let stride = usize::try_from(chunk.stride).unwrap_or(0);
            let bytes =
                std::slice::from_raw_parts(data.data.cast::<u8>().add(offset), maxsize - offset);
            crate::to_rgba(bytes, stride, format)?
        };
        Ok(VideoFrame {
            rgba,
            width: format.width,
            height: format.height,
            sequence: state.sequence,
        })
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        // SAFETY: stopping the loop joins its thread, so no callback runs while
        // the objects below are destroyed in reverse creation order.
        unsafe {
            (self.api.thread_loop_stop)(self.thread_loop);
            if !self.video.is_null() {
                self.shared.stream.store(ptr::null_mut(), Ordering::Release);
                let held =
                    std::mem::replace(&mut self.shared.lock().held, BufferPtr(ptr::null_mut()));
                if !held.0.is_null() {
                    (self.api.stream_queue_buffer)(self.video, held.0);
                }
                (self.api.stream_destroy)(self.video);
            }
            if !self.core.is_null() {
                (self.api.core_disconnect)(self.core);
            }
            if !self.context.is_null() {
                (self.api.context_destroy)(self.context);
            }
            (self.api.thread_loop_destroy)(self.thread_loop);
        }
    }
}
