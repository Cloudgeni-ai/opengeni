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

use compute_engine::SnapshotFiles;
use compute_host::protocol::Id;
use compute_host::{CHUNK_BYTES, Chunked, SavedFiles, Store};
use compute_storage::store::ChunkStore;
use object_store::StaticCredentialProvider;
use object_store::gcp::{GcpCredential, GoogleCloudStorageBuilder};

fn open(url: &str) -> Chunked {
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
        return Chunked::new(ChunkStore::new(Arc::new(backend), prefix.into()));
    }
    Chunked::from_url(url)
        .unwrap()
        .expect("an object storage URL")
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
    let store = open(&url);
    let local = tempfile::tempdir().unwrap();
    let saved = SavedFiles {
        disk: local.path().join("disk"),
        memory: Some(SnapshotFiles {
            state: local.path().join("state"),
            memory: local.path().join("memory"),
        }),
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
    store.archive(id, &saved).await.unwrap();
    let first = started.elapsed();
    let started = Instant::now();
    store.archive(id, &saved).await.unwrap();
    let again = started.elapsed();

    let restored = tempfile::tempdir().unwrap();
    let into = SavedFiles {
        disk: restored.path().join("disk"),
        memory: Some(SnapshotFiles {
            state: restored.path().join("state"),
            memory: restored.path().join("memory"),
        }),
    };
    let started = Instant::now();
    store.fetch(id, &into).await.unwrap();
    let fetched = started.elapsed();
    let into_memory = into.memory.as_ref().unwrap();
    for (original, copy) in [
        (&saved.disk, &into.disk),
        (&memory.state, &into_memory.state),
        (&memory.memory, &into_memory.memory),
    ] {
        // Not assert_eq!: a mismatch would print gigabytes.
        let same = fs::read(original).unwrap() == fs::read(copy).unwrap();
        assert!(same, "{} came back different", original.display());
    }
    store.delete(id).await.unwrap();
    eprintln!(
        "{} MiB of data: first archive {first:?}, unchanged archive {again:?}, fetch {fetched:?}",
        ((disk_at.len() + memory_at.len() + 1) as u64 * CHUNK_BYTES) >> 20
    );
}
