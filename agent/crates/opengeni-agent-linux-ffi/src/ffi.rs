//! The complete Linux `unsafe` surface.
//!
//! The pre-exec closures call only async-signal-safe libc operations. Static byte
//! strings and stack-only integer formatting avoid allocation, locks,
//! environment access, and Rust filesystem machinery in the post-fork child.

use std::fs::File;
use std::os::fd::AsRawFd as _;
use std::os::unix::process::CommandExt as _;

pub(super) fn configure_oom_score_adj_before_exec(
    command: &mut tokio::process::Command,
    score: u16,
) {
    let score = score.min(1000);
    // SAFETY: the closure captures only a Copy integer and its body is limited to
    // stack formatting plus the three async-signal-safe libc calls documented
    // above. Errors are ignored so hardening cannot change spawn semantics.
    unsafe {
        command.as_std_mut().pre_exec(move || {
            const PATH: &[u8] = b"/proc/self/oom_score_adj\0";
            const DECIMAL_DIGITS: usize = 4;
            let mut digits = [0_u8; DECIMAL_DIGITS];
            let mut value = score;
            let mut start = digits.len();
            loop {
                start -= 1;
                digits[start] = b'0' + u8::try_from(value % 10).unwrap_or(0);
                value /= 10;
                if value == 0 {
                    break;
                }
            }
            let bytes = &digits[start..];
            let fd = libc::open(PATH.as_ptr().cast(), libc::O_WRONLY | libc::O_CLOEXEC);
            if fd >= 0 {
                let _ = libc::write(fd, bytes.as_ptr().cast(), bytes.len());
                let _ = libc::close(fd);
            }
            Ok(())
        });
    }
}

pub(super) fn configure_process_cgroup_before_exec(
    command: &mut tokio::process::Command,
    cgroup_procs: File,
) {
    // SAFETY: the closure uses only getpid(2), write(2), errno access, and
    // stack-local integer formatting. The captured File keeps the pre-opened
    // CLOEXEC descriptor alive in the child until exec; no path lookup or
    // allocation occurs after fork.
    unsafe {
        command.as_std_mut().pre_exec(move || {
            // Linux `pid_t` is a signed 32-bit integer and getpid(2) returns a
            // positive value, so ten decimal digits cover its complete domain.
            const PID_DECIMAL_DIGITS: usize = 10;
            let mut digits = [0_u8; PID_DECIMAL_DIGITS];
            let mut value = libc::getpid().unsigned_abs();
            let mut start = digits.len();
            loop {
                let digit = u8::try_from(value % 10)
                    .map_err(|_| std::io::Error::from_raw_os_error(libc::EINVAL))?;
                start -= 1;
                digits[start] = b'0' + digit;
                value /= 10;
                if value == 0 {
                    break;
                }
            }
            let bytes = &digits[start..];
            loop {
                let written =
                    libc::write(cgroup_procs.as_raw_fd(), bytes.as_ptr().cast(), bytes.len());
                if usize::try_from(written).ok() == Some(bytes.len()) {
                    return Ok(());
                }
                let error = (written < 0).then(std::io::Error::last_os_error);
                if error.as_ref().and_then(std::io::Error::raw_os_error) == Some(libc::EINTR) {
                    continue;
                }
                return Err(error.unwrap_or_else(|| std::io::Error::from_raw_os_error(libc::EIO)));
            }
        });
    }
}
