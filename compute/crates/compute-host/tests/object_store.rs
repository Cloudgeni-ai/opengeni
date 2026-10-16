//! Archive and fetch a sandbox through real object storage.
//!
//! Runs only when `COMPUTE_TEST_STORE` names a scratch location such as
//! `gs://bucket/prefix`; everything it writes there can be deleted after.
//! For Google Cloud Storage, `COMPUTE_TEST_GCS_TOKEN` may supply a
//! short-lived access token when the machine's own identity cannot write.

use std::fs::{self, File};
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use compute_engine::CancellationToken;
use compute_host::protocol::Id;
use compute_host::{CHUNK_BYTES, Chunked, FetchInto, FetchedMemory, SavedFiles, SavedImage, Store};
use compute_storage::manifest::{DiskManifest, ExtentSource};
use compute_storage::store::ChunkStore;
use object_store::StaticCredentialProvider;
use object_store::gcp::{GcpCredential, GoogleCloudStorageBuilder};

fn open(url: &str) -> (Chunked, ChunkStore) {
    if let (Ok(token), Some(rest)) = (
        std::env::var("COMPUTE_TEST_GCS_TOKEN"),
        url.strip_prefix("gs://"),
    ) {
        let (bucket, prefix) = rest.split_once('/').unwrap_or((rest, ""));
        let backend = GoogleCloudStorageBuilder::new()
            .with_bucket_name(bucket)
            .with_credentials(Arc::new(StaticCredentialProvider::new(GcpCredential {
                bearer: token,
            })))
            .build()
            .unwrap();
        let chunks = ChunkStore::new(Arc::new(backend), prefix.into());
        return (Chunked::new(chunks.clone()), chunks);
    }
    let chunks = ChunkStore::from_url(url)
        .unwrap()
        .expect("an object storage URL");
    (Chunked::new(chunks.clone()), chunks)
}

/// A sparse file of `length` bytes holding pseudo-random data at `at`.
fn sparse(path: &Path, length: u64, at: &[u64], seed: u64) {
    let mut file = File::create(path).unwrap();
    file.set_len(length).unwrap();
    let mut state = seed | 1;
    for &offset in at {
        let block: Vec<u8> = (0..CHUNK_BYTES)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state.to_le_bytes()[0]
            })
            .collect();
        file.seek(SeekFrom::Start(offset)).unwrap();
        file.write_all(&block).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sandbox_survives_a_round_trip_through_object_storage() {
    let Ok(url) = std::env::var("COMPUTE_TEST_STORE") else {
        eprintln!("skipped: set COMPUTE_TEST_STORE to run against object storage");
        return;
    };
    let (store, chunks) = open(&url);
    let local = tempfile::tempdir().unwrap();
    let saved = SavedFiles {
        disk: local.path().join("disk"),
        memory: Some(SavedImage {
            state: local.path().join("state"),
            memory: local.path().join("memory"),
            chunks: None,
        }),
        profile: None,
    };
    let memory = saved.memory.as_ref().unwrap();
    let gib = 1 << 30;
    let disk_at: Vec<u64> = (0..64).map(|i| i * 4 * CHUNK_BYTES).collect();
    let memory_at: Vec<u64> = (0..256).map(|i| i * 3 * CHUNK_BYTES).collect();
    sparse(&saved.disk, 4 * gib, &disk_at, 1);
    sparse(&memory.state, 40_000, &[0], 2);
    sparse(&memory.memory, 2 * gib, &memory_at, 3);

    let id: Id = format!("{:032x}", u128::from(std::process::id()) << 64 | 0xc0de)
        .parse()
        .unwrap();
    let started = Instant::now();
    let receipt = store
        .archive(id, &saved, &CancellationToken::new())
        .await
        .unwrap()
        .stored()
        .unwrap();
    let first = started.elapsed();
    let started = Instant::now();
    let again_receipt = store
        .archive(id, &saved, &CancellationToken::new())
        .await
        .unwrap()
        .stored()
        .unwrap();
    let again = started.elapsed();
    assert_eq!(
        receipt, again_receipt,
        "an unchanged sandbox stores the same copy"
    );
    assert!(store.verify(id, &receipt).await.unwrap());

    let restored = tempfile::tempdir().unwrap();
    let into = FetchInto {
        disk: restored.path().join("disk"),
        scratch: restored.path().join("scratch"),
        profile: restored.path().join("profile"),
        memory: true,
        seed: None,
    };
    let started = Instant::now();
    let fetched = store.fetch(id, &into).await.unwrap();
    let fetched_at = started.elapsed();
    let FetchedMemory::Remote {
        state, manifest, ..
    } = fetched
    else {
        panic!("memory should stay in the store, to be paged in");
    };
    // Page every chunk in, as a fully hydrated wake would.
    let started = Instant::now();
    let manifest = DiskManifest::decode(&manifest).unwrap();
    let paged = restored.path().join("memory");
    {
        let file = File::create(&paged).unwrap();
        file.set_len(manifest.disk_len).unwrap();
        for extent in &manifest.extents {
            if let ExtentSource::Chunk { reference, .. } = &extent.source {
                let bytes = chunks.get_chunk(reference).await.unwrap();
                std::os::unix::fs::FileExt::write_all_at(&file, &bytes, extent.offset).unwrap();
            }
        }
    }
    let paged_in = started.elapsed();
    for (original, copy) in [
        (&saved.disk, &into.disk),
        (&memory.state, &state),
        (&memory.memory, &paged),
    ] {
        // Not assert_eq!: a mismatch would print gigabytes.
        let same = fs::read(original).unwrap() == fs::read(copy).unwrap();
        assert!(same, "{} came back different", original.display());
    }
    store.delete(id).await.unwrap();
    eprintln!(
        "{} MiB of data: first archive {first:?}, unchanged archive {again:?}, fetch without memory {fetched_at:?}, paging all memory in {paged_in:?}",
        ((disk_at.len() + memory_at.len() + 1) as u64 * CHUNK_BYTES) >> 20
    );
}
