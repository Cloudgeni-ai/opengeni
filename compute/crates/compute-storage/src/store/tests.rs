use compute_fleet::{OwnerEpoch, Stamp};
use object_store::memory::InMemory;

use super::*;

#[tokio::test]
async fn pointers_are_replaced_read_and_deleted() {
    let store = ChunkStore::new(Arc::new(InMemory::new()), Path::from("tenant/test"));
    assert_eq!(store.get_pointer("a1").await.unwrap(), None);
    assert!(store.rewrite_test("a1").await.unwrap().is_none());
    let first = store.begin_test("a1").await.unwrap();
    store.publish(first, b"one two".to_vec()).await.unwrap();
    let (read, part) = store.rewrite_test("a1").await.unwrap().unwrap();
    assert_eq!(read, b"one two".to_vec());
    store.publish(part, b"two".to_vec()).await.unwrap();
    assert_eq!(
        store.get_pointer("a1").await.unwrap(),
        Some(b"two".to_vec())
    );
    store.delete_pointer("a1", TEST_EPOCH).await.unwrap();
    store.delete_pointer("a1", TEST_EPOCH).await.unwrap();
    assert_eq!(store.get_pointer("a1").await.unwrap(), None);
    assert!(store.rewrite_test("a1").await.unwrap().is_none());
    assert!(store.begin_test("../escape").await.is_err());
    let big = store.begin_test("big").await.unwrap();
    assert!(
        store
            .publish(big, vec![0; MAX_POINTER_BYTES + 1])
            .await
            .is_err()
    );
}

/// A change that read an older version never lands, and a delete
/// where deletes carry no condition leaves the empty pointer.
#[tokio::test]
async fn changes_land_only_on_the_version_they_read() {
    let backend = Arc::new(InMemory::new());
    let store = ChunkStore::new(backend.clone(), Path::from("p"));
    let first = store.begin_test("a").await.unwrap();
    store.publish(first, b"old".to_vec()).await.unwrap();
    let (_, stale) = store.rewrite_test("a").await.unwrap().unwrap();
    let newer = store.begin_test("a").await.unwrap();
    store.publish(newer, b"new".to_vec()).await.unwrap();
    let refused = store.publish(stale, b"part of old".to_vec()).await;
    assert!(matches!(refused, Err(Error::Superseded)), "{refused:?}");
    assert_eq!(store.get_pointer("a").await.unwrap(), Some(b"new".to_vec()));

    store.delete_pointer("a", TEST_EPOCH).await.unwrap();
    assert_eq!(store.get_pointer("a").await.unwrap(), None);
    let left = backend
        .get(&Path::from("p/pointers/v3/a"))
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert!(
        unstamped(&left).unwrap().1.is_empty(),
        "the empty pointer stays"
    );
    assert!(store.rewrite_test("a").await.unwrap().is_none());
}

/// Every write of a pointer is stored differently, even of the same
/// pointer, and a stored pointer without its stamp is refused.
#[tokio::test]
async fn every_pointer_write_has_its_own_stamp() {
    let backend = Arc::new(InMemory::new());
    let store = ChunkStore::new(backend.clone(), Path::from("p"));
    let path = Path::from("p/pointers/v3/a");
    let stored = || {
        let (backend, path) = (backend.clone(), path.clone());
        async move { backend.get(&path).await.unwrap().bytes().await.unwrap() }
    };
    let first = store.begin_test("a").await.unwrap();
    let empty = stored().await;
    store.publish(first, b"same".to_vec()).await.unwrap();
    let once = stored().await;
    let (_, again) = store.rewrite_test("a").await.unwrap().unwrap();
    store.publish(again, b"same".to_vec()).await.unwrap();
    let twice = stored().await;
    let (once_owner, once_body) = unstamped(&once).unwrap();
    let (twice_owner, twice_body) = unstamped(&twice).unwrap();
    assert_eq!(once_body, twice_body);
    assert!(twice_owner > once_owner, "a rewrite takes a later number");
    assert_ne!(once, twice);
    store.fence("pointers/v3/a").await.unwrap();
    assert_ne!(stored().await, twice, "a fence stores it anew");
    store.delete_pointer("a", TEST_EPOCH).await.unwrap();
    let deleted = stored().await;
    assert!(unstamped(&deleted).unwrap().1.is_empty());
    assert_ne!(deleted, empty, "two empty pointers differ by stamp");

    backend
        .put(&path, Bytes::from_static(b"short").into())
        .await
        .unwrap();
    assert!(matches!(
        store.get_pointer("a").await,
        Err(Error::Invalid(_))
    ));
}

fn at(epoch: u64, save: u64) -> Stamp {
    Stamp {
        epoch: OwnerEpoch(epoch),
        save,
    }
}

fn fenced_by<T: std::fmt::Debug>(result: &Result<T>, epoch: u64) {
    assert!(
        matches!(result, Err(Error::Fenced { by }) if *by == OwnerEpoch(epoch)),
        "{result:?}"
    );
}

/// Once a later owner claims a pointer, nothing a former owner does
/// lands: neither a publication it got before the claim, nor any it
/// begins after, nor a change, a delete or a claim of its own. This is
/// the stale write a check made only after a refusal would miss: an
/// archive that begins after the claim reads the claimed version.
#[tokio::test]
async fn a_former_owner_writes_nothing_after_a_claim() -> Result<()> {
    let store = ChunkStore::new(Arc::new(InMemory::new()), Path::from("p"));
    let first = store
        .begin("a", at(1, 1))
        .await?
        .into_publication()
        .unwrap();
    store.publish(first, b"one".to_vec()).await?;
    let held = store
        .begin("a", at(1, 2))
        .await?
        .into_publication()
        .unwrap();

    let claimed = store.claim("a", OwnerEpoch(2)).await?;
    assert_eq!(claimed, Some((at(2, 1), b"one".to_vec())));
    let refused = store.publish(held, b"stale".to_vec()).await;
    assert!(matches!(refused, Err(Error::Superseded)), "{refused:?}");
    fenced_by(&store.begin("a", at(1, 3)).await, 2);
    fenced_by(&store.read_for_change("a", at(1, 3)).await, 2);
    fenced_by(&store.delete_pointer("a", OwnerEpoch(1)).await, 2);
    fenced_by(&store.claim("a", OwnerEpoch(1)).await, 2);
    assert_eq!(
        store.get_owned_pointer("a").await?,
        Some((at(2, 1), b"one".to_vec()))
    );

    // The new owner goes on from the save it claimed.
    let next = store
        .begin("a", at(2, 2))
        .await?
        .into_publication()
        .unwrap();
    store.publish(next, b"two".to_vec()).await?;
    assert_eq!(
        store.get_owned_pointer("a").await?,
        Some((at(2, 2), b"two".to_vec()))
    );
    Ok(())
}

/// An archive of a save the pointer already names finds it stored, one of
/// an earlier save by the same owner finds it outdated, and neither
/// publishes; a later save publishes.
#[tokio::test]
async fn the_same_save_is_stored_and_an_earlier_one_outdated() -> Result<()> {
    let store = ChunkStore::new(Arc::new(InMemory::new()), Path::from("p"));
    let fifth = store
        .begin("a", at(1, 5))
        .await?
        .into_publication()
        .unwrap();
    store.publish(fifth, b"five".to_vec()).await?;
    assert!(matches!(store.begin("a", at(1, 3)).await?, Begun::Outdated));
    assert!(matches!(
        store.begin("a", at(1, 5)).await?,
        Begun::Stored(bytes) if bytes == b"five"
    ));
    let sixth = store
        .begin("a", at(1, 6))
        .await?
        .into_publication()
        .unwrap();
    store.publish(sixth, b"six".to_vec()).await?;
    // A later owner continues from any save, even an earlier number.
    assert!(matches!(
        store.begin("a", at(2, 1)).await?,
        Begun::Publish(_)
    ));
    Ok(())
}

/// A claim whose answer was lost is tried again and changes nothing;
/// a sweep's fence keeps the owner stamp.
#[tokio::test]
async fn a_claim_again_and_a_fence_keep_the_owner() -> Result<()> {
    let backend = Arc::new(InMemory::new());
    let store = ChunkStore::new(backend.clone(), Path::from("p"));
    let path = Path::from("p/pointers/v3/a");
    let first = store
        .begin("a", at(1, 4))
        .await?
        .into_publication()
        .unwrap();
    store.publish(first, b"four".to_vec()).await?;
    let claimed = store.claim("a", OwnerEpoch(3)).await?;
    let stored = backend.get(&path).await?.bytes().await?;
    assert_eq!(store.claim("a", OwnerEpoch(3)).await?, claimed);
    assert_eq!(
        backend.get(&path).await?.bytes().await?,
        stored,
        "claimed again without a write"
    );
    assert_eq!(
        store.fence("pointers/v3/a").await?,
        Stock::Holds(b"four".to_vec())
    );
    assert_eq!(
        store.get_owned_pointer("a").await?,
        Some((at(3, 4), b"four".to_vec()))
    );
    Ok(())
}

/// A tombstone is final: the owner that deleted the sandbox finds any
/// archive it still has in flight deleted, not done, a later owner neither
/// archives over it nor takes anything by claiming it, and a former owner
/// is fenced. Deleting again changes nothing.
#[tokio::test]
async fn a_tombstone_is_final() -> Result<()> {
    let backend = Arc::new(InMemory::new());
    let store = ChunkStore::new(backend.clone(), Path::from("p"));
    let path = Path::from("p/pointers/v3/a");
    let first = store
        .begin("a", at(2, 1))
        .await?
        .into_publication()
        .unwrap();
    store.publish(first, b"one".to_vec()).await?;
    let in_flight = store
        .begin("a", at(2, 2))
        .await?
        .into_publication()
        .unwrap();
    store.delete_pointer("a", OwnerEpoch(2)).await?;
    let tombstone = backend.get(&path).await?.bytes().await?;

    let refused = store.publish(in_flight, b"two".to_vec()).await;
    assert!(matches!(refused, Err(Error::Superseded)), "{refused:?}");
    assert!(matches!(store.begin("a", at(2, 2)).await?, Begun::Deleted));
    assert!(matches!(store.begin("a", at(3, 1)).await?, Begun::Deleted));
    assert!(matches!(
        store.read_for_change("a", at(2, 3)).await?,
        Rewrite::Nothing
    ));
    assert_eq!(store.claim("a", OwnerEpoch(3)).await?, None);
    fenced_by(&store.begin("a", at(1, 9)).await, 2);
    fenced_by(&store.delete_pointer("a", OwnerEpoch(1)).await, 2);
    store.delete_pointer("a", OwnerEpoch(2)).await?;
    assert_eq!(backend.get(&path).await?.bytes().await?, tombstone);
    assert_eq!(store.look("pointers/v3/a").await?, Stock::Tombstone);
    assert_eq!(store.fence("pointers/v3/a").await?, Stock::Tombstone);
    assert_eq!(
        backend.get(&path).await?.bytes().await?,
        tombstone,
        "never fenced"
    );
    assert_eq!(store.get_owned_pointer("a").await?, None);
    assert!(matches!(
        store.read_for_change("a", at(2, 4)).await?,
        Rewrite::Nothing
    ));
    Ok(())
}

#[tokio::test]
async fn keys_nest_under_the_prefix_so_they_can_be_listed() {
    use futures::TryStreamExt as _;

    let backend = Arc::new(InMemory::new());
    let store = ChunkStore::new(backend.clone(), Path::from("tenant/test"));
    let chunk = EncodedChunk::encode(&[5; 4096], 1).unwrap();
    store.put_chunk(&chunk).await.unwrap();
    let listed: Vec<_> = backend
        .list(Some(&Path::from("tenant/test/chunks/v1")))
        .try_collect()
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(
        listed[0].location.as_ref(),
        format!("tenant/test/{}", chunk.object_key())
    );
}

#[tokio::test]
async fn deduplicates_and_verifies() {
    let backend = Arc::new(InMemory::new());
    let store = ChunkStore::new(backend.clone(), Path::from("tenant/test"));
    let chunk = EncodedChunk::encode(&vec![9; 4096], 1).unwrap();
    assert!(store.put_chunk(&chunk).await.unwrap());
    assert!(!store.put_chunk(&chunk).await.unwrap());
    assert_eq!(
        store.get_chunk(&chunk.reference).await.unwrap(),
        vec![9; 4096]
    );
}

async fn quarantined(backend: &InMemory) -> Vec<Bytes> {
    use futures::TryStreamExt as _;
    let listed: Vec<_> = backend
        .list(Some(&Path::from("tenant/test/quarantine/v1")))
        .try_collect()
        .await
        .unwrap();
    let mut found = Vec::new();
    for meta in listed {
        found.push(
            backend
                .get(&meta.location)
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap(),
        );
    }
    found
}

#[tokio::test]
async fn truncated_and_corrupt_chunks_are_rejected_quarantined_and_repaired() {
    let backend = Arc::new(InMemory::new());
    let store = ChunkStore::new(backend.clone(), Path::from("tenant/test"));
    let chunk = EncodedChunk::encode(&vec![7; 65536], 1).unwrap();
    let path = store.path(&chunk.object_key());
    let good = Bytes::from(chunk.bytes.clone());
    let truncated = good.slice(..good.len() - 1);
    let mut flipped = chunk.bytes.clone();
    flipped[3] ^= 0x40;
    let flipped = Bytes::from(flipped);

    for (bad, truncation) in [(truncated, true), (flipped, false)] {
        backend.put(&path, bad.clone().into()).await.unwrap();
        let error = store.get_chunk(&chunk.reference).await.unwrap_err();
        assert_eq!(
            matches!(error, Error::Truncated { .. }),
            truncation,
            "{error}"
        );
        assert!(matches!(error, Error::Truncated { .. } | Error::Integrity));
        // A copy is kept for inspection.
        assert!(quarantined(&backend).await.contains(&bad));
        // The object itself stays until the right bytes replace it, and
        // neither a short nor a same-length damaged copy counts as held.
        assert!(!store.has_chunk(&chunk.reference).await.unwrap());
        // The next upload of the same content repairs the shared chunk.
        assert!(store.put_chunk(&chunk).await.unwrap());
        assert!(store.has_chunk(&chunk.reference).await.unwrap());
        assert_eq!(
            store.get_chunk(&chunk.reference).await.unwrap(),
            vec![7; 65536]
        );
    }
}

#[tokio::test]
async fn a_missing_or_truncated_chunk_is_not_held() {
    let backend = Arc::new(InMemory::new());
    let store = ChunkStore::new(backend.clone(), Path::from("tenant/test"));
    let chunk = EncodedChunk::encode(&[4; 8192], 1).unwrap();
    assert!(!store.has_chunk(&chunk.reference).await.unwrap());
    store.put_chunk(&chunk).await.unwrap();
    assert!(store.has_chunk(&chunk.reference).await.unwrap());
    let path = store.path(&chunk.object_key());
    backend
        .put(&path, Bytes::from(chunk.bytes[1..].to_vec()).into())
        .await
        .unwrap();
    assert!(!store.has_chunk(&chunk.reference).await.unwrap());
    backend.delete(&path).await.unwrap();
    assert!(!store.has_chunk(&chunk.reference).await.unwrap());
}

#[tokio::test]
async fn gcs_checksums_prove_a_chunk_without_reading_it() {
    use crate::fake::{Fake, gcs};
    let fake = Arc::new(Fake::default());
    let store = ChunkStore {
        // Never read: GCS answers from the checksums it keeps.
        backend: Arc::new(InMemory::new()),
        prefix: Path::from("p"),
        uploader: Uploader::Gcs(gcs(&fake)),
        freshness: Freshness::DEFAULT,
        clock: Clock::system(),
    };
    let chunk = EncodedChunk::encode(&[9; 16384], 1).unwrap();
    assert!(!store.has_chunk(&chunk.reference).await.unwrap());
    assert!(store.put_chunk(&chunk).await.unwrap());
    assert!(store.has_chunk(&chunk.reference).await.unwrap());
    // Same-length damage under the chunk's name is not held...
    let key = format!("p/{}", chunk.object_key());
    let mut damaged = chunk.bytes.clone();
    damaged[1] ^= 0x10;
    fake.put_raw(&key, Bytes::from(damaged));
    assert!(!store.has_chunk(&chunk.reference).await.unwrap());
    // ...and the next upload of the same content replaces it.
    assert!(store.put_chunk(&chunk).await.unwrap());
    assert_eq!(fake.bytes(&key).unwrap(), chunk.bytes);
    assert!(store.has_chunk(&chunk.reference).await.unwrap());
    // A reference whose checksums disagree with its bytes is refused.
    let mut forged = chunk.clone();
    forged.reference.checksums = Some(crate::upload::checksums(b"other"));
    assert!(matches!(
        store.put_chunk(&forged).await,
        Err(Error::Integrity)
    ));
}

#[tokio::test]
async fn an_upload_finding_a_bad_object_replaces_it() {
    let backend = Arc::new(InMemory::new());
    let store = ChunkStore::new(backend.clone(), Path::from("tenant/test"));
    let chunk = EncodedChunk::encode(&[3; 4096], 1).unwrap();
    let path = store.path(&chunk.object_key());
    backend
        .put(&path, Bytes::from_static(b"bad").into())
        .await
        .unwrap();
    assert!(store.put_chunk(&chunk).await.unwrap());
    assert_eq!(
        store.get_chunk(&chunk.reference).await.unwrap(),
        vec![3; 4096]
    );
    assert_eq!(
        quarantined(&backend).await,
        vec![Bytes::from_static(b"bad")]
    );
}

#[test]
fn store_urls_pick_the_verifying_uploader() {
    assert!(ChunkStore::from_url("/local/path").unwrap().is_none());
    assert!(ChunkStore::from_url("ftp://x/y").is_err());
    let s3 = ChunkStore::from_url("s3://bucket/a/b").unwrap().unwrap();
    assert!(matches!(s3.uploader, Uploader::StoreVerified));
    assert_eq!(s3.prefix.as_ref(), "a/b");
}

#[tokio::test]
async fn manifest_round_trip_rejects_corruption_and_invalid_digest() {
    use crate::manifest::{Extent, ExtentSource};
    let backend = Arc::new(InMemory::new());
    let store = ChunkStore::new(backend.clone(), Path::from("tenant/test"));
    let manifest = DiskManifest {
        version: 1,
        disk_len: 4096,
        base_len: 0,
        base_digest: "0".repeat(64),
        extents: vec![Extent {
            offset: 0,
            length: 4096,
            source: ExtentSource::Zero,
        }],
    };
    let digest = store.put_manifest(&manifest).await.unwrap();
    assert_eq!(store.get_manifest(&digest).await.unwrap(), manifest);
    assert_eq!(store.put_manifest(&manifest).await.unwrap(), digest);
    assert!(store.get_manifest("../unexpected").await.is_err());
    backend
        .put(
            &store.path(&format!("manifests/v1/{digest}.json")),
            Bytes::from_static(b"{}").into(),
        )
        .await
        .unwrap();
    assert!(matches!(
        store.get_manifest(&digest).await,
        Err(Error::Integrity)
    ));
}

/// Forgetting a memory image takes its own number, so an archive of the
/// save before it, tried again after a lost answer, finds the pointer
/// outdated rather than taking the copy without memory as its own; the
/// rewrite tried again finds itself done.
#[tokio::test]
async fn a_rewrite_outdates_the_save_it_rewrote() -> Result<()> {
    let store = ChunkStore::new(Arc::new(InMemory::new()), Path::from("p"));
    let save = store
        .begin("a", at(1, 1))
        .await?
        .into_publication()
        .unwrap();
    store.publish(save, b"disk and memory".to_vec()).await?;
    let Rewrite::Change(read, change) = store.read_for_change("a", at(1, 2)).await? else {
        panic!("nothing to rewrite");
    };
    assert_eq!(read, b"disk and memory");
    store.publish(change, b"disk".to_vec()).await?;
    assert!(matches!(store.begin("a", at(1, 1)).await?, Begun::Outdated));
    assert!(matches!(
        store.read_for_change("a", at(1, 2)).await?,
        Rewrite::Done(bytes) if bytes == b"disk"
    ));
    assert!(matches!(
        store.read_for_change("a", at(1, 1)).await?,
        Rewrite::Outdated
    ));
    Ok(())
}

/// A claim where there is no pointer yet stores an empty one under the new
/// owner, so an archive a former owner begins afterwards is fenced
/// instead of publishing a copy nobody claimed.
#[tokio::test]
async fn a_claim_of_nothing_still_fences_a_former_owner() -> Result<()> {
    let store = ChunkStore::new(Arc::new(InMemory::new()), Path::from("p"));
    assert_eq!(store.claim("a", OwnerEpoch(2)).await?, None);
    fenced_by(&store.begin("a", at(1, 1)).await, 2);
    assert_eq!(store.get_pointer("a").await?, None);
    // The new owner archives over its own empty pointer.
    let first = store
        .begin("a", at(2, 1))
        .await?
        .into_publication()
        .unwrap();
    store.publish(first, b"one".to_vec()).await?;
    assert_eq!(
        store.get_owned_pointer("a").await?,
        Some((at(2, 1), b"one".to_vec()))
    );
    Ok(())
}
