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

use crate::net::{Link, NetworkConfig};
use crate::protocol::Id;
use crate::state::{Allocation, Record};

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
    /// The kernel command line, including the guest's network
    /// configuration when sandboxes are networked.
    pub boot_args: String,
    /// The user id of the sandbox with ordinal 0; each sandbox's VMM runs
    /// as `first_uid + ordinal`, with the same group id. Never 0.
    pub first_uid: u32,
    /// How sandboxes are networked; `None` leaves them without a network.
    pub network: Option<NetworkConfig>,
}

impl Images {
    /// What this host gives the sandbox numbered `ordinal`: its VMM's user
    /// and group, and its link when sandboxes are networked.
    pub fn allocate(&self, ordinal: u32) -> Result<Allocation, String> {
        let uid = self
            .first_uid
            .checked_add(ordinal)
            .filter(|&uid| self.first_uid != 0 && uid != u32::MAX)
            .ok_or_else(|| format!("no unprivileged user id left for sandbox number {ordinal}"))?;
        let link = match &self.network {
            Some(config) => Some(config.addresses(ordinal).map_err(|full| full.to_string())?),
            None => None,
        };
        Ok(Allocation {
            uid,
            gid: uid,
            link,
        })
    }

    /// Checks that a sandbox recorded earlier fits this host's settings:
    /// its user and link are what this host would give it now, so no new
    /// sandbox can be given the same. A sandbox made without a network
    /// stays without one.
    pub fn check(&self, record: &Record) -> Result<(), String> {
        let now = self.allocate(record.ordinal)?;
        let had = record.allocation;
        if (had.uid, had.gid) != (now.uid, now.gid) {
            return Err(format!(
                "sandbox {} runs as uid {} gid {}, but this host's first uid gives {}",
                record.id, had.uid, had.gid, now.uid
            ));
        }
        match (had.link, now.link) {
            (None, _) => Ok(()),
            (Some(link), Some(now)) if link == now => Ok(()),
            (Some(link), None) => Err(format!(
                "sandbox {} has a network ({}), but this host networks none",
                record.id, link.host
            )),
            (Some(link), Some(now)) => Err(format!(
                "sandbox {} has link {}, but this host's pool gives {}",
                record.id, link.host, now.host
            )),
        }
    }

    /// The network `record` was given, if any.
    pub fn link(record: &Record) -> Option<Link> {
        let Allocation { uid, gid, link } = record.allocation;
        link.map(|addresses| Link::new(record.id, record.ordinal, addresses, uid, gid))
    }
}

/// The VM description for the sandbox `record` describes, from what the
/// record says it was given.
pub(crate) fn vm_spec(record: &Record, paths: &Paths, images: &Images) -> VmSpec {
    VmSpec {
        name: record.id.to_string(),
        dir: paths.jail.clone(),
        logs: paths.dir.clone(),
        uid: record.allocation.uid,
        gid: record.allocation.gid,
        vcpus: record.config.vcpus,
        memory_mib: record.config.memory_mib,
        kernel: paths.kernel.clone(),
        boot_args: images.boot_args.clone(),
        drives: vec![Drive {
            id: "rootfs".into(),
            path: paths.disk.clone(),
            root: true,
            read_only: false,
        }],
        network: Images::link(record).map(|link| link.vm_network()),
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
    failpoint(path, "renamed")?;
    sync_parent(path)
}

/// Fails the write to `path` at `point` in tests that ask for it.
#[cfg(test)]
pub(crate) fn failpoint(path: &Path, point: &'static str) -> io::Result<()> {
    if tests::FAILPOINTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
        .any(|(failing, at)| failing == path && *at == point)
    {
        Err(io::Error::other(format!("simulated failure at {point}")))
    } else {
        Ok(())
    }
}

#[cfg(not(test))]
#[allow(clippy::unnecessary_wraps)]
#[inline]
pub(crate) fn failpoint(_: &Path, _: &'static str) -> io::Result<()> {
    Ok(())
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
    failpoint(path, "sync")?;
    File::open(path)?.sync_all()
}

/// Makes the directory entry of `path` durable.
pub(crate) fn sync_parent(path: &Path) -> io::Result<()> {
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
        copy_range(source, target, start, end)?;
        offset = end;
    }
    Ok(())
}

/// Copies bytes `start..end` of `source` to the same place in `target`:
/// inside the kernel where it can, which shares extents on XFS, otherwise
/// through a buffer, as across filesystems or where `copy_file_range` is
/// not supported.
#[cfg(target_os = "linux")]
fn copy_range(source: &File, target: &File, start: u64, end: u64) -> io::Result<()> {
    use std::os::unix::fs::FileExt;

    use rustix::io::Errno;

    let shrank = || io::Error::new(io::ErrorKind::UnexpectedEof, "source shrank while copying");
    let mut from = start;
    let mut into = start;
    while from < end {
        let chunk = usize::try_from(end - from)
            .unwrap_or(usize::MAX)
            .min(1 << 30);
        match rustix::fs::copy_file_range(source, Some(&mut from), target, Some(&mut into), chunk) {
            Ok(0) => return Err(shrank()),
            Ok(_) => {}
            Err(Errno::XDEV | Errno::OPNOTSUPP | Errno::INVAL | Errno::NOSYS) => break,
            Err(error) => return Err(error.into()),
        }
    }
    let mut buffer = vec![0_u8; 1 << 20];
    while from < end {
        let want = usize::try_from(end - from)
            .unwrap_or(usize::MAX)
            .min(buffer.len());
        let read = source.read_at(&mut buffer[..want], from)?;
        if read == 0 {
            return Err(shrank());
        }
        target.write_all_at(&buffer[..read], from)?;
        from += read as u64;
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn copy_contents(mut source: &File, mut target: &File) -> io::Result<()> {
    io::copy(&mut source, &mut target).map(drop)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Writes that fail on purpose: a path and the point it fails at.
    pub(crate) static FAILPOINTS: std::sync::Mutex<Vec<(PathBuf, &'static str)>> =
        std::sync::Mutex::new(Vec::new());

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
