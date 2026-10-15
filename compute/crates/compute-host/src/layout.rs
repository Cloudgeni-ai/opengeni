//! Where each sandbox's state lives on the host's disk, and the small
//! crash-safe writes that keep it consistent.
//!
//! Every VM runs inside a jail: a chroot directory owned by the sandbox's
//! own user, which is the only part of the host's filesystem its VMM can
//! see. Everything the VMM opens therefore lives inside that jail, and
//! everything only the host needs lives next to it:
//!
//! ```text
//! <root>/vm/firecracker/<id>/  the sandbox directory (host only)
//!   sandbox.json               the sandbox's record (see crate::state)
//!   console.log                the guest's serial console (written by the engine)
//!   vmm.log                    the VMM's own log (written by the engine)
//!   root/                      the jail: "/" for the VMM
//!     vmlinux                  guest kernel (a hard link to the host's copy)
//!     disk.ext4                the sandbox's root disk
//!     vm.state                 saved processor and device state
//!     vm.mem                   saved memory image (sparse)
//!     api.sock                 the VMM's control socket
//!     vsock.sock               host side of the guest's vsock device
//!     vsock.sock_<port>        listeners for connections the guest opens
//! ```
//!
//! The `vm/firecracker/<id>/root` shape is what Firecracker's jailer builds
//! from `--chroot-base-dir <root>/vm`, the exec file's name and `--id`, so
//! the jailer reuses the sandbox's own directory as its chroot. Anything a
//! VMM must open, such as a page-fault handler's socket, belongs under
//! [`Paths::jail`]; [`Paths::in_jail`] names such a file.
//!
//! A memory image is only valid together with the exact disk it was taken
//! with. Once a restored guest runs, its disk moves on and the old image
//! would corrupt it, so the record stops vouching for the image before the
//! guest runs and vouches for a new one only once it is complete and on
//! disk. Which files are valid is only ever read from the record.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use compute_engine::{Drive, SnapshotFiles, VmSpec};

use crate::protocol::{Id, SandboxConfig};

/// Directory name the jailer gives each VM's chroot, inside the sandbox
/// directory.
const JAIL: &str = "root";

/// Longest Unix socket path the kernel accepts, without the trailing NUL.
const MAX_SOCKET_PATH: usize = 107;

/// The longest socket name inside a jail: a guest port listener on the
/// largest possible port.
const LONGEST_SOCKET: &str = "vsock.sock_4294967295";

/// Every path belonging to one sandbox.
#[derive(Clone, Debug)]
pub(crate) struct Paths {
    /// The sandbox directory, host only.
    pub dir: PathBuf,
    pub record: PathBuf,
    /// The VM's jail: the only directory its VMM can see.
    pub jail: PathBuf,
    pub kernel: PathBuf,
    pub disk: PathBuf,
    pub snapshot: SnapshotFiles,
}

impl Paths {
    pub fn new(root: &Path, id: Id) -> Self {
        let dir = sandboxes_dir(root).join(id.to_string());
        let jail = dir.join(JAIL);
        Self {
            record: dir.join("sandbox.json"),
            kernel: jail.join("vmlinux"),
            disk: jail.join("disk.ext4"),
            snapshot: SnapshotFiles {
                state: jail.join("vm.state"),
                memory: jail.join("vm.mem"),
            },
            jail,
            dir,
        }
    }

    /// The host path of `name` inside the jail, which the VMM sees as
    /// `/<name>`.
    #[allow(dead_code)]
    pub fn in_jail(&self, name: &str) -> PathBuf {
        self.jail.join(name)
    }
}

/// The jailer's chroot base directory.
pub(crate) fn chroot_base(root: &Path) -> PathBuf {
    root.join("vm")
}

/// The directory holding one directory per sandbox.
pub(crate) fn sandboxes_dir(root: &Path) -> PathBuf {
    chroot_base(root).join("firecracker")
}

/// Checks that every socket a sandbox under `root` needs fits in a Unix
/// socket address.
pub(crate) fn check_root(root: &Path) -> Result<(), String> {
    let sample = Paths::new(root, Id(compute_core::SandboxId(0)));
    let longest = sample.jail.join(LONGEST_SOCKET);
    let length = longest.as_os_str().len();
    if length > MAX_SOCKET_PATH {
        return Err(format!(
            "state root {} is too long: sandbox sockets would need {length} bytes \
             and Unix sockets allow {MAX_SOCKET_PATH}",
            root.display()
        ));
    }
    Ok(())
}

/// What the host needs to start a sandbox's VM, besides its own paths.
#[derive(Clone, Debug)]
pub(crate) struct Images {
    /// The host's guest kernel, linked into each jail.
    pub kernel: PathBuf,
    pub boot_args: String,
    /// The user id of the sandbox with ordinal 0; each sandbox's VMM runs
    /// as `first_uid + ordinal`, with the same group id.
    pub first_uid: u32,
}

/// The VM description for one sandbox, whose ordinal on this host is
/// `ordinal`.
pub(crate) fn vm_spec(
    id: Id,
    ordinal: u32,
    config: &SandboxConfig,
    paths: &Paths,
    images: &Images,
) -> VmSpec {
    let uid = images.first_uid.saturating_add(ordinal);
    VmSpec {
        name: id.to_string(),
        dir: paths.jail.clone(),
        logs: paths.dir.clone(),
        uid,
        gid: uid,
        vcpus: config.vcpus,
        memory_mib: config.memory_mib,
        kernel: paths.kernel.clone(),
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

/// Points the jail's kernel at the host's current guest kernel: a hard link
/// where the jail shares the kernel's filesystem, otherwise a copy.
/// Replacing it on every boot picks up a kernel upgrade; restores do not
/// read the kernel at all.
pub(crate) fn link_kernel(host_kernel: &Path, paths: &Paths) -> io::Result<()> {
    let staging = paths.kernel.with_extension("staging");
    remove_if_present(&staging)?;
    if fs::hard_link(host_kernel, &staging).is_err() {
        copy_sparse(host_kernel, &staging)?;
    }
    fs::rename(&staging, &paths.kernel)
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
