//! Linux: record the monitor of the default output through PulseAudio's
//! simple API, which PipeWire also serves (pipewire-pulse). The library is
//! loaded at runtime, so the helper builds without audio headers and reports a
//! clear error on a system without a sound server.

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;

use libloading::{Library, Symbol};

use crate::output::Sink;
use crate::{Capture, CaptureError, Options};

const SAMPLE_RATE: u32 = 48_000;
const PA_STREAM_RECORD: c_int = 2;
const PA_SAMPLE_FLOAT32LE: c_int = 5;

#[repr(C)]
struct SampleSpec {
    format: c_int,
    rate: u32,
    channels: u8,
}

#[repr(C)]
struct BufferAttr {
    maxlength: u32,
    tlength: u32,
    prebuf: u32,
    minreq: u32,
    fragsize: u32,
}

type NewFn = unsafe extern "C" fn(
    server: *const c_char,
    name: *const c_char,
    direction: c_int,
    device: *const c_char,
    stream_name: *const c_char,
    spec: *const SampleSpec,
    map: *const c_void,
    attr: *const BufferAttr,
    error: *mut c_int,
) -> *mut c_void;
type ReadFn = unsafe extern "C" fn(
    s: *mut c_void,
    data: *mut c_void,
    bytes: usize,
    error: *mut c_int,
) -> c_int;
type FreeFn = unsafe extern "C" fn(s: *mut c_void);
type StrErrorFn = unsafe extern "C" fn(error: c_int) -> *const c_char;

struct Pulse {
    simple: Library,
    core: Option<Library>,
}

impl Pulse {
    fn load() -> Result<Self, CaptureError> {
        // SAFETY: loading the system's PulseAudio client libraries, which have
        // no initialisers with preconditions.
        let simple = unsafe { Library::new("libpulse-simple.so.0") }.map_err(|error| {
            CaptureError::new(
                "sound_server_unavailable",
                format!("PulseAudio or PipeWire's PulseAudio support is needed to record other apps' audio ({error})."),
            )
        })?;
        let core = unsafe { Library::new("libpulse.so.0") }.ok();
        Ok(Self { simple, core })
    }

    fn describe(&self, code: c_int) -> String {
        let Some(core) = &self.core else {
            return format!("PulseAudio error {code}");
        };
        // SAFETY: pa_strerror returns a static string for any code.
        unsafe {
            match core.get::<StrErrorFn>(b"pa_strerror\0") {
                Ok(strerror) => {
                    let text = strerror(code);
                    if text.is_null() {
                        format!("PulseAudio error {code}")
                    } else {
                        CStr::from_ptr(text).to_string_lossy().into_owned()
                    }
                }
                Err(_) => format!("PulseAudio error {code}"),
            }
        }
    }
}

struct Stream {
    pulse: Pulse,
    handle: *mut c_void,
}

// The handle is only used by the capture thread after it is created.
unsafe impl Send for Stream {}

impl Drop for Stream {
    fn drop(&mut self) {
        // SAFETY: the handle came from pa_simple_new and is freed once.
        unsafe {
            if let Ok(free) = self.pulse.simple.get::<FreeFn>(b"pa_simple_free\0") {
                free(self.handle);
            }
        }
    }
}

fn open() -> Result<Stream, CaptureError> {
    let pulse = Pulse::load()?;
    let name = CString::new("Opengeni").unwrap();
    let stream_name = CString::new("Meeting audio").unwrap();
    let device = CString::new("@DEFAULT_MONITOR@").unwrap();
    let spec = SampleSpec {
        format: PA_SAMPLE_FLOAT32LE,
        rate: SAMPLE_RATE,
        channels: 1,
    };
    // Ask for 20 ms fragments so audio arrives steadily.
    let attr = BufferAttr {
        maxlength: u32::MAX,
        tlength: u32::MAX,
        prebuf: u32::MAX,
        minreq: u32::MAX,
        fragsize: SAMPLE_RATE / 50 * 4,
    };
    let mut error: c_int = 0;
    // SAFETY: all pointers are valid for the call; the symbol has this signature.
    let handle = unsafe {
        let new: Symbol<NewFn> = pulse
            .simple
            .get(b"pa_simple_new\0")
            .map_err(|error| CaptureError::new("sound_server_unavailable", error.to_string()))?;
        new(
            std::ptr::null(),
            name.as_ptr(),
            PA_STREAM_RECORD,
            device.as_ptr(),
            stream_name.as_ptr(),
            &spec,
            std::ptr::null(),
            &attr,
            &mut error,
        )
    };
    if handle.is_null() {
        return Err(CaptureError::new(
            "sound_server_unavailable",
            format!(
                "Could not record the sound server's output: {}.",
                pulse.describe(error)
            ),
        ));
    }
    Ok(Stream { pulse, handle })
}

struct Guard {
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Guard {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub fn start(_options: &Options, sink: Sink) -> Result<Capture, CaptureError> {
    let stream = open()?;
    let running = Arc::new(AtomicBool::new(true));
    let thread = {
        let running = running.clone();
        std::thread::spawn(move || {
            let read: ReadFn =
                match unsafe { stream.pulse.simple.get::<ReadFn>(b"pa_simple_read\0") } {
                    Ok(symbol) => *symbol,
                    Err(_) => return,
                };
            // 20 ms per read.
            let mut samples = vec![0f32; (SAMPLE_RATE / 50) as usize];
            while running.load(Ordering::Relaxed) {
                let mut error: c_int = 0;
                // SAFETY: the buffer holds exactly the requested bytes.
                let status = unsafe {
                    read(
                        stream.handle,
                        samples.as_mut_ptr().cast(),
                        samples.len() * 4,
                        &mut error,
                    )
                };
                if status < 0 {
                    crate::output::fatal("capture_failed", &stream.pulse.describe(error));
                }
                sink.push(&samples);
            }
            drop(stream);
        })
    };
    Ok(Capture {
        sample_rate: SAMPLE_RATE,
        backend: "pulseaudio-monitor",
        _guard: Box::new(Guard {
            running,
            thread: Some(thread),
        }),
    })
}
