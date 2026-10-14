//! Taking ownership of a descriptor a predecessor process image left open.
//!
//! An in-place agent update `exec`s the new binary in the same process. Pipe
//! ends of still-running commands survive that `exec` as plain descriptor
//! numbers recorded in the handover manifest. Turning a number back into an
//! [`OwnedFd`] is the one unsafe step, kept here.

use std::os::fd::{FromRawFd as _, OwnedFd, RawFd};

/// Claims descriptor `fd`, which this process inherited across `exec`, and
/// marks it close-on-exec again so commands spawned later cannot inherit it.
///
/// The caller must be the only owner of `fd`: it must come from this
/// process's own handover manifest, be claimed at most once, and not be used
/// by anything else in the process.
///
/// # Errors
///
/// `fd` is negative, not open, or its descriptor flags cannot be updated.
pub fn claim_inherited_fd(fd: RawFd) -> std::io::Result<OwnedFd> {
    if fd < 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "inherited descriptor number is negative",
        ));
    }
    // SAFETY: F_GETFD/F_SETFD only read and set the descriptor flags of `fd`.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: as above.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: `fd` is open (checked above) and the caller guarantees it has no
    // other owner in this process image.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

#[cfg(test)]
mod tests {
    use std::io::{Read as _, Write as _};
    use std::os::fd::IntoRawFd as _;

    use super::*;

    #[test]
    fn a_claimed_descriptor_is_owned_and_close_on_exec() {
        let (mut reader, writer) = std::io::pipe().unwrap();
        let raw = OwnedFd::from(writer).into_raw_fd();
        let owned = claim_inherited_fd(raw).unwrap();
        // SAFETY: test-only flag read on a descriptor this test owns.
        let flags = unsafe { libc::fcntl(raw, libc::F_GETFD) };
        assert_eq!(flags & libc::FD_CLOEXEC, libc::FD_CLOEXEC);
        let mut writer = std::fs::File::from(owned);
        writer.write_all(b"ok").unwrap();
        drop(writer);
        let mut text = String::new();
        reader.read_to_string(&mut text).unwrap();
        assert_eq!(text, "ok");
    }

    #[test]
    fn a_closed_descriptor_is_refused() {
        let (reader, writer) = std::io::pipe().unwrap();
        let raw = OwnedFd::from(writer).into_raw_fd();
        drop(claim_inherited_fd(raw).unwrap());
        assert!(claim_inherited_fd(raw).is_err());
        assert!(claim_inherited_fd(-1).is_err());
        drop(reader);
    }
}
