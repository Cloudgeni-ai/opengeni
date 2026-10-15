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
    /// Name of the host tap device.
    pub tap: String,
    /// The guest's MAC address, such as `06:00:ac:10:00:02`.
    pub mac: String,
}

/// Everything needed to start or restore one VM.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VmSpec {
    /// Name, used for the VMM process and the cgroup. Letters, digits and
    /// hyphens only, at most 64 characters.
    pub name: String,
    /// Private working directory for sockets and logs.
    pub dir: PathBuf,
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

/// Where a saved VM lives on local disk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotFiles {
    /// Device and processor state; small.
    pub state: PathBuf,
    /// Guest memory image; as large as guest memory, but sparse.
    pub memory: PathBuf,
}
