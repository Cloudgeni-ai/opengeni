//! Darwin's kernel process-group inventory. Independent of desktop/TCC access.

use std::io;
use std::mem::{size_of, zeroed};

/// Returns whether the anchored process group contains live processes other
/// than its private anchor. The caller keeps that anchor unreaped throughout
/// inspection and cleanup, fencing numeric group-id reuse.
///
/// # Errors
/// Returns native inventory failures rather than inventing a cleanup receipt.
pub fn process_group_has_live_children(group_id: i32) -> io::Result<bool> {
    // xnu/bsd/sys/proc_info.h: PROC_PGRP_ONLY.
    const PROC_PGRP_ONLY: u32 = 2;
    let group = u32::try_from(group_id).map_err(|_| io::Error::other("invalid process group"))?;
    // SAFETY: null/zero requests the required buffer size; no memory is written.
    let size = unsafe { libc::proc_listpids(PROC_PGRP_ONLY, group, std::ptr::null_mut(), 0) };
    if size <= 0 {
        return Err(io::Error::last_os_error());
    }
    let mut pids = vec![0_i32; usize::try_from(size).unwrap_or_default() / size_of::<i32>() + 1];
    loop {
        let bytes = i32::try_from(pids.len() * size_of::<i32>())
            .map_err(|_| io::Error::other("process inventory exceeds native buffer range"))?;
        // SAFETY: the initialized buffer has exactly bytes writable bytes.
        let count =
            unsafe { libc::proc_listpids(PROC_PGRP_ONLY, group, pids.as_mut_ptr().cast(), bytes) };
        if count < 0 {
            return Err(io::Error::last_os_error());
        }
        if count >= bytes {
            pids.resize(pids.len() * 2, 0);
            continue;
        }
        let count = usize::try_from(count).unwrap_or_default() / size_of::<i32>();
        for &pid in &pids[..count] {
            if pid <= 0 || pid == group_id {
                continue;
            }
            // SAFETY: proc_bsdinfo is a plain C record, fully initialized here.
            let mut info: libc::proc_bsdinfo = unsafe { zeroed() };
            let size = i32::try_from(size_of::<libc::proc_bsdinfo>()).map_err(io::Error::other)?;
            // SAFETY: the output points to a live, correctly sized C record.
            let read = unsafe {
                libc::proc_pidinfo(
                    pid,
                    libc::PROC_PIDTBSDINFO,
                    0,
                    std::ptr::from_mut(&mut info).cast(),
                    size,
                )
            };
            if read == size && info.pbi_pgid == group && info.pbi_status != libc::SZOMB {
                return Ok(true);
            }
            // A process may exit between the inventory and detail query.
        }
        return Ok(false);
    }
}
