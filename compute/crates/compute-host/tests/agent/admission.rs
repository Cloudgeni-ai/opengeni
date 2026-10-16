//! Admission: a host takes on only the memory it can hold, makes room by
//! pushing idle sandboxes deeper, answers host full otherwise, reports its
//! capacity, and rebuilds what it promised after a restart.

use std::time::Duration;

use compute_core::{Admission, HostPolicy};
use compute_host::protocol::{
    CapacityStatus, ErrorCode, LevelName, PriorityName, Reply, Request, SandboxConfig, SleepConfig,
};

use super::{Delays, Lab, NEVER, id};

const MIB: u64 = 1 << 20;

/// Room for two of the labs' 256 MiB sandboxes.
fn policy() -> HostPolicy {
    HostPolicy {
        admission: Some(Admission {
            budget: 512 * MIB,
            busy_grace: Duration::from_millis(100),
        }),
        ..HostPolicy::default()
    }
}

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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn idle_sandboxes_make_room_and_reservations_survive_a_restart() {
    let lab = Lab::new(Delays::default(), policy()).await;
    for n in 1..=3 {
        lab.create(id(n), SAVE_WHEN_NEEDED).await;
    }
    for n in 1..=2 {
        woke(&lab.wake(id(n)).await);
    }
    // Both idle past the grace: the oldest makes room.
    tokio::time::sleep(Duration::from_millis(300)).await;
    woke(&lab.wake(id(3)).await);
    let status = lab.status().await;
    assert_eq!(Lab::sandbox(&status, id(1)).level, LevelName::Saved);
    assert_eq!(Lab::sandbox(&status, id(2)).level, LevelName::Running);
    let before = capacity(&lab).await;
    assert_eq!((before.reserved, before.awake), (512 * MIB, 2));

    // A new agent rebuilds what it promised from its records and the VMs
    // it finds.
    let (root, world) = lab.stop().await;
    let lab = Lab::start(root, world, Delays::default(), policy()).await;
    let after = capacity(&lab).await;
    assert_eq!(
        (after.reserved, after.awake),
        (before.reserved, before.awake)
    );
    // And still makes room the same way. Both found running count as used
    // when found, so either may go.
    tokio::time::sleep(Duration::from_millis(300)).await;
    woke(&lab.wake(id(1)).await);
    let status = lab.status().await;
    let mut levels = [2, 3].map(|n| Lab::sandbox(&status, id(n)).level);
    levels.sort_by_key(|level| format!("{level:?}"));
    assert_eq!(levels, [LevelName::Running, LevelName::Saved]);
    lab.assert_clean();
}
