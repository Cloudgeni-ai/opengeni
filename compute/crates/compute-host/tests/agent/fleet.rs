//! Sandboxes changing hands between hosts: hand-offs, adopts, requests
//! fenced by owner epoch, and the rulings a registering host takes in. Two
//! labs sharing one directory store stand for two hosts of a fleet.

use std::path::PathBuf;
use std::sync::Arc;

use compute_core::Priority;
use compute_host::protocol::{
    ErrorCode, Id, LevelName, Reply, Request, SandboxConfig, SleepConfig,
};
use compute_host::{Directory, HostError, OwnerEpoch};
use compute_protocol::fleet::Verdict;

use super::{Lab, NEVER, id};

fn config(sleep: SleepConfig) -> SandboxConfig {
    SandboxConfig {
        vcpus: 1,
        memory_mib: 256,
        memory_request_mib: None,
        cpu_request_millis: None,
        sleep,
    }
}

/// Two hosts keeping sandboxes in one store.
async fn hosts() -> (Lab, Lab, PathBuf) {
    let a = Lab::root();
    let shelf = a.join("shelf");
    let one = Lab::start_stored(a, Arc::default(), Directory::new(&shelf)).await;
    let two = Lab::start_stored(Lab::root(), Arc::default(), Directory::new(&shelf)).await;
    (one, two, shelf)
}

fn code(reply: &Reply) -> Option<ErrorCode> {
    match reply {
        Reply::Error { code, .. } => Some(*code),
        _ => None,
    }
}

async fn hand_off(lab: &Lab, id: Id, owner_epoch: u64) -> Reply {
    lab.client
        .call(&Request::HandOff { id, owner_epoch })
        .await
        .unwrap()
}

async fn adopt(lab: &Lab, id: Id, owner_epoch: u64) -> Reply {
    lab.client
        .call(&Request::Adopt {
            id,
            config: config(NEVER),
            owner_epoch,
        })
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sandbox_handed_off_by_one_host_wakes_on_another_with_its_files_and_programs() {
    let (one, two, shelf) = hosts().await;
    let sandbox = id(1);
    one.create(sandbox, NEVER).await;
    one.run(sandbox, &["set kept", "write on-disk"]).await;

    // Awake, it is not handed off: the service sleeps it first.
    assert_eq!(
        code(&hand_off(&one, sandbox, 1).await),
        Some(ErrorCode::Busy)
    );
    assert_eq!(one.sleep_to(sandbox, LevelName::Paused).await, Reply::Done);
    one.wait_level(sandbox, LevelName::Paused).await;
    assert_eq!(
        code(&hand_off(&one, sandbox, 2).await),
        Some(ErrorCode::NotFound),
        "this host never held a later ownership"
    );
    assert_eq!(hand_off(&one, sandbox, 1).await, Reply::Done);
    assert_eq!(one.status().await.sandboxes, Vec::new());
    assert!(!one.sandbox_dir(sandbox).exists());
    assert!(
        shelf.join(sandbox.to_string()).exists(),
        "a hand-off keeps the store's copy"
    );
    assert_eq!(code(&one.wake(sandbox).await), Some(ErrorCode::NotFound));
    assert_eq!(
        code(&hand_off(&one, sandbox, 1).await),
        Some(ErrorCode::NotFound),
        "done once it is gone"
    );

    assert_eq!(adopt(&two, sandbox, 2).await, Reply::Done);
    let adopted = two.current(sandbox).await;
    assert_eq!((adopted.level, adopted.owner_epoch), (LevelName::Remote, 2));
    assert!(adopted.memory_saved, "the archive holds its memory");
    assert_eq!(adopt(&two, sandbox, 2).await, Reply::Done, "adopting again");
    assert_eq!(
        code(&adopt(&two, sandbox, 1).await),
        Some(ErrorCode::Stale),
        "an earlier ownership"
    );
    assert_eq!(
        two.run(sandbox, &["get", "disk"]).await,
        ["kept", "on-disk"],
        "programs and files moved with it"
    );
    one.assert_clean();
    two.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sandbox_being_handed_off_takes_no_wake() {
    let (one, _two, _shelf) = hosts().await;
    let sandbox = id(2);
    one.create(sandbox, NEVER).await;
    one.run(sandbox, &["set first"]).await;
    one.sleep_to(sandbox, LevelName::Paused).await;
    one.wait_level(sandbox, LevelName::Paused).await;
    let handle = one.handle.clone();
    let handing = tokio::spawn(async move { handle.hand_off(sandbox, OwnerEpoch::FIRST).await });
    // Until it is gone, every wake is refused; once gone, none finds it.
    loop {
        match one.wake(sandbox).await {
            Reply::Error {
                code: ErrorCode::Busy,
                ..
            } => {}
            Reply::Error {
                code: ErrorCode::NotFound,
                ..
            } => break,
            other => panic!("a wake reached a sandbox being handed off: {other:?}"),
        }
        if handing.is_finished() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    handing.await.unwrap().unwrap();
    one.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn requests_reach_only_the_ownership_the_host_holds() {
    let (one, _two, _shelf) = hosts().await;
    let sandbox = id(3);
    one.create(sandbox, NEVER).await;
    let first = one.handle.owned(OwnerEpoch::FIRST);
    let later = one.handle.owned(OwnerEpoch(2));
    assert!(
        first
            .touch(sandbox, None, Priority::Interactive)
            .await
            .is_ok()
    );
    assert!(
        matches!(
            later.touch(sandbox, None, Priority::Interactive).await,
            Err(HostError::NotFound(_))
        ),
        "a later ownership than the host holds finds nothing"
    );
    // A create sent again under a later epoch takes the copy over.
    later.create(sandbox, config(NEVER)).await.unwrap();
    assert_eq!(one.current(sandbox).await.owner_epoch, 2);
    assert!(matches!(
        first.touch(sandbox, None, Priority::Interactive).await,
        Err(HostError::Superseded {
            held: 2,
            asked: 1,
            ..
        })
    ));
    assert!(
        matches!(
            first.remove(sandbox, None).await,
            Err(HostError::Superseded { .. })
        ),
        "an earlier ownership removes nothing"
    );
    assert!(
        later
            .touch(sandbox, None, Priority::Interactive)
            .await
            .is_ok()
    );
    // The record keeps it across a restart, once no handle keeps the
    // agent running.
    drop((first, later));
    let (root, world) = one.stop().await;
    let one = Lab::start_stored(root.clone(), world, Directory::new(root.join("shelf"))).await;
    assert_eq!(one.current(sandbox).await.owner_epoch, 2);
    let local = one.handle.local_to_fleet();
    assert!(
        matches!(
            local.create(id(4), config(NEVER)).await,
            Err(HostError::Invalid(_))
        ),
        "only the fleet service creates sandboxes on a host in a fleet"
    );
    one.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_adopt_replaces_an_earlier_ownerships_copy_with_the_stores() {
    let (one, _two, _shelf) = hosts().await;
    let sandbox = id(5);
    one.create(sandbox, NEVER).await;
    one.run(sandbox, &["set archived", "write archived"]).await;
    one.sleep_to(sandbox, LevelName::Archived).await;
    one.wait_level(sandbox, LevelName::Archived).await;
    // It changes here after its last archive, as on a host given up on.
    one.run(sandbox, &["set newer", "write newer"]).await;
    assert_eq!(adopt(&one, sandbox, 2).await, Reply::Done);
    let status = one.current(sandbox).await;
    assert_eq!((status.level, status.owner_epoch), (LevelName::Remote, 2));
    assert_eq!(
        one.run(sandbox, &["get", "disk"]).await,
        ["archived", "archived"],
        "the store's copy, which the service gave out, wins"
    );
    one.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_registering_host_keeps_what_the_service_rules_and_drops_the_rest() {
    let (one, two, _shelf) = hosts().await;
    let (kept, dropped, unlisted, refetched) = (id(6), id(7), id(8), id(9));
    for sandbox in [kept, dropped, unlisted, refetched] {
        one.create(sandbox, NEVER).await;
        one.run(sandbox, &[&format!("set {sandbox}")]).await;
        one.sleep_to(sandbox, LevelName::Archived).await;
    }
    for sandbox in [kept, dropped, unlisted, refetched] {
        one.wait_level(sandbox, LevelName::Archived).await;
    }
    one.handle
        .reconcile(vec![
            (kept, Verdict::Keep { owner_epoch: 3 }),
            (dropped, Verdict::Drop),
            (refetched, Verdict::Refetch { owner_epoch: 4 }),
        ])
        .await
        .unwrap();
    let status = one.status().await;
    let held: Vec<(Id, u64, LevelName)> = status
        .sandboxes
        .iter()
        .map(|sandbox| (sandbox.id, sandbox.owner_epoch, sandbox.level))
        .collect();
    assert_eq!(
        held,
        [
            (kept, 3, LevelName::Archived),
            (refetched, 4, LevelName::Remote)
        ]
    );
    // What was dropped is still in the store for whoever gets it next.
    for sandbox in [dropped, unlisted] {
        assert_eq!(adopt(&two, sandbox, 5).await, Reply::Done);
        assert_eq!(
            two.run(sandbox, &["get"]).await,
            [sandbox.to_string()],
            "dropped with its copy kept"
        );
    }
    assert_eq!(one.run(kept, &["get"]).await, [kept.to_string()]);
    one.assert_clean();
    two.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_adopt_without_a_stored_copy_leaves_nothing() {
    let (one, _two, _shelf) = hosts().await;
    let sandbox = id(10);
    assert_eq!(
        code(&adopt(&one, sandbox, 2).await),
        Some(ErrorCode::NotFound)
    );
    assert_eq!(one.status().await.sandboxes, Vec::new());
    assert!(!one.sandbox_dir(sandbox).exists());
}
