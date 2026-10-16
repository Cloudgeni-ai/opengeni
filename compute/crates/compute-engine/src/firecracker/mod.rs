//! The Firecracker driver.
//!
//! Every VM runs under Firecracker's jailer ([`jail`]): as its own
//! unprivileged user, chrooted to its own directory, in its own cgroup v2
//! group, PID and mount namespaces, behind Firecracker's default seccomp
//! filters. The VMM is not a child of the host agent ([`process`]), so it
//! keeps running when the agent stops or crashes, and [`Engine::adopt`]
//! takes it back.

mod api;
mod jail;
mod process;

use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::net::UnixStream;
use tokio::process::Command;
use tokio::sync::watch;
use tokio::time::{Instant, sleep, timeout};

use self::api::Api;
pub use self::api::ApiError;
pub use self::jail::BINARY_NAME;
use self::jail::{API_SOCKET, Jail, LAUNCH_LEFTOVERS, Launch, PID_FILE, jailer_args};
pub use self::process::Exit;
use self::process::{Process, in_cgroup, parse_pid};
use crate::cgroup::Cgroup;
use crate::error::{EngineError, ErrorKind};
use crate::profile::{MemoryProfile, PageSize, ProfileError};
use crate::spec::{MemorySource, PagedMemory, RestoreFiles, SnapshotFiles, SnapshotKind, VmSpec};
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

/// The kernel command line to boot with: the caller's, plus [`CLOCK_SOURCE`]
/// if it names no clock source of its own.
fn boot_args(requested: &str) -> String {
    if requested
        .split_whitespace()
        .any(|arg| arg.starts_with("clocksource="))
    {
        requested.to_owned()
    } else if requested.trim().is_empty() {
        CLOCK_SOURCE.to_owned()
    } else {
        format!("{} {CLOCK_SOURCE}", requested.trim_end())
    }
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

/// The `/snapshot/load` request for restoring `files` as the VM in `spec`.
///
/// Host-side paths and devices are taken from `spec`, not from the snapshot, so
/// a snapshot restores the same way on another host or in another directory.
/// Paths are the ones the jailed VMM sees. Page size and dirty tracking come
/// from this host's profile, not from the host that took the snapshot: the
/// image is plain memory either way. The profile must already allow
/// `files.memory` (see [`check_source`]).
fn load_request(
    spec: &VmSpec,
    jail: &Jail,
    files: &RestoreFiles,
    profile: MemoryProfile,
) -> Result<Value, String> {
    let backend = match &files.memory {
        MemorySource::File(path) => {
            json!({ "backend_type": "File", "backend_path": jail.inside(path)? })
        }
        MemorySource::Pager(socket) => {
            json!({ "backend_type": "Uffd", "backend_path": jail.inside(socket)? })
        }
    };
    let mut body = json!({
        "snapshot_path": jail.inside(&files.state)?,
        "mem_backend": backend,
        "huge_pages": huge_pages(profile.pages),
        "track_dirty_pages": profile.tracks_dirty_pages(),
        "resume_vm": false,
        "clock_realtime": true,
        "vsock_override": { "uds_path": jail.inside(&spec.vsock_path())? },
    });
    if let Some(network) = &spec.network {
        body["network_overrides"] = json!([{ "iface_id": "eth0", "host_dev_name": network.tap }]);
    }
    Ok(body)
}

/// Refuses memory sources the profile cannot back: Firecracker maps
/// huge-page memory only through a fault handler.
fn check_source(memory: &MemorySource, profile: MemoryProfile) -> Result<(), ProfileError> {
    match memory {
        MemorySource::File(_) if profile.needs_pager() => Err(ProfileError::FileBackedHugePages),
        _ => Ok(()),
    }
}

/// The `/snapshot/create` request writing `files`, as the jailed VMM sees
/// them.
fn create_request(jail: &Jail, files: &SnapshotFiles, kind: SnapshotKind) -> Result<Value, String> {
    Ok(json!({
        "snapshot_type": match kind {
            SnapshotKind::Diff => "Diff",
            SnapshotKind::Full => "Full",
        },
        "snapshot_path": jail.inside(&files.state)?,
        "mem_file_path": jail.inside(&files.memory)?,
        "sync_snapshot_files": true,
    }))
}

/// How [`Firecracker`] runs VMs.
#[derive(Clone, Debug)]
pub struct FirecrackerConfig {
    /// The Firecracker binary. Its file name must be [`BINARY_NAME`].
    pub firecracker: PathBuf,
    /// The jailer binary from the same Firecracker release.
    pub jailer: PathBuf,
    /// Parent of every VM's own cgroup. It must sit inside the cgroup v2
    /// hierarchy with the memory and CPU controllers available.
    pub cgroup_parent: PathBuf,
}

/// Runs VMs with Firecracker, each under its jailer.
#[derive(Clone, Debug)]
pub struct Firecracker {
    binary: PathBuf,
    jailer: PathBuf,
    cgroups: Cgroup,
    /// `cgroups` relative to the cgroup v2 mount, as the jailer names it.
    cgroup_relative: PathBuf,
    startup_timeout: Duration,
    memory: MemoryProfile,
}

impl Firecracker {
    /// Checks `config` and creates the parent cgroup.
    /// VMs use the bare-metal memory profile unless
    /// [`Firecracker::with_memory_profile`] says otherwise.
    pub fn new(config: FirecrackerConfig) -> io::Result<Self> {
        if config
            .firecracker
            .file_name()
            .is_none_or(|name| name != BINARY_NAME)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "the Firecracker binary must be named {BINARY_NAME}, not {}",
                    config.firecracker.display()
                ),
            ));
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
        Ok(Self {
            binary: config.firecracker,
            jailer: config.jailer,
            cgroups: Cgroup::create_parent(config.cgroup_parent)?,
            cgroup_relative,
            startup_timeout: Duration::from_secs(5),
            memory: MemoryProfile::bare_metal(),
        })
    }

    /// Backs, saves and compresses every VM's memory as `profile` says.
    /// Refuses an unsafe profile.
    pub fn with_memory_profile(mut self, profile: MemoryProfile) -> Result<Self, ProfileError> {
        self.memory = profile.validate()?;
        Ok(self)
    }

    /// The VM's own cgroup; it exists only while the jailer's work does.
    fn cgroup_of(&self, spec: &VmSpec) -> Cgroup {
        Cgroup::at(self.cgroups.path().join(&spec.name))
    }

    /// The VM's cgroup as `/proc/<pid>/cgroup` shows it.
    fn cgroup_name(&self, spec: &VmSpec) -> PathBuf {
        Path::new("/").join(&self.cgroup_relative).join(&spec.name)
    }

    /// Starts a jailed VMM for `spec` and waits for its API. `owned` are
    /// files the VMM must be able to write, such as its drives; they are
    /// handed to the VM's user first.
    async fn launch(
        &self,
        spec: &VmSpec,
        operation: &'static str,
        owned: Vec<PathBuf>,
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
                binary: &self.binary,
                cgroup_parent: &self.cgroup_relative,
                netns: netns.as_deref(),
            },
        );
        let (console, log) = {
            let (jail, logs, uid, gid) = (jail.clone(), spec.logs.clone(), spec.uid, spec.gid);
            tokio::task::spawn_blocking(move || prepare(&jail, &logs, &owned, uid, gid))
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
        // SAFETY: the closure runs in the forked child before exec and makes
        // one setsid(2) call, which is async-signal-safe. A new session keeps
        // the jailer, and through it Firecracker, away from the agent's
        // terminal and process group, so signals aimed at the agent (such as
        // Ctrl-C) never reach a VM.
        unsafe {
            command.pre_exec(|| rustix::process::setsid().map(drop).map_err(io::Error::from));
        }
        let mut jailer = command
            .spawn()
            .map_err(|error| EngineError::io(operation, error))?;
        // The jailer exits as soon as Firecracker runs in its new PID
        // namespace; Firecracker is then nobody's child but init's.
        let Ok(status) = timeout(JAILER_TIMEOUT, jailer.wait()).await else {
            let _ = jailer.kill().await;
            let _ = self.discard(spec).await;
            return Err(EngineError::new(
                ErrorKind::Transient,
                operation,
                format!("the jailer did not finish within {JAILER_TIMEOUT:?}"),
            ));
        };
        let status = status.map_err(|error| EngineError::io(operation, error))?;
        if !status.success() {
            let _ = self.discard(spec).await;
            return Err(EngineError::new(
                ErrorKind::Transient,
                operation,
                format!(
                    "the jailer failed ({status}); see {}",
                    spec.logs.join("vmm.log").display()
                ),
            ));
        }
        let vm = match self.attach(spec, &jail) {
            Ok(vm) => vm,
            Err(error) => {
                let _ = self.discard(spec).await;
                return Err(EngineError::new(ErrorKind::Transient, operation, error));
            }
        };
        if let Err(error) = vm.wait_for_api(self.startup_timeout).await {
            self.kill(&vm).await;
            return Err(EngineError::new(ErrorKind::Transient, operation, error));
        }
        Ok(vm)
    }

    /// Pins the VMM the jailer started for `spec`: the process named by the
    /// jail's pid file, if it lives in the VM's own cgroup.
    fn attach(&self, spec: &VmSpec, jail: &Jail) -> Result<FirecrackerVm, String> {
        let pid_file = jail.root().join(PID_FILE);
        let text = fs::read_to_string(&pid_file)
            .map_err(|error| format!("reading {}: {error}", pid_file.display()))?;
        let pid = parse_pid(&text).ok_or_else(|| format!("bad pid file {text:?}"))?;
        let process = Process::open(pid).map_err(|error| format!("pidfd for {pid:?}: {error}"))?;
        // Checked after pinning: had the VMM exited and its pid been reused
        // before the pidfd was opened, the new process would not be in the
        // VM's cgroup.
        let cgroup = self.cgroup_name(spec);
        if !in_cgroup(pid, &cgroup).map_err(|error| error.to_string())? || !process.is_running() {
            return Err(format!(
                "process {} is not the VMM in {}",
                pid.as_raw_pid(),
                cgroup.display()
            ));
        }
        Ok(FirecrackerVm {
            name: spec.name.clone(),
            process,
            api: Api::new(spec.api_socket()),
            cgroup: self.cgroup_of(spec),
            jail: jail.clone(),
        })
    }

    /// Kills the VMM, waits for it to exit and releases its cgroup and the
    /// jailer's per-launch files.
    async fn kill(&self, vm: &FirecrackerVm) {
        // A pidfd only ever signals its own process, even if it is gone.
        let _ = vm.process.kill();
        vm.process.exited().await;
        let (cgroup, jail) = (vm.cgroup.clone(), vm.jail.clone());
        let _ = tokio::task::spawn_blocking(move || {
            let _ = cgroup.remove();
            tidy(&jail)
        })
        .await;
    }

    /// Kills whatever runs in the VM's cgroup, for VMMs the host holds no
    /// pidfd for, and releases it like [`Self::kill`].
    async fn discard(&self, spec: &VmSpec) -> io::Result<()> {
        let cgroup = self.cgroup_of(spec);
        let jail = Jail::new(spec).ok();
        tokio::task::spawn_blocking(move || {
            cgroup.kill_all()?;
            let mut delay = Duration::from_millis(1);
            for _ in 0..12 {
                if !cgroup.is_populated()? {
                    break;
                }
                std::thread::sleep(delay);
                delay *= 2;
            }
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
        let result = body.await;
        if result.is_err() {
            self.kill(vm).await;
        }
        result
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
    logs: &Path,
    owned: &[PathBuf],
    uid: u32,
    gid: u32,
) -> io::Result<(File, File)> {
    fs::create_dir_all(jail.root())?;
    tidy(jail)?;
    for path in owned {
        std::os::unix::fs::chown(path, Some(uid), Some(gid))?;
    }
    fs::create_dir_all(logs)?;
    Ok((
        File::create(logs.join("console.log"))?,
        File::create(logs.join("vmm.log"))?,
    ))
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
            if UnixStream::connect(self.api.socket()).await.is_ok() {
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

    /// Pauses or resumes the processors; see [`set_run_state`].
    async fn set_state(&self, operation: &'static str, run: RunState) -> Result<(), EngineError> {
        set_run_state(&self.api, || self.is_running(), operation, run).await
    }
}

/// Pauses or resumes the processors so that a failure always means nothing
/// changed. A request refused or never sent is a transient failure. A
/// request whose answer was lost or late may still have taken effect, so the
/// VMM is asked which state the VM is in. It answers requests one at a time,
/// so once it answers, the earlier request has either taken effect or never
/// will. If it cannot say in time, the VM is beyond control and counts as
/// lost, since its guest may or may not be running.
async fn set_run_state(
    api: &Api,
    alive: impl Fn() -> bool,
    operation: &'static str,
    run: RunState,
) -> Result<(), EngineError> {
    let body = json!({ "state": run.request() });
    let error = match api.call("PATCH", "/vm", Some(&body)).await {
        Ok(_) => return Ok(()),
        Err(error @ (ApiError::Connect(_) | ApiError::Status { .. })) if alive() => {
            return Err(EngineError::caused_by(
                ErrorKind::Transient,
                operation,
                error,
            ));
        }
        Err(error) => error,
    };
    let reported = api
        .call("GET", "/", None)
        .await
        .ok()
        .and_then(|body| serde_json::from_slice::<Value>(&body).ok())
        .and_then(|info| info.get("state")?.as_str().map(str::to_owned));
    match reported.as_deref() {
        Some(state) if state == run.reported() => Ok(()),
        Some(_) if alive() => Err(EngineError::caused_by(
            ErrorKind::Transient,
            operation,
            error,
        )),
        _ if !alive() => Err(EngineError::new(
            ErrorKind::MemoryLost,
            operation,
            "the VMM process has exited",
        )),
        _ => Err(EngineError::caused_by(
            ErrorKind::MemoryLost,
            operation,
            error,
        )),
    }
}

/// The processor state asked of the VMM.
#[derive(Clone, Copy)]
enum RunState {
    Paused,
    Running,
}

impl RunState {
    /// The value `PATCH /vm` takes.
    const fn request(self) -> &'static str {
        match self {
            Self::Paused => "Paused",
            Self::Running => "Resumed",
        }
    }

    /// The value `GET /` reports once the change took effect.
    const fn reported(self) -> &'static str {
        match self {
            Self::Paused => "Paused",
            Self::Running => "Running",
        }
    }
}

impl Engine for Firecracker {
    type Vm = FirecrackerVm;

    fn memory_profile(&self) -> MemoryProfile {
        self.memory
    }

    async fn boot(&self, spec: &VmSpec) -> Result<FirecrackerVm, EngineError> {
        const OP: &str = "boot";
        let owned = spec
            .drives
            .iter()
            .filter(|drive| !drive.read_only)
            .map(|drive| drive.path.clone())
            .collect();
        let vm = self.launch(spec, OP, owned).await?;
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
                    "boot_args": boot_args(&spec.boot_args),
                }),
            )
            .await?;
            for drive in &spec.drives {
                vm.call(
                    OP,
                    ErrorKind::Fatal,
                    "PUT",
                    &format!("/drives/{}", drive.id),
                    &json!({
                        "drive_id": drive.id,
                        "path_on_host": vm.inside(OP, &drive.path)?,
                        "is_root_device": drive.root,
                        "is_read_only": drive.read_only,
                    }),
                )
                .await?;
            }
            put("/machine-config", machine_config(spec, self.memory)).await?;
            if spec.free_page_reporting {
                put(
                    "/balloon",
                    json!({
                        "amount_mib": 0,
                        "deflate_on_oom": true,
                        "stats_polling_interval_s": 0,
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
        let body = load_request(spec, &jail, files, self.memory)
            .map_err(|error| EngineError::new(ErrorKind::Fatal, OP, error))?;
        let mut owned: Vec<PathBuf> = spec
            .drives
            .iter()
            .filter(|drive| !drive.read_only)
            .map(|drive| drive.path.clone())
            .collect();
        // Saved state and memory are only read; they stay the host's, so the
        // VMM cannot change an image it restores from. A pager's socket must
        // be the VMM's to connect to.
        if let MemorySource::Pager(socket) = &files.memory {
            owned.push(socket.clone());
        }
        let vm = self.launch(spec, OP, owned).await?;
        // A rejected image means the memory state is unusable; the disk is not
        // involved.
        let load = vm.call(OP, ErrorKind::MemoryLost, "PUT", "/snapshot/load", &body);
        self.or_kill(&vm, load).await?;
        Ok(vm)
    }

    async fn pause(&self, vm: &FirecrackerVm) -> Result<(), EngineError> {
        vm.set_state("pause", RunState::Paused).await
    }

    async fn resume(&self, vm: &FirecrackerVm) -> Result<(), EngineError> {
        vm.set_state("resume", RunState::Running).await
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
        self.kill(&vm).await;
        Ok(())
    }

    async fn adopt(&self, spec: &VmSpec) -> Result<Option<(FirecrackerVm, Found)>, EngineError> {
        const OP: &str = "adopt";
        let cgroup = self.cgroup_of(spec);
        if !cgroup.path().exists() {
            return Ok(None);
        }
        let jail =
            Jail::new(spec).map_err(|error| EngineError::new(ErrorKind::Fatal, OP, error))?;
        let Ok(vm) = self.attach(spec, &jail) else {
            // Whatever is left (a jailer that died half way, an empty
            // group) is of no use.
            self.discard(spec)
                .await
                .map_err(|error| EngineError::io(OP, error))?;
            return Ok(None);
        };
        if let Ok(Ok(Some(found))) = timeout(ADOPT_TIMEOUT, vm.found()).await {
            Ok(Some((vm, found)))
        } else {
            // It never finished starting, or it does not answer.
            self.kill(&vm).await;
            Ok(None)
        }
    }

    async fn clean_up(&self, spec: &VmSpec) -> Result<(), EngineError> {
        self.discard(spec)
            .await
            .map_err(|error| EngineError::io("clean_up", error))
    }

    fn resident_bytes(&self, vm: &FirecrackerVm) -> Result<u64, EngineError> {
        vm.cgroup
            .memory_current()
            .map_err(|error| EngineError::io("resident_bytes", error))
    }

    fn cpu_time(&self, vm: &FirecrackerVm) -> Result<Duration, EngineError> {
        vm.cgroup
            .cpu_time()
            .map_err(|error| EngineError::io("cpu_time", error))
    }

    fn paged_memory(&self, vm: &FirecrackerVm) -> Result<PagedMemory, EngineError> {
        let (uffd, vmm) = vm
            .process
            .paged_memory()
            .map_err(|error| EngineError::io("paged_memory", error))?;
        Ok(PagedMemory { uffd, vmm })
    }

    fn exited(&self, vm: &FirecrackerVm) -> impl Future<Output = ()> + Send + 'static {
        let mut exit = vm.exit_watch();
        async move {
            let _ = exit.wait_for(|exit| *exit == Exit::Exited).await;
        }
    }
}

async fn remove_if_present(path: &Path) -> io::Result<()> {
    match tokio::fs::remove_file(path).await {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::Network;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixListener;

    /// A VMM API that answers `PATCH /vm` with `patch` and `GET /` with
    /// `get`.
    fn vmm(patch: Answer, get: Answer) -> (Socket, Api) {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let socket = std::env::temp_dir().join(format!(
            "compute-engine-vmm-{}-{}.sock",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket).unwrap();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut request = vec![0_u8; 4096];
                let read = stream.read(&mut request).await.unwrap_or(0);
                let answer = if request[..read].starts_with(b"PATCH") {
                    patch
                } else {
                    get
                };
                match answer {
                    Answer::Reply(reply) => {
                        let _ = stream.write_all(reply.as_bytes()).await;
                    }
                    Answer::Close => {}
                    Answer::Hang => {
                        tokio::spawn(async move {
                            let _open = stream;
                            std::future::pending::<()>().await;
                        });
                    }
                }
            }
        });
        let limit = Duration::from_millis(200);
        let api = Api::new(&socket).with_limits(limit, limit);
        (Socket(socket), api)
    }

    /// How the fake VMM answers a request.
    #[derive(Clone, Copy)]
    enum Answer {
        Reply(&'static str),
        /// Drops the connection without answering.
        Close,
        /// Keeps the connection open and never answers.
        Hang,
    }

    /// Removes the socket file when the test ends.
    struct Socket(PathBuf);

    impl Drop for Socket {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    const NO_CONTENT: &str = "HTTP/1.1 204 \r\n\r\n";
    const REFUSED: &str = "HTTP/1.1 400 \r\ncontent-length: 2\r\n\r\n{}";
    const RUNNING: &str = "HTTP/1.1 200 \r\ncontent-length: 19\r\n\r\n{\"state\":\"Running\"}";
    const PAUSED: &str = "HTTP/1.1 200 \r\ncontent-length: 18\r\n\r\n{\"state\":\"Paused\"}";

    async fn resume(api: &Api, alive: bool) -> Result<(), ErrorKind> {
        set_run_state(api, || alive, "resume", RunState::Running)
            .await
            .map_err(|error| error.kind)
    }

    #[tokio::test]
    async fn a_run_state_change_fails_only_when_nothing_changed() {
        use Answer::{Close, Hang, Reply};
        let (_s1, api) = vmm(Reply(NO_CONTENT), Close);
        assert_eq!(resume(&api, true).await, Ok(()));
        let (_s2, api) = vmm(Reply(REFUSED), Reply(PAUSED));
        assert_eq!(
            resume(&api, true).await,
            Err(ErrorKind::Transient),
            "refused"
        );
        // The answer is lost: the VMM says what actually happened.
        let (_s3, api) = vmm(Close, Reply(RUNNING));
        assert_eq!(resume(&api, true).await, Ok(()), "it did resume");
        let (_s4, api) = vmm(Close, Reply(PAUSED));
        assert_eq!(resume(&api, true).await, Err(ErrorKind::Transient));
        // The answer is late: likewise.
        let (_s5, api) = vmm(Hang, Reply(RUNNING));
        assert_eq!(resume(&api, true).await, Ok(()), "it did resume");
        // Nobody can say whether the guest ran.
        let (_s6, api) = vmm(Close, Close);
        assert_eq!(resume(&api, true).await, Err(ErrorKind::MemoryLost));
        assert_eq!(resume(&api, false).await, Err(ErrorKind::MemoryLost));
        // A VMM that stops answering is beyond control, and noticing that
        // takes no longer than the deadlines.
        let (_s7, api) = vmm(Hang, Hang);
        let started = std::time::Instant::now();
        assert_eq!(resume(&api, true).await, Err(ErrorKind::MemoryLost));
        assert!(started.elapsed() < Duration::from_secs(2));
        // Never sent: nothing changed.
        let gone = Api::new(std::env::temp_dir().join("compute-engine-no-such-vmm.sock"));
        assert_eq!(resume(&gone, true).await, Err(ErrorKind::Transient));
    }

    #[test]
    fn boot_pins_the_clock_source_restore_can_correct() {
        assert_eq!(
            boot_args("console=ttyS0 quiet"),
            "console=ttyS0 quiet clocksource=kvm-clock"
        );
        assert_eq!(boot_args(""), "clocksource=kvm-clock");
        assert_eq!(
            boot_args("console=ttyS0 clocksource=tsc"),
            "console=ttyS0 clocksource=tsc"
        );
    }

    #[test]
    fn restore_takes_host_paths_from_the_spec_not_the_snapshot() {
        let jail_dir = "/lab/vm/firecracker/a/root";
        let mut spec = VmSpec {
            name: "a".into(),
            dir: jail_dir.into(),
            logs: "/lab/vm/firecracker/a".into(),
            uid: 4_000_000,
            gid: 4_000_000,
            vcpus: 1,
            memory_mib: 512,
            kernel: format!("{jail_dir}/vmlinux").into(),
            boot_args: String::new(),
            drives: Vec::new(),
            network: None,
            free_page_reporting: true,
        };
        let files = RestoreFiles {
            state: format!("{jail_dir}/vm.state").into(),
            memory: MemorySource::File(format!("{jail_dir}/vm.mem").into()),
        };
        let jail = Jail::new(&spec).unwrap();
        let bare = MemoryProfile::bare_metal();
        let body = load_request(&spec, &jail, &files, bare).unwrap();
        assert_eq!(body["clock_realtime"], true);
        assert_eq!(body["resume_vm"], false);
        assert_eq!(body["snapshot_path"], "/vm.state");
        assert_eq!(body["mem_backend"]["backend_path"], "/vm.mem");
        assert_eq!(body["vsock_override"]["uds_path"], "/vsock.sock");
        assert!(body.get("network_overrides").is_none());

        spec.network = Some(Network {
            tap: "tap0".into(),
            mac: "06:00:ac:10:00:02".into(),
            namespace: None,
        });
        let body = load_request(&spec, &jail, &files, bare).unwrap();
        assert_eq!(
            body["network_overrides"],
            json!([{ "iface_id": "eth0", "host_dev_name": "tap0" }])
        );

        let outside = RestoreFiles {
            state: "/elsewhere/vm.state".into(),
            memory: MemorySource::File(format!("{jail_dir}/vm.mem").into()),
        };
        assert!(load_request(&spec, &jail, &outside, bare).is_err());
    }

    fn spec() -> VmSpec {
        VmSpec {
            name: "a".into(),
            dir: "/lab/vm/firecracker/a/root".into(),
            logs: "/lab/vm/firecracker/a".into(),
            uid: 4_000_000,
            gid: 4_000_000,
            vcpus: 2,
            memory_mib: 512,
            kernel: "/lab/vm/firecracker/a/root/vmlinux".into(),
            boot_args: String::new(),
            drives: Vec::new(),
            network: None,
            free_page_reporting: true,
        }
    }

    #[test]
    fn the_profile_decides_page_size_and_dirty_tracking() {
        let bare = machine_config(&spec(), MemoryProfile::bare_metal());
        assert_eq!(bare["track_dirty_pages"], true);
        assert_eq!(bare["huge_pages"], "None");
        let nested = machine_config(&spec(), MemoryProfile::nested());
        assert_eq!(nested["track_dirty_pages"], false);
        assert_eq!(nested["huge_pages"], "2M");

        let jail = Jail::new(&spec()).unwrap();
        let paged = RestoreFiles {
            state: "/lab/vm/firecracker/a/root/vm.state".into(),
            memory: MemorySource::Pager("/lab/vm/firecracker/a/root/uffd.sock".into()),
        };
        let body = load_request(&spec(), &jail, &paged, MemoryProfile::nested()).unwrap();
        assert_eq!(body["mem_backend"]["backend_type"], "Uffd");
        assert_eq!(body["mem_backend"]["backend_path"], "/uffd.sock");
        assert_eq!(body["huge_pages"], "2M");
        assert_eq!(body["track_dirty_pages"], false);
        let body = load_request(&spec(), &jail, &paged, MemoryProfile::bare_metal()).unwrap();
        assert_eq!(body["huge_pages"], "None");
        assert_eq!(body["track_dirty_pages"], true);
    }

    #[test]
    fn huge_pages_are_never_restored_from_a_mapped_file() {
        let mapped = MemorySource::File("/lab/vm/firecracker/a/root/vm.mem".into());
        assert_eq!(
            check_source(&mapped, MemoryProfile::nested()),
            Err(ProfileError::FileBackedHugePages)
        );
        assert_eq!(check_source(&mapped, MemoryProfile::bare_metal()), Ok(()));
        let paged = MemorySource::Pager("/lab/vm/firecracker/a/root/uffd.sock".into());
        assert_eq!(check_source(&paged, MemoryProfile::nested()), Ok(()));
    }

    #[test]
    fn snapshots_are_durable_and_name_their_kind() {
        let jail = Jail::new(&spec()).unwrap();
        let files = SnapshotFiles {
            state: "/lab/vm/firecracker/a/root/diff.state".into(),
            memory: "/lab/vm/firecracker/a/root/diff.mem".into(),
        };
        let diff = create_request(&jail, &files, SnapshotKind::Diff).unwrap();
        assert_eq!(diff["snapshot_type"], "Diff");
        assert_eq!(diff["sync_snapshot_files"], true);
        assert_eq!(diff["mem_file_path"], "/diff.mem");
        assert_eq!(
            create_request(&jail, &files, SnapshotKind::Full).unwrap()["snapshot_type"],
            "Full"
        );
    }
}
