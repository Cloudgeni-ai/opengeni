//! The host's memory rule (ADR 24) as the agent carries it out: running
//! VMs bounded so that borrowers give back first, guests asked to shrink
//! from inside when the host is short, a VM ended only when its guest
//! cannot shrink, and the kernel's out-of-memory kills raised as alarms.
//! A sandbox in use is never paused for any of it.

use std::sync::Arc;
use std::time::Duration;

use compute_core::{HostPolicy, MemoryPolicy, Outgrowth};
use compute_engine::MemoryStats;
use compute_host::observe::{Alarm, ObserveConfig, Observer, ShrinkOutcome};
use compute_host::protocol::{Id, LevelName, PriorityName, Reply, Request, SandboxConfig};
use tokio::time::{Instant, sleep};

use super::{Delays, Lab, NEVER, id};

const MIB: u64 = 1 << 20;

/// What each fake VM holds: above its request, below its limit.
const RESIDENT: u64 = 200 * MIB;
/// Its request.
const REQUEST_MIB: u32 = 64;

/// A memory rule that acts within a test's time: a short host is acted on
/// a moment after it is found short.
fn policy() -> HostPolicy {
    HostPolicy {
        memory: Some(MemoryPolicy {
            low_watermark: 512 * MIB,
            high_watermark: 1024 * MIB,
            compressed_percent: 30,
            balloon_grace: Duration::from_millis(200),
            outgrowth: Some(Outgrowth {
                hold: Duration::from_millis(100),
                answer: Duration::from_secs(2),
                settle: Duration::from_millis(100),
                least: MIB,
                step: MIB,
            }),
        }),
        ..HostPolicy::default()
    }
}

/// A lab with the memory rule whose guests take host requests, and its
/// observer.
async fn lab() -> (Lab, Observer) {
    let mut kept = None;
    let lab = Lab::start_configured(
        Lab::root(),
        Arc::default(),
        Delays::default(),
        policy(),
        |config| {
            let observer = Observer::start(ObserveConfig {
                journal: false,
                ..ObserveConfig::default()
            });
            kept = Some(observer.clone());
            config.observer = observer;
            config.restore_notice_port = Some(53);
        },
    )
    .await;
    *lab.world.resident.lock().unwrap() = Some(RESIDENT);
    (lab, kept.unwrap())
}

/// Creates `sandbox` with a request below what its VM holds, wakes it and
/// holds it awake: a sandbox in use.
async fn in_use(lab: &Lab, sandbox: Id) {
    let config = SandboxConfig {
        memory_request_mib: Some(REQUEST_MIB),
        ..SandboxConfig::new(1, 256, NEVER)
    };
    let created = lab
        .client
        .call(&Request::Create {
            id: sandbox,
            config,
        })
        .await
        .unwrap();
    assert_eq!(created, Reply::Done);
    let hold = Request::Hold {
        id: sandbox,
        generation: None,
        hold: "work".into(),
        ttl_ms: None,
        priority: PriorityName::Interactive,
    };
    assert_eq!(lab.client.call(&hold).await.unwrap(), Reply::Done);
    lab.wait_level(sandbox, LevelName::Running).await;
}

/// Waits until `done` holds, checking that `sandbox` runs all along.
async fn running_until(lab: &Lab, sandbox: Id, what: &str, done: impl Fn() -> bool) {
    let until = Instant::now() + Duration::from_secs(20);
    while !done() {
        assert!(Instant::now() < until, "timed out waiting for {what}");
        let level = Lab::sandbox(&lab.status().await, sandbox).level;
        assert_eq!(level, LevelName::Running, "{sandbox} in use left running");
        sleep(Duration::from_millis(20)).await;
    }
}

/// With no room left even if every sandbox held only its request, the
/// guest of the one above its request is asked to free what the host is
/// short of, keeping its request: it ends programs inside, and its VM runs
/// on, never paused.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_short_host_shrinks_the_borrowing_guest_and_never_pauses_it() {
    let (lab, observer) = lab().await;
    let sandbox = id(81);
    in_use(&lab, sandbox).await;
    *lab.world.shrink_answer.lock().unwrap() =
        Some("shrunk freed=104857600 spent=0 ended=1 names=hog".into());

    *lab.world.memory_room.lock().unwrap() = Some(0);
    let metrics = observer.metrics();
    running_until(&lab, sandbox, "a shrink answered", || {
        metrics.shrinks(ShrinkOutcome::Freed) > 0
    })
    .await;
    let asked = lab.world.shrinks.lock().unwrap()[0].clone();
    assert!(
        asked.contains(&format!("keep={}", u64::from(REQUEST_MIB) * MIB)),
        "the guest keeps its request: {asked}"
    );
    // It frees at most what it holds above its request.
    let free: u64 = asked
        .split_whitespace()
        .find_map(|field| field.strip_prefix("free="))
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        (MIB..=RESIDENT - u64::from(REQUEST_MIB) * MIB).contains(&free),
        "{asked}"
    );
    // Its guest freeing more while the host is still short is asked again,
    // one at a time; its VM is never ended while it can.
    sleep(Duration::from_millis(500)).await;
    assert_eq!(metrics.alarms(Alarm::EndedForMemory), 0);
    assert_eq!(
        Lab::sandbox(&lab.status().await, sandbox).level,
        LevelName::Running
    );

    *lab.world.memory_room.lock().unwrap() = None;
    lab.assert_clean();
}

/// A guest that cannot shrink (one of a release before shrinking) has its
/// VM ended while the host stays short, loudly, and the sandbox comes back
/// from its files once there is room: the last resort, never a pause.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_guest_that_cannot_shrink_has_its_vm_ended_loudly() {
    let (lab, observer) = lab().await;
    let sandbox = id(82);
    in_use(&lab, sandbox).await;

    *lab.world.memory_room.lock().unwrap() = Some(0);
    let metrics = observer.metrics();
    let until = Instant::now() + Duration::from_secs(20);
    while metrics.alarms(Alarm::EndedForMemory) == 0 {
        assert!(
            Instant::now() < until,
            "timed out waiting for the VM to end"
        );
        assert_ne!(
            Lab::sandbox(&lab.status().await, sandbox).level,
            LevelName::Paused,
            "a sandbox in use is never paused for memory"
        );
        sleep(Duration::from_millis(20)).await;
    }
    assert!(metrics.shrinks(ShrinkOutcome::Failed) > 0, "asked first");
    assert!(metrics.alarms(Alarm::ProgramsLost) > 0);

    // Room again: held, it runs again.
    *lab.world.memory_room.lock().unwrap() = None;
    lab.wait_level(sandbox, LevelName::Running).await;
    lab.assert_clean();
}

/// On a host that compresses running VMs, a borrower is bounded to its
/// request and a level of borrowed memory as the host tightens, and the
/// bound is lifted once there is room again. Its request is always its
/// `memory.low`, with what it compressed on top.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn borrowers_are_bounded_as_the_host_tightens_and_freed_after() {
    let (lab, _observer) = lab().await;
    lab.world
        .compresses_running
        .store(true, std::sync::atomic::Ordering::SeqCst);
    *lab.world.paging.lock().unwrap() = Some(MemoryStats {
        compressed: Some(0),
        swapped: Some(0),
        pressure_full_avg10: Some(0.0),
        ..MemoryStats::default()
    });
    let sandbox = id(83);
    in_use(&lab, sandbox).await;
    let request = u64::from(REQUEST_MIB) * MIB;

    // 24 MiB left above every request and the low watermark: the one
    // borrower may keep that much of what it borrowed.
    *lab.world.memory_room.lock().unwrap() = Some(400 * MIB);
    let bounded = |high: Option<u64>| {
        lab.world
            .bounds
            .lock()
            .unwrap()
            .last()
            .is_some_and(|(_, low, set)| *low == request && *set == high)
    };
    running_until(&lab, sandbox, "the borrower bounded", || {
        bounded(Some(request + 24 * MIB))
    })
    .await;

    *lab.world.memory_room.lock().unwrap() = None;
    running_until(&lab, sandbox, "the bound lifted", || bounded(None)).await;
    lab.assert_clean();
}

/// VM processes the kernel's out-of-memory killer ends are counted from
/// the agent's start on, each an alarm.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_kernels_out_of_memory_kills_are_alarms() {
    let (lab, observer) = lab().await;
    *lab.world.oom_kills.lock().unwrap() = Some(3);
    sleep(Duration::from_millis(300)).await;
    let metrics = observer.metrics();
    assert_eq!(metrics.alarms(Alarm::OomKilled), 0, "before its time");
    *lab.world.oom_kills.lock().unwrap() = Some(5);
    let until = Instant::now() + Duration::from_secs(10);
    while metrics.alarms(Alarm::OomKilled) < 2 {
        assert!(Instant::now() < until, "timed out waiting for the alarms");
        sleep(Duration::from_millis(20)).await;
    }
    sleep(Duration::from_millis(200)).await;
    assert_eq!(metrics.alarms(Alarm::OomKilled), 2);
    lab.assert_clean();
}
