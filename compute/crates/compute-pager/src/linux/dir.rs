//! The directories a pager names files in once it is no longer root.
//!
//! A host keeps its state where only root may enter (its state directory
//! is `0700`), so a pager that has dropped to its VM's user can no longer
//! resolve a path from `/` to anything of the VM's. It opens each
//! directory it will name files in while it is still root, and from then
//! on names files only within those: the directory's own permissions still
//! apply, those of the directories above it no longer do. Nothing is
//! followed through a link, so a VM that owns a directory cannot send the
//! pager elsewhere through it.
//!
//! Nor does the pager write into, or wait on, anything already in a
//! directory under a name it creates: whatever is there, a FIFO that
//! would block it until someone reads, or a second name for another file
//! that writing would change, is replaced or refused. A pager that serves
//! a VM's faults must never stop for its own files. What this cannot
//! guarantee is the files' integrity against a writer of the directory:
//! that rests on the directory being reachable only by root and the
//! pager, outside the VM's jail.

use std::ffi::{OsStr, OsString};
use std::fmt;
use std::io::{self, Write};
use std::os::fd::{AsFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use nix::fcntl::{AtFlags, OFlag, open, openat, renameat};
use nix::sys::stat::{Mode, SFlag, fstatat};
use nix::unistd::{UnlinkatFlags, unlinkat};

/// A directory opened while the pager could still reach it by path.
#[derive(Clone)]
pub struct Dir {
    fd: Arc<OwnedFd>,
    path: PathBuf,
}

impl fmt::Debug for Dir {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("Dir").field(&self.path).finish()
    }
}

impl Dir {
    /// The directory `file` is in, opened, and `file`'s own name in it.
    pub fn of(file: &Path) -> io::Result<(Self, OsString)> {
        let (Some(parent), Some(name)) = (file.parent(), file.file_name()) else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{} names no file in a directory", file.display()),
            ));
        };
        let parent = if parent.as_os_str().is_empty() {
            Path::new(".")
        } else {
            parent
        };
        let fd = open(
            parent,
            OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
            Mode::empty(),
        )?;
        Ok((
            Self {
                fd: Arc::new(fd),
                path: parent.to_owned(),
            },
            name.to_owned(),
        ))
    }

    /// `name` in this directory, for messages.
    pub fn display(&self, name: &OsStr) -> String {
        self.path.join(name).display().to_string()
    }

    /// Opens `name` with `flags`, never through a link.
    pub fn open(&self, name: &OsStr, flags: OFlag, mode: Mode) -> io::Result<OwnedFd> {
        Ok(openat(
            self.fd.as_fd(),
            name,
            flags | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            mode,
        )?)
    }

    /// The device and inode of `name` itself, a link's own if it is one.
    pub fn identity(&self, name: &OsStr) -> io::Result<(u64, u64)> {
        let stat = fstatat(self.fd.as_fd(), name, AtFlags::AT_SYMLINK_NOFOLLOW)?;
        Ok((stat.st_dev, stat.st_ino))
    }

    /// Removes `name`, which is not a directory.
    pub fn remove(&self, name: &OsStr) -> io::Result<()> {
        Ok(unlinkat(self.fd.as_fd(), name, UnlinkatFlags::NoRemoveDir)?)
    }

    /// Creates `name` empty if it is not there, opening nothing that is:
    /// an ordinary file there already is the same, anything else is an
    /// error.
    pub fn touch(&self, name: &OsStr) -> io::Result<()> {
        match self.open(
            name,
            OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL,
            Mode::from_bits_truncate(0o644),
        ) {
            Ok(_) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let stat = fstatat(self.fd.as_fd(), name, AtFlags::AT_SYMLINK_NOFOLLOW)?;
                if SFlag::from_bits_truncate(stat.st_mode) & SFlag::S_IFMT == SFlag::S_IFREG {
                    Ok(())
                } else {
                    Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        format!("{} is there but not an ordinary file", self.display(name)),
                    ))
                }
            }
            Err(error) => Err(error),
        }
    }

    /// Replaces `name` with `bytes` all at once, through a staging file
    /// beside it that the pager makes new: whatever an earlier write left
    /// under the staging name is removed first, never opened.
    pub fn write_atomic(&self, name: &OsStr, bytes: &[u8]) -> io::Result<()> {
        let mut staging = name.to_owned();
        staging.push(".pager-tmp");
        match self.remove(&staging) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        let fd = self.open(
            &staging,
            OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL,
            Mode::from_bits_truncate(0o644),
        )?;
        std::fs::File::from(fd).write_all(bytes)?;
        Ok(renameat(
            self.fd.as_fd(),
            staging.as_os_str(),
            self.fd.as_fd(),
            name,
        )?)
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[test]
    fn files_are_named_within_the_directory_opened() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("pager");
        std::fs::create_dir(&dir).unwrap();
        let (opened, name) = Dir::of(&dir.join("learned.json")).unwrap();
        assert_eq!(name, "learned.json");
        opened.write_atomic(&name, b"first").unwrap();
        opened.write_atomic(&name, b"second").unwrap();
        assert_eq!(std::fs::read(dir.join("learned.json")).unwrap(), b"second");
        assert!(!dir.join("learned.json.pager-tmp").exists());
        opened.touch(OsStr::new("sock.done")).unwrap();
        let identity = opened.identity(OsStr::new("sock.done")).unwrap();
        assert!(identity.1 != 0);
        opened.remove(OsStr::new("sock.done")).unwrap();
        assert!(!dir.join("sock.done").exists());
    }

    #[test]
    fn links_in_it_are_not_followed() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("elsewhere");
        std::fs::write(&target, b"kept").unwrap();
        std::os::unix::fs::symlink(&target, root.path().join("learned.json")).unwrap();
        let (opened, name) = Dir::of(&root.path().join("learned.json")).unwrap();
        assert!(opened.open(&name, OFlag::O_RDONLY, Mode::empty()).is_err());
        assert!(opened.touch(&name).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"kept");
    }

    /// Runs `work` on a thread of its own and fails, rather than hangs,
    /// if it has not returned within seconds.
    fn without_waiting<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
        let (done, answer) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(work());
        });
        answer
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("it waited on a file left in its directory")
    }

    /// Whatever is left under a name the pager creates is never opened: a
    /// FIFO there would block it until something reads, and a second name
    /// for another file would have it change that file.
    #[test]
    fn what_is_left_under_its_names_is_replaced_or_refused_never_opened() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().to_owned();
        nix::unistd::mkfifo(&dir.join("learned.json.pager-tmp"), Mode::S_IRWXU).unwrap();
        nix::unistd::mkfifo(&dir.join("sock.done"), Mode::S_IRWXU).unwrap();
        let (opened, name) = Dir::of(&dir.join("learned.json")).unwrap();
        let (writer, staged) = (opened.clone(), name.clone());
        without_waiting(move || writer.write_atomic(&staged, b"learned")).unwrap();
        assert_eq!(std::fs::read(dir.join("learned.json")).unwrap(), b"learned");
        let marker = opened.clone();
        let touched = without_waiting(move || marker.touch(OsStr::new("sock.done")));
        assert!(touched.is_err(), "a FIFO is not the marker");

        // A second name for another file under the staging name.
        let other = dir.join("other");
        std::fs::write(&other, b"kept").unwrap();
        std::fs::hard_link(&other, dir.join("learned.json.pager-tmp")).unwrap();
        opened.write_atomic(&name, b"again").unwrap();
        assert_eq!(std::fs::read(&other).unwrap(), b"kept");
        assert_eq!(std::fs::read(dir.join("learned.json")).unwrap(), b"again");

        // An ordinary file already there is the marker.
        std::fs::remove_file(dir.join("sock.done")).unwrap();
        std::fs::write(dir.join("sock.done"), b"").unwrap();
        opened.touch(OsStr::new("sock.done")).unwrap();
        opened.touch(OsStr::new("sock.done")).unwrap();
    }

    /// A directory above the one opened that its user may no longer enter
    /// does not matter: what the pager's user cannot do by path it still
    /// does within the directory. Shown here with the opened directory
    /// moved where its old path no longer reaches.
    #[test]
    fn the_path_to_the_directory_is_not_walked_again() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("pager");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (opened, name) = Dir::of(&dir.join("learned.json")).unwrap();
        let moved = root.path().join("moved");
        std::fs::rename(&dir, &moved).unwrap();
        opened.write_atomic(&name, b"here").unwrap();
        assert_eq!(std::fs::read(moved.join("learned.json")).unwrap(), b"here");
    }
}
