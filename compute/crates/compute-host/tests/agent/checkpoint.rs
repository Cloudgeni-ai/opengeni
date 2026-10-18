//! Checkpoints: sandboxes in use copied to the store while they run, so
//! losing their host costs them only what changed since.
//!
//! A checkpoint clones the disk, which needs a state root whose files
//! share extents (XFS, btrfs). Those tests run only where
//! `COMPUTE_TEST_SHARED_EXTENTS_DIR` names a directory on such a
//! filesystem; a gate that lists `shared-extents` in
//! `COMPUTE_TEST_REQUIRE` fails them instead of skipping.
//!
//! The hosts here keep sandboxes in a local directory, which brings a
//! memory image back whole, as the fake engine needs. That store keeps no
//! owner stamps, so the test of a checkpoint meeting a later owner uses
//! [`Superseded`] for the refusal the fleet's store gives; the real
//! Firecracker tests check it against that store.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use compute_core::HostPolicy;
use compute_engine::{CancellationToken, EngineError};
use compute_host::protocol::{
    DurabilityName, ErrorCode, HostStatus, Id, LevelName, Reply, Request, SandboxConfig,
    SandboxStatus, SleepConfig,
};
use compute_host::{
    Archive, Claimed, Directory, FetchInto, FetchedMemory, Owned, OwnerEpoch, Receipt, SavedFiles,
    Stamp, Store,
};
use tokio::time::{Instant, sleep};

use super::{Delays, Lab, NEVER, id, required};

/// Checkpointed every two seconds of running: long enough that a test sees
/// one checkpoint end before the next can begin.
const CHECKPOINTED: SleepConfig = SleepConfig {
    checkpoint_every_ms: Some(2_000),
    ..NEVER
};

/// The directory on a filesystem whose files share extents, if the test
/// host has one.
fn shared_extents() -> Option<PathBuf> {
    let dir = std::env::var_os("COMPUTE_TEST_SHARED_EXTENTS_DIR").map(PathBuf::from);
    if dir.is_none() {
        required::skip(
            "shared-extents",
            "COMPUTE_TEST_SHARED_EXTENTS_DIR names no directory whose files share extents",
        );
    }
    dir
}

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

fn unix_ms() -> u64 {
    let since = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    u64::try_from(since.as_millis()).unwrap()
}

/// Two hosts under `dir` keeping sandboxes in one store, the first with
/// `delays`.
async fn hosts_in(dir: &Path, delays: Delays) -> (Lab, Lab) {
    let a = Lab::root_in(dir);
    let shelf = a.join("shelf");
    let config = Lab::config(&a, HostPolicy::default());
    let one = Lab::launch(a, Arc::default(), delays, config, Directory::new(&shelf)).await;
    let two = Lab::start_stored(Lab::root_in(dir), Arc::default(), Directory::new(&shelf)).await;
    (one, two)
}

/// A store whose sandboxes a later owner holds once `by` is set: from then
/// on it refuses this host's every write to them, as the fleet's store
/// refuses one stamped with an earlier owner epoch.
struct Superseded {
    inner: Directory,
    by: Arc<AtomicU64>,
}

impl Superseded {
    fn later(&self) -> Option<OwnerEpoch> {
        match self.by.load(Ordering::SeqCst) {
            0 => None,
            by => Some(OwnerEpoch(by)),
        }
    }
}

impl Store for Superseded {
    fn archive(
        &self,
        id: Id,
        save: Stamp,
        files: &SavedFiles,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<Archive, EngineError>> + Send {
        let later = self.later();
        let archived = self.inner.archive(id, save, files, cancel);
        async move {
            match later {
                Some(by) => Ok(Archive::Fenced { by }),
                None => archived.await,
            }
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
        let later = self.later();
        let deleted = self.inner.delete(id, own);
        async move {
            match later {
                Some(by) => Ok(Owned::Fenced { by }),
                None => deleted.await,
            }
        }
    }

    fn claim(
        &self,
        id: Id,
        own: OwnerEpoch,
    ) -> impl Future<Output = Result<Owned<Option<Claimed>>, EngineError>> + Send {
        self.inner.claim(id, own)
    }

    fn forget_memory(
        &self,
        id: Id,
        change: Stamp,
    ) -> impl Future<Output = Result<Owned<Option<Receipt>>, EngineError>> + Send {
        let later = self.later();
        let forgotten = self.inner.forget_memory(id, change);
        async move {
            match later {
                Some(by) => Ok(Owned::Fenced { by }),
                None => forgotten.await,
            }
        }
    }
}

/// Waits until `id`'s latest copy in the store was captured at `after_ms`
/// or later, and no step runs, and returns its status.
async fn checkpointed_since(lab: &Lab, id: Id, after_ms: u64) -> SandboxStatus {
    let status = lab
        .wait_until(&format!("a checkpoint of {id}"), |status| {
            let sandbox = Lab::sandbox(status, id);
            sandbox.step.is_none() && sandbox.backed_up_ms.is_some_and(|ms| ms >= after_ms)
        })
        .await;
    Lab::sandbox(&status, id).clone()
}

/// A store whose archives take `delay` longer, as a large upload does.
struct Slow {
    inner: Directory,
    delay: Duration,
}

impl Store for Slow {
    fn archive(
        &self,
        id: Id,
        save: Stamp,
        files: &SavedFiles,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<Archive, EngineError>> + Send {
        let (archived, delay) = (self.inner.archive(id, save, files, cancel), self.delay);
        async move {
            sleep(delay).await;
            archived.await
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
        self.inner.claim(id, own)
    }

    fn forget_memory(
        &self,
        id: Id,
        change: Stamp,
    ) -> impl Future<Output = Result<Owned<Option<Receipt>>, EngineError>> + Send {
        self.inner.forget_memory(id, change)
    }
}

fn snapshots(lab: &Lab) -> usize {
    lab.world
        .snapshots
        .iter()
        .map(|taken| taken.load(Ordering::Relaxed))
        .sum()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_running_sandbox_is_checkpointed_and_comes_back_elsewhere_as_it_was_then() {
    let Some(dir) = shared_extents() else {
        return;
    };
    let (one, two) = hosts_in(&dir, Delays::default()).await;
    assert!(
        one.status().await.about.checkpoints,
        "{dir:?} shares extents"
    );
    let sandbox = id(1);
    one.create(sandbox, CHECKPOINTED).await;
    one.run(sandbox, &["set kept", "write on-disk"]).await;
    let written = unix_ms();

    let checkpointed = checkpointed_since(&one, sandbox, written).await;
    assert_eq!(
        (checkpointed.level, checkpointed.durability),
        (LevelName::Running, DurabilityName::Volatile),
        "it goes on running, and the copy is no longer current"
    );
    assert!(!one.image(sandbox), "the record vouches for no local copy");
    // What it does from now on is in no copy.
    assert_eq!(
        one.run(sandbox, &["set later", "write later", "get", "disk"])
            .await,
        ["ok", "ok", "later", "later"]
    );
    // The host is lost before its next checkpoint, and the fleet gives the
    // sandbox to another.
    one.assert_clean();
    drop(one.stop().await);
    assert_eq!(
        two.client
            .call(&Request::Adopt {
                id: sandbox,
                config: config(CHECKPOINTED),
                owner_epoch: 2,
            })
            .await
            .unwrap(),
        Reply::Done
    );
    let adopted = two.current(sandbox).await;
    assert_eq!(adopted.level, LevelName::Remote);
    assert!(adopted.memory_saved, "the checkpoint holds its memory");
    assert_eq!(
        two.run(sandbox, &["get", "disk"]).await,
        ["kept", "on-disk"],
        "programs and files as they were at the checkpoint"
    );
    two.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_checkpoint_that_finds_a_later_owner_drops_this_hosts_copy() {
    let Some(dir) = shared_extents() else {
        return;
    };
    let root = Lab::root_in(&dir);
    let shelf = root.join("shelf");
    let by = Arc::new(AtomicU64::new(0));
    let superseded = Superseded {
        inner: Directory::new(&shelf),
        by: Arc::clone(&by),
    };
    let one = Lab::start_stored(root, Arc::default(), superseded).await;
    let two = Lab::start_stored(Lab::root_in(&dir), Arc::default(), Directory::new(&shelf)).await;
    let sandbox = id(7);
    one.create(sandbox, CHECKPOINTED).await;
    one.run(sandbox, &["set kept"]).await;
    let written = unix_ms();
    checkpointed_since(&one, sandbox, written).await;
    // The fleet gave the sandbox to another host while this one still runs
    // it, as when it lost this host's lease: the store now refuses this
    // host's writes.
    by.store(2, Ordering::SeqCst);
    assert_eq!(
        two.client
            .call(&Request::Adopt {
                id: sandbox,
                config: config(CHECKPOINTED),
                owner_epoch: 2,
            })
            .await
            .unwrap(),
        Reply::Done
    );
    one.wait_until("the first host's copy dropped", |status| {
        status.sandboxes.iter().all(|found| found.id != sandbox)
    })
    .await;
    // Its removal, which began then, ends its VM.
    let runs = || !one.world.live.lock().unwrap().is_empty();
    let dropped = Instant::now();
    while runs() {
        assert!(dropped.elapsed() < Duration::from_secs(10), "its VM ends");
        sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(two.run(sandbox, &["get"]).await, ["kept"]);
    one.assert_clean();
    two.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn use_during_a_checkpoint_neither_waits_for_it_nor_cancels_it() {
    let Some(dir) = shared_extents() else {
        return;
    };
    let snapshot = Duration::from_millis(600);
    let delays = Delays {
        snapshot,
        ..Delays::default()
    };
    let (one, _two) = hosts_in(&dir, delays).await;
    let sandbox = id(2);
    one.create(sandbox, CHECKPOINTED).await;
    one.run(sandbox, &["set kept"]).await;
    let written = unix_ms();
    let before = snapshots(&one);
    one.wait_until("a checkpoint under way", |status: &HostStatus| {
        Lab::sandbox(status, sandbox).step.as_deref() == Some("checkpoint")
    })
    .await;
    // It runs: a wake has nothing to wait for.
    let asked = Instant::now();
    let woken = one.wake(sandbox).await;
    let Reply::Woken { waited_us, .. } = woken else {
        panic!("{woken:?}");
    };
    assert!(asked.elapsed() < snapshot / 2, "{:?}", asked.elapsed());
    assert!(
        u128::from(waited_us) < (snapshot / 2).as_micros(),
        "{woken:?}"
    );
    assert_eq!(one.run(sandbox, &["get"]).await, ["kept"]);
    assert_eq!(
        one.current(sandbox).await.step.as_deref(),
        Some("checkpoint"),
        "use goes on beside the checkpoint"
    );
    let done = checkpointed_since(&one, sandbox, written).await;
    assert_eq!(done.level, LevelName::Running);
    assert_eq!(
        snapshots(&one) - before,
        1,
        "the checkpoint was not cancelled and taken again"
    );
    one.assert_clean();
}

/// A command running in the guest keeps an idle sandbox from sleeping, not
/// from being checkpointed: the host takes a checkpoint without asking the
/// guest, once each time it is due, rather than starting and cancelling it
/// over and over while the command runs.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_running_command_does_not_hold_up_a_checkpoint() {
    let Some(dir) = shared_extents() else {
        return;
    };
    let root = Lab::root_in(&dir);
    let shelf = root.join("shelf");
    let mut config = Lab::config(&root, HostPolicy::default());
    config.restore_notice_port = Some(53);
    let one = Lab::launch(
        root,
        Arc::default(),
        Delays::default(),
        config,
        Directory::new(&shelf),
    )
    .await;
    let sandbox = id(6);
    one.create(sandbox, CHECKPOINTED).await;
    assert_eq!(one.run(sandbox, &["start-command"]).await, ["ok"]);
    let written = unix_ms();
    let done = checkpointed_since(&one, sandbox, written).await;
    assert_eq!(done.level, LevelName::Running);
    let status = one.status().await;
    let (_, checkpoints) = status
        .steps
        .iter()
        .find(|(name, _)| name == "checkpoint")
        .expect("checkpoint statistics");
    assert_eq!(checkpoints.cancelled, 0, "{checkpoints:?}");
    assert!(checkpoints.started <= 2, "{checkpoints:?}");
    assert_eq!(one.run(sandbox, &["end-command"]).await, ["ok"]);
    one.assert_clean();
}

/// A guest working on its own throughout a checkpoint whose upload takes
/// longer than its pause delay is not taken for idle: it runs on once the
/// checkpoint ends, and sleeps only once it goes quiet.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_guest_working_through_a_slow_checkpoint_stays_awake_after_it() {
    let Some(dir) = shared_extents() else {
        return;
    };
    let root = Lab::root_in(&dir);
    let config = Lab::config(&root, HostPolicy::default());
    let upload = Duration::from_millis(3_000);
    let store = Slow {
        inner: Directory::new(root.join("shelf")),
        delay: upload,
    };
    let one = Lab::launch(root, Arc::default(), Delays::default(), config, store).await;
    let sandbox = id(5);
    let sleep_config = SleepConfig {
        pause_after_ms: Some(1_000),
        ..CHECKPOINTED
    };
    one.create(sandbox, sleep_config).await;
    assert_eq!(one.run(sandbox, &["busy"]).await, ["ok"]);
    let written = unix_ms();
    let began = one
        .wait_until("a checkpoint under way", |status: &HostStatus| {
            Lab::sandbox(status, sandbox).step.as_deref() == Some("checkpoint")
        })
        .await;
    assert_eq!(Lab::sandbox(&began, sandbox).level, LevelName::Running);
    let done = checkpointed_since(&one, sandbox, written).await;
    assert_eq!(
        done.level,
        LevelName::Running,
        "a working guest was put to sleep as its checkpoint ended"
    );
    sleep(Duration::from_millis(1_500)).await;
    assert_eq!(one.current(sandbox).await.level, LevelName::Running);
    // Quiet now: it sleeps after its pause delay, checkpoint or not.
    assert_eq!(one.run(sandbox, &["quiet"]).await, ["ok"]);
    one.wait_until("the quiet guest paused", |status: &HostStatus| {
        let view = Lab::sandbox(status, sandbox);
        view.level == LevelName::Paused && view.step.is_none()
    })
    .await;
    one.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_new_sandbox_that_checkpoints_is_archived_before_it_ever_runs() {
    let Some(dir) = shared_extents() else {
        return;
    };
    let (one, two) = hosts_in(&dir, Delays::default()).await;
    let sandbox = id(3);
    one.create(sandbox, CHECKPOINTED).await;
    let archived = one
        .wait_until("the new sandbox archived", |status| {
            let sandbox = Lab::sandbox(status, sandbox);
            sandbox.step.is_none() && sandbox.durability == DurabilityName::Remote
        })
        .await;
    let archived = Lab::sandbox(&archived, sandbox);
    assert_eq!(archived.level, LevelName::Archived);
    assert!(archived.backed_up_ms.is_some());
    assert_eq!(archived.launches, 0, "it never ran");
    // Losing its host before it ever ran loses nothing.
    drop(one.stop().await);
    assert_eq!(
        two.client
            .call(&Request::Adopt {
                id: sandbox,
                config: config(CHECKPOINTED),
                owner_epoch: 2,
            })
            .await
            .unwrap(),
        Reply::Done
    );
    assert_eq!(two.run(sandbox, &["disk"]).await, ["base"]);
    two.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_host_whose_files_share_no_extents_takes_no_checkpoints() {
    let root = Lab::root();
    let shelf = root.join("shelf");
    let lab = Lab::start_stored(root, Arc::default(), Directory::new(&shelf)).await;
    if lab.status().await.about.checkpoints {
        // Only where the temporary directory shares no extents, as ext4.
        eprintln!("skipped: files under /tmp share extents here");
        return;
    }
    let sandbox = id(4);
    // Taken, without them: its status says this host takes none.
    lab.create(sandbox, CHECKPOINTED).await;
    lab.run(sandbox, &["set kept"]).await;
    sleep(Duration::from_millis(2_500)).await;
    let running = lab.current(sandbox).await;
    assert_eq!(
        (running.level, running.durability, running.backed_up_ms),
        (LevelName::Running, DurabilityName::Volatile, None)
    );
    assert!(!shelf.join(sandbox.to_string()).exists());
    lab.assert_clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_host_without_a_store_refuses_checkpoints() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    assert!(!lab.status().await.about.checkpoints);
    let reply = lab
        .client
        .call(&Request::Create {
            id: id(5),
            config: config(CHECKPOINTED),
        })
        .await
        .unwrap();
    assert!(
        matches!(
            reply,
            Reply::Error {
                code: ErrorCode::Invalid,
                ..
            }
        ),
        "{reply:?}"
    );
    assert_eq!(lab.status().await.sandboxes, Vec::new());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restart_removes_a_disk_clone_a_crashed_checkpoint_left() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let sandbox = id(6);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["write on-disk"]).await;
    let clone = lab.sandbox_dir(sandbox).join("checkpoint.disk");
    let (root, world) = lab.stop().await;
    std::fs::write(&clone, "a clone").unwrap();
    let lab = Lab::start(root, world, Delays::default(), HostPolicy::default()).await;
    assert!(!clone.exists(), "recovery removes it");
    assert_eq!(lab.run(sandbox, &["disk"]).await, ["on-disk"]);
    lab.assert_clean();
}
