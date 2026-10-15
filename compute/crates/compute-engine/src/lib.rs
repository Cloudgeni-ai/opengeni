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
mod spec;
pub mod vsock;

use std::future::Future;

pub use error::{EngineError, ErrorKind};
pub use spec::{Drive, Network, SnapshotFiles, VmSpec};

/// What the host needs from a VM program.
///
/// Every method that can fail reports an [`ErrorKind`] saying what the
/// failure means for the sandbox. Operations on one VM are never issued
/// concurrently.
pub trait Engine: Send + Sync + 'static {
    /// A running VM process.
    type Vm: Send + Sync + 'static;

    /// Boots a fresh VM from its disks.
    fn boot(&self, spec: &VmSpec) -> impl Future<Output = Result<Self::Vm, EngineError>> + Send;

    /// Starts a VM from saved state and resumes it. Memory is loaded lazily,
    /// as the guest touches it.
    fn restore(
        &self,
        spec: &VmSpec,
        files: &SnapshotFiles,
    ) -> impl Future<Output = Result<Self::Vm, EngineError>> + Send;

    /// Stops the VM's processors. Memory stays in place.
    fn pause(&self, vm: &Self::Vm) -> impl Future<Output = Result<(), EngineError>> + Send;

    /// Restarts the processors of a paused VM.
    fn resume(&self, vm: &Self::Vm) -> impl Future<Output = Result<(), EngineError>> + Send;

    /// Moves a paused VM's memory into compressed host RAM.
    fn compress(&self, vm: &Self::Vm) -> impl Future<Output = Result<(), EngineError>> + Send;

    /// Writes a paused VM's processor, device and memory state to `files`.
    /// The VM stays paused, so the caller can still resume it instead of
    /// stopping it.
    fn snapshot(
        &self,
        vm: &Self::Vm,
        files: &SnapshotFiles,
    ) -> impl Future<Output = Result<(), EngineError>> + Send;

    /// Ends the VM process and releases its host resources. Its disks and
    /// any snapshot stay on disk.
    fn stop(&self, vm: Self::Vm) -> impl Future<Output = Result<(), EngineError>> + Send;

    /// Bytes of host memory the VM holds right now.
    fn resident_bytes(&self, vm: &Self::Vm) -> Result<u64, EngineError>;
}
