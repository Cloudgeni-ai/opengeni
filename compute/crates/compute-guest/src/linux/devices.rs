//! The device nodes programs expect in `/dev`, kept there.
//!
//! The kernel makes them when it mounts `devtmpfs`, but a command running
//! as root can remove one (`rm -f /dev/urandom`) and nothing made it again:
//! every program that opened it failed from then on. PID 1 puts back a
//! missing or replaced node, with the kernel's device numbers and modes,
//! before it starts the agent or envd and every few seconds otherwise (a
//! few `lstat`s). The rules are the agent's own for `/dev/null`
//! (`agent/crates/opengeni-agent-platform/src/null_device.rs`), for every
//! core node: a directory at the path is never removed, anything else in
//! the way is, and the new node's mode is set through a handle that is
//! checked to be that node.

use std::fs::{self, OpenOptions, Permissions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt, symlink};
use std::path::Path;

use super::{log, sys};

/// What belongs at one name in `/dev`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Node {
    /// A character device, with its numbers and mode.
    Char { major: u32, minor: u32, mode: u32 },
    /// A symbolic link to this target.
    Link(&'static str),
}

/// The nodes kept, by name under `/dev`: the memory devices every Linux
/// has (`devices.txt`), the controlling terminal, and the links the guest
/// makes at boot. `ptmx` points into the guest's own devpts instance.
pub const CORE: &[(&str, Node)] = &[
    ("null", char_node(1, 3)),
    ("zero", char_node(1, 5)),
    ("full", char_node(1, 7)),
    ("random", char_node(1, 8)),
    ("urandom", char_node(1, 9)),
    ("tty", char_node(5, 0)),
    ("ptmx", Node::Link("pts/ptmx")),
    ("fd", Node::Link("/proc/self/fd")),
    ("stdin", Node::Link("/proc/self/fd/0")),
    ("stdout", Node::Link("/proc/self/fd/1")),
    ("stderr", Node::Link("/proc/self/fd/2")),
];

const fn char_node(major: u32, minor: u32) -> Node {
    Node::Char {
        major,
        minor,
        mode: 0o666,
    }
}

/// What a path holds, compared with the node that belongs there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// The node itself.
    Healthy,
    /// The device, with another mode.
    WrongMode,
    /// Nothing, or a symbolic link to nothing.
    Missing,
    /// Something else, which may be removed.
    Replaced,
    /// A directory, which is never removed: it may hold someone's files.
    Directory,
}

/// Reads what `path` holds. One that cannot be read for another reason
/// counts as healthy: only what is seen to be wrong is repaired.
#[must_use]
pub fn inspect(path: &Path, node: Node) -> State {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return State::Missing,
        Err(_) => return State::Healthy,
    };
    if meta.is_dir() {
        return State::Directory;
    }
    match node {
        Node::Link(target) => match fs::read_link(path) {
            Ok(found) if found == Path::new(target) => State::Healthy,
            _ => State::Replaced,
        },
        Node::Char { major, minor, mode } => {
            if meta.file_type().is_symlink() && fs::metadata(path).is_err() {
                State::Missing
            } else if !meta.file_type().is_char_device()
                || sys::device_numbers(meta.rdev()) != (major, minor)
            {
                State::Replaced
            } else if meta.mode() & 0o7777 != mode {
                State::WrongMode
            } else {
                State::Healthy
            }
        }
    }
}

/// Puts `node` back at `path`, which holds `state`.
pub fn repair(path: &Path, node: Node, state: State) -> io::Result<()> {
    match state {
        State::Healthy => return Ok(()),
        State::Directory => {
            return Err(io::Error::other("a directory is in its place"));
        }
        State::WrongMode => return set_mode(path, node),
        State::Missing | State::Replaced => {}
    }
    // Whatever is at the path itself: a dangling symbolic link reads as
    // missing, yet is in the way.
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    match node {
        Node::Link(target) => symlink(target, path),
        Node::Char { major, minor, .. } => {
            let name = path
                .to_str()
                .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
            sys::make_char_device(name, 0o600, major, minor)?;
            // mknod applies the umask; the mode is set afterwards, through
            // the node just made.
            set_mode(path, node)
        }
    }
}

/// Sets the mode of the device `node` at `path`, through a handle opened
/// without following a symbolic link (and without opening the device), only
/// once that handle is seen to be the device.
fn set_mode(path: &Path, node: Node) -> io::Result<()> {
    let Node::Char { major, minor, mode } = node else {
        return Ok(());
    };
    let handle = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH | libc::O_NOFOLLOW)
        .open(path)?;
    let meta = handle.metadata()?;
    if !meta.file_type().is_char_device() || sys::device_numbers(meta.rdev()) != (major, minor) {
        return Err(io::Error::other("another file took its place"));
    }
    fs::set_permissions(
        format!("/proc/self/fd/{}", handle.as_raw_fd()),
        Permissions::from_mode(mode),
    )
}

/// Puts back every core node under `dev` that is missing, replaced or has
/// another mode, and returns the names it put back. One it cannot put back
/// is logged and left.
pub fn keep_in(dev: &Path) -> Vec<&'static str> {
    let mut repaired = Vec::new();
    for &(name, node) in CORE {
        let path = dev.join(name);
        let state = inspect(&path, node);
        if state == State::Healthy {
            continue;
        }
        match repair(&path, node, state) {
            Ok(()) => repaired.push(name),
            Err(error) => log(&format!("{} ({state:?}): {error}", path.display())),
        }
    }
    repaired
}

/// Puts back what is missing in the guest's `/dev`, and says so.
pub fn keep() {
    let repaired = keep_in(Path::new("/dev"));
    if !repaired.is_empty() {
        log(&format!(
            "put back in /dev what was missing or replaced: {}",
            repaired.join(", ")
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("compute-guest-dev-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn inspect_tells_a_node_from_what_took_its_place() {
        let dir = scratch("inspect");
        assert_eq!(
            inspect(Path::new("/dev/null"), char_node(1, 3)),
            State::Healthy
        );
        // The right device under another number is not it.
        assert_eq!(
            inspect(Path::new("/dev/null"), char_node(1, 5)),
            State::Replaced
        );
        assert_eq!(inspect(&dir.join("none"), char_node(1, 9)), State::Missing);
        fs::write(dir.join("file"), "what `> /dev/urandom` leaves").unwrap();
        assert_eq!(inspect(&dir.join("file"), char_node(1, 9)), State::Replaced);
        assert_eq!(inspect(&dir, char_node(1, 9)), State::Directory);
        symlink(dir.join("nowhere"), dir.join("dangling")).unwrap();
        assert_eq!(
            inspect(&dir.join("dangling"), char_node(1, 9)),
            State::Missing
        );
        symlink("pts/ptmx", dir.join("ptmx")).unwrap();
        assert_eq!(
            inspect(&dir.join("ptmx"), Node::Link("pts/ptmx")),
            State::Healthy
        );
        assert_eq!(
            inspect(&dir.join("ptmx"), Node::Link("/proc/self/fd")),
            State::Replaced
        );
        assert_eq!(
            inspect(&dir.join("file"), Node::Link("pts/ptmx")),
            State::Replaced
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn links_are_put_back_and_a_directory_is_never_removed() {
        let dir = scratch("links");
        fs::write(dir.join("stdout"), "redirected").unwrap();
        symlink("/elsewhere", dir.join("fd")).unwrap();
        fs::create_dir(dir.join("stderr")).unwrap();
        fs::write(dir.join("stderr/kept"), "someone's file").unwrap();
        keep_in(&dir);
        for (name, target) in [
            ("ptmx", "pts/ptmx"),
            ("fd", "/proc/self/fd"),
            ("stdin", "/proc/self/fd/0"),
            ("stdout", "/proc/self/fd/1"),
        ] {
            assert_eq!(
                fs::read_link(dir.join(name)).unwrap(),
                Path::new(target),
                "{name}"
            );
        }
        assert!(dir.join("stderr/kept").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    /// `mknod` needs root: skipped, and says so, otherwise.
    #[test]
    fn removed_or_replaced_devices_are_made_again_with_their_numbers_and_modes() {
        if !sys::is_root() {
            eprintln!("skipping: mknod needs root");
            return;
        }
        let dir = scratch("devices");
        // What the repro left: urandom, random, zero, tty and full removed.
        // What else happens: a redirection's file, a dangling link, a node
        // made with the wrong mode, and a directory in a device's place.
        fs::write(dir.join("null"), "what `> /dev/null` leaves").unwrap();
        symlink(dir.join("nowhere"), dir.join("zero")).unwrap();
        sys::make_char_device(dir.join("random").to_str().unwrap(), 0o600, 1, 8).unwrap();
        fs::set_permissions(dir.join("random"), Permissions::from_mode(0o600)).unwrap();
        fs::create_dir(dir.join("full")).unwrap();
        let repaired = keep_in(&dir);
        for (name, numbers) in [
            ("null", (1, 3)),
            ("zero", (1, 5)),
            ("random", (1, 8)),
            ("urandom", (1, 9)),
            ("tty", (5, 0)),
        ] {
            let meta = fs::symlink_metadata(dir.join(name)).unwrap();
            assert!(meta.file_type().is_char_device(), "{name}");
            assert_eq!(sys::device_numbers(meta.rdev()), numbers, "{name}");
            assert_eq!(meta.mode() & 0o7777, 0o666, "{name}");
            assert!(repaired.contains(&name), "{name}: {repaired:?}");
        }
        // A device made here works: it reads zeros.
        let mut bytes = [1_u8; 8];
        io::Read::read_exact(&mut fs::File::open(dir.join("zero")).unwrap(), &mut bytes).unwrap();
        assert_eq!(bytes, [0; 8]);
        assert!(dir.join("full").is_dir());
        assert!(!repaired.contains(&"full"));
        // Nothing left to do.
        assert_eq!(keep_in(&dir), Vec::<&str>::new());
        let _ = fs::remove_dir_all(&dir);
    }
}
