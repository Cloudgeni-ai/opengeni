//! The Firecracker driver.
//!
//! Every VM runs under Firecracker's jailer ([`jail`]): as its own
//! unprivileged user, chrooted to its own directory, in its own cgroup v2
//! group, PID and mount namespaces, behind Firecracker's default seccomp
//! filters. The VMM is not a child of the host agent ([`process`]), so it
//! keeps running when the agent stops or crashes, and [`Engine::adopt`]
//! takes it back.

mod api;
mod balloon;
mod bounds;
mod drives;
mod holder;
mod jail;
mod logs;
mod pager;
mod process;
mod run_state;
mod runtime;
mod snapshot;

use std::fs::{self, File};
use std::io;
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::watch;
use tokio::time::{Instant, sleep, timeout};

use self::api::Api;
pub use self::api::ApiError;
use self::balloon::Balloon;
use self::drives::drive_config;
pub use self::jail::BINARY_NAME;
use self::jail::{
    API_SOCKET, Jail, LAUNCH_LEFTOVERS, Launch, PID_FILE, jailer_args, remove_if_present,
};
pub use self::process::Exit;
use self::process::{Process, in_cgroup, parse_pid};
use self::run_state::{RunState, set_run_state};
use self::runtime::{Binary, chosen, readable, record_runtime, recorded_runtime};
use self::snapshot::{
    check_source, create_request, lacks_realtime_clock, load_failure, load_request,
};
use crate::Readable;
use crate::cgroup::{Cgroup, MemoryStats, Writes};
use crate::confined::Owned;
use crate::error::{EngineError, ErrorKind};
use crate::profile::{MemoryProfile, PageSize, ProfileError};
use crate::spec::{MemorySource, RestoreFiles, SnapshotFiles, SnapshotKind, VmSpec};
use crate::{CancellationToken, Completion, Engine, Found};

/// Memory pushed to compressed RAM per reclaim request. Small enough that a
/// wake arriving mid-compression waits only a few milliseconds.
const RECLAIM_CHUNK: u64 = 16 << 20;

/// How long the jailer may take to set up a VM and start Firecracker.
const JAILER_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a VMM found by [`Engine::adopt`] may take to answer.
const ADOPT_TIMEOUT: Duration = Duration::from_secs(2);

/// The search path the jailer runs with; it inherits nothing else.
const JAILER_PATH: &str = "/usr/sbin:/usr/bin:/sbin:/bin";

/// Guest clock source that restore can correct.
///
/// A restored guest's clock otherwise stands still for as long as the VM was
/// saved. Firecracker fixes that on restore (`clock_realtime`) by moving the
/// paravirtual KVM clock forward, which only helps a guest that reads time from
/// that clock. Left to choose, Linux prefers the processor's own counter (TSC),
/// so boot pins it unless the caller already chose a clock source.
const CLOCK_SOURCE: &str = "clocksource=kvm-clock";

/// Guest kernel parameter for the smallest free block, as a power of two of
/// 4 KiB pages, that the guest reports to the host for reclaim.
const REPORTING_ORDER: &str = "page_reporting.page_reporting_order";

/// The reporting order that matches the pages backing guest memory.
///
/// The host can give back only whole backing pages. A reported range smaller
/// than one of the 2 MiB huge pages frees nothing (Firecracker's discard of
/// it fails) and still costs the guest and the VMM a report, which also
/// slows the reports that would free memory. So a guest on huge pages reports
/// only blocks of at least one huge page (order 9), and a guest on 4 KiB
/// pages every free page (order 0), the most it can give back. Firecracker's
/// ballooning guide gives the same advice: reported ranges should match the
/// backing page size.
///
/// The order is the guest kernel's, set when it boots: a sandbox restored
/// from a memory image keeps the order it booted with, whatever pages back
/// it after the restore. A fleet whose hosts all run one memory profile
/// never sees a difference. Were a guest booted on base pages restored
/// onto huge pages, its reports smaller than a huge page would free
/// nothing; one booted on huge pages and restored onto base pages gives
/// back less than it could.
fn reporting_order(pages: PageSize) -> u32 {
    (pages.bytes() / PageSize::Base.bytes()).trailing_zeros()
}

/// The kernel command line to boot with: the caller's, plus [`CLOCK_SOURCE`]
/// if it names no clock source of its own, plus the [`reporting_order`] for
/// `reporting`, the pages backing a guest that reports freed memory, if it
/// names no order of its own. A guest keeps the order it booted with.
fn boot_args(requested: &str, reporting: Option<PageSize>) -> String {
    let names = |parameter: &str| {
        requested.split_whitespace().any(|arg| {
            arg.split_once('=')
                .is_some_and(|(name, _)| name == parameter)
        })
    };
    let mut args = requested.trim().to_owned();
    let mut add = |arg: &str| {
        if !args.is_empty() {
            args.push(' ');
        }
        args.push_str(arg);
    };
    if !names("clocksource") {
        add(CLOCK_SOURCE);
    }
    if let Some(pages) = reporting
        && !names(REPORTING_ORDER)
    {
        add(&format!("{REPORTING_ORDER}={}", reporting_order(pages)));
    }
    args
}

/// Firecracker's name for a page size.
fn huge_pages(pages: PageSize) -> &'static str {
    match pages {
        PageSize::Base => "None",
        PageSize::Huge => "2M",
    }
}

/// The memory part of `/machine-config` for a fresh boot.
fn machine_config(spec: &VmSpec, profile: MemoryProfile) -> Value {
    json!({
        "vcpu_count": spec.vcpus,
        "mem_size_mib": spec.memory_mib,
        "smt": false,
        "track_dirty_pages": profile.tracks_dirty_pages(),
        "huge_pages": huge_pages(profile.pages),
    })
}

/// How [`Firecracker`] runs VMs.
#[derive(Clone, Debug)]
pub struct FirecrackerConfig {
    /// The Firecracker binary. Its file name, once every symbolic link is
    /// resolved, must be [`BINARY_NAME`].
    pub firecracker: PathBuf,
    /// Older Firecracker binaries kept after an upgrade, each named like
    /// `firecracker`, so that memory images made under them can still be
    /// restored. New VMs always start under `firecracker`; a binary can go
    /// once no image is older than the image retention period.
    pub retained: Vec<PathBuf>,
    /// The jailer binary from the same Firecracker release.
    pub jailer: PathBuf,
    /// Parent of every VM's own cgroup. It must sit inside the cgroup v2
    /// hierarchy with the memory and CPU controllers available, and hold
    /// no groups but the VMs': [`Engine::clean_up_left_behind`] removes
    /// the empty ones.
    pub cgroup_parent: PathBuf,
}

/// Runs VMs with Firecracker, each under its jailer.
#[derive(Clone, Debug)]
pub struct Firecracker {
    /// What new VMs start under.
    binary: Binary,
    /// Kept only to restore images made under them.
    retained: Vec<Binary>,
    jailer: PathBuf,
    cgroups: Cgroup,
    /// `cgroups` relative to the cgroup v2 mount, as the jailer names it.
    cgroup_relative: PathBuf,
    startup_timeout: Duration,
    memory: MemoryProfile,
    /// Whether running VMs' memory may be compressed into zswap; see
    /// [`Firecracker::with_running_compression`].
    compress_running: bool,
    /// Bytes the out-of-memory killer counts a VM's badness against when
    /// the VMs' group reaches its `memory.max`: that limit and the swap
    /// the group may use. `None` without such a limit.
    oom_total: Option<u64>,
}

impl Firecracker {
    /// Checks `config` and creates the parent cgroup.
    /// VMs use the bare-metal memory profile unless
    /// [`Firecracker::with_memory_profile`] says otherwise.
    pub fn new(config: FirecrackerConfig) -> io::Result<Self> {
        let binary = Binary::new(&config.firecracker)?;
        let mut retained: Vec<Binary> = Vec::new();
        for path in &config.retained {
            let older = Binary::new(path)?;
            // One whose images the current binary makes alike adds nothing.
            if older.runtime != binary.runtime
                && retained.iter().all(|kept| kept.runtime != older.runtime)
            {
                retained.push(older);
            }
        }
        let mount = cgroup2_mount()?;
        let cgroup_relative = config
            .cgroup_parent
            .strip_prefix(&mount)
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "cgroup {} is not inside the cgroup v2 hierarchy at {}",
                        config.cgroup_parent.display(),
                        mount.display()
                    ),
                )
            })?
            .to_path_buf();
        if cgroup_relative.as_os_str().is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "VMs need a parent cgroup below the cgroup v2 root",
            ));
        }
        crate::cgroup::check_outside_own(&cgroup_relative)?;
        crate::cgroup::enable_controllers_above(&mount, &cgroup_relative)?;
        Ok(Self {
            binary,
            retained,
            jailer: config.jailer,
            cgroups: Cgroup::create_parent(config.cgroup_parent)?,
            cgroup_relative,
            startup_timeout: Duration::from_secs(5),
            memory: MemoryProfile::bare_metal(),
            compress_running: false,
            oom_total: None,
        })
    }

    /// Backs, saves and compresses every VM's memory as `profile` says.
    /// Refuses an unsafe profile.
    pub fn with_memory_profile(mut self, profile: MemoryProfile) -> Result<Self, ProfileError> {
        self.memory = profile.validate()?;
        Ok(self)
    }

    /// Lets the VMs hold at most `bytes` of memory together before the
    /// kernel slows them down (the parent group's `memory.high`), or lifts
    /// that for `None`, which also undoes what an earlier agent set. Their
    /// VMMs, pagers and the page cache of their disks and images count,
    /// as in each VM's own group. A guest past it waits on its own
    /// allocations while the kernel reclaims from the VMs' groups first,
    /// so the host's other processes keep their memory; nothing is ended.
    /// Returns without waiting for the kernel to reclaim down to it; see
    /// [`Cgroup::set_memory_high`].
    pub fn with_memory_high(self, bytes: Option<u64>) -> io::Result<Self> {
        self.cgroups.set_memory_high(bytes)?;
        Ok(self)
    }

    /// Lets the VMs hold at most `bytes` of memory together, ever (the
    /// parent group's `memory.max`), or lifts that for `None`, which also
    /// undoes what an earlier agent set. Should they reach it, the kernel
    /// ends one VM, never anything else on the host: the one furthest above
    /// its request, since every VMM's out-of-memory score is lowered by its
    /// request (see [`Firecracker::oom_score_adj`]). The host's last
    /// defence, above [`Firecracker::with_memory_high`]; the agent bounds
    /// sandboxes long before (ADR 24).
    pub fn with_memory_max(mut self, bytes: Option<u64>) -> io::Result<Self> {
        self.cgroups.set_memory_max(bytes)?;
        self.oom_total = match bytes {
            Some(bytes) => Some(bytes.saturating_add(crate::cgroup::swap_total()?)),
            None => None,
        };
        Ok(self)
    }

    /// Lets the kernel compress running VMs' memory into zswap, never to a
    /// disk, when the host is short or a VM is past its `memory.high`
    /// (ADR 24). Their requests stay protected (`memory.low`). Needs a
    /// profile that compresses, with zswap on and a swap device for its
    /// slots; without, running VMs are never compressed, as before.
    pub fn with_running_compression(mut self, on: bool) -> Result<Self, ProfileError> {
        if on && !self.memory.compress {
            return Err(ProfileError::CompressionDisabled);
        }
        self.compress_running = on;
        Ok(self)
    }

    /// The out-of-memory score adjustment of the VMM of a VM that requests
    /// `request` bytes: with a limit for the VMs together, its request in
    /// thousandths of what the killer counts against, so that a VM's
    /// badness is what it holds above its request. The VM furthest above
    /// its request goes first, and one within it last of all. Without such
    /// a limit, [`process::OOM_SCORE_ADJ`] for every VM.
    fn oom_score_adj(&self, request: u64) -> i32 {
        let Some(total) = self.oom_total.filter(|total| *total > 0) else {
            return process::OOM_SCORE_ADJ;
        };
        let thousandths = u128::from(request) * 999 / u128::from(total);
        -i32::try_from(thousandths.min(999)).unwrap_or(999)
    }

    /// The VM's own cgroup; it exists only while the jailer's work does.
    fn cgroup_of(&self, spec: &VmSpec) -> Cgroup {
        Cgroup::at(self.cgroups.path().join(&spec.name))
    }

    /// The cgroup of VM `name` as `/proc/<pid>/cgroup` shows it.
    fn cgroup_name(&self, name: &str) -> PathBuf {
        Path::new("/").join(&self.cgroup_relative).join(name)
    }

    /// Starts a jailed VMM for `spec` and waits for its API. `owned` are
    /// entries the VMM must be able to write or connect to, such as its
    /// drives; they are handed to the VM's user first. A failure counts as a
    /// launch ([`EngineError::launched`]) once the VMM the jailer started was
    /// found in the VM's cgroup. Before that, a jailer that failed or hung
    /// may have got as far as starting one, but anything it left in the
    /// cgroup is ended unseen and not counted.
    async fn launch(
        &self,
        spec: &VmSpec,
        operation: &'static str,
        owned: Vec<(PathBuf, Owned)>,
        binary: &Binary,
    ) -> Result<FirecrackerVm, EngineError> {
        let jail = Jail::new(spec)
            .map_err(|error| EngineError::new(ErrorKind::Fatal, operation, error))?;
        let netns = spec
            .network
            .as_ref()
            .and_then(|network| network.namespace.clone());
        let args = jailer_args(
            spec,
            &jail,
            &Launch {
                binary: &binary.path,
                cgroup_parent: &self.cgroup_relative,
                netns: netns.as_deref(),
                // Only one that may borrow: what a VM guaranteed all of its
                // memory holds above that is its VMM's, the host's cost.
                compress_running: self.compress_running
                    && spec.memory_request_mib < spec.memory_mib,
            },
        );
        let (console, log) = {
            let (jail, logs, uid, gid) = (jail.clone(), spec.logs.clone(), spec.uid, spec.gid);
            let runtime = binary.runtime.clone();
            tokio::task::spawn_blocking(move || {
                let opened = prepare(&jail, &logs, &owned, uid, gid)?;
                record_runtime(&jail, &runtime)?;
                Ok::<_, io::Error>(opened)
            })
            .await
            .map_err(|error| EngineError::caused_by(ErrorKind::Transient, operation, error))?
            .map_err(|error| EngineError::io(operation, error))?
        };
        let mut command = Command::new(&self.jailer);
        command
            .args(&args)
            .env_clear()
            .env("PATH", JAILER_PATH)
            .stdin(Stdio::null())
            .stdout(console)
            .stderr(log);
        process::detach(&mut command);
        let mut jailer = command
            .spawn()
            .map_err(|error| EngineError::io(operation, error))?;
        // The jailer exits as soon as Firecracker runs in its new PID
        // namespace; Firecracker is then nobody's child but init's.
        let Ok(status) = timeout(JAILER_TIMEOUT, jailer.wait()).await else {
            let _ = jailer.kill().await;
            return Err(launch_failed(
                operation,
                format!("the jailer did not finish within {JAILER_TIMEOUT:?}"),
                self.discard(spec).await,
            ));
        };
        let status = match status {
            Ok(status) => status,
            Err(error) => {
                return Err(launch_failed(
                    operation,
                    format!("waiting for the jailer: {error}"),
                    self.discard(spec).await,
                ));
            }
        };
        if !status.success() {
            return Err(launch_failed(
                operation,
                format!(
                    "the jailer failed ({status}); see {}",
                    spec.logs.join("vmm.log").display()
                ),
                self.discard(spec).await,
            ));
        }
        let vm = match self.attach(spec, &jail) {
            Ok(vm) => vm,
            Err(error) => {
                return Err(launch_failed(operation, error, self.discard(spec).await));
            }
        };
        if let Err(error) = vm.wait_for_api(self.startup_timeout).await {
            return Err(self
                .ended(
                    &vm,
                    EngineError::new(ErrorKind::Transient, operation, error),
                )
                .await);
        }
        Ok(vm)
    }

    /// Pins the VMM the jailer started for `spec`: the process named by the
    /// jail's pid file, if it lives in the VM's own cgroup. Its runtime is
    /// what its launch recorded, unknown if the launch recorded none.
    fn attach(&self, spec: &VmSpec, jail: &Jail) -> Result<FirecrackerVm, String> {
        let pid_file = jail.root().join(PID_FILE);
        let text = fs::read_to_string(&pid_file)
            .map_err(|error| format!("reading {}: {error}", pid_file.display()))?;
        let pid = parse_pid(&text).ok_or_else(|| format!("bad pid file {text:?}"))?;
        let process = Process::open(pid).map_err(|error| format!("pidfd for {pid:?}: {error}"))?;
        // Checked after pinning: had the VMM exited and its pid been reused
        // before the pidfd was opened, the new process would not be in the
        // VM's cgroup.
        let cgroup = self.cgroup_name(&spec.name);
        if !in_cgroup(pid, &cgroup).map_err(|error| error.to_string())? || !process.is_running() {
            return Err(format!(
                "process {} is not the VMM in {}",
                pid.as_raw_pid(),
                cgroup.display()
            ));
        }
        // The host's out-of-memory killer ends anything else first, and
        // among VMs the one furthest above its request.
        let request = u64::from(spec.memory_request_mib) << 20;
        process
            .protect_from_oom(self.oom_score_adj(request))
            .map_err(|error| format!("protecting VMM {} from OOM: {error}", pid.as_raw_pid()))?;
        // Its guarantee counts for its parent group too.
        self.cgroup_of(spec)
            .protect_parent()
            .map_err(|error| format!("protecting the VMs' group: {error}"))?;
        // Requests reach only this VMM, never a later one at the same path,
        // and wait out the time it is frozen.
        let api = Api::new(spec.api_socket())
            .served_by(pid.as_raw_pid())
            .held_by(self.cgroup_of(spec));
        Ok(FirecrackerVm {
            name: spec.name.clone(),
            process,
            balloon: Balloon::unknown(&api, spec.free_page_reporting),
            api,
            cgroup: self.cgroup_of(spec),
            jail: jail.clone(),
            memory_low: AtomicU64::new(request),
            memory: u64::from(spec.memory_mib) << 20,
            bounds: Arc::new(bounds::Bounds::default()),
            compress_running: self.compress_running,
            runtime: recorded_runtime(jail),
            console: spec.logs.join(logs::CONSOLE_LOG),
        })
    }

    /// Kills the VMM, waits for it to exit, ends whatever else is left in
    /// its cgroup, such as holders, and releases the group and the jailer's
    /// per-launch files. Fails without waiting if the process cannot be
    /// signalled, and after it exited if releasing fails.
    async fn kill(&self, vm: &FirecrackerVm) -> Result<(), EngineError> {
        const OP: &str = "stop";
        // No balloon request reaches whatever runs behind its API socket
        // next.
        vm.balloon.end().await;
        // A pidfd only ever signals its own process, even if it is gone.
        vm.process
            .kill()
            .map_err(|error| EngineError::caused_by(ErrorKind::Fatal, OP, error))?;
        vm.process.exited().await;
        // A pager may still run in the group; it goes with the VM.
        let (cgroup, jail) = (vm.cgroup.clone(), vm.jail.clone());
        tokio::task::spawn_blocking(move || {
            cgroup.end_all()?;
            cgroup.remove()?;
            tidy(&jail)
        })
        .await
        .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))?
        .map_err(|error| EngineError::io(OP, error))
    }

    /// Ends a VM whose start failed with `error` and returns that error, or
    /// a fatal one if the VM would not end: nothing may start in its place
    /// while it may still run. Either way the error records the launch.
    async fn ended(&self, vm: &FirecrackerVm, error: EngineError) -> EngineError {
        let error = match self.kill(vm).await {
            Ok(()) => error,
            Err(stuck) => EngineError::new(
                ErrorKind::Fatal,
                error.operation,
                format!("{error}; then the VM could not be ended: {stuck}"),
            ),
        };
        error.after_launch()
    }

    /// Kills whatever runs in the VM's cgroup, for VMMs the host holds no
    /// pidfd for, and releases it like [`Self::kill`].
    async fn discard(&self, spec: &VmSpec) -> io::Result<()> {
        let cgroup = self.cgroup_of(spec);
        let jail = Jail::new(spec).ok();
        tokio::task::spawn_blocking(move || {
            cgroup.end_all()?;
            cgroup.remove()?;
            jail.map_or(Ok(()), |jail| tidy(&jail))
        })
        .await
        .map_err(io::Error::other)?
    }

    /// Runs `body` and, if it fails, kills the half-started VM.
    async fn or_kill<T>(
        &self,
        vm: &FirecrackerVm,
        body: impl Future<Output = Result<T, EngineError>>,
    ) -> Result<T, EngineError> {
        match body.await {
            Ok(value) => Ok(value),
            Err(error) => Err(self.ended(vm, error).await),
        }
    }

    /// The current binary, then the older ones kept.
    fn binaries(&self) -> Vec<&Binary> {
        std::iter::once(&self.binary)
            .chain(&self.retained)
            .collect()
    }

    /// The binary to restore an image made under `made_under` with; see
    /// [`chosen`].
    fn binary_for(&self, made_under: Option<&str>) -> &Binary {
        made_under
            .and_then(|made_under| chosen(&self.binaries(), made_under))
            .unwrap_or(&self.binary)
    }
}

/// The error a launch ends with when it failed before the host held the
/// VMM it may have started. Whatever it started was then discarded, with
/// `discarded` saying how that went: only once that is proven, by the VM's
/// cgroup being empty and gone, is the failure transient. Otherwise a VMM
/// may still run on the sandbox's disk, and nothing may start beside it.
fn launch_failed(
    operation: &'static str,
    message: String,
    discarded: io::Result<()>,
) -> EngineError {
    match discarded {
        Ok(()) => EngineError::new(ErrorKind::Transient, operation, message),
        Err(error) => EngineError::new(
            ErrorKind::Fatal,
            operation,
            format!("{message}; then what it started could not be cleaned up: {error}"),
        ),
    }
}

/// The cgroup v2 mount point.
fn cgroup2_mount() -> io::Result<PathBuf> {
    fs::read_to_string("/proc/self/mounts")?
        .lines()
        .find_map(|line| {
            let mut fields = line.split_whitespace();
            let (_, point, kind) = (fields.next()?, fields.next()?, fields.next()?);
            (kind == "cgroup2").then(|| PathBuf::from(point))
        })
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no cgroup v2 hierarchy mounted"))
}

/// Readies the jail for a launch and opens the VMM's console and log.
fn prepare(
    jail: &Jail,
    dir: &Path,
    owned: &[(PathBuf, Owned)],
    uid: u32,
    gid: u32,
) -> io::Result<(File, File)> {
    fs::create_dir_all(jail.root())?;
    tidy(jail)?;
    // The jail is the VMM's: an earlier one may have left links in it.
    for (path, kind) in owned {
        crate::confined::hand_over(path, *kind, uid, gid)?;
    }
    logs::open(dir)
}

/// Removes what one launch leaves in the jail: the jailer's copy of the
/// binary, its pid file and device nodes, and the VMM's sockets. Listener
/// sockets the host serves in the jail stay.
fn tidy(jail: &Jail) -> io::Result<()> {
    let sockets = [API_SOCKET.trim_start_matches('/'), "vsock.sock"];
    for name in LAUNCH_LEFTOVERS.iter().chain(&sockets) {
        let path = jail.root().join(name);
        let removed = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(&path),
            Ok(_) => fs::remove_file(&path),
            Err(error) => Err(error),
        };
        match removed {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
    }
    Ok(())
}

/// A running Firecracker VM.
#[derive(Debug)]
pub struct FirecrackerVm {
    name: String,
    process: Process,
    api: Api,
    cgroup: Cgroup,
    jail: Jail,
    /// Bytes of its memory protected from reclaim for others while it runs.
    memory_low: AtomicU64,
    /// Bytes of guest memory it has.
    memory: u64,
    /// The bounds the host asks of it while it runs (ADR 24).
    bounds: Arc<bounds::Bounds>,
    /// Whether running VMs' memory may be compressed on this host; its own
    /// is only while it requests less than all of it (see
    /// [`FirecrackerVm::compressible`]).
    compress_running: bool,
    balloon: Balloon,
    /// See [`Engine::vm_runtime`].
    runtime: String,
    /// Its guest's serial console, written by this VM process alone.
    console: PathBuf,
}

impl FirecrackerVm {
    /// The VM's name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The VMM process id, in the host's PID namespace.
    #[must_use]
    pub fn pid(&self) -> i32 {
        self.process.pid().as_raw_pid()
    }

    /// The VM's cgroup.
    #[must_use]
    pub fn cgroup(&self) -> &Cgroup {
        &self.cgroup
    }

    /// Whether the VMM process is still alive.
    #[must_use]
    pub fn is_running(&self) -> bool {
        self.process.is_running()
    }

    /// A watch that changes once the VMM process exits for any reason, so
    /// the host can notice a VM dying on its own.
    #[must_use]
    pub fn exit_watch(&self) -> watch::Receiver<Exit> {
        self.process.exit()
    }

    /// Resolves once the VMM process has exited.
    pub async fn exited(&self) {
        self.process.exited().await;
    }

    /// The path the jailed VMM sees for `host`.
    fn inside(&self, operation: &'static str, host: &Path) -> Result<PathBuf, EngineError> {
        self.jail
            .inside(host)
            .map_err(|error| EngineError::new(ErrorKind::Fatal, operation, error))
    }

    async fn wait_for_api(&self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        loop {
            if crate::confined::connect(self.api.socket()).await.is_ok() {
                return Ok(());
            }
            if !self.is_running() {
                return Err("the VMM exited before its API came up".into());
            }
            if Instant::now() >= deadline {
                return Err(format!("the VMM API did not come up within {timeout:?}"));
            }
            sleep(Duration::from_millis(1)).await;
        }
    }

    /// What the VM is doing, or `None` if it never finished starting.
    async fn found(&self) -> Result<Option<Found>, ApiError> {
        let body = self.api.call("GET", "/", None).await?;
        let info: Value = serde_json::from_slice(&body)
            .map_err(|_| ApiError::Malformed("instance info is not JSON"))?;
        Ok(match info["state"].as_str() {
            Some("Running") => Some(Found::Running),
            Some("Paused") => Some(Found::Paused),
            _ => None,
        })
    }

    /// Sends one API request. A failure while the VMM is gone means the VM's
    /// memory is gone with it; otherwise it is classified as `kind`.
    async fn call(
        &self,
        operation: &'static str,
        kind: ErrorKind,
        method: &'static str,
        path: &str,
        body: &Value,
    ) -> Result<(), EngineError> {
        match self.api.call(method, path, Some(body)).await {
            Ok(_) => Ok(()),
            Err(_) if !self.is_running() => Err(EngineError::new(
                ErrorKind::MemoryLost,
                operation,
                "the VMM process has exited",
            )),
            Err(error) => Err(EngineError::caused_by(kind, operation, error)),
        }
    }

    /// Gives the VM what a running VM starts with: its memory guarantee
    /// (its request as `memory.low`), no `memory.high`, and zswap open
    /// only if it may be compressed while it runs. Drops any bound asked
    /// before (see [`bounds`]), and lifts a `memory.high` an earlier
    /// bound or an earlier agent left.
    fn guard_running(&self) -> io::Result<()> {
        self.bounds.reset(|| {
            self.launched_zswap()?;
            self.cgroup
                .set_memory_low(self.memory_low.load(Ordering::Acquire))?;
            self.lift_high()
        })
    }

    /// Gives the VM the zswap it was launched with: open only if it may be
    /// compressed while it runs. Its bounds may have closed or metered its
    /// swap meanwhile (see [`bounds`]).
    fn launched_zswap(&self) -> io::Result<()> {
        if self.compressible() {
            self.cgroup.open_zswap()
        } else {
            self.cgroup.close_zswap()
        }
    }

    /// Whether its memory may be compressed while it runs: on a host that
    /// compresses running VMs, and only while it requests less than all of
    /// its memory, so that it may borrow (ADR 24). One guaranteed all of it
    /// never borrows; what it holds above that is its VMM's own.
    fn compressible(&self) -> bool {
        self.compress_running && self.memory_low.load(Ordering::Acquire) < self.memory
    }

    /// Gives the VM what a paused VM has: no guarantee, no `memory.high`,
    /// and zswap closed until something compresses it. Drops any bound
    /// asked before.
    fn guard_paused(&self) -> io::Result<()> {
        self.bounds.reset(|| {
            self.cgroup.close_zswap()?;
            self.cgroup.set_memory_low(0)?;
            self.lift_high()
        })
    }

    /// Lifts the VM's own `memory.high` (ADR 24). A paused VM takes no
    /// memory of its own: what it brings back is its save's, page by page
    /// from zswap, and a high would have the kernel compress another of
    /// its pages for each, so that the save reads them again. The VMs'
    /// shared bounds still hold.
    fn lift_high(&self) -> io::Result<()> {
        if self.cgroup.memory_high()?.is_some() {
            self.cgroup.set_memory_high(None)?;
        }
        Ok(())
    }

    async fn set_state(&self, operation: &'static str, run: RunState) -> Result<(), EngineError> {
        set_run_state(&self.api, || self.is_running(), operation, run).await
    }
}

impl Engine for Firecracker {
    type Vm = FirecrackerVm;

    fn memory_profile(&self) -> MemoryProfile {
        self.memory
    }

    fn runtime(&self) -> &str {
        &self.binary.runtime
    }

    fn vm_runtime<'a>(&'a self, vm: &'a FirecrackerVm) -> &'a str {
        &vm.runtime
    }

    fn process_identity(&self, vm: &FirecrackerVm) -> Result<String, EngineError> {
        vm.process
            .identity()
            .map_err(|error| EngineError::io("process_identity", error))
    }

    fn reads(&self, made_under: &str) -> Readable {
        readable(&self.binaries(), made_under)
    }

    async fn boot(&self, spec: &VmSpec) -> Result<FirecrackerVm, EngineError> {
        const OP: &str = "boot";
        let vm = self
            .launch(spec, OP, drives::owned(&spec.drives), &self.binary)
            .await?;
        let configure = async {
            // A rejected configuration will not fix itself: fatal.
            let put = |path: &'static str, body: Value| {
                let vm = &vm;
                async move { vm.call(OP, ErrorKind::Fatal, "PUT", path, &body).await }
            };
            put(
                "/boot-source",
                json!({
                    "kernel_image_path": vm.inside(OP, &spec.kernel)?,
                    "boot_args": boot_args(
                        &spec.boot_args,
                        spec.free_page_reporting.then_some(self.memory.pages),
                    ),
                }),
            )
            .await?;
            for drive in &spec.drives {
                vm.call(
                    OP,
                    ErrorKind::Fatal,
                    "PUT",
                    &format!("/drives/{}", drive.id),
                    &drive_config(drive, &vm.inside(OP, &drive.path)?),
                )
                .await?;
            }
            put("/machine-config", machine_config(spec, self.memory)).await?;
            if spec.free_page_reporting {
                // Statistics can only be turned on at boot, and are how
                // the API tells what the guest holds in the balloon. Their
                // guest-side report is rare; that count is read directly.
                put(
                    "/balloon",
                    json!({
                        "amount_mib": 0,
                        "deflate_on_oom": true,
                        "stats_polling_interval_s": 60,
                        "free_page_reporting": true,
                    }),
                )
                .await?;
            }
            if let Some(network) = &spec.network {
                put(
                    "/network-interfaces/eth0",
                    json!({ "iface_id": "eth0", "host_dev_name": network.tap, "guest_mac": network.mac }),
                )
                .await?;
            }
            put(
                "/vsock",
                json!({ "guest_cid": 3, "uds_path": vm.inside(OP, &spec.vsock_path())? }),
            )
            .await?;
            vm.call(
                OP,
                ErrorKind::Transient,
                "PUT",
                "/actions",
                &json!({ "action_type": "InstanceStart" }),
            )
            .await
        };
        self.or_kill(&vm, configure).await?;
        Ok(vm)
    }

    async fn restore(
        &self,
        spec: &VmSpec,
        files: &RestoreFiles,
    ) -> Result<FirecrackerVm, EngineError> {
        const OP: &str = "restore";
        // Checked before starting a process: a refused combination is a
        // configuration error, not a failed restore.
        check_source(&files.memory, self.memory)
            .map_err(|error| EngineError::caused_by(ErrorKind::Fatal, OP, error))?;
        let jail =
            Jail::new(spec).map_err(|error| EngineError::new(ErrorKind::Fatal, OP, error))?;
        // Saved state and memory are only read; they stay the host's, so the
        // VMM cannot change an image it restores from.
        let binary = self.binary_for(files.made_under.as_deref());
        // The guest's clock is moved on by the time the image was saved,
        // unless the image recorded no realtime clock to move it by: a VMM
        // that refused it for that is ended, and a new one loads the image
        // with the clock left as saved.
        let mut realtime = true;
        loop {
            let body = load_request(spec, &jail, files, self.memory, realtime)
                .map_err(|error| EngineError::new(ErrorKind::Fatal, OP, error))?;
            let vm = self
                .launch(spec, OP, drives::owned(&spec.drives), binary)
                .await?;
            if let MemorySource::Pager(pager) = &files.memory {
                // The host's own failure: the image is not in question.
                let started = async {
                    pager::start(pager, &vm, &spec.logs, spec.uid, spec.gid)
                        .await
                        .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))
                };
                self.or_kill(&vm, started).await?;
            }
            let Err(error) = vm.api.call("PUT", "/snapshot/load", Some(&body)).await else {
                return Ok(vm);
            };
            let again = realtime && lacks_realtime_clock(&error);
            let failed = self.ended(&vm, load_failure(error, vm.is_running())).await;
            // Only a VM that ended may be launched again; one that would not
            // end makes the failure fatal.
            if !again || failed.kind == ErrorKind::Fatal {
                return Err(failed);
            }
            realtime = false;
        }
    }

    async fn pause(&self, vm: &FirecrackerVm) -> Result<(), EngineError> {
        vm.balloon
            .pausing(vm.set_state("pause", RunState::Paused))
            .await?;
        // Idle, its guarantee goes to the VMs that run: the kernel may now
        // take its file pages before theirs. Best effort, since the pause
        // itself took effect; the next resume sets it again either way.
        // A bound asked before the pause is dropped, so none lands after,
        // and its high goes, so that a save is not slowed by it. Its swap
        // goes back to what it was launched with.
        let _ = vm.bounds.reset(|| {
            vm.cgroup.set_memory_low(0)?;
            vm.lift_high()?;
            vm.launched_zswap()
        });
        Ok(())
    }

    async fn resume(&self, vm: &FirecrackerVm) -> Result<(), EngineError> {
        vm.guard_running()
            .map_err(|error| EngineError::io("resume", error))?;
        vm.balloon
            .resuming(vm.set_state("resume", RunState::Running))
            .await
    }

    async fn compress(
        &self,
        vm: &FirecrackerVm,
        cancel: &CancellationToken,
    ) -> Result<Completion, EngineError> {
        if !self.memory.compress {
            return Err(EngineError::caused_by(
                ErrorKind::Fatal,
                "compress",
                ProfileError::CompressionDisabled,
            ));
        }
        let cgroup = vm.cgroup.clone();
        let cancel = cancel.clone();
        let finished = tokio::task::spawn_blocking(move || {
            cgroup.reclaim_to_zswap(RECLAIM_CHUNK, || cancel.is_cancelled())
        })
        .await
        .map_err(|error| EngineError::caused_by(ErrorKind::Transient, "compress", error))?
        .map_err(|error| EngineError::io("compress", error))?;
        Ok(if finished {
            Completion::Finished
        } else {
            Completion::Cancelled
        })
    }

    async fn snapshot(
        &self,
        vm: &FirecrackerVm,
        files: &SnapshotFiles,
        kind: SnapshotKind,
    ) -> Result<(), EngineError> {
        const OP: &str = "snapshot";
        // Firecracker merges a diff into an existing file of the right size,
        // so a leftover file would silently become part of this snapshot.
        for file in [&files.state, &files.memory] {
            remove_if_present(file)
                .await
                .map_err(|error| EngineError::io(OP, error))?;
        }
        vm.call(
            OP,
            ErrorKind::Transient,
            "PUT",
            "/snapshot/create",
            &create_request(&vm.jail, files, kind)
                .map_err(|error| EngineError::new(ErrorKind::Fatal, OP, error))?,
        )
        .await
    }

    async fn stop(&self, vm: FirecrackerVm) -> Result<(), EngineError> {
        self.kill(&vm).await
    }

    async fn adopt(&self, spec: &VmSpec) -> Result<Option<(FirecrackerVm, Found)>, EngineError> {
        const OP: &str = "adopt";
        let Some(vm) = self.attached(spec).await? else {
            return Ok(None);
        };
        // The pager comes first: a VMM whose pager died can be stuck on
        // guest memory and never answer its API, which alone proves nothing.
        let (vmm, group, api) = (
            vm.process.pid(),
            vm.cgroup.clone(),
            vm.api.socket().to_owned(),
        );
        let lost = tokio::task::spawn_blocking(move || pager::lost(vmm, &group, &api))
            .await
            .map_err(io::Error::other)
            .and_then(|lost| lost);
        match lost {
            Ok(false) => self.answering(vm, spec.cpu_weight).await,
            Ok(true) => {
                // Established: its next missing page would wait forever.
                self.kill(&vm).await?;
                Err(EngineError::new(
                    ErrorKind::MemoryLost,
                    OP,
                    "the VM's memory pager died while the guest still needed it",
                ))
            }
            Err(_) if !vm.is_running() => {
                self.kill(&vm).await?;
                Ok(None)
            }
            // Nothing established: the VM is left as it is.
            Err(error) => Err(EngineError::caused_by(ErrorKind::Transient, OP, error)),
        }
    }

    fn hold(
        &self,
        vm: &FirecrackerVm,
        file: OwnedFd,
    ) -> impl Future<Output = Result<(), EngineError>> + Send {
        holder::hold(vm.cgroup.clone(), JAILER_PATH, file)
    }

    fn held(
        &self,
        vm: &FirecrackerVm,
    ) -> impl Future<Output = Result<Option<OwnedFd>, EngineError>> + Send {
        let relative = self.cgroup_name(&vm.name);
        std::future::ready(holder::held(&vm.cgroup, &relative, vm.process.pid()))
    }

    async fn clean_up(&self, spec: &VmSpec) -> Result<(), EngineError> {
        self.discard(spec)
            .await
            .map_err(|error| EngineError::io("clean_up", error))
    }

    fn clean_up_left_behind(&self) -> Result<(), EngineError> {
        self.cgroups
            .remove_empty_children()
            .map_err(|error| EngineError::io("clean_up_left_behind", error))
    }

    fn memory_room(&self) -> Result<Option<u64>, EngineError> {
        // The limit as it is now, not as the agent set it: an operator may
        // lift it while the agent runs.
        let Some(high) = self
            .cgroups
            .memory_high()
            .map_err(|error| EngineError::io("memory_room", error))?
        else {
            return Ok(None);
        };
        let held = self
            .cgroups
            .memory_held()
            .map_err(|error| EngineError::io("memory_room", error))?;
        Ok(Some(high.saturating_sub(held)))
    }

    fn resident_bytes(&self, vm: &FirecrackerVm) -> Result<u64, EngineError> {
        // With huge pages, what counts is what the VM takes from the pool;
        // with base pages, what the VMM's group holds less the page cache
        // its disk and saved images left there, which the host can drop.
        match self.memory.pages {
            PageSize::Base => vm.cgroup.memory_held(),
            PageSize::Huge => vm.cgroup.huge_page_bytes(),
        }
        .map_err(|error| EngineError::io("resident_bytes", error))
    }

    fn set_guarantees(
        &self,
        vm: &FirecrackerVm,
        memory_request_mib: u32,
        cpu_weight: u16,
    ) -> Result<(), EngineError> {
        vm.cgroup
            .set_cpu_weight(cpu_weight)
            .map_err(|error| EngineError::io("set_guarantees", error))?;
        // Applied by its next resume, as every running VM's is. Its
        // out-of-memory score follows its request at once.
        let request = u64::from(memory_request_mib) << 20;
        vm.memory_low.store(request, Ordering::Release);
        vm.process
            .protect_from_oom(self.oom_score_adj(request))
            .map_err(|error| EngineError::io("set_guarantees", error))?;
        Ok(())
    }

    fn compresses_running(&self) -> bool {
        self.compress_running
    }

    fn oom_kills(&self) -> Result<Option<u64>, EngineError> {
        self.cgroups
            .oom_kills()
            .map(Some)
            .map_err(|error| EngineError::io("oom_kills", error))
    }

    fn bound_memory(
        &self,
        vm: &FirecrackerVm,
        low: u64,
        high: Option<u64>,
    ) -> Result<(), EngineError> {
        vm.bounds.ask(&vm.cgroup, low, high);
        Ok(())
    }

    fn set_memory_limit(&self, vm: &FirecrackerVm, bytes: Option<u64>) -> Result<(), EngineError> {
        vm.cgroup
            .set_memory_max(bytes)
            .map_err(|error| EngineError::io("set_memory_limit", error))
    }

    async fn resize_drives(&self, vm: &FirecrackerVm, spec: &VmSpec) -> Result<(), EngineError> {
        drives::resize(vm, spec).await
    }

    fn cpu_time(&self, vm: &FirecrackerVm) -> Result<Duration, EngineError> {
        vm.cgroup
            .cpu_time()
            .map_err(|error| EngineError::io("cpu_time", error))
    }

    fn io_bytes(&self, vm: &FirecrackerVm) -> Result<u64, EngineError> {
        vm.cgroup
            .io_bytes()
            .map_err(|error| EngineError::io("io_bytes", error))
    }

    fn writes(&self, vm: &FirecrackerVm) -> Result<Writes, EngineError> {
        vm.cgroup
            .writes()
            .map_err(|error| EngineError::io("writes", error))
    }

    fn settle_writes(
        &self,
        vm: &FirecrackerVm,
    ) -> impl Future<Output = Result<(), EngineError>> + Send + 'static {
        drives::settled(vm.api.clone())
    }

    fn memory_stats(&self, vm: &FirecrackerVm) -> Result<MemoryStats, EngineError> {
        vm.cgroup
            .memory_stats()
            .map_err(|error| EngineError::io("memory_stats", error))
    }

    fn halted(
        &self,
        vm: &FirecrackerVm,
    ) -> impl Future<Output = Result<bool, EngineError>> + Send + 'static {
        logs::halted(vm.console.clone(), vm.name.clone())
    }

    fn exited(&self, vm: &FirecrackerVm) -> impl Future<Output = ()> + Send + 'static {
        let mut exit = vm.exit_watch();
        async move {
            let _ = exit.wait_for(|exit| *exit == Exit::Exited).await;
        }
    }

    fn set_balloon(
        &self,
        vm: &FirecrackerVm,
        bytes: u64,
    ) -> impl Future<Output = Result<(), EngineError>> + Send + 'static {
        vm.balloon.set(bytes)
    }
}

impl Firecracker {
    /// The VM process left running for `spec`, without asking it anything
    /// yet. A VMM is discarded only on proof that no guest ever ran in it
    /// or that it is gone; anything less is an error and the VM is left be.
    async fn attached(&self, spec: &VmSpec) -> Result<Option<FirecrackerVm>, EngineError> {
        const OP: &str = "adopt";
        let cgroup = self.cgroup_of(spec);
        if !cgroup.path().exists() {
            return Ok(None);
        }
        let jail =
            Jail::new(spec).map_err(|error| EngineError::new(ErrorKind::Fatal, OP, error))?;
        match self.attach(spec, &jail) {
            Ok(vm) => Ok(Some(vm)),
            Err(error) => {
                // The VM's own helpers, its pager and the engine's
                // holders, may outlive its VMM; anything else may be it.
                let api = spec.api_socket();
                let besides =
                    holder::besides_holders(&cgroup, &self.cgroup_name(&spec.name), |pid| {
                        pager::certainly_pager(pid, &api)
                    })
                    .map_err(|error| EngineError::io(OP, error))?;
                if besides {
                    return Err(EngineError::new(
                        ErrorKind::Transient,
                        OP,
                        format!("a process runs in the VM's group but is not its VMM: {error}"),
                    ));
                }
                // A group with no VMM: a jailer that died half way, or a
                // VMM that exited, perhaps leaving its pager and holders.
                // No guest runs, so nothing is lost.
                self.discard(spec)
                    .await
                    .map_err(|error| EngineError::io(OP, error))?;
                Ok(None)
            }
        }
    }

    /// `vm` with what it is doing, or `None` once it is ended because it
    /// never started a guest or has exited. A VMM that runs but does not
    /// answer is left be and reported.
    async fn answering(
        &self,
        vm: FirecrackerVm,
        cpu_weight: u16,
    ) -> Result<Option<(FirecrackerVm, Found)>, EngineError> {
        const OP: &str = "adopt";
        let unsure = |why: String| EngineError::new(ErrorKind::Transient, OP, why);
        match timeout(ADOPT_TIMEOUT, vm.found()).await {
            Ok(Ok(Some(found))) => {
                // Whatever an earlier agent left behind: zswap as for the
                // state found, since a compression it ran ended with it,
                // the guarantee as for that state, and no bound of its
                // memory. Its processor share is today's for its request,
                // which an earlier agent may have rounded otherwise.
                let guarded = match found {
                    Found::Running => vm.guard_running(),
                    Found::Paused => vm.guard_paused(),
                }
                .and_then(|()| vm.cgroup.set_cpu_weight(cpu_weight));
                guarded.map_err(|error| unsure(format!("setting its guarantees: {error}")))?;
                Ok(Some((vm, found)))
            }
            // The VMM says it never started a guest: a launch cut short.
            Ok(Ok(None)) => {
                self.kill(&vm).await?;
                Ok(None)
            }
            _ if !vm.is_running() => {
                self.kill(&vm).await?;
                Ok(None)
            }
            Ok(Err(error)) => Err(unsure(format!("the VMM runs but its API failed: {error}"))),
            Err(_) => Err(unsure(format!(
                "the VMM runs but did not answer within {ADOPT_TIMEOUT:?}"
            ))),
        }
    }
}

#[cfg(test)]
mod tests;
