//! macOS 14.2 and later: a private Core Audio process tap of everything the
//! system plays except the app's own processes, read through a private
//! aggregate device. It needs only the "System Audio Recording" permission,
//! not screen recording; macOS asks the first time.

use cidre::core_audio::aggregate_device_keys as agg_keys;
use cidre::{arc, cat, cf, core_audio as ca, ns, os};

use crate::output::{self, Event, Sink};
use crate::{Capture, CaptureError, Options};

struct Context {
    sink: Sink,
}

struct Guard {
    // Field order is drop order: stop the device before the tap goes away.
    _device: ca::hardware::StartedDevice<ca::AggregateDevice>,
    _tap: ca::TapGuard,
    _context: Box<Context>,
}

extern "C" fn io_proc(
    _device: ca::Device,
    _now: &cat::AudioTimeStamp,
    input: &cat::AudioBufList<1>,
    _input_time: &cat::AudioTimeStamp,
    _output: &mut cat::AudioBufList<1>,
    _output_time: &cat::AudioTimeStamp,
    context: Option<&mut Context>,
) -> os::Status {
    let Some(context) = context else {
        return os::Status::NO_ERR;
    };
    let buffer = &input.buffers[0];
    let bytes = buffer.data_bytes_size as usize;
    if bytes == 0 || buffer.data.is_null() || !(buffer.data as usize).is_multiple_of(4) {
        return os::Status::NO_ERR;
    }
    // SAFETY: the tap delivers mono 32-bit float frames (checked at start).
    let samples = unsafe { std::slice::from_raw_parts(buffer.data as *const f32, bytes / 4) };
    context.sink.push(samples);
    os::Status::NO_ERR
}

fn excluded_processes(options: &Options) -> Vec<arc::R<ns::Number>> {
    let Ok(processes) = ca::System::processes() else {
        return Vec::new();
    };
    processes
        .into_iter()
        .filter(|process| {
            let by_pid = process
                .pid()
                .map(|pid| options.exclude_pids.contains(&(pid as u32)))
                .unwrap_or(false);
            let by_bundle = !options.exclude_bundle_prefixes.is_empty()
                && process
                    .bundle_id()
                    .map(|id| {
                        let id = id.to_string();
                        options
                            .exclude_bundle_prefixes
                            .iter()
                            .any(|prefix| id.starts_with(prefix.as_str()))
                    })
                    .unwrap_or(false);
            by_pid || by_bundle
        })
        .map(|process| ns::Number::with_u32(process.0.0))
        .collect()
}

fn failed(step: &str, status: os::Error) -> CaptureError {
    CaptureError::new(
        "capture_failed",
        format!("Could not record other apps' audio ({step}: {status:?})."),
    )
}

fn permission_denied() -> CaptureError {
    CaptureError::new(
        "permission_denied",
        "System Audio Recording is turned off for this app.",
    )
}

/// Whether the app may record system audio, from TCC's preflight: 0 allowed,
/// 1 turned off, 2 not asked yet. There is no public API for this permission,
/// and a tap the person turned off records silence instead of failing, so
/// this is the only way to tell them. The helper's permission is its app's.
fn audio_capture_permission() -> Option<isize> {
    type Preflight =
        unsafe extern "C" fn(*const std::ffi::c_void, *const std::ffi::c_void) -> isize;
    // SAFETY: TCCAccessPreflight takes a CFString service name and an optional
    // options dictionary, and returns an integer status; the library stays
    // loaded while it runs.
    unsafe {
        let library = libloading::Library::new(
            "/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC",
        )
        .ok()?;
        let preflight = library.get::<Preflight>(b"TCCAccessPreflight\0").ok()?;
        let service = cf::String::from_str("kTCCServiceAudioCapture");
        let service: &cf::String = &service;
        Some(preflight(
            service as *const cf::String as *const std::ffi::c_void,
            std::ptr::null(),
        ))
    }
}

pub fn start(options: &Options, sink: Sink) -> Result<Capture, CaptureError> {
    match audio_capture_permission() {
        Some(1) => return Err(permission_denied()),
        // Not asked yet: macOS asks now, and starting the device below waits
        // for the person's answer. Say so, so the app doesn't give up meanwhile.
        Some(2) => output::event(&Event::AwaitingPermission),
        _ => {}
    }
    let excluded = excluded_processes(options);
    let excluded = ns::Array::from_slice_retained(&excluded);
    let mut description = ca::TapDesc::with_mono_global_tap_excluding_processes(&excluded);
    description.set_private(true);
    let tap = description
        .create_process_tap()
        .map_err(|status| failed("create the tap", status))?;
    let format = tap
        .asbd()
        .map_err(|status| failed("read the tap format", status))?;
    if format.channels_per_frame != 1
        || format.bits_per_channel != 32
        || !format
            .format_flags
            .contains(cat::AudioFormatFlags::IS_FLOAT)
    {
        return Err(CaptureError::new(
            "capture_failed",
            format!("The system audio tap uses an unexpected format: {format:?}."),
        ));
    }
    let tap_uid = tap
        .uid()
        .map_err(|status| failed("read the tap id", status))?;
    let sub_tap =
        cf::DictionaryOf::with_keys_values(&[ca::sub_device_keys::uid()], &[tap_uid.as_type_ref()]);
    let aggregate = cf::DictionaryOf::with_keys_values(
        &[
            agg_keys::is_private(),
            agg_keys::tap_auto_start(),
            agg_keys::name(),
            agg_keys::uid(),
            agg_keys::tap_list(),
        ],
        &[
            cf::Boolean::value_true().as_type_ref(),
            cf::Boolean::value_true(),
            cf::String::from_str("Opengeni meeting audio").as_ref(),
            &cf::Uuid::new().to_cf_string(),
            &cf::ArrayOf::from_slice(&[sub_tap.as_ref()]),
        ],
    );
    let device = ca::AggregateDevice::with_desc(&aggregate)
        .map_err(|status| failed("create the aggregate device", status))?;
    let mut context = Box::new(Context { sink });
    let proc_id = device
        .create_io_proc_id(io_proc, Some(&mut *context))
        .map_err(|status| failed("listen to the device", status))?;
    let started = ca::device_start(device, Some(proc_id))
        .map_err(|status| failed("start the device", status))?;
    // Turned off in the prompt just now: the tap would record only silence.
    if audio_capture_permission() == Some(1) {
        return Err(permission_denied());
    }
    Ok(Capture {
        sample_rate: format.sample_rate.round() as u32,
        backend: "core-audio-tap",
        _guard: Box::new(Guard {
            _device: started,
            _tap: tap,
            _context: context,
        }),
    })
}
