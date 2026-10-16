use super::*;
use std::sync::atomic::AtomicUsize;

use compute_core::SandboxId;
use compute_engine::Found;

use crate::layout::tests::FAILPOINTS;
use crate::layout::{Images, vm_spec};
use crate::protocol::{SandboxConfig, SleepConfig};
use crate::state::Allocation;
use crate::store::NoStore;

/// A VMM whose one VM is paused and resumes when asked.
#[derive(Debug, Default)]
struct Paused {
    resumes: AtomicUsize,
}

// A fake answers at once; the trait is async for the real VMMs.
#[allow(clippy::unused_async_trait_impl)]
impl Engine for Paused {
    type Vm = ();

    fn memory_profile(&self) -> MemoryProfile {
        MemoryProfile::bare_metal()
    }

    async fn boot(&self, _: &VmSpec) -> Result<(), EngineError> {
        unreachable!("only resumes are asked for")
    }

    async fn restore(&self, _: &VmSpec, _: &RestoreFiles) -> Result<(), EngineError> {
        unreachable!("only resumes are asked for")
    }

    async fn pause(&self, (): &()) -> Result<(), EngineError> {
        Ok(())
    }

    async fn resume(&self, (): &()) -> Result<(), EngineError> {
        self.resumes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn compress(&self, (): &(), _: &CancellationToken) -> Result<Completion, EngineError> {
        unreachable!("only resumes are asked for")
    }

    async fn snapshot(
        &self,
        (): &(),
        _: &SnapshotFiles,
        _: SnapshotKind,
    ) -> Result<(), EngineError> {
        unreachable!("only resumes are asked for")
    }

    async fn stop(&self, (): ()) -> Result<(), EngineError> {
        Ok(())
    }

    async fn adopt(&self, _: &VmSpec) -> Result<Option<((), Found)>, EngineError> {
        unreachable!("only resumes are asked for")
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

    fn exited(&self, (): &()) -> impl Future<Output = ()> + Send + 'static {
        std::future::pending()
    }
}

/// A resume step on the paused VM of `record`'s sandbox.
fn resume_job(
    engine: &Arc<Paused>,
    records: &Arc<Records>,
    root: &Path,
    record: Record,
) -> Job<Paused, NoStore> {
    let paths = Paths::new(root, record.id);
    let images = Images {
        kernel: root.join("vmlinux"),
        boot_args: String::new(),
        first_uid: 1_000_000,
        network: None,
    };
    Job {
        engine: Arc::clone(engine),
        store: Arc::new(NoStore),
        records: Arc::clone(records),
        id: record.id,
        spec: vm_spec(&record, &paths, &images),
        record,
        paths,
        cancel: CancellationToken::new(),
        live: Some(Live {
            vm: (),
            incarnation: 1,
            stopping: Arc::default(),
            memory: LiveMemory::adopted(None),
        }),
        restore_notice_port: None,
        base_image: root.join("base.ext4"),
        kernel: root.join("vmlinux"),
        #[cfg(target_os = "linux")]
        fetcher: None,
        launches: 0,
    }
}

/// A resume first stops the record vouching for the saved image. If
/// that write lands but cannot be made durable, a crash could bring
/// the old record back: the guest must not run until it is settled,
/// neither in that step nor in a retry that sees the newer record.
#[tokio::test]
async fn a_resume_never_runs_on_an_invalidation_that_is_not_durable() {
    let root = tempfile::tempdir().unwrap();
    let (records, _) = Records::open(root.path().into(), Duration::ZERO, None)
        .await
        .unwrap();
    let records = Arc::new(records);
    let id = Id(SandboxId(1));
    let paths = Paths::new(root.path(), id);
    fs::create_dir_all(&paths.dir).unwrap();
    let config = SandboxConfig {
        vcpus: 1,
        memory_mib: 256,
        sleep: SleepConfig::default(),
    };
    let allocation = Allocation {
        uid: 1_000_000,
        gid: 1_000_000,
        link: None,
    };
    let created = records
        .insert(Record::new(id, 0, allocation, config))
        .await
        .unwrap();
    let saved = records
        .commit(id, created.fence(), Change::new().image(true))
        .await
        .unwrap();
    let engine = Arc::new(Paused::default());
    let failing = [
        (paths.record.clone(), "renamed"),
        (paths.record.clone(), "parent"),
    ];
    FAILPOINTS.lock().unwrap().extend(failing);

    let ran = resume_job(&engine, &records, root.path(), saved)
        .run(Step::Resume)
        .await;
    assert_eq!(ran.outcome, Outcome::Failed(Failure::Untrusted));
    let retry = records.get(id).unwrap();
    assert!(!retry.image, "the cache shows the write that landed");
    let ran = resume_job(&engine, &records, root.path(), retry.clone())
        .run(Step::Resume)
        .await;
    assert_eq!(ran.outcome, Outcome::Failed(Failure::Transient));
    assert_eq!(
        engine.resumes.load(Ordering::SeqCst),
        0,
        "the guest ran while its record could still be taken back"
    );

    FAILPOINTS
        .lock()
        .unwrap()
        .retain(|(path, _)| path != &paths.record);
    let ran = resume_job(&engine, &records, root.path(), retry)
        .run(Step::Resume)
        .await;
    assert_eq!(ran.outcome, Outcome::Done);
    assert_eq!(engine.resumes.load(Ordering::SeqCst), 1);
    drop(Arc::into_inner(records).unwrap());
    let (records, _) = Records::open(root.path().into(), Duration::ZERO, None)
        .await
        .unwrap();
    assert!(
        !records.get(id).unwrap().image,
        "after a crash the record vouches for an image the guest moved past"
    );
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

#[test]
fn syncing_a_jailed_file_follows_no_link_and_opens_no_pipe() {
    let dir = tempfile::tempdir().unwrap();
    let disk = dir.path().join("disk.ext4");
    fs::write(&disk, "disk").unwrap();
    sync_jailed(&disk).unwrap();

    let link = dir.path().join("link");
    std::os::unix::fs::symlink(&disk, &link).unwrap();
    assert!(sync_jailed(&link).is_err());

    let pipe = dir.path().join("pipe");
    rustix::fs::mkfifoat(
        rustix::fs::CWD,
        &pipe,
        rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
    )
    .unwrap();
    assert!(sync_jailed(&pipe).is_err(), "a pipe must not block or pass");
}
