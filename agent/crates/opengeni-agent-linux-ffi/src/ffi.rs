//! The complete Linux `unsafe` surface.
//!
//! The pre-exec closure captures nothing and calls only `open(2)`, `write(2)`,
//! and `close(2)`, all async-signal-safe. Static byte strings avoid allocation,
//! locks, environment access, formatting, and Rust filesystem machinery in the
//! post-fork child.

use std::os::unix::process::CommandExt as _;

pub(super) fn configure_oom_score_adj_before_exec(command: &mut tokio::process::Command) {
    // SAFETY: the closure captures nothing and its body is limited to the three
    // async-signal-safe libc calls documented above. Errors are ignored by
    // design so hardening cannot change command spawn semantics.
    unsafe {
        command.as_std_mut().pre_exec(|| {
            const PATH: &[u8] = b"/proc/self/oom_score_adj\0";
            const VALUE: &[u8] = b"500";
            let fd = libc::open(PATH.as_ptr().cast(), libc::O_WRONLY | libc::O_CLOEXEC);
            if fd >= 0 {
                let _ = libc::write(fd, VALUE.as_ptr().cast(), VALUE.len());
                let _ = libc::close(fd);
            }
            Ok(())
        });
    }
}
