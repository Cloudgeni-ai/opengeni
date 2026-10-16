//! Host memory running short: a running VM is never compressed by the
//! kernel, and a guest that outgrows the huge-page pool.

use super::*;

const MIB: u64 = 1 << 20;

/// The value of `field` in `/proc/meminfo`.
pub(super) fn meminfo(field: &str) -> u64 {
    let meminfo = std::fs::read_to_string("/proc/meminfo").unwrap();
    meminfo
        .lines()
        .find_map(|line| line.strip_prefix(field))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|value| value.parse().ok())
        .unwrap_or_else(|| panic!("no {field} in /proc/meminfo"))
}

const POOL: &str = "/proc/sys/vm/nr_hugepages";

/// Shrinks the huge-page pool to `free` free pages for as long as it lives.
struct ShrunkPool {
    total: u64,
}

impl ShrunkPool {
    fn leaving(free: u64) -> Self {
        let total = meminfo("HugePages_Total:");
        let used = total - meminfo("HugePages_Free:");
        std::fs::write(POOL, (used + free).to_string()).unwrap();
        Self { total }
    }
}

impl Drop for ShrunkPool {
    fn drop(&mut self) {
        let _ = std::fs::write(POOL, self.total.to_string());
    }
}

pub(super) fn nested() -> bool {
    std::env::var("COMPUTE_TEST_PROFILE").is_ok_and(|profile| profile == "nested")
}

async fn create_sized(client: &Client, sandbox: Id, memory_mib: u32) {
    let reply = client
        .call(&Request::Create {
            id: sandbox,
            config: SandboxConfig::new(1, memory_mib, NEVER),
        })
        .await
        .unwrap();
    assert_eq!(reply, Reply::Done, "create {sandbox}");
}

/// Runs `script` in `sandbox`'s shell in the background; the task yields
/// its output.
fn spawn_script(client: &Client, sandbox: Id, script: &str) -> tokio::task::JoinHandle<String> {
    let client = client.clone();
    let mut input = script.to_owned();
    input.push_str("\nexit\n");
    tokio::spawn(async move {
        let (reply, mut stream) = client
            .connect(sandbox, PORT, PriorityName::Interactive)
            .await
            .unwrap();
        assert!(matches!(reply, Reply::Connected { .. }), "{reply:?}");
        stream.get_mut().write_all(input.as_bytes()).await.unwrap();
        let mut output = String::new();
        stream.read_to_string(&mut output).await.unwrap();
        output
    })
}

/// What a guest meets when the huge-page pool runs out under it: its
/// memory is mapped without reserving pages, so nothing fails up front,
/// and a fault that finds no free page is retried inside KVM. The guest
/// stalls, its vCPU spinning, until a page is free, then goes on: no
/// SIGBUS, nothing lost. Admission therefore counts every awake VM whole
/// against the pool, so the pool never runs out unless something else
/// takes from it.
#[tokio::test(flavor = "multi_thread")]
async fn a_guest_stalls_while_the_huge_page_pool_is_empty_and_resumes_after() {
    let Some(lab) = lab() else {
        eprintln!("skipped: set COMPUTE_TEST_LAB to run against Firecracker");
        return;
    };
    if !nested() {
        eprintln!("skipped: needs COMPUTE_TEST_PROFILE=nested");
        return;
    }
    let host = Host::new(&lab, "pool", &[]);
    let agent = host.start().await;
    let sandbox = id(0);
    create_sized(&agent.client, sandbox, 1024).await;
    let (output, _) = exec(&agent.client, sandbox, "echo up").await;
    assert_eq!(output.trim(), "up");
    // The capacity is the pool, and an awake VM counts whole against it.
    let capacity = agent.status().await.capacity.expect("admission is on");
    assert_eq!(capacity.total, meminfo("HugePages_Total:") * 2 * MIB);
    assert_eq!(capacity.reserved, 1024 * MIB);

    let pool = ShrunkPool::leaving(16);
    let started = Instant::now();
    let fill = spawn_script(
        &agent.client,
        sandbox,
        "dd if=/dev/zero of=/dev/shm/fill bs=1M count=400 2>/dev/null; echo dd=$?",
    );
    sleep(Duration::from_secs(10)).await;
    assert!(!fill.is_finished(), "the guest went on without pages");
    assert_eq!(meminfo("HugePages_Free:"), 0);
    let status = agent.status().await;
    let stalled = status.sandboxes.iter().find(|s| s.id == sandbox).unwrap();
    assert_eq!(
        (stalled.level, stalled.broken, stalled.launches),
        (LevelName::Running, false, 1),
        "the VM lives on"
    );
    drop(pool);
    let output = timeout(Duration::from_secs(60), fill)
        .await
        .expect("the guest never went on")
        .unwrap();
    assert_eq!(output.trim(), "dd=0");
    eprintln!(
        "stalled for 10 s with the pool empty, finished {:?} after it was refilled",
        started.elapsed().saturating_sub(Duration::from_secs(10))
    );
    agent.remove_all().await;
    agent.kill();
    host.finish("pool");
}

/// A cgroup the test creates, ended and removed with everything below it
/// when dropped.
struct Group(PathBuf);

impl Group {
    fn create(path: impl Into<PathBuf>, controllers: bool) -> Self {
        let path = path.into();
        std::fs::create_dir_all(&path).unwrap();
        if controllers {
            std::fs::write(path.join("cgroup.subtree_control"), "+memory +cpu").unwrap();
        }
        Self(path)
    }

    fn read(&self, file: &str) -> String {
        std::fs::read_to_string(self.0.join(file)).unwrap_or_default()
    }

    fn write(&self, file: &str, value: &str) {
        std::fs::write(self.0.join(file), value).unwrap();
    }

    /// The value of `field` in one of the group's flat-keyed files.
    fn field(&self, file: &str, field: &str) -> u64 {
        self.read(file)
            .lines()
            .find_map(|line| line.strip_prefix(field)?.strip_prefix(' '))
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(0)
    }
}

fn remove_tree(path: &Path) {
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten().filter(|entry| entry.path().is_dir()) {
            remove_tree(&entry.path());
        }
    }
    for _ in 0..50 {
        if std::fs::remove_dir(path).is_ok() || !path.exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        let _ = std::fs::write(self.0.join("cgroup.kill"), "1");
        remove_tree(&self.0);
    }
}

/// Sleeps only under memory pressure, compressing first.
const COMPRESS_WHEN_NEEDED: SleepConfig = SleepConfig {
    pause_after_ms: Some(3_600_000),
    save_after_ms: Some(7_200_000),
    archive_after_ms: None,
    drop_after_ms: None,
    evict_after_ms: None,
    forget_after_ms: None,
    compress: true,
};

/// The parent of the groups the memory-pressure test makes: the agent's
/// VMs and a memory hog, under one memory limit.
const SQUEEZED: &str = "/sys/fs/cgroup/compute-test-squeezed";

/// Holds `sandbox` awake and waits until it runs.
pub(super) async fn hold_running(agent: &Agent, sandbox: Id) {
    let hold = Request::Hold {
        id: sandbox,
        generation: None,
        hold: "work".into(),
        ttl_ms: None,
        priority: PriorityName::Interactive,
    };
    assert_eq!(agent.client.call(&hold).await.unwrap(), Reply::Done);
    agent
        .wait_until("it to run", |status| {
            status
                .sandboxes
                .iter()
                .any(|found| found.id == sandbox && found.level == LevelName::Running)
        })
        .await;
}

/// Starts a process in `hog` that takes 1 GiB and holds it for 30 s.
fn start_hog(hog: &Group) -> Child {
    Command::new("sh")
        .arg("-c")
        .arg(format!(
            "echo $$ > {}/cgroup.procs && exec python3 -c \
             \"import time; b = bytearray(b'x') * (1024 << 20); time.sleep(30)\"",
            hog.0.display()
        ))
        .spawn()
        .unwrap()
}

/// Until `work` is done, checks that `busy` runs and is never compressed,
/// and notes the most pages compressed out of each of `idle` and whether
/// it ended.
async fn watch_squeeze(
    agent: &Agent,
    busy: Id,
    idle: [Id; 2],
    work: &tokio::task::JoinHandle<String>,
) -> ([u64; 2], [bool; 2]) {
    let mut compressed = [0_u64; 2];
    let mut ended = [false; 2];
    let deadline = Instant::now() + Duration::from_secs(40);
    while !work.is_finished() && Instant::now() < deadline {
        let status = agent.status().await;
        for (n, sandbox) in idle.iter().enumerate() {
            let found = status.sandboxes.iter().find(|s| s.id == *sandbox).unwrap();
            if let Some(memory) = found.memory {
                compressed[n] = compressed[n].max(memory.zswpout);
            }
            ended[n] |= found.level == LevelName::Saved;
        }
        let running = status.sandboxes.iter().find(|s| s.id == busy).unwrap();
        assert_eq!(running.level, LevelName::Running);
        assert_eq!(
            running.memory.map(|memory| memory.zswpout),
            Some(0),
            "the busy VM was compressed"
        );
        sleep(Duration::from_millis(200)).await;
    }
    (compressed, ended)
}

/// A running VM's memory never goes into zswap, not even when the kernel
/// reclaims under real memory pressure, while idle sandboxes are
/// compressed or ended by the host's own relief. The pressure is real but
/// local: the agent's VMs and a memory hog share a memory limit, so the
/// kernel reclaims from them as from a full host.
#[tokio::test(flavor = "multi_thread")]
async fn a_running_vm_is_never_compressed_under_memory_pressure() {
    let Some(lab) = lab() else {
        eprintln!("skipped: set COMPUTE_TEST_LAB to run against Firecracker");
        return;
    };
    if nested() {
        eprintln!("skipped: huge pages are never compressed");
        return;
    }
    let squeezed = Group::create(SQUEEZED, true);
    let hog = Group::create(Path::new(SQUEEZED).join("hog"), false);
    let vms = Path::new(SQUEEZED).join("vms");
    // The agent sees memory short all the time, so it pushes every idle
    // sandbox as deep as it may go.
    let beyond = (meminfo("MemTotal:") / 1024 * 2).to_string();
    let host = Host::new(
        &lab,
        "squeezed",
        &[
            "--memory-low-mib",
            &beyond,
            "--memory-high-mib",
            &beyond,
            "--memory-buffer-mib",
            "0",
        ],
    )
    .with_cgroup(&vms);
    let agent = host.start().await;
    let busy = id(0);
    let idle = [id(1), id(2)];
    agent.create(busy, NEVER).await;
    for sandbox in idle {
        agent.create(sandbox, COMPRESS_WHEN_NEEDED).await;
        let (output, _) = exec(&agent.client, sandbox, "echo up").await;
        assert_eq!(output.trim(), "up");
    }
    hold_running(&agent, busy).await;
    let busy_group = Group(vms.join(busy.to_string()));
    assert_eq!(busy_group.read("memory.zswap.max").trim(), "0");
    // The busy guest fills 256 MiB, then keeps reading it.
    let work = spawn_script(
        &agent.client,
        busy,
        "dd if=/dev/zero of=/dev/shm/a bs=1M count=256 2>/dev/null; touch /dev/shm/filled; \
         end=$(($(date +%s) + 20)); n=0; \
         while [ $(date +%s) -lt $end ]; do cat /dev/shm/a > /dev/null; n=$((n + 1)); done; \
         echo reads=$n",
    );
    sleep(Duration::from_secs(3)).await;
    // The limit leaves 256 MiB beyond what the VMs hold; the hog wants
    // more, so the kernel reclaims from everything under the limit.
    let limit: u64 = squeezed.read("memory.current").trim().parse().unwrap();
    squeezed.write("memory.max", &(limit + 256 * MIB).to_string());
    let mut hog_process = start_hog(&hog);
    let (compressed, ended) = watch_squeeze(&agent, busy, idle, &work).await;
    let output = timeout(Duration::from_secs(30), work)
        .await
        .unwrap()
        .unwrap();
    assert!(output.contains("reads="), "{output}");
    let _ = hog_process.kill();
    let _ = hog_process.wait();
    // The pressure was real: the kernel hit the limit and reclaimed.
    let events = squeezed.read("memory.events");
    let reclaimed = hog.field("memory.stat", "zswpout") + hog.field("memory.stat", "pswpout");
    eprintln!(
        "busy: {output:?}; idle compressed {compressed:?} pages, ended {ended:?}; \
         hog swapped {reclaimed} pages; limit events: {}",
        events.split_whitespace().collect::<Vec<_>>().join(" ")
    );
    assert!(squeezed.field("memory.events", "max") > 0, "{events}");
    assert_eq!(busy_group.field("memory.stat", "zswpout"), 0);
    for n in 0..2 {
        assert!(
            compressed[n] > 0 || ended[n],
            "{:?} was neither compressed nor ended",
            idle[n]
        );
    }
    let log = std::fs::read_to_string(host.root.join("agent.log")).unwrap_or_default();
    assert!(!log.contains("a running VM's memory was compressed"));
    squeezed.write("memory.max", "max");
    let release = Request::Release {
        id: busy,
        generation: None,
        hold: "work".into(),
    };
    assert_eq!(agent.client.call(&release).await.unwrap(), Reply::Done);
    agent.remove_all().await;
    agent.kill();
    std::mem::forget(busy_group);
    drop(hog);
    drop(squeezed);
    host.finish("squeezed");
}
