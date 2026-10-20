use std::io::{Seek, SeekFrom, Write};
use std::sync::Arc;
use std::time::Duration;

use object_store::memory::InMemory;
use object_store::{ObjectStore, path::Path as ObjectPath};

use super::files::extents;
use super::*;
use crate::image::overlaps;
use crate::protocol::Id;
use futures::TryStreamExt as _;

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

/// The runtime the test images say made them.
const RUNTIME: &str = "Firecracker v1.0.0 on a test processor";

fn files(dir: &Path, memory: bool) -> SavedFiles {
    SavedFiles {
        disk: crate::store::JailedFile::new(dir.join("disk")),
        memory: memory.then(|| crate::store::SavedImage {
            state: dir.join("state"),
            memory: dir.join("memory"),
            chunks: None,
            runtime: Some(RUNTIME.to_owned()),
        }),
        profile: None,
    }
}

/// A save of the first owner later than every one before it.
fn save() -> Stamp {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SAVES: AtomicU64 = AtomicU64::new(1);
    Stamp {
        epoch: OwnerEpoch::FIRST,
        save: SAVES.fetch_add(1, Ordering::Relaxed),
    }
}

fn at(epoch: u64, save: u64) -> Stamp {
    Stamp {
        epoch: OwnerEpoch(epoch),
        save,
    }
}

/// A host the fleet gave up on writes nothing once the sandbox's next
/// owner claimed its copy: no archive, no forgetting, no delete. The new
/// owner takes over the copy as it was, and goes on from its save number.
#[tokio::test]
async fn a_former_owner_writes_nothing_once_a_later_one_claims_the_copy() {
    let dir = tempfile::tempdir().unwrap();
    let (saved, store) = owned_fixture(dir.path());
    let sandbox = id("0123456789abcdef0123456789abcde0");
    let cancel = CancellationToken::new();

    let first = store
        .archive(sandbox, at(1, 3), &saved, &cancel)
        .await
        .unwrap();
    let Archive::Stored(receipt) = first.clone() else {
        panic!("{first:?}");
    };
    // An archive of the same save, tried again after its answer was lost,
    // finds it stored; an earlier one finds a later save there.
    let again = store
        .archive(sandbox, at(1, 3), &saved, &cancel)
        .await
        .unwrap();
    assert_eq!(again, first);
    let earlier = store
        .archive(sandbox, at(1, 2), &saved, &cancel)
        .await
        .unwrap();
    assert_eq!(earlier, Archive::Outdated);

    let Owned::Done(Some(claimed)) = store.claim(sandbox, OwnerEpoch(2)).await.unwrap() else {
        panic!("a copy to claim");
    };
    assert_eq!(
        claimed,
        Claimed {
            save: 3,
            receipt: receipt.clone(),
            memory: true,
        }
    );
    assert!(
        store.verify(sandbox, &receipt).await.unwrap(),
        "the copy is as it was"
    );
    let fenced = Owned::Fenced { by: OwnerEpoch(2) };
    assert_eq!(
        store
            .archive(sandbox, at(1, 4), &saved, &cancel)
            .await
            .unwrap(),
        Archive::Fenced { by: OwnerEpoch(2) }
    );
    assert_eq!(
        store.forget_memory(sandbox, at(1, 5)).await.unwrap(),
        fenced
    );
    assert_eq!(
        store.delete(sandbox, OwnerEpoch(1)).await.unwrap(),
        Owned::Fenced { by: OwnerEpoch(2) }
    );
    assert_eq!(
        store.claim(sandbox, OwnerEpoch(1)).await.unwrap(),
        Owned::Fenced { by: OwnerEpoch(2) }
    );
    assert!(
        store.verify(sandbox, &receipt).await.unwrap(),
        "untouched by the former owner"
    );

    let next = store
        .archive(sandbox, at(2, 4), &saved, &cancel)
        .await
        .unwrap();
    assert!(matches!(next, Archive::Stored(_)), "{next:?}");
}

/// A host's files to archive with a memory image, and a store to archive
/// them to.
fn owned_fixture(dir: &std::path::Path) -> (SavedFiles, Chunked) {
    let saved = files(dir, true);
    sparse(saved.disk.path(), CHUNK_BYTES, &[(0, b"disk")]);
    let image = saved.memory.clone().unwrap();
    sparse(&image.state, 100, &[(0, b"state")]);
    sparse(&image.memory, CHUNK_BYTES, &[(9, b"memory")]);
    let store = Chunked::new(ChunkStore::new(
        Arc::new(InMemory::new()),
        ObjectPath::from("t"),
    ));
    (saved, store)
}

/// Forgetting the memory is a change of its own: tried again after its
/// answer was lost it finds itself done, and the archive it followed,
/// tried again, no longer lands over it. A delete is final: a later
/// archive stores nothing, and says so.
#[tokio::test]
async fn a_forget_is_a_change_of_its_own_and_a_delete_is_final() {
    let dir = tempfile::tempdir().unwrap();
    let (saved, store) = owned_fixture(dir.path());
    let sandbox = id("0123456789abcdef0123456789abcde1");
    let cancel = CancellationToken::new();
    let first = store
        .archive(sandbox, at(2, 4), &saved, &cancel)
        .await
        .unwrap();
    assert!(matches!(first, Archive::Stored(_)), "{first:?}");
    let Owned::Done(Some(disk_only)) = store.forget_memory(sandbox, at(2, 5)).await.unwrap() else {
        panic!("the disk stays");
    };
    assert_eq!(
        store.forget_memory(sandbox, at(2, 5)).await.unwrap(),
        Owned::Done(Some(disk_only.clone()))
    );
    assert_eq!(
        store
            .archive(sandbox, at(2, 4), &saved, &cancel)
            .await
            .unwrap(),
        Archive::Outdated
    );
    assert!(store.verify(sandbox, &disk_only).await.unwrap());
    assert_eq!(
        store.delete(sandbox, OwnerEpoch(2)).await.unwrap(),
        Owned::Done(())
    );
    assert_eq!(
        store
            .archive(sandbox, at(2, 6), &saved, &cancel)
            .await
            .unwrap(),
        Archive::Deleted
    );
    assert_eq!(
        store.forget_memory(sandbox, at(2, 7)).await.unwrap(),
        Owned::Done(None)
    );
    assert_eq!(
        store.claim(sandbox, OwnerEpoch(3)).await.unwrap(),
        Owned::Done(None)
    );
}

/// Forgetting memory stores a new version even when the copy names none
/// already: an archive upload held up in flight from before, conditional
/// on the version the forget read, then can no longer land with its
/// memory image afterwards.
#[tokio::test]
async fn a_forget_of_a_disk_only_copy_still_stops_an_archive_in_flight() {
    let dir = tempfile::tempdir().unwrap();
    let (_, store) = owned_fixture(dir.path());
    let disk_only = files(dir.path(), false);
    let sandbox = id("0123456789abcdef0123456789abcde2");
    let cancel = CancellationToken::new();
    let first = store
        .archive(sandbox, at(2, 4), &disk_only, &cancel)
        .await
        .unwrap();
    assert!(matches!(first, Archive::Stored(_)), "{first:?}");
    // The next save read the pointer; its upload is held up and lands
    // only on the version it read.
    let held = store
        .chunks
        .begin(&sandbox.to_string(), at(2, 5))
        .await
        .unwrap()
        .into_publication()
        .expect("a later save publishes");
    let forgot = store.forget_memory(sandbox, at(2, 6)).await.unwrap();
    assert!(matches!(forgot, Owned::Done(Some(_))), "{forgot:?}");
    let landed = store.chunks.publish(held, b"{}".to_vec()).await;
    assert!(
        matches!(landed, Err(StorageError::Superseded)),
        "the held-up save must not land after the forget: {landed:?}"
    );
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

/// The memory of the largest sandbox, every chunk distinct, still fits in
/// one manifest.
#[test]
fn a_dense_manifest_of_the_largest_sandbox_fits() {
    use compute_storage::manifest::{Extent, MAX_MANIFEST_BYTES};
    const SAMPLE: u64 = 1024;
    let mut reference = EncodedChunk::encode(&[7; 4096], 1).unwrap().reference;
    reference.plain_len = u32::try_from(CHUNK_BYTES).unwrap();
    reference.stored_len = reference.plain_len;
    reference.checksums = Some(format!("crc32c={},md5={}", "A".repeat(8), "A".repeat(24)));
    let manifest = DiskManifest {
        version: 1,
        disk_len: SAMPLE * CHUNK_BYTES,
        base_len: 0,
        base_digest: "0".repeat(64),
        extents: (0..SAMPLE)
            .map(|index| Extent {
                offset: index * CHUNK_BYTES,
                length: CHUNK_BYTES,
                source: ExtentSource::Chunk {
                    reference: reference.clone(),
                    offset: 0,
                },
            })
            .collect(),
    };
    let sample = manifest.encode().unwrap().len() as u64;
    // The largest file's offsets take up to 3 more digits than the sample's.
    let per_chunk = sample.div_ceil(SAMPLE) + 3;
    let largest = u64::from(crate::protocol::MAX_MEMORY_MIB) << 20;
    let needed = per_chunk * (largest / CHUNK_BYTES);
    assert!(
        needed < MAX_MANIFEST_BYTES as u64,
        "{needed} bytes at {per_chunk} per chunk"
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
    base_files.disk = crate::store::JailedFile::new(&base);
    store
        .archive(
            id("00000000000000000000000000000001"),
            save(),
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
        saved.disk.path(),
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
        .archive(sandbox, save(), &saved, &CancellationToken::new())
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
        fs::read(saved.disk.path()).unwrap(),
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
        saved.disk.path(),
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
        .archive(sandbox, save(), &saved, &CancellationToken::new())
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
        saved.disk.path(),
        big,
        &[(5, b"disk"), (2 * CHUNK_BYTES + 7, b"far")],
    );
    let second = store
        .archive(sandbox, save(), &saved, &CancellationToken::new())
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
        prefilled,
        runtime,
    } = store.fetch(sandbox, &into).await.unwrap()
    else {
        panic!("memory should stay in the store");
    };
    assert_eq!(runtime.as_deref(), Some(RUNTIME), "the runtime comes back");
    assert_eq!(memory_len, big);
    assert!(prefilled.is_none(), "an unusable profile packs nothing");
    assert_eq!(
        fs::read(saved.disk.path()).unwrap(),
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
    let leftovers = fs::read_dir(into.disk.parent().unwrap())
        .unwrap()
        .filter(|entry| {
            let name = entry.as_ref().unwrap().file_name();
            name.to_string_lossy().contains(".fetching")
        })
        .count();
    assert_eq!(leftovers, 0, "staging files left behind");

    store.delete(sandbox, OwnerEpoch::FIRST).await.unwrap();
    assert!(!store.verify(sandbox, &second).await.unwrap());
    let gone = store.fetch(sandbox, &into).await.unwrap_err();
    assert_eq!(gone.kind, ErrorKind::Fatal);
}

const PAGE: u64 = 4096;

/// A saved sandbox whose guest touched three pages (one of them zeros)
/// first after its last wake, so its archive stores a working-set pack.
fn with_working_set(dir: &Path) -> SavedFiles {
    let mut saved = files(dir, true);
    let big = 4 * CHUNK_BYTES;
    sparse(saved.disk.path(), CHUNK_BYTES, &[(0, b"disk")]);
    let snapshot = saved.memory.clone().unwrap();
    sparse(&snapshot.state, 10, &[(0, b"state")]);
    sparse(
        &snapshot.memory,
        big,
        &[
            (0, b"first"),
            (2 * CHUNK_BYTES, b"x"),
            (2 * CHUNK_BYTES + PAGE, b"y"),
            (CHUNK_BYTES, b"cold"),
        ],
    );
    // The guest touched these first after its last wake; the third is zeros.
    let learned = WakeProfile {
        version: 1,
        offsets: vec![2 * CHUNK_BYTES, 0, 3 * CHUNK_BYTES, 2 * CHUNK_BYTES + PAGE],
        page_size: PAGE,
    };
    fs::write(dir.join("profile"), serde_json::to_vec(&learned).unwrap()).unwrap();
    saved.profile = Some(dir.join("profile"));
    saved
}

#[tokio::test]
async fn a_wake_brings_its_working_set_back_with_the_state() {
    let dir = tempfile::tempdir().unwrap();
    let saved = with_working_set(dir.path());
    let snapshot = saved.memory.clone().unwrap();
    let big = 4 * CHUNK_BYTES;
    let store = Chunked::new(ChunkStore::new(
        Arc::new(InMemory::new()),
        ObjectPath::from("t"),
    ));
    let sandbox = id("0123456789abcdef0123456789abcdef");
    store
        .archive(sandbox, save(), &saved, &CancellationToken::new())
        .await
        .unwrap()
        .stored()
        .unwrap();

    let restored = tempfile::tempdir().unwrap();
    let into = into(restored.path(), true);
    let FetchedMemory::Remote {
        state,
        memory_len,
        chunks: map,
        manifest,
        prefilled: Some(prefilled),
        ..
    } = store.fetch(sandbox, &into).await.unwrap()
    else {
        panic!("the working set should come back with the state");
    };
    assert_eq!(
        prefilled.pages,
        [
            0..PAGE,
            2 * CHUNK_BYTES..2 * CHUNK_BYTES + 2 * PAGE,
            3 * CHUNK_BYTES..3 * CHUNK_BYTES + PAGE
        ]
    );
    let original = fs::read(&snapshot.memory).unwrap();
    let fetched = fs::read(&prefilled.memory).unwrap();
    assert_eq!(fetched.len() as u64, big);
    for range in &prefilled.pages {
        let range = usize::try_from(range.start).unwrap()..usize::try_from(range.end).unwrap();
        assert_eq!(fetched[range.clone()], original[range]);
    }
    // Nothing outside the working set is there yet.
    let cold = usize::try_from(CHUNK_BYTES).unwrap();
    assert_eq!(&fetched[cold..cold + 4], &[0; 4]);

    // Published as a remote image, it keeps what was filled.
    let images = crate::image::Images::new(restored.path().join("images"));
    let image = images
        .publish(crate::image::Parts::Remote {
            state: &state,
            memory_len,
            chunks: crate::image::ChunkMap(map),
            manifest: &manifest,
            prefilled: Some(&prefilled),
        })
        .unwrap();
    assert_eq!(images.filled(&image).unwrap(), prefilled.pages);
    assert!(!prefilled.memory.exists(), "the file was moved in");
    let memory = fs::read(images.memory(image.generation())).unwrap();
    assert_eq!(memory, fetched);
}

#[tokio::test]
async fn a_chunk_map_skips_unchanged_chunks_and_catches_a_changed_image() {
    let dir = tempfile::tempdir().unwrap();
    let mut saved = files(dir.path(), true);
    let big = 4 * CHUNK_BYTES;
    sparse(saved.disk.path(), CHUNK_BYTES, &[(0, b"disk")]);
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
        .archive(sandbox, save(), &saved, &CancellationToken::new())
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
        .archive(sandbox, save(), &saved, &CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Fatal);
    saved.memory.as_mut().unwrap().chunks = Some(map);
    store
        .archive(sandbox, save(), &saved, &CancellationToken::new())
        .await
        .unwrap()
        .stored()
        .unwrap();
}

#[tokio::test]
async fn a_disk_only_copy_cannot_supply_a_memory_image() {
    let dir = tempfile::tempdir().unwrap();
    let saved = files(dir.path(), false);
    sparse(saved.disk.path(), CHUNK_BYTES, &[(0, b"disk")]);
    let store = Chunked::new(ChunkStore::new(
        Arc::new(InMemory::new()),
        ObjectPath::from("t"),
    ));
    let sandbox = id("00000000000000000000000000000001");
    store
        .archive(sandbox, save(), &saved, &CancellationToken::new())
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
    let mut saved = files(dir.path(), true);
    let profile = dir.path().join("profile");
    fs::write(&profile, b"[0,1]").unwrap();
    saved.profile = Some(profile);
    sparse(saved.disk.path(), 4 * CHUNK_BYTES, &[(0, b"disk")]);
    let image = saved.memory.clone().unwrap();
    sparse(&image.state, 10, &[(0, b"s")]);
    sparse(&image.memory, 2 * CHUNK_BYTES, &[(0, b"one")]);
    let backend = Arc::new(InMemory::new());
    let store = Chunked::new(ChunkStore::new(backend.clone(), ObjectPath::from("t")));
    let sandbox = id("00000000000000000000000000000003");
    let cancelled = CancellationToken::new();
    cancelled.cancel();

    // Nothing stored yet: a cancelled archive writes nothing at all.
    let outcome = store
        .archive(sandbox, save(), &saved, &cancelled)
        .await
        .unwrap();
    assert_eq!(outcome, Archive::Cancelled);
    assert_eq!(objects(&backend, "t").await, 0);

    let first = store
        .archive(sandbox, save(), &saved, &CancellationToken::new())
        .await
        .unwrap()
        .stored()
        .unwrap();
    let before = objects(&backend, "t").await;
    // A changed sandbox whose archive is cancelled leaves the store
    // naming, and holding, the earlier copy.
    sparse(
        saved.disk.path(),
        4 * CHUNK_BYTES,
        &[(3 * CHUNK_BYTES, b"new")],
    );
    let outcome = store
        .archive(sandbox, save(), &saved, &cancelled)
        .await
        .unwrap();
    assert_eq!(outcome, Archive::Cancelled);
    assert_eq!(objects(&backend, "t").await, before);
    assert!(store.verify(sandbox, &first).await.unwrap());

    let second = store
        .archive(sandbox, save(), &saved, &CancellationToken::new())
        .await
        .unwrap()
        .stored()
        .unwrap();
    assert_ne!(first, second);
    assert!(store.verify(sandbox, &second).await.unwrap());
}

#[tokio::test]
async fn a_copy_missing_a_chunk_fails_verification_until_archived_again() {
    let dir = tempfile::tempdir().unwrap();
    let saved = files(dir.path(), true);
    sparse(saved.disk.path(), 2 * CHUNK_BYTES, &[(0, b"disk")]);
    let image = saved.memory.clone().unwrap();
    sparse(&image.state, 10, &[(0, b"s")]);
    sparse(&image.memory, 3 * CHUNK_BYTES, &[(CHUNK_BYTES, b"memory")]);
    let backend = Arc::new(InMemory::new());
    let store = Chunked::new(ChunkStore::new(backend.clone(), ObjectPath::from("t")));
    let sandbox = id("00000000000000000000000000000005");
    let archive = |store: &Chunked| {
        let store = store.clone();
        let saved = saved.clone();
        async move {
            store
                .archive(sandbox, save(), &saved, &CancellationToken::new())
                .await
                .unwrap()
                .stored()
                .unwrap()
        }
    };
    let first = archive(&store).await;
    assert!(store.verify(sandbox, &first).await.unwrap());

    // Lose the memory chunk: the manifests are all there, the copy is not.
    let memory_chunk = EncodedChunk::encode(
        &{
            let mut plain = vec![0; usize::try_from(CHUNK_BYTES).unwrap()];
            plain[..6].copy_from_slice(b"memory");
            plain
        },
        ZSTD_LEVEL,
    )
    .unwrap();
    let key = ObjectPath::from(format!("t/{}", memory_chunk.object_key()));
    backend.delete(&key).await.unwrap();
    assert!(!store.verify(sandbox, &first).await.unwrap());

    // The same content archived again stores the chunk once more instead
    // of naming the lost one.
    let second = archive(&store).await;
    assert!(store.verify(sandbox, &second).await.unwrap());
    backend.head(&key).await.unwrap();

    // Same-length damage: the length is right, the bytes are not. It must
    // block eviction, and archiving again must repair the shared chunk from
    // the local copy rather than keep naming the damaged one.
    let mut damaged = memory_chunk.bytes.clone();
    damaged[2] ^= 0x01;
    backend.put(&key, damaged.into()).await.unwrap();
    assert!(!store.verify(sandbox, &second).await.unwrap());
    let third = archive(&store).await;
    assert!(store.verify(sandbox, &third).await.unwrap());
    let stored = backend.get(&key).await.unwrap().bytes().await.unwrap();
    assert_eq!(stored.as_ref(), memory_chunk.bytes.as_slice());
}

/// A sweep keeps everything a stored copy needs, its working-set pack
/// included; what a forgotten memory image, its pack included, or a
/// deleted copy alone named becomes sweepable, and what another copy
/// shares stays.
#[tokio::test]
async fn a_sweep_keeps_what_stored_copies_name() {
    use compute_storage::fresh::Clock;

    let dir = tempfile::tempdir().unwrap();
    let saved = with_working_set(dir.path());
    let other_dir = tempfile::tempdir().unwrap();
    let other = files(other_dir.path(), false);
    // The same disk: the two copies share its chunk and manifest.
    sparse(other.disk.path(), CHUNK_BYTES, &[(0, b"disk")]);
    let chunks = ChunkStore::new(Arc::new(InMemory::new()), ObjectPath::from("t"));
    let store = Chunked::new(chunks.clone());
    let (with_memory, disk_only) = (
        id("0123456789abcdef0123456789abcdef"),
        id("fedcba9876543210fedcba9876543210"),
    );
    for (sandbox, files) in [(with_memory, &saved), (disk_only, &other)] {
        store
            .archive(sandbox, save(), files, &CancellationToken::new())
            .await
            .unwrap()
            .stored()
            .unwrap();
    }
    let pointer = chunks
        .get_pointer(&with_memory.to_string())
        .await
        .unwrap()
        .unwrap();
    let pack = parse_head("test", &pointer).unwrap().pack.unwrap();
    let parts = working_set::parts(&chunks, &pack).await.unwrap();
    let named = store.names(&pointer).await.unwrap();
    assert_ne!(parts.len(), 0);
    for kept in parts.iter().chain([&pack]) {
        assert!(named.contains(&kept.key()), "the pack is kept");
    }
    // A pack holds memory pages: a copy without memory keeps none.
    let disk_only_with_pack = serde_json::to_vec(&Head {
        memory: None,
        ..parse_head("test", &pointer).unwrap()
    })
    .unwrap();
    let named = store.names(&disk_only_with_pack).await.unwrap();
    for gone in parts.iter().chain([&pack]) {
        assert!(!named.contains(&gone.key()), "a pack without its memory");
    }

    // Seen from a month ahead, everything stored is old enough to go.
    let later = SystemTime::now() + Duration::from_secs(30 * 86_400);
    let ahead = Chunked::new(chunks.clone().with_clock(Clock::from_fn(move || later)));
    let report = ahead.sweep(false).await.unwrap();
    assert_eq!((report.pointers, report.unnamed), (2, 0), "{report:?}");
    assert_eq!(report.named, report.stored);

    store.forget_memory(with_memory, save()).await.unwrap();
    let pointer = chunks
        .get_pointer(&with_memory.to_string())
        .await
        .unwrap()
        .unwrap();
    assert!(parse_head("test", &pointer).unwrap().pack.is_none());
    let named = store.names(&pointer).await.unwrap();
    for gone in parts.iter().chain([&pack]) {
        assert!(
            !named.contains(&gone.key()),
            "the pack goes with the memory"
        );
    }
    let forgotten = ahead.sweep(false).await.unwrap();
    assert!(
        forgotten.unnamed >= 3,
        "the image's manifests and the pack: {forgotten:?}"
    );
    assert_eq!(forgotten.named + forgotten.unnamed, forgotten.stored);

    store.delete(with_memory, OwnerEpoch::FIRST).await.unwrap();
    let shared = ahead.sweep(false).await.unwrap();
    // This store deletes on no condition, so the deleted copy's pointer
    // stays, empty, naming nothing.
    assert_eq!(shared.pointers, 2);
    assert!(shared.named >= 2, "the shared disk stays: {shared:?}");
    assert_eq!(shared.named + shared.unnamed, shared.stored);

    store.delete(disk_only, OwnerEpoch::FIRST).await.unwrap();
    let none = ahead.sweep(false).await.unwrap();
    assert_eq!((none.named, none.unnamed), (0, none.stored));
}
