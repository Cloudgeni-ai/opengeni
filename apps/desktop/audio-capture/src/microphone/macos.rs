//! macOS 14 and later: Core Audio lists every process with audio objects and
//! says which of them is running input right now.

use std::ffi::{c_int, c_void};
use std::sync::OnceLock;

use cidre::core_audio as ca;

use super::{MicrophoneUser, file_name};
use crate::CaptureError;

const PATH_MAX: usize = 4096;

unsafe extern "C" {
    fn proc_pidpath(pid: c_int, buffer: *mut c_void, size: u32) -> c_int;
}

fn process_path(pid: i32) -> Option<String> {
    let mut buffer = vec![0u8; PATH_MAX];
    // SAFETY: the buffer holds PATH_MAX bytes, as told.
    let length = unsafe { proc_pidpath(pid, buffer.as_mut_ptr().cast(), PATH_MAX as u32) };
    if length <= 0 {
        return None;
    }
    buffer.truncate(length as usize);
    String::from_utf8(buffer).ok()
}

type Responsible = unsafe extern "C" fn(c_int) -> c_int;

/// libSystem and the private call, loaded once and kept for the process.
fn responsible_function() -> Option<Responsible> {
    static FUNCTION: OnceLock<Option<(libloading::Library, Responsible)>> = OnceLock::new();
    FUNCTION
        .get_or_init(|| {
            // SAFETY: libSystem is always present; the symbol takes and
            // returns a pid. The library is kept beside the pointer, so the
            // pointer stays valid.
            unsafe {
                let library = libloading::Library::new("/usr/lib/libSystem.B.dylib").ok()?;
                let function = *library
                    .get::<Responsible>(b"responsibility_get_pid_responsible_for_pid\0")
                    .ok()?;
                Some((library, function))
            }
        })
        .as_ref()
        .map(|(_, function)| *function)
}

/// The process macOS holds responsible for this one (the app above a
/// WebKit or helper process), when it differs. The call is private but
/// stable, and looked up at run time so a missing one only loses the owner.
fn responsible_pid(pid: i32) -> Option<i32> {
    let function = responsible_function()?;
    // SAFETY: see responsible_function.
    let owner = unsafe { function(pid) };
    (owner > 0 && owner != pid).then_some(owner)
}

pub fn users() -> Result<Vec<MicrophoneUser>, CaptureError> {
    let processes = ca::System::processes().map_err(|status| {
        CaptureError::new(
            "unavailable",
            format!("Could not list the processes using audio ({status:?})."),
        )
    })?;
    let mut users = Vec::new();
    for process in processes {
        if !process.is_running_input().unwrap_or(false) {
            continue;
        }
        let Ok(pid) = process.pid() else {
            continue;
        };
        let path = process_path(pid);
        let bundle_id = process
            .bundle_id()
            .ok()
            .map(|id| id.to_string())
            .filter(|id| !id.is_empty());
        let owners = responsible_pid(pid)
            .and_then(process_path)
            .into_iter()
            .collect();
        users.push(MicrophoneUser {
            pid: pid as u32,
            name: path.as_deref().map(file_name).unwrap_or_default(),
            path,
            bundle_id,
            owners,
        });
    }
    Ok(users)
}
