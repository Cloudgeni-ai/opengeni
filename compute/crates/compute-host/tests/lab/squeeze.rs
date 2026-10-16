//! A host short of memory with no idle sandbox left to push: sandboxes in
//! use above their request give way, first through their balloons, then
//! by being paused and saved until there is room again.

use super::memory::{hold_running, nested};
use super::*;

const MIB: u64 = 1 << 20;

/// Takes `mib` MiB of host memory outside any VM until killed.
fn hog(mib: u64) -> Child {
    Command::new("python3")
        .arg("-c")
        .arg(format!(
            "import time; b = bytearray(b'x') * ({mib} << 20); time.sleep(600)"
        ))
        .spawn()
        .unwrap()
}

/// MiB of memory available for new guests, read as the agent reads it.
fn available_mib() -> u64 {
    compute_host::host_memory::available(false).unwrap() >> 20
}

/// Waits, within two minutes, until available memory stops rising or
/// falling, such as while an earlier test's VMs are still being freed:
/// watermarks set from a reading taken before then mean nothing after.
async fn settle() {
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut last = available_mib();
    loop {
        sleep(Duration::from_secs(2)).await;
        let now = available_mib();
        if now.abs_diff(last) < 64 || Instant::now() >= deadline {
            return;
        }
        last = now;
    }
}

/// Takes host memory until available memory is `mib` MiB below `low`,
/// whatever else the host freed or took since the agent started.
fn short_by(low: u64, mib: u64) -> Child {
    hog(available_mib().saturating_sub(low) + mib)
}

fn find(status: &HostStatus, sandbox: Id) -> &SandboxStatus {
    status
        .sandboxes
        .iter()
        .find(|found| found.id == sandbox)
        .unwrap()
}

/// Seconds the guest of `sandbox` has been up, and the size of its
/// `/dev/shm/kept`.
async fn uptime_and_kept(agent: &Agent, sandbox: Id) -> (f64, String) {
    let (output, _) = exec(
        &agent.client,
        sandbox,
        "cut -d' ' -f1 /proc/uptime; stat -c %s /dev/shm/kept",
    )
    .await;
    let mut lines = output.lines();
    let uptime = lines.next().unwrap().trim().parse().unwrap();
    (uptime, lines.next().unwrap_or_default().trim().to_owned())
}

/// Checks that `light`, within its request, runs untouched.
fn untouched(status: &HostStatus, light: Id) {
    let found = find(status, light);
    assert_eq!(found.level, LevelName::Running);
    assert_eq!((found.paused_for_memory, found.balloon_bytes), (None, None));
}

/// With `heavy` filled, takes memory away until the host is short: its
/// guest gives its file cache back through its balloon, and it keeps
/// running. Returns how long that took.
async fn balloon_gives_way(agent: &Agent, low: u64, heavy: Id, light: Id) -> (Duration, Child) {
    agent
        .wait_until("the sampler to see the guest's memory", |status| {
            find(status, heavy)
                .resident_bytes
                .is_some_and(|bytes| bytes > 1400 * MIB)
        })
        .await;
    let before = find(&agent.status().await, heavy).resident_bytes.unwrap();
    // Short by less than the cache it can give back.
    let first = short_by(low, 128);
    let begin = Instant::now();
    agent
        .wait_until("the guest to give its cache back", |status| {
            let found = find(status, heavy);
            found.balloon_bytes == Some(1792 * MIB)
                && found
                    .resident_bytes
                    .is_some_and(|bytes| bytes + 512 * MIB < before)
        })
        .await;
    let gave = begin.elapsed();
    // Past the grace it still runs: the balloon was enough.
    sleep(Duration::from_secs(5)).await;
    let status = agent.status().await;
    let found = find(&status, heavy);
    assert_eq!(found.level, LevelName::Running);
    assert_eq!(found.paused_for_memory, None);
    untouched(&status, light);
    (gave, first)
}

/// When the host runs short with no idle sandbox to push, a sandbox in use
/// above its request first gives its file cache back through its balloon;
/// when that is not enough it is paused and saved, held or not, and once
/// there is room again it wakes by itself with its programs. A sandbox
/// within its request is never touched. The shortage is real host memory
/// taken by hogs sized from what is available at the time; the watermarks
/// sit below what was free at the start by more than the guests fill and
/// the test leaves behind, such as its saved image in the page cache, so
/// it wakes once the hogs are gone. Bare metal only: on huge pages every
/// request is the whole VM.
#[tokio::test(flavor = "multi_thread")]
async fn busy_sandboxes_above_their_request_give_way_when_the_host_runs_short() {
    let Some(lab) = lab() else {
        eprintln!("skipped: set COMPUTE_TEST_LAB to run against Firecracker");
        return;
    };
    if nested() {
        eprintln!("skipped: on huge pages a request is the whole VM");
        return;
    }
    settle().await;
    let free = available_mib();
    let low = free - 4096;
    let host = Host::new(
        &lab,
        "giveway",
        &[
            "--memory-low-mib",
            &low.to_string(),
            "--memory-high-mib",
            &(low + 512).to_string(),
            "--memory-buffer-mib",
            "0",
        ],
    );
    let agent = host.start().await;
    let (heavy, light) = (id(0), id(1));
    let config = SandboxConfig {
        memory_request_mib: Some(256),
        ..SandboxConfig::new(1, 2048, NEVER)
    };
    let reply = agent
        .client
        .call(&Request::Create { id: heavy, config })
        .await
        .unwrap();
    assert_eq!(reply, Reply::Done);
    agent.create(light, NEVER).await;
    hold_running(&agent, heavy).await;
    hold_running(&agent, light).await;
    // 512 MiB it cannot give back (tmpfs) and 1 GiB of file cache it can.
    exec(
        &agent.client,
        heavy,
        "dd if=/dev/zero of=/dev/shm/kept bs=1M count=512 2>/dev/null; \
         dd if=/dev/zero of=/cache bs=1M count=1024 2>/dev/null; sync",
    )
    .await;
    let (uptime, kept) = uptime_and_kept(&agent, heavy).await;
    assert_eq!(kept, (512 * MIB).to_string());
    let (gave, first) = balloon_gives_way(&agent, low, heavy, light).await;
    // Short by more than its balloon can give: it is paused and saved,
    // though held.
    let mut hogs = [first, short_by(low, 1024)];
    let begin = Instant::now();
    agent
        .wait_until("it to be saved for memory", |status| {
            let found = find(status, heavy);
            found.level == LevelName::Saved
                && found.paused_for_memory.is_some()
                && found.waiting_for_room.is_some()
        })
        .await;
    let saved = begin.elapsed();
    untouched(&agent.status().await, light);
    // Room comes back: it wakes by itself, its programs intact.
    for hog in &mut hogs {
        let _ = hog.kill();
        let _ = hog.wait();
    }
    let begin = Instant::now();
    agent
        .wait_until("it to wake by itself", |status| {
            find(status, heavy).level == LevelName::Running
        })
        .await;
    let woke = begin.elapsed();
    let status = agent.status().await;
    let found = find(&status, heavy);
    assert_eq!((found.paused_for_memory, found.balloon_bytes), (None, None));
    untouched(&status, light);
    let (after, kept) = uptime_and_kept(&agent, heavy).await;
    assert!(after > uptime, "the guest did not boot again");
    assert_eq!(kept, (512 * MIB).to_string());
    eprintln!(
        "balloon gave the cache back in {gave:?}; paused and saved in {saved:?}; \
         woke {woke:?} after room came back"
    );
    agent.remove_all().await;
    agent.kill();
    host.finish("giveway");
}
