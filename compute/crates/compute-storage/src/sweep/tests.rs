use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use object_store::ObjectStore as _;
use object_store::memory::InMemory;
use object_store::path::Path;

use super::*;
use crate::chunk::EncodedChunk;
use crate::fake::{Bucket, Fake, Object, Rng};
use crate::fresh::{Clock, Freshness};
use crate::store::unstamped;

const SECOND: Duration = Duration::from_secs(1);

/// The simulated time: tokio's paused clock, from an arbitrary date.
fn paused_clock() -> Clock {
    skewed_clock(0)
}

/// The simulated time as a clock `offset_ms` ahead of the store's reads it.
fn skewed_clock(offset_ms: i64) -> Clock {
    let start = tokio::time::Instant::now();
    let base = UNIX_EPOCH + Duration::from_secs(1_800_000_000);
    let offset = Duration::from_millis(offset_ms.unsigned_abs());
    Clock::from_fn(move || {
        let now = base + start.elapsed();
        if offset_ms < 0 {
            now - offset
        } else {
            now + offset
        }
    })
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
    let publication = store.begin("a").await.unwrap();
    store
        .publish(publication, pointer(&[kept.reference.key()]))
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

/// An archive's first pointer is an empty one stored when it begins; it
/// names nothing, reads as no copy, and goes when the sandbox does.
#[tokio::test(start_paused = true)]
async fn an_archive_begins_by_storing_an_empty_pointer() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let first = store.begin("a").await.unwrap();
    let stored = fake.bytes("p/pointers/v2/a").unwrap();
    assert!(unstamped(&stored).unwrap().is_empty());
    assert_eq!(store.get_pointer("a").await.unwrap(), None);
    let looked = sweep(&store, listed_names, true).await.unwrap();
    assert_eq!((looked.pointers, looked.named), (1, 0));
    // The sweep took stock since the archive began.
    let refused = store.publish(first, pointer(&[])).await;
    assert!(matches!(refused, Err(Error::Superseded)), "{refused:?}");

    let again = store.begin("a").await.unwrap();
    store.publish(again, pointer(&[])).await.unwrap();
    assert_eq!(store.get_pointer("a").await.unwrap(), Some(pointer(&[])));
    store.delete_pointer("a").await.unwrap();
    assert!(fake.bytes("p/pointers/v2/a").is_none());
}

/// The race a deadline cannot close: an archive reuses an old chunk, its
/// pointer write is held up in flight, and a sweep that cannot see it
/// deletes the chunk. The sweep fenced the pointer first, so the write
/// is refused when it arrives, however late, and the archive started
/// again stores the chunk anew.
#[tokio::test(start_paused = true)]
async fn a_publication_held_up_past_a_sweep_never_lands() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p").with_freshness(SIMULATED);
    let reused = chunk(9);
    let key = reused.reference.key();
    store.put_chunk(&reused).await.unwrap();
    let empty = store.begin("a").await.unwrap();
    store.publish(empty, pointer(&[])).await.unwrap();
    // Exactly as old as an archive may reuse without storing it again.
    tokio::time::advance(SIMULATED.refresh_after).await;
    let publication = store.begin("a").await.unwrap();
    assert!(!store.put_chunk(&reused).await.unwrap(), "reused as it is");
    let generation = fake.object(&format!("p/{key}")).unwrap().generation;

    *fake.stall.lock().unwrap() = Some(("pointers/", 300 * SECOND));
    let publishing = tokio::spawn({
        let (store, key) = (store.clone(), key.clone());
        async move { store.publish(publication, pointer(&[key])).await }
    });
    while *fake.held.lock().unwrap() == 0 {
        tokio::task::yield_now().await;
    }
    *fake.stall.lock().unwrap() = None;
    tokio::time::advance(2 * SIMULATED.clock_skew + SECOND).await;
    let swept = sweep(&store, listed_names, true).await.unwrap();
    assert_eq!(swept.deleted, 1, "{swept:?}");
    assert!(fake.object(&format!("p/{key}")).is_none());

    let late = publishing.await.unwrap();
    assert!(matches!(late, Err(Error::Superseded)), "{late:?}");
    assert_eq!(
        store.get_pointer("a").await.unwrap(),
        Some(pointer(&[])),
        "the pointer names nothing that is gone"
    );

    let again = store.begin("a").await.unwrap();
    assert!(store.put_chunk(&reused).await.unwrap(), "stored anew");
    assert!(fake.object(&format!("p/{key}")).unwrap().generation > generation);
    store.publish(again, pointer(&[key])).await.unwrap();
    store.get_chunk(&reused.reference).await.unwrap();
}

/// Waits until a request is held up in flight, then stops waiting for its
/// answer, as a caller that gave up would; the request still lands.
async fn give_up_once_held<T>(fake: &Fake, request: tokio::task::JoinHandle<T>) {
    while *fake.held.lock().unwrap() == 0 {
        tokio::task::yield_now().await;
    }
    request.abort();
    *fake.stall.lock().unwrap() = None;
}

/// Forgetting a memory image replaces the pointer with one naming part
/// of what it named. Held up in flight after its caller gave up, it lands
/// after a newer copy and a sweep that took what the old pointer named,
/// and is refused: the pointer still names only what is stored.
#[tokio::test(start_paused = true)]
async fn a_change_held_up_past_a_newer_copy_never_lands() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p").with_freshness(SIMULATED);
    let (memory, disk, newer) = (chunk(1), chunk(2), chunk(3));
    store.put_chunk(&memory).await.unwrap();
    store.put_chunk(&disk).await.unwrap();
    let first = store.begin("a").await.unwrap();
    let both = pointer(&[memory.reference.key(), disk.reference.key()]);
    store.publish(first, both).await.unwrap();

    let (_, change) = store.read_for_change("a").await.unwrap().unwrap();
    *fake.stall.lock().unwrap() = Some(("pointers/", 300 * SECOND));
    let forgetting = tokio::spawn({
        let (store, key) = (store.clone(), disk.reference.key());
        async move { store.publish(change, pointer(&[key])).await }
    });
    give_up_once_held(&fake, forgetting).await;

    let archive = store.begin("a").await.unwrap();
    store.put_chunk(&newer).await.unwrap();
    let current = pointer(&[newer.reference.key()]);
    store.publish(archive, current.clone()).await.unwrap();
    tokio::time::advance(SIMULATED.sweep_after() + SECOND).await;
    let swept = sweep(&store, listed_names, true).await.unwrap();
    assert_eq!(swept.deleted, 2, "{swept:?}");

    tokio::time::sleep(301 * SECOND).await;
    assert_eq!(*fake.held.lock().unwrap(), 1);
    assert_eq!(store.get_pointer("a").await.unwrap(), Some(current));
    store.get_chunk(&newer.reference).await.unwrap();
}

/// A delete of a removed sandbox's pointer, held up in flight after its
/// caller gave up, lands after a sandbox of the same name stored a copy,
/// and is refused.
#[tokio::test(start_paused = true)]
async fn a_delete_held_up_past_a_newer_copy_never_lands() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let first = store.begin("a").await.unwrap();
    store.publish(first, pointer(&[])).await.unwrap();
    *fake.stall.lock().unwrap() = Some(("pointers/", 300 * SECOND));
    let deleting = tokio::spawn({
        let store = store.clone();
        async move { store.delete_pointer("a").await }
    });
    give_up_once_held(&fake, deleting).await;

    let stored = chunk(4);
    let again = store.begin("a").await.unwrap();
    store.put_chunk(&stored).await.unwrap();
    let current = pointer(&[stored.reference.key()]);
    store.publish(again, current.clone()).await.unwrap();

    tokio::time::sleep(301 * SECOND).await;
    assert_eq!(*fake.held.lock().unwrap(), 1);
    assert_eq!(store.get_pointer("a").await.unwrap(), Some(current));
}

/// The same where an entity tag follows the bytes (S3) and deletes carry
/// no condition: the sandbox is removed again and a new one of the same
/// name stores exactly the pointer the held-up delete read. That pointer
/// is a later write with its own stamp, so the delete is still refused.
#[tokio::test(start_paused = true)]
async fn a_delete_held_up_past_the_same_bytes_stored_again_never_lands() {
    let fake = Fake::new(paused_clock());
    *fake.tags_follow_bytes.lock().unwrap() = true;
    let store = ChunkStore::new(Arc::new(Bucket(fake.clone())), Path::from("p"))
        .with_clock(fake.clock.clone());
    let same = pointer(&[]);
    let first = store.begin("a").await.unwrap();
    store.publish(first, same.clone()).await.unwrap();
    *fake.stall.lock().unwrap() = Some(("pointers/", 300 * SECOND));
    let deleting = tokio::spawn({
        let store = store.clone();
        async move { store.delete_pointer("a").await }
    });
    give_up_once_held(&fake, deleting).await;

    store.delete_pointer("a").await.unwrap();
    assert_eq!(store.get_pointer("a").await.unwrap(), None);
    let again = store.begin("a").await.unwrap();
    store.publish(again, same.clone()).await.unwrap();

    tokio::time::sleep(301 * SECOND).await;
    assert_eq!(*fake.held.lock().unwrap(), 1);
    assert_eq!(store.get_pointer("a").await.unwrap(), Some(same));
}

/// A store still holding pointers from before they carried a stamp is
/// refused, rather than read as holding no copies and swept bare.
#[tokio::test(start_paused = true)]
async fn a_store_with_unstamped_pointers_is_refused() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    store.refuse_unstamped_pointers().await.unwrap();
    let named = chunk(5);
    store.put_chunk(&named).await.unwrap();
    fake.put_raw("p/pointers/v1/a", pointer(&[named.reference.key()]).into());
    tokio::time::advance(store.freshness().sweep_after() + SECOND).await;
    for delete in [false, true] {
        let refused = sweep(&store, listed_names, delete).await;
        assert!(matches!(refused, Err(Error::Unsupported(_))), "{refused:?}");
    }
    assert!(store.refuse_unstamped_pointers().await.is_err());
    store.get_chunk(&named.reference).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_sweep_that_cannot_read_a_pointer_deletes_nothing() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    store.put_chunk(&chunk(6)).await.unwrap();
    store
        .put_pointer_unfenced("garbled", b"not json".to_vec())
        .await
        .unwrap();
    tokio::time::advance(store.freshness().sweep_after() + SECOND).await;
    let refused = sweep(&store, listed_names, true).await;
    assert!(matches!(refused, Err(Error::Json(_))), "{refused:?}");
    assert_eq!(fake.names().len(), 2);
}

#[tokio::test]
async fn only_a_store_that_deletes_on_condition_deletes() {
    let backend = Arc::new(InMemory::new());
    let store = ChunkStore::new(backend.clone(), Path::from("p"));
    store.put_chunk(&chunk(7)).await.unwrap();
    let empty = store.begin("a").await.unwrap();
    store.publish(empty, pointer(&[])).await.unwrap();
    let pointer_path = Path::from("p/pointers/v2/a");
    let version = backend.head(&pointer_path).await.unwrap().e_tag;
    // Seen from far enough ahead, the chunk is old.
    let later = SystemTime::now() + 30 * Duration::from_secs(86_400);
    let store = store.with_clock(Clock::from_fn(move || later));
    let looked = sweep(&store, listed_names, false).await.unwrap();
    assert_eq!(looked.unnamed, 1);
    let refused = sweep(&store, listed_names, true).await;
    assert!(matches!(refused, Err(Error::Unsupported(_))), "{refused:?}");
    assert_eq!(
        backend.head(&pointer_path).await.unwrap().e_tag,
        version,
        "refused before it fenced anything"
    );
}

/// The times the simulation runs with: a sweep may delete what was stored
/// more than 104 seconds before it began.
const SIMULATED: Freshness = Freshness {
    refresh_after: Duration::from_secs(100),
    clock_skew: Duration::from_secs(2),
};

/// Whether deleting `name` leaves every stored test pointer whole.
fn pointers_stay_whole(objects: &BTreeMap<String, Object>, name: &str) -> bool {
    objects
        .iter()
        .filter(|(key, _)| key.starts_with("p/pointers/v2/"))
        .map(|(_, pointer)| unstamped(&pointer.bytes).unwrap())
        .filter(|pointer| !pointer.is_empty())
        .all(|pointer| {
            let keys: Vec<String> = serde_json::from_slice(&pointer).unwrap();
            keys.iter().all(|key| format!("p/{key}") != name)
        })
}

#[derive(Debug, Default)]
struct Outcome {
    published: usize,
    superseded: usize,
    deleted: usize,
    /// Deletes of what a stored pointer named, and pointers published
    /// naming what was gone.
    violations: Vec<String>,
}

fn seconds(rng: &mut Rng, below: u64) -> Duration {
    SECOND * u32::try_from(rng.below(below)).unwrap()
}

/// A clock offset within `freshness`'s allowed disagreement, in
/// milliseconds either way.
fn skew(rng: &mut Rng, freshness: Freshness) -> i64 {
    let most = u64::try_from(freshness.clock_skew.as_millis()).unwrap();
    i64::try_from(rng.below(2 * most + 1)).unwrap() - i64::try_from(most).unwrap()
}

/// Six archives at a time, each archiving one of its two sandboxes again
/// and again: storing or reusing up to three of sixteen chunks, waiting at
/// random, now and then held up for up to five minutes, far longer than a
/// sweep waits, before it publishes; and sometimes deleting a copy. One
/// sweep after another runs beside them. Each archive and the sweep read
/// their own clock, off the store's by up to the allowed disagreement,
/// and every request waits up to three seconds, as the seed picks. With
/// `fenced` false, archives replace their pointers unconditionally.
async fn simulate(seed: u64, archives: Freshness, sweeps: Freshness, fenced: bool) -> Outcome {
    let fake = Fake::new(paused_clock());
    fake.with_latency(seed, 3 * SECOND);
    *fake.guard.lock().unwrap() = Some(pointers_stay_whole);
    let contents: Vec<EncodedChunk> = (0..16).map(chunk).collect();
    let outcome = Mutex::new(Outcome::default());
    let writer = |w: u64| {
        let (fake, contents, outcome) = (&fake, &contents, &outcome);
        async move {
            let mut rng = Rng(seed ^ (w + 1).wrapping_mul(0x2545_F491_4F6C_DD1D));
            let store = ChunkStore::over_fake(fake, "p")
                .with_freshness(archives)
                .with_clock(skewed_clock(skew(&mut rng, archives)));
            for _round in 0..8 {
                tokio::time::sleep(seconds(&mut rng, 30)).await;
                let name = format!("w{w}s{}", rng.below(2));
                let publication = store.begin(&name).await.unwrap();
                let mut keys = Vec::new();
                for _ in 0..=rng.below(3) {
                    let chunk = &contents[usize::try_from(rng.below(16)).unwrap()];
                    store.put_chunk(chunk).await.unwrap();
                    keys.push(chunk.reference.key());
                    tokio::time::sleep(seconds(&mut rng, 25)).await;
                }
                let held = if rng.below(4) == 0 { 300 } else { 50 };
                tokio::time::sleep(seconds(&mut rng, held)).await;
                let published = if fenced {
                    store.publish(publication, pointer(&keys)).await
                } else {
                    store.put_pointer_unfenced(&name, pointer(&keys)).await
                };
                match published {
                    Ok(()) => {
                        let mut outcome = outcome.lock().unwrap();
                        outcome.published += 1;
                        for key in &keys {
                            if fake.bytes(&format!("p/{key}")).is_none() {
                                outcome.violations.push(format!("{name} names {key}"));
                            }
                        }
                    }
                    Err(Error::Superseded) => outcome.lock().unwrap().superseded += 1,
                    Err(error) => panic!("{error}"),
                }
                if rng.below(4) == 0 {
                    store.delete_pointer(&name).await.unwrap();
                }
            }
        }
    };
    let sweeper = async {
        let mut rng = Rng(!seed);
        let store = ChunkStore::over_fake(&fake, "p")
            .with_freshness(sweeps)
            .with_clock(skewed_clock(skew(&mut rng, sweeps)));
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
/// sweeps do delete, and some archives must start again.
#[tokio::test(start_paused = true)]
async fn sweeps_never_take_what_archives_in_flight_will_name() {
    let mut total = Outcome::default();
    for seed in 0..40 {
        let outcome = simulate(seed, SIMULATED, SIMULATED, true).await;
        assert!(
            outcome.violations.is_empty(),
            "seed {seed}: {:?}",
            outcome.violations
        );
        total.published += outcome.published;
        total.superseded += outcome.superseded;
        total.deleted += outcome.deleted;
    }
    assert!(total.deleted > 100, "sweeps deleted only {}", total.deleted);
    assert!(total.superseded > 100 && total.published > 400, "{total:?}");
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
        violations += simulate(seed, never_refresh, SIMULATED, true)
            .await
            .violations
            .len();
    }
    assert!(violations > 0, "no seed lost a chunk");
}

/// And archives held up past a sweep that publish without the fence name
/// what the sweep took.
#[tokio::test(start_paused = true)]
async fn without_the_fence_held_up_archives_name_what_sweeps_took() {
    let mut violations = 0;
    for seed in 0..40 {
        violations += simulate(seed, SIMULATED, SIMULATED, false)
            .await
            .violations
            .len();
    }
    assert!(violations > 0, "no seed lost a chunk");
}
