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
//!     vmlinux                  guest kernel (a clone of the host's, owned by the host)
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

use compute_engine::{Drive, Network, SnapshotFiles, VmSpec};

use crate::net::{Link, NetworkConfig};
use crate::protocol::Id;
use crate::state::{Allocation, Record};

/// Directory name the jailer gives each VM's chroot, inside the sandbox
/// directory.
const JAIL: &str = "root";

/// The kernel command line argument naming the sandbox (see
/// [`crate::restore_notice`]). Dotted, so the kernel leaves it out of the
/// init process's arguments and environment.
pub(crate) const SANDBOX_ARG: &str = "opengeni.sandbox";

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
    /// The sandbox's named holds; see `agent::holds`.
    pub holds: PathBuf,
    /// The VM's jail: the only directory its VMM can see.
    pub jail: PathBuf,
    pub kernel: PathBuf,
    pub disk: PathBuf,
    pub snapshot: SnapshotFiles,
}

impl Paths {
    /// The paths of the sandbox directory named `id`.
    pub fn new(root: &Path, id: Id) -> Self {
        Self::at(sandboxes_dir(root).join(id.to_string()))
    }

    /// The paths of the sandbox `record` describes, under the name its
    /// directory was made with (see [`Record::host`]).
    pub fn of(root: &Path, record: &Record) -> Self {
        Self::new(root, record.host())
    }

    /// The paths of a VM whose directory is `dir`, which the jailer needs
    /// to be `<base>/firecracker/<VM name>`.
    pub fn at(dir: PathBuf) -> Self {
        let jail = dir.join(JAIL);
        Self {
            record: dir.join("sandbox.json"),
            holds: dir.join("holds.json"),
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

/// The directory holding the warm templates (see [`crate::pool`]).
pub(crate) fn templates_dir(root: &Path) -> PathBuf {
    root.join("templates")
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
        link.map(|addresses| Link::new(record.host(), record.ordinal, addresses, uid, gid))
    }
}

/// The VM description for the sandbox `record` describes, from what the
/// record says it was given.
pub(crate) fn vm_spec(record: &Record, paths: &Paths, images: &Images) -> VmSpec {
    Machine {
        // The jail, cgroup and network keep the name they were made under.
        name: record.host().to_string(),
        paths,
        uid: record.allocation.uid,
        gid: record.allocation.gid,
        vcpus: record.config.vcpus,
        memory_mib: record.config.memory_mib,
        memory_request_mib: record.config.memory_request(),
        cpu_weight: record.config.cpu_weight(),
        // The guest's own id, for a guest booted from its disk; a restored
        // one is told in the restore notice.
        boot_args: format!("{} {SANDBOX_ARG}={}", images.boot_args, record.id),
        network: Images::link(record).map(|link| link.vm_network()),
    }
    .spec()
}

/// A VM on this host. Besides what is named here, every VM has the same
/// devices at the same paths inside its jail, so the saved state of one,
/// such as a template's, restores as any other of the same shape.
pub(crate) struct Machine<'a> {
    pub name: String,
    pub paths: &'a Paths,
    pub uid: u32,
    pub gid: u32,
    pub vcpus: u8,
    pub memory_mib: u32,
    /// Memory guaranteed to it; see [`VmSpec::memory_request_mib`].
    pub memory_request_mib: u32,
    /// Its share of the processors; see [`VmSpec::cpu_weight`].
    pub cpu_weight: u16,
    pub boot_args: String,
    pub network: Option<Network>,
}

impl Machine<'_> {
    pub fn spec(self) -> VmSpec {
        VmSpec {
            name: self.name,
            dir: self.paths.jail.clone(),
            logs: self.paths.dir.clone(),
            uid: self.uid,
            gid: self.gid,
            vcpus: self.vcpus,
            memory_mib: self.memory_mib,
            memory_request_mib: self.memory_request_mib,
            cpu_weight: self.cpu_weight,
            kernel: self.paths.kernel.clone(),
            boot_args: self.boot_args,
            drives: vec![Drive {
                id: "rootfs".into(),
                path: self.paths.disk.clone(),
                root: true,
                read_only: false,
            }],
            network: self.network,
            free_page_reporting: true,
        }
    }
}

/// Puts a copy of the host's current guest kernel in the jail: a clone
/// sharing its extents where the filesystem can (XFS, btrfs), otherwise a
/// plain copy. Never a hard link: the jail is the VMM's, and a name for the
/// host's own kernel in it would let a compromised VMM have the host change
/// that file's owner or read it in place of one of its own. Replacing it on
/// every boot picks up a kernel upgrade; restores do not read the kernel.
pub(crate) fn link_kernel(host_kernel: &Path, paths: &Paths) -> io::Result<()> {
    let staging = paths.kernel.with_extension("staging");
    remove_if_present(&staging)?;
    copy_sparse(host_kernel, &staging)?;
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
    failpoint(path, "staged")?;
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
    failpoint(path, "parent")?;
    match path.parent() {
        Some(parent) => File::open(parent)?.sync_all(),
        None => Ok(()),
    }
}

/// Creates `dir` if missing, with its entry in its parent made durable.
/// The parent is synced even when `dir` exists already: an earlier call may
/// have created it and then failed to sync. The parent must exist: an
/// ancestor this did not create could not be vouched for, so a missing one
/// fails with [`io::ErrorKind::NotFound`] instead of being made.
pub(crate) fn create_dir_durably(dir: &Path) -> io::Result<()> {
    match fs::create_dir(dir) {
        Err(error) if error.kind() != io::ErrorKind::AlreadyExists => Err(error),
        _ => sync_parent(dir),
    }
}

/// Opens a file in a VM's jail for reading. Its VMM may have put a link to
/// a host file or a pipe in its place, so the last component is never
/// followed, opening never blocks, and anything but a regular file with no
/// other name is refused.
pub(crate) fn open_jailed(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let flags = rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK;
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(flags.bits().cast_signed())
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() || metadata.nlink() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "{} in a VM's jail is not a regular file of its own",
                path.display()
            ),
        ));
    }
    Ok(file)
}

/// Copies `from` to `to` as cheaply as the filesystem allows: a shared-extent
/// clone where supported (XFS, btrfs), otherwise only the data regions, so
/// holes stay holes and a mostly empty 2 GiB image costs only its data.
pub(crate) fn copy_sparse(from: &Path, to: &Path) -> io::Result<()> {
    copy_file(&File::open(from)?, to)
}

/// Copies the open file `source` to a new file `to` like [`copy_sparse`].
pub(crate) fn copy_file(source: &File, to: &Path) -> io::Result<()> {
    let target = File::create(to)?;
    copy_contents(source, &target)?;
    target.sync_all()
}

/// A file being written beside `target` under a name of its own, so work
/// left running by an abandoned attempt never writes into another
/// attempt's file. Removed unless published.
#[derive(Debug)]
pub(crate) struct Staging {
    path: PathBuf,
    target: PathBuf,
    published: bool,
}

impl Staging {
    /// A fresh staging name beside `target`. Staging files an earlier
    /// agent process left there are removed: only one agent holds the
    /// state root, so nothing of theirs can still be writing.
    pub(crate) fn beside(target: &Path) -> io::Result<Self> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static ATTEMPTS: AtomicU64 = AtomicU64::new(0);

        let name = target
            .file_name()
            .ok_or_else(|| io::Error::other("staging a path without a file name"))?;
        let mut prefix = name.to_owned();
        prefix.push(".fetching");
        let prefix = prefix.to_string_lossy().into_owned();
        let ours = format!("{prefix}.{}.", std::process::id());
        if let Some(parent) = target.parent() {
            for entry in fs::read_dir(parent)? {
                let entry = entry?;
                let found = entry.file_name();
                let found = found.to_string_lossy();
                if found.starts_with(&prefix) && !found.starts_with(&ours) {
                    remove_if_present(&entry.path())?;
                }
            }
        }
        let attempt = ATTEMPTS.fetch_add(1, Ordering::Relaxed);
        Ok(Self {
            path: target.with_file_name(format!("{ours}{attempt}")),
            target: target.to_owned(),
            published: false,
        })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// Makes the staged file durable and moves it into place.
    pub(crate) fn publish(mut self) -> io::Result<()> {
        sync_file(&self.path)?;
        fs::rename(&self.path, &self.target)?;
        self.published = true;
        sync_parent(&self.target)
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Bytes a copy of `from` by [`copy_sparse`] can take on a filesystem that
/// allocates in units of `unit` bytes (see [`allocation_unit`]): every
/// data range of `from`, widened to whole units, as where extents cannot
/// be shared each is written out, whatever `from`'s own filesystem
/// compresses or shares; its whole length where its holes cannot be found.
#[cfg(target_os = "linux")]
pub(crate) fn copy_size(from: &Path, unit: u64) -> io::Result<u64> {
    use rustix::fs::SeekFrom;

    let unit = unit.max(1);
    let source = File::open(from)?;
    let length = source.metadata()?.len();
    let mut size = 0_u64;
    let mut offset = 0_u64;
    while offset < length {
        let start = match rustix::fs::seek(&source, SeekFrom::Data(offset)) {
            Ok(start) => start,
            Err(rustix::io::Errno::NXIO) => break,
            Err(_) => return Ok(length.next_multiple_of(unit)),
        };
        let end = rustix::fs::seek(&source, SeekFrom::Hole(start)).map_err(io::Error::from)?;
        size = size.saturating_add(end.next_multiple_of(unit) - start / unit * unit);
        offset = end;
    }
    Ok(size)
}

/// [`copy_size`] where holes cannot be found: the whole length.
#[cfg(not(target_os = "linux"))]
pub(crate) fn copy_size(from: &Path, unit: u64) -> io::Result<u64> {
    Ok(fs::metadata(from)?.len().next_multiple_of(unit.max(1)))
}

/// Filesystems the state root may be on: those on which the smallest write
/// [`allocation_unit`] makes bounds what any write takes, so sparse copies
/// and saves can be booked. Ext4 allocates blocks, or with bigalloc whole
/// clusters, which the probe's file takes too; XFS allocates blocks, or
/// the extent size hint the probe's file inherits; btrfs allocates
/// sectors, and its inline and compressed extents take less. Others, such
/// as ZFS, whose record size grows with a file, or tmpfs with huge pages
/// within a file's size, can take more than the probe shows.
pub(crate) const SUPPORTED_FILESYSTEMS: [(u64, &str); 3] = [
    (0xEF53, "ext4"),
    (0x5846_5342, "XFS"),
    (0x9123_683E, "btrfs"),
];

/// Refuses a filesystem of statfs type `kind` that is not one of
/// [`SUPPORTED_FILESYSTEMS`].
pub(crate) fn supported_filesystem(kind: u64) -> io::Result<()> {
    if SUPPORTED_FILESYSTEMS
        .iter()
        .any(|(magic, _)| *magic == kind)
    {
        return Ok(());
    }
    let names: Vec<&str> = SUPPORTED_FILESYSTEMS
        .iter()
        .map(|(_, name)| *name)
        .collect();
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        format!(
            "it is on a filesystem of type {kind:#x}, on which what a save or copy \
             takes cannot be bounded; use one of {}",
            names.join(", ")
        ),
    ))
}

/// The bytes the filesystem holding `dir` allocates for the smallest write,
/// learned by writing one: 4 KiB that do not compress, made durable, then
/// what the file takes; no less than the block size it reports, as some
/// filesystems count what a write takes only later. Ext4 with bigalloc,
/// for one, allocates whole clusters of up to megabytes. Refuses a
/// filesystem not in [`SUPPORTED_FILESYSTEMS`], on which that bounds
/// nothing, before writing.
pub(crate) fn allocation_unit(dir: &Path) -> io::Result<u64> {
    use std::os::unix::fs::MetadataExt;

    #[cfg(target_os = "linux")]
    {
        let kind = rustix::fs::statfs(dir)?.f_type;
        supported_filesystem(u64::try_from(kind).unwrap_or(u64::MAX))?;
    }
    let probe = dir.join(".allocation-probe");
    let result = (|| {
        let mut file = File::create(&probe)?;
        // Bytes no filesystem compresses away: a simple generator's output.
        let mut state = 0x9e37_79b9_7f4a_7c15_u64;
        let block: Vec<u8> = (0..4096)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state.to_le_bytes()[0]
            })
            .collect();
        file.write_all(&block)?;
        file.sync_all()?;
        let metadata = file.metadata()?;
        Ok(metadata
            .blocks()
            .saturating_mul(512)
            .max(metadata.blksize())
            .max(4096))
    })();
    let _ = fs::remove_file(&probe);
    result
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

/// Whether files under `dir` can share extents: then a save's merge clones
/// the previous image and writes only what changed; otherwise the merge
/// writes a whole new copy as well.
#[cfg(target_os = "linux")]
pub(crate) fn shares_extents(dir: &Path) -> io::Result<bool> {
    use std::os::unix::fs::FileExt;

    let probe = dir.join(".extent-probe");
    let copy = dir.join(".extent-probe-copy");
    let result = (|| {
        // A clone reads its source, so the source must be open for reading.
        let source = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&probe)?;
        source.write_all_at(&[1; 4096], 0)?;
        let target = File::create(&copy)?;
        Ok(rustix::fs::ioctl_ficlone(&target, &source).is_ok())
    })();
    let _ = fs::remove_file(&copy);
    let _ = fs::remove_file(&probe);
    result
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn shares_extents(_: &Path) -> io::Result<bool> {
    Ok(false)
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

    /// A directory whose entry could not be made durable is synced again by
    /// the next call, which must not take the directory existing as proof.
    #[test]
    fn a_directory_entry_that_failed_to_sync_is_synced_on_the_next_try() {
        let dir = tempfile::tempdir().unwrap();
        let made = dir.path().join("images");
        FAILPOINTS.lock().unwrap().push((made.clone(), "parent"));
        assert!(create_dir_durably(&made).is_err());
        assert!(made.is_dir());
        assert!(
            create_dir_durably(&made).is_err(),
            "an existing directory was taken as durable"
        );
        FAILPOINTS.lock().unwrap().retain(|(path, _)| path != &made);
        create_dir_durably(&made).unwrap();
    }

    /// The unit is learned from the filesystem itself: at least a block,
    /// and the probe leaves nothing behind.
    #[test]
    fn the_allocation_unit_is_learned_from_the_filesystem() {
        let dir = tempfile::tempdir().unwrap();
        let unit = allocation_unit(dir.path()).unwrap();
        assert!(unit >= 4096 && unit.is_power_of_two(), "{unit}");
        assert!(!dir.path().join(".allocation-probe").exists());
    }

    /// A state root on a filesystem whose allocation the probe cannot bound,
    /// such as tmpfs or ZFS, is refused, naming the ones that are supported;
    /// nothing is written there.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_filesystem_the_probe_cannot_bound_is_refused() {
        const ZFS: u64 = 0x2fc1_2fc1;
        let refused = supported_filesystem(ZFS).unwrap_err();
        assert_eq!(refused.kind(), io::ErrorKind::Unsupported);
        assert!(
            refused.to_string().contains("ext4, XFS, btrfs"),
            "{refused}"
        );
        let shm = Path::new("/dev/shm");
        if rustix::fs::statfs(shm).is_ok_and(|fs| fs.f_type == 0x0102_1994) {
            let refused = allocation_unit(shm).unwrap_err();
            assert_eq!(refused.kind(), io::ErrorKind::Unsupported, "{refused}");
            assert!(!shm.join(".allocation-probe").exists());
        }
    }

    /// What a VMM can leave in its jail in place of a file is never read.
    #[test]
    fn jailed_files_are_read_only_as_plain_files_of_their_own() {
        let dir = tempfile::tempdir().unwrap();
        let host = dir.path().join("host-secret");
        fs::write(&host, b"host").unwrap();
        let disk = dir.path().join("disk.ext4");
        fs::write(&disk, b"disk").unwrap();
        open_jailed(&disk).unwrap();
        let link = dir.path().join("linked");
        std::os::unix::fs::symlink(&host, &link).unwrap();
        assert!(open_jailed(&link).is_err(), "followed a link");
        let named = dir.path().join("named");
        fs::hard_link(&host, &named).unwrap();
        assert!(
            open_jailed(&named).is_err(),
            "read a file with another name"
        );
        let pipe = dir.path().join("pipe");
        rustix::fs::mkfifoat(
            rustix::fs::CWD,
            &pipe,
            rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
        )
        .unwrap();
        assert!(open_jailed(&pipe).is_err(), "a pipe must not block or pass");
        let copy = dir.path().join("copy");
        copy_file(&open_jailed(&disk).unwrap(), &copy).unwrap();
        assert_eq!(fs::read(&copy).unwrap(), b"disk");
    }

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
