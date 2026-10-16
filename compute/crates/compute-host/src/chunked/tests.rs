use std::io::{Seek, SeekFrom, Write};
use std::sync::Arc;

use object_store::memory::InMemory;
use object_store::{ObjectStore, path::Path as ObjectPath};

use super::*;
use crate::protocol::Id;

fn id(value: &str) -> Id {
    value.parse().unwrap()
}

/// A sparse file of `length` bytes with `bytes` written at each offset.
fn sparse(path: &Path, length: u64, writes: &[(u64, &[u8])]) {
    let mut file = File::create(path).unwrap();
    file.set_len(length).unwrap();
    for (at, bytes) in writes {
        file.seek(SeekFrom::Start(*at)).unwrap();
        file.write_all(bytes).unwrap();
    }
}

fn files(dir: &Path, memory: bool) -> SavedFiles {
    SavedFiles {
        disk: dir.join("disk"),
        memory: memory.then(|| crate::store::SavedImage {
            state: dir.join("state"),
            memory: dir.join("memory"),
            chunks: None,
        }),
        profile: None,
    }
}

async fn objects(backend: &InMemory, prefix: &str) -> usize {
    backend
        .list(Some(&ObjectPath::from(prefix)))
        .try_collect::<Vec<_>>()
        .await
        .unwrap()
        .len()
}

#[test]
fn manifests_cover_the_whole_file_and_merge_zeros() {
    let chunk = EncodedChunk::encode(&[1; 16], 1).unwrap().reference;
    let at = |start: u64| start..start + 16;
    let manifest = extents(
        100,
        vec![
            (at(16), None),
            (at(32), Some(chunk.clone())),
            (at(64), None),
        ],
    );
    let layout: Vec<_> = manifest
        .iter()
        .map(|extent| {
            let zero = matches!(extent.source, ExtentSource::Zero);
            (extent.offset, extent.length, zero)
        })
        .collect();
    assert_eq!(layout, [(0, 32, true), (32, 16, false), (48, 52, true)]);
    assert_eq!(
        extents(10, Vec::new())
            .iter()
            .map(|extent| (extent.offset, extent.length))
            .collect::<Vec<_>>(),
        [(0, 10)]
    );
}

#[test]
fn overlap_finds_data_inside_a_chunk() {
    let data = [10..20, 40..50];
    assert!(overlaps(&data, &(0..11)));
    assert!(overlaps(&data, &(19..30)));
    assert!(!overlaps(&data, &(20..40)));
    assert!(overlaps(&data, &(30..60)));
    assert!(!overlaps(&data, &(50..90)));
}

fn into(dir: &Path, memory: bool) -> FetchInto {
    FetchInto {
        disk: dir.join("disk"),
        scratch: dir.join("scratch"),
        profile: dir.join("profile"),
        memory,
        seed: None,
    }
}

#[tokio::test]
async fn a_disk_fetched_over_its_base_downloads_only_what_differs() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("base");
    let at = |chunk: u64, within: u64| chunk * CHUNK_BYTES + within;
    sparse(
        &base,
        at(4, 500),
        &[
            (at(0, 1), b"same"),
            (at(1, 2), b"before"),
            (at(2, 3), b"erased"),
            (at(3, 4), b"kept"),
        ],
    );
    let backend = Arc::new(InMemory::new());
    let store = Chunked::new(ChunkStore::new(backend.clone(), ObjectPath::from("t")));
    let mut base_files = files(dir.path(), false);
    base_files.disk.clone_from(&base);
    store
        .archive(
            id("00000000000000000000000000000001"),
            &base_files,
            &CancellationToken::new(),
        )
        .await
        .unwrap()
        .stored()
        .unwrap();
    let base_chunks: Vec<_> = backend
        .list(Some(&ObjectPath::from("t/chunks")))
        .map_ok(|object| object.location)
        .try_collect()
        .await
        .unwrap();

    // The sandbox changed one chunk, erased another and grew.
    let saved = files(dir.path(), false);
    sparse(
        &saved.disk,
        at(5, 9),
        &[
            (at(0, 1), b"same"),
            (at(1, 2), b"after!"),
            (at(3, 4), b"kept"),
            (at(4, 600), b"grown"),
        ],
    );
    let sandbox = id("00000000000000000000000000000002");
    store
        .archive(sandbox, &saved, &CancellationToken::new())
        .await
        .unwrap()
        .stored()
        .unwrap();
    // Only the base's copy of the unchanged chunks remains, locally.
    for location in &base_chunks {
        backend.delete(location).await.unwrap();
    }

    let restored = tempfile::tempdir().unwrap();
    let mut into = into(restored.path(), false);
    assert!(
        store.fetch(sandbox, &into).await.is_err(),
        "without the base the deleted chunks are needed"
    );
    into.seed = Some(base.clone());
    store.fetch(sandbox, &into).await.unwrap();
    assert_eq!(
        fs::read(&saved.disk).unwrap(),
        fs::read(&into.disk).unwrap()
    );

    // A changed base is hashed again, never trusted from before.
    sparse(&base, at(4, 500), &[(at(0, 1), b"SAME")]);
    assert!(store.fetch(sandbox, &into).await.is_err());
}

/// Rebuilds a memory file from a remote image's manifest, as lazy wake
/// pages it in.
async fn page_in(store: &Chunked, manifest: &[u8]) -> Vec<u8> {
    let manifest = DiskManifest::decode(manifest).unwrap();
    let refs = chunk_refs(&manifest).expect("memory is stored in whole chunks");
    let mut memory = vec![0; usize::try_from(manifest.disk_len).unwrap()];
    for (index, reference) in refs.iter().enumerate() {
        if let Some(reference) = reference {
            let range = chunk_range(index, manifest.disk_len);
            let bytes = store.chunks.get_chunk(reference).await.unwrap();
            memory[usize::try_from(range.start).unwrap()..usize::try_from(range.end).unwrap()]
                .copy_from_slice(&bytes);
        }
    }
    memory
}

#[tokio::test]
async fn a_sandbox_comes_back_byte_for_byte_and_unchanged_chunks_are_not_stored_twice() {
    let dir = tempfile::tempdir().unwrap();
    let mut saved = files(dir.path(), true);
    let big = 3 * CHUNK_BYTES + 1000;
    sparse(
        &saved.disk,
        big,
        &[(5, b"disk"), (2 * CHUNK_BYTES + 7, b"far")],
    );
    let snapshot = saved.memory.clone().unwrap();
    sparse(&snapshot.state, 300, &[(0, b"state")]);
    sparse(&snapshot.memory, big, &[(CHUNK_BYTES, b"memory")]);
    fs::write(dir.path().join("profile"), b"[1,2,3]").unwrap();
    saved.profile = Some(dir.path().join("profile"));

    let backend = Arc::new(InMemory::new());
    let store = Chunked::new(ChunkStore::new(backend.clone(), ObjectPath::from("t")));
    let sandbox = id("0123456789abcdef0123456789abcdef");
    let first = store
        .archive(sandbox, &saved, &CancellationToken::new())
        .await
        .unwrap()
        .stored()
        .unwrap();
    let chunks = objects(&backend, "t/chunks").await;
    assert_eq!(
        chunks, 5,
        "one chunk per range holding data, and the profile"
    );
    assert!(store.verify(sandbox, &first).await.unwrap());

    // Change one byte: only that chunk is stored again, and the old
    // receipt no longer matches what the store holds.
    sparse(&snapshot.memory, big, &[(CHUNK_BYTES, b"Memory")]);
    sparse(
        &saved.disk,
        big,
        &[(5, b"disk"), (2 * CHUNK_BYTES + 7, b"far")],
    );
    let second = store
        .archive(sandbox, &saved, &CancellationToken::new())
        .await
        .unwrap()
        .stored()
        .unwrap();
    assert_eq!(objects(&backend, "t/chunks").await, chunks + 1);
    assert!(!store.verify(sandbox, &first).await.unwrap());
    assert!(store.verify(sandbox, &second).await.unwrap());

    let restored = tempfile::tempdir().unwrap();
    let into = into(restored.path(), true);
    let FetchedMemory::Remote {
        state,
        memory_len,
        chunks: map,
        manifest,
    } = store.fetch(sandbox, &into).await.unwrap()
    else {
        panic!("memory should stay in the store");
    };
    assert_eq!(memory_len, big);
    assert_eq!(
        fs::read(&saved.disk).unwrap(),
        fs::read(&into.disk).unwrap()
    );
    assert_eq!(
        fs::read(&snapshot.state).unwrap(),
        fs::read(&state).unwrap()
    );
    assert_eq!(fs::read(&into.profile).unwrap(), b"[1,2,3]");
    let memory = fs::read(&snapshot.memory).unwrap();
    assert_eq!(page_in(&store, &manifest).await, memory);
    // The chunk map fetched equals one computed from the bytes.
    let file = File::open(&snapshot.memory).unwrap();
    let all: Vec<usize> = (0..chunk_count(big)).collect();
    assert_eq!(map, crate::image::hash_chunks(&file, big, &all).unwrap());
    assert!(!staging_path(&into.disk).exists());

    store.delete(sandbox).await.unwrap();
    assert!(!store.verify(sandbox, &second).await.unwrap());
    let gone = store.fetch(sandbox, &into).await.unwrap_err();
    assert_eq!(gone.kind, ErrorKind::Fatal);
}

#[tokio::test]
async fn a_chunk_map_skips_unchanged_chunks_and_catches_a_changed_image() {
    let dir = tempfile::tempdir().unwrap();
    let mut saved = files(dir.path(), true);
    let big = 4 * CHUNK_BYTES;
    sparse(&saved.disk, CHUNK_BYTES, &[(0, b"disk")]);
    let image = saved.memory.clone().unwrap();
    sparse(&image.state, 10, &[(0, b"s")]);
    sparse(
        &image.memory,
        big,
        &[(0, b"zero"), (2 * CHUNK_BYTES, b"two")],
    );
    let file = File::open(&image.memory).unwrap();
    let all: Vec<usize> = (0..4).collect();
    let map = Arc::new(crate::image::hash_chunks(&file, big, &all).unwrap());
    saved.memory.as_mut().unwrap().chunks = Some(Arc::clone(&map));
    let store = Chunked::new(ChunkStore::new(
        Arc::new(InMemory::new()),
        ObjectPath::from("t"),
    ));
    let sandbox = id("00000000000000000000000000000002");
    store
        .archive(sandbox, &saved, &CancellationToken::new())
        .await
        .unwrap()
        .stored()
        .unwrap();
    // Unchanged per the map: archived again without reading, so even an
    // unreadable memory file does not matter.
    fs::remove_file(&image.memory).unwrap();
    File::create(&image.memory).unwrap().set_len(big).unwrap();
    let mut stale = (*map).clone();
    stale[3] = [7; 32];
    saved.memory.as_mut().unwrap().chunks = Some(Arc::new(stale));
    // ...but a chunk the map says changed is read and must match it.
    let error = store
        .archive(sandbox, &saved, &CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Fatal);
    saved.memory.as_mut().unwrap().chunks = Some(map);
    store
        .archive(sandbox, &saved, &CancellationToken::new())
        .await
        .unwrap()
        .stored()
        .unwrap();
}

#[tokio::test]
async fn a_disk_only_copy_cannot_supply_a_memory_image() {
    let dir = tempfile::tempdir().unwrap();
    let saved = files(dir.path(), false);
    sparse(&saved.disk, CHUNK_BYTES, &[(0, b"disk")]);
    let store = Chunked::new(ChunkStore::new(
        Arc::new(InMemory::new()),
        ObjectPath::from("t"),
    ));
    let sandbox = id("00000000000000000000000000000001");
    store
        .archive(sandbox, &saved, &CancellationToken::new())
        .await
        .unwrap()
        .stored()
        .unwrap();
    let restored = tempfile::tempdir().unwrap();
    let error = store
        .fetch(sandbox, &into(restored.path(), true))
        .await
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::MemoryLost);
}

#[test]
fn hex_hashes_round_trip() {
    let hash = blake3::hash(b"x");
    assert_eq!(hash_from_hex(hash.to_hex().as_str()), Ok(*hash.as_bytes()));
    assert!(hash_from_hex("zz").is_err());
}

#[tokio::test]
async fn a_cancelled_archive_publishes_nothing_and_keeps_the_earlier_copy() {
    let dir = tempfile::tempdir().unwrap();
    let saved = files(dir.path(), true);
    sparse(&saved.disk, 4 * CHUNK_BYTES, &[(0, b"disk")]);
    let image = saved.memory.clone().unwrap();
    sparse(&image.state, 10, &[(0, b"s")]);
    sparse(&image.memory, 2 * CHUNK_BYTES, &[(0, b"one")]);
    let backend = Arc::new(InMemory::new());
    let store = Chunked::new(ChunkStore::new(backend.clone(), ObjectPath::from("t")));
    let sandbox = id("00000000000000000000000000000003");
    let cancelled = CancellationToken::new();
    cancelled.cancel();

    // Nothing stored yet: a cancelled archive writes nothing at all.
    let outcome = store.archive(sandbox, &saved, &cancelled).await.unwrap();
    assert_eq!(outcome, Archive::Cancelled);
    assert_eq!(objects(&backend, "t").await, 0);

    let first = store
        .archive(sandbox, &saved, &CancellationToken::new())
        .await
        .unwrap()
        .stored()
        .unwrap();
    let before = objects(&backend, "t").await;
    // A changed sandbox whose archive is cancelled leaves the store
    // naming, and holding, the earlier copy.
    sparse(&saved.disk, 4 * CHUNK_BYTES, &[(3 * CHUNK_BYTES, b"new")]);
    let outcome = store.archive(sandbox, &saved, &cancelled).await.unwrap();
    assert_eq!(outcome, Archive::Cancelled);
    assert_eq!(objects(&backend, "t").await, before);
    assert!(store.verify(sandbox, &first).await.unwrap());

    let second = store
        .archive(sandbox, &saved, &CancellationToken::new())
        .await
        .unwrap()
        .stored()
        .unwrap();
    assert_ne!(first, second);
    assert!(store.verify(sandbox, &second).await.unwrap());
}
