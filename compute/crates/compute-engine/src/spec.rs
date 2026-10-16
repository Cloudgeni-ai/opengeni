//! What a VM looks like: processors, memory, kernel, disks and channels.

use std::path::PathBuf;

/// A block device attached to the VM.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Drive {
    /// Device name, unique within the VM, such as `rootfs`.
    pub id: String,
    /// Backing file or block device on the host.
    pub path: PathBuf,
    /// Whether this is the root device the kernel mounts as `/`.
    pub root: bool,
    /// Whether the guest may only read it.
    pub read_only: bool,
}

/// A network interface backed by a host tap device.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Network {
    /// Name of the tap device, inside `namespace` if one is given.
    pub tap: String,
    /// The guest's MAC address, such as `06:00:ac:10:00:02`.
    pub mac: String,
    /// The network namespace holding the tap, such as `/run/netns/<name>`.
    /// The VMM runs inside it.
    pub namespace: Option<PathBuf>,
}

/// Everything needed to start or restore one VM.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VmSpec {
    /// Name, used for the VMM process and the cgroup. Letters, digits and
    /// hyphens only, at most 64 characters.
    pub name: String,
    /// The VM's own directory. Every file the VMM opens (kernel, drives,
    /// snapshot files) and every socket it serves lives inside it, so an
    /// engine can confine the VMM to it.
    pub dir: PathBuf,
    /// Where the VMM's console output and logs go: a directory the VMM
    /// itself never sees.
    pub logs: PathBuf,
    /// The unprivileged user the VMM runs as. Every VM has its own, so one
    /// VMM cannot touch another's files or processes.
    pub uid: u32,
    /// The VMM's group.
    pub gid: u32,
    /// Virtual processors.
    pub vcpus: u8,
    /// Guest memory in MiB.
    pub memory_mib: u32,
    /// Uncompressed guest kernel.
    pub kernel: PathBuf,
    /// Kernel command line.
    pub boot_args: String,
    /// Block devices, root device included.
    pub drives: Vec<Drive>,
    /// Network interface, if any.
    pub network: Option<Network>,
    /// Have the guest hand freed memory back to the host as it frees it.
    pub free_page_reporting: bool,
}

impl VmSpec {
    /// Host side of the VM's socket for talking to agents inside it.
    #[must_use]
    pub fn vsock_path(&self) -> PathBuf {
        self.dir.join("vsock.sock")
    }

    /// The VMM's control socket.
    #[must_use]
    pub fn api_socket(&self) -> PathBuf {
        self.dir.join("api.sock")
    }
}

/// Where a snapshot is written on local disk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotFiles {
    /// Device and processor state; small.
    pub state: PathBuf,
    /// Guest memory: a sparse file as large as guest memory. Which pages it
    /// holds depends on the [`SnapshotKind`].
    pub memory: PathBuf,
}

/// Which memory pages a snapshot writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapshotKind {
    /// Only pages that may differ from the VM's memory source: the image it
    /// was restored from, or zeros for a VM booted fresh. Every page the file
    /// does not hold (a hole) equals the source, so the result is only
    /// usable merged over that source. Cheap: work scales with what changed.
    Diff,
    /// Every page. Needed whenever the source is unknown, for example after a
    /// diff that was written but never merged.
    Full,
}

/// Where a restored VM's memory comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MemorySource {
    /// Map this complete memory image file copy-on-write; the page cache
    /// supplies pages as the guest touches them. Only for 4 KiB pages.
    File(PathBuf),
    /// A page-fault handler listening on this Unix socket supplies every
    /// page; see the `compute-pager` crate.
    Pager(PathBuf),
}

/// What a VM is restored from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestoreFiles {
    /// Device and processor state.
    pub state: PathBuf,
    /// Guest memory.
    pub memory: MemorySource,
}
