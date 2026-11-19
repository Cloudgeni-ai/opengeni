//! Save and wake cycles against a real Firecracker on a KVM host.
//!
//! Runs only as root and only when `COMPUTE_TEST_LAB` names a directory
//! prepared by `compute/lab/host-setup.sh` (it holds `bin/firecracker`,
//! `bin/jailer`, `vmlinux` and `base.ext4`, whose guest runs a shell on vsock
//! port 52). `COMPUTE_TEST_PROFILE` picks the host's memory profile
//! (`bare-metal` by default; `nested` needs a reserved 2 MiB page pool), and
//! `COMPUTE_TEST_STORE` (a directory or a `gs://`, `s3://` or `az://` URL)
//! enables the archive and object-storage wake test. `COMPUTE_TEST_REQUIRE`
//! (`lab,store` on a gate) makes a test that cannot run fail.
//!
//! Each test starts a process in the guest that counts in memory, then lets
//! the sandbox fall asleep and wakes it again several times. Every wake
//! must find the same process still counting, from where it left off, and
//! a block of guest memory that changes a little between saves must read
//! back exactly as it was written: that only holds if every diff save was
//! merged correctly into the image the next wake restores.

#![cfg(target_os = "linux")]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use compute_core::HostPolicy;
use compute_engine::MemoryProfile;
use compute_engine::firecracker::{Firecracker, FirecrackerConfig};
use compute_host::client::Client;
use compute_host::protocol::{
    Id, LevelName, PriorityName, Reply, Request, SandboxConfig, SleepConfig,
};
use compute_host::{Chunked, Directory, HostAgent, HostConfig, NoStore, PagerConfig, Store, serve};
use compute_storage::store::ChunkStore;
use object_store::memory::InMemory;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::Instant;

#[path = "support/required.rs"]
mod required;
#[path = "support/state.rs"]
mod state;
#[path = "support/vms.rs"]
mod vms;
use required::skip;
use state::private_dir;

const SHELL_PORT: u32 = 52;

/// How long pagers record first touches here: short, so a pager that has
/// put every page in place exits within the test.
const RECORD_FOR: Duration = Duration::from_secs(3);

/// A recording window long enough that a pager is still there when a test
/// wants to end it.
const RECORD_LONG: Duration = Duration::from_secs(90);

fn lab() -> Option<PathBuf> {
    let lab = std::env::var_os("COMPUTE_TEST_LAB").map(PathBuf::from);
    if lab.is_none() {
        skip("lab", "set COMPUTE_TEST_LAB to run against Firecracker");
    }
    lab
}

fn profile() -> MemoryProfile {
    std::env::var("COMPUTE_TEST_PROFILE").map_or_else(
        |_| MemoryProfile::bare_metal(),
        |name| name.parse().unwrap(),
    )
}

/// A short name for the profile: socket paths have little room.
fn short() -> &'static str {
    if profile() == MemoryProfile::nested() {
        "n"
    } else {
        "b"
    }
}

/// A running agent on a fresh state root, reached through its socket.
struct Agent {
    client: Client,
    root: PathBuf,
    task: tokio::task::JoinHandle<()>,
    /// The cgroup that holds its VMs.
    cgroup: PathBuf,
}

impl Drop for Agent {
    /// Ends the agent as a crash would: its VMs run on, for a later agent
    /// to adopt. A test that fails part way ends them too.
    fn drop(&mut self) {
        self.task.abort();
        if std::thread::panicking() {
            vms::end_vms(&self.cgroup);
        }
    }
}

async fn start<S: Store>(lab: &Path, name: &str, first_uid: u32, store: S) -> Agent {
    start_with(lab, name, first_uid, store, Setup::default()).await
}

/// What sets an in-process agent apart from another on the same machine.
struct Setup {
    /// The cgroup that holds its VMs: two agents holding the same sandbox
    /// need one each.
    cgroup: PathBuf,
    observer: compute_host::observe::Observer,
}

impl Default for Setup {
    fn default() -> Self {
        Self {
            cgroup: "/sys/fs/cgroup/compute-host-test".into(),
            observer: compute_host::observe::Observer::default(),
        }
    }
}

async fn start_with<S: Store>(
    lab: &Path,
    name: &str,
    first_uid: u32,
    store: S,
    setup: Setup,
) -> Agent {
    let root = lab.join("ht").join(name);
    let _ = std::fs::remove_dir_all(&root);
    private_dir(&root);
    restart_with(lab, name, first_uid, store, setup).await
}

/// Starts an agent on the state root of an earlier one, as after a crash.
async fn restart_with<S: Store>(
    lab: &Path,
    name: &str,
    first_uid: u32,
    store: S,
    setup: Setup,
) -> Agent {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_test_writer()
        .try_init();
    let root = lab.join("ht").join(name);
    let cgroup = setup.cgroup.clone();
    let engine = Firecracker::new(FirecrackerConfig {
        firecracker: lab.join("bin/firecracker"),
        retained: Vec::new(),
        jailer: lab.join("bin/jailer"),
        cgroup_parent: setup.cgroup,
    })
    .unwrap()
    .with_memory_profile(profile())
    .unwrap();
    let config = HostConfig {
        root: root.join("s"),
        kernel: lab.join("vmlinux"),
        boot_args: "console=ttyS0 reboot=k panic=1 quiet loglevel=1".into(),
        base_image: lab.join("base.ext4"),
        policy: HostPolicy::default(),
        sample_every: Duration::from_secs(1),
        first_wake_within: HostConfig::FIRST_WAKE_WITHIN,
        disk_reading: None,
        stream_idle: HostConfig::STREAM_IDLE,
        hand_off_unwakeable: HostConfig::HAND_OFF_UNWAKEABLE,
        guest_ports: Vec::new(),
        restore_notice_port: None,
        guest_checks: compute_host::GuestChecks::DEFAULT,
        first_uid,
        network: None,
        busy: None,
        can_compress: true,
        host_lock: None,
        pool: None,
        pager: PagerConfig {
            program: env!("CARGO_BIN_EXE_compute-host").into(),
            record_for: RECORD_FOR,
        },
        about: compute_host::protocol::About::default(),
        lease: None,
        guard_freezes: None,
        observer: setup.observer,
        summary_every: HostConfig::SUMMARY_EVERY,
        recovery_retry: HostConfig::RECOVERY_RETRY,
        agent_link: None,
        processor_share: None,
        prepare: None,
    };
    let socket = root.join("agent.sock");
    let _ = std::fs::remove_file(&socket);
    let (handle, agent) = HostAgent::start(config, engine, store).await.unwrap();
    let serving = socket.clone();
    let task = tokio::spawn(async move {
        tokio::select! {
            result = serve(handle, &serving) => result.unwrap(),
            result = agent => result.unwrap(),
        }
    });
    for _ in 0..100 {
        if socket.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Agent {
        client: Client::new(&socket),
        root,
        task,
        cgroup,
    }
}

/// The cgroup that holds the VMs of an agent run as its own process.
const PROCESS_CGROUP: &str = "/sys/fs/cgroup/compute-host-test";

/// An agent running as its own process, as in production: killing it runs
/// no destructor, so whatever it was doing stops wherever it was.
struct Process {
    client: Client,
    socket: PathBuf,
    child: std::process::Child,
}

impl Drop for Process {
    /// Kills the agent; its VMs run on, as after a crash. A test that
    /// fails part way ends them too.
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if std::thread::panicking() {
            vms::end_vms(Path::new(PROCESS_CGROUP));
        }
    }
}

impl Process {
    /// Starts `compute-host serve` on the state root `name`, keeping what
    /// it holds, with `store` if given, its pagers recording first touches
    /// for `record_for`.
    async fn start(
        lab: &Path,
        name: &str,
        first_uid: u32,
        store: Option<&str>,
        record_for: Duration,
    ) -> Self {
        let root = lab.join("ht").join(name);
        private_dir(&root);
        let socket = root.join("agent.sock");
        let _ = std::fs::remove_file(&socket);
        let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_compute-host"));
        command
            .arg("--socket")
            .arg(&socket)
            .arg("serve")
            .arg("--root")
            .arg(root.join("s"))
            .arg("--firecracker")
            .arg(lab.join("bin/firecracker"))
            .arg("--jailer")
            .arg(lab.join("bin/jailer"))
            .arg("--first-uid")
            .arg(first_uid.to_string())
            .arg("--host-lock")
            .arg(root.join("host.lock"))
            .arg("--kernel")
            .arg(lab.join("vmlinux"))
            .arg("--base-image")
            .arg(lab.join("base.ext4"))
            .arg("--cgroup")
            .arg(PROCESS_CGROUP)
            .arg("--memory-profile")
            .arg(profile().to_string())
            .arg("--busy-cpu-percent")
            .arg("0")
            .arg("--pager-record-ms")
            .arg(record_for.as_millis().to_string());
        if let Some(store) = store {
            command.arg("--store").arg(store);
        }
        let child = command.spawn().unwrap();
        let started = Instant::now();
        while !socket.exists() {
            assert!(
                started.elapsed() < Duration::from_secs(30),
                "the agent never listened"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Self {
            client: Client::new(&socket),
            socket,
            child,
        }
    }

    /// Ends the agent at once with SIGKILL.
    fn kill(mut self) {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
    }
}

/// Runs `script` in the guest's shell, waking the sandbox first.
async fn exec(client: &Client, id: Id, script: &str) -> String {
    let (reply, mut stream) = client
        .connect(id, None, SHELL_PORT, PriorityName::Interactive)
        .await
        .unwrap();
    assert!(matches!(reply, Reply::Connected { .. }), "{reply:?}");
    stream
        .get_mut()
        .write_all(format!("{script}\nexit\n").as_bytes())
        .await
        .unwrap();
    let mut output = Vec::new();
    stream.read_to_end(&mut output).await.unwrap();
    String::from_utf8_lossy(&output).into_owned()
}

async fn wait_for(client: &Client, id: Id, level: LevelName) {
    let started = Instant::now();
    loop {
        let Reply::Status(status) = client.call(&Request::Status).await.unwrap() else {
            panic!("status failed");
        };
        let sandbox = status.sandboxes.iter().find(|s| s.id == id).unwrap();
        if sandbox.level == level && sandbox.step.is_none() {
            assert!(sandbox.memory_saved, "{sandbox:?}");
            return;
        }
        assert!(
            started.elapsed() < Duration::from_secs(120),
            "never reached {level:?}: {sandbox:?}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Pauses after half a second, then each half second goes one level deeper
/// until `deepest`. Saving ends the VM process, so every wake restores.
fn ladder(deepest: LevelName) -> SleepConfig {
    let mut config = SleepConfig {
        pause_after_ms: Some(500),
        save_after_ms: Some(1_000),
        keep_memory: true,
        drop_after_ms: Some(1_000),
        ..SleepConfig::default()
    };
    if matches!(deepest, LevelName::Archived | LevelName::Remote) {
        config.archive_after_ms = Some(1_500);
    }
    if deepest == LevelName::Remote {
        config.evict_after_ms = Some(2_000);
    }
    config
}

/// Starts a process that counts once a second into a file in guest memory,
/// and fills 64 MiB of guest memory with random data. Returns the
/// process's id and the data's checksum.
const SETUP: &str = "\
mkdir -p /dev/shm
mount -t tmpfs -o size=128m tmpfs /dev/shm 2>/dev/null
head -c 64M /dev/urandom > /dev/shm/blob
setsid sh -c 'i=0; while true; do i=$((i+1)); echo $i > /dev/shm/count; sleep 1; done' \
  </dev/null >/dev/null 2>&1 &
echo pid=$!
echo sum=$(md5sum < /dev/shm/blob | cut -d' ' -f1)";

/// Checks on the counter, then changes a random 1 MiB of the data so the
/// next save holds a fresh diff.
fn check(pid: &str) -> String {
    format!(
        "\
kill -0 {pid} && echo alive=yes
echo count=$(cat /dev/shm/count)
echo was=$(md5sum < /dev/shm/blob | cut -d' ' -f1)
dd if=/dev/urandom of=/dev/shm/blob bs=1M count=1 seek=$((RANDOM % 64)) conv=notrunc 2>/dev/null
echo sum=$(md5sum < /dev/shm/blob | cut -d' ' -f1)"
    )
}

fn field<'a>(output: &'a str, name: &str) -> &'a str {
    output
        .lines()
        .find_map(|line| line.strip_prefix(name)?.strip_prefix('='))
        .unwrap_or_else(|| panic!("no {name} in {output:?}"))
        .trim()
}

/// Sleeps to `deepest` and wakes `cycles` times, checking each wake.
async fn cycle(agent: &Agent, id: &str, deepest: LevelName, cycles: u32) {
    let id: Id = id.parse().unwrap();
    let config = SandboxConfig {
        disk_mib: None,
        reach: Vec::new(),
        image: None,
        vcpus: 2,
        memory_mib: 512,
        memory_request_mib: None,
        cpu_request_millis: None,
        sleep: ladder(deepest),
        link: None,
    };
    let created = agent
        .client
        .call(&Request::Create { id, config })
        .await
        .unwrap();
    assert!(matches!(created, Reply::Done), "{created:?}");
    let setup = exec(&agent.client, id, SETUP).await;
    let pid = field(&setup, "pid").to_owned();
    let mut sum = field(&setup, "sum").to_owned();
    let mut count = 0_u64;
    for round in 1..=cycles {
        wait_for(&agent.client, id, deepest).await;
        let started = Instant::now();
        let output = exec(&agent.client, id, &check(&pid)).await;
        let woke = started.elapsed();
        assert_eq!(field(&output, "alive"), "yes", "round {round}: {output}");
        assert_eq!(field(&output, "was"), sum, "round {round}: memory differs");
        let now: u64 = field(&output, "count").parse().unwrap();
        assert!(
            now >= count,
            "round {round}: count went back from {count} to {now}"
        );
        count = now;
        field(&output, "sum").clone_into(&mut sum);
        eprintln!("round {round}: woke from {deepest:?} and checked in {woke:?}, count {count}");
    }
    let images = agent
        .root
        .join("s/vm/firecracker")
        .join(id.to_string())
        .join("images");
    let generations = std::fs::read_dir(&images)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().len() == 16)
        .count();
    assert!(
        generations <= 1,
        "old images left behind in {}",
        images.display()
    );
    let removed = agent
        .client
        .call(&Request::Remove {
            id,
            generation: None,
        })
        .await
        .unwrap();
    assert!(matches!(removed, Reply::Done), "{removed:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn guest_processes_survive_repeated_saves_and_wakes() {
    let Some(lab) = lab() else { return };
    let agent = start(&lab, &format!("s{}", short()), 1 << 30, NoStore).await;
    cycle(
        &agent,
        "00000000-0000-4000-8000-0000000000b1",
        LevelName::Saved,
        5,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn guest_processes_survive_waking_from_object_storage() {
    let Some(lab) = lab() else { return };
    let Ok(url) = std::env::var("COMPUTE_TEST_STORE") else {
        skip("store", "set COMPUTE_TEST_STORE to archive sandboxes");
        return;
    };
    let name = format!("r{}", short());
    if let Some(chunked) = Chunked::from_url(&url).unwrap() {
        let agent = start(&lab, &name, (1 << 30) + 1000, chunked).await;
        cycle(
            &agent,
            "00000000-0000-4000-8000-0000000000b2",
            LevelName::Remote,
            3,
        )
        .await;
    } else {
        let agent = start(&lab, &name, (1 << 30) + 1000, Directory::new(url)).await;
        cycle(
            &agent,
            "00000000-0000-4000-8000-0000000000b2",
            LevelName::Remote,
            3,
        )
        .await;
    }
}

/// A guest whose memory is not kept is ended with nothing of it saved once
/// its rules call for it, and its next wake boots it: its files are as it
/// left them, and its programs and what it held in memory are gone. No
/// memory image is ever made for it.
///
/// The lab's hosts send guests no notice, so nothing asks this guest to
/// write its disk out as it pauses: it syncs its own write, as a guest on
/// a host with a notice port is asked to.
#[tokio::test(flavor = "multi_thread")]
async fn a_guest_whose_memory_is_not_kept_boots_afresh_with_its_files() {
    const UID: u32 = (1 << 30) + 6000;
    let Some(lab) = lab() else { return };
    let agent = start(&lab, &format!("e{}", short()), UID, NoStore).await;
    let id: Id = "00000000-0000-4000-8000-0000000000b9".parse().unwrap();
    let config = SandboxConfig {
        disk_mib: None,
        reach: Vec::new(),
        image: None,
        vcpus: 2,
        memory_mib: 512,
        memory_request_mib: None,
        cpu_request_millis: None,
        sleep: SleepConfig {
            keep_memory: false,
            ..ladder(LevelName::Saved)
        },
        link: None,
    };
    let created = agent
        .client
        .call(&Request::Create { id, config })
        .await
        .unwrap();
    assert!(matches!(created, Reply::Done), "{created:?}");
    exec(&agent.client, id, SETUP).await;
    exec(&agent.client, id, "echo kept > /kept; sync").await;

    let started = Instant::now();
    let launches = loop {
        let status = status(&agent.client).await;
        let sandbox = status.sandboxes.iter().find(|s| s.id == id).unwrap();
        if sandbox.level == LevelName::Saved && sandbox.step.is_none() {
            assert!(!sandbox.memory_saved, "{sandbox:?}");
            break sandbox.launches;
        }
        assert!(
            started.elapsed() < Duration::from_secs(120),
            "its VM never ended: {sandbox:?}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let images = agent
        .root
        .join("s/vm/firecracker")
        .join(id.to_string())
        .join("images");
    let generations = std::fs::read_dir(&images).map_or(0, |entries| {
        entries
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().len() == 16)
            .count()
    });
    assert_eq!(generations, 0, "a memory image in {}", images.display());

    let woke = Instant::now();
    let output = exec(
        &agent.client,
        id,
        "echo kept=$(cat /kept)\n\
         test -e /dev/shm/count && echo counting=yes || echo counting=no\n\
         test -e /dev/shm/blob && echo blob=yes || echo blob=no",
    )
    .await;
    eprintln!("booted afresh and checked in {:?}", woke.elapsed());
    assert_eq!(field(&output, "kept"), "kept", "{output}");
    assert_eq!(field(&output, "counting"), "no", "{output}");
    assert_eq!(field(&output, "blob"), "no", "{output}");
    let status = status(&agent.client).await;
    let sandbox = status.sandboxes.iter().find(|s| s.id == id).unwrap();
    assert_eq!(sandbox.launches, launches + 1, "{sandbox:?}");

    let removed = agent
        .client
        .call(&Request::Remove {
            id,
            generation: None,
        })
        .await
        .unwrap();
    assert!(matches!(removed, Reply::Done), "{removed:?}");
}

/// Wakes the sandbox through a pager, then kills the agent process while
/// the guest is about to read memory it has not touched since the wake.
/// The pager is a process of its own and stays: the guest must read its
/// memory exactly as saved (waiting, if it lives in the store, until a new
/// agent fills it in), and a new agent process on the same state must
/// reconnect to the pager so the guest goes on. Once every page is in
/// place the pager must hand the guest's memory to the kernel and exit,
/// leaving the VM running without it.
async fn survive_restart(lab: &Path, name: &str, deepest: LevelName, store: Option<&str>) {
    const UID: u32 = (1 << 30) + 2000;
    let id: Id = "00000000-0000-4000-8000-0000000000b3".parse().unwrap();
    let _ = std::fs::remove_dir_all(lab.join("ht").join(name));
    let agent = Process::start(lab, name, UID, store, RECORD_FOR).await;
    let config = SandboxConfig {
        disk_mib: None,
        reach: Vec::new(),
        image: None,
        vcpus: 2,
        memory_mib: 512,
        memory_request_mib: None,
        cpu_request_millis: None,
        sleep: ladder(deepest),
        link: None,
    };
    let created = agent
        .client
        .call(&Request::Create { id, config })
        .await
        .unwrap();
    assert!(matches!(created, Reply::Done), "{created:?}");
    let setup = exec(&agent.client, id, SETUP).await;
    let pid = field(&setup, "pid").to_owned();
    let sum = field(&setup, "sum").to_owned();
    wait_for(&agent.client, id, deepest).await;
    // The wake reads nothing of the blob; two seconds later, with no pager
    // left, the guest reads all of it.
    let later = format!(
        "\
kill -0 {pid} && echo alive=yes
setsid sh -c 'sleep 2; md5sum < /dev/shm/blob | cut -d\" \" -f1 > /dev/shm/later' \
  </dev/null >/dev/null 2>&1 &
echo started=yes"
    );
    let output = exec(&agent.client, id, &later).await;
    assert_eq!(field(&output, "alive"), "yes", "{output}");
    agent.kill();
    tokio::time::sleep(Duration::from_secs(4)).await;

    let agent = Process::start(lab, name, UID, store, RECORD_FOR).await;
    let read = "\
for _ in $(seq 100); do [ -s /dev/shm/later ] && break; sleep 0.1; done
echo later=$(cat /dev/shm/later)";
    let output = exec(&agent.client, id, read).await;
    assert_eq!(
        field(&output, "later"),
        sum,
        "memory read while no pager ran differs"
    );
    // Kept awake meanwhile, the VM ends up without a pager.
    let awake = {
        let client = Client::new(&agent.socket);
        tokio::spawn(async move { exec(&client, id, "sleep 100").await })
    };
    vmm_unpaged(id).await;
    awake.abort();
    // It wrote what it learned as the VM's user, though the state root
    // above its directory is root's alone.
    let learned = lab
        .join("ht")
        .join(name)
        .join("s/vm/firecracker")
        .join(id.to_string())
        .join("pager/learned.json");
    assert!(
        learned.exists(),
        "the pager did not write {}",
        learned.display()
    );
    let output = exec(
        &agent.client,
        id,
        &format!("kill -0 {pid} && echo alive=yes"),
    )
    .await;
    assert_eq!(field(&output, "alive"), "yes", "{output}");
    // Saving and waking still work.
    wait_for(&agent.client, id, deepest).await;
    let output = exec(&agent.client, id, &check(&pid)).await;
    assert_eq!(field(&output, "alive"), "yes", "{output}");
    assert_eq!(
        field(&output, "was"),
        sum,
        "memory differs after the next save"
    );
    let removed = agent
        .client
        .call(&Request::Remove {
            id,
            generation: None,
        })
        .await
        .unwrap();
    assert!(matches!(removed, Reply::Done), "{removed:?}");
}

/// Waits until VM `id` runs without a pager, its memory no longer
/// registered with a fault handler.
async fn vmm_unpaged(id: Id) {
    let started = Instant::now();
    loop {
        let pids = group_processes(id);
        let vmm = pids.iter().copied().find(|pid| {
            std::fs::read_to_string(format!("/proc/{pid}/comm"))
                .is_ok_and(|comm| comm.trim() == "firecracker")
        });
        if let Some(vmm) = vmm
            && pagers(id).is_empty()
        {
            let maps = std::fs::read_to_string(format!("/proc/{vmm}/smaps")).unwrap_or_default();
            let registered = maps
                .lines()
                .filter_map(|line| line.strip_prefix("VmFlags:"))
                .any(|flags| flags.split_whitespace().any(|flag| flag == "um"));
            if !registered {
                eprintln!("the pager left after {:?}", started.elapsed());
                return;
            }
        }
        assert!(
            started.elapsed() < Duration::from_secs(90),
            "the pager never finished: processes {pids:?}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_paged_guest_survives_its_agent_restarting() {
    let Some(lab) = lab() else { return };
    let name = format!("p{}", short());
    if let Some((deepest, store)) = paged_wake("restart") {
        survive_restart(&lab, &name, deepest, store.as_deref()).await;
    }
}

/// A paged guest whose VMM does not answer when a new agent starts, as
/// one the guard holds frozen does, is blocked while its pager is served
/// in the background, then taken back by a later try once the VMM answers
/// again: the guest reads its memory exactly as saved, and the pager is
/// served by one connection at a time until it leaves.
#[tokio::test(flavor = "multi_thread")]
#[expect(clippy::too_many_lines, reason = "one scenario, step by step")]
async fn a_paged_guest_frozen_at_restart_is_taken_back_later() {
    const UID: u32 = (1 << 30) + 3000;
    let Some(lab) = lab() else { return };
    let Some((deepest, store)) = paged_wake("frozen") else {
        return;
    };
    let store = store.as_deref();
    let name = format!("f{}", short());
    let id: Id = "00000000-0000-4000-8000-0000000000b4".parse().unwrap();
    let _ = std::fs::remove_dir_all(lab.join("ht").join(&name));
    let agent = Process::start(&lab, &name, UID, store, RECORD_FOR).await;
    let config = SandboxConfig {
        disk_mib: None,
        reach: Vec::new(),
        image: None,
        vcpus: 2,
        memory_mib: 512,
        memory_request_mib: None,
        cpu_request_millis: None,
        sleep: ladder(deepest),
        link: None,
    };
    let created = agent
        .client
        .call(&Request::Create { id, config })
        .await
        .unwrap();
    assert!(matches!(created, Reply::Done), "{created:?}");
    let setup = exec(&agent.client, id, SETUP).await;
    let pid = field(&setup, "pid").to_owned();
    let sum = field(&setup, "sum").to_owned();
    wait_for(&agent.client, id, deepest).await;
    let later = format!(
        "\
kill -0 {pid} && echo alive=yes
setsid sh -c 'sleep 2; md5sum < /dev/shm/blob | cut -d\" \" -f1 > /dev/shm/later' \
  </dev/null >/dev/null 2>&1 &
echo started=yes"
    );
    let output = exec(&agent.client, id, &later).await;
    assert_eq!(field(&output, "alive"), "yes", "{output}");
    agent.kill();

    let vmm = group_processes(id)
        .into_iter()
        .find(|pid| {
            std::fs::read_to_string(format!("/proc/{pid}/comm"))
                .is_ok_and(|comm| comm.trim() == "firecracker")
        })
        .expect("the VMM runs on");
    let signal = |name: &str| {
        let status = std::process::Command::new("kill")
            .arg(format!("-{name}"))
            .arg(vmm.to_string())
            .status()
            .unwrap();
        assert!(status.success(), "kill -{name} {vmm}");
    };
    signal("STOP");
    let agent = Process::start(&lab, &name, UID, store, RECORD_FOR).await;
    let blocked = loop {
        let status = status(&agent.client).await;
        if !status.blocked.is_empty() || status.sandboxes.iter().any(|s| s.id == id) {
            break status;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    signal("CONT");
    assert_eq!(blocked.blocked.len(), 1, "{blocked:?}");
    assert!(pagers(id).len() <= 1, "one pager at most: {:?}", pagers(id));

    let started = Instant::now();
    loop {
        let status = status(&agent.client).await;
        if status.blocked.is_empty() && status.sandboxes.iter().any(|s| s.id == id) {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(240),
            "never taken back: {status:?}"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let read = "\
for _ in $(seq 100); do [ -s /dev/shm/later ] && break; sleep 0.1; done
echo later=$(cat /dev/shm/later)";
    let output = exec(&agent.client, id, read).await;
    assert_eq!(
        field(&output, "later"),
        sum,
        "memory read while the VMM was frozen differs"
    );
    let output = exec(
        &agent.client,
        id,
        &format!("kill -0 {pid} && echo alive=yes"),
    )
    .await;
    assert_eq!(field(&output, "alive"), "yes", "{output}");
    let removed = agent
        .client
        .call(&Request::Remove {
            id,
            generation: None,
        })
        .await
        .unwrap();
    assert!(matches!(removed, Reply::Done), "{removed:?}");
}

/// The deepest level whose wake goes through a pager on this host, and the
/// store it needs (under `prefix`), or `None` when the test cannot run.
fn paged_wake(prefix: &str) -> Option<(LevelName, Option<String>)> {
    if profile().needs_pager() {
        // Every restore on a huge-page host goes through a pager.
        return Some((LevelName::Saved, None));
    }
    let Ok(url) = std::env::var("COMPUTE_TEST_STORE") else {
        skip(
            "store",
            "4 KiB pages page only from a store; set COMPUTE_TEST_STORE",
        );
        return None;
    };
    let url = format!("{url}/{prefix}");
    if Chunked::from_url(&url).unwrap().is_none() {
        skip("chunked", "only a chunked store pages memory in");
        return None;
    }
    Some((LevelName::Remote, Some(url)))
}

/// The processes in VM `id`'s cgroup: its VMM, its pager while it has one,
/// and the engine's holder.
fn group_processes(id: Id) -> Vec<u32> {
    let group = PathBuf::from("/sys/fs/cgroup/compute-host-test").join(id.to_string());
    std::fs::read_to_string(group.join("cgroup.procs"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.parse().ok())
        .collect()
}

/// VM `id`'s pager, while it has one: the agent's binary run with `pager`
/// as its first argument.
fn pagers(id: Id) -> Vec<u32> {
    group_processes(id)
        .into_iter()
        .filter(|pid| {
            std::fs::read(format!("/proc/{pid}/cmdline"))
                .is_ok_and(|cmdline| cmdline.split(|&byte| byte == 0).nth(1) == Some(&b"pager"[..]))
        })
        .collect()
}

/// Checks that `pager`, in VM `id`'s cgroup, runs as the VM's VMM does,
/// with no other groups, no capabilities and no way to gain any.
fn runs_as_its_vm(id: Id, pager: u32) {
    let status = |pid: u32| std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
    let field = |status: &str, name: &str| {
        status
            .lines()
            .find_map(|line| line.strip_prefix(name)?.strip_prefix(':'))
            .unwrap_or_else(|| panic!("no {name}"))
            .trim()
            .to_owned()
    };
    let vmm = group_processes(id)
        .into_iter()
        .find(|pid| {
            std::fs::read_to_string(format!("/proc/{pid}/comm"))
                .is_ok_and(|comm| comm.trim() == "firecracker")
        })
        .expect("the VM has a VMM");
    let (vmm, pager) = (status(vmm), status(pager));
    for name in ["Uid", "Gid"] {
        let ids = field(&vmm, name);
        assert!(!ids.starts_with('0'), "the VMM runs as {name} {ids}");
        assert_eq!(field(&pager, name), ids, "the pager's {name}");
    }
    assert_eq!(field(&pager, "Groups"), "");
    for name in ["CapInh", "CapPrm", "CapEff", "CapAmb"] {
        assert_eq!(field(&pager, name), "0".repeat(16), "the pager's {name}");
    }
    assert_eq!(field(&pager, "NoNewPrivs"), "1");
    eprintln!("the pager runs as {}", field(&pager, "Uid"));
}

/// A pager that dies while its VM still needs it leaves a guest that can
/// never run again. With no agent around when it dies, the next agent
/// must find that out, end the VM rather than adopt it, and boot the
/// sandbox afresh: its guest ran after the last save, so no image stands
/// in for it.
#[tokio::test(flavor = "multi_thread")]
async fn a_guest_whose_pager_died_boots_afresh() {
    const UID: u32 = (1 << 30) + 2100;
    let Some(lab) = lab() else { return };
    let Some((deepest, store)) = paged_wake("pager-death") else {
        return;
    };
    let store = store.as_deref();
    let name = format!("d{}", short());
    let id: Id = "00000000-0000-4000-8000-0000000000b4".parse().unwrap();
    let _ = std::fs::remove_dir_all(lab.join("ht").join(&name));
    let agent = Process::start(&lab, &name, UID, store, RECORD_LONG).await;
    let config = SandboxConfig {
        disk_mib: None,
        reach: Vec::new(),
        image: None,
        vcpus: 2,
        memory_mib: 512,
        memory_request_mib: None,
        cpu_request_millis: None,
        sleep: ladder(deepest),
        link: None,
    };
    let created = agent
        .client
        .call(&Request::Create { id, config })
        .await
        .unwrap();
    assert!(matches!(created, Reply::Done), "{created:?}");
    let setup = exec(&agent.client, id, SETUP).await;
    let pid = field(&setup, "pid").to_owned();
    wait_for(&agent.client, id, deepest).await;
    let output = exec(
        &agent.client,
        id,
        &format!("kill -0 {pid} && echo alive=yes"),
    )
    .await;
    assert_eq!(field(&output, "alive"), "yes", "{output}");
    agent.kill();
    let pager = pagers(id);
    assert_eq!(pager.len(), 1, "the woken VM has no pager: {pager:?}");
    runs_as_its_vm(id, pager[0]);
    let killed = std::process::Command::new("kill")
        .args(["-KILL", &pager[0].to_string()])
        .status()
        .unwrap();
    assert!(killed.success());

    let agent = Process::start(&lab, &name, UID, store, RECORD_FOR).await;
    let output = exec(
        &agent.client,
        id,
        &format!(
            "kill -0 {pid} 2>/dev/null && echo alive=yes; [ -e /dev/shm/blob ] || echo fresh=yes"
        ),
    )
    .await;
    assert_eq!(
        field(&output, "fresh"),
        "yes",
        "the old guest went on: {output}"
    );
    let removed = agent
        .client
        .call(&Request::Remove {
            id,
            generation: None,
        })
        .await
        .unwrap();
    assert!(matches!(removed, Reply::Done), "{removed:?}");
}

/// The next event of a checkpoint of `id` that ended done.
async fn checkpoint_done(
    events: &mut tokio::sync::mpsc::Receiver<compute_host::observe::Event>,
    id: Id,
) -> compute_host::observe::Event {
    use compute_host::observe::Value;
    let sandbox = id.to_string();
    let text = |event: &compute_host::observe::Event, key: &str| match event.get(key) {
        Some(Value::Str(text)) => Some(text.to_string()),
        _ => None,
    };
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let event = tokio::time::timeout_at(deadline, events.recv())
            .await
            .expect("no checkpoint within a minute")
            .expect("the observer ended");
        if event.name != "compute.step"
            || text(&event, "compute.sandbox.id").as_deref() != Some(sandbox.as_str())
            || text(&event, "compute.step").as_deref() != Some("checkpoint")
        {
            continue;
        }
        assert_eq!(
            text(&event, "compute.outcome").as_deref(),
            Some("done"),
            "{event:?}"
        );
        return event;
    }
}

fn micros(event: &compute_host::observe::Event, key: &str) -> u64 {
    match event.get(key) {
        Some(compute_host::observe::Value::Int(us)) => u64::try_from(*us).unwrap(),
        other => panic!("{key}: {other:?} in {event:?}"),
    }
}

async fn status(client: &Client) -> compute_host::protocol::HostStatus {
    match client.call(&Request::Status).await.unwrap() {
        Reply::Status(status) => *status,
        other => panic!("{other:?}"),
    }
}

/// The first uid of the first host in the checkpoint test; the second
/// starts a thousand higher.
const CHECKPOINT_UID: u32 = (1 << 30) + 4000;

/// A sandbox in use is checkpointed while it runs: its disk alone is
/// copied, and its guest is never paused. Losing its host then costs its
/// running programs, as it always would, and what it wrote since. Another
/// host adopts it under a later owner epoch, even whole as a hand-off's
/// copy is taken, and boots it from the checkpoint's disk with its files as
/// they were, and the first host's next checkpoint finds itself fenced off
/// and drops its copy.
///
/// Both hosts keep sandboxes in one store that stamps each with its owner,
/// as a fleet's does: the bucket `COMPUTE_TEST_STORE` names, or else one
/// in memory.
#[tokio::test(flavor = "multi_thread")]
async fn a_checkpoint_of_a_running_guest_boots_it_on_another_host_with_its_files() {
    let Some(lab) = lab() else { return };
    let store = std::env::var("COMPUTE_TEST_STORE")
        .ok()
        .and_then(|url| Chunked::from_url(&url).unwrap())
        .unwrap_or_else(|| {
            Chunked::new(ChunkStore::new(
                Arc::new(InMemory::new()),
                "checkpoint".into(),
            ))
        });
    let id: Id = "00000000-0000-4000-8000-0000000000b6".parse().unwrap();
    let Some((one, mut events)) = checkpointing(&lab, store.clone()).await else {
        return;
    };
    // The host it moves to is up before the move, so the fleet's adoption
    // follows the last writes at once, well before the next checkpoint.
    let two = start_with(
        &lab,
        &format!("l{}", short()),
        CHECKPOINT_UID + 1000,
        store,
        Setup {
            cgroup: "/sys/fs/cgroup/compute-host-test-2".into(),
            ..Setup::default()
        },
    )
    .await;
    let config = SandboxConfig {
        disk_mib: None,
        reach: Vec::new(),
        vcpus: 2,
        memory_mib: 512,
        memory_request_mib: None,
        cpu_request_millis: None,
        sleep: SleepConfig {
            checkpoint_every_ms: Some(4_000),
            ..SleepConfig::default()
        },
        image: None,
        link: None,
    };
    let created = one
        .client
        .call(&Request::Create {
            id,
            config: config.clone(),
        })
        .await
        .unwrap();
    assert!(matches!(created, Reply::Done), "{created:?}");
    let setup = exec(&one.client, id, SETUP).await;
    let pid = field(&setup, "pid").to_owned();
    checkpoint_twice(&one, &mut events, id, &pid).await;
    // What it does from now on is in no copy.
    exec(
        &one.client,
        id,
        "echo lost > /lost; echo lost > /dev/shm/lost",
    )
    .await;
    // Its host is cut off, and the fleet gives it to another under a later
    // owner epoch.
    adopt_checkpointed(&two, id, config).await;
    // The first host's next checkpoint finds a later owner and drops its
    // copy, ending its VM.
    let fenced = Instant::now();
    while status(&one.client)
        .await
        .sandboxes
        .iter()
        .any(|sandbox| sandbox.id == id)
    {
        assert!(
            fenced.elapsed() < Duration::from_secs(30),
            "the first host kept a sandbox another owns"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let removed = two
        .client
        .call(&Request::Remove {
            id,
            generation: None,
        })
        .await
        .unwrap();
    assert!(matches!(removed, Reply::Done), "{removed:?}");
}

/// An agent keeping sandboxes in `store`, with a tap on its events; none
/// when the lab directory's files share no extents, so it takes no
/// checkpoints.
async fn checkpointing(
    lab: &Path,
    store: Chunked,
) -> Option<(
    Agent,
    tokio::sync::mpsc::Receiver<compute_host::observe::Event>,
)> {
    use compute_host::observe::{ObserveConfig, Observer};
    let (tap, events) = tokio::sync::mpsc::channel(4096);
    let observer = Observer::start(ObserveConfig {
        journal: false,
        tap: Some(tap),
        ..ObserveConfig::default()
    });
    let agent = start_with(
        lab,
        &format!("k{}", short()),
        CHECKPOINT_UID,
        store,
        Setup {
            observer,
            ..Setup::default()
        },
    )
    .await;
    if !status(&agent.client).await.about.checkpoints {
        skip("lab", "files under the lab directory share no extents");
        return None;
    }
    Some((agent, events))
}

/// Waits out `id`'s first checkpoint and, once its disk and memory
/// changed, one whose clone was taken after the change, and prints how
/// long each took. None pauses the guest: process `pid` runs throughout.
///
/// A checkpoint that takes longer than the time between two is followed
/// at once by the next, whose clone may then be taken before the change
/// is written: that one does not hold it, and the one after is awaited.
///
/// The guest writes its change out itself. A checkpoint copies the disk
/// and no memory, so it holds what has reached the disk; these hosts set
/// no restore notice port, so nothing here asks the guest to write its
/// disks out before the clone, as a deployed host does.
async fn checkpoint_twice(
    agent: &Agent,
    events: &mut tokio::sync::mpsc::Receiver<compute_host::observe::Event>,
    id: Id,
    pid: &str,
) {
    let first = checkpoint_done(events, id).await;
    let output = exec(
        &agent.client,
        id,
        &format!("{}\necho kept > /kept; sync", check(pid)),
    )
    .await;
    assert_eq!(field(&output, "alive"), "yes", "{output}");
    let written = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let mut later = Vec::new();
    let checkpointed = loop {
        later.push(checkpoint_done(events, id).await);
        let checkpointed = status(&agent.client)
            .await
            .sandboxes
            .into_iter()
            .find(|sandbox| sandbox.id == id)
            .unwrap();
        if checkpointed
            .backed_up_ms
            .is_some_and(|cloned| u128::from(cloned) >= written)
        {
            break checkpointed;
        }
        assert!(later.len() < 4, "no checkpoint cloned after the change");
    };
    for event in std::iter::once(&first).chain(&later) {
        assert!(
            event.get("compute.paused_us").is_none(),
            "a checkpoint paused its guest: {event:?}"
        );
    }
    eprintln!(
        "checkpoints took {} us and then {:?} us",
        micros(&first, "compute.duration_us"),
        later
            .iter()
            .map(|event| micros(event, "compute.duration_us"))
            .collect::<Vec<_>>(),
    );
    assert_eq!(checkpointed.level, LevelName::Running);
}

/// Adopts `id` on `agent` under owner epoch 2, whole, and checks that its
/// guest booted from its last checkpoint's disk: its programs and memory
/// gone, its disk holding what it wrote before, and nothing it did after.
async fn adopt_checkpointed(agent: &Agent, id: Id, config: SandboxConfig) {
    let adopted = agent
        .client
        .call(&Request::Adopt {
            id,
            config,
            owner_epoch: 2,
            whole: true,
        })
        .await
        .unwrap();
    assert!(matches!(adopted, Reply::Done), "{adopted:?}");
    let started = Instant::now();
    let output = exec(
        &agent.client,
        id,
        "test -e /dev/shm/count || echo booted=yes\necho disk=$(cat /kept)\necho lost=$(cat /lost /dev/shm/lost 2>/dev/null | wc -l)",
    )
    .await;
    eprintln!(
        "booted on the second host from the checkpoint in {:?}",
        started.elapsed()
    );
    assert_eq!(
        field(&output, "booted"),
        "yes",
        "no memory came back: {output}"
    );
    assert_eq!(field(&output, "disk"), "kept", "{output}");
    assert_eq!(
        field(&output, "lost"),
        "0",
        "nothing done after it: {output}"
    );
}

/// Hands `id`, held under `owner_epoch`, off from `agent` once it is
/// saved, as the fleet does for a move or a resize.
async fn saved_and_handed_off(agent: &Agent, id: Id, owner_epoch: u64) {
    let slept = agent
        .client
        .call(&Request::Sleep {
            id,
            generation: None,
            level: LevelName::Saved,
        })
        .await
        .unwrap();
    assert!(matches!(slept, Reply::Done), "{slept:?}");
    wait_for(&agent.client, id, LevelName::Saved).await;
    let handed_off = agent
        .client
        .call(&Request::HandOff {
            id,
            owner_epoch,
            awake: false,
        })
        .await
        .unwrap();
    assert!(matches!(handed_off, Reply::Done), "{handed_off:?}");
}

/// Has `agent` take `id` up under `owner_epoch` at the shape `config`
/// gives, as after a resize: `whole` as the service sends it, only while
/// the machine stays the same.
async fn adopt_resized(
    agent: &Agent,
    id: Id,
    owner_epoch: u64,
    config: SandboxConfig,
    whole: bool,
) {
    let adopted = agent
        .client
        .call(&Request::Adopt {
            id,
            config,
            owner_epoch,
            whole,
        })
        .await
        .unwrap();
    assert!(matches!(adopted, Reply::Done), "{adopted:?}");
}

/// How long, in MiB, the guest sees the drive its root file system is on.
/// This lab's guests take no restore notices, so they do not grow their
/// file system when their drive grows: the guest tests check that.
async fn root_drive_mib(agent: &Agent, id: Id) -> u64 {
    let output = exec(
        &agent.client,
        id,
        "echo sectors=$(cat /sys/dev/block/$(awk '$5 == \"/\" {print $3}' /proc/self/mountinfo | tail -1)/size)",
    )
    .await;
    let sectors: u64 = field(&output, "sectors")
        .parse()
        .unwrap_or_else(|_| panic!("{output}"));
    (sectors * 512) >> 20
}

/// A sandbox resized as the fleet resizes one (ADR 27): handed off, then
/// adopted at its new shape. Given a longer disk and a new request, it is
/// restored with its programs and its VM told its drive grew; given more
/// processors and memory, it boots from its disk at that machine, its
/// programs gone and its files and disk kept.
#[tokio::test(flavor = "multi_thread")]
async fn a_resized_sandbox_keeps_its_files_and_its_programs_only_on_the_same_machine() {
    const UID: u32 = (1 << 30) + 5000;
    let Some(lab) = lab() else { return };
    let store = Chunked::new(ChunkStore::new(Arc::new(InMemory::new()), "resize".into()));
    let id: Id = "00000000-0000-4000-8000-0000000000b8".parse().unwrap();
    let one = start(&lab, &format!("z{}", short()), UID, store.clone()).await;
    let two = start_with(
        &lab,
        &format!("y{}", short()),
        UID + 1000,
        store,
        Setup {
            cgroup: "/sys/fs/cgroup/compute-host-test-2".into(),
            ..Setup::default()
        },
    )
    .await;
    let mut config = SandboxConfig {
        disk_mib: None,
        reach: Vec::new(),
        vcpus: 1,
        memory_mib: 512,
        memory_request_mib: None,
        cpu_request_millis: None,
        sleep: SleepConfig::default(),
        image: None,
        link: None,
    };
    let created = one
        .client
        .call(&Request::Create {
            id,
            config: config.clone(),
        })
        .await
        .unwrap();
    assert!(matches!(created, Reply::Done), "{created:?}");
    let setup = exec(
        &one.client,
        id,
        &format!("{SETUP}\necho kept > /kept; sync"),
    )
    .await;
    let sum = field(&setup, "sum").to_owned();
    let before = root_drive_mib(&one, id).await;

    // A longer disk and a new request: the same machine.
    saved_and_handed_off(&one, id, 1).await;
    let base = std::fs::metadata(lab.join("base.ext4")).unwrap().len() >> 20;
    let longer = before.max(base) + 512;
    config.disk_mib = Some(u32::try_from(longer).unwrap());
    config.memory_request_mib = Some(256);
    adopt_resized(&two, id, 2, config.clone(), true).await;
    let output = exec(
        &two.client,
        id,
        "echo count=$(cat /dev/shm/count)\n\
         echo was=$(md5sum < /dev/shm/blob | cut -d' ' -f1)\n\
         echo disk=$(cat /kept)",
    )
    .await;
    assert!(
        field(&output, "count").parse::<u64>().is_ok(),
        "its programs carried on: {output}"
    );
    assert_eq!(field(&output, "was"), sum, "{output}");
    assert_eq!(field(&output, "disk"), "kept", "{output}");
    assert_eq!(
        root_drive_mib(&two, id).await,
        longer,
        "its drive grew from {before} MiB before it ran on"
    );

    // More processors and memory: another machine, booted from its disk.
    // This lab's agents have no notice port to ask the guest to write its
    // disks out before a save, as hosts do, so the test asks.
    exec(&two.client, id, "sync").await;
    saved_and_handed_off(&two, id, 2).await;
    config.vcpus = 2;
    config.memory_mib = 1024;
    adopt_resized(&one, id, 3, config, false).await;
    let output = exec(
        &one.client,
        id,
        "echo count=$(cat /dev/shm/count 2>/dev/null)\n\
         echo cpus=$(nproc)\n\
         echo memory=$(awk '/MemTotal/ {print $2}' /proc/meminfo)\n\
         echo disk=$(cat /kept)",
    )
    .await;
    assert_eq!(field(&output, "count"), "", "its programs ended: {output}");
    assert_eq!(field(&output, "cpus"), "2", "{output}");
    let memory_kib: u64 = field(&output, "memory").parse().unwrap();
    assert!(memory_kib > 768 * 1024, "{output}");
    assert_eq!(field(&output, "disk"), "kept", "{output}");
    assert_eq!(root_drive_mib(&one, id).await, longer, "it kept its disk");
    let removed = one
        .client
        .call(&Request::Remove {
            id,
            generation: None,
        })
        .await
        .unwrap();
    assert!(matches!(removed, Reply::Done), "{removed:?}");
}
