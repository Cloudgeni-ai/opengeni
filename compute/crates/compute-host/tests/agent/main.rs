//! The host agent against a fake engine whose guest keeps memory and disk
//! state, so tests can check exactly what survives each kind of sleep,
//! crash and restart, and that the agent never drives a VM illegally.

use std::collections::{HashMap, HashSet};
use std::future::ready;
use std::os::fd::OwnedFd;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use compute_core::{HostPolicy, SandboxId};
use compute_engine::{
    CancellationToken, Completion, Engine, EngineError, ErrorKind, Found, MemoryProfile,
    MemorySource, RestoreFiles, SnapshotFiles, SnapshotKind, VmSpec,
};
use compute_host::client::Client;
use compute_host::protocol::{
    HostStatus, Id, LevelName, PriorityName, Reply, Request, SandboxConfig, SandboxStatus,
    SleepConfig,
};
use compute_host::{BusyRule, HostAgent, HostConfig, NoStore, PagerConfig, serve};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::sync::watch;
use tokio::task::{AbortHandle, JoinHandle};
use tokio::time::{Instant, sleep};

mod requests;
mod restart;
mod sleep;

/// Bytes of fake guest memory that hold its value. A memory image is as long
/// as the sandbox's memory, so the rest of it is a hole.
const FAKE_MEMORY: usize = 64 << 10;

/// How long each fake operation takes.
#[derive(Clone, Copy, Debug)]
struct Delays {
    boot: Duration,
    restore: Duration,
    snapshot: Duration,
    compress: Duration,
    /// How long a VM process takes to end once stopped.
    stop: Duration,
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
            stop: Duration::ZERO,
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
    /// While set, every boot fails as a launch does that could not prove
    /// the VMM it may have started is gone.
    stuck_boots: AtomicBool,
    /// While set, a refused resume also makes the sandbox's directory
    /// read-only, as a failing disk would.
    freeze_on_refusal: AtomicBool,
    /// Whether a freeze took effect; it does not for root.
    froze: AtomicBool,
    /// While set, every resume lets the guest run and then reports the VM
    /// beyond control, with its process still alive.
    lose_resumes: AtomicBool,
    restoring: AtomicUsize,
    max_restoring: AtomicUsize,
    compress_cancelled: AtomicUsize,
    /// Snapshots taken: full, then diff.
    snapshots: [AtomicUsize; 2],
    next_vm: AtomicU64,
    /// The latest VM process of every sandbox, by name, so a restarted
    /// agent can take it back and a test can crash it.
    vms: Mutex<HashMap<String, Process>>,
    /// VMs whose teardown is under way, by name.
    tearing_down: Mutex<HashSet<String>>,
    /// VMs that cannot be checked on, by name: adopting one fails as when
    /// its VMM does not answer.
    unadoptable: Mutex<HashSet<String>>,
    /// While set, no VM's processor time can be read.
    unreadable_cpu: AtomicBool,
    /// While set, no VM's traffic can be read.
    unreadable_io: AtomicBool,
    /// While set, every pause moves a burst of data, as a VMM writing a
    /// snapshot does: work the host does, not the guest.
    transition_traffic: AtomicBool,
    /// Traffic readings taken, so a test can line up with the agent's
    /// sampling.
    samples: AtomicUsize,
}

/// What a fake VM process is, independent of any agent's handle to it.
#[derive(Clone, Debug)]
struct Process {
    vsock: PathBuf,
    memory: Arc<Mutex<String>>,
    /// The sandbox's memory size: the length of every image it writes.
    memory_len: u64,
    paused: Arc<Mutex<bool>>,
    exit: watch::Sender<bool>,
    guest: AbortHandle,
    work: Arc<Mutex<Work>>,
    /// What [`Engine::hold`] keeps for it, which ends with it.
    held: Arc<Mutex<Option<OwnedFd>>>,
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
    /// The sandbox's directory on the host.
    sandbox_dir: PathBuf,
    process: Process,
}

impl std::ops::Deref for FakeVm {
    type Target = Process;

    fn deref(&self) -> &Process {
        &self.process
    }
}

/// What a fake VM's guest is told to be doing.
#[derive(Debug, Default)]
struct Work {
    /// One full processor while busy.
    cpu: Meter,
    /// A byte of traffic every microsecond while streaming.
    io: Meter,
}

/// Time a fake VM spent on one kind of work.
#[derive(Debug, Default)]
struct Meter {
    used: Duration,
    busy_since: Option<Instant>,
}

impl Meter {
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
        if self.world.tearing_down.lock().unwrap().contains(&name) {
            self.world.violation(format!(
                "a VM for {name} started during an old one's teardown"
            ));
        }
        let vsock = spec.vsock_path();
        std::fs::create_dir_all(&spec.dir).unwrap();
        let _ = std::fs::remove_file(&vsock);
        let listener = UnixListener::bind(&vsock).unwrap();
        let memory = Arc::new(Mutex::new(memory));
        let work = Arc::new(Mutex::new(Work::default()));
        let (exit, mut exited) = watch::channel(false);
        let guest = tokio::spawn(guest(
            listener,
            Arc::clone(&memory),
            spec.drives[0].path.clone(),
            Arc::new(AtomicBool::new(false)),
            Arc::clone(&work),
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
            memory_len: spec.memory_bytes(),
            paused: Arc::default(),
            exit,
            guest: guest.abort_handle(),
            work,
            held: Arc::default(),
        };
        self.world
            .vms
            .lock()
            .unwrap()
            .insert(name.clone(), process.clone());
        self.world.next_vm.fetch_add(1, Ordering::Relaxed);
        FakeVm {
            name,
            sandbox_dir: spec.dir.parent().unwrap().to_owned(),
            process,
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
    work: Arc<Mutex<Work>>,
) {
    while let Ok((stream, _)) = listener.accept().await {
        let memory = Arc::clone(&memory);
        let disk = disk.clone();
        let told_restored = Arc::clone(&told_restored);
        let work = Arc::clone(&work);
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
                        work.lock().unwrap().cpu.set_busy(true);
                        "ok".into()
                    }
                    ("quiet", _) => {
                        work.lock().unwrap().cpu.set_busy(false);
                        "ok".into()
                    }
                    ("stream", _) => {
                        work.lock().unwrap().io.set_busy(true);
                        "ok".into()
                    }
                    ("still", _) => {
                        work.lock().unwrap().io.set_busy(false);
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
        if self.world.stuck_boots.load(Ordering::SeqCst) {
            return Err(EngineError::new(
                ErrorKind::Fatal,
                "boot",
                "attaching failed; then what it started could not be cleaned up",
            ));
        }
        Ok(self.launch(spec, String::new()))
    }

    fn memory_profile(&self) -> MemoryProfile {
        MemoryProfile::bare_metal()
    }

    fn runtime(&self) -> &'static str {
        "fake"
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
            // As Firecracker does: the VMM starts, then refuses the load.
            return Err(EngineError::new(
                ErrorKind::MemoryLost,
                "restore",
                "snapshot load refused",
            )
            .after_launch());
        }
        let MemorySource::File(path) = &files.memory else {
            panic!("a bare-metal host restores local images from files");
        };
        let mut memory = Vec::new();
        std::fs::File::open(path)
            .and_then(|file| {
                std::io::Read::read_to_end(
                    &mut std::io::Read::take(file, FAKE_MEMORY as u64),
                    &mut memory,
                )
            })
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
        if self.world.transition_traffic.load(Ordering::SeqCst) {
            // A second of streaming: a million bytes.
            vm.work.lock().unwrap().io.used += Duration::from_secs(1);
        }
        ready(self.set_paused(vm, "pause", true))
    }

    fn resume(&self, vm: &FakeVm) -> impl Future<Output = Result<(), EngineError>> + Send {
        if self.world.refuse_resumes.load(Ordering::SeqCst) {
            if self.world.freeze_on_refusal.load(Ordering::SeqCst) {
                self.world
                    .froze
                    .store(freeze(&vm.sandbox_dir), Ordering::SeqCst);
            }
            return ready(Err(EngineError::new(
                ErrorKind::Transient,
                "resume",
                "refused",
            )));
        }
        let resumed = self.set_paused(vm, "resume", false);
        if resumed.is_ok() && self.world.lose_resumes.load(Ordering::SeqCst) {
            return ready(Err(EngineError::new(
                ErrorKind::MemoryLost,
                "resume",
                "no answer, and the VMM cannot say what happened",
            )));
        }
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
        // Like a real engine, the image is as long as guest memory, and
        // sparse. A diff holding every page is still a valid diff.
        let mut image = memory.into_bytes();
        assert!(image.len() <= FAKE_MEMORY, "fake guest memory overflow");
        image.resize(FAKE_MEMORY, 0);
        let file = std::fs::File::create(&files.memory).unwrap();
        std::io::Write::write_all(&mut &file, &image).unwrap();
        file.set_len(vm.memory_len).unwrap();
        self.world.snapshots[usize::from(kind == SnapshotKind::Diff)]
            .fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    async fn stop(&self, vm: FakeVm) -> Result<(), EngineError> {
        self.world
            .tearing_down
            .lock()
            .unwrap()
            .insert(vm.name.clone());
        sleep(self.delays.stop).await;
        let _ = vm.exit.send(true);
        vm.guest.abort();
        let _ = std::fs::remove_file(&vm.vsock);
        self.world.live.lock().unwrap().remove(&vm.name);
        self.world.tearing_down.lock().unwrap().remove(&vm.name);
        Ok(())
    }

    fn adopt(
        &self,
        spec: &VmSpec,
    ) -> impl Future<Output = Result<Option<(FakeVm, Found)>, EngineError>> + Send {
        if self.world.unadoptable.lock().unwrap().contains(&spec.name) {
            return ready(Err(EngineError::new(
                ErrorKind::Transient,
                "adopt",
                "the VMM did not answer",
            )));
        }
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
                sandbox_dir: spec.dir.parent().unwrap().to_owned(),
                process,
            };
            (vm, found)
        });
        ready(Ok(found))
    }

    fn hold(
        &self,
        vm: &FakeVm,
        file: OwnedFd,
    ) -> impl Future<Output = Result<(), EngineError>> + Send {
        *vm.held.lock().unwrap() = Some(file);
        ready(Ok(()))
    }

    fn held(
        &self,
        vm: &FakeVm,
    ) -> impl Future<Output = Result<Option<OwnedFd>, EngineError>> + Send {
        ready(
            vm.held
                .lock()
                .unwrap()
                .as_ref()
                .map(OwnedFd::try_clone)
                .transpose()
                .map_err(|error| EngineError::io("held", error)),
        )
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
        if self.world.unreadable_cpu.load(Ordering::SeqCst) {
            return Err(EngineError::new(
                ErrorKind::Transient,
                "cpu_time",
                "cpu.stat unreadable",
            ));
        }
        Ok(vm.work.lock().unwrap().cpu.total())
    }

    fn io_bytes(&self, vm: &FakeVm) -> Result<u64, EngineError> {
        self.world.samples.fetch_add(1, Ordering::SeqCst);
        if self.world.unreadable_io.load(Ordering::SeqCst) {
            return Err(EngineError::new(
                ErrorKind::Transient,
                "io_bytes",
                "io.stat unreadable",
            ));
        }
        let streamed = vm.work.lock().unwrap().io.total();
        Ok(u64::try_from(streamed.as_micros()).unwrap_or(u64::MAX))
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
                io_bytes_per_second: 100_000,
                window: Duration::from_millis(100),
            }),
            can_compress: true,
            host_lock: None,
            // Fake VMs never start one.
            pager: PagerConfig::new(root.join("no-pager")),
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

    async fn wake(&self, id: Id) -> Reply {
        self.client
            .call(&Request::Wake {
                id,
                generation: None,
                priority: PriorityName::Interactive,
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
            .connect(id, None, 52, PriorityName::Interactive)
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

/// Pauses soon after the last activity.
const PAUSE_SOON: SleepConfig = SleepConfig {
    pause_after_ms: Some(200),
    ..NEVER
};

/// Makes `dir` read-only and returns whether that stops writes, which it
/// does not for root.
fn freeze(dir: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o555)).unwrap();
    let probe = dir.join("probe");
    if std::fs::write(&probe, b"").is_ok() {
        let _ = std::fs::remove_file(probe);
        return false;
    }
    true
}

fn thaw(dir: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755)).unwrap();
}
