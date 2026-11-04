//! A sweep lists each period once it may delete from it, reads each
//! manifest once, and leaves what fails to the next sweep (ADR 29).

use super::*;
use crate::chunk::ChunkRef;
use crate::copy::{Copies, Head, VERSION};
use crate::manifest::{DiskManifest, Extent, ExtentSource};
use crate::sweep::stock::{decode, encode, print};

/// A disk of `references`, stored as a manifest, and the head of a copy
/// naming it: what the copy's pointer holds, and the manifest's key.
async fn copy_of(store: &ChunkStore, references: &[ChunkRef]) -> (Vec<u8>, String) {
    let mut extents = Vec::new();
    let mut offset = 0;
    for reference in references {
        let length = u64::from(reference.plain_len);
        extents.push(Extent {
            offset,
            length,
            source: ExtentSource::Chunk {
                reference: reference.clone(),
                offset: 0,
            },
        });
        offset += length;
    }
    let manifest = DiskManifest {
        version: 1,
        disk_len: offset,
        base_len: 0,
        base_digest: "0".repeat(64),
        extents,
    };
    let name = store.put_manifest(&manifest).await.unwrap();
    let key = ChunkStore::manifest_key(&name).unwrap();
    let head = Head {
        version: VERSION,
        disk: name,
        memory: None,
        profile: None,
        pack: None,
    };
    (serde_json::to_vec(&head).unwrap(), key)
}

async fn publish(store: &ChunkStore, name: &str, pointer: Vec<u8>) {
    let publication = store.begin_test(name).await.unwrap();
    store.publish(publication, pointer).await.unwrap();
}

/// The prefixes of chunks and manifests listed since `from`, by delimiter
/// or not.
fn listed_since(fake: &Fake, from: usize) -> Vec<String> {
    fake.listed.lock().unwrap()[from..]
        .iter()
        .filter(|prefix| !prefix.starts_with("p/pointers/"))
        .cloned()
        .collect()
}

fn listings(fake: &Fake) -> usize {
    fake.listed.lock().unwrap().len()
}

/// The prefixes listing hour `hour` lists.
fn of_hour(hour: u32) -> Vec<String> {
    vec![
        format!("p/manifests/v2/{hour}/"),
        format!("p/chunks/v2/{hour}/"),
        format!("p/packs/v1/{hour}/"),
    ]
}

/// A sweep reads a manifest once and keeps a record of what it names, which
/// the next sweep believes; and each sweep lists only the hours that became
/// old enough since the last.
#[tokio::test(start_paused = true)]
async fn a_manifest_is_read_once_and_an_hour_listed_once() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let hour = period_of(store.now());
    let parts = [put(&store, &chunk(1)).await, put(&store, &chunk(2)).await];
    let (head, manifest) = copy_of(
        &store,
        &[parts[0].reference.clone(), parts[1].reference.clone()],
    )
    .await;
    publish(&store, "a", head).await;
    let copies = Copies(&store);

    // 11:00: the first sweep lists every hour stored it may delete from.
    tokio::time::advance(3 * HOUR).await;
    let first = sweep(&store, &copies, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!(
        (first.audit, first.read, first.remembered),
        (true, 1, 0),
        "{first:?}"
    );
    assert_eq!(
        (first.named, first.stored, first.deleted),
        (3, 3, 0),
        "{first:?}"
    );
    assert!(
        fake.bytes(&format!("p/sweep/v1/within/{manifest}"))
            .is_some(),
        "a record"
    );

    // 12:00: one more hour is old enough, and the record answers.
    tokio::time::advance(HOUR).await;
    let from = listings(&fake);
    let next = sweep(&store, &copies, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!(
        (next.audit, next.read, next.remembered),
        (false, 0, 1),
        "{next:?}"
    );
    assert_eq!(next.named, 3);
    assert_eq!(
        listed_since(&fake, from),
        of_hour(hour + 2),
        "only 10:00 is new"
    );
    assert!(present(&fake, &manifest) && present(&fake, &key_of(&parts[1])));
}

/// What a replaced copy alone named, in an hour listed already, goes as
/// soon as no pointer names it, without listing that hour again; what the
/// new copy still names stays.
#[tokio::test(start_paused = true)]
async fn what_a_replaced_copy_alone_named_goes_without_listing_its_hour_again() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let hour = period_of(store.now());
    let (kept, dropped) = (put(&store, &chunk(1)).await, put(&store, &chunk(2)).await);
    let (head, first_manifest) =
        copy_of(&store, &[kept.reference.clone(), dropped.reference.clone()]).await;
    publish(&store, "a", head).await;
    let copies = Copies(&store);
    tokio::time::advance(3 * HOUR).await;
    let first = sweep(&store, &copies, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!(first.deleted, 0);

    // 11:00: the copy is replaced, reusing one chunk of 08:00.
    let added = put(&store, &chunk(3)).await;
    let (head, second_manifest) =
        copy_of(&store, &[kept.reference.clone(), added.reference.clone()]).await;
    publish(&store, "a", head).await;
    tokio::time::advance(2 * HOUR).await;
    let from = listings(&fake);
    let next = sweep(&store, &copies, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!(
        next.deleted, 2,
        "the dropped chunk and the first manifest: {next:?}"
    );
    assert!(next.candidates >= 3, "{next:?}");
    assert!(!present(&fake, &key_of(&dropped)) && !present(&fake, &first_manifest));
    for named in [key_of(&kept), key_of(&added), second_manifest] {
        assert!(present(&fake, &named), "{named}");
    }
    let listed = listed_since(&fake, from);
    assert!(
        !listed.iter().any(|prefix| of_hour(hour).contains(prefix)),
        "{listed:?}"
    );
    assert_eq!(
        listed,
        [of_hour(hour + 3), of_hour(hour + 2)].concat(),
        "newest first"
    );
    assert!(
        fake.bytes(&format!("p/sweep/v1/within/{first_manifest}"))
            .is_none(),
        "its record goes with it"
    );
}

/// An hour that cannot be listed, after trying again, is left to the next
/// sweep, which lists only it; the others are done.
#[tokio::test(start_paused = true)]
async fn an_hour_that_fails_to_list_is_listed_again_by_the_next_sweep_alone() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let hour = period_of(store.now());
    let early = put(&store, &chunk(1)).await;
    tokio::time::advance(HOUR).await;
    let late = put(&store, &chunk(2)).await;
    tokio::time::advance(2 * HOUR).await;
    // Every try at the first hour's chunks times out.
    let failing: &'static str = Box::leak(format!("chunks/v2/{hour}/").into_boxed_str());
    *fake.failing.lock().unwrap() = Some((failing, 3));
    let first = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!(
        (first.failed, first.deleted, first.left),
        (1, 1, 1),
        "{first:?}"
    );
    assert!(present(&fake, &key_of(&early)) && !present(&fake, &key_of(&late)));

    tokio::time::advance(5 * MINUTE).await;
    let from = listings(&fake);
    let next = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!(
        (next.failed, next.deleted, next.left),
        (0, 1, 0),
        "{next:?}"
    );
    assert_eq!(listed_since(&fake, from), of_hour(hour));
    assert!(!present(&fake, &key_of(&early)));
}

/// A read of a pointer that times out once is tried again, and the sweep
/// goes on.
#[tokio::test(start_paused = true)]
async fn a_pointer_read_that_times_out_once_is_tried_again() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let named = put(&store, &chunk(1)).await;
    let unnamed = put(&store, &chunk(2)).await;
    publish(&store, "a", pointer(&[key_of(&named)])).await;
    tokio::time::advance(3 * HOUR).await;
    *fake.failing.lock().unwrap() = Some(("pointers/v3/a", 1));
    let swept = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!((swept.named, swept.deleted), (1, 1), "{swept:?}");
    assert_eq!(fake.failing.lock().unwrap().unwrap().1, 0, "it failed once");
    assert!(present(&fake, &key_of(&named)) && !present(&fake, &key_of(&unnamed)));
}

/// A listing the store drops partway is listed again from after the last
/// page done, not from the start.
#[tokio::test(start_paused = true)]
async fn a_listing_dropped_partway_goes_on_after_the_last_page_done() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let hour = period_of(store.now());
    // Keys of no layout this build knows are listed and never deleted.
    for n in 0..1_500 {
        fake.put_raw(
            &format!("p/chunks/v2/{hour}/odd{n:04}"),
            Bytes::from_static(b"?"),
        );
    }
    let unnamed = put(&store, &chunk(1)).await;
    tokio::time::advance(3 * HOUR).await;
    let chunks: &'static str = Box::leak(format!("chunks/v2/{hour}/").into_boxed_str());
    *fake.cut.lock().unwrap() = Some((chunks, 1_200));
    let swept = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!((swept.failed, swept.left), (0, 0), "{swept:?}");
    assert_eq!(swept.unknown, 1_500, "each once: {swept:?}");
    assert_eq!((swept.stored, swept.deleted), (1_501, 1));
    assert!(!present(&fake, &key_of(&unnamed)));
}

/// A sweep that runs out of time leaves the rest to the next, which goes on
/// where it stopped, newest first.
#[tokio::test(start_paused = true)]
async fn a_listing_cut_short_goes_on_where_it_stopped() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let hour = period_of(store.now());
    let mut stored = Vec::new();
    for n in 0..4 {
        stored.push(put(&store, &chunk(n)).await);
        tokio::time::advance(HOUR).await;
    }
    tokio::time::advance(2 * HOUR).await;
    let mut order = Vec::new();
    for left in (0..5).rev() {
        let from = listings(&fake);
        let swept = sweep_within(&store, &Lists, true, SystemTime::UNIX_EPOCH, Duration::ZERO)
            .await
            .unwrap();
        assert_eq!((swept.listed, swept.left), (1, left), "{swept:?}");
        order.extend(listed_since(&fake, from));
    }
    let hours: Vec<String> = (0..4).rev().flat_map(|n| of_hour(hour + n)).collect();
    let legacy = ["p/manifests/v1/".to_owned(), "p/chunks/v1/".to_owned()];
    // The first sweep also found the hours stored, by delimiter, and its
    // records.
    let found = [
        "p/manifests/v2/".to_owned(),
        "p/chunks/v2/".to_owned(),
        "p/packs/v1/".to_owned(),
        "p/sweep/v1/within/".to_owned(),
    ];
    assert_eq!(order, [&found[..], &hours, &legacy].concat());
    assert!(stored.iter().all(|put| !present(&fake, &key_of(put))));
}

/// A record is believed only whole and under the key it was kept for; a
/// damaged one makes the sweep read the manifest again and keep it anew.
#[tokio::test(start_paused = true)]
async fn a_record_is_believed_only_whole() {
    let prints = [print("a"), print("b")];
    let record = encode("manifests/v2/1/x.json", &prints);
    assert_eq!(
        decode("manifests/v2/1/x.json", &record),
        Some(prints.to_vec())
    );
    assert_eq!(
        decode("manifests/v2/2/x.json", &record),
        None,
        "another key"
    );
    let mut damaged = record.to_vec();
    damaged[13] ^= 1;
    assert_eq!(decode("manifests/v2/1/x.json", &damaged), None);
    assert_eq!(
        decode("manifests/v2/1/x.json", &record[..record.len() - 1]),
        None
    );
    assert_eq!(
        decode(
            "manifests/v2/1/x.json",
            &encode("manifests/v2/1/x.json", &[])
        ),
        Some(vec![])
    );

    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let part = put(&store, &chunk(1)).await;
    let (head, manifest) = copy_of(&store, std::slice::from_ref(&part.reference)).await;
    publish(&store, "a", head).await;
    tokio::time::advance(3 * HOUR).await;
    let copies = Copies(&store);
    sweep(&store, &copies, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    let kept = format!("p/sweep/v1/within/{manifest}");
    let whole = fake.bytes(&kept).unwrap();
    // One that names nothing would let the chunk go.
    fake.put_raw(
        &kept,
        Bytes::from(encode("manifests/v2/1/x.json", &[]).to_vec()),
    );
    tokio::time::advance(2 * HOUR).await;
    let swept = sweep(&store, &copies, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!(
        (swept.read, swept.remembered, swept.named),
        (1, 0, 2),
        "{swept:?}"
    );
    assert_eq!(fake.bytes(&kept), Some(whole), "kept anew");
    assert!(present(&fake, &key_of(&part)));
}

/// What lands in an hour after a sweep listed it, as a write held up in
/// flight past the fence can, waits for the daily listing of everything.
#[tokio::test(start_paused = true)]
async fn the_daily_listing_finds_what_a_write_held_up_in_flight_left_behind() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let hour = period_of(store.now());
    put(&store, &chunk(1)).await;
    tokio::time::advance(3 * HOUR).await;
    sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    let late = chunk(2).reference.on_day(hour).key();
    fake.put_raw(&format!("p/{late}"), Bytes::from(chunk(2).bytes.clone()));
    tokio::time::advance(HOUR).await;
    let hourly = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!((hourly.audit, hourly.deleted), (false, 0), "{hourly:?}");
    assert!(present(&fake, &late));
    tokio::time::advance(AUDIT_EVERY).await;
    let daily = sweep(&store, &Lists, true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert!(daily.audit && daily.deleted >= 1, "{daily:?}");
    assert!(!present(&fake, &late));
}

/// A sweep that only looks writes nothing, not even its record, and
/// reports what a sweep that deletes would delete.
#[tokio::test(start_paused = true)]
async fn a_look_writes_nothing() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let part = put(&store, &chunk(1)).await;
    let (head, _) = copy_of(&store, std::slice::from_ref(&part.reference)).await;
    publish(&store, "a", head).await;
    put(&store, &chunk(2)).await;
    tokio::time::advance(3 * HOUR).await;
    let before = fake.names();
    let looked = sweep(&store, &Copies(&store), false, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!((looked.unnamed, looked.deleted), (1, 0), "{looked:?}");
    assert_eq!(fake.names(), before);
}
