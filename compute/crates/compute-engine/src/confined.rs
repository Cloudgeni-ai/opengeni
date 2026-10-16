//! Touching files inside a VM's jail without trusting them.
//!
//! A jailed VMM owns its jail, so a compromised one can replace any file in
//! it with a symbolic link to a host path, or a hard link to a host file of
//! its own. The host runs as root and must never act on such a link: it
//! changes owners only of the entry itself after checking its type, and
//! connects to the VMM's sockets through a descriptor opened without
//! following links.

use std::fs;
use std::io;
use std::os::unix::fs::FileTypeExt;
use std::path::Path;

use tokio::net::UnixStream;

fn refused(path: &Path, what: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("{} in a VM's jail is {what}", path.display()),
    )
}

/// Gives the regular file or socket at `path` to `uid`/`gid`, refusing
/// anything else (such as a symbolic link) and never following a link.
///
/// # Errors
///
/// The entry is missing, of another type, or cannot be changed.
pub fn hand_over(path: &Path, uid: u32, gid: u32) -> io::Result<()> {
    let kind = fs::symlink_metadata(path)?.file_type();
    if !(kind.is_file() || kind.is_socket()) {
        return Err(refused(path, "not a regular file or socket"));
    }
    // Should the entry be swapped for a link after the check, `lchown`
    // changes only the link.
    std::os::unix::fs::lchown(path, Some(uid), Some(gid))
}

/// Checks that `path` is a regular file with no other name, as a file a VMM
/// wrote must be before the host reads it: not a link to a host file.
///
/// # Errors
///
/// The entry is missing or is anything else.
pub fn check_written(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        return Err(refused(path, "not a regular file"));
    }
    if metadata.nlink() != 1 {
        return Err(refused(path, "a file with other names"));
    }
    Ok(())
}

/// Connects to the Unix socket at `path`, refusing to follow a symbolic
/// link there: the path is resolved once, without following its last
/// component, and the connection goes through that resolution.
///
/// # Errors
///
/// `path` is not a socket, or connecting fails.
#[cfg(target_os = "linux")]
pub async fn connect(path: &Path) -> io::Result<UnixStream> {
    use std::os::fd::AsRawFd;

    use rustix::fs::{FileType, Mode, OFlags};

    let fd = rustix::fs::open(
        path,
        OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    if FileType::from_raw_mode(rustix::fs::fstat(&fd)?.st_mode) != FileType::Socket {
        return Err(refused(path, "not a socket"));
    }
    // The descriptor stays open until the connection is made.
    UnixStream::connect(format!("/proc/self/fd/{}", fd.as_raw_fd())).await
}

/// Connects to the Unix socket at `path`. Jails exist only on Linux.
///
/// # Errors
///
/// Connecting fails.
#[cfg(not(target_os = "linux"))]
pub async fn connect(path: &Path) -> io::Result<UnixStream> {
    UnixStream::connect(path).await
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn links_are_never_followed() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("real.sock");
        let _listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let link = dir.path().join("vsock.sock");
        std::os::unix::fs::symlink(&socket, &link).unwrap();
        assert!(connect(&socket).await.is_ok());
        assert!(connect(&link).await.is_err(), "connected through a link");

        let file = dir.path().join("disk.ext4");
        fs::write(&file, b"disk").unwrap();
        let planted = dir.path().join("planted");
        std::os::unix::fs::symlink(&file, &planted).unwrap();
        assert!(hand_over(&planted, 1, 1).is_err(), "handed over a link");
        assert!(check_written(&planted).is_err(), "trusted a link");
        check_written(&file).unwrap();
        let second = dir.path().join("second");
        fs::hard_link(&file, &second).unwrap();
        assert!(check_written(&file).is_err(), "trusted a hard link");
    }
}
