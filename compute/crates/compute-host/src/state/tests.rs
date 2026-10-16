use std::collections::BTreeMap;

use super::*;
use crate::protocol::SleepConfig;

/// splitmix64: small, fast and good enough to drive simulations.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
}

fn config() -> SandboxConfig {
    SandboxConfig {
        vcpus: 1,
        memory_mib: 256,
        sleep: SleepConfig::default(),
    }
}

fn id(n: u128) -> Id {
    Id(SandboxId(n))
}

fn allocation() -> Allocation {
    Allocation {
        uid: 4_000_000,
        gid: 4_000_000,
        link: None,
    }
}

fn random_change(rng: &mut Rng) -> Change {
    let mut change = Change::new();
    if rng.chance(30) {
        change = change.disk(if rng.chance(50) {
            Disk::Local
        } else {
            Disk::Remote
        });
    }
    if rng.chance(50) {
        change = change.image(rng.chance(50));
    }
    if rng.chance(40) {
        change = change.archived(rng.chance(50));
    }
    if rng.chance(20) {
        change = change.execution();
    }
    change
}

/// The current fence, or one wrong in a way a stale operation's is.
fn random_fence(rng: &mut Rng, current: Fence, seen: &[Fence]) -> Fence {
    match rng.below(10) {
        0..=5 => current,
        6 | 7 if !seen.is_empty() => seen[usize::try_from(rng.below(seen.len() as u64)).unwrap()],
        8 => Fence {
            generation: current.generation + 1,
            ..current
        },
        _ => Fence {
            revision: current.revision + 1 + rng.below(3),
            ..current
        },
    }
}

/// The decision core against a plain model, over many seeds.
#[test]
fn writes_apply_only_against_the_current_fence() {
    for seed in 0..2_000 {
        let mut rng = Rng(seed);
        let sandbox = id(7);
        let mut model = Record::new(sandbox, 3, allocation(), config());
        let mut seen = Vec::new();
        for _ in 0..200 {
            let fence = random_fence(&mut rng, model.fence(), &seen);
            let change = random_change(&mut rng);
            let result = apply(sandbox, Some(&model), fence, change);
            if fence != model.fence() {
                assert!(
                    matches!(result, Err(StateError::Stale { found, .. }) if found == model.fence()),
                    "seed {seed}: a stale write was not refused: {result:?}"
                );
                continue;
            }
            let mut expected = model.clone();
            change.apply_to(&mut expected);
            match result.unwrap() {
                None => assert_eq!(expected, model, "seed {seed}"),
                Some(next) => {
                    assert_ne!(expected, model, "seed {seed}: a no-op was written");
                    expected.revision += 1;
                    assert_eq!(next, expected, "seed {seed}");
                    seen.push(model.fence());
                    model = next;
                }
            }
        }
    }
    let fence = Fence {
        generation: 0,
        revision: 1,
    };
    assert!(matches!(
        apply(id(1), None, fence, Change::new()),
        Err(StateError::NotFound(_))
    ));
}

#[test]
fn requests_naming_another_execution_are_refused() {
    let mut record = Record::new(id(1), 0, allocation(), config());
    record.generation = 4;
    assert!(check_generation(&record, None).is_ok());
    assert!(check_generation(&record, Some(4)).is_ok());
    assert_eq!(
        check_generation(&record, Some(3)),
        Err(StateError::Generation {
            id: id(1),
            expected: 3,
            found: 4
        })
    );
}

fn temp_root(name: &str) -> tempfile::TempDir {
    tempfile::Builder::new().prefix(name).tempdir().unwrap()
}

/// A new sandbox's record, with the directory the agent creates before
/// writing it.
fn fresh(root: &Path, n: u128, ordinal: u32) -> Record {
    fs::create_dir_all(Paths::new(root, id(n)).dir).unwrap();
    Record::new(id(n), ordinal, allocation(), config())
}

#[tokio::test]
async fn one_agent_at_a_time_owns_a_root() {
    let root = temp_root("state-lock");
    let (first, _) = Records::open(root.path().into(), Duration::ZERO, None)
        .await
        .unwrap();
    let second = Records::open(root.path().into(), Duration::from_millis(50), None).await;
    assert!(matches!(second, Err(StateError::Locked(_))), "{second:?}");
    drop(first);
    Records::open(root.path().into(), Duration::from_secs(1), None)
        .await
        .unwrap();
}

#[tokio::test]
async fn strays_and_corrupt_records_are_reported_not_loaded() {
    let root = temp_root("state-strays");
    let (records, _) = Records::open(root.path().into(), Duration::ZERO, None)
        .await
        .unwrap();
    records.insert(fresh(root.path(), 1, 0)).await.unwrap();
    assert!(matches!(
        records.insert(fresh(root.path(), 1, 1)).await,
        Err(StateError::Exists(_))
    ));
    drop(records);
    let unfinished = Paths::new(root.path(), id(2));
    fs::create_dir_all(&unfinished.dir).unwrap();
    let corrupt = Paths::new(root.path(), id(3));
    fs::create_dir_all(&corrupt.dir).unwrap();
    fs::write(&corrupt.record, b"{").unwrap();
    let (records, mut strays) = Records::open(root.path().into(), Duration::ZERO, None)
        .await
        .unwrap();
    strays.sort_by_key(|stray| stray.id);
    assert_eq!(records.all().len(), 1);
    assert_eq!(strays.len(), 2);
    assert!(strays[0].id == id(2) && strays[0].problem.is_none());
    assert!(matches!(
        strays[1].problem,
        Some(StateError::Corrupt { .. })
    ));
}

#[tokio::test]
async fn removal_is_fenced_and_frees_the_id() {
    let root = temp_root("state-remove");
    let (records, _) = Records::open(root.path().into(), Duration::ZERO, None)
        .await
        .unwrap();
    let first = records.insert(fresh(root.path(), 1, 0)).await.unwrap();
    let moved = records
        .commit(id(1), first.fence(), Change::new().execution())
        .await
        .unwrap();
    assert_eq!(moved.generation, 1);
    assert!(matches!(
        records.remove(id(1), first.fence()).await,
        Err(StateError::Stale { .. })
    ));
    records.remove(id(1), moved.fence()).await.unwrap();
    assert!(records.get(id(1)).is_none());
    assert!(!Paths::new(root.path(), id(1)).record.exists());
    assert!(matches!(
        records.commit(id(1), moved.fence(), Change::new()).await,
        Err(StateError::NotFound(_))
    ));
    // A new sandbox with the same id never reuses a generation, so a
    // late request for the old one cannot act on it, even after a
    // restart.
    let again = records.insert(fresh(root.path(), 1, 0)).await.unwrap();
    assert_eq!(again.generation, 2);
    records.remove(id(1), again.fence()).await.unwrap();
    drop(records);
    let (records, _) = Records::open(root.path().into(), Duration::ZERO, None)
        .await
        .unwrap();
    let third = records.insert(fresh(root.path(), 1, 0)).await.unwrap();
    assert_eq!(third.generation, 3);
}

/// A write that replaced the file and then failed to sync its directory
/// must not leave the cache describing the older record: the next write
/// would be decided against a version the file no longer holds.
#[tokio::test]
async fn a_write_that_fails_after_landing_leaves_the_cache_true_to_the_file() {
    let root = temp_root("state-unsure");
    let (records, _) = Records::open(root.path().into(), Duration::ZERO, None)
        .await
        .unwrap();
    let first = records.insert(fresh(root.path(), 1, 0)).await.unwrap();
    let path = Paths::new(root.path(), id(1)).record;
    crate::layout::tests::FAILPOINTS
        .lock()
        .unwrap()
        .push((path.clone(), "renamed"));
    let failed = records
        .commit(id(1), first.fence(), Change::new().image(true))
        .await;
    crate::layout::tests::FAILPOINTS
        .lock()
        .unwrap()
        .retain(|(failing, _)| failing != &path);
    assert!(matches!(failed, Err(StateError::Io(_))), "{failed:?}");
    let cached = records.get(id(1)).unwrap();
    assert!(cached.image, "the cache lost a write the file holds");
    assert_eq!(cached, read(&path, id(1)).unwrap().unwrap());
    // Whoever still holds the old version is refused.
    assert!(matches!(
        records
            .commit(id(1), first.fence(), Change::new().image(false))
            .await,
        Err(StateError::Stale { .. })
    ));
    records
        .commit(id(1), cached.fence(), Change::new().image(false))
        .await
        .unwrap();
}

/// Live records may have used generations past the file's floor.
/// Restarting, then removing such a record, must still keep its
/// generations from ever being used again, across another restart.
#[tokio::test]
async fn the_generation_floor_survives_a_restart_before_a_removal() {
    let root = temp_root("state-floor");
    let (records, _) = Records::open(root.path().into(), Duration::ZERO, None)
        .await
        .unwrap();
    let mut record = records.insert(fresh(root.path(), 1, 0)).await.unwrap();
    for _ in 0..2 {
        record = records
            .commit(id(1), record.fence(), Change::new().execution())
            .await
            .unwrap();
    }
    assert_eq!(record.generation, 2);
    drop(records);
    let (records, _) = Records::open(root.path().into(), Duration::ZERO, None)
        .await
        .unwrap();
    records.remove(id(1), record.fence()).await.unwrap();
    drop(records);
    let (records, _) = Records::open(root.path().into(), Duration::ZERO, None)
        .await
        .unwrap();
    let again = records.insert(fresh(root.path(), 1, 0)).await.unwrap();
    assert!(
        again.generation > record.generation,
        "generation {} used again",
        again.generation
    );
}

/// While a write's fate is unknown, the record cannot be settled; once
/// it can, settling returns what the file durably holds.
#[tokio::test]
async fn an_unsure_record_is_settled_before_anyone_relies_on_it() {
    let root = temp_root("state-settle");
    let (records, _) = Records::open(root.path().into(), Duration::ZERO, None)
        .await
        .unwrap();
    let first = records.insert(fresh(root.path(), 1, 0)).await.unwrap();
    let path = Paths::new(root.path(), id(1)).record;
    let failing = [(path.clone(), "renamed"), (path.clone(), "parent")];
    crate::layout::tests::FAILPOINTS
        .lock()
        .unwrap()
        .extend(failing);
    assert!(matches!(
        records
            .commit(id(1), first.fence(), Change::new().image(true))
            .await,
        Err(StateError::Io(_))
    ));
    assert!(records.get(id(1)).unwrap().image);
    assert!(
        records.settle(id(1)).await.is_err(),
        "an unsure record was settled"
    );
    crate::layout::tests::FAILPOINTS
        .lock()
        .unwrap()
        .retain(|(failing, _)| failing != &path);
    let settled = records.settle(id(1)).await.unwrap();
    assert!(settled.image);
    assert_eq!(settled, read(&path, id(1)).unwrap().unwrap());
}

/// Work on a record whose caller gave up keeps the record's lock until
/// it is done: a writer after it waits, and then sees its effect.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn abandoned_work_on_a_record_still_runs_alone() {
    let root = temp_root("state-cancel");
    let (records, _) = Records::open(root.path().into(), Duration::ZERO, None)
        .await
        .unwrap();
    let records = Arc::new(records);
    let first = records.insert(fresh(root.path(), 1, 0)).await.unwrap();
    // The write lands and its directory cannot be synced: the next
    // work on the record starts by settling it.
    let path = Paths::new(root.path(), id(1)).record;
    crate::layout::tests::FAILPOINTS
        .lock()
        .unwrap()
        .push((path.clone(), "renamed"));
    assert!(
        records
            .commit(id(1), first.fence(), Change::new().image(true))
            .await
            .is_err()
    );
    crate::layout::tests::FAILPOINTS
        .lock()
        .unwrap()
        .retain(|(failing, _)| failing != &path);
    let landed = records.get(id(1)).unwrap().fence();

    let (started, on_start) = std::sync::mpsc::channel();
    let (release, held) = std::sync::mpsc::channel();
    *locked(&records.gate) = Some(Gate {
        started,
        release: held,
    });
    let abandoned = tokio::spawn({
        let records = Arc::clone(&records);
        async move {
            records
                .commit(id(1), landed, Change::new().archived(true))
                .await
        }
    });
    tokio::task::spawn_blocking(move || on_start.recv())
        .await
        .unwrap()
        .unwrap();
    abandoned.abort();
    assert!(abandoned.await.unwrap_err().is_cancelled());
    let later = tokio::spawn({
        let records = Arc::clone(&records);
        async move {
            records
                .commit(id(1), landed, Change::new().image(false))
                .await
        }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !later.is_finished(),
        "a writer ran beside work that was still going"
    );
    release.send(()).unwrap();
    let later = later.await.unwrap();
    assert!(matches!(later, Err(StateError::Stale { .. })), "{later:?}");
    let on_disk = read(&path, id(1)).unwrap().unwrap();
    assert!(on_disk.image && on_disk.archived);
    assert_eq!(records.get(id(1)).unwrap(), on_disk);
}

/// One acknowledged write, as its writer saw it.
#[derive(Debug)]
struct Acked {
    expected: Fence,
    record: Record,
}

type History = Arc<Mutex<BTreeMap<u128, Vec<Acked>>>>;

/// Many writers race on a few records with fresh and stale fences while
/// the agent repeatedly "crashes" (every writer is dropped wherever it
/// is) and the records are reopened from disk. In some rounds every
/// write to one record fails after replacing its file, as when syncing
/// the directory fails. Checks that
///
/// - acknowledged writes form one chain per record: each replaced
///   exactly the version before it, so no two writes ever applied
///   against the same version and none applied against a stale one;
/// - after a crash the disk holds the last acknowledged record or a
///   later one, never anything older.
#[test]
fn racing_writers_and_crashes_never_lose_or_fork_a_record() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap();
    for seed in 0..24 {
        runtime.block_on(simulate(seed));
    }
}

async fn simulate(seed: u64) {
    const SANDBOXES: u128 = 3;
    const WRITERS: u64 = 8;
    let root = temp_root("state-sim");
    let mut rng = Rng(seed);
    let (records, _) = Records::open(root.path().into(), Duration::ZERO, None)
        .await
        .unwrap();
    for n in 0..SANDBOXES {
        records
            .insert(fresh(root.path(), n, u32::try_from(n).unwrap()))
            .await
            .unwrap();
    }
    let mut records = Arc::new(records);
    let history: History = Arc::default();
    restart_history(&history, &records, SANDBOXES);
    for _round in 0..6 {
        // Writes to sandbox 0 land, then report failure.
        let failing = rng.chance(50);
        let unsure = Paths::new(root.path(), id(0)).record;
        if failing {
            crate::layout::tests::FAILPOINTS
                .lock()
                .unwrap()
                .push((unsure.clone(), "renamed"));
        }
        let mut writers = tokio::task::JoinSet::new();
        for _ in 0..WRITERS {
            let records = Arc::clone(&records);
            let history = Arc::clone(&history);
            let mut rng = Rng(rng.next());
            writers.spawn(async move {
                let mut earlier: Vec<Fence> = Vec::new();
                loop {
                    let n = u128::from(rng.below(3));
                    let current = records.get(id(n)).unwrap().fence();
                    let fence = random_fence(&mut rng, current, &earlier);
                    earlier.push(current);
                    match records.commit(id(n), fence, random_change(&mut rng)).await {
                        Ok(record) if record.fence() != fence => {
                            let mut history = history.lock().unwrap();
                            history.entry(n).or_default().push(Acked {
                                expected: fence,
                                record,
                            });
                        }
                        Ok(_) | Err(StateError::Stale { .. }) => {}
                        Err(StateError::Io(_)) if failing && n == 0 => {}
                        Err(error) => panic!("seed {seed}: {error}"),
                    }
                    if rng.chance(10) {
                        tokio::task::yield_now().await;
                    }
                }
            });
        }
        tokio::time::sleep(Duration::from_millis(5 + rng.below(25))).await;
        // The crash: every writer stops wherever it is.
        writers.shutdown().await;
        crate::layout::tests::FAILPOINTS
            .lock()
            .unwrap()
            .retain(|(path, _)| path != &unsure);
        drop(Arc::try_unwrap(records).expect("every writer is gone"));
        let (reopened, strays) = Records::open(root.path().into(), Duration::from_secs(10), None)
            .await
            .unwrap();
        assert!(strays.is_empty(), "seed {seed}: {strays:?}");
        {
            let history = history.lock().unwrap();
            for n in 0..SANDBOXES {
                let chain = &history[&n];
                check_chain(seed, chain);
                let last = &chain[chain.len() - 1].record;
                let on_disk = reopened.get(id(n)).unwrap();
                assert!(
                    on_disk.revision >= last.revision,
                    "seed {seed}: the disk lost an acknowledged write"
                );
                if on_disk.revision == last.revision {
                    assert_eq!(&on_disk, last, "seed {seed}");
                }
            }
        }
        records = Arc::new(reopened);
        restart_history(&history, &records, SANDBOXES);
    }
}

/// Starts each record's chain again from what is committed now.
fn restart_history(history: &History, records: &Records, sandboxes: u128) {
    let mut history = history.lock().unwrap();
    history.clear();
    for n in 0..sandboxes {
        let record = records.get(id(n)).unwrap();
        let expected = record.fence();
        history.insert(n, vec![Acked { expected, record }]);
    }
}

/// Acknowledged writes form one chain: each replaced the version just
/// before it, and no two share a version. A crash can interrupt a
/// writer after its write landed but before it heard so, leaving a gap
/// where the unacknowledged write sits.
fn check_chain(seed: u64, chain: &[Acked]) {
    let mut ordered: Vec<&Acked> = chain.iter().collect();
    ordered.sort_by_key(|acked| acked.record.revision);
    for pair in ordered.windows(2) {
        let (before, after) = (pair[0], pair[1]);
        assert!(
            after.record.revision > before.record.revision,
            "seed {seed}: two writes applied against one version"
        );
        assert_eq!(
            after.expected.revision + 1,
            after.record.revision,
            "seed {seed}"
        );
        if after.record.revision == before.record.revision + 1 {
            assert_eq!(
                after.expected,
                before.record.fence(),
                "seed {seed}: a write applied against a version that was not current"
            );
        }
    }
}
