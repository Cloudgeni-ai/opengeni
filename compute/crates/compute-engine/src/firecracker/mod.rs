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
use crate::Engine;
use crate::cgroup::Cgroup;
use crate::error::{EngineError, ErrorKind};
use crate::spec::{SnapshotFiles, VmSpec};

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
                json!({ "kernel_image_path": spec.kernel, "boot_args": spec.boot_args }),
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
        let body = json!({
            "snapshot_path": files.state,
            "mem_backend": { "backend_type": "File", "backend_path": files.memory },
            "resume_vm": true,
        });
        let load = vm.call(OP, ErrorKind::MemoryLost, "PUT", "/snapshot/load", &body);
        self.or_kill(&vm, load).await?;
        Ok(vm)
    }

    async fn pause(&self, vm: &FirecrackerVm) -> Result<(), EngineError> {
        vm.call(
            "pause",
            ErrorKind::Transient,
            "PATCH",
            "/vm",
            &json!({ "state": "Paused" }),
        )
        .await
    }

    async fn resume(&self, vm: &FirecrackerVm) -> Result<(), EngineError> {
        vm.call(
            "resume",
            ErrorKind::Transient,
            "PATCH",
            "/vm",
            &json!({ "state": "Resumed" }),
        )
        .await
    }

    async fn compress(&self, vm: &FirecrackerVm) -> Result<(), EngineError> {
        let cgroup = vm.cgroup.clone();
        tokio::task::spawn_blocking(move || cgroup.reclaim_to_zswap())
            .await
            .map_err(|error| EngineError::caused_by(ErrorKind::Transient, "compress", error))?
            .map_err(|error| EngineError::io("compress", error))
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

    fn resident_bytes(&self, vm: &FirecrackerVm) -> Result<u64, EngineError> {
        vm.cgroup
            .memory_current()
            .map_err(|error| EngineError::io("resident_bytes", error))
    }
}

async fn remove_if_present(path: &Path) -> io::Result<()> {
    match tokio::fs::remove_file(path).await {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}
