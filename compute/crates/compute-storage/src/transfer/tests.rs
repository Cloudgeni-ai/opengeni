use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use object_store::ObjectStore;
use object_store::memory::InMemory;
use object_store::path::Path;

use super::*;
use crate::chunk::{ChunkRef, EncodedChunk};
use crate::copy::{Head, MemoryHead, VERSION};
use crate::fresh::Clock;
use crate::manifest::{DiskManifest, Extent, ExtentSource};
use crate::store::TEST_EPOCH;

fn at() -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_800_000_000)
}

/// A store over its own memory, and that memory, under prefix `p`.
fn store() -> (ChunkStore, Arc<InMemory>) {
    let backend = Arc::new(InMemory::new());
    let store = ChunkStore::new(backend.clone(), Path::from("p")).with_clock(Clock::from_fn(at));
    (store, backend)
}

/// Every key under the prefix, outside the pointers and quarantine.
async fn keys(backend: &InMemory) -> BTreeSet<String> {
    let listed: Vec<_> = futures::TryStreamExt::try_collect(backend.list(None))
        .await
        .unwrap();
    listed
        .into_iter()
        .map(|meta| meta.location.as_ref().trim_start_matches("p/").to_owned())
        .filter(|key| key.starts_with("chunks/") || key.starts_with("manifests/"))
        .collect()
}

async fn chunk(store: &ChunkStore, n: u8) -> ChunkRef {
    store
        .put_chunk(&EncodedChunk::encode(&[n; 4096], 1).unwrap())
        .await
        .unwrap()
        .reference
}

/// A disk of the chunks `chunks`, stored, by its name.
async fn disk(store: &ChunkStore, chunks: &[&ChunkRef]) -> String {
    let extents = chunks
        .iter()
        .zip(0_u64..)
        .map(|(reference, n)| Extent {
            offset: n * 4096,
            length: 4096,
            source: ExtentSource::Chunk {
                reference: (*reference).clone(),
                offset: 0,
            },
        })
        .collect::<Vec<_>>();
    let manifest = DiskManifest {
        version: 1,
        disk_len: 4096 * extents.len() as u64,
        base_len: 0,
        base_digest: "0".repeat(64),
        extents,
    };
    store.put_manifest(&manifest).await.unwrap()
}

async fn publish(store: &ChunkStore, name: &str, head: &Head) {
    let publication = store.begin_test(name).await.unwrap();
    store
        .publish(publication, serde_json::to_vec(head).unwrap())
        .await
        .unwrap();
}

fn disk_only(disk: String) -> Head {
    Head {
        version: VERSION,
        disk,
        memory: None,
        profile: None,
        pack: None,
    }
}

/// The keys of `parts`.
fn keyed(parts: &[Part]) -> BTreeSet<String> {
    parts.iter().map(|part| part.key().unwrap()).collect()
}

/// A sandbox saved with its memory, a working-set pack and a profile; an
/// image; a deleted sandbox; an archive that has not published; and a
/// chunk nothing names. Answers what the pointers keep.
async fn archive(from: &ChunkStore) -> BTreeSet<String> {
    let (shared, own) = (chunk(from, 1).await, chunk(from, 2).await);
    let (state, memory) = (chunk(from, 3).await, chunk(from, 4).await);
    let (profile, page) = (chunk(from, 5).await, chunk(from, 6).await);
    let index = from
        .put_chunk(
            &EncodedChunk::encode(
                &serde_json::to_vec(&serde_json::json!({ "parts": [{ "chunk": page }] })).unwrap(),
                1,
            )
            .unwrap(),
        )
        .await
        .unwrap()
        .reference;
    let head = Head {
        version: VERSION,
        disk: disk(from, &[&shared, &own]).await,
        memory: Some(MemoryHead {
            state: disk(from, &[&state]).await,
            memory: disk(from, &[&memory]).await,
            runtime: None,
        }),
        profile: Some(profile),
        pack: Some(index),
    };
    publish(from, "sandbox", &head).await;
    let image = disk_only(disk(from, &[&shared]).await);
    publish(from, "image", &image).await;
    publish(
        from,
        "deleted",
        &disk_only(disk(from, &[&chunk(from, 7).await]).await),
    )
    .await;
    from.delete_pointer("deleted", TEST_EPOCH).await.unwrap();
    let _unpublished = from.begin_test("unpublished").await.unwrap();
    chunk(from, 8).await;

    let mut kept = keyed(
        &parts(from, &serde_json::to_vec(&head).unwrap())
            .await
            .unwrap(),
    );
    kept.extend(keyed(
        &parts(from, &serde_json::to_vec(&image).unwrap())
            .await
            .unwrap(),
    ));
    assert_eq!(kept.len(), 11, "6 chunks, a pack index and 4 manifests");
    kept
}

#[tokio::test]
async fn every_object_a_pointer_keeps_is_copied_and_nothing_else() {
    let (from, from_backend) = self::store();
    let (to, to_backend) = self::store();
    let kept = archive(&from).await;

    let report = copy(&from, &to, 4).await.unwrap();
    assert!(report.complete(), "{report:?}");
    assert_eq!(
        (report.pointers, report.tombstones, report.named),
        (4, 1, 11)
    );
    assert_eq!((report.present, report.copied), (0, 11));
    assert_eq!(keys(&to_backend).await, kept);
    let mut size = 0;
    for key in &kept {
        let path = Path::from(format!("p/{key}"));
        let bytes = from_backend
            .get(&path)
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        size += bytes.len() as u64;
        assert_eq!(
            to_backend.get(&path).await.unwrap().bytes().await.unwrap(),
            bytes
        );
    }
    assert_eq!(report.copied_bytes, size);
    // The copy reads as the original does, through the same pointers.
    let moved = to.with_pointers(Arc::new(from.object_pointers()));
    let Stock::Holds(sandbox) = moved.look("sandbox").await.unwrap() else {
        panic!("the sandbox's pointer");
    };
    for part in parts(&moved, &sandbox).await.unwrap() {
        match part {
            Part::Manifest(name) => {
                moved.get_manifest(&name).await.unwrap();
            }
            Part::Chunk(reference) => {
                moved.get_chunk(&reference).await.unwrap();
            }
        }
    }
    // Only read from.
    assert!(
        keys(&from_backend).await.len() > kept.len(),
        "what nothing names stays behind"
    );
}

#[tokio::test]
async fn a_second_copy_copies_only_what_was_stored_since() {
    let (from, _) = self::store();
    let (to, to_backend) = self::store();
    let mut kept = archive(&from).await;
    let first = copy(&from, &to, 4).await.unwrap();
    assert_eq!(first.copied, 11);

    let new = chunk(&from, 9).await;
    let shared = chunk(&from, 1).await;
    let head = disk_only(disk(&from, &[&shared, &new]).await);
    publish(&from, "later", &head).await;
    kept.extend(keyed(
        &parts(&from, &serde_json::to_vec(&head).unwrap())
            .await
            .unwrap(),
    ));

    let second = copy(&from, &to, 4).await.unwrap();
    assert!(second.complete(), "{second:?}");
    assert_eq!((second.named, second.present, second.copied), (13, 11, 2));
    assert_eq!(keys(&to_backend).await, kept);
    let third = copy(&from, &to, 4).await.unwrap();
    assert_eq!((third.present, third.copied), (13, 0));
}

#[tokio::test]
async fn what_cannot_be_read_is_reported_and_the_rest_copied() {
    let (from, from_backend) = self::store();
    let (to, to_backend) = self::store();
    let kept = archive(&from).await;
    // A chunk damaged where it is stored, same length.
    let damaged = chunk(&from, 10).await;
    let path = Path::from(format!("p/{}", damaged.key()));
    let mut bytes = from_backend
        .get(&path)
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap()
        .to_vec();
    bytes[0] ^= 1;
    from_backend.put(&path, bytes.into()).await.unwrap();
    publish(&from, "damaged", &disk_only(disk(&from, &[&damaged]).await)).await;
    // A copy whose manifest is gone.
    let lost = disk(&from, &[&chunk(&from, 11).await]).await;
    from_backend
        .delete(&Path::from(format!(
            "p/{}",
            ChunkStore::manifest_key(&lost).unwrap()
        )))
        .await
        .unwrap();
    publish(&from, "lost", &disk_only(lost)).await;

    let report = copy(&from, &to, 4).await.unwrap();
    assert!(!report.complete());
    assert_eq!(
        report
            .unreadable
            .iter()
            .map(|unread| unread.name.as_str())
            .collect::<Vec<_>>(),
        ["lost"]
    );
    assert_eq!(
        report
            .failed
            .iter()
            .map(|unread| unread.name.clone())
            .collect::<Vec<_>>(),
        [damaged.key()]
    );
    assert_eq!(report.copied, 12, "all but the damaged chunk");
    let held = keys(&to_backend).await;
    assert!(held.is_superset(&kept));
    assert!(!held.contains(&damaged.key()));
}

#[tokio::test]
async fn other_bytes_under_a_name_in_the_new_store_are_copied_over() {
    let (from, _) = self::store();
    let (to, to_backend) = self::store();
    let reference = chunk(&from, 1).await;
    publish(&from, "a", &disk_only(disk(&from, &[&reference]).await)).await;
    let path = Path::from(format!("p/{}", reference.key()));
    to_backend
        .put(&path, Bytes::from_static(b"left by a bad write").into())
        .await
        .unwrap();

    let report = copy(&from, &to, 1).await.unwrap();
    assert!(report.complete(), "{report:?}");
    assert_eq!((report.present, report.copied), (0, 2));
    to.get_chunk(&reference).await.unwrap();
    let listed: Vec<_> =
        futures::TryStreamExt::try_collect(to_backend.list(Some(&Path::from("p/quarantine"))))
            .await
            .unwrap();
    assert_eq!(listed.len(), 1, "the bytes found there are kept");
}
