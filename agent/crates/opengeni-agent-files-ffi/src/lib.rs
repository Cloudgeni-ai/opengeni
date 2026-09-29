//! Safe native filesystem metadata inspection, independent of desktop/TCC code.
//! The only unsafe code is the descriptor-based Apple ACL wrapper in `macos`.

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::has_extended_acl;
