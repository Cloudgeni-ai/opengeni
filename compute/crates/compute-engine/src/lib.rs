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

pub use cgroup::{MemoryStats, Writes};
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

/// What [`Engine::keep_memory_room`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoomKept {
    /// Nothing: the reserve is free, nothing limits the VMs together, or a
    /// drop asked earlier is under way.
    Free,
    /// It is dropping this many bytes of the VMs' page cache.
    Dropping(u64),
    /// It cannot: the kernel cannot be asked for page cache alone (Linux
    /// 6.9 and later can). Said once; every later call is `Free`.
    Unsupported,
}

/// Whether an engine can load memory images made under some runtime.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Readable {
    /// One of its VMMs reads them; a refusal was for another reason.
    Yes,
    /// None of its VMMs ever will, and this says why. Only proof counts:
    /// a refusal alone proves nothing.
    No(String),
    /// One of its VMMs reads their format, but they were made on another
    /// kind of host (another processor model or host kernel), and this
    /// says how it differs. Whether their saved processor state fits this
    /// host is known only by trying; the host does not change while it
    /// runs, so a refusal repeated is its answer.
    Elsewhere(String),
    /// It cannot tell, for instance because a runtime is unnamed.
    Unknown,
}

/// What a VM's logs last said, for an operator to tell why it was lost
/// (see [`Engine::last_words`]). Each part is its last few lines, oldest
/// first, and empty when there was nothing to read.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LastWords {
    /// What its guest last wrote on its console, such as a kernel panic.
    pub guest: String,
    /// What its VMM last wrote, other than its answers to the host's
    /// requests: why it stopped, or its panic.
    pub vmm: String,
    /// What the pager serving its memory last wrote, if one did.
    pub pager: String,
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

    /// Names `vm`'s process apart from every other process the host has
    /// run or will run, across reboots. State that lives only in that
    /// process, such as which pages its next [`SnapshotKind::Diff`] holds,
    /// can then be recorded for an agent that restarts beside the VM: a
    /// record naming another process says nothing about this one. Engines
    /// that cannot tell report an error, and such state is never trusted
    /// after a restart.
    fn process_identity(&self, vm: &Self::Vm) -> Result<String, EngineError> {
        let _ = vm;
        Err(EngineError::new(
            ErrorKind::Transient,
            "process_identity",
            "this engine cannot name its VM processes",
        ))
    }

    /// Whether any VMM this engine keeps can load an image made under
    /// runtime `made_under`, on any processor. A runtime on another
    /// processor or host kernel is not a [`Readable::No`] but a
    /// [`Readable::Elsewhere`]: whether its saved processor state fits
    /// this host is only known by trying.
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

    /// Releases what VMs that ended while nothing managed them left behind
    /// with no VM to name it by, such as Firecracker's empty cgroups,
    /// which would go on claiming the memory protection of VMs that are
    /// gone. For the one host agent holding the host, once, before it
    /// starts or adopts any VM. Blocks briefly.
    fn clean_up_left_behind(&self) -> Result<(), EngineError> {
        Ok(())
    }

    /// Bytes of memory its VMs may still take together, if the engine
    /// limits what they hold together: the limit less what they hold now,
    /// page cache the host can drop at once left out as in
    /// [`Engine::resident_bytes`]. A new guest gets no more than this
    /// however much the host has free, so the host counts it as the most
    /// that is available. `None` where nothing limits them together.
    fn memory_room(&self) -> Result<Option<u64>, EngineError> {
        Ok(None)
    }

    /// Drops page cache charged to the VMs together, and only cache, while
    /// less than `reserve` is free under the limit on what they hold
    /// together, in the background: [`Engine::memory_room`] counts that
    /// cache as available, so the reserve the host keeps for sandboxes
    /// growing within their request has to be free memory, not cache the
    /// first of them to grow would wait to drop. Nothing where nothing
    /// limits them together.
    fn keep_memory_room(&self, _reserve: u64) -> RoomKept {
        RoomKept::Free
    }

    /// Bytes of host memory the VM holds right now; with huge-page guest
    /// memory, the huge pages it holds. Page cache the host can drop at
    /// once, such as what its disk writes and saved images leave, is not
    /// held.
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

    /// What the VM's processes have written through system calls since
    /// they started: every write its VMM makes to the VM's drives counts
    /// once the call returns, and every file page it dirties, also with no
    /// write call (as a discard over part of a block does), counts as it is
    /// dirtied, besides others an engine documents. Only differences
    /// between readings of the same VM mean anything. Engines that cannot
    /// tell report an error.
    fn writes(&self, vm: &Self::Vm) -> Result<Writes, EngineError> {
        let _ = vm;
        Err(EngineError::new(
            ErrorKind::Transient,
            "writes",
            "this engine does not count a VM's writes",
        ))
    }

    /// Resolves once every write to the VM's drives that its VMM had
    /// started when this is first polled has returned, so a
    /// [`Engine::writes`] reading taken after it counts them all. The
    /// future does not borrow the VM. Engines that cannot tell report an
    /// error.
    fn settle_writes(
        &self,
        vm: &Self::Vm,
    ) -> impl Future<Output = Result<(), EngineError>> + Send + 'static {
        let _ = vm;
        std::future::ready(Err(EngineError::new(
            ErrorKind::Transient,
            "settle_writes",
            "this engine cannot tell when a VM's writes have returned",
        )))
    }

    /// The VM's zswap traffic and memory pressure so far, and what of its
    /// memory is compressed now. A running VM is compressed only on a host
    /// that lets the kernel do so (ADR 24). Engines that cannot tell
    /// report an error.
    fn memory_stats(&self, vm: &Self::Vm) -> Result<MemoryStats, EngineError> {
        let _ = vm;
        Err(EngineError::new(
            ErrorKind::Transient,
            "memory_stats",
            "this engine does not report memory statistics",
        ))
    }

    /// Whether the guest's last words were that it halted: it stopped its
    /// processors for good, as Linux does for a halt and for a power-off
    /// its VMM gives it no way to make (Firecracker on x86). Its VM then
    /// runs on, but its guest never will. The words are the guest's own,
    /// and it can write them whenever it likes, so they say only why a
    /// guest that also takes no connection has stopped. The future reads
    /// a little of a file off the caller's thread and does not borrow the
    /// VM. Engines that cannot tell say no.
    fn halted(
        &self,
        vm: &Self::Vm,
    ) -> impl Future<Output = Result<bool, EngineError>> + Send + 'static {
        let _ = vm;
        std::future::ready(Ok(false))
    }

    /// What `vm`'s logs last said, for an operator to tell why it was lost:
    /// its process ended on its own, its memory could no longer be served,
    /// or its guest stopped answering. Read before the VM is torn down,
    /// which may remove its logs with its sandbox. The future reads the
    /// ends of a few files off the caller's thread and does not borrow the
    /// VM; what it cannot read it says so in place of the lines. Engines
    /// that keep no logs say nothing.
    fn last_words(&self, vm: &Self::Vm) -> impl Future<Output = LastWords> + Send + 'static {
        let _ = vm;
        std::future::ready(LastWords::default())
    }

    /// Gives the VM new guarantees, as [`VmSpec::memory_request_mib`] and
    /// [`VmSpec::cpu_weight`] give a new one: its processor share at once,
    /// its memory protection from its next resume, which is when a VM gets
    /// it. For a VM restored for one request and handed to another. Engines
    /// that cannot change them report an error, and the VM is not handed
    /// on.
    fn set_guarantees(
        &self,
        vm: &Self::Vm,
        memory_request_mib: u32,
        cpu_weight: u16,
    ) -> Result<(), EngineError> {
        let _ = (vm, memory_request_mib, cpu_weight);
        Err(EngineError::new(
            ErrorKind::Transient,
            "set_guarantees",
            "this engine cannot change a VM's guarantees",
        ))
    }

    /// Sets the most host memory the VM may hold from now on, as
    /// [`VmSpec::memory_limit`] sets it for a new one, or lifts the limit
    /// for `None`. Engines that cannot change it report an error.
    fn set_memory_limit(&self, vm: &Self::Vm, bytes: Option<u64>) -> Result<(), EngineError> {
        let _ = (vm, bytes);
        Err(EngineError::new(
            ErrorKind::Transient,
            "set_memory_limit",
            "this engine cannot change a VM's memory limit",
        ))
    }

    /// Whether the kernel may compress running VMs' memory (ADR 24): on
    /// an engine that does not, a running VM's compressed pages are a
    /// defect worth a warning.
    fn compresses_running(&self) -> bool {
        false
    }

    /// How many VM processes, VMMs and pagers, the kernel's out-of-memory
    /// killer ended since the engine took the host: a VM it ends this way
    /// loses its running programs, which the host's memory rule (ADR 24)
    /// exists to prevent. `None` where the engine cannot tell.
    fn oom_kills(&self) -> Result<Option<u64>, EngineError> {
        Ok(None)
    }

    /// Bounds the running VM's memory as the host's memory rule asks
    /// (ADR 24): `low` bytes the kernel keeps it from losing to others,
    /// and `high` bytes past which it waits on its own allocations while
    /// the kernel compresses its coldest pages, or no such point for
    /// `None`. A VM starts, resumes and is adopted with its request as its
    /// low and no high. Applied in the background, the latest asked
    /// winning; a pause or a resume drops one not yet applied. Returns at
    /// once. Engines that cannot bound a VM report an error.
    fn bound_memory(&self, vm: &Self::Vm, low: u64, high: Option<u64>) -> Result<(), EngineError> {
        let _ = (vm, low, high);
        Err(EngineError::new(
            ErrorKind::Transient,
            "bound_memory",
            "this engine cannot bound a VM's memory",
        ))
    }

    /// Whether the engine is still bringing `vm` down toward the high of
    /// the latest [`Engine::bound_memory`]: the kernel is at work on it and
    /// has not shown that it can take no more. A VM whose pages the kernel
    /// must first age may come down only after many seconds. `false` for
    /// an engine that applies a bound at once or cannot bound a VM.
    fn bringing_down(&self, vm: &Self::Vm) -> bool {
        let _ = vm;
        false
    }

    /// Tells the guest of `vm`, started from `spec`, how long each of its
    /// writable drives is now: their files grew since it last learned
    /// that, at its boot or in the state it was restored from. A paused
    /// guest learns it when it next runs. Engines whose drives cannot
    /// change length report an error, and the VM keeps the drives it had.
    fn resize_drives(
        &self,
        vm: &Self::Vm,
        spec: &VmSpec,
    ) -> impl Future<Output = Result<(), EngineError>> + Send {
        let _ = (vm, spec);
        std::future::ready(Err(EngineError::new(
            ErrorKind::Transient,
            "resize_drives",
            "this engine cannot change a drive's length",
        )))
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
    /// and a request not made is never taken for done. Requests take
    /// effect in the order this is called: one that reaches the VM after a
    /// later request, or a later pause or resume, does nothing and fails,
    /// so the setting asked last is the one that holds. For 0, resolves
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
