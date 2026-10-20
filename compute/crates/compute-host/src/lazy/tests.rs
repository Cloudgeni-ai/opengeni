use super::*;

/// Local writes still to fail, by the memory file's inode.
static FAILING: Mutex<Vec<(u64, u32)>> = Mutex::new(Vec::new());

/// Fails a write into `file` while failures are left for it, as a
/// full disk would.
pub(super) fn failing_write(file: &File) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt as _;
    let inode = file.metadata()?.ino();
    let mut failing = lock(&FAILING);
    match failing
        .iter_mut()
        .find(|(at, left)| *at == inode && *left > 0)
    {
        Some((_, left)) => {
            *left -= 1;
            Err(io::Error::new(
                io::ErrorKind::StorageFull,
                "simulated full disk",
            ))
        }
        None => Ok(()),
    }
}

const PAGE: u64 = 4096;

/// Cached chunks leave [`CACHE_FOR`] after they arrived, with the
/// bytes they held, whether the agent samples or the next fetch lands.
#[test]
fn cached_chunks_leave_a_minute_after_they_arrived() {
    let start = tokio::time::Instant::now();
    let chunk = |byte| Arc::new(vec![byte; 4096]);
    let mut cache = Cache::default();
    assert_eq!(cache.insert("a".into(), chunk(1), start).len(), 0);
    let later = start + Duration::from_secs(30);
    assert_eq!(cache.insert("b".into(), chunk(2), later).len(), 0);
    assert_eq!(cache.bytes, 2 * 4096);

    let just_before = start + CACHE_FOR - Duration::from_millis(1);
    assert_eq!(cache.expire(just_before).len(), 0);
    let expired = cache.expire(start + CACHE_FOR);
    assert_eq!(expired.len(), 1);
    assert_eq!(expired[0][0], 1, "the oldest goes first");
    assert!(!cache.chunks.contains_key("a"));
    assert_eq!((cache.bytes, cache.order.len()), (4096, 1));

    // A fetch landing takes out what has expired by then, and a chunk
    // fetched again after it left comes back.
    let evicted = cache.insert("a".into(), chunk(3), later + CACHE_FOR);
    assert_eq!(evicted.len(), 1);
    assert_eq!(evicted[0][0], 2);
    assert_eq!((cache.bytes, cache.order.len()), (4096, 1));
    assert_eq!(cache.chunks["a"][0], 3);
    assert_eq!(cache.expire(later + 3 * CACHE_FOR).len(), 1);
    assert_eq!(
        (cache.bytes, cache.chunks.len(), cache.order.len()),
        (0, 0, 0)
    );
}

/// Hydrates a three-chunk image whose chunk 1 is never stored, with
/// `filled` written into the memory file first by `prefill`.
async fn hydrate(
    filled: &[std::ops::Range<u64>],
    prefill: impl Fn(&File, &[Vec<u8>]),
) -> (Result<(), Unavailable>, Vec<u8>, Vec<u8>) {
    hydrate_failing(0, filled, prefill).await
}

/// [`hydrate`], with the first `failing` writes into the memory file
/// failing as on a full disk.
async fn hydrate_failing(
    failing: u32,
    filled: &[std::ops::Range<u64>],
    prefill: impl Fn(&File, &[Vec<u8>]),
) -> (Result<(), Unavailable>, Vec<u8>, Vec<u8>) {
    let (hydration, file, plain, _dir) = start(failing, filled, prefill).await;
    let finished = tokio::time::timeout(Duration::from_secs(10), hydration.finished())
        .await
        .unwrap_or_else(|_| Err(Unavailable::passing("still hydrating".to_owned())));
    let mut held = vec![0; plain.concat().len()];
    file.read_exact_at(&mut held, 0).unwrap();
    (finished, held, plain.concat())
}

/// Starts the hydration [`hydrate_failing`] waits for, returning it,
/// the memory file, each chunk's bytes and the file's directory.
async fn start(
    failing: u32,
    filled: &[std::ops::Range<u64>],
    prefill: impl Fn(&File, &[Vec<u8>]),
) -> (Arc<Hydration>, File, Vec<Vec<u8>>, tempfile::TempDir) {
    let chunk = usize::try_from(CHUNK_BYTES).unwrap();
    let plain: Vec<Vec<u8>> = (1..=3_u8).map(|fill| vec![fill; chunk]).collect();
    let backend = Arc::new(object_store::memory::InMemory::new());
    let chunks = ChunkStore::new(backend, object_store::path::Path::from("p"));
    let encoded: Vec<_> = plain
        .iter()
        .map(|bytes| compute_storage::chunk::EncodedChunk::encode(bytes, 1).unwrap())
        .collect();
    for (index, chunk) in encoded.iter().enumerate() {
        if index != 1 {
            chunks.put_chunk(chunk).await.unwrap();
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("memory");
    let file = File::options()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    file.set_len(3 * CHUNK_BYTES).unwrap();
    prefill(&file, &plain);
    {
        use std::os::unix::fs::MetadataExt as _;
        lock(&FAILING).push((file.metadata().unwrap().ino(), failing));
    }
    let (hydration, _arrivals) = Hydration::start(
        Arc::new(Fetcher::new(chunks, Arc::default())),
        &path,
        encoded
            .iter()
            .map(|chunk| Some(chunk.reference.clone()))
            .collect(),
        plain.iter().map(|bytes| chunk_hash(bytes)).collect(),
        PageSet::new(filled),
        &[],
        &[],
    )
    .unwrap();
    (hydration, file, plain, dir)
}

#[tokio::test]
async fn filled_pages_are_kept_and_a_filled_chunk_is_checked_in_place() {
    let filled = [0..PAGE, CHUNK_BYTES..2 * CHUNK_BYTES];
    let (finished, held, image) = hydrate(&filled, |file, plain| {
        file.write_all_at(&plain[0][..4096], 0).unwrap();
        file.write_all_at(&plain[1], CHUNK_BYTES).unwrap();
    })
    .await;
    finished.unwrap();
    assert_eq!(held, image);
}

/// A write that fails on the host's own disk, such as a full one, is
/// tried again with the chunk already fetched: the sandbox waits for
/// room instead of losing its memory.
#[tokio::test]
async fn a_failing_local_write_is_tried_again() {
    let filled = CHUNK_BYTES..2 * CHUNK_BYTES;
    let (finished, held, image) =
        hydrate_failing(3, std::slice::from_ref(&filled), |file, plain| {
            file.write_all_at(&plain[1], CHUNK_BYTES).unwrap();
        })
        .await;
    finished.unwrap();
    assert_eq!(held, image);
}

#[tokio::test]
async fn filled_pages_that_differ_from_their_chunk_fail_for_good() {
    // A wrong page in a chunk that is fetched.
    let filled = [PAGE..2 * PAGE, CHUNK_BYTES..2 * CHUNK_BYTES];
    let (finished, _, _) = hydrate(&filled, |file, plain| {
        file.write_all_at(&[9; 4096], PAGE).unwrap();
        file.write_all_at(&plain[1], CHUNK_BYTES).unwrap();
    })
    .await;
    assert!(finished.unwrap_err().permanent);
    // A wrong byte in a chunk filled whole, which is not fetched.
    let (finished, _, _) = hydrate(
        std::slice::from_ref(&(CHUNK_BYTES..2 * CHUNK_BYTES)),
        |file, plain| {
            file.write_all_at(&plain[1], CHUNK_BYTES).unwrap();
            file.write_all_at(&[9], CHUNK_BYTES + 100).unwrap();
        },
    )
    .await;
    assert!(finished.unwrap_err().permanent);
}

/// A failed fill still counts as writing to local disk until its fetch
/// task has ended and every write it started has landed, so the disk
/// it fills is not taken as settled while a write may grow it.
#[tokio::test]
async fn a_failed_fill_writes_until_its_writes_have_landed() {
    let filled = [PAGE..2 * PAGE, CHUNK_BYTES..2 * CHUNK_BYTES];
    let (hydration, _file, _plain, _dir) = start(0, &filled, |file, plain| {
        file.write_all_at(&[9; 4096], PAGE).unwrap();
        file.write_all_at(&plain[1], CHUNK_BYTES).unwrap();
    })
    .await;
    // A write still under way, as on a blocking thread.
    let write = Arc::clone(&hydration.writers).try_acquire_owned().unwrap();
    let finished = tokio::time::timeout(Duration::from_secs(10), hydration.finished())
        .await
        .unwrap();
    assert!(finished.unwrap_err().permanent);
    let ended = |hydration: &Hydration| {
        lock(&hydration.task)
            .as_ref()
            .is_none_or(tokio::task::JoinHandle::is_finished)
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !ended(&hydration) && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(ended(&hydration), "the fetch task did not end");
    assert!(hydration.is_writing(), "a write under way was not counted");
    drop(write);
    assert!(!hydration.is_writing());
}

/// An in-memory store whose reads fail, as if it did not answer, while
/// `down` is set.
#[derive(Debug, Default)]
struct Flaky {
    inner: object_store::memory::InMemory,
    down: AtomicBool,
}

impl std::fmt::Display for Flaky {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("flaky")
    }
}

#[async_trait::async_trait]
impl object_store::ObjectStore for Flaky {
    async fn put_opts(
        &self,
        location: &object_store::path::Path,
        payload: object_store::PutPayload,
        opts: object_store::PutOptions,
    ) -> object_store::Result<object_store::PutResult> {
        self.inner.put_opts(location, payload, opts).await
    }

    async fn put_multipart_opts(
        &self,
        location: &object_store::path::Path,
        opts: object_store::PutMultipartOptions,
    ) -> object_store::Result<Box<dyn object_store::MultipartUpload>> {
        self.inner.put_multipart_opts(location, opts).await
    }

    async fn get_opts(
        &self,
        location: &object_store::path::Path,
        options: object_store::GetOptions,
    ) -> object_store::Result<object_store::GetResult> {
        if self.down.load(Ordering::Relaxed) {
            return Err(object_store::Error::Generic {
                store: "flaky",
                source: "connection refused".into(),
            });
        }
        self.inner.get_opts(location, options).await
    }

    async fn delete(&self, location: &object_store::path::Path) -> object_store::Result<()> {
        self.inner.delete(location).await
    }

    fn list(
        &self,
        prefix: Option<&object_store::path::Path>,
    ) -> futures::stream::BoxStream<'static, object_store::Result<object_store::ObjectMeta>> {
        self.inner.list(prefix)
    }

    async fn list_with_delimiter(
        &self,
        prefix: Option<&object_store::path::Path>,
    ) -> object_store::Result<object_store::ListResult> {
        self.inner.list_with_delimiter(prefix).await
    }

    async fn copy(
        &self,
        from: &object_store::path::Path,
        to: &object_store::path::Path,
    ) -> object_store::Result<()> {
        self.inner.copy(from, to).await
    }

    async fn copy_if_not_exists(
        &self,
        from: &object_store::path::Path,
        to: &object_store::path::Path,
    ) -> object_store::Result<()> {
        self.inner.copy_if_not_exists(from, to).await
    }
}

/// A store that stops answering stalls hydration, which carries on
/// once it answers again: nothing is lost however long it takes.
#[tokio::test]
async fn a_store_that_does_not_answer_stalls_hydration_without_losing_it() {
    let chunk = usize::try_from(CHUNK_BYTES).unwrap();
    let plain: Vec<Vec<u8>> = (1..=3_u8).map(|fill| vec![fill; chunk]).collect();
    let backend = Arc::new(Flaky::default());
    let chunks = ChunkStore::new(
        Arc::clone(&backend) as Arc<dyn object_store::ObjectStore>,
        object_store::path::Path::from("p"),
    );
    let encoded: Vec<_> = plain
        .iter()
        .map(|bytes| compute_storage::chunk::EncodedChunk::encode(bytes, 1).unwrap())
        .collect();
    for chunk in &encoded {
        chunks.put_chunk(chunk).await.unwrap();
    }
    backend.down.store(true, Ordering::Relaxed);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("memory");
    let file = File::options()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    file.set_len(3 * CHUNK_BYTES).unwrap();
    let fetcher = Arc::new(Fetcher::new(chunks, Arc::default()));
    let (hydration, _arrivals) = Hydration::start(
        Arc::clone(&fetcher),
        &path,
        encoded
            .iter()
            .map(|chunk| Some(chunk.reference.clone()))
            .collect(),
        plain.iter().map(|bytes| chunk_hash(bytes)).collect(),
        PageSet::new(&[]),
        &[],
        &[],
    )
    .unwrap();

    let waited = tokio::time::Instant::now();
    while fetcher.stalled_for().is_none() {
        assert!(
            waited.elapsed() < STALL_AFTER + Duration::from_secs(10),
            "never reported as stalled"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(500), hydration.finished())
            .await
            .is_err(),
        "a store that does not answer neither fails nor finishes hydration"
    );

    backend.down.store(false, Ordering::Relaxed);
    tokio::time::timeout(Duration::from_secs(30), hydration.finished())
        .await
        .expect("hydration carries on once the store answers")
        .unwrap();
    // The stall ends with the fetch that wrote the last chunk, just
    // after that write completed hydration.
    tokio::time::timeout(Duration::from_secs(1), async {
        while fetcher.stalled_for().is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("no longer stalled once every chunk is in place");
    let mut held = vec![0; 3 * chunk];
    file.read_exact_at(&mut held, 0).unwrap();
    assert_eq!(held, plain.concat());
}
