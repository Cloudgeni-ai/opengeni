use super::*;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize};

use compute_core::SandboxId;
use compute_engine::{Found, SnapshotFiles};
use tokio::task::JoinHandle;

use crate::layout::tests::FAILPOINTS;
use crate::layout::vm_spec;
use crate::protocol::{SandboxConfig, SleepConfig};
use crate::state::Allocation;
use crate::store::{Directory, NoStore};

/// A VMM with one VM, which counts what it is asked to do.
#[derive(Debug, Default)]
struct Counting {
    restores: AtomicUsize,
    resumes: AtomicUsize,
    stops: AtomicUsize,
    /// What [`Engine::runtime`] says.
    runtime: String,
    /// What [`Engine::reads`] says of any runtime but its own.
    reads: Option<Readable>,
    /// Whether it refuses every memory image, as a VMM refuses a snapshot
    /// format it no longer reads.
    refuses: AtomicBool,
    /// How its next resumes fail, one each, before they succeed again.
    resume_failures: std::sync::Mutex<std::collections::VecDeque<ErrorKind>>,
    /// Whether its VM has ended: [`Engine::exited`] resolves once it has.
    ended: tokio::sync::watch::Sender<bool>,
}

impl Counting {
    fn count(counter: &AtomicUsize) -> usize {
        counter.load(Ordering::SeqCst)
    }
}

// A fake answers at once; the trait is async for the real VMMs.
#[allow(clippy::unused_async_trait_impl)]
impl Engine for Counting {
    type Vm = ();

    fn memory_profile(&self) -> MemoryProfile {
        MemoryProfile::bare_metal()
    }

    fn runtime(&self) -> &str {
        &self.runtime
    }

    fn reads(&self, made_under: &str) -> Readable {
        if made_under == self.runtime && !made_under.is_empty() {
            return Readable::Yes;
        }
        self.reads.clone().unwrap_or(Readable::Unknown)
    }

    async fn boot(&self, _: &VmSpec) -> Result<(), EngineError> {
        unreachable!("no step here boots")
    }

    async fn restore(&self, _: &VmSpec, _: &RestoreFiles) -> Result<(), EngineError> {
        self.restores.fetch_add(1, Ordering::SeqCst);
        if self.refuses.load(Ordering::SeqCst) {
            return Err(EngineError::new(
                ErrorKind::MemoryLost,
                "restore",
                "unsupported snapshot version",
            ));
        }
        Ok(())
    }

    async fn pause(&self, (): &()) -> Result<(), EngineError> {
        Ok(())
    }

    async fn resume(&self, (): &()) -> Result<(), EngineError> {
        self.resumes.fetch_add(1, Ordering::SeqCst);
        let failure = self.resume_failures.lock().unwrap().pop_front();
        failure.map_or(Ok(()), |kind| {
            Err(EngineError::new(kind, "resume", "refused"))
        })
    }

    async fn compress(&self, (): &(), _: &CancellationToken) -> Result<Completion, EngineError> {
        unreachable!("no step here compresses")
    }

    async fn snapshot(
        &self,
        (): &(),
        _: &SnapshotFiles,
        _: SnapshotKind,
    ) -> Result<(), EngineError> {
        unreachable!("no step here snapshots")
    }

    async fn stop(&self, (): ()) -> Result<(), EngineError> {
        self.stops.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn adopt(&self, _: &VmSpec) -> Result<Option<((), Found)>, EngineError> {
        unreachable!("no step here adopts")
    }

    async fn hold(&self, (): &(), _: std::os::fd::OwnedFd) -> Result<(), EngineError> {
        Ok(())
    }

    async fn held(&self, (): &()) -> Result<Option<std::os::fd::OwnedFd>, EngineError> {
        Ok(None)
    }

    async fn clean_up(&self, _: &VmSpec) -> Result<(), EngineError> {
        Ok(())
    }

    fn resident_bytes(&self, (): &()) -> Result<u64, EngineError> {
        Ok(0)
    }

    fn cpu_time(&self, (): &()) -> Result<Duration, EngineError> {
        Ok(Duration::ZERO)
    }

    fn io_bytes(&self, (): &()) -> Result<u64, EngineError> {
        Ok(0)
    }

    fn exited(&self, (): &()) -> impl Future<Output = ()> + Send + 'static {
        let mut ended = self.ended.subscribe();
        async move {
            // The fake outlives every test's VM, so the sender stays.
            let _ = ended.wait_for(|ended| *ended).await;
        }
    }
}

/// One sandbox under a fresh state root, with a disk in its jail.
struct Sandbox {
    root: tempfile::TempDir,
    records: Arc<Records>,
    engine: Arc<Counting>,
    paths: Paths,
    id: Id,
}

impl Sandbox {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let (records, _) = Records::open(root.path().into(), Duration::ZERO, None)
            .await
            .unwrap();
        let id = Id(SandboxId(1));
        let paths = Paths::new(root.path(), id);
        fs::create_dir_all(&paths.jail).unwrap();
        fs::write(&paths.disk, "disk").unwrap();
        Self {
            root,
            records: Arc::new(records),
            engine: Arc::default(),
            paths,
            id,
        }
    }

    /// Inserts the sandbox's record and applies `change` to it.
    async fn record(&self, change: Change) -> Record {
        let config = SandboxConfig {
            image: None,
            vcpus: 1,
            memory_mib: 256,
            memory_request_mib: None,
            cpu_request_millis: None,
            sleep: SleepConfig::default(),
            link: None,
        };
        let allocation = Allocation {
            uid: 1_000_000,
            gid: 1_000_000,
            link: None,
            disk_bytes: None,
        };
        let created = self
            .records
            .insert(Record::new(self.id, 0, allocation, config))
            .await
            .unwrap();
        self.records
            .commit(self.id, created.fence(), change)
            .await
            .unwrap()
    }

    /// A step on the sandbox as `record` has it, with its VM if `live`.
    fn job<S>(&self, store: S, record: Record, live: bool) -> Job<Counting, S> {
        let images = crate::layout::Images {
            kernel: self.root.path().join("vmlinux"),
            boot_args: String::new(),
            first_uid: 1_000_000,
            network: None,
        };
        Job {
            engine: Arc::clone(&self.engine),
            store: Arc::new(store),
            records: Arc::clone(&self.records),
            id: record.id,
            spec: vm_spec(&record, &self.paths, &images),
            record,
            paths: self.paths.clone(),
            cancel: CancellationToken::new(),
            live: live.then(|| Live {
                vm: (),
                incarnation: 1,
                stopping: Arc::default(),
                memory: LiveMemory::adopted(DiskWatch::fresh(&self.paths).unwrap()),
            }),
            restore_notice_port: None,
            disk_image: self.root.path().join("base.ext4"),
            kernel: self.root.path().join("vmlinux"),
            #[cfg(target_os = "linux")]
            fetcher: None,
            pager: crate::PagerConfig::new(self.root.path().join("no-pager")),
            launches: 0,
            link_clock: None,
            untouched: false,
            unthrottle: None,
            meter: None,
            last_used_ms: 1_700_000_000_000,
        }
    }

    /// Makes every write of the record land without becoming durable.
    fn fail_record_writes(&self) {
        let failing = [
            (self.paths.record.clone(), "renamed"),
            (self.paths.record.clone(), "parent"),
        ];
        FAILPOINTS.lock().unwrap().extend(failing);
    }

    fn heal_record_writes(&self) {
        FAILPOINTS
            .lock()
            .unwrap()
            .retain(|(path, _)| path != &self.paths.record);
    }

    /// The agent stops: every handle on the state root goes, and a new
    /// agent opens it.
    async fn restart(self) -> Self {
        let Self {
            root,
            records,
            engine,
            paths,
            id,
        } = self;
        drop(records);
        // Record work runs on to its end on a blocking thread, holding the
        // root's lock until it does.
        let mut tries = 0;
        let records = loop {
            match Records::open(root.path().into(), Duration::ZERO, None).await {
                Ok((records, _)) => break records,
                Err(StateError::Locked(_)) if tries < 100 => {
                    tries += 1;
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(error) => panic!("{error}"),
            }
        };
        Self {
            root,
            records: Arc::new(records),
            engine,
            paths,
            id,
        }
    }
}

/// Lets a job run until it is waiting, then reports that it still is.
async fn still_waiting<T>(job: &JoinHandle<T>) -> bool {
    tokio::time::sleep(Duration::from_millis(300)).await;
    !job.is_finished()
}

async fn finished<V>(job: JoinHandle<Ran<V>>) -> Ran<V> {
    tokio::time::timeout(Duration::from_secs(10), job)
        .await
        .expect("the step did not finish once its record could be settled")
        .unwrap()
}

/// A resume first stops the record vouching for the saved image. If
/// that write lands but cannot be made durable, a crash could bring
/// the old record back: the guest must not run until it is settled, and
/// the step waits for that with the saved image and the VM as they are.
#[tokio::test(flavor = "multi_thread")]
async fn a_resume_waits_for_its_invalidation_to_be_durable() {
    let sandbox = Sandbox::new().await;
    let saved = sandbox.record(Change::new().image(true)).await;
    sandbox.fail_record_writes();

    let job = tokio::spawn(sandbox.job(NoStore, saved, true).run(Step::Resume));
    assert!(
        still_waiting(&job).await,
        "an unsettled write ended the step"
    );
    assert_eq!(
        Counting::count(&sandbox.engine.resumes),
        0,
        "the guest ran while its record could still be taken back"
    );

    sandbox.heal_record_writes();
    let ran = finished(job).await;
    assert_eq!(ran.outcome, Outcome::Done);
    assert_eq!(Counting::count(&sandbox.engine.resumes), 1);
    assert_eq!(Counting::count(&sandbox.engine.stops), 0);
    let sandbox = sandbox.restart().await;
    assert!(!sandbox.records.settle(sandbox.id).await.unwrap().image);
}

/// An agent that restarts after a record write landed but was not made
/// durable must not act on what it reads until the write is settled:
/// the write may still be lost, or may already have been.
#[tokio::test(flavor = "multi_thread")]
async fn a_restarted_agent_acts_on_no_record_it_could_not_settle() {
    for lost in [false, true] {
        let sandbox = Sandbox::new().await;
        let saved = sandbox.record(Change::new().image(true)).await;
        sandbox.fail_record_writes();
        let job = tokio::spawn(sandbox.job(NoStore, saved.clone(), true).run(Step::Resume));
        assert!(still_waiting(&job).await);
        // The scenario starts once the step's write has landed; on a busy
        // host that can take longer than the wait above.
        let landed = tokio::time::timeout(Duration::from_secs(10), async {
            while fs::read(&sandbox.paths.record)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Record>(&bytes).ok())
                .is_none_or(|record| record.image)
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        });
        landed.await.expect("the step's record write landed");
        job.abort();
        let _ = job.await;
        // Record work runs on to its end on a blocking thread after the
        // step is stopped; wait for it, so the power loss below comes after
        // every write and nothing replaces the file it leaves.
        assert!(sandbox.records.settle(sandbox.id).await.is_err());
        if lost {
            // The host lost power before the rename reached the disk.
            let mut bytes = serde_json::to_vec(&saved).unwrap();
            bytes.push(b'\n');
            fs::write(&sandbox.paths.record, bytes).unwrap();
        }
        let sandbox = sandbox.restart().await;

        let found = sandbox.records.get(sandbox.id).unwrap();
        assert_eq!(found.image, lost, "the file is read as it is");
        assert!(
            sandbox.records.settle(sandbox.id).await.is_err(),
            "a record read after a restart was taken as durable"
        );
        let ran = sandbox.job(NoStore, found, true).run(Step::Resume).await;
        assert_eq!(ran.outcome, Outcome::Failed(Failure::Transient));
        assert_eq!(
            Counting::count(&sandbox.engine.resumes),
            0,
            "the guest ran on a record a crash could still take back"
        );

        sandbox.heal_record_writes();
        let durable = sandbox.records.settle(sandbox.id).await.unwrap();
        assert_eq!(durable.image, lost);
        let ran = sandbox.job(NoStore, durable, true).run(Step::Resume).await;
        assert_eq!(ran.outcome, Outcome::Done);
        assert_eq!(Counting::count(&sandbox.engine.resumes), 1);
        assert!(!sandbox.records.settle(sandbox.id).await.unwrap().image);
    }
}

/// A restore whose record cannot settle keeps the image it restored from
/// and the VM it started until the record does, then finishes.
#[tokio::test(flavor = "multi_thread")]
async fn an_uncertain_restore_keeps_the_image_and_the_vm() {
    let sandbox = Sandbox::new().await;
    let saved = sandbox.record(Change::new().image(true)).await;
    let (state, memory) = (
        sandbox.paths.dir.join("state"),
        sandbox.paths.dir.join("memory"),
    );
    fs::write(&state, "state").unwrap();
    fs::write(&memory, vec![7; 8192]).unwrap();
    let images = images_of(&sandbox.paths);
    images
        .publish(Parts::Whole {
            state: &state,
            memory: &memory,
            len: 8192,
        })
        .unwrap();
    sandbox.fail_record_writes();

    let job = tokio::spawn(sandbox.job(NoStore, saved, false).run(Step::Restore));
    assert!(
        still_waiting(&job).await,
        "an unsettled write ended the restore"
    );
    assert_eq!(Counting::count(&sandbox.engine.restores), 1);
    assert_eq!(
        Counting::count(&sandbox.engine.stops),
        0,
        "the restored VM was stopped"
    );
    assert_eq!(
        Counting::count(&sandbox.engine.resumes),
        0,
        "the guest ran unsettled"
    );
    assert!(
        images.current_verified().unwrap().is_some(),
        "the image was dropped"
    );

    sandbox.heal_record_writes();
    let ran = finished(job).await;
    assert_eq!(ran.outcome, Outcome::Done);
    assert!(matches!(ran.after, After::New(..)));
    assert_eq!(Counting::count(&sandbox.engine.resumes), 1);
    assert_eq!(Counting::count(&sandbox.engine.stops), 0);
    let sandbox = sandbox.restart().await;
    let durable = sandbox.records.settle(sandbox.id).await.unwrap();
    assert!(
        !durable.image,
        "the record still vouches for the image the guest left"
    );
}

/// An eviction whose record cannot settle deletes nothing until it does:
/// the local copy may still be the one the record relies on.
#[tokio::test(flavor = "multi_thread")]
async fn an_uncertain_eviction_keeps_the_local_copy() {
    let sandbox = Sandbox::new().await;
    let store = sandbox.root.path().join("store");
    let idle = sandbox.record(Change::new()).await;
    let before = crate::state::unix_ms_now();
    let ran = sandbox
        .job(Directory::new(&store), idle, false)
        .run(Step::Archive)
        .await;
    assert_eq!(ran.outcome, Outcome::Done);
    let archived = sandbox.records.get(sandbox.id).unwrap();
    assert!(archived.archived);
    assert!(
        archived
            .backed_up_ms
            .is_some_and(|at| (before..=crate::state::unix_ms_now()).contains(&at)),
        "an archive records when its copy was made: {:?}",
        archived.backed_up_ms
    );
    sandbox.fail_record_writes();

    let job = tokio::spawn(
        sandbox
            .job(Directory::new(&store), archived, false)
            .run(Step::Evict),
    );
    assert!(
        still_waiting(&job).await,
        "an unsettled write ended the eviction"
    );
    assert!(sandbox.paths.disk.exists(), "the local disk went unsettled");

    sandbox.heal_record_writes();
    let ran = finished(job).await;
    assert_eq!(ran.outcome, Outcome::Done);
    assert!(!sandbox.paths.disk.exists());
    let sandbox = sandbox.restart().await;
    let durable = sandbox.records.settle(sandbox.id).await.unwrap();
    assert_eq!(durable.disk, Disk::Remote);
}

/// Each archive takes a save number of its own, recorded before the store
/// sees it. Once a later owner claims the stored copy, the next archive
/// finds the sandbox no longer this host's: its removal begins, and leaves
/// the copy as the new owner holds it.
#[tokio::test(flavor = "multi_thread")]
async fn an_archive_a_later_owner_fenced_hands_the_sandbox_off() {
    use compute_storage::store::ChunkStore;
    use object_store::memory::InMemory;
    use object_store::path::Path as ObjectPath;

    use crate::chunked::Chunked;
    use crate::store::{Owned, OwnerEpoch, Stamp, Store as _};

    let sandbox = Sandbox::new().await;
    let chunks = ChunkStore::new(Arc::new(InMemory::new()), ObjectPath::from("t"));
    let idle = sandbox.record(Change::new()).await;
    let ran = Box::pin(
        sandbox
            .job(Chunked::new(chunks.clone()), idle, false)
            .run(Step::Archive),
    )
    .await;
    assert_eq!(ran.outcome, Outcome::Done);
    let archived = sandbox.records.get(sandbox.id).unwrap();
    assert_eq!((archived.saves, archived.archived), (1, true));
    let name = sandbox.id.to_string();
    let first = Stamp {
        epoch: OwnerEpoch::FIRST,
        save: 1,
    };
    assert_eq!(
        chunks.get_owned_pointer(&name).await.unwrap().unwrap().0,
        first
    );

    let ran = Box::pin(
        sandbox
            .job(Chunked::new(chunks.clone()), archived, false)
            .run(Step::Archive),
    )
    .await;
    assert_eq!(ran.outcome, Outcome::Done);
    let again = sandbox.records.get(sandbox.id).unwrap();
    assert_eq!(again.saves, 2, "every archive has its own number");

    let next = Chunked::new(chunks.clone());
    let claimed = next.claim(sandbox.id, OwnerEpoch(2)).await.unwrap();
    assert!(
        matches!(claimed, Owned::Done(Some(ref copy)) if copy.save == 2),
        "{claimed:?}"
    );
    let held = chunks.get_owned_pointer(&name).await.unwrap();
    let ran = Box::pin(
        sandbox
            .job(Chunked::new(chunks.clone()), again, false)
            .run(Step::Archive),
    )
    .await;
    assert_eq!(ran.outcome, Outcome::Failed(Failure::Fatal));
    let dropped = sandbox.records.get(sandbox.id).unwrap();
    assert!(dropped.removing && dropped.handed_off, "{dropped:?}");
    assert_eq!(
        chunks.get_owned_pointer(&name).await.unwrap(),
        held,
        "the copy stays"
    );
}

/// A refusal alone proves nothing about a sound image: the host may have
/// run short of memory, or the VMM been killed while loading. So an image
/// is kept for a retry when the engine reads its runtime, made it under
/// another processor, or cannot tell (an image labelled before runtimes
/// named their snapshot format, say). Only an image the engine proves no
/// VMM of its reads is given up, and the sandbox wakes from its disk
/// instead of retrying forever.
#[tokio::test(flavor = "multi_thread")]
async fn only_an_image_no_vmm_here_reads_is_given_up() {
    const NOW: &str = "Firecracker snapshot format v13.0.0 on a new processor";
    const OLD: &str = "Firecracker snapshot format v12.0.0 on a new processor";
    const ELSEWHERE: &str = "Firecracker snapshot format v13.0.0 on another processor";
    const LEGACY: &str = "Firecracker v1.13.1 on a new processor";
    let unreadable = || Some(Readable::No("format v12 is not read here".into()));
    for (made_under, runtime, reads, kept) in [
        (NOW, NOW, None, true),
        (OLD, NOW, unreadable(), false),
        (OLD, NOW, Some(Readable::Yes), true),
        (ELSEWHERE, NOW, Some(Readable::Yes), true),
        (LEGACY, NOW, Some(Readable::Unknown), true),
        (OLD, "", None, true),
    ] {
        let mut sandbox = Sandbox::new().await;
        sandbox.engine = Arc::new(Counting {
            runtime: runtime.to_owned(),
            reads,
            refuses: AtomicBool::new(true),
            ..Counting::default()
        });
        let saved = sandbox.record(Change::new().image(true)).await;
        let (state, memory) = (
            sandbox.paths.dir.join("state"),
            sandbox.paths.dir.join("memory"),
        );
        fs::write(&state, "state").unwrap();
        fs::write(&memory, vec![7; 8192]).unwrap();
        let images = images_of(&sandbox.paths);
        images
            .publish_made_by(
                Parts::Whole {
                    state: &state,
                    memory: &memory,
                    len: 8192,
                },
                Some(made_under),
            )
            .unwrap();

        let ran = sandbox.job(NoStore, saved, false).run(Step::Restore).await;
        assert_eq!(Counting::count(&sandbox.engine.restores), 1);
        let durable = sandbox.records.settle(sandbox.id).await.unwrap();
        if kept {
            assert_eq!(ran.outcome, Outcome::Failed(Failure::Transient));
            assert!(durable.image, "a sound image of this runtime was given up");
        } else {
            assert_eq!(ran.outcome, Outcome::Failed(Failure::MemoryLost));
            assert!(!durable.image, "the sandbox would retry the image forever");
        }
    }
}

/// A step tells the sandbox's agent-link streams before each VM process it
/// starts, even one that fails to: the guest is a new one, which has yet
/// to prove it runs (see `crate::resume`).
#[tokio::test(flavor = "multi_thread")]
async fn a_restore_tells_the_streams_before_it_starts_a_vm_process() {
    const RUNTIME: &str = "Firecracker snapshot format v13.0.0 on a new processor";
    let mut sandbox = Sandbox::new().await;
    sandbox.engine = Arc::new(Counting {
        runtime: RUNTIME.to_owned(),
        refuses: AtomicBool::new(true),
        ..Counting::default()
    });
    let saved = sandbox.record(Change::new().image(true)).await;
    let (state, memory) = (
        sandbox.paths.dir.join("state"),
        sandbox.paths.dir.join("memory"),
    );
    fs::write(&state, "state").unwrap();
    fs::write(&memory, vec![7; 8192]).unwrap();
    images_of(&sandbox.paths)
        .publish_made_by(
            Parts::Whole {
                state: &state,
                memory: &memory,
                len: 8192,
            },
            Some(RUNTIME),
        )
        .unwrap();
    let clock = crate::resume::RunClock::default();
    let mut job = sandbox.job(NoStore, saved, false);
    job.link_clock = Some(clock.clone());
    let ran = job.run(Step::Restore).await;
    assert_eq!(ran.outcome, Outcome::Failed(Failure::Transient));
    assert_eq!(Counting::count(&sandbox.engine.restores), 1);
    assert_eq!(clock.launches(), 1);
}

/// A save of a VM whose memory is still arriving waits for it, but a wake
/// or a removal meanwhile does not have to: cancelling the save ends it at
/// once with nothing changed, however long the memory takes.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_save_waiting_for_memory_that_does_not_arrive_can_be_cancelled() {
    let sandbox = Sandbox::new().await;
    let record = sandbox.record(Change::new()).await;
    let mut job = sandbox.job(NoStore, record, true);
    // A pager that never listens: the memory it serves never completes.
    let paging = Paging::start(
        sandbox.root.path().join("silent-pager.sock"),
        "1".into(),
        ((0, 0), 1 << 20),
        None,
        Vec::new(),
    );
    job.live.as_mut().unwrap().memory.paging = Some(paging);
    let cancel = job.cancel.clone();
    let save = tokio::spawn(async move { job.run(Step::Save).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!save.is_finished(), "the save did not wait for the memory");
    cancel.cancel();
    let ran = tokio::time::timeout(Duration::from_secs(5), save)
        .await
        .expect("the cancelled save ends")
        .unwrap();
    assert_eq!(ran.outcome, Outcome::Cancelled);
    let durable = sandbox.records.settle(sandbox.id).await.unwrap();
    assert!(!durable.image);
}

/// A checkpoint cancelled before it began, or while it waits for its
/// memory, reports that it wrote nothing, so the core books nothing for
/// it; a step that began its work, such as a save waiting for its memory,
/// may have written.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_checkpoint_cancelled_before_it_captured_anything_reports_it_wrote_nothing() {
    let sandbox = Sandbox::new().await;
    let record = sandbox.record(Change::new()).await;
    let job = sandbox.job(NoStore, record.clone(), true);
    job.cancel.cancel();
    let ran = job.run(Step::Checkpoint).await;
    assert_eq!(ran.outcome, Outcome::Cancelled);
    assert!(!ran.report.wrote, "cancelled before it began");

    let silent = |name: &str| {
        Paging::start(
            sandbox.root.path().join(name),
            "1".into(),
            ((0, 0), 1 << 20),
            None,
            Vec::new(),
        )
    };
    for (step, wrote) in [(Step::Checkpoint, false), (Step::Save, true)] {
        let mut job = sandbox.job(NoStore, record.clone(), true);
        // A pager that never listens: the memory it serves never completes.
        job.live.as_mut().unwrap().memory.paging = Some(silent(&format!("{step:?}.sock")));
        let cancel = job.cancel.clone();
        let running = tokio::spawn(async move { job.run(step).await });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            !running.is_finished(),
            "{step:?} did not wait for the memory"
        );
        cancel.cancel();
        let ran = tokio::time::timeout(Duration::from_secs(5), running)
            .await
            .expect("the cancelled step ends")
            .unwrap();
        assert_eq!(ran.outcome, Outcome::Cancelled, "{step:?}");
        assert_eq!(ran.report.wrote, wrote, "{step:?}");
    }
}

/// A failed disk check, or one an agent never finished, keeps every later
/// snapshot of the VM untrusted, even by a new agent; only a new VM starts
/// clean. A new agent watches through the description the engine kept,
/// and through nothing else.
#[tokio::test]
async fn a_disk_check_that_failed_or_never_ended_outlives_the_agent() {
    let sandbox = Sandbox::new().await;
    let paths = &sandbox.paths;
    let marker = live::check_marker(paths);

    let watch = DiskWatch::fresh(paths).unwrap();
    watch.begin().unwrap();
    watch.sync().unwrap();
    assert!(!marker.exists(), "a clean check left its marker");
    assert!(!DiskWatch::adopt(paths, watch.description().unwrap()).failed());
    assert!(
        DiskWatch::adopt(paths, None).failed(),
        "a disk opened afresh was trusted"
    );
    fs::write(paths.dir.join("other"), "other").unwrap();
    let other = fs::File::open(paths.dir.join("other")).unwrap();
    assert!(
        DiskWatch::adopt(paths, Some(other.into())).failed(),
        "another file was taken for the disk"
    );

    // An agent stops part way through a check.
    watch.begin().unwrap();
    let kept = watch.description().unwrap();
    drop(watch);
    assert!(
        DiskWatch::adopt(paths, kept).failed(),
        "an unfinished check was forgotten"
    );

    let watch = DiskWatch::fresh(paths).unwrap();
    assert!(!marker.exists(), "a new VM inherited an old check");
    watch.begin().unwrap();
    FAILPOINTS
        .lock()
        .unwrap()
        .push((paths.disk.clone(), "sync"));
    assert!(watch.sync().is_err());
    FAILPOINTS
        .lock()
        .unwrap()
        .retain(|(path, _)| path != &paths.disk);
    assert!(watch.failed());
    assert!(watch.begin().is_err(), "a failed watch started a check");
    assert!(watch.sync().is_err(), "a failed watch vouched for the disk");
    assert!(marker.exists());
    let kept = watch.description().unwrap();
    drop(watch);
    let adopted = DiskWatch::adopt(paths, kept);
    assert!(adopted.failed(), "the failure was lost with the agent");
    assert!(adopted.sync().is_err());

    // A disk the new agent cannot open is not vouched for either.
    fs::remove_file(&marker).unwrap();
    let kept = DiskWatch::fresh(paths).unwrap().description().unwrap();
    fs::rename(&paths.disk, paths.dir.join("moved")).unwrap();
    std::os::unix::fs::symlink(paths.dir.join("moved"), &paths.disk).unwrap();
    assert!(
        DiskWatch::adopt(paths, kept).failed(),
        "a linked disk was watched"
    );
}

/// A VM whose disk no one can vouch for, here because an agent stopped
/// part way through a check, is never saved, yet keeps running: the save
/// fails as unsavable and leaves the VM and its record as they were.
#[tokio::test]
async fn a_vm_whose_disk_cannot_be_vouched_for_is_kept_unsaved() {
    let sandbox = Sandbox::new().await;
    let record = sandbox.record(Change::new()).await;
    let mut job = sandbox.job(NoStore, record, true);
    let kept = DiskWatch::fresh(&sandbox.paths)
        .unwrap()
        .description()
        .unwrap();
    fs::write(live::check_marker(&sandbox.paths), "").unwrap();
    job.live.as_mut().unwrap().memory = LiveMemory::adopted(DiskWatch::adopt(&sandbox.paths, kept));

    let ran = job.run(Step::Save).await;
    assert_eq!(ran.outcome, Outcome::Failed(Failure::Unsavable));
    assert!(matches!(ran.after, After::Kept(..)), "the VM was let go");
    assert_eq!(Counting::count(&sandbox.engine.stops), 0);
    assert!(
        live::check_marker(&sandbox.paths).exists(),
        "the marker went"
    );
    let durable = sandbox.records.settle(sandbox.id).await.unwrap();
    assert!(!durable.image, "the record vouches for an image");
}

/// A checkpoint resumes the VM it paused through failures that changed
/// nothing, even once cancelled, since its sandbox is in use, for as long
/// as the VM lives; a failure that may have changed something, or the VM
/// ending, ends the tries.
#[tokio::test]
async fn a_checkpoint_resumes_its_paused_vm_through_transient_failures() {
    let sandbox = Sandbox::new().await;
    let record = sandbox.record(Change::new()).await;
    let job = sandbox.job(NoStore, record, true);
    job.cancel.cancel();
    let fail = |kinds: &[ErrorKind]| {
        let mut failures = sandbox.engine.resume_failures.lock().unwrap();
        failures.clear();
        failures.extend(kinds);
    };

    fail(&[ErrorKind::Transient; 3]);
    job.resume_paused(&()).await.unwrap();
    assert_eq!(Counting::count(&sandbox.engine.resumes), 4);

    fail(&[
        ErrorKind::Transient,
        ErrorKind::MemoryLost,
        ErrorKind::Transient,
    ]);
    let error = job.resume_paused(&()).await.unwrap_err();
    assert_eq!(error.kind, ErrorKind::MemoryLost);
    assert_eq!(Counting::count(&sandbox.engine.resumes), 6);

    // A VMM that goes on answering that nothing changed is tried for as
    // long as the VM lives, well past the point where that is an error,
    // about once a second once the waits have grown.
    tokio::time::pause();
    fail(&[ErrorKind::Transient; 1_000]);
    let begin = tokio::time::Instant::now();
    let ends = async {
        tokio::time::sleep(Duration::from_secs(120)).await;
        sandbox.engine.ended.send_replace(true);
    };
    let (resumed, ()) = tokio::join!(job.resume_paused(&()), ends);
    // Once the VM ends, its memory is gone.
    assert_eq!(resumed.unwrap_err().kind, ErrorKind::MemoryLost);
    assert!(begin.elapsed() >= Duration::from_secs(120));
    let tries = Counting::count(&sandbox.engine.resumes) - 6;
    assert!((115..135).contains(&tries), "{tries} tries");

    // An ended VM is not asked to resume at all.
    let error = job.resume_paused(&()).await.unwrap_err();
    assert_eq!(error.kind, ErrorKind::MemoryLost);
    assert_eq!(Counting::count(&sandbox.engine.resumes), tries + 6);
}

fn written(jail: &Path) -> SnapshotFiles {
    SnapshotFiles {
        state: jail.join("save.state"),
        memory: jail.join("save.mem"),
    }
}

#[test]
fn snapshot_outputs_must_be_plain_files_of_their_own() {
    let dir = tempfile::tempdir().unwrap();
    let (jail, scratch) = (dir.path().join("jail"), dir.path().join("saving"));
    fs::create_dir(&jail).unwrap();
    let secret = dir.path().join("secret");
    fs::write(&secret, "host only").unwrap();
    let files = written(&jail);

    fs::write(&files.state, "state").unwrap();
    fs::write(&files.memory, "memory").unwrap();
    let taken = take_written(&files, &scratch).unwrap();
    assert_eq!(fs::read_to_string(&taken.memory).unwrap(), "memory");
    assert!(!files.memory.exists());

    // A link to a host file, by name or by inode, is refused.
    fs::write(&files.state, "state").unwrap();
    std::os::unix::fs::symlink(&secret, &files.memory).unwrap();
    assert!(take_written(&files, &scratch).is_err());
    // The refused link was moved out of the jail with the rest.
    assert!(fs::symlink_metadata(&files.memory).is_err());
    fs::hard_link(&secret, &files.memory).unwrap();
    fs::write(&files.state, "state").unwrap();
    assert!(take_written(&files, &scratch).is_err());
    assert_eq!(fs::read_to_string(&secret).unwrap(), "host only");
}
