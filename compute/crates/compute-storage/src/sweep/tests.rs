use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use object_store::memory::InMemory;
use object_store::path::Path;

use super::*;
use crate::chunk::EncodedChunk;
use crate::fake::{Fake, Object, Rng};
use crate::fresh::{Clock, Freshness};

const SECOND: Duration = Duration::from_secs(1);

/// The simulated time: tokio's paused clock, from an arbitrary date.
fn paused_clock() -> Clock {
    let start = tokio::time::Instant::now();
    let base = UNIX_EPOCH + Duration::from_secs(1_800_000_000);
    Clock::from_fn(move || base + start.elapsed())
}

/// Test pointers hold the keys they name as a JSON list.
async fn listed_names(bytes: Vec<u8>) -> Result<Vec<String>> {
    Ok(serde_json::from_slice(&bytes)?)
}

fn pointer(keys: &[String]) -> Vec<u8> {
    serde_json::to_vec(keys).unwrap()
}

fn chunk(n: u8) -> EncodedChunk {
    EncodedChunk::encode(&[n; 4096], 1).unwrap()
}

#[tokio::test(start_paused = true)]
async fn old_unnamed_objects_go_and_named_or_recent_ones_stay() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let [kept, old, older, recent] = [chunk(1), chunk(2), chunk(3), chunk(4)];
    for chunk in [&kept, &old, &older] {
        store.put_chunk(chunk).await.unwrap();
    }
    let publication = store.begin();
    store
        .publish(publication, "a", pointer(&[kept.reference.key()]))
        .await
        .unwrap();
    tokio::time::advance(store.freshness().sweep_after() + SECOND).await;
    store.put_chunk(&recent).await.unwrap();

    let looked = sweep(&store, listed_names, false).await.unwrap();
    assert_eq!(
        (looked.pointers, looked.named, looked.stored, looked.recent),
        (1, 1, 4, 1)
    );
    assert_eq!((looked.unnamed, looked.deleted), (2, 0));
    assert_eq!(fake.names().len(), 5, "a look deletes nothing");

    let swept = sweep(&store, listed_names, true).await.unwrap();
    assert_eq!((swept.unnamed, swept.deleted), (2, 2));
    assert_eq!(swept.deleted_bytes, looked.unnamed_bytes);
    let present = |chunk: &EncodedChunk| fake.bytes(&format!("p/{}", chunk.object_key())).is_some();
    assert!(present(&kept) && present(&recent));
    assert!(!present(&old) && !present(&older));
}

#[tokio::test(start_paused = true)]
async fn a_reused_chunk_stored_long_ago_is_stored_again() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let chunk = chunk(5);
    let name = format!("p/{}", chunk.object_key());
    assert!(store.put_chunk(&chunk).await.unwrap());
    let first = fake.object(&name).unwrap().generation;
    tokio::time::advance(store.freshness().refresh_after).await;
    assert!(!store.put_chunk(&chunk).await.unwrap());
    assert_eq!(
        fake.object(&name).unwrap().generation,
        first,
        "still recent"
    );
    tokio::time::advance(2 * SECOND).await;
    assert!(!store.put_chunk(&chunk).await.unwrap());
    let refreshed = fake.object(&name).unwrap();
    assert!(refreshed.generation > first, "stored again");
    assert_eq!(refreshed.at, store.now());
}

#[tokio::test(start_paused = true)]
async fn an_archive_past_its_window_cannot_publish() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let publication = store.begin();
    tokio::time::advance(store.freshness().publish_within + SECOND).await;
    let refused = store.publish(publication, "late", pointer(&[])).await;
    assert!(matches!(refused, Err(Error::Expired)), "{refused:?}");
    assert_eq!(store.get_pointer("late").await.unwrap(), None);
}

#[tokio::test(start_paused = true)]
async fn a_sweep_that_cannot_read_a_pointer_deletes_nothing() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    store.put_chunk(&chunk(6)).await.unwrap();
    store
        .put_pointer("garbled", b"not json".to_vec())
        .await
        .unwrap();
    tokio::time::advance(store.freshness().sweep_after() + SECOND).await;
    let refused = sweep(&store, listed_names, true).await;
    assert!(matches!(refused, Err(Error::Json(_))), "{refused:?}");
    assert_eq!(fake.names().len(), 2);
}

#[tokio::test]
async fn only_a_store_that_deletes_on_condition_deletes() {
    let store = ChunkStore::new(Arc::new(InMemory::new()), Path::from("p"));
    store.put_chunk(&chunk(7)).await.unwrap();
    // Seen from far enough ahead, the chunk is old.
    let later = SystemTime::now() + 30 * Duration::from_secs(86_400);
    let store = store.with_clock(Clock::from_fn(move || later));
    let looked = sweep(&store, listed_names, false).await.unwrap();
    assert_eq!(looked.unnamed, 1);
    let refused = sweep(&store, listed_names, true).await;
    assert!(matches!(refused, Err(Error::Unsupported(_))), "{refused:?}");
}

/// The windows the simulation runs with: a sweep may delete what was
/// stored more than 164 seconds before it began.
const SIMULATED: Freshness = Freshness {
    refresh_after: Duration::from_secs(100),
    publish_within: Duration::from_secs(60),
    clock_skew: Duration::from_secs(2),
};

/// Whether deleting `name` leaves every stored test pointer whole.
fn pointers_stay_whole(objects: &BTreeMap<String, Object>, name: &str) -> bool {
    objects
        .iter()
        .filter(|(key, _)| key.starts_with("p/pointers/v1/"))
        .all(|(_, pointer)| {
            let keys: Vec<String> = serde_json::from_slice(&pointer.bytes).unwrap();
            keys.iter().all(|key| format!("p/{key}") != name)
        })
}

#[derive(Debug, Default)]
struct Outcome {
    published: usize,
    expired: usize,
    deleted: usize,
    /// Deletes of what a stored pointer named, and pointers published
    /// naming what was gone.
    violations: Vec<String>,
}

fn seconds(rng: &mut Rng, below: u64) -> Duration {
    SECOND * u32::try_from(rng.below(below)).unwrap()
}

/// Six archives at a time, each storing or reusing up to three of sixteen
/// chunks, waiting at random and sometimes past its window, publishing
/// and deleting pointers; and one sweep after another. Every request to
/// the store waits up to three seconds, as the seed picks.
async fn simulate(seed: u64, archives: Freshness, sweeps: Freshness) -> Outcome {
    let fake = Fake::new(paused_clock());
    fake.with_latency(seed, 3 * SECOND);
    *fake.guard.lock().unwrap() = Some(pointers_stay_whole);
    let contents: Vec<EncodedChunk> = (0..16).map(chunk).collect();
    let outcome = Mutex::new(Outcome::default());
    let writer = |w: u64| {
        let store = ChunkStore::over_fake(&fake, "p").with_freshness(archives);
        let (fake, contents, outcome) = (&fake, &contents, &outcome);
        async move {
            let mut rng = Rng(seed ^ (w + 1).wrapping_mul(0x2545_F491_4F6C_DD1D));
            let mut mine = Vec::new();
            for round in 0..8 {
                tokio::time::sleep(seconds(&mut rng, 30)).await;
                let publication = store.begin();
                let mut keys = Vec::new();
                for _ in 0..=rng.below(3) {
                    let chunk = &contents[usize::try_from(rng.below(16)).unwrap()];
                    store.put_chunk(chunk).await.unwrap();
                    keys.push(chunk.reference.key());
                    tokio::time::sleep(seconds(&mut rng, 25)).await;
                }
                tokio::time::sleep(seconds(&mut rng, 50)).await;
                let name = format!("w{w}r{round}");
                match store.publish(publication, &name, pointer(&keys)).await {
                    Ok(()) => {
                        let mut outcome = outcome.lock().unwrap();
                        outcome.published += 1;
                        for key in &keys {
                            if fake.bytes(&format!("p/{key}")).is_none() {
                                outcome.violations.push(format!("{name} names {key}"));
                            }
                        }
                        mine.push(name);
                    }
                    Err(Error::Expired) => outcome.lock().unwrap().expired += 1,
                    Err(error) => panic!("{error}"),
                }
                if !mine.is_empty() && rng.below(2) == 0 {
                    let which = usize::try_from(rng.below(mine.len() as u64)).unwrap();
                    let gone = mine.swap_remove(which);
                    store.delete_pointer(&gone).await.unwrap();
                }
            }
        }
    };
    let sweeper = async {
        let store = ChunkStore::over_fake(&fake, "p").with_freshness(sweeps);
        let mut rng = Rng(!seed);
        for _ in 0..16 {
            tokio::time::sleep(seconds(&mut rng, 120)).await;
            let report = sweep(&store, listed_names, true).await.unwrap();
            outcome.lock().unwrap().deleted += report.deleted;
        }
    };
    let writers = futures::future::join_all((0..6).map(writer));
    tokio::join!(writers, sweeper);
    let mut outcome = outcome.into_inner().unwrap();
    outcome
        .violations
        .extend(fake.violations.lock().unwrap().drain(..));
    outcome
}

/// Under the rules, no seed ever deletes what a pointer names, while the
/// sweeps do delete, and some archives run out of time.
#[tokio::test(start_paused = true)]
async fn sweeps_never_take_what_archives_in_flight_will_name() {
    let mut total = Outcome::default();
    for seed in 0..40 {
        let outcome = simulate(seed, SIMULATED, SIMULATED).await;
        assert!(
            outcome.violations.is_empty(),
            "seed {seed}: {:?}",
            outcome.violations
        );
        total.published += outcome.published;
        total.expired += outcome.expired;
        total.deleted += outcome.deleted;
    }
    assert!(total.deleted > 100, "sweeps deleted only {}", total.deleted);
    assert!(total.expired > 0 && total.published > 1_000, "{total:?}");
}

/// The simulation has teeth: archives that reuse old chunks without
/// storing them again lose them to sweeps.
#[tokio::test(start_paused = true)]
async fn without_refreshing_reused_chunks_sweeps_take_them() {
    let never_refresh = Freshness {
        refresh_after: Duration::from_secs(1_000_000),
        ..SIMULATED
    };
    let mut violations = 0;
    for seed in 0..40 {
        violations += simulate(seed, never_refresh, SIMULATED)
            .await
            .violations
            .len();
    }
    assert!(violations > 0, "no seed lost a chunk");
}
