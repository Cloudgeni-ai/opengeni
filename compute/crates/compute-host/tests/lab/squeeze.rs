//! Sandboxes in use above their request when their host's memory runs
//! out: the kernel compresses what they borrowed and they run on, slower;
//! they are never paused for memory, and a sandbox within its request is
//! never touched (ADR 24).

use super::memory::{hold_running, nested};
use super::*;

const MIB: u64 = 1 << 20;

fn find(status: &HostStatus, sandbox: Id) -> &SandboxStatus {
    status
        .sandboxes
        .iter()
        .find(|found| found.id == sandbox)
        .unwrap()
}

/// Pages of `sandbox` its VM compressed since it started.
fn compressed_pages(status: &HostStatus, sandbox: Id) -> u64 {
    find(status, sandbox)
        .memory
        .as_ref()
        .map_or(0, |memory| memory.zswpout)
}

/// Writes `mib` MiB of text that compresses well, but is not zeros (the
/// kernel keeps zero pages out of zswap), to `path` in the guest.
fn fill(path: &str, mib: u64) -> String {
    format!("yes {path} | head -c {mib}M > {path}")
}

/// Whether `path` in the guest still holds what [`fill`] wrote.
fn intact(path: &str, mib: u64) -> String {
    format!(
        "[ \"$(md5sum < {path})\" = \"$(yes {path} | head -c {mib}M | md5sum)\" ] \
         && echo intact-{mib}"
    )
}

/// Watches `sandboxes` until told to stop, failing the test as soon as
/// one is anything but running, is paused for memory or was launched
/// again; yields how many readings it took.
fn watch(
    client: &Client,
    sandboxes: Vec<(Id, u64)>,
) -> (
    tokio::sync::oneshot::Sender<()>,
    tokio::task::JoinHandle<usize>,
) {
    let (stop, mut stopped) = tokio::sync::oneshot::channel();
    let client = client.clone();
    let watcher = tokio::spawn(async move {
        let mut readings = 0;
        loop {
            let Reply::Status(status) = client.call(&Request::Status).await.unwrap() else {
                panic!("no status");
            };
            for (sandbox, launches) in &sandboxes {
                let found = find(&status, *sandbox);
                assert_eq!(found.level, LevelName::Running, "{sandbox}: {found:?}");
                assert_eq!(found.paused_for_memory, None, "{sandbox}: {found:?}");
                assert_eq!(found.launches, *launches, "{sandbox} was launched again");
            }
            readings += 1;
            if stopped.try_recv().is_ok() {
                return readings;
            }
            sleep(Duration::from_millis(200)).await;
        }
    });
    (stop, watcher)
}

/// Starts and holds `heavy`, 2 GiB guaranteed 256 MiB, and `light`,
/// 1.5 GiB guaranteed all of it. Light then holds about 1.2 GiB; heavy,
/// which may keep about 1.3 GiB uncompressed (its request and what is
/// left), holds about 900 MiB and runs a program in the background.
async fn start_both(agent: &Agent) -> (Id, Id) {
    let (heavy, light) = (id(0), id(1));
    for (sandbox, memory_mib, memory_request_mib) in [(heavy, 2048, Some(256)), (light, 1536, None)]
    {
        let config = SandboxConfig {
            image: None,
            memory_request_mib,
            ..SandboxConfig::new(1, memory_mib, NEVER)
        };
        let reply = agent
            .client
            .call(&Request::Create {
                id: sandbox,
                config,
            })
            .await
            .unwrap();
        assert_eq!(reply, Reply::Done, "create {sandbox}");
        hold_running(agent, sandbox).await;
    }
    let (output, _) = exec(
        &agent.client,
        light,
        &format!(
            "mount -o remount,size=1300M /dev/shm && {} && echo filled",
            fill("/dev/shm/light", 1100)
        ),
    )
    .await;
    assert!(output.contains("filled"), "{output}");
    let (output, _) = exec(
        &agent.client,
        heavy,
        &format!(
            "mount -o remount,size=1700M /dev/shm && {} && echo filled; \
             nohup sleep 600 >/dev/null 2>&1 & echo $! > /tmp/sleep.pid",
            fill("/dev/shm/kept", 768)
        ),
    )
    .await;
    assert!(output.contains("filled"), "{output}");
    (heavy, light)
}

/// When sandboxes in use outgrow what the host has for them, the one above
/// its request is held to what is left: the kernel compresses its coldest
/// pages and it runs on, slower, with every program and file it had; it is
/// never paused or saved, however long the shortage lasts, and the sandbox
/// within its request is never compressed. The shortage is real: the host
/// declares a 4 GiB share of its memory for sandboxes, as a host shared
/// with other VMs does, so the kernel holds the VMs to that share whatever
/// else the lab machine has free. The guests run the lab's base image,
/// which cannot shrink, so the share is sized for compression alone to
/// make room: what the guest suite's sandboxes go through past that is
/// theirs. Bare metal only: on huge pages every request is the whole VM.
#[tokio::test(flavor = "multi_thread")]
async fn busy_sandboxes_above_their_request_are_compressed_never_paused() {
    let Some(lab) = lab() else {
        eprintln!("skipped: set COMPUTE_TEST_LAB to run against Firecracker");
        return;
    };
    if nested() {
        eprintln!("skipped: on huge pages a request is the whole VM");
        return;
    }
    // The VMs may hold 3 GiB together before the kernel slows them, and
    // the bounds keep 512 MiB of that free: 2.5 GiB for both.
    let host = Host::new(
        &lab,
        "giveway",
        &[
            "--memory-total-mib",
            "4096",
            "--memory-low-mib",
            "512",
            "--memory-high-mib",
            "1024",
            "--memory-buffer-mib",
            "0",
        ],
    );
    let agent = host.start().await;
    let (heavy, light) = start_both(&agent).await;
    let status = agent.status().await;
    let launches = |sandbox| find(&status, sandbox).launches;
    let (stop, watcher) = watch(
        &agent.client,
        vec![(heavy, launches(heavy)), (light, launches(light))],
    );
    // Past what is left for it: held back while it writes, it is
    // compressed, slowed but not stopped.
    let begin = Instant::now();
    let (output, _) = exec(&agent.client, heavy, &fill("/dev/shm/more", 768)).await;
    let wrote = begin.elapsed();
    assert!(!output.contains("No space"), "{output}");
    agent
        .wait_until("heavy to be compressed", |status| {
            compressed_pages(status, heavy) > 0
        })
        .await;
    let compressed = begin.elapsed();
    // Both files read back whole: what was compressed comes back as it is
    // touched, while other pages go in its place.
    let begin = Instant::now();
    let (output, _) = exec(
        &agent.client,
        heavy,
        &format!(
            "{}; {}",
            intact("/dev/shm/kept", 768),
            intact("/dev/shm/more", 768)
        ),
    )
    .await;
    let read = begin.elapsed();
    assert_eq!(
        output.matches("intact-768").count(),
        2,
        "heavy's files changed: {output}"
    );
    let (output, _) = exec(&agent.client, light, &intact("/dev/shm/light", 1100)).await;
    assert!(
        output.contains("intact-1100"),
        "light's file changed: {output}"
    );
    // Held there a while longer, it is still never paused.
    sleep(Duration::from_secs(20)).await;
    stop.send(()).unwrap();
    let readings = watcher.await.unwrap();
    let status = agent.status().await;
    assert_eq!(compressed_pages(&status, light), 0, "light was compressed");
    let found = find(&status, heavy);
    let swapped_in = found.memory.as_ref().map_or(0, |memory| memory.zswpin);
    assert!(swapped_in > 0, "nothing heavy compressed was read back");
    let (output, _) = exec(
        &agent.client,
        heavy,
        "kill -0 \"$(cat /tmp/sleep.pid)\" && echo alive",
    )
    .await;
    assert!(output.contains("alive"), "heavy's program ended: {output}");
    eprintln!(
        "heavy wrote past its share in {wrote:?}, was compressed {compressed:?} after it \
         began and read both files back in {read:?}; {} pages compressed and {swapped_in} \
         brought back, resident {} MiB; running at all {readings} readings",
        compressed_pages(&status, heavy),
        found.resident_bytes.unwrap_or_default() / MIB,
    );
    agent.remove_all().await;
    agent.kill();
    host.finish("giveway");
}
