//! Whole-machine memory, processor-time and volume readings for the agent's
//! metrics and capacity samples. Each call is one Win32 query that writes only
//! into a stack value it owns, so there is nothing to release afterwards.

use std::ffi::OsStr;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows_sys::Win32::Foundation::FILETIME;
use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows_sys::Win32::System::Threading::GetSystemTimes;

use crate::system::{Memory, ProcessorTimes, Volume};

pub(crate) fn memory() -> Option<Memory> {
    let mut status = MEMORYSTATUSEX {
        dwLength: u32::try_from(size_of::<MEMORYSTATUSEX>()).ok()?,
        dwMemoryLoad: 0,
        ullTotalPhys: 0,
        ullAvailPhys: 0,
        ullTotalPageFile: 0,
        ullAvailPageFile: 0,
        ullTotalVirtual: 0,
        ullAvailVirtual: 0,
        ullAvailExtendedVirtual: 0,
    };
    // SAFETY: `status` is a live, writable MEMORYSTATUSEX whose dwLength is set
    // to its size, as GlobalMemoryStatusEx requires.
    if unsafe { GlobalMemoryStatusEx(&raw mut status) } == 0 || status.ullTotalPhys == 0 {
        return None;
    }
    Some(Memory {
        total_bytes: status.ullTotalPhys,
        available_bytes: status.ullAvailPhys.min(status.ullTotalPhys),
    })
}

fn filetime_ticks(time: FILETIME) -> u64 {
    (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
}

pub(crate) fn processor_times() -> Option<ProcessorTimes> {
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut idle, mut kernel, mut user) = (zero, zero, zero);
    // SAFETY: three live, writable FILETIME values; GetSystemTimes only writes them.
    if unsafe { GetSystemTimes(&raw mut idle, &raw mut kernel, &raw mut user) } == 0 {
        return None;
    }
    Some(ProcessorTimes {
        idle: filetime_ticks(idle),
        kernel: filetime_ticks(kernel),
        user: filetime_ticks(user),
    })
}

pub(crate) fn volume(path: &Path) -> Option<Volume> {
    let wide: Vec<u16> = OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let (mut available, mut total, mut free) = (0u64, 0u64, 0u64);
    // SAFETY: `wide` is a NUL-terminated UTF-16 path that outlives the call, and
    // the three out-pointers are live, writable u64 values.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &raw mut available,
            &raw mut total,
            &raw mut free,
        )
    };
    if ok == 0 || total == 0 {
        return None;
    }
    Some(Volume {
        total_bytes: total,
        available_bytes: available.min(total),
    })
}
