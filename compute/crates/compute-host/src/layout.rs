//! Where each sandbox's state lives on the host's disk, and the small
//! crash-safe writes that keep it consistent.
//!
//! ```text
//! <root>/sandboxes/<id>/
//!   sandbox.json   shape and sleep ladder
//!   disk.ext4      the sandbox's root disk
//!   vm.state       saved processor and device state
//!   vm.mem         saved memory image (sparse)
//!   saved          marker: the memory image is complete and matches the disk
//!   archived       marker: the store holds a copy matching the local files
//!   run/           VMM sockets and logs
//! ```
//!
//! A memory image is only valid together with the exact disk it was taken
//! with. Once a restored guest runs, its disk moves on and the old image
//! would corrupt it, so the `saved` marker is removed before the guest runs
//! and written only after a new image is complete and on disk.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use compute_engine::{Drive, SnapshotFiles, VmSpec};

use crate::protocol::{Id, SandboxConfig};

/// Every path belonging to one sandbox.
#[derive(Clone, Debug)]
pub(crate) struct Paths {
    pub dir: PathBuf,
    pub record: PathBuf,
    pub disk: PathBuf,
    pub snapshot: SnapshotFiles,
    pub saved: PathBuf,
    pub archived: PathBuf,
    pub run: PathBuf,
}

impl Paths {
    pub fn new(root: &Path, id: Id) -> Self {
        let dir = sandboxes_dir(root).join(id.to_string());
        Self {
            record: dir.join("sandbox.json"),
            disk: dir.join("disk.ext4"),
            snapshot: SnapshotFiles {
                state: dir.join("vm.state"),
                memory: dir.join("vm.mem"),
            },
            saved: dir.join("saved"),
            archived: dir.join("archived"),
            run: dir.join("run"),
            dir,
        }
    }
}

pub(crate) fn sandboxes_dir(root: &Path) -> PathBuf {
    root.join("sandboxes")
}

/// What the host needs to start a sandbox's VM, besides its own paths.
#[derive(Clone, Debug)]
pub(crate) struct Images {
    pub kernel: PathBuf,
    pub boot_args: String,
}

/// The VM description for one sandbox.
pub(crate) fn vm_spec(id: Id, config: &SandboxConfig, paths: &Paths, images: &Images) -> VmSpec {
    VmSpec {
        name: format!("sbx-{id}"),
        dir: paths.run.clone(),
        vcpus: config.vcpus,
        memory_mib: config.memory_mib,
        kernel: images.kernel.clone(),
        boot_args: images.boot_args.clone(),
        drives: vec![Drive {
            id: "rootfs".into(),
            path: paths.disk.clone(),
            root: true,
            read_only: false,
        }],
        network: None,
        free_page_reporting: true,
    }
}

/// Writes `contents` to `path` so that after a crash the file either holds
/// all of it or does not exist.
pub(crate) fn write_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    let staging = path.with_extension("staging");
    {
        let mut file = File::create(&staging)?;
        file.write_all(contents)?;
        file.sync_all()?;
    }
    fs::rename(&staging, path)?;
    sync_parent(path)
}

/// Removes `path` durably; succeeds if it does not exist.
pub(crate) fn remove_durably(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => sync_parent(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Removes `path`; succeeds if it does not exist.
pub(crate) fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Flushes a written file's data to disk.
pub(crate) fn sync_file(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

fn sync_parent(path: &Path) -> io::Result<()> {
    match path.parent() {
        Some(parent) => File::open(parent)?.sync_all(),
        None => Ok(()),
    }
}

/// Copies `from` to `to` as cheaply as the filesystem allows: a shared-extent
/// clone where supported (XFS, btrfs), otherwise only the data regions, so
/// holes stay holes and a mostly empty 2 GiB image costs only its data.
pub(crate) fn copy_sparse(from: &Path, to: &Path) -> io::Result<()> {
    let source = File::open(from)?;
    let target = File::create(to)?;
    copy_contents(&source, &target)?;
    target.sync_all()
}

#[cfg(target_os = "linux")]
fn copy_contents(source: &File, target: &File) -> io::Result<()> {
    use rustix::fs::SeekFrom;

    if rustix::fs::ioctl_ficlone(target, source).is_ok() {
        return Ok(());
    }
    let length = source.metadata()?.len();
    target.set_len(length)?;
    let mut offset = 0_u64;
    while offset < length {
        let start = match rustix::fs::seek(source, SeekFrom::Data(offset)) {
            Ok(start) => start,
            Err(rustix::io::Errno::NXIO) => break,
            Err(error) => return Err(error.into()),
        };
        let end = rustix::fs::seek(source, SeekFrom::Hole(start)).map_err(io::Error::from)?;
        let mut from = start;
        let mut into = start;
        while from < end {
            let chunk = usize::try_from(end - from)
                .unwrap_or(usize::MAX)
                .min(1 << 30);
            let copied = rustix::fs::copy_file_range(
                source,
                Some(&mut from),
                target,
                Some(&mut into),
                chunk,
            )?;
            if copied == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "source shrank while copying",
                ));
            }
        }
        offset = end;
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn copy_contents(mut source: &File, mut target: &File) -> io::Result<()> {
    io::copy(&mut source, &mut target).map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sparse_copy_keeps_contents() {
        use std::io::{Seek, SeekFrom};

        let dir = std::env::temp_dir().join(format!("compute-host-copy-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let from = dir.join("from");
        let to = dir.join("to");
        {
            let file = File::create(&from).unwrap();
            file.set_len(64 << 20).unwrap();
            let mut file = file;
            file.write_all(b"head").unwrap();
            file.seek(SeekFrom::Start(40 << 20)).unwrap();
            file.write_all(b"middle").unwrap();
        }
        copy_sparse(&from, &to).unwrap();
        assert_eq!(fs::read(&from).unwrap(), fs::read(&to).unwrap());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn atomic_writes_replace_whole_files() {
        let dir = std::env::temp_dir().join(format!("compute-host-atomic-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("marker");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        remove_durably(&path).unwrap();
        remove_durably(&path).unwrap();
        assert!(!path.exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}
