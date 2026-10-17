//! Running sandboxes as microVMs.
//!
//! [`Engine`] is the small set of operations an Opengeni compute host needs
//! from a VM program: boot, pause, resume, compress memory, snapshot,
//! restore and stop. Everything above it, such as deciding when to sleep,
//! is engine-independent, so another VM program (for example Cloud
//! Hypervisor) is one more implementation of this trait.
//!
//! [`firecracker::Firecracker`] is the first implementation.

pub mod cgroup;
pub mod confined;
mod error;
pub mod firecracker;
mod profile;
mod spec;
pub mod vsock;
pub mod watchdog;

use std::future::Future;
use std::os::fd::OwnedFd;
use std::time::Duration;

pub use cgroup::MemoryStats;
pub use error::{EngineError, ErrorKind};
pub use profile::{MemoryProfile, PageSize, ProfileError, SaveMode};
pub use spec::{
    Drive, MemorySource, Network, PagerSpec, RestoreFiles, SnapshotFiles, SnapshotKind, VmSpec,
};
pub use tokio_util::sync::CancellationToken;

/// How an interruptible operation ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Completion {
    /// It ran to the end.
    Finished,
    /// It stopped early because it was cancelled. Whatever it did so far is
    /// valid: the VM is in the same level as before, just partly done.
    Cancelled,
}

/// What a VM found alive by [`Engine::adopt`] is doing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Found {
    /// Its processors run.
    Running,
    /// Its processors are stopped; its memory is in place.
    Paused,
}

/// Whether an engine can load memory images made under some runtime.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Readable {
    /// One of its VMMs reads them; a refusal was for another reason.
    Yes,
    /// None of its VMMs ever will, and this says why. Only proof counts:
    /// a refusal alone proves nothing.
    No(String),
    /// It cannot tell, for instance because a runtime is unnamed.
    Unknown,
}

/// What the host needs from a VM program.
///
/// Every method that can fail reports an [`ErrorKind`] saying what the
/// failure means for the sandbox. Operations on one VM are never issued
/// concurrently.
///
/// VM processes outlive the host agent: stopping, crashing or upgrading the
/// agent leaves every VM as it was, and the next agent takes them back with
/// [`Engine::adopt`].
pub trait Engine: Send + Sync + 'static {
    /// A running VM process.
    type Vm: Send + Sync + 'static;

    /// How this engine backs, saves and compresses guest memory.
    fn memory_profile(&self) -> MemoryProfile;

    /// What restoring a memory image depends on besides the image, such as
    /// the VMM's version and the processor: an image made under another
    /// runtime may be refused. New VMs run under this one. Empty when
    /// unknown.
    fn runtime(&self) -> &str;

    /// The runtime `vm` runs under, which its snapshots belong to. A VM an
    /// earlier agent started before an upgrade may run under an older one
    /// than [`Engine::runtime`]. Empty when unknown.
    fn vm_runtime<'a>(&'a self, vm: &'a Self::Vm) -> &'a str {
        let _ = vm;
        self.runtime()
    }

    /// Whether any VMM this engine keeps can load an image made under
    /// runtime `made_under`, on any processor. A runtime on another
    /// processor is not a [`Readable::No`]: whether its saved processor
    /// state fits this one is only known by trying.
    fn reads(&self, made_under: &str) -> Readable {
        if made_under == self.runtime() && !made_under.is_empty() {
            Readable::Yes
        } else {
            Readable::Unknown
        }
    }

    /// Boots a fresh VM from its disks.
    fn boot(&self, spec: &VmSpec) -> impl Future<Output = Result<Self::Vm, EngineError>> + Send;

    /// Starts a VM from saved state and leaves it paused. Memory is loaded
    /// lazily, as the guest touches it, from `files.memory`. The process of
    /// a [`MemorySource::Pager`] is started here, after the VMM and before
    /// the VMM loads the state; it runs with the VM from then on and ends
    /// with it at the latest. It may exit earlier, once the VM needs it no
    /// more.
    ///
    /// The VM stays paused so the caller can mark the saved image as stale
    /// before the guest runs: once the guest writes to its disk, the old
    /// memory image no longer matches the disk and must never be restored
    /// again.
    fn restore(
        &self,
        spec: &VmSpec,
        files: &RestoreFiles,
    ) -> impl Future<Output = Result<Self::Vm, EngineError>> + Send;

    /// Stops the VM's processors. Memory stays in place. A transient
    /// failure means the processors kept running.
    fn pause(&self, vm: &Self::Vm) -> impl Future<Output = Result<(), EngineError>> + Send;

    /// Restarts the processors of a paused VM. A transient failure means
    /// the guest did not run; whether it ran after any other failure is
    /// unknown.
    fn resume(&self, vm: &Self::Vm) -> impl Future<Output = Result<(), EngineError>> + Send;

    /// Moves a paused VM's memory into compressed host RAM, in small chunks
    /// so a wake that arrives meanwhile only waits for the current chunk.
    fn compress(
        &self,
        vm: &Self::Vm,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<Completion, EngineError>> + Send;

    /// Writes a paused VM's processor, device and memory state to `files`,
    /// which must not exist yet. The VM stays paused, so the caller can
    /// still resume it instead of stopping it.
    ///
    /// A [`SnapshotKind::Diff`] that succeeds is the only record of which
    /// pages changed: the next diff starts from it. A caller that cannot
    /// merge it, or sees this call fail, must ask for
    /// [`SnapshotKind::Full`] next time.
    fn snapshot(
        &self,
        vm: &Self::Vm,
        files: &SnapshotFiles,
        kind: SnapshotKind,
    ) -> impl Future<Output = Result<(), EngineError>> + Send;

    /// Ends the VM process and releases its host resources. Its disks and
    /// any snapshot stay on disk. Resolves only once the process has ended,
    /// so that nothing is still using the disks when a replacement starts.
    /// Fails at once if the process cannot be signalled, and after it ended
    /// if its resources could not be released; [`Engine::clean_up`] then
    /// releases them later.
    fn stop(&self, vm: Self::Vm) -> impl Future<Output = Result<(), EngineError>> + Send;

    /// Takes over the VM an earlier run of the host agent left running for
    /// `spec`, if there is one in a usable state, without disturbing it.
    /// `None` means no guest runs for `spec`: none was found, or the one
    /// found provably never started its guest or has exited, and has been
    /// cleaned up. A VM that may hold a running guest but cannot be taken
    /// over (it does not answer, say) is an error and is left alone, so
    /// its memory is never lost to a slow probe. A VM whose memory pager
    /// has died while the guest still depended on it can never run again:
    /// it is ended and the error is [`ErrorKind::MemoryLost`].
    fn adopt(
        &self,
        spec: &VmSpec,
    ) -> impl Future<Output = Result<Option<(Self::Vm, Found)>, EngineError>> + Send;

    /// Keeps `file` open, as the same open file description, for as long as
    /// `vm`'s process lives, outliving the host agent as the VM does, so
    /// state that belongs to the description survives an agent restart;
    /// [`Engine::held`] gets it back. The host keeps its disk watch there.
    fn hold(
        &self,
        vm: &Self::Vm,
        file: OwnedFd,
    ) -> impl Future<Output = Result<(), EngineError>> + Send;

    /// A new descriptor for the open file description [`Engine::hold`]
    /// keeps for `vm`, or `None` if nothing is kept for it.
    fn held(
        &self,
        vm: &Self::Vm,
    ) -> impl Future<Output = Result<Option<OwnedFd>, EngineError>> + Send;

    /// Ends any VM process left behind for `spec` and releases its host
    /// resources. Succeeds when there is none.
    fn clean_up(&self, spec: &VmSpec) -> impl Future<Output = Result<(), EngineError>> + Send;

    /// Bytes of host memory the VM holds right now; with huge-page guest
    /// memory, the huge pages it holds.
    fn resident_bytes(&self, vm: &Self::Vm) -> Result<u64, EngineError>;

    /// Processor time the VM has used since it started, counting every
    /// thread of its VMM. The host compares readings to tell a sandbox busy
    /// with work of its own from an idle one.
    fn cpu_time(&self, vm: &Self::Vm) -> Result<Duration, EngineError>;

    /// Bytes the VM's processes have moved through system calls since they
    /// started: its network and disk traffic, and possibly part of its
    /// vsock traffic (an engine documents what it counts). The host compares
    /// readings to see work that waits on data rather than the processor,
    /// such as a slow download. Only differences between readings of the
    /// same VM mean anything.
    fn io_bytes(&self, vm: &Self::Vm) -> Result<u64, EngineError>;

    /// The VM's zswap traffic and memory pressure so far. A running VM is
    /// never compressed, so its `zswpout` grows only while it is paused.
    /// Engines that cannot tell report an error.
    fn memory_stats(&self, vm: &Self::Vm) -> Result<MemoryStats, EngineError> {
        let _ = vm;
        Err(EngineError::new(
            ErrorKind::Transient,
            "memory_stats",
            "this engine does not report memory statistics",
        ))
    }

    /// Resolves once the VM process has ended for any reason, including
    /// [`Engine::stop`]. The future does not borrow the VM, so the host can
    /// watch for a VM dying on its own while a step uses it.
    fn exited(&self, vm: &Self::Vm) -> impl Future<Output = ()> + Send + 'static;

    /// Asks the guest of the running VM to give `bytes` of its memory back
    /// to the host through its balloon, or none for 0. The guest gives what
    /// it can spare, file cache first, and takes pages back from the
    /// balloon rather than run out of memory. Every pause lets the balloon
    /// go first, and a request that comes once the VM is paused or ended
    /// does nothing and fails, so a VM never sleeps with its balloon set
    /// and a request not made is never taken for done. For 0, resolves
    /// once the guest has taken back every page it gave. The future does
    /// not borrow the VM. Engines without balloons do nothing.
    fn set_balloon(
        &self,
        vm: &Self::Vm,
        bytes: u64,
    ) -> impl Future<Output = Result<(), EngineError>> + Send + 'static {
        let _ = (vm, bytes);
        std::future::ready(Ok(()))
    }
}
