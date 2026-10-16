//! What a VM looks like: processors, memory, kernel, disks and channels.

use std::ffi::OsString;
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
    /// Guest memory in MiB the VM is guaranteed: the host keeps at least
    /// this much of its memory from being reclaimed for others (the VM
    /// cgroup's `memory.low`). At most `memory_mib`.
    pub memory_request_mib: u32,
    /// The VM's share of processor time when processors are contended,
    /// relative to other VMs: its cgroup's `cpu.weight`, 1 to 10000, where
    /// 100 is one processor's worth. `vcpus` stays the ceiling.
    pub cpu_weight: u16,
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

    /// Guest memory in bytes: the length of every memory snapshot of the
    /// VM.
    #[must_use]
    pub fn memory_bytes(&self) -> u64 {
        u64::from(self.memory_mib) << 20
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
    /// A page-fault handler supplies every page: a process the engine
    /// starts beside the VM, which lives as long as the VM needs it and
    /// no longer than the VM; see the `compute-pager` crate.
    Pager(PagerSpec),
}

/// The page-fault handler process of a [`MemorySource::Pager`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PagerSpec {
    /// The Unix socket it listens on for the VMM, inside the VM's jail.
    pub socket: PathBuf,
    /// A directory of its own, which the engine gives the VM's user before
    /// the pager starts: everything the pager writes once it has dropped to
    /// that user (see the `compute-pager` crate's `user` module) goes
    /// there, so whoever reads it must not trust it more than the VM.
    pub dir: PathBuf,
    /// The program to run, with its arguments. It must print `ready` on a
    /// line of its own once `socket` listens and it runs as the VM's user
    /// (which the engine passes as `--user UID:GID`), and nothing else on
    /// standard output; it must exit once the VMM has gone.
    pub program: PathBuf,
    pub args: Vec<OsString>,
}

/// What a VM is restored from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestoreFiles {
    /// Device and processor state.
    pub state: PathBuf,
    /// Guest memory.
    pub memory: MemorySource,
    /// The runtime the image was made under, if known; see
    /// [`crate::Engine::runtime`]. An engine that keeps that runtime
    /// restores the image under it.
    pub made_under: Option<String>,
}
