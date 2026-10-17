//! Paths inside an image's root, resolved as if the root were `/`.
//!
//! Layers are untrusted: an entry may name `etc/passwd` after an earlier
//! layer made `etc` a symlink to `/` or `../../..`. Following that on the
//! build host would write outside the image. Here every component but the
//! last is resolved inside the root, symlinks included, and the last is
//! never followed, which is how a container runtime reads them.
//!
//! Whatever changes the image goes through the helpers here, which check
//! that the path stays inside the root and never follow a symlink at its
//! last component, wherever the path came from.

use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io;
use std::os::unix::ffi::OsStrExt as _;
use std::path::{Component, Path, PathBuf};

use rustix::fs::{Mode, OFlags};

/// The most symlinks one resolution follows, as Linux allows.
const MAX_LINKS: usize = 40;

/// The components of a path from a layer, relative to the root. Leading
/// `/` and `.` are dropped; `..` is refused, as no sound layer uses it.
pub fn clean(path: &Path) -> io::Result<Vec<OsString>> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_owned()),
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("{} leaves the image", path.display()),
                ));
            }
        }
    }
    Ok(parts)
}

/// The host path for `parts` inside `root`: every component but the last
/// is resolved inside the root, following symlinks there; the last is
/// not followed. Missing components are kept as named.
///
/// # Errors
///
/// When the last component is not a plain name (empty, `.`, `..` or with
/// a `/`), so the path would not name an entry inside the root, and when
/// a resolution follows too many symlinks.
pub fn resolve(root: &Path, parts: &[OsString]) -> io::Result<PathBuf> {
    let Some((last, parents)) = parts.split_last() else {
        return Ok(root.to_owned());
    };
    if !plain(last) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{} names no entry in the image", last.to_string_lossy()),
        ));
    }
    Ok(join(root, &walk(root, parents)?).join(last))
}

/// The host path for `parts` inside `root` with every component resolved
/// inside the root, the last too: what the image itself would open at
/// that path. The result is the root or a path inside it that is not a
/// symlink (or does not exist).
///
/// # Errors
///
/// When a resolution follows too many symlinks.
pub fn resolve_all(root: &Path, parts: &[OsString]) -> io::Result<PathBuf> {
    Ok(join(root, &walk(root, parts)?))
}

/// Whether `part` is one plain name.
fn plain(part: &OsStr) -> bool {
    !part.is_empty() && part != "." && part != ".." && !part.as_bytes().contains(&b'/')
}

/// `parts` resolved inside `root`, following every symlink there.
fn walk(root: &Path, parts: &[OsString]) -> io::Result<Vec<OsString>> {
    let mut resolved: Vec<OsString> = Vec::new();
    let mut pending: Vec<OsString> = parts.iter().rev().cloned().collect();
    let mut links = 0;
    while let Some(part) = pending.pop() {
        if part == "." || part.is_empty() {
            continue;
        }
        if part == ".." {
            resolved.pop();
            continue;
        }
        let candidate = join(root, &resolved).join(&part);
        match std::fs::symlink_metadata(&candidate) {
            Ok(meta) if meta.file_type().is_symlink() => {
                links += 1;
                if links > MAX_LINKS {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("too many symlinks under {}", candidate.display()),
                    ));
                }
                let target = std::fs::read_link(&candidate)?;
                if target.is_absolute() {
                    resolved.clear();
                }
                for component in target.components().rev() {
                    match component {
                        Component::Normal(part) => pending.push(part.to_owned()),
                        Component::ParentDir => pending.push("..".into()),
                        Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
                    }
                }
            }
            _ => resolved.push(part),
        }
    }
    Ok(resolved)
}

/// Checks that `path` is an entry strictly inside `root`, named by plain
/// components: what every deletion and replacement must hold to, whatever
/// produced the path.
///
/// # Errors
///
/// When it is not.
pub fn confined(root: &Path, path: &Path) -> io::Result<()> {
    let inside = path.strip_prefix(root).ok().filter(|rest| {
        rest.components().next().is_some()
            && rest
                .components()
                .all(|component| matches!(component, Component::Normal(_)))
    });
    if inside.is_some() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{} is not inside the image", path.display()),
        ))
    }
}

/// Removes whatever is at `path` inside `root`, a directory with its
/// contents, never following a symlink there. Returns whether something
/// was there.
///
/// # Errors
///
/// When `path` is not inside `root`, and when removing fails.
pub fn remove(root: &Path, path: &Path) -> io::Result<bool> {
    confined(root, path)?;
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path).map(|()| true),
        Ok(_) => std::fs::remove_file(path).map(|()| true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// Creates a new file at `path` inside `root` with `mode`, replacing
/// whatever was there; never follows a symlink at `path`.
///
/// # Errors
///
/// When `path` is not inside `root`, and when creating fails.
pub fn create(root: &Path, path: &Path, mode: u32) -> io::Result<File> {
    remove(root, path)?;
    let fd = rustix::fs::open(
        path,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        mode_of(mode),
    )?;
    let file = File::from(fd);
    // Past the umask.
    rustix::fs::fchmod(&file, mode_of(mode))?;
    Ok(file)
}

/// Opens the file at `path`, which must not be a symlink, to read, or to
/// append to (creating it with `mode` if missing).
///
/// # Errors
///
/// When it is a symlink, and when opening fails.
pub fn open(path: &Path, append: Option<u32>) -> io::Result<File> {
    let (flags, mode) = match append {
        None => (OFlags::RDONLY, 0),
        Some(mode) => (OFlags::WRONLY | OFlags::APPEND | OFlags::CREATE, mode),
    };
    let fd = rustix::fs::open(
        path,
        flags | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        mode_of(mode),
    )?;
    Ok(File::from(fd))
}

/// Sets the mode, and the modification time if given, of the directory at
/// `path` without following a symlink there. Returns false, changing
/// nothing, when `path` is no longer a directory.
///
/// # Errors
///
/// When setting them fails.
pub fn set_dir(
    path: &Path,
    mode: u32,
    mtime: Option<i64>,
    owner: Option<(u32, u32)>,
) -> io::Result<bool> {
    let dir = match rustix::fs::open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(dir) => dir,
        Err(rustix::io::Errno::LOOP | rustix::io::Errno::NOTDIR | rustix::io::Errno::NOENT) => {
            return Ok(false);
        }
        Err(error) => return Err(error.into()),
    };
    if let Some((uid, gid)) = owner {
        rustix::fs::fchown(
            &dir,
            Some(rustix::fs::Uid::from_raw(uid)),
            Some(rustix::fs::Gid::from_raw(gid)),
        )?;
    }
    rustix::fs::fchmod(&dir, mode_of(mode))?;
    if let Some(mtime) = mtime {
        let time = rustix::fs::Timespec {
            tv_sec: mtime,
            tv_nsec: 0,
        };
        rustix::fs::futimens(
            &dir,
            &rustix::fs::Timestamps {
                last_access: time,
                last_modification: time,
            },
        )?;
    }
    Ok(true)
}

fn join(root: &Path, parts: &[OsString]) -> PathBuf {
    let mut path = root.to_owned();
    path.extend(parts);
    path
}

/// The permission bits of `mode` (narrower than `u32` on some systems).
fn mode_of(mode: u32) -> Mode {
    Mode::from_bits_truncate(rustix::fs::RawMode::try_from(mode & 0o7777).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;
    use std::os::unix::fs::symlink;

    use super::*;

    fn parts(path: &str) -> Vec<OsString> {
        clean(Path::new(path)).unwrap()
    }

    #[test]
    fn cleaning_drops_roots_and_dots_and_refuses_parents() {
        assert_eq!(parts("/a/./b/"), ["a", "b"]);
        assert_eq!(parts("./"), Vec::<OsString>::new());
        assert!(clean(Path::new("a/../b")).is_err());
        assert!(clean(Path::new("../b")).is_err());
    }

    #[test]
    fn symlinks_resolve_inside_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("usr/sbin")).unwrap();
        symlink("usr/sbin", root.join("sbin")).unwrap();
        symlink("/", root.join("up")).unwrap();
        symlink("../../../../..", root.join("usr/escape")).unwrap();
        symlink("/usr/sbin", root.join("usr/abs")).unwrap();
        symlink("loop2", root.join("loop1")).unwrap();
        symlink("loop1", root.join("loop2")).unwrap();
        assert_eq!(
            resolve(root, &parts("sbin/init")).unwrap(),
            root.join("usr/sbin/init")
        );
        assert_eq!(
            resolve(root, &parts("up/etc/passwd")).unwrap(),
            root.join("etc/passwd")
        );
        assert_eq!(
            resolve(root, &parts("usr/escape/etc/x")).unwrap(),
            root.join("etc/x")
        );
        assert_eq!(
            resolve(root, &parts("usr/abs/x")).unwrap(),
            root.join("usr/sbin/x")
        );
        // The last component is never followed.
        assert_eq!(resolve(root, &parts("sbin")).unwrap(), root.join("sbin"));
        assert_eq!(
            resolve(root, &parts("missing/x")).unwrap(),
            root.join("missing/x")
        );
        assert_eq!(resolve(root, &[]).unwrap(), root);
        assert!(resolve(root, &parts("loop1/x")).is_err());
        // A last component that is no plain name is refused.
        for bad in ["..", ".", ""] {
            let mut path = parts("usr");
            path.push(bad.into());
            assert!(resolve(root, &path).is_err(), "{bad:?}");
        }
        // resolve_all follows the last component too, inside the root.
        assert_eq!(resolve_all(root, &parts("up")).unwrap(), root);
        assert_eq!(
            resolve_all(root, &parts("sbin")).unwrap(),
            root.join("usr/sbin")
        );
    }

    #[test]
    fn changes_stay_inside_the_root_and_never_follow_the_last_symlink() {
        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("root");
        std::fs::create_dir_all(root.join("etc")).unwrap();
        let outside = outer.path().join("outside");
        std::fs::write(&outside, "keep").unwrap();
        std::fs::set_permissions(
            &outside,
            std::os::unix::fs::PermissionsExt::from_mode(0o644),
        )
        .unwrap();
        // Removing is refused outside the root, and for the root itself.
        assert!(remove(&root, outer.path()).is_err());
        assert!(remove(&root, &root).is_err());
        assert!(remove(&root, &root.join("etc/..")).is_err());
        assert!(outside.exists());
        // Creating over a symlink replaces the link, not its target.
        symlink(&outside, root.join("etc/passwd")).unwrap();
        create(&root, &root.join("etc/passwd"), 0o600)
            .unwrap()
            .write_all(b"mine")
            .unwrap();
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep");
        assert_eq!(
            std::fs::read_to_string(root.join("etc/passwd")).unwrap(),
            "mine"
        );
        // Opening refuses a symlink.
        symlink(&outside, root.join("etc/group")).unwrap();
        assert!(open(&root.join("etc/group"), None).is_err());
        assert!(open(&root.join("etc/group"), Some(0o644)).is_err());
        // A directory replaced by a symlink is left alone.
        symlink(&outside, root.join("tmp")).unwrap();
        assert!(!set_dir(&root.join("tmp"), 0o700, Some(0), None).unwrap());
        let mode = std::fs::metadata(&outside).unwrap().permissions();
        assert_eq!(
            std::os::unix::fs::PermissionsExt::mode(&mode) & 0o777,
            0o644
        );
        std::fs::create_dir(root.join("dir")).unwrap();
        assert!(set_dir(&root.join("dir"), 0o700, Some(0), None).unwrap());
    }
}
