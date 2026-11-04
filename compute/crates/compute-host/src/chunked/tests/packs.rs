//! Archives storing their chunks in packs (ADR 31).

use super::*;

/// A clock stopped half way through an hour, so no test spans two.
fn mid_hour() -> compute_storage::fresh::Clock {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let at = SystemTime::UNIX_EPOCH + Duration::from_secs(now - now % 3_600 + 1_800);
    compute_storage::fresh::Clock::from_fn(move || at)
}

fn packed(backend: &Arc<Counted>) -> Chunked {
    Chunked::new(ChunkStore::new(backend.clone(), ObjectPath::from("t")).with_clock(mid_hour()))
}

fn unpacked(backend: &Arc<Counted>) -> Chunked {
    Chunked::new(
        ChunkStore::new(backend.clone(), ObjectPath::from("t"))
            .with_clock(mid_hour())
            .with_packs(false),
    )
}

/// Writes a disk of eight chunks, chunk `i` holding `marks[i]` a few times.
fn disk_of(saved: &SavedFiles, marks: [u8; 8]) {
    let bytes: Vec<(u64, Vec<u8>)> = (0_u64..)
        .zip(marks)
        .map(|(index, mark)| (at_chunk(index, 1), vec![mark; 64]))
        .collect();
    let writes: Vec<(u64, &[u8])> = bytes.iter().map(|(at, b)| (*at, b.as_slice())).collect();
    sparse(saved.disk.path(), at_chunk(8, 0), &writes);
}

/// The stored objects under `prefix`, with their sizes.
async fn listed(backend: &Counted, prefix: &str) -> Vec<(ObjectPath, u64)> {
    let mut found: Vec<_> = backend
        .inner
        .list(Some(&ObjectPath::from(prefix)))
        .map_ok(|meta| (meta.location, meta.size))
        .try_collect()
        .await
        .unwrap();
    found.sort();
    found
}

async fn delete_all(backend: &Counted, prefix: &str) {
    for (location, _) in listed(backend, prefix).await {
        backend.inner.delete(&location).await.unwrap();
    }
}

/// The sandbox's disk as a fetch brings it back.
async fn fetched_disk(store: &Chunked, sandbox: Id) -> Result<Vec<u8>, EngineError> {
    let dir = tempfile::tempdir().unwrap();
    let into = into(dir.path(), false);
    store.fetch(sandbox, &into).await?;
    Ok(fs::read(&into.disk).unwrap())
}

/// An archive's new chunks go into packs, not objects of their own; the
/// copy is written in the packs format and comes back byte for byte, and
/// an unchanged copy archived again stores nothing.
#[tokio::test]
async fn an_archive_packs_its_chunks_and_comes_back_byte_for_byte() {
    let dir = tempfile::tempdir().unwrap();
    let saved = files(dir.path(), false);
    disk_of(&saved, *b"abcdefgh");
    let backend = Arc::new(Counted::default());
    let store = packed(&backend);
    let sandbox = id("000000000000000000000000000000a1");
    archived(&store, sandbox, &saved).await;
    assert_eq!(objects(&backend.inner, "t/chunks").await, 0);
    assert_eq!(
        listed(&backend, "t/packs").await.len(),
        1,
        "eight chunks, one pack"
    );
    let head = store.head("test", sandbox).await.unwrap().unwrap();
    assert_eq!(head.version, copy::VERSION_PACKS);
    let disk = fs::read(saved.disk.path()).unwrap();
    assert_eq!(fetched_disk(&store, sandbox).await.unwrap(), disk);

    backend.take();
    archived(&store, sandbox, &saved).await;
    assert_eq!(backend.take().1, 0, "nothing stored again");
    assert_eq!(listed(&backend, "t/packs").await.len(), 1);
}

/// A copy an earlier release stored as one object per chunk moves whole
/// into packs at its next archive, from the local bytes: once archived,
/// it no longer needs any of those objects.
#[tokio::test]
async fn a_copy_of_chunk_objects_moves_into_packs_at_its_next_archive() {
    let dir = tempfile::tempdir().unwrap();
    let saved = files(dir.path(), false);
    disk_of(&saved, *b"abcdefgh");
    let backend = Arc::new(Counted::default());
    let sandbox = id("000000000000000000000000000000a2");
    archived(&unpacked(&backend), sandbox, &saved).await;
    assert_eq!(objects(&backend.inner, "t/chunks").await, 8);

    let store = packed(&backend);
    archived(&store, sandbox, &saved).await;
    assert_eq!(listed(&backend, "t/packs").await.len(), 1);
    delete_all(&backend, "t/chunks").await;
    let disk = fs::read(saved.disk.path()).unwrap();
    assert_eq!(fetched_disk(&store, sandbox).await.unwrap(), disk);
}

/// A pack the next copy would name less than half of is not kept alive
/// for the few chunks left in it: those are stored again with the new
/// ones. A pack still named for at least half is reused as it is.
#[tokio::test]
async fn chunks_left_in_a_mostly_replaced_pack_are_stored_again() {
    let dir = tempfile::tempdir().unwrap();
    let saved = files(dir.path(), false);
    disk_of(&saved, *b"abcdefgh");
    let backend = Arc::new(Counted::default());
    let store = packed(&backend);
    let sandbox = id("000000000000000000000000000000a3");
    archived(&store, sandbox, &saved).await;
    let first = listed(&backend, "t/packs").await;

    // Five of eight change: the three left are stored again, so the copy
    // no longer names the first pack.
    disk_of(&saved, *b"ABCDEfgh");
    archived(&store, sandbox, &saved).await;
    for (location, _) in &first {
        backend.inner.delete(location).await.unwrap();
    }
    let disk = fs::read(saved.disk.path()).unwrap();
    assert_eq!(fetched_disk(&store, sandbox).await.unwrap(), disk);
    let second = listed(&backend, "t/packs").await;
    assert_eq!(second.len(), 1);

    // Two of eight change: the six left are reused where they are, and
    // the new pack holds only the two.
    disk_of(&saved, *b"xyCDEfgh");
    archived(&store, sandbox, &saved).await;
    let third: Vec<_> = listed(&backend, "t/packs")
        .await
        .into_iter()
        .filter(|pack| !second.contains(pack))
        .collect();
    assert_eq!(third.len(), 1);
    assert!(
        third[0].1 * 2 < second[0].1,
        "the new pack holds two chunks: {third:?} beside {second:?}"
    );
    let disk = fs::read(saved.disk.path()).unwrap();
    assert_eq!(fetched_disk(&store, sandbox).await.unwrap(), disk);
    backend.inner.delete(&second[0].0).await.unwrap();
    assert!(
        fetched_disk(&store, sandbox).await.is_err(),
        "the copy still names the second pack"
    );
}

/// A fetch reads the chunks of a file that follow one another in a pack
/// with one request, where chunks stored on their own take one each.
#[tokio::test]
async fn a_fetch_reads_the_chunks_of_a_pack_with_one_request() {
    let dir = tempfile::tempdir().unwrap();
    let saved = files(dir.path(), false);
    disk_of(&saved, *b"abcdefgh");
    let disk = fs::read(saved.disk.path()).unwrap();
    let sandbox = id("000000000000000000000000000000a4");
    for (store, backend, reads) in [
        (packed as fn(&Arc<Counted>) -> Chunked, Arc::default(), 1),
        (unpacked, Arc::default(), 8),
    ] {
        let backend: Arc<Counted> = backend;
        let store = store(&backend);
        archived(&store, sandbox, &saved).await;
        backend.take();
        assert_eq!(fetched_disk(&store, sandbox).await.unwrap(), disk);
        assert_eq!(backend.take().0, reads);
    }
}
