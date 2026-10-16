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
use std::path::Path;

use tokio::net::UnixStream;

fn refused(path: &Path, what: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("{} in a VM's jail is {what}", path.display()),
    )
}

/// What the host hands a VMM in its jail.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owned {
    /// A regular file, such as a writable drive.
    File,
    /// A Unix socket the VMM connects to.
    Socket,
}

impl Owned {
    fn refusal(self) -> &'static str {
        match self {
            Self::File => "not a regular file",
            Self::Socket => "not a socket",
        }
    }
}

/// Whether an entry owned by `owner` with permission bits `mode` may be
/// given to `uid`: it must be the VMM's already, or the host's and not
/// sealed. The host seals what it shares between VMs (memory images,
/// templates) by making it read-only, and those must never change hands,
/// even when no other name of one is left at the moment.
fn may_hand_over(owner: u32, mode: u32, uid: u32, host: u32) -> Result<(), &'static str> {
    if owner == uid {
        Ok(())
    } else if owner != host {
        Err("owned by someone else")
    } else if mode & 0o200 == 0 {
        Err("a file the host sealed")
    } else {
        Ok(())
    }
}

/// Gives the entry at `path` to `uid`/`gid`, if it is of the `kind` asked
/// for, has no other name, and is the VMM's already or an unsealed one of
/// the host's.
///
/// The entry is pinned by a descriptor opened without following a link, its
/// type and owner are read through that descriptor and its owner changed
/// through it, so swapping the entry for something else after the check
/// changes only the pinned one. A file with another name is refused: it
/// may be a hard link to a host file the jail can see. So is a file the
/// host sealed, such as a memory image linked into the jail and renamed
/// over the drive, which may have no other name left for a moment.
///
/// # Errors
///
/// The entry is missing, of another kind, has other names, is sealed or
/// someone else's, or cannot be changed.
#[cfg(target_os = "linux")]
pub fn hand_over(path: &Path, kind: Owned, uid: u32, gid: u32) -> io::Result<()> {
    use rustix::fs::{AtFlags, FileType, Gid, Mode, OFlags, Uid};

    let fd = rustix::fs::open(
        path,
        OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let stat = rustix::fs::fstat(&fd)?;
    let expected = match kind {
        Owned::File => FileType::RegularFile,
        Owned::Socket => FileType::Socket,
    };
    if FileType::from_raw_mode(stat.st_mode) != expected {
        return Err(refused(path, kind.refusal()));
    }
    if stat.st_nlink != 1 {
        return Err(refused(path, "a file with other names"));
    }
    may_hand_over(
        stat.st_uid,
        stat.st_mode,
        uid,
        rustix::process::geteuid().as_raw(),
    )
    .map_err(|what| refused(path, what))?;
    rustix::fs::chownat(
        &fd,
        "",
        Some(Uid::from_raw(uid)),
        Some(Gid::from_raw(gid)),
        AtFlags::EMPTY_PATH,
    )?;
    Ok(())
}

/// Gives the entry at `path` to `uid`/`gid`, if it is of the `kind` asked
/// for. Jails exist only on Linux; this checks the type and never follows
/// a link.
///
/// # Errors
///
/// The entry is missing, of another kind, or cannot be changed.
#[cfg(not(target_os = "linux"))]
pub fn hand_over(path: &Path, kind: Owned, uid: u32, gid: u32) -> io::Result<()> {
    use std::os::unix::fs::FileTypeExt;

    use std::os::unix::fs::MetadataExt;

    let metadata = fs::symlink_metadata(path)?;
    let found = metadata.file_type();
    let matches = match kind {
        Owned::File => found.is_file(),
        Owned::Socket => found.is_socket(),
    };
    if !matches {
        return Err(refused(path, kind.refusal()));
    }
    let host = rustix::process::geteuid().as_raw();
    may_hand_over(metadata.uid(), metadata.mode(), uid, host)
        .map_err(|what| refused(path, what))?;
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
        assert!(
            hand_over(&planted, Owned::File, 1, 1).is_err(),
            "handed over a link"
        );
        assert!(check_written(&planted).is_err(), "trusted a link");
        check_written(&file).unwrap();
        let second = dir.path().join("second");
        fs::hard_link(&file, &second).unwrap();
        assert!(check_written(&file).is_err(), "trusted a hard link");
    }

    /// A VMM owns its jail and can replace its drive with a hard link to a
    /// host file the jail can see, or with something of another kind; the
    /// host must then change no owner at all.
    #[tokio::test]
    async fn only_entries_of_their_own_of_the_kind_asked_for_are_handed_over() {
        let dir = tempfile::tempdir().unwrap();
        let (uid, gid) = (
            rustix::process::getuid().as_raw(),
            rustix::process::getgid().as_raw(),
        );
        let disk = dir.path().join("disk.ext4");
        fs::write(&disk, b"disk").unwrap();
        hand_over(&disk, Owned::File, uid, gid).unwrap();
        assert!(hand_over(&disk, Owned::Socket, uid, gid).is_err());

        // The drive renamed away and a hard link to the host's file put in
        // its place.
        let host = dir.path().join("vmlinux");
        fs::write(&host, b"host kernel").unwrap();
        fs::rename(&disk, dir.path().join("moved")).unwrap();
        fs::hard_link(&host, &disk).unwrap();
        assert!(
            hand_over(&disk, Owned::File, uid, gid).is_err(),
            "handed over a second name of a host file"
        );

        let socket = dir.path().join("vsock.sock_53");
        let _listener = tokio::net::UnixListener::bind(&socket).unwrap();
        hand_over(&socket, Owned::Socket, uid, gid).unwrap();
        assert!(hand_over(&socket, Owned::File, uid, gid).is_err());
        let doubled = dir.path().join("second.sock");
        fs::hard_link(&socket, &doubled).unwrap();
        assert!(hand_over(&socket, Owned::Socket, uid, gid).is_err());
    }

    /// A memory image the host shares is sealed read-only and linked into
    /// each jail that maps it. Renamed over the drive when no other name of
    /// it is left, it must still never change hands.
    #[test]
    fn a_sealed_host_file_with_no_other_name_is_not_handed_over() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let host = rustix::process::geteuid().as_raw();
        let (vmm, gid) = (host.wrapping_add(1), rustix::process::getgid().as_raw());
        let image = dir.path().join("disk.ext4");
        fs::write(&image, b"shared memory").unwrap();
        fs::set_permissions(&image, fs::Permissions::from_mode(0o444)).unwrap();
        let refusal = hand_over(&image, Owned::File, vmm, gid).unwrap_err();
        assert!(refusal.to_string().contains("sealed"), "{refusal}");

        assert_eq!(
            may_hand_over(vmm, 0o444, vmm, host),
            Ok(()),
            "the VMM's own"
        );
        assert_eq!(may_hand_over(host, 0o644, vmm, host), Ok(()), "a new drive");
        assert!(may_hand_over(host, 0o444, vmm, host).is_err(), "sealed");
        assert!(
            may_hand_over(vmm.wrapping_add(1), 0o644, vmm, host).is_err(),
            "another VMM's"
        );
    }
}
