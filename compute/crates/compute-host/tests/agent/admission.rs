//! Admission: a host takes on only the memory it can hold, ends idle saved
//! VMs at once for a wake, answers host full otherwise, keeps room ahead of
//! wakes in the background, reports its capacity, and rebuilds what it
//! promised after a restart.

use std::time::Duration;

use compute_core::{Admission, HostPolicy};
use compute_host::protocol::{
    CapacityStatus, DurabilityName, ErrorCode, LevelName, PriorityName, Reply, Request,
    SandboxConfig, SleepConfig,
};

use super::{Delays, Lab, NEVER, id};

const MIB: u64 = 1 << 20;

/// Room for two of the labs' 256 MiB sandboxes, and `buffer` MiB kept
/// free ahead of wakes.
fn policy_with(budget_mib: u64, buffer_mib: u64) -> HostPolicy {
    HostPolicy {
        admission: Some(Admission {
            budget: budget_mib * MIB,
            buffer: buffer_mib * MIB,
            busy_grace: Duration::from_millis(100),
        }),
        ..HostPolicy::default()
    }
}

fn policy() -> HostPolicy {
    policy_with(512, 0)
}

/// Pauses and saves soon, but keeps the VM process until something needs
/// its memory.
const SAVE_SOON: SleepConfig = SleepConfig {
    pause_after_ms: Some(200),
    save_after_ms: Some(200),
    ..NEVER
};

/// Sleeps only when the host needs the room: after an hour otherwise.
const SAVE_WHEN_NEEDED: SleepConfig = SleepConfig {
    pause_after_ms: Some(3_600_000),
    save_after_ms: Some(7_200_000),
    ..NEVER
};

fn host_full(reply: &Reply) -> Option<&str> {
    match reply {
        Reply::Error {
            code: ErrorCode::HostFull,
            message,
        } => Some(message),
        _ => None,
    }
}

fn woke(reply: &Reply) {
    assert!(matches!(reply, Reply::Woken { .. }), "{reply:?}");
}

async fn capacity(lab: &Lab) -> CapacityStatus {
    lab.status().await.capacity.expect("admission is on")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_full_host_refuses_wakes_and_creates_it_cannot_hold() {
    let lab = Lab::new(Delays::default(), policy()).await;
    for n in 1..=3 {
        lab.create(id(n), NEVER).await;
    }
    let empty = capacity(&lab).await;
    assert_eq!(
        (empty.total, empty.reserved, empty.free, empty.awake),
        (512 * MIB, 0, 512 * MIB, 0)
    );
    for n in 1..=2 {
        woke(&lab.wake(id(n)).await);
    }
    let full = capacity(&lab).await;
    assert_eq!((full.reserved, full.free, full.awake), (512 * MIB, 0, 2));
    // Neither may sleep, so nothing can make room.
    let reply = lab.wake(id(3)).await;
    let message = host_full(&reply).unwrap_or_else(|| panic!("{reply:?}"));
    assert!(
        message.contains(&(256 * MIB).to_string()),
        "says what it needs: {message}"
    );
    let status = lab.status().await;
    let third = Lab::sandbox(&status, id(3));
    assert_eq!(third.level, LevelName::Saved);
    assert_eq!(third.holds, 0, "a refused wake keeps nothing held");
    // Held, it waits for room, and wakes by itself once there is some.
    let hold = Request::Hold {
        id: id(3),
        generation: None,
        hold: "work".into(),
        ttl_ms: None,
        priority: PriorityName::Interactive,
    };
    assert_eq!(lab.client.call(&hold).await.unwrap(), Reply::Done);
    let status = lab
        .wait_until("the held sandbox to wait for room", |status| {
            Lab::sandbox(status, id(3)).waiting_for_room == Some(256 * MIB)
        })
        .await;
    assert_eq!(Lab::sandbox(&status, id(3)).level, LevelName::Saved);
    assert_eq!(
        lab.client
            .call(&Request::Remove {
                id: id(1),
                generation: None
            })
            .await
            .unwrap(),
        Reply::Done
    );
    lab.wait_level(id(3), LevelName::Running).await;
    assert_eq!(
        Lab::sandbox(&lab.status().await, id(3)).waiting_for_room,
        None
    );

    // A sandbox bigger than the whole host is refused at creation.
    let config = SandboxConfig {
        memory_request_mib: Some(256),
        ..SandboxConfig::new(1, 1024, NEVER)
    };
    let reply = lab
        .client
        .call(&Request::Create {
            id: id(4),
            config: config.clone(),
        })
        .await
        .unwrap();
    assert_eq!(reply, Reply::Done, "only its request is reserved");
    let reply = lab
        .client
        .call(&Request::Create {
            id: id(5),
            config: SandboxConfig::new(1, 1024, NEVER),
        })
        .await
        .unwrap();
    assert!(host_full(&reply).is_some(), "{reply:?}");
}

/// Waits until `n` is paused with its state saved: ending its VM process
/// loses nothing.
async fn wait_paused_and_saved(lab: &Lab, n: u128) {
    lab.wait_until(&format!("{} paused and saved", id(n)), |status| {
        let sandbox = Lab::sandbox(status, id(n));
        sandbox.level == LevelName::Paused && sandbox.durability != DurabilityName::Volatile
    })
    .await;
    // Its resident size is sampled every 50 ms.
    tokio::time::sleep(Duration::from_millis(150)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn idle_saved_vms_end_for_a_wake_and_reservations_survive_a_restart() {
    // The fake's paused VMs hold 100 MiB each.
    let lab = Lab::new(Delays::default(), policy_with(400, 0)).await;
    for n in 1..=3 {
        lab.create(id(n), SAVE_SOON).await;
    }
    for n in 1..=2 {
        woke(&lab.wake(id(n)).await);
        wait_paused_and_saved(&lab, n).await;
    }
    // 200 MiB free: the oldest paused VM ends at once for the third.
    let hold = |n| Request::Hold {
        id: id(n),
        generation: None,
        hold: "work".into(),
        ttl_ms: None,
        priority: PriorityName::Interactive,
    };
    assert_eq!(lab.client.call(&hold(3)).await.unwrap(), Reply::Done);
    lab.wait_level(id(3), LevelName::Running).await;
    let status = lab.status().await;
    assert_eq!(Lab::sandbox(&status, id(1)).level, LevelName::Saved);
    assert_eq!(Lab::sandbox(&status, id(2)).level, LevelName::Paused);
    let before = capacity(&lab).await;
    assert_eq!((before.reserved, before.awake), (256 * MIB, 1));

    // A new agent rebuilds what it promised from its records and the VMs
    // it finds.
    let (root, world) = lab.stop().await;
    let lab = Lab::start(root, world, Delays::default(), policy_with(400, 0)).await;
    let after = capacity(&lab).await;
    assert_eq!(
        (after.reserved, after.awake),
        (before.reserved, before.awake)
    );
    // And still ends the oldest paused one for a wake.
    let release = Request::Release {
        id: id(3),
        generation: None,
        hold: "work".into(),
    };
    assert_eq!(lab.client.call(&release).await.unwrap(), Reply::Done);
    wait_paused_and_saved(&lab, 3).await;
    woke(&lab.wake(id(1)).await);
    let status = lab.status().await;
    assert_eq!(Lab::sandbox(&status, id(2)).level, LevelName::Saved);
    assert_eq!(Lab::sandbox(&status, id(3)).level, LevelName::Paused);
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_buffer_is_kept_ahead_of_wakes_in_the_background() {
    let lab = Lab::new(Delays::default(), policy_with(512, 256)).await;
    for n in 1..=3 {
        lab.create(id(n), SAVE_WHEN_NEEDED).await;
    }
    for n in 1..=2 {
        woke(&lab.wake(id(n)).await);
    }
    // Idle past the grace, the oldest is pushed out to keep the buffer,
    // and only that one.
    lab.wait_level(id(1), LevelName::Saved).await;
    let status = lab
        .wait_until("the buffer to be free", |status| {
            status
                .capacity
                .is_some_and(|capacity| capacity.free == 256 * MIB)
        })
        .await;
    assert_eq!(Lab::sandbox(&status, id(2)).level, LevelName::Running);
    // A wake takes the buffer at once, and the buffer is made again.
    woke(&lab.wake(id(3)).await);
    lab.wait_level(id(2), LevelName::Saved).await;
    assert_eq!(
        Lab::sandbox(&lab.status().await, id(3)).level,
        LevelName::Running
    );
    lab.assert_clean();
}

/// Watermarks that `available` bytes of host memory are far above
/// (`room`) or far below (no room).
fn memory_policy(room: bool) -> HostPolicy {
    let available = compute_host::host_memory::available(false).unwrap_or(1 << 40);
    let (low, high) = if room {
        (MIB, 2 * MIB)
    } else {
        (available * 4, available * 8)
    };
    HostPolicy {
        memory: Some(compute_core::MemoryPolicy {
            low_watermark: low,
            high_watermark: high,
            compressed_percent: 30,
            balloon_grace: Duration::from_millis(200),
        }),
        ..HostPolicy::default()
    }
}

/// A sandbox in use that was paused and saved for host memory wakes by
/// itself once there is room, even after the agent that paused it was
/// restarted: whether it waits for memory is kept across restarts.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sandbox_paused_for_memory_wakes_by_itself_after_a_restart() {
    let sandbox = id(31);
    let lab = Lab::new(Delays::default(), memory_policy(true)).await;
    // The fake's VMs hold 100 MiB: above this request.
    let config = SandboxConfig {
        memory_request_mib: Some(64),
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
    woke(&lab.wake(sandbox).await);

    // No room: its balloon gives nothing back, so it is paused and saved.
    let (root, world) = lab.stop().await;
    let lab = Lab::start(root, world, Delays::default(), memory_policy(false)).await;
    lab.wait_until("the sandbox saved for memory", |status| {
        Lab::sandbox(status, sandbox).level == LevelName::Saved
    })
    .await;
    sleep_a_little().await;

    // A new agent finds room and wakes it, with nothing asking.
    let (root, world) = lab.stop().await;
    let lab = Lab::start(root, world, Delays::default(), memory_policy(true)).await;
    lab.wait_level(sandbox, LevelName::Running).await;
    lab.assert_clean();
}

/// Long enough for a background write of the holds file to land.
async fn sleep_a_little() {
    tokio::time::sleep(Duration::from_millis(300)).await;
}
