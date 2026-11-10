//! A sweep over copies whose chunks are in packs (ADR 31).

use super::*;
use crate::chunk::ChunkRef;
use crate::copy::{Copies, VERSION_PACKS};
use crate::manifest::{DiskManifest, Extent, ExtentSource};
use crate::pack::Packer;

/// A pack of chunks 1 to `count`.
async fn pack(store: &ChunkStore, first: u8, count: u8) -> Vec<ChunkRef> {
    let mut packer = Packer::new();
    for n in first..first + count {
        packer.push(&chunk(n));
    }
    store.put_pack(packer).await.unwrap().references
}

/// The head of a copy in `version` whose disk is `references`, in order.
async fn head(store: &ChunkStore, version: u32, references: &[ChunkRef]) -> Vec<u8> {
    let manifest = DiskManifest {
        version: 1,
        disk_len: 4096 * references.len() as u64,
        base_len: 0,
        base_digest: "0".repeat(64),
        extents: references
            .iter()
            .zip(0..)
            .map(|(reference, n)| Extent {
                offset: 4096 * n,
                length: 4096,
                source: ExtentSource::Chunk {
                    reference: reference.clone(),
                    offset: 0,
                },
            })
            .collect(),
    };
    let disk = store.put_manifest(&manifest).await.unwrap();
    serde_json::to_vec(&serde_json::json!({
        "version": version,
        "disk": disk,
        "memory": null,
        "profile": null,
        "pack": null,
    }))
    .unwrap()
}

/// A pack is kept while a copy names any chunk in it, and deleted as an
/// unnamed chunk is once none does and its hour ended the skew before.
#[tokio::test(start_paused = true)]
async fn a_pack_goes_once_no_copy_names_a_chunk_in_it() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let named = pack(&store, 1, 3).await;
    let unnamed = pack(&store, 10, 3).await;
    // One chunk of the first pack is enough to keep all of it.
    let bytes = head(&store, VERSION_PACKS, &named[1..2]).await;
    let publication = store.begin_test("a").await.unwrap();
    store.publish(publication, bytes).await.unwrap();
    tokio::time::advance(HOUR.checked_sub(MINUTE).unwrap()).await;
    let early = sweep(&store, &Copies(&store), true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!(early.deleted, 0, "its hour is not over: {early:?}");
    tokio::time::advance(MINUTE + CLOCK_SKEW).await;
    let swept = sweep(&store, &Copies(&store), true, SystemTime::UNIX_EPOCH)
        .await
        .unwrap();
    assert_eq!((swept.deleted, swept.unknown), (1, 0), "{swept:?}");
    assert!(present(&fake, &named[0].key()));
    assert!(!present(&fake, &unnamed[0].key()));
    for reference in &named {
        assert_eq!(
            store.get_chunk(reference).await.unwrap(),
            vec![reference_byte(reference); 4096]
        );
    }
}

/// The byte chunk `reference` was made of in these tests.
fn reference_byte(reference: &ChunkRef) -> u8 {
    (1..=255)
        .find(|n| chunk(*n).reference.hash == reference.hash)
        .unwrap()
}

/// A sweep that meets a copy in a format it does not read refuses before
/// it deletes anything, as a sweep of an earlier release meets a copy in
/// packs: a host may write a format before every sweep reads it, and no
/// object one names is lost.
#[tokio::test(start_paused = true)]
async fn a_sweep_that_cannot_read_a_copys_format_deletes_nothing() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake(&fake, "p");
    let named = pack(&store, 1, 2).await;
    pack(&store, 10, 2).await;
    store.put_chunk(&chunk(20)).await.unwrap();
    let bytes = head(&store, VERSION_PACKS + 1, &named).await;
    let publication = store.begin_test("a").await.unwrap();
    store.publish(publication, bytes).await.unwrap();
    let before = fake.names().len();
    tokio::time::advance(2 * DAY).await;
    let refused = sweep(&store, &Copies(&store), true, SystemTime::UNIX_EPOCH).await;
    assert!(matches!(refused, Err(Error::Invalid(_))), "{refused:?}");
    assert_eq!(fake.names().len(), before, "nothing deleted");
}
