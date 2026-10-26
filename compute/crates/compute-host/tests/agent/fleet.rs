//! Sandboxes changing hands between hosts: hand-offs, adopts, requests
//! fenced by owner epoch, and the rulings a registering host takes in. Two
//! labs sharing one directory store stand for two hosts of a fleet.

use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use std::time::Duration;

use compute_core::{DiskPolicy, DiskSpace, HostPolicy, Level, Priority};
use compute_engine::{CancellationToken, EngineError};
use compute_host::fleet::{Admission, LeaseGate, boot_now};
use compute_host::protocol::{
    DiskStatus, ErrorCode, Id, LevelName, PriorityName, Reply, Request, SandboxConfig, SleepConfig,
};
use compute_host::{
    Archive, Claimed, Directory, DiskGauge, FetchInto, FetchedMemory, HostError, Owned, OwnerEpoch,
    Receipt, SavedFiles, Stamp, Store,
};
use compute_protocol::fleet::{Answered, Ruling, Verdict};
use tokio::sync::Semaphore;
use tokio::time::{Instant, sleep};

use super::{Delays, Lab, NEVER, PAUSE_SOON, id};

fn config(sleep: SleepConfig) -> SandboxConfig {
    SandboxConfig {
        vcpus: 1,
        memory_mib: 256,
        memory_request_mib: None,
        cpu_request_millis: None,
        sleep,
        image: None,
        link: None,
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

fn ruling(id: Id, verdict: Verdict) -> Ruling {
    Ruling {
        id,
        verdict,
        link: None,
    }
}

async fn hand_off(lab: &Lab, id: Id, owner_epoch: u64) -> Reply {
    lab.client
        .call(&Request::HandOff {
            id,
            owner_epoch,
            awake: false,
        })
        .await
        .unwrap()
}

async fn hand_off_awake(lab: &Lab, id: Id, owner_epoch: u64) -> Reply {
    lab.client
        .call(&Request::HandOff {
            id,
            owner_epoch,
            awake: true,
        })
        .await
        .unwrap()
}

async fn adopt(lab: &Lab, id: Id, owner_epoch: u64) -> Reply {
    lab.client
        .call(&Request::Adopt {
            id,
            config: config(NEVER),
            owner_epoch,
            whole: true,
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

/// A sandbox something keeps awake for good, as a desktop someone watches
/// or a program that never stops working, still leaves a host being
/// drained when asked to go awake: its holds end, it is saved where it
/// stands, and it carries on, programs and all, on the host that adopts
/// it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sandbox_held_awake_is_handed_off_with_its_programs_when_asked_to_go_awake() {
    let (one, two, shelf) = hosts().await;
    let sandbox = id(3);
    one.create(sandbox, NEVER).await;
    one.run(sandbox, &["set kept", "write on-disk"]).await;
    let hold = Request::Hold {
        id: sandbox,
        generation: None,
        hold: "watched".into(),
        ttl_ms: None,
        priority: PriorityName::default(),
    };
    assert_eq!(one.client.call(&hold).await.unwrap(), Reply::Done);
    // A stream carrying traffic holds it too, under a lease of its own.
    let lease = one
        .handle
        .acquire(sandbox, None, compute_core::Priority::Interactive)
        .await
        .unwrap();

    assert_eq!(
        code(&hand_off(&one, sandbox, 1).await),
        Some(ErrorCode::Busy),
        "held awake, it stays unless asked to go awake"
    );
    assert_eq!(hand_off_awake(&one, sandbox, 1).await, Reply::Done);
    assert_eq!(one.status().await.sandboxes, Vec::new());
    assert!(shelf.join(sandbox.to_string()).exists());
    // The stream's lease ends after the sandbox has gone, as a stream's
    // does at its next write.
    drop(lease);
    assert_eq!(code(&one.wake(sandbox).await), Some(ErrorCode::NotFound));

    assert_eq!(adopt(&two, sandbox, 2).await, Reply::Done);
    assert!(
        two.current(sandbox).await.memory_saved,
        "it was saved with its memory"
    );
    assert_eq!(
        two.run(sandbox, &["get", "disk"]).await,
        ["kept", "on-disk"],
        "programs and files moved with it"
    );
    one.assert_clean();
    two.assert_clean();
}

/// Asked to go awake, a sandbox kept running by its own work and held by
/// nothing is handed off too.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_running_sandbox_is_handed_off_when_asked_to_go_awake() {
    let (one, two, _shelf) = hosts().await;
    let sandbox = id(4);
    one.create(sandbox, NEVER).await;
    one.run(sandbox, &["set kept"]).await;
    assert_eq!(
        code(&hand_off(&one, sandbox, 1).await),
        Some(ErrorCode::Busy)
    );
    assert_eq!(hand_off_awake(&one, sandbox, 1).await, Reply::Done);
    assert_eq!(adopt(&two, sandbox, 2).await, Reply::Done);
    assert_eq!(two.run(sandbox, &["get"]).await, ["kept"]);
    one.assert_clean();
    two.assert_clean();
}

/// A sandbox asked to wake, whose wake keeps failing for now, is wanted
/// awake though nothing holds it: a drain of what sleeps leaves it, and
/// one asked to go awake ends the wake, tells whoever waits for it here
/// that it is going, and saves it where it stands instead of waiting for
/// a wake to get through.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_hand_off_asked_to_go_awake_ends_a_wake_still_retrying() {
    let (one, two, _shelf) = hosts().await;
    let sandbox = id(5);
    one.create(sandbox, NEVER).await;
    one.run(sandbox, &["set kept"]).await;
    assert_eq!(one.sleep_to(sandbox, LevelName::Paused).await, Reply::Done);
    one.wait_level(sandbox, LevelName::Paused).await;
    one.world.refuse_resumes.store(true, Ordering::SeqCst);
    let touch = Request::Touch {
        id: sandbox,
        generation: None,
        priority: PriorityName::Interactive,
    };
    assert_eq!(one.client.call(&touch).await.unwrap(), Reply::Done);
    one.wait_until("a refused resume", |status| {
        status
            .steps
            .iter()
            .any(|(name, stats)| name == "resume" && stats.failed > 0)
    })
    .await;
    assert_eq!(
        code(&hand_off(&one, sandbox, 1).await),
        Some(ErrorCode::Busy),
        "wanted awake, it stays unless asked to go awake"
    );

    let (woken, handed) = tokio::join!(
        one.handle.acquire(sandbox, None, Priority::Interactive),
        async {
            sleep(Duration::from_millis(50)).await;
            hand_off_awake(&one, sandbox, 1).await
        },
    );
    let Err(error) = woken else {
        panic!("a wait for it to wake here got through");
    };
    assert!(matches!(error, HostError::HandingOff(_)), "{error:?}");
    assert_eq!(handed, Reply::Done);
    assert_eq!(one.status().await.sandboxes, Vec::new());
    assert_eq!(adopt(&two, sandbox, 2).await, Reply::Done);
    assert_eq!(
        two.run(sandbox, &["get"]).await,
        ["kept"],
        "its programs moved with it"
    );
    one.assert_clean();
    two.assert_clean();
}

/// An adopted sandbox's record keeps the length of the disk it was handed
/// off with, so what its wake books is its own disk's, never the adopting
/// host's base image, however much shorter that is.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_adopted_sandbox_keeps_the_length_of_the_disk_it_was_handed_off_with() {
    const GROWN: u64 = 1 << 20;
    let (one, two, _shelf) = hosts().await;
    let sandbox = id(4);
    one.create(sandbox, NEVER).await;
    one.run(sandbox, &["write on-disk"]).await;
    assert_eq!(one.sleep_to(sandbox, LevelName::Paused).await, Reply::Done);
    one.wait_level(sandbox, LevelName::Paused).await;
    std::fs::OpenOptions::new()
        .write(true)
        .open(one.sandbox_dir(sandbox).join("root/disk.ext4"))
        .unwrap()
        .set_len(GROWN)
        .unwrap();
    assert_eq!(hand_off(&one, sandbox, 1).await, Reply::Done);

    assert_eq!(adopt(&two, sandbox, 2).await, Reply::Done);
    let base = std::fs::metadata(two.root.join("base.img")).unwrap().len();
    assert!(base < GROWN, "the adopting host's base image is shorter");
    assert_eq!(two.record(sandbox)["allocation"]["disk_bytes"], GROWN);
    let woken = two.wake(sandbox).await;
    assert!(matches!(woken, Reply::Woken { .. }), "{woken:?}");
    assert_eq!(two.record(sandbox)["allocation"]["disk_bytes"], GROWN);
    one.assert_clean();
    two.assert_clean();
}

/// A guest's memory keeps the latest restore notice it applied, and moves
/// with the sandbox; the new host's record of it starts afresh, with a
/// fence lower than the old host's. Its notices still come after the old
/// host's, by the new owner's higher epoch, so the guest takes them: it
/// sets its clock, keeps its identity and has its agent reconnect.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_moved_sandbox_takes_its_new_hosts_restore_notices() {
    let a = Lab::root();
    let shelf = a.join("shelf");
    let one = Lab::start_stored_configured(a, Arc::default(), Directory::new(&shelf), |config| {
        config.restore_notice_port = Some(53);
    })
    .await;
    let two = Lab::start_stored_configured(
        Lab::root(),
        Arc::default(),
        Directory::new(&shelf),
        |config| config.restore_notice_port = Some(53),
    )
    .await;
    let sandbox = id(3);
    one.create(sandbox, NEVER).await;
    one.run(sandbox, &["set kept"]).await;
    // Restores on the first host raise its record's fence above where the
    // second host's starts, and each tells the guest.
    for _ in 0..3 {
        assert_eq!(one.sleep_to(sandbox, LevelName::Saved).await, Reply::Done);
        one.wait_level(sandbox, LevelName::Saved).await;
        assert_eq!(
            one.run(sandbox, &["told-restored?", "get"]).await,
            ["true", "kept"]
        );
    }
    assert_eq!(one.sleep_to(sandbox, LevelName::Paused).await, Reply::Done);
    one.wait_level(sandbox, LevelName::Paused).await;
    assert_eq!(hand_off(&one, sandbox, 1).await, Reply::Done);
    assert_eq!(adopt(&two, sandbox, 2).await, Reply::Done);
    assert_eq!(
        two.run(sandbox, &["told-restored?", "get", "sandbox?"])
            .await,
        ["true".to_owned(), "kept".to_owned(), sandbox.to_string()],
        "the new host's notice was taken"
    );
    for lab in [&one, &two] {
        assert_eq!(lab.world.notices_turned_down.load(Ordering::Relaxed), 0);
        assert_eq!(lab.world.notices_out_of_order.load(Ordering::Relaxed), 0);
    }
    one.assert_clean();
    two.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sandbox_being_handed_off_takes_no_wake() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let root = Lab::root();
        // The store holds the hand-off's archive until a wake has been
        // refused, so the two always overlap.
        let archives = Arc::new(Semaphore::new(0));
        let gated = Gated {
            inner: Directory::new(root.join("shelf")),
            claims: Arc::new(Semaphore::new(OPEN)),
            archives: Arc::clone(&archives),
        };
        let one = Lab::start_stored(root, Arc::default(), gated).await;
        let sandbox = id(2);
        one.create(sandbox, NEVER).await;
        one.run(sandbox, &["set first"]).await;
        one.sleep_to(sandbox, LevelName::Paused).await;
        one.wait_level(sandbox, LevelName::Paused).await;
        let handle = one.handle.clone();
        let handing =
            tokio::spawn(async move { handle.hand_off(sandbox, OwnerEpoch::FIRST, false).await });
        // A wake the agent takes before the hand-off wakes the sandbox and
        // turns the hand-off down, so probe only once the hand-off has
        // begun its sleep: nothing else would, with sleep left to requests.
        one.wait_until("the hand-off to begin", |status| {
            status
                .sandboxes
                .iter()
                .any(|held| held.id == sandbox && held.step.is_some())
        })
        .await;
        assert_eq!(
            code(&one.wake(sandbox).await),
            Some(ErrorCode::Busy),
            "a wake during the hand-off is refused"
        );
        assert!(!handing.is_finished(), "the archive is still held");
        archives.add_permits(OPEN);
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
            sleep(Duration::from_millis(1)).await;
        }
        handing.await.unwrap().unwrap();
        one.assert_clean();
    })
    .await
    .expect("the hand-off and the wakes end");
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
        "only the control service creates sandboxes on a host in a fleet"
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
            ruling(kept, Verdict::Keep { owner_epoch: 3 }),
            ruling(dropped, Verdict::Drop),
            ruling(
                refetched,
                Verdict::Refetch {
                    owner_epoch: 4,
                    whole: true,
                },
            ),
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

/// Has the agent of `lab` read `bytes` free on its disk, and inodes to
/// spare, then tells what its disk book holds.
async fn read_disk(lab: &Lab, gauge: &DiskGauge, bytes: u64) -> DiskStatus {
    gauge.give(DiskSpace {
        bytes,
        inodes: 1 << 40,
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while !gauge.taken() {
        assert!(Instant::now() < deadline, "no sample took the reading");
        sleep(Duration::from_millis(5)).await;
    }
    lab.status().await.disk.expect("a disk policy")
}

/// Two hosts sharing a store, the second of which reads its free disk
/// from the gauge returned, and a sandbox of the first's per id, written
/// to, paused and handed off through the store.
async fn handed_to_a_gauged_host(sandboxes: &[Id]) -> (Lab, Lab, DiskGauge, PathBuf) {
    let a = Lab::root();
    let shelf = a.join("shelf");
    let one = Lab::start_stored(a, Arc::default(), Directory::new(&shelf)).await;
    let gauge = DiskGauge::default();
    let reading = gauge.clone();
    let two = Lab::start_stored_configured(
        Lab::root(),
        Arc::default(),
        Directory::new(&shelf),
        move |config| {
            config.policy.disk = Some(DiskPolicy {
                reserve: 0,
                reserve_inodes: 0,
            });
            config.disk_reading = Some(reading);
        },
    )
    .await;
    for &sandbox in sandboxes {
        one.create(sandbox, NEVER).await;
        one.run(sandbox, &["write on-disk"]).await;
        assert_eq!(one.sleep_to(sandbox, LevelName::Paused).await, Reply::Done);
        one.wait_level(sandbox, LevelName::Paused).await;
    }
    (one, two, gauge, shelf)
}

/// An adopt books the first wake without the copy's disk before it claims
/// the store's copy, then books it again with the copy's own disk: a copy
/// this host has no disk for is refused there, before anything of it is
/// made here, leaving the store's copy whole for another host.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_adopt_whose_copy_needs_more_disk_than_is_free_is_refused_and_leaves_the_copy() {
    const GROWN: u64 = 64 << 20;
    const PLENTY: u64 = 1 << 50;
    let (small, grown) = (id(1), id(2));
    let (one, two, gauge, shelf) = handed_to_a_gauged_host(&[small, grown]).await;
    std::fs::OpenOptions::new()
        .write(true)
        .open(one.sandbox_dir(grown).join("root/disk.ext4"))
        .unwrap()
        .set_len(GROWN)
        .unwrap();
    for sandbox in [small, grown] {
        assert_eq!(hand_off(&one, sandbox, 1).await, Reply::Done);
    }

    // What the first wake of the small copy books.
    let empty = read_disk(&two, &gauge, PLENTY).await.free;
    assert_eq!(adopt(&two, small, 2).await, Reply::Done);
    let first = empty - two.status().await.disk.unwrap().free;
    assert!(first > 0);
    // Room for one more such wake, but not for the grown disk's.
    let booked = PLENTY - empty + first;
    let disk = read_disk(&two, &gauge, booked + first + (16 << 20)).await;
    assert_eq!(disk.free, first + (16 << 20));

    let reply = adopt(&two, grown, 2).await;
    assert_eq!(code(&reply), Some(ErrorCode::HostFull), "{reply:?}");
    assert!(
        !two.sandbox_dir(grown).exists(),
        "the refused adopt made files"
    );
    let status = two.status().await;
    assert!(status.sandboxes.iter().all(|sandbox| sandbox.id != grown));
    assert!(status.blocked.is_empty(), "{:?}", status.blocked);
    assert_eq!(
        status.disk.unwrap().free,
        first + (16 << 20),
        "its booking ended"
    );
    assert!(shelf.join(grown.to_string()).exists(), "the store keeps it");

    // With room, a later ownership adopts the very copy.
    read_disk(&two, &gauge, PLENTY).await;
    assert_eq!(adopt(&two, grown, 3).await, Reply::Done);
    assert_eq!(two.record(grown)["allocation"]["disk_bytes"], GROWN);
    let files = two.run(grown, &["disk"]).await;
    assert_eq!(
        files[0].trim_end_matches('\0'),
        "on-disk",
        "its files moved"
    );
    assert_eq!(two.run(small, &["disk"]).await, ["on-disk"]);
    one.assert_clean();
    two.assert_clean();
}

/// An adopt never takes over or deletes a directory already there for its
/// sandbox, which belongs to a sandbox this agent does not know: it is
/// refused as existing and leaves the directory as it was, and the same
/// adopt goes through once the directory is gone.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_adopt_leaves_an_unknown_directory_of_its_sandbox_alone() {
    let sandbox = id(4);
    let (one, two, gauge, _shelf) = handed_to_a_gauged_host(&[sandbox]).await;
    assert_eq!(hand_off(&one, sandbox, 1).await, Reply::Done);
    read_disk(&two, &gauge, 1 << 40).await;
    let unknown = two.sandbox_dir(sandbox);
    std::fs::create_dir_all(&unknown).unwrap();
    std::fs::write(unknown.join("theirs"), b"kept").unwrap();

    let reply = adopt(&two, sandbox, 2).await;
    assert_eq!(code(&reply), Some(ErrorCode::Exists), "{reply:?}");
    assert_eq!(std::fs::read(unknown.join("theirs")).unwrap(), b"kept");
    let status = two.status().await;
    assert!(status.sandboxes.is_empty() && status.blocked.is_empty());

    std::fs::remove_dir_all(&unknown).unwrap();
    assert_eq!(adopt(&two, sandbox, 2).await, Reply::Done);
    assert_eq!(two.run(sandbox, &["disk"]).await, ["on-disk"]);
    one.assert_clean();
    two.assert_clean();
}

/// An adopt judges disk by the store's copy alone, never by the adopting
/// host's base image: a host with room for the copy's first wake but not
/// for one of a disk as long as its base image, far longer than the
/// copy's, takes the copy and books only what it needs.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_adopt_judges_disk_by_the_copy_never_by_the_base_image() {
    const LONG: u64 = 8 << 30;
    let sandbox = id(3);
    let (one, two, gauge, _shelf) = handed_to_a_gauged_host(&[sandbox]).await;
    assert_eq!(hand_off(&one, sandbox, 1).await, Reply::Done);
    std::fs::OpenOptions::new()
        .write(true)
        .open(two.root.join("base.img"))
        .unwrap()
        .set_len(LONG)
        .unwrap();

    let free = read_disk(&two, &gauge, LONG / 2).await.free;
    assert_eq!(adopt(&two, sandbox, 2).await, Reply::Done);
    let booked = free - two.status().await.disk.unwrap().free;
    assert!(booked > 0 && booked < LONG / 4, "booked {booked}");
    assert_eq!(two.run(sandbox, &["disk"]).await, ["on-disk"]);
    one.assert_clean();
    two.assert_clean();
}

/// Once its lease runs out a host's VMs are frozen by its guard, so the
/// agent takes no decision by time, its own tools only read, and it goes
/// on where it was once the lease is renewed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_host_whose_lease_ran_out_decides_nothing_by_time_and_its_tools_only_read() {
    let gate = LeaseGate::new(boot_now() + Duration::from_secs(60));
    let lab = Lab::start_configured(
        Lab::root(),
        Arc::default(),
        Delays::default(),
        HostPolicy::default(),
        |config| config.lease = Some(gate.clone()),
    )
    .await;
    let sandbox = id(11);
    lab.create(sandbox, PAUSE_SOON).await;
    assert_eq!(lab.run(sandbox, &["set kept"]).await, ["ok"]);
    let local = lab.handle.local_to_fleet();
    assert!(local.status().await.is_ok(), "open: the tools work");
    assert!(
        matches!(
            local.remove(sandbox, None).await,
            Err(HostError::Invalid(_))
        ),
        "only the service, which lists the fleet's sandboxes, removes one"
    );

    gate.set(boot_now());
    assert!(!gate.is_open());
    // Well past the idle pause the sandbox would otherwise take.
    sleep(Duration::from_millis(800)).await;
    let status = local.status().await.expect("status while lapsed");
    let held = status
        .sandboxes
        .iter()
        .find(|held| held.id == sandbox)
        .unwrap();
    assert_eq!(held.level, LevelName::Running, "no idle pause while lapsed");
    assert!(held.step.is_none(), "nothing under way: {:?}", held.step);
    assert!(matches!(
        local.sleep(sandbox, None, Level::Paused).await,
        Err(HostError::LeaseLapsed)
    ));
    assert!(matches!(
        local.touch(sandbox, None, Priority::Interactive).await,
        Err(HostError::LeaseLapsed)
    ));

    // Renewed, it carries on: the idle sandbox pauses by itself.
    gate.set(boot_now() + Duration::from_secs(60));
    lab.wait_level(sandbox, LevelName::Paused).await;
    assert!(local.sleep(sandbox, None, Level::Saved).await.is_ok());
    lab.wait_level(sandbox, LevelName::Saved).await;
    lab.assert_clean();
}

/// A gate under registration 3 at renewal `seq`, open for a minute,
/// admitting requests two renewals old.
fn registered(seq: u64) -> LeaseGate {
    LeaseGate::holding(
        boot_now() + Duration::from_secs(60),
        Answered {
            host_epoch: Some(3),
            seq,
        },
        2,
    )
}

fn renewed(gate: &LeaseGate, host_epoch: u64, seq: u64) {
    gate.hold(
        Answered {
            host_epoch: Some(host_epoch),
            seq,
        },
        boot_now() + Duration::from_secs(60),
    );
}

/// The listener admits a request when it arrives; the agent carries it
/// out only if the lease would still admit it when it acts, so one that
/// waited across renewals or a new registration does nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_request_that_waited_past_its_admission_does_nothing() {
    let gate = registered(10);
    let lab = Lab::start_configured(
        Lab::root(),
        Arc::default(),
        Delays::default(),
        HostPolicy::default(),
        |config| config.lease = Some(gate.clone()),
    )
    .await;
    let (sandbox, other) = (id(21), id(22));
    let admitted = |host_epoch, stamp| {
        lab.handle
            .admitted(OwnerEpoch::FIRST, Admission { host_epoch, stamp })
    };
    admitted(3, 10)
        .create(sandbox, config(NEVER))
        .await
        .unwrap();
    renewed(&gate, 3, 13);
    let stale = admitted(3, 10);
    assert!(matches!(
        stale.create(other, config(NEVER)).await,
        Err(HostError::NotAdmitted)
    ));
    assert!(matches!(
        stale.touch(sandbox, None, Priority::Interactive).await,
        Err(HostError::NotAdmitted)
    ));
    // An adopt or hand-off names its owner itself, and is still held to
    // its admission.
    assert!(matches!(
        stale
            .adopt(other, config(NEVER), OwnerEpoch(2), false)
            .await,
        Err(HostError::NotAdmitted)
    ));
    assert!(matches!(
        stale.hand_off(sandbox, OwnerEpoch::FIRST, false).await,
        Err(HostError::NotAdmitted)
    ));
    assert!(
        admitted(3, 11)
            .touch(sandbox, None, Priority::Interactive)
            .await
            .is_ok()
    );
    renewed(&gate, 4, 1);
    assert!(
        matches!(
            admitted(3, 13).remove(sandbox, None).await,
            Err(HostError::NotAdmitted)
        ),
        "nothing sent under an earlier registration acts"
    );
    assert!(matches!(
        admitted(3, 13)
            .adopt(other, config(NEVER), OwnerEpoch(2), false)
            .await,
        Err(HostError::NotAdmitted)
    ));
    assert!(matches!(
        admitted(3, 13)
            .hand_off(sandbox, OwnerEpoch::FIRST, false)
            .await,
        Err(HostError::NotAdmitted)
    ));
    assert!(
        admitted(4, 1)
            .touch(sandbox, None, Priority::Interactive)
            .await
            .is_ok()
    );
    gate.set(boot_now());
    assert!(matches!(
        admitted(4, 1)
            .touch(sandbox, None, Priority::Interactive)
            .await,
        Err(HostError::NotAdmitted)
    ));
    assert_eq!(
        lab.status().await.sandboxes.len(),
        1,
        "{other} was never created"
    );
    lab.assert_clean();
}

/// Permits enough for every claim or archive a test makes.
const OPEN: usize = 1 << 20;

/// A store whose claims and archives each take a permit for good, so an
/// adopt or a sleep to the store stays under way until the test adds one.
struct Gated {
    inner: Directory,
    claims: Arc<Semaphore>,
    archives: Arc<Semaphore>,
}

impl Store for Gated {
    fn archive(
        &self,
        id: Id,
        save: Stamp,
        files: &SavedFiles,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<Archive, EngineError>> + Send {
        let archives = Arc::clone(&self.archives);
        async move {
            archives.acquire().await.expect("never closed").forget();
            self.inner.archive(id, save, files, cancel).await
        }
    }

    fn verify(
        &self,
        id: Id,
        receipt: &Receipt,
    ) -> impl Future<Output = Result<bool, EngineError>> + Send {
        self.inner.verify(id, receipt)
    }

    fn fetch(
        &self,
        id: Id,
        into: &FetchInto,
    ) -> impl Future<Output = Result<FetchedMemory, EngineError>> + Send {
        self.inner.fetch(id, into)
    }

    fn delete(
        &self,
        id: Id,
        own: OwnerEpoch,
    ) -> impl Future<Output = Result<Owned<()>, EngineError>> + Send {
        self.inner.delete(id, own)
    }

    fn claim(
        &self,
        id: Id,
        own: OwnerEpoch,
    ) -> impl Future<Output = Result<Owned<Option<Claimed>>, EngineError>> + Send {
        let claims = Arc::clone(&self.claims);
        async move {
            claims.acquire().await.expect("never closed").forget();
            self.inner.claim(id, own).await
        }
    }

    fn forget_memory(
        &self,
        id: Id,
        change: Stamp,
    ) -> impl Future<Output = Result<Owned<Option<Receipt>>, EngineError>> + Send {
        self.inner.forget_memory(id, change)
    }
}

/// What a registering host lists must be everything it holds, so the list
/// waits for an adopt under way, and a wake asked meanwhile is told to try
/// again rather than that the sandbox is not here.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_registering_host_lists_an_adopt_under_way_once_it_lands() {
    let root = Lab::root();
    let shelf = root.join("shelf");
    let one = Lab::start_stored(root, Arc::default(), Directory::new(&shelf)).await;
    let sandbox = id(23);
    one.create(sandbox, NEVER).await;
    one.run(sandbox, &["set moved"]).await;
    one.sleep_to(sandbox, LevelName::Archived).await;
    one.wait_level(sandbox, LevelName::Archived).await;

    let claims = Arc::new(Semaphore::new(0));
    let gated = Gated {
        inner: Directory::new(&shelf),
        claims: Arc::clone(&claims),
        archives: Arc::new(Semaphore::new(OPEN)),
    };
    let two = Lab::start_stored(Lab::root(), Arc::default(), gated).await;
    let owned = two.handle.owned(OwnerEpoch(2));
    let adopting = tokio::spawn({
        let owned = owned.clone();
        async move {
            owned
                .adopt(sandbox, config(NEVER), OwnerEpoch(2), false)
                .await
        }
    });
    let unsettled = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match two.handle.inventory().await.unwrap() {
                Err(unsettled) => break unsettled,
                Ok(_) => sleep(Duration::from_millis(5)).await,
            }
        }
    })
    .await
    .expect("the adopt starts");
    assert_eq!(unsettled, 1);
    assert!(
        matches!(
            owned.touch(sandbox, None, Priority::Interactive).await,
            Err(HostError::Busy(_))
        ),
        "never \"not found\" while the adopt may land"
    );
    claims.add_permits(1);
    adopting.await.unwrap().unwrap();
    let listed = two
        .handle
        .inventory()
        .await
        .unwrap()
        .expect("nothing under way");
    assert!(
        listed
            .sandboxes
            .iter()
            .any(|held| held.id == sandbox && held.owner_epoch == 2),
        "{listed:?}"
    );
    assert_eq!(two.run(sandbox, &["get"]).await, ["moved"]);
    one.assert_clean();
    two.assert_clean();
}

/// While the lease has run out the agent decides nothing of its own on
/// any input, not only on time: a hold let go long after the sandbox went
/// idle pauses nothing, nor does a restart that finds it, until renewal.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_host_whose_lease_ran_out_decides_nothing_on_events_or_after_a_restart() {
    let gate = LeaseGate::new(boot_now() + Duration::from_secs(60));
    let configure = |config: &mut compute_host::HostConfig| config.lease = Some(gate.clone());
    let lab = Lab::start_configured(
        Lab::root(),
        Arc::default(),
        Delays::default(),
        HostPolicy::default(),
        configure,
    )
    .await;
    let sandbox = id(24);
    lab.create(sandbox, PAUSE_SOON).await;
    lab.handle
        .hold(sandbox, None, "turn", None, Priority::Interactive)
        .await
        .unwrap();
    gate.set(boot_now());
    lab.handle.release(sandbox, None, "turn").await.unwrap();
    // Well past the idle pause the release would otherwise lead to.
    sleep(Duration::from_millis(800)).await;
    let still = |status: &compute_host::protocol::HostStatus| {
        let held = Lab::sandbox(status, sandbox);
        (held.level, held.step.clone())
    };
    assert_eq!(still(&lab.status().await), (LevelName::Running, None));

    let (root, world) = lab.stop().await;
    let lab = Lab::start_configured(
        root,
        world,
        Delays::default(),
        HostPolicy::default(),
        configure,
    )
    .await;
    sleep(Duration::from_millis(800)).await;
    assert_eq!(
        still(&lab.status().await),
        (LevelName::Running, None),
        "recovered into a lapsed lease, it decides nothing either"
    );
    gate.set(boot_now() + Duration::from_secs(60));
    lab.wait_level(sandbox, LevelName::Paused).await;
    lab.assert_clean();
}

/// A hand-off sent while a change of owner is still being written finds
/// the host about to hold that ownership: it is told to try again, never
/// that the sandbox is not here, which the service could take as final.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_hand_off_during_a_change_of_owner_is_never_answered_not_found() {
    let (one, _two, shelf) = hosts().await;
    let sandbox = id(25);
    one.create(sandbox, NEVER).await;
    // A sandbox boots on its first use.
    one.run(sandbox, &["set first"]).await;
    one.sleep_to(sandbox, LevelName::Paused).await;
    one.wait_level(sandbox, LevelName::Paused).await;
    let later = OwnerEpoch(2);
    // Sent in order on one channel: the create, which changes the owner,
    // then the hand-off under the new owner.
    let owned = one.handle.owned(later);
    let (created, handed) = tokio::join!(
        owned.create(sandbox, config(NEVER)),
        one.handle.hand_off(sandbox, later, false),
    );
    created.unwrap();
    assert!(
        matches!(handed, Ok(()) | Err(HostError::Busy(_))),
        "{handed:?}"
    );
    if handed.is_err() {
        one.handle.hand_off(sandbox, later, false).await.unwrap();
    }
    assert_eq!(one.status().await.sandboxes, Vec::new());
    assert!(shelf.join(sandbox.to_string()).exists());
    one.assert_clean();
}

/// A hand-off while the sandbox is being removed, which deletes the
/// store's copy, is told to try again: answered done, it would tell the
/// service the store still holds the sandbox.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_hand_off_during_a_removal_is_told_to_try_again() {
    let root = Lab::root();
    let shelf = root.join("shelf");
    let slow_stop = Delays {
        stop: Duration::from_millis(1500),
        ..Delays::default()
    };
    let config = Lab::config(&root, HostPolicy::default());
    let one = Lab::launch(
        root,
        Arc::default(),
        slow_stop,
        config,
        Directory::new(&shelf),
    )
    .await;
    let sandbox = id(27);
    one.create(sandbox, NEVER).await;
    one.run(sandbox, &["set first"]).await;
    one.sleep_to(sandbox, LevelName::Paused).await;
    one.wait_level(sandbox, LevelName::Paused).await;
    let removing = tokio::spawn({
        let handle = one.handle.clone();
        async move { handle.remove(sandbox, None).await }
    });
    // The removal is under way once the host no longer lists the sandbox;
    // a hand-off sent before it reached the host would just be done.
    one.wait_until(&format!("{sandbox} being removed"), |status| {
        status.sandboxes.iter().all(|listed| listed.id != sandbox)
    })
    .await;
    let mut busy = 0;
    loop {
        match hand_off(&one, sandbox, 1).await {
            Reply::Error {
                code: ErrorCode::Busy,
                ..
            } => busy += 1,
            // Gone: the removal is over, or ends at once.
            Reply::Error {
                code: ErrorCode::NotFound,
                ..
            } => break,
            other => panic!("a hand-off during a removal: {other:?}"),
        }
        sleep(Duration::from_millis(50)).await;
    }
    tokio::time::timeout(Duration::from_secs(5), removing)
        .await
        .expect("the removal ended with the sandbox gone")
        .unwrap()
        .unwrap();
    assert!(busy > 0, "the removal was never seen under way");
    one.assert_clean();
}

/// An adopt under a later ownership removes the earlier one's copy first.
/// A hand-off meanwhile, under either ownership, must not join that
/// removal: it would be answered done while the sandbox is about to be
/// this host's again.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_hand_off_during_an_adopts_removal_is_told_to_try_again() {
    let root = Lab::root();
    let shelf = root.join("shelf");
    let one = Lab::start_stored(root, Arc::default(), Directory::new(&shelf)).await;
    let sandbox = id(26);
    one.create(sandbox, NEVER).await;
    one.run(sandbox, &["set moved"]).await;
    one.sleep_to(sandbox, LevelName::Archived).await;
    one.wait_level(sandbox, LevelName::Archived).await;
    assert_eq!(hand_off(&one, sandbox, 1).await, Reply::Done);

    let claims = Arc::new(Semaphore::new(1));
    let gated = Gated {
        inner: Directory::new(&shelf),
        claims: Arc::clone(&claims),
        archives: Arc::new(Semaphore::new(OPEN)),
    };
    let two_root = Lab::root();
    let slow_stop = Delays {
        stop: Duration::from_millis(1500),
        ..Delays::default()
    };
    let config_two = Lab::config(&two_root, HostPolicy::default());
    let two = Lab::launch(two_root, Arc::default(), slow_stop, config_two, gated).await;
    assert_eq!(adopt(&two, sandbox, 2).await, Reply::Done);
    assert_eq!(two.run(sandbox, &["get"]).await, ["moved"]);

    let adopting = tokio::spawn({
        let owned = two.handle.owned(OwnerEpoch(3));
        async move {
            owned
                .adopt(sandbox, config(NEVER), OwnerEpoch(3), false)
                .await
        }
    });
    // Until the adopt is let claim the store's copy, it is still under
    // way: the earlier copy's removal, then the claim.
    // One under the ownership being replaced is stale; one under the new
    // ownership must try again, never be told the sandbox is gone.
    for _ in 0..10 {
        let earlier = code(&hand_off(&two, sandbox, 2).await);
        assert!(
            matches!(earlier, Some(ErrorCode::Busy | ErrorCode::Stale)),
            "a hand-off under ownership 2: {earlier:?}"
        );
        assert_eq!(
            code(&hand_off(&two, sandbox, 3).await),
            Some(ErrorCode::Busy),
            "a hand-off under ownership 3"
        );
        sleep(Duration::from_millis(200)).await;
    }
    assert!(!adopting.is_finished());
    claims.add_permits(1);
    adopting.await.unwrap().unwrap();
    let adopted = two.current(sandbox).await;
    assert_eq!(adopted.owner_epoch, 3);
    assert_eq!(two.run(sandbox, &["get"]).await, ["moved"]);
    one.assert_clean();
    two.assert_clean();
}
