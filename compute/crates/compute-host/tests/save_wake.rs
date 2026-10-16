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
use std::time::Duration;

use compute_core::HostPolicy;
use compute_engine::MemoryProfile;
use compute_engine::firecracker::{Firecracker, FirecrackerConfig};
use compute_host::client::Client;
use compute_host::protocol::{
    Id, LevelName, PriorityName, Reply, Request, SandboxConfig, SleepConfig,
};
use compute_host::{Chunked, Directory, HostAgent, HostConfig, NoStore, PagerConfig, Store, serve};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::Instant;

#[path = "support/required.rs"]
mod required;
use required::skip;

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
}

impl Drop for Agent {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn start<S: Store>(lab: &Path, name: &str, first_uid: u32, store: S) -> Agent {
    let root = lab.join("ht").join(name);
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    restart(lab, name, first_uid, store).await
}

/// Starts an agent on the state root of an earlier one, as after a crash.
async fn restart<S: Store>(lab: &Path, name: &str, first_uid: u32, store: S) -> Agent {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_test_writer()
        .try_init();
    let root = lab.join("ht").join(name);
    let engine = Firecracker::new(FirecrackerConfig {
        firecracker: lab.join("bin/firecracker"),
        retained: Vec::new(),
        jailer: lab.join("bin/jailer"),
        cgroup_parent: "/sys/fs/cgroup/compute-host-test".into(),
    })
    .unwrap()
    .with_memory_profile(profile())
    .unwrap();
    let config = HostConfig {
        root: root.join("s"),
        kernel: lab.join("vmlinux"),
        boot_args:
            "console=ttyS0 reboot=k panic=1 quiet loglevel=1 page_reporting.page_reporting_order=0"
                .into(),
        base_image: lab.join("base.ext4"),
        policy: HostPolicy::default(),
        sample_every: Duration::from_secs(1),
        stream_idle: HostConfig::STREAM_IDLE,
        guest_ports: Vec::new(),
        restore_notice_port: None,
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
    }
}

/// An agent running as its own process, as in production: killing it runs
/// no destructor, so whatever it was doing stops wherever it was.
struct Process {
    client: Client,
    socket: PathBuf,
    child: std::process::Child,
}

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
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
        std::fs::create_dir_all(&root).unwrap();
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
            .arg("/sys/fs/cgroup/compute-host-test")
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
        vcpus: 2,
        memory_mib: 512,
        memory_request_mib: None,
        cpu_request_millis: None,
        sleep: ladder(deepest),
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
        vcpus: 2,
        memory_mib: 512,
        memory_request_mib: None,
        cpu_request_millis: None,
        sleep: ladder(deepest),
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
        vcpus: 2,
        memory_mib: 512,
        memory_request_mib: None,
        cpu_request_millis: None,
        sleep: ladder(deepest),
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
