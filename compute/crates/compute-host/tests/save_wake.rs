//! Save and wake cycles against a real Firecracker on a KVM host.
//!
//! Runs only as root and only when `COMPUTE_TEST_LAB` names a directory
//! prepared by `compute/lab/host-setup.sh` (it holds `bin/firecracker`,
//! `bin/jailer`, `vmlinux` and `base.ext4`, whose guest runs a shell on vsock
//! port 52). `COMPUTE_TEST_PROFILE` picks the host's memory profile
//! (`bare-metal` by default; `nested` needs a reserved 2 MiB page pool), and
//! `COMPUTE_TEST_STORE` (a directory or a `gs://`, `s3://` or `az://` URL)
//! enables the archive and object-storage wake test.
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
use compute_host::{Chunked, Directory, HostAgent, HostConfig, NoStore, Store, serve};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::Instant;

const SHELL_PORT: u32 = 52;

fn lab() -> Option<PathBuf> {
    let lab = std::env::var_os("COMPUTE_TEST_LAB").map(PathBuf::from);
    if lab.is_none() {
        eprintln!("skipped: set COMPUTE_TEST_LAB to run against Firecracker");
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
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_test_writer()
        .try_init();
    let root = lab.join("ht").join(name);
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let engine = Firecracker::new(FirecrackerConfig {
        firecracker: lab.join("bin/firecracker"),
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
        guest_ports: Vec::new(),
        restore_notice_port: None,
        first_uid,
        network: None,
        busy: None,
        can_compress: true,
        host_lock: None,
    };
    let socket = root.join("agent.sock");
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

/// Runs `script` in the guest's shell, waking the sandbox first.
async fn exec(client: &Client, id: Id, script: &str) -> String {
    let (reply, mut stream) = client
        .connect(id, SHELL_PORT, PriorityName::Interactive)
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
        eprintln!("skipped: set COMPUTE_TEST_STORE to archive sandboxes");
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
