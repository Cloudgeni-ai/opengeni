//! A sandbox's VM is marked its sandbox's only copy while no copy of it
//! can reach the store, so the guard leaves it running when the host's
//! lease runs out (ADR 18): from its create or claim here until an
//! archive of it begins, whose VM loses the mark before the store sees
//! anything of it.

use std::future::Future;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use compute_core::HostPolicy;
use compute_engine::{CancellationToken, EngineError};
use compute_host::protocol::{DurabilityName, Id, LevelName, Reply};
use compute_host::{
    Archive, Claimed, Directory, FetchInto, FetchedMemory, Owned, OwnerEpoch, Receipt, SavedFiles,
    Stamp, Store,
};

use super::{Delays, Lab, NEVER, SAVE_IN_PLACE, World, id, vm_name};

/// A store that notes, as each archive begins, how the VM of the sandbox
/// it archives is marked.
struct Watching {
    inner: Directory,
    world: Arc<World>,
    seen: Arc<Mutex<Vec<Option<bool>>>>,
}

impl Store for Watching {
    fn archive(
        &self,
        id: Id,
        save: Stamp,
        files: &SavedFiles,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<Archive, EngineError>> + Send {
        let marked = self
            .world
            .only_copies
            .lock()
            .unwrap()
            .get(&vm_name(id))
            .copied();
        self.seen.lock().unwrap().push(marked);
        self.inner.archive(id, save, files, cancel)
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

fn marked(lab: &Lab, sandbox: Id) -> Option<bool> {
    lab.world
        .only_copies
        .lock()
        .unwrap()
        .get(&vm_name(sandbox))
        .copied()
}

fn recorded_only_copy(lab: &Lab, sandbox: Id) -> bool {
    lab.record(sandbox)["only_copy"].as_bool().unwrap_or(false)
}

/// Created here, a sandbox is its only copy, and its VM marked so, through
/// a save in place; an archive clears the VM's mark before the store sees
/// anything, then the record's, for good: its next VM is not marked, and
/// neither is it after the agent restarts.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sandbox_is_its_only_copy_until_an_archive_of_it_begins() {
    let root = Lab::root();
    let world: Arc<World> = Arc::default();
    let seen = Arc::default();
    let store = Watching {
        inner: Directory::new(root.join("shelf")),
        world: Arc::clone(&world),
        seen: Arc::clone(&seen),
    };
    let lab = Lab::start_stored(root.clone(), world, store).await;
    let sandbox = id(1);
    lab.create(sandbox, SAVE_IN_PLACE).await;
    assert!(
        recorded_only_copy(&lab, sandbox),
        "made here from nothing the store holds"
    );
    assert_eq!(lab.run(sandbox, &["set kept"]).await, ["ok"]);
    assert_eq!(marked(&lab, sandbox), Some(true));
    lab.wait_until("the save in place", |status| {
        let view = Lab::sandbox(status, sandbox);
        view.durability == DurabilityName::Local && view.step.is_none()
    })
    .await;
    assert_eq!(marked(&lab, sandbox), Some(true), "a local save is no copy");
    assert!(recorded_only_copy(&lab, sandbox));

    assert_eq!(
        lab.sleep_to(sandbox, LevelName::Archived).await,
        Reply::Done
    );
    lab.wait_level(sandbox, LevelName::Archived).await;
    let seen: Vec<Option<bool>> = seen.lock().unwrap().clone();
    assert!(!seen.is_empty(), "it was archived");
    assert!(
        seen.iter().all(|mark| *mark != Some(true)),
        "no VM marked the only copy as the store saw it: {seen:?}"
    );
    assert!(!recorded_only_copy(&lab, sandbox));
    assert_ne!(marked(&lab, sandbox), Some(true));

    assert_eq!(lab.run(sandbox, &["get"]).await, ["kept"]);
    assert_eq!(marked(&lab, sandbox), Some(false), "its next VM is fenced");
    lab.assert_clean();
}

/// An agent that restarts while a sandbox's VM runs marks it as the record
/// says: an agent of an earlier release kept no such record.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restarted_agent_marks_the_vms_it_takes_back_as_their_records_say() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let (only, copied) = (id(2), id(3));
    lab.create(only, NEVER).await;
    lab.create(copied, NEVER).await;
    for sandbox in [only, copied] {
        assert_eq!(lab.run(sandbox, &["set kept"]).await, ["ok"]);
    }
    let (root, world) = lab.stop().await;
    // As an earlier release would leave them: a record without the fact,
    // and VMs with whatever mark.
    let record = root
        .join("state/vm/firecracker")
        .join(copied.to_string())
        .join("sandbox.json");
    let mut written: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&record).unwrap()).unwrap();
    written.as_object_mut().unwrap().remove("only_copy");
    std::fs::write(&record, serde_json::to_vec(&written).unwrap()).unwrap();
    world.only_copies.lock().unwrap().clear();
    let lab = Lab::start(root, world, Delays::default(), HostPolicy::default()).await;
    for sandbox in [only, copied] {
        assert_eq!(lab.run(sandbox, &["get"]).await, ["kept"], "taken back");
    }
    assert_eq!(marked(&lab, only), Some(true));
    assert_eq!(marked(&lab, copied), Some(false));
    lab.assert_clean();
}

/// A group the kernel still holds after its VM ended keeps that VM's mark.
/// A sandbox saved here and then archived has no VM whose mark the archive
/// could clear, and its next VM starts into that group: it starts
/// unmarked and nothing marks it, so the guard does not leave running a
/// VM whose sandbox has a copy.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_vm_started_into_a_marked_group_left_behind_is_not_marked() {
    let root = Lab::root();
    let world: Arc<World> = Arc::default();
    world.groups_left.store(true, Ordering::SeqCst);
    let store = Directory::new(root.join("shelf"));
    let lab = Lab::start_stored(root, world, store).await;
    let sandbox = id(4);
    lab.create(sandbox, NEVER).await;
    assert_eq!(lab.run(sandbox, &["set kept"]).await, ["ok"]);
    assert_eq!(marked(&lab, sandbox), Some(true));
    assert_eq!(lab.sleep_to(sandbox, LevelName::Saved).await, Reply::Done);
    lab.wait_level(sandbox, LevelName::Saved).await;
    assert_eq!(marked(&lab, sandbox), Some(true), "its group kept the mark");

    assert_eq!(
        lab.sleep_to(sandbox, LevelName::Archived).await,
        Reply::Done
    );
    lab.wait_level(sandbox, LevelName::Archived).await;
    assert!(!recorded_only_copy(&lab, sandbox));
    assert_eq!(lab.run(sandbox, &["get"]).await, ["kept"]);
    assert_eq!(
        marked(&lab, sandbox),
        Some(false),
        "its next VM is unmarked"
    );
    lab.assert_clean();
}
