//! The host agent against a fake engine whose guest keeps memory and disk
//! state, so tests can check exactly what survives each kind of sleep,
//! crash and restart, and that the agent never drives a VM illegally.

use std::collections::{HashMap, HashSet};
use std::future::ready;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use compute_core::{HostPolicy, SandboxId, Step};
use compute_engine::{
    CancellationToken, Completion, Engine, EngineError, ErrorKind, Found, MemoryProfile,
    MemorySource, RestoreFiles, SnapshotFiles, SnapshotKind, VmSpec,
};
use compute_host::client::Client;
use compute_host::protocol::{
    DurabilityName, ErrorCode, HostStatus, Id, LevelName, PriorityName, Reply, Request,
    SandboxConfig, SandboxStatus, SleepConfig,
};
use compute_host::{BusyRule, GuestPort, HostAgent, HostConfig, NoStore, serve};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, UnixListener, UnixStream};
use tokio::sync::watch;
use tokio::task::{AbortHandle, JoinHandle};
use tokio::time::{Instant, sleep};

/// Bytes of fake guest memory, as a memory image is as long as the guest's
/// memory.
const FAKE_MEMORY: usize = 64 << 10;

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
    /// Restores still to refuse as a VMM does when it cannot load an image
    /// (with a memory-lost error), whatever the image holds.
    refuse_restores: Mutex<usize>,
    resumes: AtomicUsize,
    adopted: AtomicUsize,
    /// While set, every resume is refused before the guest runs.
    refuse_resumes: AtomicBool,
    restoring: AtomicUsize,
    max_restoring: AtomicUsize,
    compress_cancelled: AtomicUsize,
    /// Snapshots taken: full, then diff.
    snapshots: [AtomicUsize; 2],
    next_vm: AtomicU64,
    /// The latest VM process of every sandbox, by name, so a restarted
    /// agent can take it back and a test can crash it.
    vms: Mutex<HashMap<String, Process>>,
}

/// What a fake VM process is, independent of any agent's handle to it.
#[derive(Clone, Debug)]
struct Process {
    vsock: PathBuf,
    memory: Arc<Mutex<String>>,
    paused: Arc<Mutex<bool>>,
    exit: watch::Sender<bool>,
    guest: AbortHandle,
    cpu: Arc<Mutex<CpuMeter>>,
}

impl World {
    fn violation(&self, text: String) {
        self.violations.lock().unwrap().push(text);
    }

    /// Simulates a VMM crash.
    fn crash(&self, name: &str) {
        if let Some(process) = self.vms.lock().unwrap().get(name) {
            let _ = process.exit.send(true);
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
    process: Process,
}

impl std::ops::Deref for FakeVm {
    type Target = Process;

    fn deref(&self) -> &Process {
        &self.process
    }
}

/// Processor time a fake VM used: one full processor while its guest is
/// told to be busy.
#[derive(Debug, Default)]
struct CpuMeter {
    used: Duration,
    busy_since: Option<Instant>,
}

impl CpuMeter {
    fn total(&self) -> Duration {
        self.used
            + self
                .busy_since
                .map_or(Duration::ZERO, |since| since.elapsed())
    }

    fn set_busy(&mut self, busy: bool) {
        match (busy, self.busy_since) {
            (true, None) => self.busy_since = Some(Instant::now()),
            (false, Some(since)) => {
                self.used += since.elapsed();
                self.busy_since = None;
            }
            _ => {}
        }
    }
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
        let cpu = Arc::new(Mutex::new(CpuMeter::default()));
        let (exit, mut exited) = watch::channel(false);
        let guest = tokio::spawn(guest(
            listener,
            Arc::clone(&memory),
            spec.drives[0].path.clone(),
            Arc::new(AtomicBool::new(false)),
            Arc::clone(&cpu),
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
        let process = Process {
            vsock,
            memory,
            paused: Arc::default(),
            exit,
            guest: guest.abort_handle(),
            cpu,
        };
        self.world
            .vms
            .lock()
            .unwrap()
            .insert(name.clone(), process.clone());
        self.world.next_vm.fetch_add(1, Ordering::Relaxed);
        FakeVm { name, process }
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
    cpu: Arc<Mutex<CpuMeter>>,
) {
    while let Ok((stream, _)) = listener.accept().await {
        let memory = Arc::clone(&memory);
        let disk = disk.clone();
        let told_restored = Arc::clone(&told_restored);
        let cpu = Arc::clone(&cpu);
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
                    ("busy", _) => {
                        cpu.lock().unwrap().set_busy(true);
                        "ok".into()
                    }
                    ("quiet", _) => {
                        cpu.lock().unwrap().set_busy(false);
                        "ok".into()
                    }
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

    fn memory_profile(&self) -> MemoryProfile {
        MemoryProfile::bare_metal()
    }

    async fn restore(&self, spec: &VmSpec, files: &RestoreFiles) -> Result<FakeVm, EngineError> {
        let now = self.world.restoring.fetch_add(1, Ordering::SeqCst) + 1;
        self.world.max_restoring.fetch_max(now, Ordering::SeqCst);
        sleep(self.delays.restore).await;
        self.world.restoring.fetch_sub(1, Ordering::SeqCst);
        let refuse = {
            let mut left = self.world.refuse_restores.lock().unwrap();
            left.checked_sub(1).map(|fewer| *left = fewer)
        };
        if refuse.is_some() {
            return Err(EngineError::new(
                ErrorKind::MemoryLost,
                "restore",
                "snapshot load refused",
            ));
        }
        let MemorySource::File(path) = &files.memory else {
            panic!("a bare-metal host restores local images from files");
        };
        let memory = std::fs::read(path)
            .map_err(|error| EngineError::caused_by(ErrorKind::MemoryLost, "restore", error))?;
        let memory = String::from_utf8_lossy(&memory)
            .trim_end_matches('\0')
            .to_owned();
        self.world.restores.fetch_add(1, Ordering::Relaxed);
        let vm = self.launch(spec, memory);
        *vm.paused.lock().unwrap() = true;
        Ok(vm)
    }

    fn pause(&self, vm: &FakeVm) -> impl Future<Output = Result<(), EngineError>> + Send {
        ready(self.set_paused(vm, "pause", true))
    }

    fn resume(&self, vm: &FakeVm) -> impl Future<Output = Result<(), EngineError>> + Send {
        if self.world.refuse_resumes.load(Ordering::SeqCst) {
            return ready(Err(EngineError::new(
                ErrorKind::Transient,
                "resume",
                "refused",
            )));
        }
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

    async fn snapshot(
        &self,
        vm: &FakeVm,
        files: &SnapshotFiles,
        kind: SnapshotKind,
    ) -> Result<(), EngineError> {
        Self::alive(vm, "snapshot")?;
        self.expect_paused(vm, "snapshot", true);
        sleep(self.delays.snapshot).await;
        Self::alive(vm, "snapshot")?;
        let memory = vm.memory.lock().unwrap().clone();
        std::fs::write(&files.state, "state").unwrap();
        // Like a real engine, the image is as long as guest memory. A diff
        // holding every page is still a valid diff.
        let mut image = memory.into_bytes();
        assert!(image.len() <= FAKE_MEMORY, "fake guest memory overflow");
        image.resize(FAKE_MEMORY, 0);
        std::fs::write(&files.memory, image).unwrap();
        self.world.snapshots[usize::from(kind == SnapshotKind::Diff)]
            .fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    fn stop(&self, vm: FakeVm) -> impl Future<Output = Result<(), EngineError>> + Send {
        let _ = vm.exit.send(true);
        vm.guest.abort();
        let _ = std::fs::remove_file(&vm.vsock);
        self.world.live.lock().unwrap().remove(&vm.name);
        ready(Ok(()))
    }

    fn adopt(
        &self,
        spec: &VmSpec,
    ) -> impl Future<Output = Result<Option<(FakeVm, Found)>, EngineError>> + Send {
        let process = self
            .world
            .vms
            .lock()
            .unwrap()
            .get(&spec.name)
            .filter(|process| !*process.exit.borrow())
            .cloned();
        let found = process.map(|process| {
            self.world.adopted.fetch_add(1, Ordering::Relaxed);
            let found = if *process.paused.lock().unwrap() {
                Found::Paused
            } else {
                Found::Running
            };
            let vm = FakeVm {
                name: spec.name.clone(),
                process,
            };
            (vm, found)
        });
        ready(Ok(found))
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

    fn cpu_time(&self, vm: &FakeVm) -> Result<Duration, EngineError> {
        Ok(vm.cpu.lock().unwrap().total())
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
            first_uid: 1 << 30,
            network: None,
            busy: Some(BusyRule {
                cpu_percent: 50,
                window: Duration::from_millis(100),
            }),
            can_compress: true,
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
        // The socket file appears at bind, before the server listens, so
        // wait for a request to succeed rather than for the file.
        let client = Client::new(&socket);
        let deadline = Instant::now() + Duration::from_secs(10);
        while client.call(&Request::Status).await.is_err() {
            assert!(Instant::now() < deadline, "the host API never came up");
            sleep(Duration::from_millis(1)).await;
        }
        Self {
            root,
            client,
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

    async fn create(&self, id: Id, sleep: SleepConfig) {
        let config = SandboxConfig {
            vcpus: 1,
            memory_mib: 256,
            sleep,
        };
        let reply = self
            .client
            .call(&Request::Create { id, config })
            .await
            .unwrap();
        assert_eq!(reply, Reply::Done);
    }

    async fn sleep_to(&self, id: Id, level: LevelName) -> Reply {
        self.client
            .call(&Request::Sleep {
                id,
                generation: None,
                level,
            })
            .await
            .unwrap()
    }

    fn sandbox(status: &HostStatus, id: Id) -> &compute_host::protocol::SandboxStatus {
        status
            .sandboxes
            .iter()
            .find(|sandbox| sandbox.id == id)
            .unwrap()
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

    /// The sandbox's durable record, as the agent last wrote it.
    fn record(&self, id: Id) -> serde_json::Value {
        let bytes = std::fs::read(self.sandbox_dir(id).join("sandbox.json")).unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// Whether the record vouches for a saved memory image.
    fn image(&self, id: Id) -> bool {
        self.record(id)["image"].as_bool().unwrap()
    }

    async fn current(&self, id: Id) -> SandboxStatus {
        self.status()
            .await
            .sandboxes
            .into_iter()
            .find(|sandbox| sandbox.id == id)
            .unwrap()
    }
}

fn id(n: u128) -> Id {
    Id(SandboxId((0x00c0_ffee << 64) | n))
}

fn vm_name(id: Id) -> String {
    id.to_string()
}

/// Never sleeps on its own.
const NEVER: SleepConfig = SleepConfig {
    pause_after_ms: None,
    save_after_ms: None,
    archive_after_ms: None,
    drop_after_ms: None,
    evict_after_ms: None,
    forget_after_ms: None,
    compress: false,
};

/// Pauses and saves quickly, and keeps the paused VM.
const SAVE_IN_PLACE: SleepConfig = SleepConfig {
    pause_after_ms: Some(30),
    save_after_ms: Some(60),
    ..NEVER
};

/// Pauses, saves and ends the VM process quickly.
const SAVE_QUICKLY: SleepConfig = SleepConfig {
    drop_after_ms: Some(90),
    ..SAVE_IN_PLACE
};

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
    assert!(lab.image(sandbox));
    assert!(
        lab.world.live.lock().unwrap().is_empty(),
        "a saved sandbox has no VM"
    );

    let again = lab.run(sandbox, &["get", "disk"]).await;
    assert_eq!(again, ["hello", "on-disk"]);
    assert!(
        !lab.image(sandbox),
        "a restored guest makes the old image stale"
    );
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1);
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 1);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_save_keeps_the_paused_vm_ready_to_resume() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(12);
    lab.create(sandbox, SAVE_IN_PLACE).await;
    assert_eq!(lab.run(sandbox, &["set hello"]).await, ["ok"]);
    let status = lab
        .wait_until("the save to finish", |status| {
            let view = Lab::sandbox(status, sandbox);
            view.durability == DurabilityName::Local && view.step.is_none()
        })
        .await;
    let view = Lab::sandbox(&status, sandbox);
    assert_eq!(view.level, LevelName::Paused);
    assert!(view.memory_saved);
    assert!(lab.image(sandbox));
    assert!(lab.world.live.lock().unwrap().contains(&vm_name(sandbox)));

    let resumes = lab.world.resumes.load(Ordering::SeqCst);
    assert_eq!(lab.run(sandbox, &["get"]).await, ["hello"]);
    assert_eq!(lab.world.resumes.load(Ordering::SeqCst), resumes + 1);
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 0);
    assert!(
        !lab.image(sandbox),
        "a resumed guest makes the saved image stale"
    );
    lab.assert_clean();
}

/// The memory file of the sandbox's current image, made writable.
fn current_image_memory(lab: &Lab, sandbox: Id) -> PathBuf {
    let images = lab.sandbox_dir(sandbox).join("images");
    let newest = std::fs::read_dir(&images)
        .unwrap()
        .filter_map(|entry| {
            let name = entry.unwrap().file_name().into_string().ok()?;
            Some((name.parse::<u64>().ok()?, name))
        })
        .max()
        .map(|(_, name)| name)
        .unwrap();
    let memory = images.join(newest).join("memory");
    let mut permissions = std::fs::metadata(&memory).unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    permissions.set_readonly(false);
    std::fs::set_permissions(&memory, permissions).unwrap();
    memory
}

fn quarantined(lab: &Lab, sandbox: Id) -> Vec<String> {
    let dir = lab.sandbox_dir(sandbox).join("images/quarantine");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_restore_of_a_good_image_keeps_it_and_tries_again() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(17);
    lab.create(sandbox, SAVE_QUICKLY).await;
    lab.run(sandbox, &["set hello"]).await;
    lab.wait_level(sandbox, LevelName::Saved).await;

    // A VMM may refuse for reasons of the host's own, such as a pager that
    // could not start; the image itself is fine.
    *lab.world.refuse_restores.lock().unwrap() = 2;
    assert_eq!(lab.run(sandbox, &["get"]).await, ["hello"]);
    assert_eq!(*lab.world.refuse_restores.lock().unwrap(), 0);
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 1);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1, "never rebooted");
    assert_eq!(quarantined(&lab, sandbox), Vec::<String>::new());
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_restore_of_a_damaged_image_quarantines_it() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(18);
    lab.create(sandbox, SAVE_QUICKLY).await;
    lab.run(sandbox, &["set hello", "write kept"]).await;
    lab.wait_level(sandbox, LevelName::Saved).await;

    // Damage only the memory: the quick check before a restore passes, and
    // only the full check the refusal triggers finds it.
    let memory = current_image_memory(&lab, sandbox);
    let mut bytes = std::fs::read(&memory).unwrap();
    bytes[0] ^= 0xff;
    std::fs::write(&memory, bytes).unwrap();
    *lab.world.refuse_restores.lock().unwrap() = 1;
    assert_eq!(
        lab.run(sandbox, &["get", "disk"]).await,
        ["", "kept"],
        "booted fresh from the files"
    );
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 2);
    let quarantined = quarantined(&lab, sandbox);
    assert!(
        quarantined.len() == 1 && quarantined[0].ends_with("-damaged"),
        "{quarantined:?}"
    );
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_crash_after_a_save_loses_nothing() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(13);
    lab.create(sandbox, SAVE_IN_PLACE).await;
    lab.run(sandbox, &["set hello", "write kept"]).await;
    lab.wait_until("the save to finish", |status| {
        Lab::sandbox(status, sandbox).durability == DurabilityName::Local
    })
    .await;
    lab.world.crash(&vm_name(sandbox));
    lab.wait_level(sandbox, LevelName::Saved).await;
    assert_eq!(lab.run(sandbox, &["get", "disk"]).await, ["hello", "kept"]);
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 1);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_resume_keeps_the_saved_copy_for_a_crash() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(15);
    lab.create(sandbox, SAVE_IN_PLACE).await;
    lab.run(sandbox, &["set hello", "write kept"]).await;
    lab.wait_until("the save to finish", |status| {
        let view = Lab::sandbox(status, sandbox);
        view.durability == DurabilityName::Local && view.step.is_none()
    })
    .await;

    lab.world.refuse_resumes.store(true, Ordering::SeqCst);
    let reply = lab
        .client
        .call(&Request::Touch {
            id: sandbox,
            generation: None,
            priority: PriorityName::Interactive,
        })
        .await
        .unwrap();
    assert_eq!(reply, Reply::Done);
    lab.wait_until("a refused resume", |status| {
        status
            .steps
            .iter()
            .any(|(name, stats)| name == "resume" && stats.failed > 0)
    })
    .await;
    let status = lab.status().await;
    let view = Lab::sandbox(&status, sandbox);
    assert_eq!(view.level, LevelName::Paused);
    assert_eq!(view.durability, DurabilityName::Local, "nothing changed");
    assert!(
        lab.image(sandbox),
        "the guest never ran, so its copy is still marked good"
    );

    // The VM dies before a retry gets through: the copy takes its place,
    // and a restore that is refused keeps it too.
    lab.world.crash(&vm_name(sandbox));
    lab.wait_until("a refused restore", |status| {
        status
            .steps
            .iter()
            .any(|(name, stats)| name == "restore" && stats.failed > 0)
    })
    .await;
    assert!(lab.image(sandbox));
    lab.world.refuse_resumes.store(false, Ordering::SeqCst);
    assert_eq!(lab.run(sandbox, &["get", "disk"]).await, ["hello", "kept"]);
    assert!(lab.world.restores.load(Ordering::Relaxed) >= 2);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sleep_request_overrides_the_settings_until_the_next_wake() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(14);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["set hello", "write kept"]).await;
    assert_eq!(lab.sleep_to(sandbox, LevelName::Saved).await, Reply::Done);
    lab.wait_level(sandbox, LevelName::Saved).await;
    assert!(lab.world.live.lock().unwrap().is_empty());
    assert_eq!(lab.run(sandbox, &["get", "disk"]).await, ["hello", "kept"]);

    // The wake cleared the request: a never-sleeping sandbox stays awake.
    sleep(Duration::from_millis(200)).await;
    let status = lab.status().await;
    assert_eq!(Lab::sandbox(&status, sandbox).level, LevelName::Running);

    // Without a store, nothing can be archived.
    let reply = lab.sleep_to(sandbox, LevelName::Archived).await;
    assert!(
        matches!(&reply, Reply::Error { message, .. } if message.contains("store")),
        "{reply:?}"
    );
    let reply = lab.sleep_to(id(99), LevelName::Paused).await;
    assert!(matches!(reply, Reply::Error { .. }), "{reply:?}");
    lab.assert_clean();
}

/// Pauses soon after the last activity.
const PAUSE_SOON: SleepConfig = SleepConfig {
    pause_after_ms: Some(200),
    ..NEVER
};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn work_inside_the_guest_keeps_it_awake() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(16);
    lab.create(sandbox, PAUSE_SOON).await;
    // The guest starts a background job and nobody is connected any more.
    assert_eq!(lab.run(sandbox, &["busy"]).await, ["ok"]);
    sleep(Duration::from_millis(800)).await;
    let status = lab.status().await;
    assert_eq!(
        Lab::sandbox(&status, sandbox).level,
        LevelName::Running,
        "a busy guest stays awake"
    );
    // The job ends; the sandbox goes idle and pauses.
    assert_eq!(lab.run(sandbox, &["quiet"]).await, ["ok"]);
    let quiet = Instant::now();
    lab.wait_level(sandbox, LevelName::Paused).await;
    assert!(quiet.elapsed() >= Duration::from_millis(200));
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_named_hold_wakes_a_sandbox_and_keeps_it_awake_until_it_lapses() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(17);
    lab.create(sandbox, PAUSE_SOON).await;
    let hold = |ttl_ms| Request::Hold {
        id: sandbox,
        generation: None,
        hold: "turn".into(),
        ttl_ms,
        priority: PriorityName::Interactive,
    };
    let started = Instant::now();
    assert_eq!(
        lab.client.call(&hold(Some(600))).await.unwrap(),
        Reply::Done
    );
    // Holding wakes it: a turn starting is a good moment to boot.
    lab.wait_level(sandbox, LevelName::Running).await;
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 1);
    sleep(Duration::from_millis(450)).await;
    let status = lab.status().await;
    assert_eq!(Lab::sandbox(&status, sandbox).level, LevelName::Running);
    assert_eq!(Lab::sandbox(&status, sandbox).holds, 1);
    // Nobody refreshed it: it lapses, and the idle clock runs from there.
    lab.wait_level(sandbox, LevelName::Paused).await;
    assert!(
        started.elapsed() >= Duration::from_millis(800),
        "{:?}",
        started.elapsed()
    );

    // A hold without expiry lasts until released.
    assert_eq!(lab.client.call(&hold(None)).await.unwrap(), Reply::Done);
    lab.wait_level(sandbox, LevelName::Running).await;
    sleep(Duration::from_millis(400)).await;
    let status = lab.status().await;
    assert_eq!(Lab::sandbox(&status, sandbox).level, LevelName::Running);
    let release = Request::Release {
        id: sandbox,
        generation: None,
        hold: "turn".into(),
    };
    assert_eq!(lab.client.call(&release).await.unwrap(), Reply::Done);
    lab.wait_level(sandbox, LevelName::Paused).await;

    let missing = Request::Release {
        id: id(98),
        generation: None,
        hold: "turn".into(),
    };
    let reply = lab.client.call(&missing).await.unwrap();
    assert!(matches!(reply, Reply::Error { .. }), "{reply:?}");
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_host_that_cannot_compress_refuses_to() {
    let lab = Lab::start_configured(
        Lab::root(),
        Arc::default(),
        Delays::default(),
        HostPolicy::default(),
        |config| config.can_compress = false,
    )
    .await;
    let sandbox = id(18);
    let compressible = SleepConfig {
        compress: true,
        ..PAUSE_SOON
    };
    lab.create(sandbox, compressible).await;
    lab.run(sandbox, &["set x"]).await;
    let reply = lab.sleep_to(sandbox, LevelName::Compressed).await;
    assert!(
        matches!(&reply, Reply::Error { message, .. } if message.contains("compress")),
        "{reply:?}"
    );
    assert_eq!(lab.sleep_to(sandbox, LevelName::Paused).await, Reply::Done);
    lab.wait_level(sandbox, LevelName::Paused).await;
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn forgetting_memory_keeps_the_files() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(15);
    let forget_soon = SleepConfig {
        forget_after_ms: Some(150),
        ..SAVE_QUICKLY
    };
    lab.create(sandbox, forget_soon).await;
    lab.run(sandbox, &["set hello", "write kept"]).await;
    lab.wait_until("the memory image to be forgotten", |status| {
        let view = Lab::sandbox(status, sandbox);
        view.level == LevelName::Saved && !view.memory_saved && view.step.is_none()
    })
    .await;
    assert!(!lab.image(sandbox));
    assert_eq!(lab.run(sandbox, &["get", "disk"]).await, ["", "kept"]);
    assert_eq!(lab.world.boots.load(Ordering::Relaxed), 2);
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 0);
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
    lab.create(sandbox, NEVER).await;
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
    let compressible = SleepConfig {
        pause_after_ms: Some(20),
        compress: true,
        ..NEVER
    };
    lab.create(sandbox, compressible).await;
    lab.run(sandbox, &["set warm"]).await;
    lab.wait_level(sandbox, LevelName::Paused).await;
    assert_eq!(
        lab.sleep_to(sandbox, LevelName::Compressed).await,
        Reply::Done
    );
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
    lab.create(sandbox, SAVE_IN_PLACE).await;
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
        !lab.image(sandbox),
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
        .call(&Request::Remove {
            id: sandbox,
            generation: None,
        })
        .await
        .unwrap();
    assert_eq!(reply, Reply::Done);
    assert!(!lab.sandbox_dir(sandbox).exists());
    assert!(lab.world.live.lock().unwrap().is_empty());
    assert_eq!(lab.status().await.sandboxes.len(), 0);
    // The id is free again.
    lab.create(sandbox, NEVER).await;
    assert_eq!(lab.run(sandbox, &["get"]).await, [""]);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restarted_agent_takes_back_running_vms_and_recovers_the_rest() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let (saved, running, paused) = (id(6), id(7), id(12));
    let in_place = id(14);
    lab.create(saved, SAVE_QUICKLY).await;
    lab.create(running, NEVER).await;
    lab.create(paused, PAUSE_SOON).await;
    lab.create(in_place, SAVE_IN_PLACE).await;
    lab.run(saved, &["set kept", "write saved-disk"]).await;
    lab.run(running, &["set alive", "write running-disk"]).await;
    lab.run(paused, &["set asleep"]).await;
    lab.run(in_place, &["set copied"]).await;
    lab.wait_level(saved, LevelName::Saved).await;
    lab.wait_level(paused, LevelName::Paused).await;
    lab.wait_until("the save in place", |status| {
        let view = Lab::sandbox(status, in_place);
        view.durability == DurabilityName::Local && view.step.is_none()
    })
    .await;
    let before = lab.status().await;
    let (root, world) = lab.stop().await;

    // VMs outlive the agent.
    assert!(world.live.lock().unwrap().contains(&vm_name(running)));
    assert!(world.live.lock().unwrap().contains(&vm_name(paused)));
    let lab = Lab::start(root, world, Delays::default(), HostPolicy::default()).await;
    let after = lab.status().await;
    assert_eq!(after.sandboxes.len(), 4);
    for (old, new) in before.sandboxes.iter().zip(&after.sandboxes) {
        assert_eq!(
            (old.id, old.level, old.durability, old.generation),
            (new.id, new.level, new.durability, new.generation),
            "a restart changed a sandbox"
        );
    }
    assert_eq!(lab.world.adopted.load(Ordering::Relaxed), 3);
    assert!(
        lab.image(in_place),
        "a paused VM taken back keeps its saved copy"
    );
    assert_eq!(
        lab.run(saved, &["get", "disk"]).await,
        ["kept", "saved-disk"]
    );
    assert_eq!(
        lab.run(running, &["get", "disk"]).await,
        ["alive", "running-disk"],
        "the running VM was taken back as it was"
    );
    assert_eq!(lab.run(paused, &["get"]).await, ["asleep"]);
    assert_eq!(lab.run(in_place, &["get"]).await, ["copied"]);
    assert_eq!(
        lab.world.boots.load(Ordering::Relaxed),
        4,
        "nothing rebooted"
    );
    assert_eq!(lab.world.restores.load(Ordering::Relaxed), 1);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn requests_for_a_replaced_execution_are_refused() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(13);
    lab.create(sandbox, SAVE_QUICKLY).await;
    assert_eq!(lab.current(sandbox).await.generation, 0, "not yet run");
    lab.run(sandbox, &["set first"]).await;
    let first = lab.current(sandbox).await.generation;
    assert_eq!(first, 1);
    let wake = |generation| Request::Wake {
        id: sandbox,
        generation: Some(generation),
        priority: PriorityName::Interactive,
    };
    assert!(matches!(
        lab.client.call(&wake(first)).await.unwrap(),
        Reply::Woken { .. }
    ));

    // A save and restore keep the guest's programs but replace the
    // execution.
    lab.wait_level(sandbox, LevelName::Saved).await;
    assert_eq!(lab.run(sandbox, &["get"]).await, ["first"]);
    let second = lab.current(sandbox).await.generation;
    assert_eq!(second, first + 1);
    let reply = lab.client.call(&wake(first)).await.unwrap();
    assert!(
        matches!(
            reply,
            Reply::Error {
                code: ErrorCode::Stale,
                ..
            }
        ),
        "{reply:?}"
    );
    let reply = lab
        .client
        .call(&Request::Remove {
            id: sandbox,
            generation: Some(first),
        })
        .await
        .unwrap();
    assert!(
        matches!(
            reply,
            Reply::Error {
                code: ErrorCode::Stale,
                ..
            }
        ),
        "{reply:?}"
    );
    assert_eq!(lab.status().await.sandboxes.len(), 1, "a stale remove ran");
    let reply = lab
        .client
        .call(&Request::Remove {
            id: sandbox,
            generation: Some(second),
        })
        .await
        .unwrap();
    assert_eq!(reply, Reply::Done);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_removal_cut_short_finishes_on_the_next_start() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let (doomed, kept) = (id(14), id(15));
    lab.create(doomed, NEVER).await;
    lab.create(kept, NEVER).await;
    lab.run(doomed, &["set x"]).await;
    let dir = lab.sandbox_dir(doomed);
    let (root, world) = lab.stop().await;

    // The agent died right after recording that removal began.
    let path = dir.join("sandbox.json");
    let mut record: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    record["removing"] = true.into();
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    // And an unfinished creation left a directory without a record.
    let unfinished = root.join("state/vm/firecracker").join(id(16).to_string());
    std::fs::create_dir_all(unfinished.join("root")).unwrap();

    let lab = Lab::start(root, world, Delays::default(), HostPolicy::default()).await;
    lab.wait_until("the removal to finish", |_| !dir.exists())
        .await;
    let status = lab.status().await;
    assert_eq!(status.sandboxes.len(), 1);
    assert_eq!(status.sandboxes[0].id, kept);
    assert!(!unfinished.exists());
    assert!(
        !lab.world.live.lock().unwrap().contains(&vm_name(doomed)),
        "the removed sandbox's VM still runs"
    );
    // Its id is free again.
    lab.create(doomed, NEVER).await;
    assert_eq!(lab.run(doomed, &["get"]).await, [""]);
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
            generation: None,
            priority: PriorityName::Interactive,
        })
        .await
        .unwrap();
    assert!(
        matches!(
            reply,
            Reply::Error {
                code: ErrorCode::NotFound,
                ..
            }
        ),
        "{reply:?}"
    );
    let config = SandboxConfig {
        vcpus: 1,
        memory_mib: 256,
        sleep: SleepConfig {
            archive_after_ms: Some(90),
            ..SAVE_IN_PLACE
        },
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
        matches!(&reply, Reply::Error { message, .. } if message.contains("store")),
        "{reply:?}"
    );
    let reply = lab
        .client
        .call(&Request::Create {
            id: missing,
            config: SandboxConfig {
                vcpus: 1,
                memory_mib: 256,
                sleep: SleepConfig {
                    save_after_ms: Some(10),
                    ..NEVER
                },
            },
        })
        .await
        .unwrap();
    assert!(
        matches!(&reply, Reply::Error { message, .. } if message.contains("pause")),
        "saving needs pausing first: {reply:?}"
    );
    lab.create(missing, NEVER).await;
    let reply = lab
        .client
        .call(&Request::Create {
            id: missing,
            config: SandboxConfig {
                vcpus: 1,
                memory_mib: 256,
                sleep: NEVER,
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
    lab.create(
        sandbox,
        SleepConfig {
            pause_after_ms: Some(30),
            ..NEVER
        },
    )
    .await;
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
        .call(&Request::Remove {
            id: sandbox,
            generation: None,
        })
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
