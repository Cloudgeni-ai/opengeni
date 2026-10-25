//! Linux: the sound server's recording streams (PulseAudio, or PipeWire's
//! PulseAudio service) that read a real input rather than another output's
//! monitor, and the client process behind each. libpulse is loaded at run
//! time, as for the capture.

use std::ffi::{CStr, CString, c_char, c_int, c_void};

use libloading::Library;

use super::{MAX_OWNERS, MicrophoneUser, file_name};
use crate::CaptureError;

const PA_CONTEXT_READY: c_int = 4;
const PA_CONTEXT_FAILED: c_int = 5;
const PA_CONTEXT_TERMINATED: c_int = 6;
const PA_OPERATION_RUNNING: c_int = 0;
const PA_INVALID_INDEX: u32 = u32::MAX;
const CHANNELS_MAX: usize = 32;

#[repr(C)]
#[allow(dead_code)]
struct SampleSpec {
    format: c_int,
    rate: u32,
    channels: u8,
}

#[repr(C)]
#[allow(dead_code)]
struct ChannelMap {
    channels: u8,
    map: [c_int; CHANNELS_MAX],
}

#[repr(C)]
#[allow(dead_code)]
struct CVolume {
    channels: u8,
    values: [u32; CHANNELS_MAX],
}

/// The leading fields of `pa_source_output_info`, as in pulse/introspect.h.
#[repr(C)]
#[allow(dead_code)]
struct SourceOutputInfo {
    index: u32,
    name: *const c_char,
    owner_module: u32,
    client: u32,
    source: u32,
    sample_spec: SampleSpec,
    channel_map: ChannelMap,
    buffer_usec: u64,
    source_usec: u64,
    resample_method: *const c_char,
    driver: *const c_char,
    proplist: *mut c_void,
    corked: c_int,
}

/// The leading fields of `pa_source_info`.
#[repr(C)]
#[allow(dead_code)]
struct SourceInfo {
    name: *const c_char,
    index: u32,
    description: *const c_char,
    sample_spec: SampleSpec,
    channel_map: ChannelMap,
    owner_module: u32,
    volume: CVolume,
    mute: c_int,
    monitor_of_sink: u32,
}

type MainloopNew = unsafe extern "C" fn() -> *mut c_void;
type MainloopGetApi = unsafe extern "C" fn(*mut c_void) -> *mut c_void;
type MainloopIterate = unsafe extern "C" fn(*mut c_void, c_int, *mut c_int) -> c_int;
type MainloopFree = unsafe extern "C" fn(*mut c_void);
type ContextNew = unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void;
type ContextConnect =
    unsafe extern "C" fn(*mut c_void, *const c_char, c_int, *const c_void) -> c_int;
type ContextGetState = unsafe extern "C" fn(*mut c_void) -> c_int;
type ContextVoid = unsafe extern "C" fn(*mut c_void);
type OutputCallback = extern "C" fn(*mut c_void, *const SourceOutputInfo, c_int, *mut c_void);
type SourceCallback = extern "C" fn(*mut c_void, *const SourceInfo, c_int, *mut c_void);
type GetOutputs = unsafe extern "C" fn(*mut c_void, OutputCallback, *mut c_void) -> *mut c_void;
type GetSources = unsafe extern "C" fn(*mut c_void, SourceCallback, *mut c_void) -> *mut c_void;
type OperationGetState = unsafe extern "C" fn(*mut c_void) -> c_int;
type OperationUnref = unsafe extern "C" fn(*mut c_void);
type ProplistGets = unsafe extern "C" fn(*mut c_void, *const c_char) -> *const c_char;

struct Stream {
    pid: Option<u32>,
    binary: Option<String>,
    app_name: Option<String>,
    source: u32,
    corked: bool,
}

#[derive(Default)]
struct Listing {
    gets: Option<ProplistGets>,
    streams: Vec<Stream>,
    monitors: Vec<u32>,
    failed: bool,
}

unsafe fn text(pointer: *const c_char) -> Option<String> {
    if pointer.is_null() {
        return None;
    }
    // SAFETY: libpulse strings are NUL-terminated and live for the callback.
    let value = unsafe { CStr::from_ptr(pointer) }
        .to_string_lossy()
        .into_owned();
    (!value.is_empty()).then_some(value)
}

extern "C" fn on_output(
    _context: *mut c_void,
    info: *const SourceOutputInfo,
    eol: c_int,
    userdata: *mut c_void,
) {
    // SAFETY: userdata is the Listing passed with the request, alive until it ends.
    let listing = unsafe { &mut *(userdata as *mut Listing) };
    if eol < 0 {
        listing.failed = true;
    }
    if eol != 0 || info.is_null() {
        return;
    }
    // SAFETY: libpulse passes a valid info for the callback's duration.
    let info = unsafe { &*info };
    let property = |key: &str| -> Option<String> {
        let gets = listing.gets?;
        let key = CString::new(key).ok()?;
        // SAFETY: the proplist belongs to info; gets returns a borrowed string.
        unsafe { text(gets(info.proplist, key.as_ptr())) }
    };
    let stream = Stream {
        pid: property("application.process.id").and_then(|pid| pid.parse().ok()),
        binary: property("application.process.binary"),
        app_name: property("application.name"),
        source: info.source,
        corked: info.corked != 0,
    };
    listing.streams.push(stream);
}

extern "C" fn on_source(
    _context: *mut c_void,
    info: *const SourceInfo,
    eol: c_int,
    userdata: *mut c_void,
) {
    // SAFETY: as in on_output.
    let listing = unsafe { &mut *(userdata as *mut Listing) };
    if eol < 0 {
        listing.failed = true;
    }
    if eol != 0 || info.is_null() {
        return;
    }
    // SAFETY: as in on_output.
    let info = unsafe { &*info };
    if info.monitor_of_sink != PA_INVALID_INDEX {
        listing.monitors.push(info.index);
    }
}

fn unavailable(message: impl Into<String>) -> CaptureError {
    CaptureError::new("sound_server_unavailable", message)
}

struct Client {
    _library: Library,
    mainloop: *mut c_void,
    context: *mut c_void,
    iterate: MainloopIterate,
    free_mainloop: MainloopFree,
    disconnect: ContextVoid,
    unref_context: ContextVoid,
    get_state: ContextGetState,
    get_outputs: GetOutputs,
    get_sources: GetSources,
    operation_state: OperationGetState,
    operation_unref: OperationUnref,
    gets: ProplistGets,
}

impl Drop for Client {
    fn drop(&mut self) {
        // SAFETY: both were created by this client and are released once.
        unsafe {
            (self.disconnect)(self.context);
            (self.unref_context)(self.context);
            (self.free_mainloop)(self.mainloop);
        }
    }
}

impl Client {
    fn connect() -> Result<Self, CaptureError> {
        // SAFETY: loading the system's PulseAudio client library.
        let library = unsafe { Library::new("libpulse.so.0") }.map_err(|error| {
            unavailable(format!(
                "PulseAudio or PipeWire's PulseAudio support is needed to see which apps use the microphone ({error})."
            ))
        })?;
        macro_rules! symbol {
            ($name:literal, $kind:ty) => {
                // SAFETY: the symbol has this signature in libpulse's headers.
                *unsafe { library.get::<$kind>(concat!($name, "\0").as_bytes()) }
                    .map_err(|error| unavailable(error.to_string()))?
            };
        }
        let mainloop_new = symbol!("pa_mainloop_new", MainloopNew);
        let get_api = symbol!("pa_mainloop_get_api", MainloopGetApi);
        let iterate = symbol!("pa_mainloop_iterate", MainloopIterate);
        let free_mainloop = symbol!("pa_mainloop_free", MainloopFree);
        let context_new = symbol!("pa_context_new", ContextNew);
        let context_connect = symbol!("pa_context_connect", ContextConnect);
        let get_state = symbol!("pa_context_get_state", ContextGetState);
        let disconnect = symbol!("pa_context_disconnect", ContextVoid);
        let unref_context = symbol!("pa_context_unref", ContextVoid);
        let get_outputs = symbol!("pa_context_get_source_output_info_list", GetOutputs);
        let get_sources = symbol!("pa_context_get_source_info_list", GetSources);
        let operation_state = symbol!("pa_operation_get_state", OperationGetState);
        let operation_unref = symbol!("pa_operation_unref", OperationUnref);
        let gets = symbol!("pa_proplist_gets", ProplistGets);
        let name = CString::new("Opengeni call detection").unwrap();
        // SAFETY: plain libpulse calls in the order its docs give; every
        // object is released in Drop.
        unsafe {
            let mainloop = mainloop_new();
            if mainloop.is_null() {
                return Err(unavailable("Could not start a PulseAudio main loop."));
            }
            let context = context_new(get_api(mainloop), name.as_ptr());
            if context.is_null() {
                free_mainloop(mainloop);
                return Err(unavailable("Could not create a PulseAudio context."));
            }
            let client = Client {
                _library: library,
                mainloop,
                context,
                iterate,
                free_mainloop,
                disconnect,
                unref_context,
                get_state,
                get_outputs,
                get_sources,
                operation_state,
                operation_unref,
                gets,
            };
            if context_connect(context, std::ptr::null(), 0, std::ptr::null()) < 0 {
                return Err(unavailable(
                    "No sound server (PulseAudio or PipeWire) is running.",
                ));
            }
            loop {
                match (client.get_state)(context) {
                    PA_CONTEXT_READY => break,
                    PA_CONTEXT_FAILED | PA_CONTEXT_TERMINATED => {
                        return Err(unavailable(
                            "No sound server (PulseAudio or PipeWire) is running.",
                        ));
                    }
                    _ => {
                        if (client.iterate)(mainloop, 1, std::ptr::null_mut()) < 0 {
                            return Err(unavailable("The sound server connection failed."));
                        }
                    }
                }
            }
            Ok(client)
        }
    }

    fn ready(&self) -> bool {
        // SAFETY: the context is alive while the client is.
        unsafe { (self.get_state)(self.context) == PA_CONTEXT_READY }
    }

    /// Run one introspection request to its end.
    fn wait(&self, operation: *mut c_void) -> Result<(), CaptureError> {
        if operation.is_null() {
            return Err(unavailable("The sound server refused the request."));
        }
        // SAFETY: the operation is unreferenced once, after it finishes.
        unsafe {
            while (self.operation_state)(operation) == PA_OPERATION_RUNNING {
                if (self.iterate)(self.mainloop, 1, std::ptr::null_mut()) < 0 {
                    (self.operation_unref)(operation);
                    return Err(unavailable("The sound server connection failed."));
                }
            }
            (self.operation_unref)(operation);
        }
        Ok(())
    }

    fn list(&self) -> Result<Listing, CaptureError> {
        let mut listing = Listing {
            gets: Some(self.gets),
            ..Default::default()
        };
        let userdata = &mut listing as *mut Listing as *mut c_void;
        // SAFETY: listing outlives both requests, which end inside wait().
        let sources = unsafe { (self.get_sources)(self.context, on_source, userdata) };
        self.wait(sources)?;
        let outputs = unsafe { (self.get_outputs)(self.context, on_output, userdata) };
        self.wait(outputs)?;
        if listing.failed {
            return Err(unavailable("The sound server couldn't list its streams."));
        }
        Ok(listing)
    }
}

thread_local! {
    static CLIENT: std::cell::RefCell<Option<Client>> = const { std::cell::RefCell::new(None) };
}

fn process_path(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

fn parent(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The name is in parentheses and may hold spaces: the fields after the last ")".
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.split_whitespace().nth(1)?.parse().ok()
}

pub fn users() -> Result<Vec<MicrophoneUser>, CaptureError> {
    let listing = CLIENT.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.as_ref().is_some_and(|client| !client.ready()) {
            *slot = None;
        }
        if slot.is_none() {
            *slot = Some(Client::connect()?);
        }
        let result = slot.as_ref().expect("connected").list();
        if result.is_err() {
            // Connect again next time.
            *slot = None;
        }
        result
    })?;
    let mut users = Vec::new();
    for stream in listing.streams {
        if stream.corked || listing.monitors.contains(&stream.source) {
            continue;
        }
        // A sandboxed app's pid belongs to its own namespace; its path then
        // can't be read here, and the stream's binary name stands in.
        let pid = stream.pid.unwrap_or(0);
        let path = (pid != 0).then(|| process_path(pid)).flatten();
        let mut owners = Vec::new();
        let mut current = pid;
        while pid != 0 && owners.len() < MAX_OWNERS {
            match parent(current) {
                Some(next) if next > 1 && next != current => {
                    match process_path(next) {
                        Some(owner) => owners.push(owner),
                        None => break,
                    }
                    current = next;
                }
                _ => break,
            }
        }
        let name = stream
            .binary
            .clone()
            .or_else(|| path.as_deref().map(file_name))
            .or(stream.app_name.clone())
            .unwrap_or_default();
        users.push(MicrophoneUser {
            pid,
            name,
            path: path.or(stream.binary),
            bundle_id: None,
            owners,
        });
    }
    Ok(users)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layouts_match_libpulse() {
        // Offsets from pulse/introspect.h on 64-bit Linux.
        assert_eq!(std::mem::offset_of!(SourceOutputInfo, sample_spec), 28);
        assert_eq!(std::mem::offset_of!(SourceOutputInfo, buffer_usec), 176);
        assert_eq!(std::mem::offset_of!(SourceOutputInfo, proplist), 208);
        assert_eq!(std::mem::offset_of!(SourceOutputInfo, corked), 216);
    }

    #[test]
    fn reads_parent_of_self() {
        assert!(parent(std::process::id()).is_some());
    }
}
