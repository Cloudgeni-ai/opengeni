//! Paths inside an image's root, resolved as if the root were `/`.
//!
//! Layers are untrusted: an entry may name `etc/passwd` after an earlier
//! layer made `etc` a symlink to `/` or `../../..`. Following that on the
//! build host would write outside the image. Here every component but the
//! last is resolved inside the root, symlinks included, and the last is
//! never followed, which is how a container runtime reads them.

use std::ffi::OsString;
use std::io;
use std::path::{Component, Path, PathBuf};

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
pub fn resolve(root: &Path, parts: &[OsString]) -> io::Result<PathBuf> {
    let Some((last, parents)) = parts.split_last() else {
        return Ok(root.to_owned());
    };
    let mut resolved: Vec<OsString> = Vec::new();
    let mut pending: Vec<OsString> = parents.iter().rev().cloned().collect();
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
    Ok(join(root, &resolved).join(last))
}

fn join(root: &Path, parts: &[OsString]) -> PathBuf {
    let mut path = root.to_owned();
    path.extend(parts);
    path
}

#[cfg(test)]
mod tests {
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
    }
}
