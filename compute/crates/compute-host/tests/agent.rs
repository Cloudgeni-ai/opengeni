//! The host agent against a fake engine whose guest keeps memory and disk
//! state, so tests can check exactly what survives each kind of sleep,
//! crash and restart, and that the agent never drives a VM illegally.

use std::collections::HashSet;
use std::future::ready;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use compute_core::{HostPolicy, SandboxId, Step};
use compute_engine::{
    CancellationToken, Completion, Engine, EngineError, ErrorKind, SnapshotFiles, VmSpec,
};
use compute_host::client::Client;
use compute_host::protocol::{
    HostStatus, Id, LevelName, PriorityName, Reply, Request, SandboxConfig, SleepRule,
};
use compute_host::{GuestPort, HostAgent, HostConfig, NoStore, serve};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, UnixListener, UnixStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep};

/// How long each fake operation takes.
#[derive(Clone, Copy, Debug)]
struct Delays {
    boot: Duration,
    restore: Duration,
    snapshot: Duration,
    compress: Duration,
    /// How late the host hears that a VM process ended.
    exit_notice: Duration,
}

impl Default for Delays {
    fn default() -> Self {
        Self {
            boot: Duration::from_millis(5),
            restore: Duration::from_millis(5),
            snapshot: Duration::from_millis(5),
            compress: Duration::from_millis(5),
            exit_notice: Duration::ZERO,
        }
    }
}

/// What the fake saw, shared by every engine instance in a test so a
/// restarted agent sees VMs the previous one left running.
#[derive(Debug, Default)]
struct World {
    live: Mutex<HashSet<String>>,
    violations: Mutex<Vec<String>>,
    boots: AtomicUsize,
    restores: AtomicUsize,
    resumes: AtomicUsize,
    restoring: AtomicUsize,
    max_restoring: AtomicUsize,
    compress_cancelled: AtomicUsize,
    next_vm: AtomicU64,
    /// Kill switches for every live VM, by name.
    killers: Mutex<Vec<(String, watch::Sender<bool>)>>,
}

impl World {
    fn violation(&self, text: String) {
        self.violations.lock().unwrap().push(text);
    }

    /// Simulates a VMM crash.
    fn crash(&self, name: &str) {
        let killers = self.killers.lock().unwrap();
        for (vm, kill) in killers.iter() {
            if vm == name {
                let _ = kill.send(true);
            }
        }
    }
}

#[derive(Clone, Debug)]
struct Fake {
    world: Arc<World>,
    delays: Delays,
}

#[derive(Debug)]
struct FakeVm {
    name: String,
    vsock: PathBuf,
    memory: Arc<Mutex<String>>,
    paused: Mutex<bool>,
    exit: watch::Sender<bool>,
    guest: JoinHandle<()>,
}

impl Fake {
    fn launch(&self, spec: &VmSpec, memory: String) -> FakeVm {
        let name = spec.name.clone();
        if !self.world.live.lock().unwrap().insert(name.clone()) {
            self.world.violation(format!("two VMs at once for {name}"));
        }
        let vsock = spec.vsock_path();
        std::fs::create_dir_all(&spec.dir).unwrap();
        let _ = std::fs::remove_file(&vsock);
        let listener = UnixListener::bind(&vsock).unwrap();
        let memory = Arc::new(Mutex::new(memory));
        let (exit, mut exited) = watch::channel(false);
        let guest = tokio::spawn(guest(
            listener,
            Arc::clone(&memory),
            spec.drives[0].path.clone(),
            Arc::new(AtomicBool::new(false)),
        ));
        let world = Arc::clone(&self.world);
        let dead = name.clone();
        let socket = vsock.clone();
        let abort = guest.abort_handle();
        tokio::spawn(async move {
            let _ = exited.wait_for(|exited| *exited).await;
            abort.abort();
            let _ = std::fs::remove_file(&socket);
            world.live.lock().unwrap().remove(&dead);
        });
        self.world
            .killers
            .lock()
            .unwrap()
            .push((name.clone(), exit.clone()));
        self.world.next_vm.fetch_add(1, Ordering::Relaxed);
        FakeVm {
            name,
            vsock,
            memory,
            paused: Mutex::new(false),
            exit,
            guest,
        }
    }

    fn alive(vm: &FakeVm, op: &'static str) -> Result<(), EngineError> {
        if *vm.exit.borrow() {
            Err(EngineError::new(ErrorKind::MemoryLost, op, "VMM gone"))
        } else {
            Ok(())
        }
    }

    fn expect_paused(&self, vm: &FakeVm, op: &str, paused: bool) {
        if *vm.paused.lock().unwrap() != paused {
            self.world.violation(format!(
                "{op} on {} while {}",
                vm.name,
                if paused { "running" } else { "paused" }
            ));
        }
    }

    /// Pauses or resumes a live VM, recording a violation if it already was.
    fn set_paused(&self, vm: &FakeVm, op: &'static str, paused: bool) -> Result<(), EngineError> {
        Self::alive(vm, op)?;
        self.expect_paused(vm, op, !paused);
        *vm.paused.lock().unwrap() = paused;
        Ok(())
    }
}

/// A guest: answers shell-like lines on any port, and remembers whether this
/// VM process was told it was restored.
async fn guest(
    listener: UnixListener,
    memory: Arc<Mutex<String>>,
    disk: PathBuf,
    told_restored: Arc<AtomicBool>,
) {
    while let Ok((stream, _)) = listener.accept().await {
        let memory = Arc::clone(&memory);
        let disk = disk.clone();
        let told_restored = Arc::clone(&told_restored);
        tokio::spawn(async move {
            let (read, mut write) = stream.into_split();
            let mut lines = BufReader::new(read).lines();
            match lines.next_line().await {
                Ok(Some(line)) if line.starts_with("CONNECT ") => {}
                _ => return,
            }
            if write.write_all(b"OK 1073741824\n").await.is_err() {
                return;
            }
            while let Ok(Some(line)) = lines.next_line().await {
                let reply = match line.split_once(' ').unwrap_or((line.as_str(), "")) {
                    ("exit", _) => break,
                    ("get", _) => memory.lock().unwrap().clone(),
                    ("set", value) => {
                        value.clone_into(&mut memory.lock().unwrap());
                        "ok".into()
                    }
                    ("write", value) => {
                        std::fs::write(&disk, value).unwrap();
                        "ok".into()
                    }
                    ("disk", _) => std::fs::read_to_string(&disk).unwrap_or_default(),
                    ("restored", _) => {
                        told_restored.store(true, Ordering::SeqCst);
                        "ok".into()
                    }
                    ("told-restored?", _) => told_restored.load(Ordering::SeqCst).to_string(),
                    (other, _) => format!("unknown {other}"),
                };
                if write
                    .write_all(format!("{reply}\n").as_bytes())
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
    }
}

impl Engine for Fake {
    type Vm = FakeVm;

    async fn boot(&self, spec: &VmSpec) -> Result<FakeVm, EngineError> {
        sleep(self.delays.boot).await;
        self.world.boots.fetch_add(1, Ordering::Relaxed);
        Ok(self.launch(spec, String::new()))
    }

    async fn restore(&self, spec: &VmSpec, files: &SnapshotFiles) -> Result<FakeVm, EngineError> {
        let now = self.world.restoring.fetch_add(1, Ordering::SeqCst) + 1;
        self.world.max_restoring.fetch_max(now, Ordering::SeqCst);
        sleep(self.delays.restore).await;
        self.world.restoring.fetch_sub(1, Ordering::SeqCst);
        let memory = std::fs::read_to_string(&files.memory)
            .map_err(|error| EngineError::caused_by(ErrorKind::MemoryLost, "restore", error))?;
        self.world.restores.fetch_add(1, Ordering::Relaxed);
        let vm = self.launch(spec, memory);
        *vm.paused.lock().unwrap() = true;
        Ok(vm)
    }

    fn pause(&self, vm: &FakeVm) -> impl Future<Output = Result<(), EngineError>> + Send {
        ready(self.set_paused(vm, "pause", true))
    }

    fn resume(&self, vm: &FakeVm) -> impl Future<Output = Result<(), EngineError>> + Send {
        let resumed = self.set_paused(vm, "resume", false);
        if resumed.is_ok() {
            self.world.resumes.fetch_add(1, Ordering::Relaxed);
        }
        ready(resumed)
    }

    async fn compress(
        &self,
        vm: &FakeVm,
        cancel: &CancellationToken,
    ) -> Result<Completion, EngineError> {
        Self::alive(vm, "compress")?;
        self.expect_paused(vm, "compress", true);
        let deadline = Instant::now() + self.delays.compress;
        while Instant::now() < deadline {
            if cancel.is_cancelled() {
                self.world
                    .compress_cancelled
                    .fetch_add(1, Ordering::Relaxed);
                return Ok(Completion::Cancelled);
            }
            sleep(Duration::from_millis(2)).await;
        }
        Ok(Completion::Finished)
    }

    async fn snapshot(&self, vm: &FakeVm, files: &SnapshotFiles) -> Result<(), EngineError> {
        Self::alive(vm, "snapshot")?;
        self.expect_paused(vm, "snapshot", true);
        sleep(self.delays.snapshot).await;
        Self::alive(vm, "snapshot")?;
        let memory = vm.memory.lock().unwrap().clone();
        std::fs::write(&files.state, "state").unwrap();
        std::fs::write(&files.memory, memory).unwrap();
        Ok(())
    }

    fn stop(&self, vm: FakeVm) -> impl Future<Output = Result<(), EngineError>> + Send {
        let _ = vm.exit.send(true);
        vm.guest.abort();
        let _ = std::fs::remove_file(&vm.vsock);
        self.world.live.lock().unwrap().remove(&vm.name);
        ready(Ok(()))
    }

    async fn clean_up(&self, spec: &VmSpec) -> Result<(), EngineError> {
        self.world.crash(&spec.name);
        // Give the crash watcher a moment to release the name.
        for _ in 0..100 {
            if !self.world.live.lock().unwrap().contains(&spec.name) {
                break;
            }
            sleep(Duration::from_millis(1)).await;
        }
        Ok(())
    }

    fn resident_bytes(&self, _: &FakeVm) -> Result<u64, EngineError> {
        Ok(100 << 20)
    }

    fn exited(&self, vm: &FakeVm) -> impl Future<Output = ()> + Send + 'static {
        let mut exit = vm.exit.subscribe();
        let late = self.delays.exit_notice;
        async move {
            let _ = exit.wait_for(|exited| *exited).await;
            sleep(late).await;
        }
    }
}

struct Lab {
    root: PathBuf,
    client: Client,
    world: Arc<World>,
    server: JoinHandle<()>,
}

static NEXT_LAB: AtomicUsize = AtomicUsize::new(0);

impl Lab {
    /// Unix socket paths are short, so labs live directly under /tmp.
    fn root() -> PathBuf {
        let n = NEXT_LAB.fetch_add(1, Ordering::Relaxed);
        let root = PathBuf::from(format!("/tmp/ch-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("base.img"), "base").unwrap();
        std::fs::write(root.join("vmlinux"), "kernel").unwrap();
        root
    }

    async fn start(root: PathBuf, world: Arc<World>, delays: Delays, policy: HostPolicy) -> Self {
        Self::start_configured(root, world, delays, policy, |_| {}).await
    }

    async fn start_configured(
        root: PathBuf,
        world: Arc<World>,
        delays: Delays,
        policy: HostPolicy,
        configure: impl FnOnce(&mut HostConfig),
    ) -> Self {
        let mut config = HostConfig {
            root: root.join("state"),
            kernel: root.join("vmlinux"),
            boot_args: String::new(),
            base_image: root.join("base.img"),
            policy,
            sample_every: Duration::from_millis(50),
            guest_ports: Vec::new(),
            restore_notice_port: None,
        };
        configure(&mut config);
        let engine = Fake {
            world: Arc::clone(&world),
            delays,
        };
        let (handle, _agent) = HostAgent::start(config, engine, NoStore).await.unwrap();
        let socket = root.join("host.sock");
        let _ = std::fs::remove_file(&socket);
        let listening = socket.clone();
        let server = tokio::spawn(async move {
            let _ = serve(handle, &listening).await;
        });
        // Generous: on a loaded machine the server can take a while to bind.
        let deadline = Instant::now() + Duration::from_secs(10);
        while !socket.exists() {
            assert!(Instant::now() < deadline, "the host API never came up");
            sleep(Duration::from_millis(1)).await;
        }
        Self {
            root,
            client: Client::new(socket),
            world,
            server,
        }
    }

    async fn new(delays: Delays, policy: HostPolicy) -> Self {
        Self::start(Self::root(), Arc::default(), delays, policy).await
    }

    /// Stops serving; the agent stops once its last handle is gone.
    async fn stop(self) -> (PathBuf, Arc<World>) {
        self.server.abort();
        let _ = self.server.await;
        sleep(Duration::from_millis(20)).await;
        (self.root, self.world)
    }

    async fn create(&self, id: Id, sleep: &[(LevelName, u64)]) {
        let config = SandboxConfig {
            vcpus: 1,
            memory_mib: 256,
            sleep: sleep
                .iter()
                .map(|(level, after_ms)| SleepRule {
                    level: *level,
                    after_ms: *after_ms,
                })
                .collect(),
        };
        let reply = self
            .client
            .call(&Request::Create { id, config })
            .await
            .unwrap();
        assert_eq!(reply, Reply::Done);
    }

    /// Runs guest shell lines in one connection and returns the replies.
    async fn run(&self, id: Id, lines: &[&str]) -> Vec<String> {
        let (reply, mut stream) = self
            .client
            .connect(id, 52, PriorityName::Interactive)
            .await
            .unwrap();
        assert!(matches!(reply, Reply::Connected { .. }), "{reply:?}");
        let mut script = lines.join("\n");
        script.push_str("\nexit\n");
        stream.get_mut().write_all(script.as_bytes()).await.unwrap();
        let mut output = String::new();
        stream.read_to_string(&mut output).await.unwrap();
        output.lines().map(str::to_owned).collect()
    }

    async fn status(&self) -> HostStatus {
        match self.client.call(&Request::Status).await.unwrap() {
            Reply::Status(status) => *status,
            other => panic!("{other:?}"),
        }
    }

    async fn wait_until(&self, what: &str, done: impl Fn(&HostStatus) -> bool) -> HostStatus {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let status = self.status().await;
            if done(&status) {
                return status;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}: {status:#?}"
            );
            sleep(Duration::from_millis(5)).await;
        }
    }

    async fn wait_level(&self, id: Id, level: LevelName) {
        self.wait_until(&format!("{id} at {level:?}"), |status| {
            status
                .sandboxes
                .iter()
                .any(|sandbox| sandbox.id == id && sandbox.level == level && sandbox.step.is_none())
        })
        .await;
    }

    fn assert_clean(&self) {
        let violations = self.world.violations.lock().unwrap();
        assert!(violations.is_empty(), "illegal engine use: {violations:#?}");
    }

    fn sandbox_dir(&self, id: Id) -> PathBuf {
        self.root.join("state/vm/firecracker").join(id.to_string())
    }
}

fn id(n: u128) -> Id {
    Id(SandboxId((0x00c0_ffee << 64) | n))
}

fn vm_name(id: Id) -> String {
    id.to_string()
}

const SAVE_QUICKLY: &[(LevelName, u64)] = &[(LevelName::Paused, 30), (LevelName::Saved, 60)];

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sleeping_through_save_keeps_memory_and_disk() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(1);
    lab.create(sandbox, SAVE_QUICKLY).await;
    let first = lab
        .run(sandbox, &["set hello", "write on-disk", "get"])
        .await;
    assert_eq!(first, ["ok", "ok", "hello"]);

    lab.wait_level(sandbox, LevelName::Saved).await;
    assert!(lab.sandbox_dir(sandbox).join("saved").exists());
    assert!(
        lab.world.live.lock().unwrap().is_empty(),
        "a saved sandbox has no VM"
    );

    let again = lab.run(sandbox, &["get", "disk"]).await;
    assert_eq!(again, ["hello", "on-disk"]);
    assert!(
        !lab.sandbox_dir(sandbox).join("saved").exists(),
        "a restored guest makes the old image stale"
    );
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1);
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 1);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_burst_of_wakes_respects_the_restore_limit() {
    let policy = HostPolicy {
        limits: HostPolicy::default().limits.with(Step::Restore, 8),
        ..HostPolicy::default()
    };
    let delays = Delays {
        restore: Duration::from_millis(20),
        ..Delays::default()
    };
    let lab = Arc::new(Lab::new(delays, policy).await);
    let ids: Vec<Id> = (0..60).map(id).collect();
    for (n, sandbox) in ids.iter().enumerate() {
        lab.create(*sandbox, SAVE_QUICKLY).await;
        let value = format!("set v{n}");
        lab.run(*sandbox, &[&value]).await;
    }
    for sandbox in &ids {
        lab.wait_level(*sandbox, LevelName::Saved).await;
    }
    let started = Instant::now();
    let mut wakes = tokio::task::JoinSet::new();
    for (n, sandbox) in ids.iter().enumerate() {
        let (lab, sandbox) = (Arc::clone(&lab), *sandbox);
        wakes.spawn(async move { (n, lab.run(sandbox, &["get"]).await) });
    }
    while let Some(result) = wakes.join_next().await {
        let (n, output) = result.unwrap();
        assert_eq!(output, [format!("v{n}")]);
    }
    let elapsed = started.elapsed();
    let max = lab.world.max_restoring.load(Ordering::SeqCst);
    assert!(max <= 8, "{max} restores ran at once");
    assert!(max >= 4, "restores were not concurrent: {max}");
    // 60 restores of 20 ms, 8 at a time, need at least 8 rounds.
    assert!(elapsed >= Duration::from_millis(140), "{elapsed:?}");
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_crash_loses_memory_but_keeps_files() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(2);
    lab.create(sandbox, &[]).await;
    lab.run(sandbox, &["set hello", "write kept"]).await;
    lab.world.crash(&vm_name(sandbox));
    lab.wait_until("the crash to be noticed", |status| {
        status.sandboxes[0].level == LevelName::Saved && !status.sandboxes[0].memory_saved
    })
    .await;
    let after = lab.run(sandbox, &["get", "disk"]).await;
    assert_eq!(after, ["", "kept"]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 2);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_wake_interrupts_compression() {
    let delays = Delays {
        compress: Duration::from_secs(5),
        ..Delays::default()
    };
    let lab = Lab::new(delays, HostPolicy::default()).await;
    let sandbox = id(3);
    lab.create(
        sandbox,
        &[(LevelName::Paused, 20), (LevelName::Compressed, 40)],
    )
    .await;
    lab.run(sandbox, &["set warm"]).await;
    lab.wait_until("compression to start", |status| {
        status.sandboxes[0].step.as_deref() == Some("compress")
    })
    .await;
    let started = Instant::now();
    assert_eq!(lab.run(sandbox, &["get"]).await, ["warm"]);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(lab.world.compress_cancelled.load(Ordering::Relaxed), 1);
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 0);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_wake_during_save_resumes_the_paused_vm() {
    let delays = Delays {
        snapshot: Duration::from_millis(300),
        ..Delays::default()
    };
    let lab = Lab::new(delays, HostPolicy::default()).await;
    let sandbox = id(4);
    lab.create(sandbox, SAVE_QUICKLY).await;
    lab.run(sandbox, &["set warm"]).await;
    lab.wait_until("the save to start", |status| {
        status.sandboxes[0].step.as_deref() == Some("save")
    })
    .await;
    assert_eq!(lab.run(sandbox, &["get"]).await, ["warm"]);
    assert_eq!(
        lab.world.restores.load(Ordering::Relaxed),
        0,
        "no restore needed"
    );
    assert!(
        !lab.sandbox_dir(sandbox).join("saved").exists(),
        "a cancelled save must not leave a valid-looking image"
    );
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_late_exit_notice_is_not_blamed_on_a_new_vm() {
    let delays = Delays {
        snapshot: Duration::from_millis(100),
        exit_notice: Duration::from_millis(300),
        ..Delays::default()
    };
    let lab = Lab::new(delays, HostPolicy::default()).await;
    let sandbox = id(9);
    lab.create(sandbox, SAVE_QUICKLY).await;
    lab.run(sandbox, &["set old"]).await;
    lab.wait_until("the save to start", |status| {
        status.sandboxes[0].step.as_deref() == Some("save")
    })
    .await;
    // The VM dies mid-save; the save fails and the host learns of the exit
    // from the failed step long before the exit notice itself arrives.
    lab.world.crash(&vm_name(sandbox));
    assert_eq!(lab.run(sandbox, &["get", "set new"]).await, ["", "ok"]);
    sleep(Duration::from_millis(500)).await;
    assert_eq!(
        lab.run(sandbox, &["get"]).await,
        ["new"],
        "the new VM was blamed"
    );
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 2);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn remove_waits_for_a_running_save_and_deletes_everything() {
    let delays = Delays {
        snapshot: Duration::from_millis(200),
        ..Delays::default()
    };
    let lab = Lab::new(delays, HostPolicy::default()).await;
    let sandbox = id(5);
    lab.create(sandbox, SAVE_QUICKLY).await;
    lab.run(sandbox, &["set x"]).await;
    lab.wait_until("the save to start", |status| {
        status.sandboxes[0].step.as_deref() == Some("save")
    })
    .await;
    let reply = lab
        .client
        .call(&Request::Remove { id: sandbox })
        .await
        .unwrap();
    assert_eq!(reply, Reply::Done);
    assert!(!lab.sandbox_dir(sandbox).exists());
    assert!(lab.world.live.lock().unwrap().is_empty());
    assert_eq!(lab.status().await.sandboxes.len(), 0);
    // The id is free again.
    lab.create(sandbox, &[]).await;
    assert_eq!(lab.run(sandbox, &["get"]).await, [""]);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restarted_agent_recovers_every_sandbox() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let (saved, running) = (id(6), id(7));
    lab.create(saved, SAVE_QUICKLY).await;
    lab.create(running, &[]).await;
    lab.run(saved, &["set kept", "write saved-disk"]).await;
    lab.run(running, &["set gone", "write running-disk"]).await;
    lab.wait_level(saved, LevelName::Saved).await;
    let (root, world) = lab.stop().await;

    // The running sandbox's VM is still alive; the new agent must end it.
    assert!(world.live.lock().unwrap().contains(&vm_name(running)));
    let lab = Lab::start(root, world, Delays::default(), HostPolicy::default()).await;
    let status = lab.status().await;
    assert_eq!(status.sandboxes.len(), 2);
    assert_eq!(
        lab.run(saved, &["get", "disk"]).await,
        ["kept", "saved-disk"]
    );
    assert_eq!(
        lab.run(running, &["get", "disk"]).await,
        ["", "running-disk"]
    );
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bad_requests_are_refused() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let missing = id(8);
    let reply = lab
        .client
        .call(&Request::Wake {
            id: missing,
            priority: PriorityName::Interactive,
        })
        .await
        .unwrap();
    assert!(matches!(reply, Reply::Error { .. }), "{reply:?}");
    let archived = &[
        (LevelName::Paused, 10),
        (LevelName::Saved, 20),
        (LevelName::Archived, 30),
    ];
    let config = SandboxConfig {
        vcpus: 1,
        memory_mib: 256,
        sleep: archived
            .iter()
            .map(|(level, after_ms)| SleepRule {
                level: *level,
                after_ms: *after_ms,
            })
            .collect(),
    };
    let reply = lab
        .client
        .call(&Request::Create {
            id: missing,
            config,
        })
        .await
        .unwrap();
    assert!(
        matches!(&reply, Reply::Error { message } if message.contains("store")),
        "{reply:?}"
    );
    lab.create(missing, &[]).await;
    let reply = lab
        .client
        .call(&Request::Create {
            id: missing,
            config: SandboxConfig {
                vcpus: 1,
                memory_mib: 256,
                sleep: Vec::new(),
            },
        })
        .await
        .unwrap();
    assert!(matches!(reply, Reply::Error { .. }), "{reply:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn data_for_a_sleeping_sandbox_wakes_it() {
    let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = upstream.local_addr().unwrap();
    let ports: Vec<GuestPort> = vec![format!("4222={address},wake").parse().unwrap()];
    let lab = Lab::start_configured(
        Lab::root(),
        Arc::default(),
        Delays::default(),
        HostPolicy::default(),
        |config| config.guest_ports = ports,
    )
    .await;
    let sandbox = id(10);
    lab.create(sandbox, &[(LevelName::Paused, 30)]).await;
    lab.run(sandbox, &["set up"]).await;

    // The test plays the guest: it opens a connection to its host, the way
    // an agent inside the VM dials vsock address 2.
    let socket = lab.sandbox_dir(sandbox).join("root/vsock.sock_4222");
    let mut guest = UnixStream::connect(&socket).await.unwrap();
    let (mut server, _) = upstream.accept().await.unwrap();
    guest.write_all(b"hello").await.unwrap();
    let mut hello = [0; 5];
    server.read_exact(&mut hello).await.unwrap();
    assert_eq!(&hello, b"hello");

    lab.wait_level(sandbox, LevelName::Paused).await;
    let resumes = lab.world.resumes.load(Ordering::SeqCst);
    server.write_all(b"wake up").await.unwrap();
    lab.wait_until("inbound data to wake the sandbox", |_| {
        lab.world.resumes.load(Ordering::SeqCst) > resumes
    })
    .await;
    let mut message = [0; 7];
    guest.read_exact(&mut message).await.unwrap();
    assert_eq!(&message, b"wake up");

    // Removing the sandbox closes its listeners and their sockets.
    lab.client
        .call(&Request::Remove { id: sandbox })
        .await
        .unwrap();
    assert!(!socket.exists());
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restored_guest_is_told_before_anything_else_reaches_it() {
    let lab = Lab::start_configured(
        Lab::root(),
        Arc::default(),
        Delays::default(),
        HostPolicy::default(),
        |config| config.restore_notice_port = Some(53),
    )
    .await;
    let sandbox = id(11);
    lab.create(sandbox, SAVE_QUICKLY).await;
    // A freshly booted guest has nothing stale to fix.
    assert_eq!(lab.run(sandbox, &["told-restored?"]).await, ["false"]);

    lab.wait_level(sandbox, LevelName::Saved).await;
    // The first thing to reach the restored guest finds it already told.
    assert_eq!(lab.run(sandbox, &["told-restored?"]).await, ["true"]);
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 1);
    lab.assert_clean();
}
