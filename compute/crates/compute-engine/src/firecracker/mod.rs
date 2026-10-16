//! The Firecracker driver: one VMM process and one cgroup per VM.

mod api;

use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::{AsRawFd, BorrowedFd};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use rustix::process::{Pid, Signal};
use serde_json::{Value, json};
use tokio::net::UnixStream;
use tokio::process::Command;
use tokio::sync::watch;
use tokio::time::{Instant, sleep};

use self::api::Api;
pub use self::api::ApiError;
use crate::cgroup::Cgroup;
use crate::error::{EngineError, ErrorKind};
use crate::spec::{SnapshotFiles, VmSpec};
use crate::{CancellationToken, Completion, Engine};

/// Memory pushed to compressed RAM per reclaim request. Small enough that a
/// wake arriving mid-compression waits only a few milliseconds.
const RECLAIM_CHUNK: u64 = 16 << 20;

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

/// The `/snapshot/load` request for restoring `files` as the VM in `spec`.
///
/// Host-side paths and devices are taken from `spec`, not from the snapshot, so
/// a snapshot restores the same way on another host or in another directory.
fn load_request(spec: &VmSpec, files: &SnapshotFiles) -> Value {
    let mut body = json!({
        "snapshot_path": files.state,
        "mem_backend": { "backend_type": "File", "backend_path": files.memory },
        "resume_vm": false,
        "clock_realtime": true,
        "vsock_override": { "uds_path": spec.vsock_path() },
    });
    if let Some(network) = &spec.network {
        body["network_overrides"] = json!([{ "iface_id": "eth0", "host_dev_name": network.tap }]);
    }
    body
}

/// Whether a VMM process is still alive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exit {
    /// Still running.
    Running,
    /// Ended; the status is unknown if waiting for it failed.
    Exited(Option<ExitStatus>),
}

/// Runs VMs with Firecracker.
#[derive(Clone, Debug)]
pub struct Firecracker {
    binary: PathBuf,
    cgroups: Cgroup,
    startup_timeout: Duration,
}

impl Firecracker {
    /// Uses the `binary` executable and creates one cgroup per VM under
    /// `cgroup_parent`, which must sit inside a cgroup v2 hierarchy with the
    /// memory and CPU controllers available.
    pub fn new(binary: impl Into<PathBuf>, cgroup_parent: impl Into<PathBuf>) -> io::Result<Self> {
        Ok(Self {
            binary: binary.into(),
            cgroups: Cgroup::create_parent(cgroup_parent)?,
            startup_timeout: Duration::from_secs(5),
        })
    }

    /// Starts a VMM process inside the VM's cgroup and waits for its API.
    async fn launch(
        &self,
        spec: &VmSpec,
        operation: &'static str,
    ) -> Result<FirecrackerVm, EngineError> {
        let io_error = |error| EngineError::io(operation, error);
        tokio::fs::create_dir_all(&spec.dir)
            .await
            .map_err(io_error)?;
        for socket in [spec.api_socket(), spec.vsock_path()] {
            remove_if_present(&socket).await.map_err(io_error)?;
        }
        let cgroup = self.cgroups.child(&spec.name).map_err(io_error)?;
        let procs = OpenOptions::new()
            .write(true)
            .open(cgroup.path().join("cgroup.procs"))
            .map_err(io_error)?;
        let console = File::create(spec.dir.join("console.log")).map_err(io_error)?;
        let log = File::create(spec.dir.join("vmm.log")).map_err(io_error)?;

        let mut command = Command::new(&self.binary);
        command
            .arg("--api-sock")
            .arg(spec.api_socket())
            .arg("--id")
            .arg(&spec.name)
            .stdin(Stdio::null())
            .stdout(console)
            .stderr(log);
        let procs_fd = procs.as_raw_fd();
        // SAFETY: the closure runs in the forked child before exec and makes a
        // single write(2) call, which is async-signal-safe. `procs` stays open
        // in the parent until spawn returns, so the descriptor is valid in the
        // child. Writing "0" moves the writer into the cgroup, so the VMM starts
        // inside it and every page it allocates is charged to this VM.
        unsafe {
            command.pre_exec(move || {
                let fd = BorrowedFd::borrow_raw(procs_fd);
                rustix::io::write(fd, b"0")
                    .map(drop)
                    .map_err(io::Error::from)
            });
        }
        let mut child = command.spawn().map_err(io_error)?;
        drop(procs);
        let pid = child
            .id()
            .and_then(|id| i32::try_from(id).ok())
            .and_then(Pid::from_raw)
            .ok_or_else(|| {
                EngineError::new(ErrorKind::Transient, operation, "VMM exited at once")
            })?;
        let (exit_tx, exit) = watch::channel(Exit::Running);
        tokio::spawn(async move {
            let status = child.wait().await.ok();
            let _ = exit_tx.send(Exit::Exited(status));
        });
        let vm = FirecrackerVm {
            name: spec.name.clone(),
            pid,
            api: Api::new(spec.api_socket()),
            cgroup,
            exit,
        };
        if let Err(error) = vm.wait_for_api(self.startup_timeout).await {
            self.kill(&vm).await;
            return Err(EngineError::new(ErrorKind::Transient, operation, error));
        }
        Ok(vm)
    }

    /// Kills the VMM, waits for it to exit and removes its cgroup.
    async fn kill(&self, vm: &FirecrackerVm) {
        if vm.is_running() {
            // The reaper has not collected the process yet, so the pid cannot
            // have been reused.
            let _ = rustix::process::kill_process(vm.pid, Signal::KILL);
        }
        vm.exited().await;
        let cgroup = vm.cgroup.clone();
        let _ = tokio::task::spawn_blocking(move || cgroup.remove()).await;
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

/// A running Firecracker VM.
#[derive(Debug)]
pub struct FirecrackerVm {
    name: String,
    pid: Pid,
    api: Api,
    cgroup: Cgroup,
    exit: watch::Receiver<Exit>,
}

impl FirecrackerVm {
    /// The VM's name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The VMM process id.
    #[must_use]
    pub fn pid(&self) -> i32 {
        self.pid.as_raw_nonzero().get()
    }

    /// The VM's cgroup.
    #[must_use]
    pub fn cgroup(&self) -> &Cgroup {
        &self.cgroup
    }

    /// Whether the VMM process is still alive.
    #[must_use]
    pub fn is_running(&self) -> bool {
        *self.exit.borrow() == Exit::Running
    }

    /// A watch that changes once the VMM process exits for any reason, so
    /// the host can notice a VM dying on its own.
    #[must_use]
    pub fn exit_watch(&self) -> watch::Receiver<Exit> {
        self.exit.clone()
    }

    /// Resolves once the VMM process has exited.
    pub async fn exited(&self) -> Exit {
        let mut exit = self.exit.clone();
        exit.wait_for(|exit| *exit != Exit::Running)
            .await
            .map_or(Exit::Exited(None), |exit| *exit)
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

    async fn boot(&self, spec: &VmSpec) -> Result<FirecrackerVm, EngineError> {
        const OP: &str = "boot";
        let vm = self.launch(spec, OP).await?;
        let configure = async {
            // A rejected configuration will not fix itself: fatal.
            let put = |path: &'static str, body: Value| {
                let vm = &vm;
                async move { vm.call(OP, ErrorKind::Fatal, "PUT", path, &body).await }
            };
            put(
                "/boot-source",
                json!({ "kernel_image_path": spec.kernel, "boot_args": boot_args(&spec.boot_args) }),
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
                        "path_on_host": drive.path,
                        "is_root_device": drive.root,
                        "is_read_only": drive.read_only,
                    }),
                )
                .await?;
            }
            put(
                "/machine-config",
                json!({ "vcpu_count": spec.vcpus, "mem_size_mib": spec.memory_mib, "smt": false }),
            )
            .await?;
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
                json!({ "guest_cid": 3, "uds_path": spec.vsock_path() }),
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
        files: &SnapshotFiles,
    ) -> Result<FirecrackerVm, EngineError> {
        const OP: &str = "restore";
        let vm = self.launch(spec, OP).await?;
        // A rejected image means the memory state is unusable; the disk is not
        // involved.
        let body = load_request(spec, files);
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

    async fn snapshot(&self, vm: &FirecrackerVm, files: &SnapshotFiles) -> Result<(), EngineError> {
        const OP: &str = "snapshot";
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
            &json!({
                "snapshot_type": "Full",
                "snapshot_path": files.state,
                "mem_file_path": files.memory,
            }),
        )
        .await
    }

    async fn stop(&self, vm: FirecrackerVm) -> Result<(), EngineError> {
        self.kill(&vm).await;
        Ok(())
    }

    async fn clean_up(&self, spec: &VmSpec) -> Result<(), EngineError> {
        const OP: &str = "clean_up";
        let cgroup = self
            .cgroups
            .child(&spec.name)
            .map_err(|error| EngineError::io(OP, error))?;
        tokio::task::spawn_blocking(move || -> io::Result<()> {
            cgroup.kill_all()?;
            let mut delay = Duration::from_millis(1);
            for _ in 0..12 {
                if !cgroup.is_populated()? {
                    break;
                }
                std::thread::sleep(delay);
                delay *= 2;
            }
            cgroup.remove()
        })
        .await
        .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))?
        .map_err(|error| EngineError::io(OP, error))?;
        for socket in [spec.api_socket(), spec.vsock_path()] {
            remove_if_present(&socket)
                .await
                .map_err(|error| EngineError::io(OP, error))?;
        }
        Ok(())
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

    fn exited(&self, vm: &FirecrackerVm) -> impl Future<Output = ()> + Send + 'static {
        let mut exit = vm.exit.clone();
        async move {
            let _ = exit.wait_for(|exit| *exit != Exit::Running).await;
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
        let mut spec = VmSpec {
            name: "a".into(),
            dir: "/lab/a".into(),
            vcpus: 1,
            memory_mib: 512,
            kernel: "/lab/vmlinux".into(),
            boot_args: String::new(),
            drives: Vec::new(),
            network: None,
            free_page_reporting: true,
        };
        let files = SnapshotFiles {
            state: "/lab/a/vm.state".into(),
            memory: "/lab/a/vm.mem".into(),
        };
        let body = load_request(&spec, &files);
        assert_eq!(body["clock_realtime"], true);
        assert_eq!(body["resume_vm"], false);
        assert_eq!(body["vsock_override"]["uds_path"], "/lab/a/vsock.sock");
        assert!(body.get("network_overrides").is_none());

        spec.network = Some(Network {
            tap: "tap7".into(),
            mac: "06:00:ac:10:00:02".into(),
        });
        let body = load_request(&spec, &files);
        assert_eq!(
            body["network_overrides"],
            json!([{ "iface_id": "eth0", "host_dev_name": "tap7" }])
        );
    }
}
