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
mod error;
pub mod firecracker;
mod profile;
mod spec;
pub mod vsock;

use std::future::Future;
use std::time::Duration;

pub use error::{EngineError, ErrorKind};
pub use profile::{MemoryProfile, PageSize, ProfileError, SaveMode};
pub use spec::{Drive, MemorySource, Network, RestoreFiles, SnapshotFiles, SnapshotKind, VmSpec};
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

    /// Boots a fresh VM from its disks.
    fn boot(&self, spec: &VmSpec) -> impl Future<Output = Result<Self::Vm, EngineError>> + Send;

    /// Starts a VM from saved state and leaves it paused. Memory is loaded
    /// lazily, as the guest touches it, from `files.memory`. A
    /// [`MemorySource::Pager`] must already be listening, and must keep
    /// serving until the VM ends: restoring devices touches guest memory.
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
    /// any snapshot stay on disk.
    fn stop(&self, vm: Self::Vm) -> impl Future<Output = Result<(), EngineError>> + Send;

    /// Takes over the VM an earlier run of the host agent left running for
    /// `spec`, if there is one in a usable state, without disturbing it.
    /// A VM process that cannot be used (for example one that never
    /// finished starting) is ended and `None` returned.
    fn adopt(
        &self,
        spec: &VmSpec,
    ) -> impl Future<Output = Result<Option<(Self::Vm, Found)>, EngineError>> + Send;

    /// Ends any VM process left behind for `spec` and releases its host
    /// resources. Succeeds when there is none.
    fn clean_up(&self, spec: &VmSpec) -> impl Future<Output = Result<(), EngineError>> + Send;

    /// Bytes of host memory the VM holds right now.
    fn resident_bytes(&self, vm: &Self::Vm) -> Result<u64, EngineError>;

    /// Processor time the VM has used since it started, counting every
    /// thread of its VMM. The host compares readings to tell a sandbox busy
    /// with work of its own from an idle one.
    fn cpu_time(&self, vm: &Self::Vm) -> Result<Duration, EngineError>;

    /// Resolves once the VM process has ended for any reason, including
    /// [`Engine::stop`]. The future does not borrow the VM, so the host can
    /// watch for a VM dying on its own while a step uses it.
    fn exited(&self, vm: &Self::Vm) -> impl Future<Output = ()> + Send + 'static;
}
