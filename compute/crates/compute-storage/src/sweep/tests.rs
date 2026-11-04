use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use object_store::memory::InMemory;
use object_store::path::Path;

use super::*;
use crate::chunk::EncodedChunk;
use crate::fake::{Bucket, Fake, Object, Rng};
use crate::fresh::{CLOCK_SKEW, Clock, FIRST_HOUR, LEGACY_SWEEP_AFTER, day_of, period_of};
use crate::store::{Begun, Held, Publication, Put, Rewrite, TEST_EPOCH, next_save, unstamped};

mod incremental;

const SECOND: Duration = Duration::from_secs(1);
const MINUTE: Duration = Duration::from_secs(60);
const HOUR: Duration = Duration::from_secs(3_600);
const DAY: Duration = Duration::from_secs(86_400);

/// The simulated time: tokio's paused clock, from 08:00 UTC of a day, the
/// start of an hour.
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
struct Lists;

impl Names for Lists {
    type Within = ();

    fn named(&self, pointer: &[u8]) -> Result<Named<()>> {
        Ok(Named {
            keys: serde_json::from_slice(pointer)?,
            within: Vec::new(),
        })
    }

    fn within(&self, (): &()) -> impl Future<Output = Result<Option<Vec<String>>>> + Send {
        std::future::ready(Ok(Some(Vec::new())))
    }
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

/// A sweep with no record lists every period it may delete from: unnamed
/// objects there go; named ones stay, and so do recent ones, whose period
/// it does not list yet.
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

    let looked = sweep(&store, &Lists, false, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!(
        (looked.pointers, looked.named, looked.stored, looked.audit),
        (1, 1, 3, true),
        "the recent object's hour is not listed: {looked:?}"
    );
    assert_eq!((looked.unnamed, looked.deleted, looked.unknown), (2, 0, 0));
    assert_eq!(fake.names().len(), 5, "a look deletes nothing");

    let swept = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!((swept.unnamed, swept.deleted), (2, 2));
    assert_eq!(swept.deleted_bytes, looked.unnamed_bytes);
    assert!(present(&fake, &key_of(&kept)) && present(&fake, &key_of(&recent)));
    assert!(!present(&fake, &key_of(&old)) && !present(&fake, &key_of(&older)));
}

/// What was written in an hour stays until that hour ended a clock
/// disagreement before a sweep began, however late in its hour it was
/// written: an archive that began after the sweep took stock may have
/// written it on a clock behind the sweep's.
#[tokio::test(start_paused = true)]
async fn an_hours_object_stays_until_its_hour_ended_the_skew_before() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    // 08:30, in the hour that ends at 09:00.
    tokio::time::advance(30 * MINUTE).await;
    let written = put(&store, &chunk(1)).await;
    let hour = written.reference.day.unwrap();
    assert!(hour >= FIRST_HOUR, "named by its hour");
    assert_eq!(hour, period_of(store.now()));
    // To 09:59:59: the hour ended less than the skew before.
    tokio::time::advance((30 * MINUTE + CLOCK_SKEW).checked_sub(SECOND).unwrap()).await;
    let late = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!(
        (late.stored, late.deleted),
        (0, 0),
        "not listed yet: {late:?}"
    );
    assert!(present(&fake, &key_of(&written)));
    // 10:00: the hour ended the skew before, so this sweep lists it.
    tokio::time::advance(SECOND).await;
    let next = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!(
        (next.audit, next.listed, next.deleted),
        (false, 1, 1),
        "{next:?}"
    );
    assert!(!present(&fake, &key_of(&written)));
}

/// What an archive writes on a clock behind the sweep's by nearly the
/// allowed disagreement is named with an hour that ended up to that long
/// before the sweep began; a sweep that begins just after keeps it, late
/// in its hour or early.
#[tokio::test(start_paused = true)]
async fn what_a_clock_behind_by_the_skew_writes_stays_through_a_sweep_just_after() {
    let fake = Fake::new(paused_clock());
    let sweeper = ChunkStore::over_fake(&fake, "p");
    let behind = i64::try_from(CLOCK_SKEW.checked_sub(SECOND).unwrap().as_millis()).unwrap();
    let writer = ChunkStore::over_fake(&fake, "p").with_clock(skewed_clock(-behind));
    let mut written = Vec::new();
    // From 08:00 to 08:01, 08:30 and 08:59: the writer's clock reads 07:01,
    // 07:30 and 07:59, and names the hour that ended at 08:00.
    for (n, (step, minute)) in [(1, 1), (29, 30), (29, 59)].into_iter().enumerate() {
        tokio::time::advance(step * MINUTE).await;
        let put = put(&writer, &chunk(u8::try_from(n).unwrap())).await;
        assert!(
            put.reference.day < Some(period_of(sweeper.now())),
            "an hour before"
        );
        written.push(put);
        let swept = sweep(&sweeper, &Lists, true, SystemTime::UNIX_EPOCH)
            .await
            .unwrap();
        assert_eq!(swept.deleted, 0, "at minute {minute}: {swept:?}");
    }
    assert!(written.iter().all(|put| present(&fake, &key_of(put))));
}

/// An object a host of an earlier release named with its day, no pointer
/// naming it, stays until that day ended a clock disagreement before a
/// sweep began, and then goes; one named with an hour since stays by its
/// own hour.
#[tokio::test(start_paused = true)]
async fn an_earlier_releases_day_named_object_goes_once_its_day_ended_the_skew_before() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let old = chunk(1);
    let day = day_of(store.now());
    assert!(day < FIRST_HOUR, "a day, as an earlier release names it");
    let key = old.reference.on_day(day).key();
    fake.put_raw(&format!("p/{key}"), Bytes::from(old.bytes.clone()));
    // From 08:00 to 00:30 the next day, when this release writes an hour.
    tokio::time::advance(16 * HOUR + 30 * MINUTE).await;
    let recent = put(&store, &chunk(2)).await;
    // To 00:59:59: the day ended less than the skew before.
    tokio::time::advance((30 * MINUTE).checked_sub(SECOND).unwrap()).await;
    let late = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!((late.stored, late.deleted), (0, 0), "{late:?}");
    assert!(present(&fake, &key));
    // 01:00: the day ended the skew before; the hour of 00:00 not yet.
    tokio::time::advance(SECOND).await;
    let next = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!((next.stored, next.deleted), (1, 1), "{next:?}");
    assert!(!present(&fake, &key));
    assert!(present(&fake, &key_of(&recent)));
}

/// The same bytes stored again the same hour are found there and reused;
/// the next hour another host stores them anew under that hour's name, and
/// nothing writes the earlier hour's name again.
#[tokio::test(start_paused = true)]
async fn the_same_bytes_are_reused_the_same_hour_and_stored_anew_the_next() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let content = chunk(5);
    let first = put(&store, &content).await;
    assert!(first.new);
    assert_eq!(first.reference.day, Some(period_of(store.now())));
    let stored = |put: &Put| fake.object(&format!("p/{}", key_of(put))).unwrap();
    let generation = stored(&first).generation;
    // 08:59 the same hour.
    tokio::time::advance(59 * MINUTE).await;
    let again = put(&store, &content).await;
    assert_eq!(
        again,
        Put {
            new: false,
            ..first.clone()
        }
    );
    assert_eq!(stored(&first).generation, generation, "not stored again");
    // 09:01 the next hour, by another host.
    tokio::time::advance(2 * MINUTE).await;
    let uploads = *fake.puts.lock().unwrap();
    let other = ChunkStore::over_fake(&fake, "p");
    let next = put(&other, &content).await;
    assert!(next.new && !next.copied, "uploaded");
    assert_eq!(*fake.puts.lock().unwrap(), uploads + 1);
    assert_eq!(next.reference.day, first.reference.day.map(|day| day + 1));
    assert!(next.reference.same_bytes(&first.reference));
    assert_eq!(stored(&first).generation, generation);
    assert_eq!(
        store.get_chunk(&first.reference).await.unwrap(),
        store.get_chunk(&next.reference).await.unwrap()
    );
}

/// What a store stored in one hour and stores again the next, as an
/// archive a sweep's fence stopped does, it copies within the store under
/// the new hour's name instead of uploading it again.
#[tokio::test(start_paused = true)]
async fn what_a_store_stored_an_hour_before_it_copies_instead_of_uploading() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let content = chunk(5);
    let first = put(&store, &content).await;
    assert!(first.new && !first.copied);
    let uploads = *fake.puts.lock().unwrap();
    // 09:30, the next hour.
    tokio::time::advance(90 * MINUTE).await;
    let next = put(&store, &content).await;
    assert!(next.new && next.copied, "{next:?}");
    assert_eq!(next.reference.day, first.reference.day.map(|hour| hour + 1));
    assert_eq!(*fake.puts.lock().unwrap(), uploads, "no upload");
    assert_eq!(*fake.copies.lock().unwrap(), 1);
    assert_eq!(
        store.get_chunk(&next.reference).await.unwrap(),
        store.get_chunk(&first.reference).await.unwrap()
    );
    // Carried on from the copy the hour after; within an hour, found
    // there, and checked rather than sent again.
    tokio::time::advance(HOUR).await;
    assert!(put(&store, &content).await.copied);
    let again = put(&store, &content).await;
    assert!(!again.new && !again.copied, "found this hour");
    assert_eq!(*fake.copies.lock().unwrap(), 2);
    assert_eq!(*fake.puts.lock().unwrap(), uploads, "nothing sent");
}

/// When what the store stored an hour before is gone, a sweep having taken
/// it, the store uploads the bytes again.
#[tokio::test(start_paused = true)]
async fn what_a_sweep_took_meanwhile_is_uploaded_again() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let content = chunk(5);
    let first = put(&store, &content).await;
    // 10:00: the hour of 08:00 ended the skew before.
    tokio::time::advance(HOUR + CLOCK_SKEW).await;
    let swept = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!(swept.deleted, 1);
    assert!(!present(&fake, &key_of(&first)));
    let uploads = *fake.puts.lock().unwrap();
    let next = put(&store, &content).await;
    assert!(next.new && !next.copied, "{next:?}");
    assert_eq!(*fake.puts.lock().unwrap(), uploads + 1, "uploaded");
    assert_eq!(*fake.copies.lock().unwrap(), 0);
    store.get_chunk(&next.reference).await.unwrap();
}

/// On S3 an archive's tries read no chunk back: a try again the same
/// hour, carrying into the next hour, the try after a fence, and copying
/// as a try reaches each chunk all check chunks by their size and tag.
#[tokio::test(start_paused = true)]
async fn tries_and_copies_on_s3_read_no_chunk_back() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake_s3(&fake, "p");
    let contents: Vec<_> = (0..8).map(chunk).collect();
    let held = Arc::new(Held::new());
    let holding = store.clone().holding(Arc::clone(&held));
    for content in &contents {
        assert!(put(&holding, content).await.new);
    }
    for content in &contents {
        assert!(!put(&holding, content).await.new, "found this hour");
    }
    tokio::time::advance(HOUR).await;
    assert_eq!(store.keep(&held).await.copied, 8);
    for content in &contents {
        let found = put(&holding, content).await;
        assert!(!found.new && !found.copied, "carried already");
    }
    tokio::time::advance(HOUR).await;
    for content in &contents {
        assert!(put(&holding, content).await.copied);
    }
    assert_eq!(*fake.copies.lock().unwrap(), 16);
    assert_eq!(*fake.gets.lock().unwrap(), 0, "no chunk read back");
    assert!(*fake.heads.lock().unwrap() >= 8 * 4);
}

/// Archives `contents` as sandbox `name` until a publication lands, at most
/// `tries` times: each chunk uploaded takes `upload` to send, one copied or
/// found stored takes no time. With `keep`, what the tries store is
/// carried into each new hour while they run. The attempt that published,
/// if any.
async fn archive_until_published(
    store: &ChunkStore,
    name: &str,
    contents: &[EncodedChunk],
    upload: Duration,
    (tries, keep): (usize, bool),
) -> Option<usize> {
    let held = Arc::new(Held::new());
    let holding = store.clone().holding(Arc::clone(&held));
    let tries = async {
        for attempt in 1..=tries {
            let publication = holding.begin_test(name).await.unwrap();
            let mut keys = Vec::new();
            for chunk in contents {
                let put = holding.put_chunk(chunk).await.unwrap();
                if put.new && !put.copied {
                    tokio::time::sleep(upload).await;
                }
                keys.push(put.reference.key());
            }
            match holding.publish(publication, pointer(&keys)).await {
                Ok(()) => return Some(attempt),
                Err(Error::Superseded) => {}
                Err(error) => panic!("{error}"),
            }
        }
        None
    };
    if keep {
        store.keeping(&held, tries).await.0
    } else {
        tries.await
    }
}

/// `chunks` chunks of 20 minutes' upload each beside a sweep at 17 minutes
/// past every hour, by a store remembering up to `remembered` chunks,
/// carrying what it stored into each new hour with `keep`: the attempt
/// that published, and the uploads and copies it took.
async fn long_archive(chunks: u8, remembered: usize, keep: bool) -> (Option<usize>, u32, u32) {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p").remembering(remembered);
    let sweeper = tokio::spawn({
        let store = store.clone();
        async move {
            tokio::time::sleep(17 * MINUTE).await;
            loop {
                sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
                    .await
                    .unwrap();
                tokio::time::sleep(HOUR).await;
            }
        }
    });
    let contents: Vec<_> = (0..chunks).map(chunk).collect();
    let published = archive_until_published(&store, "a", &contents, 20 * MINUTE, (8, keep)).await;
    sweeper.abort();
    if published.is_some() {
        let named: Vec<String> =
            serde_json::from_slice(&store.get_pointer("a").await.unwrap().unwrap()).unwrap();
        assert!(named.iter().all(|key| present(&fake, key)), "{named:?}");
    }
    let uploads = *fake.puts.lock().unwrap();
    let copies = *fake.copies.lock().unwrap();
    (published, uploads, copies)
}

/// An archive whose uploads outlast the time between two sweeps is stopped
/// by a fence, but what it stored carries over: started again, it copies
/// what it stored in an earlier hour, uploads again only what a sweep took
/// meanwhile, and publishes. Without the copies it uploads everything again
/// each time and never publishes.
#[tokio::test(start_paused = true)]
async fn an_archive_longer_than_the_time_between_sweeps_still_publishes() {
    let (published, uploads, copies) = long_archive(6, 1_024, false).await;
    let attempts = published.expect("published");
    assert!(attempts > 1, "stopped by a fence first");
    assert!(copies > 0);
    assert!(uploads < 2 * 6, "{uploads} uploads of 6 chunks");

    let (published, uploads, copies) = long_archive(6, 0, false).await;
    assert_eq!(published, None, "{uploads} uploads");
    assert_eq!(copies, 0);
    assert!(uploads >= 8 * 5, "{uploads} uploads");
}

/// Six hours of uploads beside hourly sweeps: what the archive stored is
/// carried into each new hour while it runs, so no sweep takes any of it,
/// and the try after the last fence finds all of it and publishes, having
/// uploaded each chunk once. Copied only as each try reaches a chunk, what
/// it uploads again delays the copies until sweeps took those chunks too,
/// and it never publishes.
#[tokio::test(start_paused = true)]
async fn an_archive_of_six_hours_publishes_beside_hourly_sweeps() {
    let (published, uploads, copies) = long_archive(18, 1_024, true).await;
    assert!(
        published.expect("published") > 1,
        "stopped by a fence first"
    );
    assert_eq!(uploads, 18, "each chunk uploaded once");
    assert!(copies > 18, "{copies} copies");

    let (published, uploads, _) = long_archive(18, 1_024, false).await;
    assert_eq!(published, None, "{uploads} uploads");
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
    let looked = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
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

    let young = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!(young.tombstones, 1);
    assert_eq!(
        fake.bytes("p/pointers/v3/a"),
        Some(tombstone.clone()),
        "not stored again"
    );
    tokio::time::advance(30 * DAY).await;
    let old = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
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
    let swept = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!(swept.tombstones, 1, "{swept:?}");

    let late = archiving.await.unwrap();
    assert!(matches!(late, Ok(Begun::Deleted)), "{late:?}");
    assert_eq!(fake.bytes("p/pointers/v3/a"), Some(tombstone));
    assert_eq!(store.get_pointer("a").await.unwrap(), None);
}

/// The race a deadline cannot close: an archive reuses a chunk another
/// write stored the same hour, its pointer write is held up in flight for
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
    let swept = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
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

/// Why an archive never reuses an object of an earlier hour it finds by
/// its name: a sweep that took stock before the archive began deletes it
/// all the same, and the archive's pointer then names what is gone. What
/// the archive stores itself, under this hour's name, the sweep leaves.
#[tokio::test(start_paused = true)]
async fn an_earlier_hours_object_found_by_name_is_not_safe_to_reuse() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let content = chunk(3);
    let old = put(&store, &content).await;
    // 10:00: the hour of 08:00 ended the skew before.
    tokio::time::advance(HOUR + CLOCK_SKEW).await;
    // Held up between taking stock and deleting.
    *fake.stall.lock().unwrap() = Some(("chunks/", HOUR));
    let sweeping = tokio::spawn({
        let store = store.clone();
        async move { sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH).await }
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
    assert!(anew.new, "this hour's name is a new object");
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
/// under a later hour's name, so no delete needs a condition.
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
        async move { sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH).await }
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
/// disagreements) before the sweep began, the old layout being listed
/// again by each sweep until then. Keys of no known layout stay.
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
    let odd_in_an_hour = format!("p/chunks/v2/{}/odd", period_of(store.now()));
    fake.put_raw(&odd_in_an_hour, Bytes::from_static(b"?"));
    let publication = store.begin_test("a").await.unwrap();
    store
        .publish(publication, pointer(&[named.object_key()]))
        .await
        .unwrap();
    store.get_chunk(&named.reference).await.unwrap();

    tokio::time::advance(LEGACY_SWEEP_AFTER.checked_sub(SECOND).unwrap()).await;
    let young = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!((young.recent, young.unknown, young.deleted), (2, 1, 0));
    tokio::time::advance(2 * SECOND).await;
    let old = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!(
        (old.audit, old.named, old.deleted),
        (false, 1, 2),
        "{old:?}"
    );
    assert!(present(&fake, &named.object_key()));
    assert!(!present(&fake, &unnamed.object_key()));
    assert!(fake.bytes("p/chunks/v9/odd").is_some());
    assert!(fake.bytes(&odd_in_an_hour).is_some());
}

/// Only pointers from before they moved name objects of the old layout,
/// so none goes until the pointers have been where the sweep reads them
/// for a week: a pointer every listing of a store catching up missed is
/// adopted well before then.
#[tokio::test(start_paused = true)]
async fn old_layout_objects_stay_for_a_week_after_the_pointers_moved() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let unnamed = chunk(2);
    fake.put_raw(
        &format!("p/{}", unnamed.object_key()),
        Bytes::from(unnamed.bytes.clone()),
    );
    tokio::time::advance(LEGACY_SWEEP_AFTER + DAY).await;
    let moved = store.now() - DAY;
    let kept = sweep(&store, &Lists, true, moved).await.unwrap();
    assert_eq!((kept.recent, kept.deleted), (1, 0), "moved only a day ago");
    assert!(present(&fake, &unnamed.object_key()));
    tokio::time::advance(LEGACY_SWEEP_AFTER).await;
    let swept = sweep(&store, &Lists, true, moved).await.unwrap();
    assert_eq!((swept.unnamed, swept.deleted), (1, 1));
    assert!(!present(&fake, &unnamed.object_key()));
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
    let swept = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
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
    let refused = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH).await;
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
    let swept = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
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
    /// Archives that gave up, superseded on every try.
    gave_up: usize,
    /// Chunks found stored the same hour by another write.
    reused: usize,
    /// Chunks an archive copied from what its store stored an hour before.
    copied: usize,
    /// Chunks an archive in flight carried into a new hour.
    carried: usize,
    deleted: usize,
    /// Deleted as what a pointer named before and none names now, without
    /// listing their period again.
    retired: usize,
    /// Deletes of what a stored pointer named, and pointers published
    /// naming what was gone.
    violations: Vec<String>,
}

/// A random wait of up to `most`.
fn within(rng: &mut Rng, most: Duration) -> Duration {
    let most = u64::try_from(most.as_millis()).unwrap();
    Duration::from_millis(rng.below(most + 1))
}

/// A clock offset from the store's of up to half the allowed disagreement,
/// in milliseconds either way, so that any two clocks disagree by up to
/// [`CLOCK_SKEW`]: under the hour rule a sweep and a writer whose clocks
/// are further apart can lose a chunk, which a seed of the simulation finds.
fn skew(rng: &mut Rng) -> i64 {
    let most = u64::try_from(CLOCK_SKEW.as_millis()).unwrap() / 2;
    i64::try_from(rng.below(2 * most + 1)).unwrap() - i64::try_from(most).unwrap()
}

/// How a simulation's archives run.
#[derive(Clone, Copy)]
struct Run {
    /// Whether archives publish on condition; otherwise they replace their
    /// pointers whatever they hold.
    fenced: bool,
    /// The longest a chunk takes to upload; one copied or found stored
    /// takes no time.
    upload: Duration,
    /// How many chunks each archive's store remembers, to copy.
    remembered: usize,
    /// Whether an archive carries what it stored into each new hour while
    /// its tries run.
    keep: bool,
}

impl Run {
    const FENCED: Self = Self {
        fenced: true,
        upload: Duration::from_secs(5 * 60),
        remembered: 1_024,
        keep: true,
    };
}

/// Stores the chunks of `contents` that `picks` names, each upload taking
/// up to `run.upload`, counting in `outcome` those found or copied; the
/// keys naming them.
async fn store_picks(
    store: &ChunkStore,
    contents: &[EncodedChunk],
    picks: &[usize],
    rng: &mut Rng,
    run: Run,
    outcome: &Mutex<Outcome>,
) -> Vec<String> {
    let mut keys = Vec::with_capacity(picks.len());
    for &pick in picks {
        let put = store.put_chunk(&contents[pick]).await.unwrap();
        {
            let mut outcome = outcome.lock().unwrap();
            outcome.reused += usize::from(!put.new);
            outcome.copied += usize::from(put.copied);
        }
        keys.push(put.reference.key());
        if put.new && !put.copied {
            tokio::time::sleep(within(rng, run.upload)).await;
        }
    }
    keys
}

/// How many times an archive superseded by a fence starts again.
const TRIES: usize = 4;

/// Publishes `keys` as sandbox `name`, on condition if `run` is fenced,
/// counting in `outcome` what happened and any key named that is gone:
/// whether it landed.
async fn publish_keys(
    store: &ChunkStore,
    publication: Publication,
    name: &str,
    keys: &[String],
    run: Run,
    fake: &Fake,
    outcome: &Mutex<Outcome>,
) -> bool {
    let published = if run.fenced {
        store.publish(publication, pointer(keys)).await
    } else {
        store
            .put_pointer_unfenced(name, next_save(), pointer(keys))
            .await
    };
    let mut outcome = outcome.lock().unwrap();
    match published {
        Ok(()) => {
            outcome.published += 1;
            for key in keys {
                if !present(fake, key) {
                    outcome.violations.push(format!("{name} names {key}"));
                }
            }
            true
        }
        Err(Error::Superseded) => {
            outcome.superseded += 1;
            false
        }
        Err(error) => panic!("{error}"),
    }
}

/// Six archives at a time over about a week, each archiving one of its
/// two sandboxes again and again: reusing part of what its last copy
/// named, storing (or finding stored the same hour) up to three of sixteen
/// chunks, each taking up to `run.upload` to upload, and now and then held
/// up for up to two days before it publishes; starting again when a fence
/// stopped it, as a host does, carrying what its tries stored into each new
/// hour meanwhile; sometimes deleting a copy. One sweep after another runs
/// beside them, about hourly. Each archive and the sweep read their own
/// clock, off the store's by up to the allowed disagreement, and every
/// request waits up to three seconds, as the seed picks.
async fn simulate(seed: u64, run: Run) -> Outcome {
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
                .with_clock(skewed_clock(skew(&mut rng)))
                .remembering(run.remembered);
            // A deleted sandbox's name is never used again.
            let mut deletes = [0_u64; 2];
            // What each sandbox's pointer names: its last publication.
            let mut last: [Vec<String>; 2] = Default::default();
            for _round in 0..12 {
                tokio::time::sleep(within(&mut rng, 8 * HOUR)).await;
                let slot = usize::try_from(rng.below(2)).unwrap();
                let name = format!("w{w}s{slot}d{}", deletes[slot]);
                let kept: Vec<String> = last[slot]
                    .iter()
                    .filter(|_| rng.below(2) == 0)
                    .cloned()
                    .collect();
                let picks: Vec<usize> = (0..=rng.below(3))
                    .map(|_| usize::try_from(rng.below(16)).unwrap())
                    .collect();
                let held = if rng.below(4) == 0 {
                    48 * HOUR
                } else {
                    10 * MINUTE
                };
                let carried = Arc::new(Held::new());
                let holding = store.clone().holding(Arc::clone(&carried));
                let tries = async {
                    for attempt in 1..=TRIES {
                        let publication = holding.begin_test(&name).await.unwrap();
                        let mut keys = kept.clone();
                        let stored =
                            store_picks(&holding, contents, &picks, &mut rng, run, outcome);
                        keys.extend(stored.await);
                        keys.sort();
                        keys.dedup();
                        if attempt == 1 {
                            tokio::time::sleep(within(&mut rng, held)).await;
                        }
                        let landed =
                            publish_keys(&holding, publication, &name, &keys, run, fake, outcome);
                        if landed.await {
                            return Some(keys);
                        }
                        outcome.lock().unwrap().gave_up += usize::from(attempt == TRIES);
                    }
                    None
                };
                let published = if run.keep {
                    let (published, kept) = store.keeping(&carried, tries).await;
                    outcome.lock().unwrap().carried += kept.copied;
                    published
                } else {
                    tries.await
                };
                if let Some(keys) = published {
                    last[slot] = keys;
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
        for _ in 0..200 {
            tokio::time::sleep(within(&mut rng, 2 * HOUR)).await;
            let report = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
                .await
                .unwrap();
            let mut outcome = outcome.lock().unwrap();
            outcome.deleted += report.deleted;
            outcome.retired += report.retired;
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
/// sweeps do delete, archives do find chunks stored the same hour and copy
/// what they stored an hour before, and some archives must start again.
#[tokio::test(start_paused = true)]
async fn sweeps_never_take_what_archives_in_flight_will_name() {
    let mut total = Outcome::default();
    for seed in 0..40 {
        let outcome = simulate(seed, Run::FENCED).await;
        assert!(
            outcome.violations.is_empty(),
            "seed {seed}: {:?}",
            outcome.violations
        );
        total.published += outcome.published;
        total.superseded += outcome.superseded;
        total.reused += outcome.reused;
        total.copied += outcome.copied;
        total.deleted += outcome.deleted;
        total.retired += outcome.retired;
    }
    assert!(total.deleted > 100, "sweeps deleted only {}", total.deleted);
    assert!(total.retired > 10, "{total:?}");
    assert!(
        total.superseded > 50 && total.published > 1_000 && total.reused > 100,
        "{total:?}"
    );
    assert!(total.copied > 100, "{total:?}");
}

/// The total of `seeds` simulations under `run`, failing on any violation.
async fn simulated(seeds: u64, run: Run) -> Outcome {
    let mut total = Outcome::default();
    for seed in 0..seeds {
        let outcome = simulate(seed, run).await;
        assert!(
            outcome.violations.is_empty(),
            "seed {seed}: {:?}",
            outcome.violations
        );
        total.published += outcome.published;
        total.superseded += outcome.superseded;
        total.gave_up += outcome.gave_up;
        total.copied += outcome.copied;
        total.carried += outcome.carried;
    }
    total
}

/// Archives whose chunks take up to an hour each to upload, a few hours in
/// all, beside sweeps about hourly: a fence stops many, and started again
/// they find what they carried into the new hour and publish; none gives
/// up. Copying only as a try reaches each chunk, some give up, and without
/// copies many more do, uploading everything again on every try.
#[tokio::test(start_paused = true)]
async fn long_archives_publish_beside_hourly_sweeps() {
    let long = Run {
        upload: HOUR,
        ..Run::FENCED
    };
    let kept = simulated(40, long).await;
    assert_eq!(kept.gave_up, 0, "{kept:?}");
    assert!(kept.carried > 1_000 && kept.superseded > 1_000, "{kept:?}");
    let copied = simulated(
        40,
        Run {
            keep: false,
            ..long
        },
    )
    .await;
    let neither = simulated(
        40,
        Run {
            keep: false,
            remembered: 0,
            ..long
        },
    )
    .await;
    assert!(copied.gave_up > 0, "{copied:?}");
    assert!(
        copied.gave_up * 4 < neither.gave_up,
        "{copied:?} {neither:?}"
    );
}

/// The simulation has teeth: archives held up past a sweep that publish
/// without the fence name what the sweep took.
#[tokio::test(start_paused = true)]
async fn without_the_fence_held_up_archives_name_what_sweeps_took() {
    let mut violations = 0;
    for seed in 0..40 {
        let run = Run {
            fenced: false,
            ..Run::FENCED
        };
        violations += simulate(seed, run).await.violations.len();
    }
    assert!(violations > 0, "no seed lost a chunk");
}
