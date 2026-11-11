//! Windows: every active capture endpoint's audio sessions, and the process
//! behind each session that is running.

use std::collections::HashMap;

use wasapi::{DeviceEnumerator, Direction, SessionState, initialize_mta};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::core::PWSTR;

use super::{MAX_OWNERS, MicrophoneUser, file_name};
use crate::CaptureError;

fn process_path(pid: u32) -> Option<String> {
    // SAFETY: the handle is closed below; the buffer's length is passed in.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = vec![0u16; 1024];
        let mut size = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);
        result.ok()?;
        Some(String::from_utf16_lossy(&buffer[..size as usize]))
    }
}

/// Each process's parent, from one snapshot.
fn parents() -> HashMap<u32, u32> {
    let mut map = HashMap::new();
    // SAFETY: the snapshot handle is closed below; the entry's size is set.
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return map;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                map.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    map
}

fn failed(error: impl std::fmt::Display) -> CaptureError {
    CaptureError::new(
        "unavailable",
        format!("Could not read which apps use the microphone ({error})."),
    )
}

pub fn users() -> Result<Vec<MicrophoneUser>, CaptureError> {
    // Already initialized on this thread after the first call; that's fine.
    let _ = initialize_mta();
    let enumerator = DeviceEnumerator::new().map_err(failed)?;
    let devices = enumerator
        .get_device_collection(&Direction::Capture)
        .map_err(failed)?;
    let mut pids = Vec::new();
    for index in 0..devices.get_nbr_devices().map_err(failed)? {
        let Ok(device) = devices.get_device_at_index(index) else {
            continue;
        };
        let Ok(sessions) = device
            .get_iaudiosessionmanager()
            .and_then(|manager| manager.get_audiosessionenumerator())
        else {
            continue;
        };
        for session_index in 0..sessions.get_count().unwrap_or(0) {
            let Ok(session) = sessions.get_session(session_index) else {
                continue;
            };
            if !matches!(session.get_state(), Ok(SessionState::Active)) {
                continue;
            }
            // Process 0 is the system's own sounds.
            if let Ok(pid) = session.get_process_id()
                && pid != 0
            {
                pids.push(pid);
            }
        }
    }
    if pids.is_empty() {
        return Ok(Vec::new());
    }
    let parents = parents();
    let mut users = Vec::new();
    for pid in pids {
        let path = process_path(pid);
        let mut owners = Vec::new();
        let mut current = pid;
        while owners.len() < MAX_OWNERS {
            let Some(&parent) = parents.get(&current) else {
                break;
            };
            if parent == 0 || parent == current {
                break;
            }
            match process_path(parent) {
                Some(owner) => owners.push(owner),
                None => break,
            }
            current = parent;
        }
        users.push(MicrophoneUser {
            pid,
            name: path.as_deref().map(file_name).unwrap_or_default(),
            path,
            bundle_id: None,
            owners,
        });
    }
    Ok(users)
}
