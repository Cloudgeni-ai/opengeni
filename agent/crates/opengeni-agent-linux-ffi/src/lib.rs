//! Linux process hardening behind one small, audited unsafe boundary.
//!
//! Rust requires [`std::os::unix::process::CommandExt::pre_exec`] to be called
//! from `unsafe` because the closure runs after `fork` in a potentially
//! multi-threaded process. The agent workspace otherwise forbids unsafe code, so
//! the raw async-signal-safe operations live only in this leaf crate.

#[cfg(target_os = "linux")]
#[allow(unsafe_code)]
mod ffi;

/// Configures `command` to raise its own Linux OOM victim bias after `fork` but
/// before user code can run or create descendants.
///
/// The hook is deliberately best-effort. A restrictive kernel policy must not
/// turn an otherwise valid command into a spawn failure; the parent performs a
/// second observable write after spawn and reports failure there.
#[cfg(target_os = "linux")]
pub fn configure_oom_score_adj_before_exec(command: &mut tokio::process::Command) {
    ffi::configure_oom_score_adj_before_exec(command);
}

/// Non-Linux stub so whole-workspace cross-platform checks retain one API.
#[cfg(not(target_os = "linux"))]
pub fn configure_oom_score_adj_before_exec(_command: &mut tokio::process::Command) {}
