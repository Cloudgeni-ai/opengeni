use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use object_store::memory::InMemory;
use object_store::path::Path;

use super::*;
use crate::chunk::EncodedChunk;
use crate::fake::{Bucket, Fake, Object, Rng};
use crate::fresh::{CLOCK_SKEW, Clock, LEGACY_SWEEP_AFTER, day_of};
use crate::store::{Begun, Put, Rewrite, TEST_EPOCH, next_save, unstamped};

const SECOND: Duration = Duration::from_secs(1);
const HOUR: Duration = Duration::from_secs(3_600);
const DAY: Duration = Duration::from_secs(86_400);

/// The simulated time: tokio's paused clock, from 08:00 UTC of a day.
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

async fn put(store: &ChunkStore, chunk: &EncodedChunk) -> Put {
    store.put_chunk(chunk).await.unwrap()
}

fn key_of(put: &Put) -> String {
    put.reference.key()
}

fn present(fake: &Fake, key: &str) -> bool {
    fake.bytes(&format!("p/{key}")).is_some()
}

#[tokio::test(start_paused = true)]
async fn old_unnamed_objects_go_and_named_or_recent_ones_stay() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let kept = put(&store, &chunk(1)).await;
    let old = put(&store, &chunk(2)).await;
    let older = put(&store, &chunk(3)).await;
    let publication = store.begin_test("a").await.unwrap();
    store
        .publish(publication, pointer(&[key_of(&kept)]))
        .await
        .unwrap();
    tokio::time::advance(2 * DAY).await;
    let recent = put(&store, &chunk(4)).await;

    let looked = sweep(&store, listed_names, false).await.unwrap();
    assert_eq!(
        (looked.pointers, looked.named, looked.stored, looked.recent),
        (1, 1, 4, 1)
    );
    assert_eq!((looked.unnamed, looked.deleted, looked.unknown), (2, 0, 0));
    assert_eq!(fake.names().len(), 5, "a look deletes nothing");

    let swept = sweep(&store, listed_names, true).await.unwrap();
    assert_eq!((swept.unnamed, swept.deleted), (2, 2));
    assert_eq!(swept.deleted_bytes, looked.unnamed_bytes);
    assert!(present(&fake, &key_of(&kept)) && present(&fake, &key_of(&recent)));
    assert!(!present(&fake, &key_of(&old)) && !present(&fake, &key_of(&older)));
}

/// What was written yesterday stays until the day after tomorrow begins,
/// however early today's sweep runs: an archive that began after the
/// sweep took stock may have written it on a clock behind the sweep's.
#[tokio::test(start_paused = true)]
async fn an_object_stays_until_the_day_after_tomorrow() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let written = put(&store, &chunk(1)).await;
    // From 08:00 to the last second of the next day.
    tokio::time::advance((DAY + 16 * HOUR).checked_sub(SECOND).unwrap()).await;
    let late = sweep(&store, listed_names, true).await.unwrap();
    assert_eq!((late.recent, late.deleted), (1, 0));
    assert!(present(&fake, &key_of(&written)));
    tokio::time::advance(SECOND).await;
    let next = sweep(&store, listed_names, true).await.unwrap();
    assert_eq!((next.recent, next.deleted), (0, 1));
}

/// The same bytes stored again the same day are found there and reused;
/// the next day they are stored anew under that day's name, and nothing
/// writes the earlier day's name again.
#[tokio::test(start_paused = true)]
async fn the_same_bytes_are_reused_the_same_day_and_stored_anew_the_next() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let content = chunk(5);
    let first = put(&store, &content).await;
    assert!(first.new);
    assert_eq!(first.reference.day, Some(day_of(store.now())));
    let stored = |put: &Put| fake.object(&format!("p/{}", key_of(put))).unwrap();
    let generation = stored(&first).generation;
    // 23:00 the same day.
    tokio::time::advance(15 * HOUR).await;
    let again = put(&store, &content).await;
    assert_eq!(
        again,
        Put {
            new: false,
            ..first.clone()
        }
    );
    assert_eq!(stored(&first).generation, generation, "not stored again");
    // 01:00 the next day.
    tokio::time::advance(2 * HOUR).await;
    let next = put(&store, &content).await;
    assert!(next.new);
    assert_eq!(next.reference.day, first.reference.day.map(|day| day + 1));
    assert!(next.reference.same_bytes(&first.reference));
    assert_eq!(stored(&first).generation, generation);
    assert_eq!(
        store.get_chunk(&first.reference).await.unwrap(),
        store.get_chunk(&next.reference).await.unwrap()
    );
}

/// An archive's first pointer is an empty one stored when it begins; it
/// names nothing and reads as no copy. Deleting the sandbox leaves a
/// tombstone, which no later archive publishes over and every sweep keeps.
#[tokio::test(start_paused = true)]
async fn an_archive_begins_by_storing_an_empty_pointer() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let first = store.begin_test("a").await.unwrap();
    let stored = fake.bytes("p/pointers/v3/a").unwrap();
    assert!(unstamped(&stored).unwrap().1.is_empty());
    assert_eq!(store.get_pointer("a").await.unwrap(), None);
    let looked = sweep(&store, listed_names, true).await.unwrap();
    assert_eq!((looked.pointers, looked.named), (1, 0));
    // The sweep took stock since the archive began.
    let refused = store.publish(first, pointer(&[])).await;
    assert!(matches!(refused, Err(Error::Superseded)), "{refused:?}");

    let again = store.begin_test("a").await.unwrap();
    store.publish(again, pointer(&[])).await.unwrap();
    assert_eq!(store.get_pointer("a").await.unwrap(), Some(pointer(&[])));
    store.delete_pointer("a", TEST_EPOCH).await.unwrap();
    let tombstone = fake.bytes("p/pointers/v3/a").expect("a tombstone");
    assert!(unstamped(&tombstone).unwrap().1.is_empty());
    assert_eq!(store.get_pointer("a").await.unwrap(), None);
    let late = store.begin("a", next_save()).await.unwrap();
    assert!(matches!(late, Begun::Deleted), "{late:?}");

    let young = sweep(&store, listed_names, true).await.unwrap();
    assert_eq!(young.tombstones, 1);
    assert_eq!(
        fake.bytes("p/pointers/v3/a"),
        Some(tombstone.clone()),
        "not stored again"
    );
    tokio::time::advance(30 * DAY).await;
    let old = sweep(&store, listed_names, true).await.unwrap();
    assert_eq!(old.tombstones, 1);
    assert_eq!(fake.bytes("p/pointers/v3/a"), Some(tombstone), "kept");
}

/// A first archive's empty pointer, held up in flight while the sandbox
/// is deleted and long past any sweep, lands on the tombstone and is
/// refused: the archive finds the sandbox deleted and stores nothing. A
/// sweep that deleted old tombstones would have let it start a copy of a
/// deleted sandbox.
#[tokio::test(start_paused = true)]
async fn a_first_archive_held_up_past_a_delete_and_a_sweep_finds_the_sandbox_deleted() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    *fake.stall.lock().unwrap() = Some(("pointers/", 3 * DAY));
    let archiving = tokio::spawn({
        let store = store.clone();
        async move { store.begin("a", next_save()).await }
    });
    while *fake.held.lock().unwrap() == 0 {
        tokio::task::yield_now().await;
    }
    *fake.stall.lock().unwrap() = None;
    store.delete_pointer("a", TEST_EPOCH).await.unwrap();
    let tombstone = fake.bytes("p/pointers/v3/a").expect("a tombstone");

    tokio::time::advance(2 * DAY).await;
    let swept = sweep(&store, listed_names, true).await.unwrap();
    assert_eq!(swept.tombstones, 1, "{swept:?}");

    let late = archiving.await.unwrap();
    assert!(matches!(late, Ok(Begun::Deleted)), "{late:?}");
    assert_eq!(fake.bytes("p/pointers/v3/a"), Some(tombstone));
    assert_eq!(store.get_pointer("a").await.unwrap(), None);
}

/// The race a deadline cannot close: an archive reuses a chunk another
/// write stored the same day, its pointer write is held up in flight for
/// days, and a sweep that cannot see it deletes the chunk. The sweep
/// fenced the pointer first, so the write is refused when it arrives,
/// however late, and the archive started again stores the chunk anew.
#[tokio::test(start_paused = true)]
async fn a_publication_held_up_past_a_sweep_never_lands() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let content = chunk(9);
    let stored = put(&store, &content).await;
    let empty = store.begin_test("a").await.unwrap();
    store.publish(empty, pointer(&[])).await.unwrap();
    let publication = store.begin_test("a").await.unwrap();
    let reused = put(&store, &content).await;
    assert!(!reused.new, "reused as it is");
    let key = key_of(&reused);
    assert_eq!(key, key_of(&stored));

    *fake.stall.lock().unwrap() = Some(("pointers/", 3 * DAY));
    let publishing = tokio::spawn({
        let (store, key) = (store.clone(), key.clone());
        async move { store.publish(publication, pointer(&[key])).await }
    });
    while *fake.held.lock().unwrap() == 0 {
        tokio::task::yield_now().await;
    }
    *fake.stall.lock().unwrap() = None;
    tokio::time::advance(2 * DAY).await;
    let swept = sweep(&store, listed_names, true).await.unwrap();
    assert_eq!(swept.deleted, 1, "{swept:?}");
    assert!(!present(&fake, &key));

    let late = publishing.await.unwrap();
    assert!(matches!(late, Err(Error::Superseded)), "{late:?}");
    assert_eq!(
        store.get_pointer("a").await.unwrap(),
        Some(pointer(&[])),
        "the pointer names nothing that is gone"
    );

    let again = store.begin_test("a").await.unwrap();
    let anew = put(&store, &content).await;
    assert!(anew.new, "stored anew");
    store
        .publish(again, pointer(&[key_of(&anew)]))
        .await
        .unwrap();
    store.get_chunk(&anew.reference).await.unwrap();
}

/// Why an archive never reuses an object of an earlier day it finds by
/// its name: a sweep that took stock before the archive began deletes it
/// all the same, and the archive's pointer then names what is gone. What
/// the archive stores itself, under today's name, the sweep leaves.
#[tokio::test(start_paused = true)]
async fn an_earlier_days_object_found_by_name_is_not_safe_to_reuse() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let content = chunk(3);
    let old = put(&store, &content).await;
    tokio::time::advance(2 * DAY).await;
    // Held up between taking stock and deleting.
    *fake.stall.lock().unwrap() = Some(("chunks/", HOUR));
    let sweeping = tokio::spawn({
        let store = store.clone();
        async move { sweep(&store, listed_names, true).await }
    });
    while *fake.held.lock().unwrap() == 0 {
        tokio::task::yield_now().await;
    }
    *fake.stall.lock().unwrap() = None;

    let unsafe_reuse = store.begin_test("a").await.unwrap();
    assert!(store.has_chunk(&old.reference).await.unwrap(), "found");
    store
        .publish(unsafe_reuse, pointer(&[key_of(&old)]))
        .await
        .unwrap();
    let archive = store.begin_test("b").await.unwrap();
    let anew = put(&store, &content).await;
    assert!(anew.new, "today's name is a new object");
    store
        .publish(archive, pointer(&[key_of(&anew)]))
        .await
        .unwrap();

    let swept = sweeping.await.unwrap().unwrap();
    assert_eq!(swept.deleted, 1, "{swept:?}");
    assert!(
        !store.has_chunk(&old.reference).await.unwrap(),
        "pointer a names what is gone"
    );
    store.get_chunk(&anew.reference).await.unwrap();
}

/// A sweep's delete held up in flight, however long, after the sweep gave
/// up, takes only the name it meant: the same bytes stored since are
/// under a later day's name, so no delete needs a condition.
#[tokio::test(start_paused = true)]
async fn a_delete_held_up_in_flight_takes_nothing_written_since() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let content = chunk(8);
    let old = put(&store, &content).await;
    tokio::time::advance(2 * DAY).await;
    *fake.stall.lock().unwrap() = Some(("chunks/", 3 * DAY));
    let sweeping = tokio::spawn({
        let store = store.clone();
        async move { sweep(&store, listed_names, true).await }
    });
    give_up_once_held(&fake, sweeping).await;

    let archive = store.begin_test("a").await.unwrap();
    let anew = put(&store, &content).await;
    assert!(anew.new);
    store
        .publish(archive, pointer(&[key_of(&anew)]))
        .await
        .unwrap();
    tokio::time::sleep(3 * DAY + SECOND).await;
    assert!(!present(&fake, &key_of(&old)), "the held delete landed");
    assert_eq!(*fake.held.lock().unwrap(), 1);
    store.get_chunk(&anew.reference).await.unwrap();
}

/// Objects of the old layout are never written again: one no pointer
/// names goes once it was last stored more than a week (and two clock
/// disagreements) before the sweep began. Keys of no known layout stay.
#[tokio::test(start_paused = true)]
async fn old_layout_objects_go_after_a_week_and_unknown_keys_stay() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let (named, unnamed) = (chunk(1), chunk(2));
    for old in [&named, &unnamed] {
        assert!(old.object_key().starts_with("chunks/v1/"));
        fake.put_raw(
            &format!("p/{}", old.object_key()),
            Bytes::from(old.bytes.clone()),
        );
    }
    let digest = "ab".repeat(32);
    fake.put_raw(
        &format!("p/manifests/v1/{digest}.json"),
        Bytes::from_static(b"{}"),
    );
    fake.put_raw("p/chunks/v9/odd", Bytes::from_static(b"?"));
    let publication = store.begin_test("a").await.unwrap();
    store
        .publish(publication, pointer(&[named.object_key()]))
        .await
        .unwrap();
    store.get_chunk(&named.reference).await.unwrap();

    tokio::time::advance(LEGACY_SWEEP_AFTER.checked_sub(SECOND).unwrap()).await;
    let young = sweep(&store, listed_names, true).await.unwrap();
    assert_eq!((young.recent, young.unknown, young.deleted), (2, 1, 0));
    tokio::time::advance(2 * SECOND).await;
    let old = sweep(&store, listed_names, true).await.unwrap();
    assert_eq!((old.named, old.unknown, old.deleted), (1, 1, 2));
    assert!(present(&fake, &named.object_key()));
    assert!(!present(&fake, &unnamed.object_key()));
    assert!(fake.bytes("p/chunks/v9/odd").is_some());
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
    let store = ChunkStore::over_fake(&fake, "p");
    let memory = put(&store, &chunk(1)).await;
    let disk = put(&store, &chunk(2)).await;
    let first = store.begin_test("a").await.unwrap();
    let both = pointer(&[key_of(&memory), key_of(&disk)]);
    store.publish(first, both).await.unwrap();

    let (_, change) = store.rewrite_test("a").await.unwrap().unwrap();
    *fake.stall.lock().unwrap() = Some(("pointers/", 3 * DAY));
    let forgetting = tokio::spawn({
        let (store, key) = (store.clone(), key_of(&disk));
        async move { store.publish(change, pointer(&[key])).await }
    });
    give_up_once_held(&fake, forgetting).await;

    let archive = store.begin_test("a").await.unwrap();
    let newer = put(&store, &chunk(3)).await;
    let current = pointer(&[key_of(&newer)]);
    store.publish(archive, current.clone()).await.unwrap();
    tokio::time::advance(2 * DAY).await;
    let swept = sweep(&store, listed_names, true).await.unwrap();
    assert_eq!(swept.deleted, 2, "{swept:?}");

    tokio::time::sleep(DAY + SECOND).await;
    assert_eq!(*fake.held.lock().unwrap(), 1);
    assert_eq!(store.get_pointer("a").await.unwrap(), Some(current));
    store.get_chunk(&newer.reference).await.unwrap();
}

/// A rewrite (forgetting memory) that finds only an archive's empty start
/// stores its own number there, so that archive, which began before it,
/// cannot land after it and bring the memory back.
#[tokio::test(start_paused = true)]
async fn a_forget_that_finds_an_archive_starting_stops_it() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let archive = store.begin("a", next_save()).await.unwrap();
    let forget = store.read_for_change("a", next_save()).await.unwrap();
    assert!(matches!(forget, Rewrite::Nothing), "{forget:?}");

    let Begun::Publish(publication) = archive else {
        panic!("{archive:?}")
    };
    let late = store
        .publish(publication, pointer(&["memory".to_owned()]))
        .await;
    assert!(matches!(late, Err(Error::Superseded)), "{late:?}");
    assert_eq!(store.get_pointer("a").await.unwrap(), None);
}

/// The same with the archive's start itself held up in flight: the forget
/// finds no pointer, stores its number, and the start lands on it and is
/// refused, so the archive finds itself outdated.
#[tokio::test(start_paused = true)]
async fn a_forget_with_nothing_stored_stops_an_archive_whose_start_is_in_flight() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let archive_stamp = next_save();
    *fake.stall.lock().unwrap() = Some(("pointers/", 300 * SECOND));
    let archiving = tokio::spawn({
        let store = store.clone();
        async move { store.begin("a", archive_stamp).await }
    });
    while *fake.held.lock().unwrap() == 0 {
        tokio::task::yield_now().await;
    }
    *fake.stall.lock().unwrap() = None;
    let forget = store.read_for_change("a", next_save()).await.unwrap();
    assert!(matches!(forget, Rewrite::Nothing), "{forget:?}");

    let late = archiving.await.unwrap();
    assert!(matches!(late, Ok(Begun::Outdated)), "{late:?}");
    assert_eq!(store.get_pointer("a").await.unwrap(), None);
}

/// A delete of a removed sandbox's pointer, held up in flight after its
/// caller gave up, lands after a sandbox of the same name stored a copy,
/// and is refused.
#[tokio::test(start_paused = true)]
async fn a_delete_held_up_past_a_newer_copy_never_lands() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let first = store.begin_test("a").await.unwrap();
    store.publish(first, pointer(&[])).await.unwrap();
    *fake.stall.lock().unwrap() = Some(("pointers/", 300 * SECOND));
    let deleting = tokio::spawn({
        let store = store.clone();
        async move { store.delete_pointer("a", TEST_EPOCH).await }
    });
    give_up_once_held(&fake, deleting).await;

    let again = store.begin_test("a").await.unwrap();
    let stored = put(&store, &chunk(4)).await;
    let current = pointer(&[key_of(&stored)]);
    store.publish(again, current.clone()).await.unwrap();

    tokio::time::sleep(301 * SECOND).await;
    assert_eq!(*fake.held.lock().unwrap(), 1);
    assert_eq!(store.get_pointer("a").await.unwrap(), Some(current));
}

/// The same where an entity tag follows the bytes (S3): an archive stores
/// exactly the pointer the held-up delete read. That pointer is a later
/// write with its own stamp, so the delete is still refused.
#[tokio::test(start_paused = true)]
async fn a_delete_held_up_past_the_same_bytes_stored_again_never_lands() {
    let fake = Fake::new(paused_clock());
    *fake.tags_follow_bytes.lock().unwrap() = true;
    let store = ChunkStore::new(Arc::new(Bucket(fake.clone())), Path::from("p"))
        .with_clock(fake.clock.clone());
    let same = pointer(&[]);
    let first = store.begin_test("a").await.unwrap();
    store.publish(first, same.clone()).await.unwrap();
    *fake.stall.lock().unwrap() = Some(("pointers/", 300 * SECOND));
    let deleting = tokio::spawn({
        let store = store.clone();
        async move { store.delete_pointer("a", TEST_EPOCH).await }
    });
    give_up_once_held(&fake, deleting).await;

    let again = store.begin_test("a").await.unwrap();
    store.publish(again, same.clone()).await.unwrap();

    tokio::time::sleep(301 * SECOND).await;
    assert_eq!(*fake.held.lock().unwrap(), 1);
    assert_eq!(store.get_pointer("a").await.unwrap(), Some(same));
}

#[tokio::test(start_paused = true)]
async fn a_sweep_that_cannot_read_a_pointer_deletes_nothing() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    store.put_chunk(&chunk(6)).await.unwrap();
    store
        .put_pointer_unfenced("garbled", next_save(), b"not json".to_vec())
        .await
        .unwrap();
    tokio::time::advance(2 * DAY).await;
    let refused = sweep(&store, listed_names, true).await;
    assert!(matches!(refused, Err(Error::Json(_))), "{refused:?}");
    assert_eq!(fake.names().len(), 2);
}

/// Deletes carry no condition, so a sweep deletes on any store.
#[tokio::test]
async fn a_sweep_deletes_on_any_store() {
    let backend = Arc::new(InMemory::new());
    let store = ChunkStore::new(backend, Path::from("p"));
    store.put_chunk(&chunk(7)).await.unwrap();
    let empty = store.begin_test("a").await.unwrap();
    store.publish(empty, pointer(&[])).await.unwrap();
    // Seen from far enough ahead, the chunk is old.
    let later = SystemTime::now() + 30 * DAY;
    let store = store.with_clock(Clock::from_fn(move || later));
    let swept = sweep(&store, listed_names, true).await.unwrap();
    assert_eq!((swept.unnamed, swept.deleted), (1, 1));
}

/// Pointers are kept in an object store only if it refuses writes whose
/// condition no longer holds; Garage ignores the conditions, so a host
/// on it needs the control service to keep its pointers.
#[tokio::test]
async fn pointers_are_kept_only_in_a_store_that_writes_on_condition() {
    let honours = Fake::new(Clock::system());
    ChunkStore::new(Arc::new(Bucket(honours.clone())), Path::from("p"))
        .check_pointers()
        .await
        .unwrap();
    assert!(honours.names().is_empty(), "the probe is removed");
    ChunkStore::new(Arc::new(InMemory::new()), Path::from("p"))
        .check_pointers()
        .await
        .unwrap();

    let ignores = Fake::new(Clock::system());
    *ignores.ignores_conditions.lock().unwrap() = true;
    let refused = ChunkStore::new(Arc::new(Bucket(ignores.clone())), Path::from("p"))
        .check_pointers()
        .await;
    assert!(matches!(refused, Err(Error::Unsupported(_))), "{refused:?}");
    assert!(ignores.names().is_empty(), "the probe is removed");
}

/// Whether deleting `name` leaves every stored test pointer whole.
fn pointers_stay_whole(objects: &BTreeMap<String, Object>, name: &str) -> bool {
    objects
        .iter()
        .filter(|(key, _)| key.starts_with("p/pointers/v3/"))
        .map(|(_, pointer)| unstamped(&pointer.bytes).unwrap().1)
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
    /// Chunks found stored the same day by another write.
    reused: usize,
    deleted: usize,
    /// Deletes of what a stored pointer named, and pointers published
    /// naming what was gone.
    violations: Vec<String>,
}

/// A random wait of up to `most`.
fn within(rng: &mut Rng, most: Duration) -> Duration {
    let most = u64::try_from(most.as_millis()).unwrap();
    Duration::from_millis(rng.below(most + 1))
}

/// A clock offset within the allowed disagreement, in milliseconds either
/// way.
fn skew(rng: &mut Rng) -> i64 {
    let most = u64::try_from(CLOCK_SKEW.as_millis()).unwrap();
    i64::try_from(rng.below(2 * most + 1)).unwrap() - i64::try_from(most).unwrap()
}

/// Six archives at a time over about a week, each archiving one of its
/// two sandboxes again and again: reusing part of what its last copy
/// named, storing (or finding stored the same day) up to three of sixteen
/// chunks, and now and then held up for up to two days before it
/// publishes; sometimes deleting a copy. One sweep after another runs
/// beside them. Each archive and the sweep read their own clock, off the
/// store's by up to the allowed disagreement, and every request waits up
/// to three seconds, as the seed picks. With `fenced` false, archives
/// replace their pointers unconditionally.
async fn simulate(seed: u64, fenced: bool) -> Outcome {
    let fake = Fake::new(paused_clock());
    fake.with_latency(seed, 3 * SECOND);
    *fake.guard.lock().unwrap() = Some(pointers_stay_whole);
    let contents: Vec<EncodedChunk> = (0..16).map(chunk).collect();
    let outcome = Mutex::new(Outcome::default());
    let writer = |w: u64| {
        let (fake, contents, outcome) = (&fake, &contents, &outcome);
        async move {
            let mut rng = Rng(seed ^ (w + 1).wrapping_mul(0x2545_F491_4F6C_DD1D));
            let store = ChunkStore::over_fake(fake, "p").with_clock(skewed_clock(skew(&mut rng)));
            // A deleted sandbox's name is never used again.
            let mut deletes = [0_u64; 2];
            // What each sandbox's pointer names: its last publication.
            let mut last: [Vec<String>; 2] = Default::default();
            for _round in 0..12 {
                tokio::time::sleep(within(&mut rng, 8 * HOUR)).await;
                let slot = usize::try_from(rng.below(2)).unwrap();
                let name = format!("w{w}s{slot}d{}", deletes[slot]);
                let publication = store.begin_test(&name).await.unwrap();
                let mut keys: Vec<String> = last[slot]
                    .iter()
                    .filter(|_| rng.below(2) == 0)
                    .cloned()
                    .collect();
                for _ in 0..=rng.below(3) {
                    let chunk = &contents[usize::try_from(rng.below(16)).unwrap()];
                    let put = store.put_chunk(chunk).await.unwrap();
                    outcome.lock().unwrap().reused += usize::from(!put.new);
                    keys.push(put.reference.key());
                    tokio::time::sleep(within(&mut rng, HOUR)).await;
                }
                keys.sort();
                keys.dedup();
                let held = if rng.below(4) == 0 {
                    48 * HOUR
                } else {
                    2 * HOUR
                };
                tokio::time::sleep(within(&mut rng, held)).await;
                let published = if fenced {
                    store.publish(publication, pointer(&keys)).await
                } else {
                    store
                        .put_pointer_unfenced(&name, next_save(), pointer(&keys))
                        .await
                };
                match published {
                    Ok(()) => {
                        let mut outcome = outcome.lock().unwrap();
                        outcome.published += 1;
                        for key in &keys {
                            if !present(fake, key) {
                                outcome.violations.push(format!("{name} names {key}"));
                            }
                        }
                        drop(outcome);
                        last[slot] = keys;
                    }
                    Err(Error::Superseded) => outcome.lock().unwrap().superseded += 1,
                    Err(error) => panic!("{error}"),
                }
                if rng.below(4) == 0 {
                    store.delete_pointer(&name, TEST_EPOCH).await.unwrap();
                    deletes[slot] += 1;
                    last[slot].clear();
                }
            }
        }
    };
    let sweeper = async {
        let mut rng = Rng(!seed);
        let store = ChunkStore::over_fake(&fake, "p").with_clock(skewed_clock(skew(&mut rng)));
        for _ in 0..32 {
            tokio::time::sleep(within(&mut rng, 8 * HOUR)).await;
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
/// sweeps do delete, archives do find chunks stored the same day, and
/// some archives must start again.
#[tokio::test(start_paused = true)]
async fn sweeps_never_take_what_archives_in_flight_will_name() {
    let mut total = Outcome::default();
    for seed in 0..40 {
        let outcome = simulate(seed, true).await;
        assert!(
            outcome.violations.is_empty(),
            "seed {seed}: {:?}",
            outcome.violations
        );
        total.published += outcome.published;
        total.superseded += outcome.superseded;
        total.reused += outcome.reused;
        total.deleted += outcome.deleted;
    }
    assert!(total.deleted > 100, "sweeps deleted only {}", total.deleted);
    assert!(
        total.superseded > 50 && total.published > 1_000 && total.reused > 100,
        "{total:?}"
    );
}

/// The simulation has teeth: archives held up past a sweep that publish
/// without the fence name what the sweep took.
#[tokio::test(start_paused = true)]
async fn without_the_fence_held_up_archives_name_what_sweeps_took() {
    let mut violations = 0;
    for seed in 0..40 {
        violations += simulate(seed, false).await.violations.len();
    }
    assert!(violations > 0, "no seed lost a chunk");
}
