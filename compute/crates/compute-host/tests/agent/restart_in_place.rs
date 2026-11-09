//! Restarting a sandbox where it is ([`Request::Restart`]): its programs
//! end and its files stay, without a copy going to the store first, so a
//! store however slow never holds it up.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use compute_engine::{CancellationToken, EngineError};
use compute_host::protocol::{ErrorCode, Id, LevelName, Reply, Request};
use compute_host::{
    Archive, Claimed, Directory, FetchInto, FetchedMemory, HostError, Owned, OwnerEpoch, Receipt,
    SavedFiles, Stamp, Store,
};
use tokio::time::Instant;

use super::{Lab, NEVER, id};

async fn restart(lab: &Lab, sandbox: Id) -> Reply {
    lab.client
        .call(&Request::Restart { id: sandbox })
        .await
        .unwrap()
}

/// A running sandbox restarted keeps its files and loses its programs: its
/// VM ends unsaved and its next wake boots it afresh on the same host.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restarted_sandbox_boots_afresh_from_its_files_where_it_is() {
    let lab = {
        let root = Lab::root();
        let shelf = Directory::new(root.join("shelf"));
        Lab::start_stored(root, Arc::default(), shelf).await
    };
    let sandbox = id(1);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["set alive", "write on-disk"]).await;
    let before = lab.current(sandbox).await;
    assert_eq!(restart(&lab, sandbox).await, Reply::Done);
    let after = lab.current(sandbox).await;
    assert_ne!(after.level, LevelName::Running, "its VM ended");
    assert!(!after.memory_saved, "nothing of its programs is kept");
    let replies = lab.run(sandbox, &["get", "disk"]).await;
    assert_ne!(replies[0], "alive", "its programs started afresh");
    assert_eq!(replies[1], "on-disk", "its files stayed");
    assert!(
        lab.current(sandbox).await.generation > before.generation,
        "it booted afresh"
    );
    assert_eq!(
        code(&restart(&lab, id(9)).await),
        Some(ErrorCode::NotFound),
        "a sandbox the host does not hold"
    );
    lab.assert_clean();
}

/// A sandbox with a saved memory image forgets it, so its next wake boots
/// from its files, not from programs the restart was asked to end.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sleeping_sandbox_restarted_forgets_its_memory_image() {
    let lab = {
        let root = Lab::root();
        let shelf = Directory::new(root.join("shelf"));
        Lab::start_stored(root, Arc::default(), shelf).await
    };
    let sandbox = id(2);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["set alive", "write on-disk"]).await;
    assert_eq!(lab.sleep_to(sandbox, LevelName::Saved).await, Reply::Done);
    lab.wait_level(sandbox, LevelName::Saved).await;
    assert!(lab.current(sandbox).await.memory_saved);
    assert_eq!(restart(&lab, sandbox).await, Reply::Done);
    assert!(!lab.current(sandbox).await.memory_saved);
    let replies = lab.run(sandbox, &["get", "disk"]).await;
    assert_ne!(replies[0], "alive");
    assert_eq!(replies[1], "on-disk");
    lab.assert_clean();
}

/// A store that takes an archive never, until cancelled, as one that takes
/// a large copy at a trickle.
struct Trickle(Directory);

impl Store for Trickle {
    fn archive(
        &self,
        _: Id,
        _: Stamp,
        _: &SavedFiles,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<Archive, EngineError>> + Send {
        let cancel = cancel.clone();
        async move {
            cancel.cancelled().await;
            Ok(Archive::Cancelled)
        }
    }

    fn verify(
        &self,
        id: Id,
        receipt: &Receipt,
    ) -> impl Future<Output = Result<bool, EngineError>> + Send {
        self.0.verify(id, receipt)
    }

    fn fetch(
        &self,
        id: Id,
        into: &FetchInto,
    ) -> impl Future<Output = Result<FetchedMemory, EngineError>> + Send {
        self.0.fetch(id, into)
    }

    fn delete(
        &self,
        id: Id,
        own: OwnerEpoch,
    ) -> impl Future<Output = Result<Owned<()>, EngineError>> + Send {
        self.0.delete(id, own)
    }

    fn claim(
        &self,
        id: Id,
        own: OwnerEpoch,
    ) -> impl Future<Output = Result<Owned<Option<Claimed>>, EngineError>> + Send {
        self.0.claim(id, own)
    }

    fn forget_memory(
        &self,
        id: Id,
        change: Stamp,
    ) -> impl Future<Output = Result<Owned<Option<Receipt>>, EngineError>> + Send {
        self.0.forget_memory(id, change)
    }
}

/// A restart never waits for a copy on its way to a slow store: the copy
/// is cancelled, the files here stay, and the sandbox runs again within
/// moments. A hand-off under way, which is storing it, refuses a restart,
/// until a wake late enough cancels the hand-off.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restart_cancels_a_copy_on_its_way_to_a_slow_store() {
    let root = Lab::root();
    let store = Trickle(Directory::new(root.join("shelf")));
    let unwakeable = Duration::from_millis(200);
    let lab = Lab::start_stored_configured(root, Arc::default(), store, |config| {
        config.hand_off_unwakeable = unwakeable;
    })
    .await;
    let sandbox = id(3);
    lab.create(sandbox, NEVER).await;
    lab.run(sandbox, &["set alive", "write on-disk"]).await;

    let handle = lab.handle.clone();
    let handing =
        tokio::spawn(async move { handle.hand_off(sandbox, OwnerEpoch::FIRST, true).await });
    lab.wait_until("the hand-off to begin", |status| {
        Lab::sandbox(status, sandbox).step.is_some()
    })
    .await;
    assert_eq!(
        code(&restart(&lab, sandbox).await),
        Some(ErrorCode::Busy),
        "a hand-off under way"
    );
    assert!(!handing.is_finished(), "the store holds the hand-off");
    tokio::time::sleep(unwakeable).await;
    assert!(matches!(lab.wake(sandbox).await, Reply::Woken { .. }));
    assert!(matches!(
        handing.await.unwrap(),
        Err(HostError::HandOffCancelled(_))
    ));

    assert_eq!(
        lab.sleep_to(sandbox, LevelName::Archived).await,
        Reply::Done
    );
    lab.wait_until("the archive to begin", |status| {
        Lab::sandbox(status, sandbox).step.as_deref() == Some("archive")
    })
    .await;
    let began = Instant::now();
    assert_eq!(restart(&lab, sandbox).await, Reply::Done);
    assert!(
        began.elapsed() < Duration::from_secs(5),
        "it waited for the store"
    );
    let replies = lab.run(sandbox, &["get", "disk"]).await;
    assert_ne!(replies[0], "alive");
    assert_eq!(replies[1], "on-disk", "its newest files stayed");
    lab.assert_clean();
}

fn code(reply: &Reply) -> Option<ErrorCode> {
    match reply {
        Reply::Error { code, .. } => Some(*code),
        _ => None,
    }
}
