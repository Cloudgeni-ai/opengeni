use std::collections::BTreeSet;
use std::path::PathBuf;

use futures::TryStreamExt as _;
use object_store::memory::InMemory;
use object_store::{ObjectStore, PutPayload, path::Path as ObjectPath};

use super::*;

const PAGE: u64 = 4096;
const PAGE_LEN: usize = 4096;

/// A memory image of `pages` pages: page `n` is filled with `n % 251 + 1`,
/// except the pages in `zeros`, which stay zero.
fn image(dir: &Path, pages: u64, zeros: &[u64]) -> PathBuf {
    let path = dir.join("memory");
    let file = File::create(&path).unwrap();
    file.set_len(pages * PAGE).unwrap();
    for page in (0..pages).filter(|page| !zeros.contains(page)) {
        let byte = u8::try_from(page % 251 + 1).unwrap();
        file.write_all_at(&[byte; PAGE_LEN], page * PAGE).unwrap();
    }
    path
}

fn store() -> (Arc<InMemory>, ChunkStore) {
    let backend = Arc::new(InMemory::new());
    let chunks = ChunkStore::new(backend.clone(), ObjectPath::from("p"));
    (backend, chunks)
}

fn transfers() -> Arc<Semaphore> {
    Arc::new(Semaphore::new(4))
}

fn profile(offsets: Vec<u64>, page_size: u64) -> WakeProfile {
    WakeProfile {
        version: 1,
        offsets,
        page_size,
    }
}

async fn index_of(chunks: &ChunkStore, index: &ChunkRef) -> PackIndex {
    serde_json::from_slice(&chunks.get_chunk(index).await.unwrap()).unwrap()
}

async fn location(backend: &InMemory, chunk: &ChunkRef) -> ObjectPath {
    let objects: Vec<_> = backend.list(None).try_collect().await.unwrap();
    objects
        .into_iter()
        .find(|object| object.location.as_ref().contains(&chunk.stored_hash))
        .expect("the chunk is stored")
        .location
}

async fn stored(backend: &InMemory, chunk: &ChunkRef) -> Vec<u8> {
    let location = location(backend, chunk).await;
    let object = backend.get(&location).await.unwrap();
    object.bytes().await.unwrap().to_vec()
}

/// Replaces the stored object of `chunk` with `bytes`.
async fn overwrite(backend: &InMemory, chunk: &ChunkRef, bytes: Vec<u8>) {
    let location = location(backend, chunk).await;
    backend
        .put(&location, PutPayload::from(bytes))
        .await
        .unwrap();
}

/// Fetches `index` into a fresh file of `len` bytes, every chunk holding
/// data; returns the file and the ranges filled.
async fn fetch_into(
    chunks: &ChunkStore,
    dir: &Path,
    index: &ChunkRef,
    len: u64,
) -> (Arc<File>, Vec<Range<u64>>) {
    let data: Arc<[bool]> = vec![false; usize::try_from(len.div_ceil(CHUNK_BYTES)).unwrap()].into();
    fetch_with(chunks, dir, index, len, &data).await
}

async fn fetch_with(
    chunks: &ChunkStore,
    dir: &Path,
    index: &ChunkRef,
    len: u64,
    zero_chunks: &Arc<[bool]>,
) -> (Arc<File>, Vec<Range<u64>>) {
    let path = dir.join("fetched");
    let _ = std::fs::remove_file(&path);
    let file = File::options()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)
        .unwrap();
    file.set_len(len).unwrap();
    let file = Arc::new(file);
    let filled = fetch(chunks, &transfers(), index, &file, len, zero_chunks).await;
    (file, filled)
}

fn page_bytes(file: &File, offset: u64) -> Vec<u8> {
    let mut bytes = vec![0; PAGE_LEN];
    file.read_exact_at(&mut bytes, offset).unwrap();
    bytes
}

fn pages_of(ranges: &[Range<u64>]) -> Vec<u64> {
    ranges
        .iter()
        .flat_map(|range| (range.start..range.end).step_by(PAGE_LEN))
        .collect()
}

#[tokio::test]
async fn a_pack_brings_back_the_working_set_in_growing_parts() {
    let dir = tempfile::tempdir().unwrap();
    let zeros = [3, 700, 1201];
    let memory = image(dir.path(), 2048, &zeros);
    // 1,500 pages in a scattered first-touch order, with repeats and an
    // offset inside a page, which counts once for its page.
    let order: Vec<u64> = (0..1500_u64).map(|n| (n * 7 % 2048) * PAGE).collect();
    let mut offsets = order.clone();
    offsets.insert(10, order[2] + 17);
    offsets.push(order[0]);
    let (_backend, chunks) = store();
    let index = put(
        &chunks,
        &transfers(),
        &memory,
        &profile(offsets, PAGE),
        &CancellationToken::new(),
    )
    .await
    .unwrap()
    .expect("the profile names pages");

    let pack = index_of(&chunks, &index).await;
    pack.check(2048 * PAGE).unwrap();
    let zero_pages: BTreeSet<u64> = pack.zeros.iter().copied().collect();
    let expected_zeros: BTreeSet<u64> = order
        .iter()
        .copied()
        .filter(|offset| zeros.contains(&(offset / PAGE)))
        .collect();
    assert_eq!(zero_pages, expected_zeros);
    assert!(!expected_zeros.is_empty());
    // In first-touch order, part after part, zeros left out.
    let packed: Vec<u64> = pack
        .parts
        .iter()
        .flat_map(|part| part.pages.clone())
        .collect();
    let in_order: Vec<u64> = order
        .iter()
        .copied()
        .filter(|offset| !zeros.contains(&(offset / PAGE)))
        .collect();
    assert_eq!(packed, in_order);
    let sizes: Vec<u32> = pack.parts.iter().map(|part| part.chunk.plain_len).collect();
    assert!(sizes.len() >= 3, "parts grow: {sizes:?}");
    assert_eq!(u64::from(sizes[0]), FIRST_PART);
    assert_eq!(u64::from(sizes[1]), 2 * FIRST_PART);

    let (fetched, filled) = fetch_into(&chunks, dir.path(), &index, 2048 * PAGE).await;
    let mut want = order.clone();
    want.sort_unstable();
    assert_eq!(pages_of(&filled), want);
    assert_eq!(filled, merge(filled.clone()), "ranges come merged");
    let original = File::open(&memory).unwrap();
    for offset in want {
        assert_eq!(page_bytes(&fetched, offset), page_bytes(&original, offset));
    }
}

#[tokio::test]
async fn a_damaged_part_is_left_out_and_the_rest_still_fills() {
    let dir = tempfile::tempdir().unwrap();
    let memory = image(dir.path(), 2048, &[]);
    let order: Vec<u64> = (0..1200_u64).map(|n| n * PAGE).collect();
    let (backend, chunks) = store();
    let index = put(
        &chunks,
        &transfers(),
        &memory,
        &profile(order, PAGE),
        &CancellationToken::new(),
    )
    .await
    .unwrap()
    .unwrap();
    let pack = index_of(&chunks, &index).await;
    assert!(pack.parts.len() >= 3);
    // One part corrupt, one cut short.
    let mut corrupt = stored(&backend, &pack.parts[0].chunk).await;
    let middle = corrupt.len() / 2;
    corrupt[middle] ^= 0xff;
    overwrite(&backend, &pack.parts[0].chunk, corrupt).await;
    let mut short = stored(&backend, &pack.parts[2].chunk).await;
    short.truncate(short.len() / 2);
    overwrite(&backend, &pack.parts[2].chunk, short).await;

    let (fetched, filled) = fetch_into(&chunks, dir.path(), &index, 2048 * PAGE).await;
    let mut want: Vec<u64> = pack.parts[1]
        .pages
        .iter()
        .chain(pack.parts.iter().skip(3).flat_map(|part| &part.pages))
        .copied()
        .collect();
    want.sort_unstable();
    assert_eq!(pages_of(&filled), want);
    let original = File::open(&memory).unwrap();
    for offset in &want {
        assert_eq!(
            page_bytes(&fetched, *offset),
            page_bytes(&original, *offset)
        );
    }
    // Nothing of the damaged parts was written.
    for offset in pack.parts[0].pages.iter().chain(&pack.parts[2].pages) {
        assert_eq!(page_bytes(&fetched, *offset), vec![0; PAGE_LEN]);
    }
}

#[tokio::test]
async fn a_bad_index_gives_no_pack() {
    let dir = tempfile::tempdir().unwrap();
    let memory = image(dir.path(), 64, &[]);
    let (backend, chunks) = store();
    let index = put(
        &chunks,
        &transfers(),
        &memory,
        &profile(vec![0, PAGE, 63 * PAGE], PAGE),
        &CancellationToken::new(),
    )
    .await
    .unwrap()
    .unwrap();
    let (_, filled) = fetch_into(&chunks, dir.path(), &index, 64 * PAGE).await;
    assert_eq!(filled, vec![0..2 * PAGE, 63 * PAGE..64 * PAGE]);
    // An image shorter than the pages the index names.
    let (_, filled) = fetch_into(&chunks, dir.path(), &index, 32 * PAGE).await;
    assert_eq!(filled, Vec::<Range<u64>>::new());
    // A corrupt index.
    let mut bytes = stored(&backend, &index).await;
    bytes[0] ^= 0xff;
    overwrite(&backend, &index, bytes).await;
    let (_, filled) = fetch_into(&chunks, dir.path(), &index, 64 * PAGE).await;
    assert_eq!(filled, Vec::<Range<u64>>::new());
    // A chunk that is not a pack index.
    let other = EncodedChunk::encode(b"{\"version\":1}", 1).unwrap();
    chunks.put_chunk(&other).await.unwrap();
    let (_, filled) = fetch_into(&chunks, dir.path(), &other.reference, 64 * PAGE).await;
    assert_eq!(filled, Vec::<Range<u64>>::new());
}

#[tokio::test]
async fn a_part_with_data_in_a_chunk_of_zeros_is_left_out() {
    let dir = tempfile::tempdir().unwrap();
    let chunk_pages = CHUNK_BYTES / PAGE;
    // Chunk 1 is all zeros except page 70, which the pack then disagrees
    // with a chunk map that calls it zeros; chunk 0 holds data.
    let pages = 2 * chunk_pages;
    let zeros: Vec<u64> = (chunk_pages..pages).filter(|page| *page != 70).collect();
    let memory = image(dir.path(), pages, &zeros);
    let (_backend, chunks) = store();
    let order = vec![0, PAGE, 70 * PAGE, 71 * PAGE];
    let index = put(
        &chunks,
        &transfers(),
        &memory,
        &profile(order, PAGE),
        &CancellationToken::new(),
    )
    .await
    .unwrap()
    .unwrap();
    let len = pages * PAGE;
    let both_data: Arc<[bool]> = vec![false, false].into();
    let (_, filled) = fetch_with(&chunks, dir.path(), &index, len, &both_data).await;
    assert_eq!(filled, vec![0..2 * PAGE, 70 * PAGE..72 * PAGE]);
    // Page 71 is zeros, which a chunk of zeros may hold; page 70 is not.
    let second_zero: Arc<[bool]> = vec![false, true].into();
    let (fetched, filled) = fetch_with(&chunks, dir.path(), &index, len, &second_zero).await;
    assert_eq!(filled, vec![71 * PAGE..72 * PAGE]);
    assert_eq!(page_bytes(&fetched, 0), vec![0; PAGE_LEN]);
    // A huge page over both chunks is checked chunk by chunk.
    let huge_page = vec![1_u8; 2 * PAGE_LEN];
    assert!(zeros_where_the_image_has_them(
        0,
        &huge_page,
        &[false, false]
    ));
    assert!(!zeros_where_the_image_has_them(
        0,
        &huge_page,
        &[true, false]
    ));
    let mut half = vec![0_u8; usize::try_from(2 * CHUNK_BYTES).unwrap()];
    half[..PAGE_LEN].fill(1);
    assert!(zeros_where_the_image_has_them(0, &half, &[false, true]));
    assert!(!zeros_where_the_image_has_them(0, &half, &[true, true]));
    assert!(
        !zeros_where_the_image_has_them(CHUNK_BYTES, &[1; PAGE_LEN], &[false]),
        "past the image"
    );
}

#[test]
fn an_index_must_describe_the_image() {
    let part = |pages: Vec<u64>| {
        let bytes = vec![1; pages.len() * PAGE_LEN];
        PackPart {
            chunk: EncodedChunk::encode(&bytes, 1).unwrap().reference,
            pages,
        }
    };
    let index = |page_size, zeros: Vec<u64>, parts: Vec<PackPart>| PackIndex {
        version: PACK_VERSION,
        page_size,
        zeros,
        parts,
    };
    let len = 64 * PAGE;
    assert_eq!(
        index(PAGE, vec![PAGE], vec![part(vec![0, 2 * PAGE])]).check(len),
        Ok(())
    );
    assert_eq!(index(3000, vec![], vec![]).check(len), Err("bad page size"));
    assert_eq!(
        index(4 << 20, vec![], vec![]).check(len),
        Err("bad page size")
    );
    for outside in [vec![5], vec![len], vec![u64::MAX - PAGE + 1]] {
        assert_eq!(
            index(PAGE, outside, vec![]).check(len),
            Err("page outside the image")
        );
    }
    assert!(
        index(PAGE, vec![], vec![part(vec![len - PAGE, len])])
            .check(len)
            .is_err()
    );
    let mut short = part(vec![0, PAGE]);
    short.pages.push(2 * PAGE);
    assert!(index(PAGE, vec![], vec![short]).check(len).is_err());
    let mut empty = part(vec![0]);
    empty.pages.clear();
    assert!(index(PAGE, vec![], vec![empty]).check(len).is_err());
    let mut newer = index(PAGE, vec![], vec![]);
    newer.version = PACK_VERSION + 1;
    assert_eq!(newer.check(len), Err("unknown pack version"));
    let many: Vec<u64> = (0..=READY_BYTES / PAGE).map(|page| page * PAGE).collect();
    assert_eq!(
        index(PAGE, many, vec![]).check(u64::MAX / 2),
        Err("too many pages")
    );
}

#[tokio::test]
async fn a_cancelled_pack_stores_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let memory = image(dir.path(), 512, &[]);
    let (backend, chunks) = store();
    let cancel = CancellationToken::new();
    cancel.cancel();
    let order = (0..512).map(|page| page * PAGE).collect();
    let packed = put(
        &chunks,
        &transfers(),
        &memory,
        &profile(order, PAGE),
        &cancel,
    )
    .await;
    assert!(matches!(packed, Err(PackError::Cancelled)), "{packed:?}");
    let objects: Vec<_> = backend.list(None).try_collect().await.unwrap();
    assert_eq!(objects.len(), 0);
    // A profile naming nothing in the image packs nothing.
    let outside = profile(vec![512 * PAGE, 900 * PAGE], PAGE);
    let none = put(
        &chunks,
        &transfers(),
        &memory,
        &outside,
        &CancellationToken::new(),
    )
    .await;
    assert!(matches!(none, Ok(None)), "{none:?}");
}

#[test]
fn packing_follows_the_page_size_and_stops_at_the_ready_bytes() {
    let huge = 2 << 20;
    let pages = profile(vec![huge + 5, huge, 0, 7 * huge, 3 * huge + PAGE], huge);
    assert_eq!(packed(&pages, 4 * huge), vec![huge, 0, 3 * huge]);
    // Profiles from before the page size was kept count small pages.
    assert_eq!(packed(&profile(vec![PAGE + 1], 0), 4 * huge), vec![PAGE]);
    let all = profile((0..10_000).map(|page| page * huge).collect(), huge);
    assert_eq!(packed(&all, u64::MAX / 2).len() as u64, READY_BYTES / huge);
}

#[test]
fn filled_ranges_round_trip_and_reject_damage() {
    let ranges = vec![0..PAGE, 3 * PAGE..8 * PAGE];
    let bytes = encode_filled(&ranges);
    assert_eq!(decode_filled(&bytes, 8 * PAGE).unwrap(), ranges);
    assert!(
        decode_filled(&bytes, 7 * PAGE).is_err(),
        "outside the image"
    );
    assert!(decode_filled(&bytes[..bytes.len() - 1], 8 * PAGE).is_err());
    assert!(
        decode_filled(&bytes[..8], 8 * PAGE).is_err(),
        "half a range"
    );
    for bad in [
        vec![PAGE..2 * PAGE, 0..PAGE],
        vec![0..2 * PAGE, PAGE..3 * PAGE],
        vec![PAGE..PAGE, 4 * PAGE..5 * PAGE],
        vec![1..PAGE, 4 * PAGE..5 * PAGE],
        vec![0..PAGE + 1, 4 * PAGE..5 * PAGE],
    ] {
        assert!(
            decode_filled(&encode_filled(&bad), 8 * PAGE).is_err(),
            "{bad:?}"
        );
    }
    assert_eq!(decode_filled(&[], 0).unwrap(), Vec::<Range<u64>>::new());
}

#[test]
fn a_page_set_splits_ranges_into_filled_and_unfilled_runs() {
    let set = PageSet::new(&[PAGE..3 * PAGE, 5 * PAGE..6 * PAGE]);
    assert!(set.covers(PAGE..3 * PAGE));
    assert!(set.covers(PAGE + 10..PAGE + 11));
    assert!(!set.covers(0..2 * PAGE));
    assert!(!set.covers(2 * PAGE..4 * PAGE));
    assert!(!set.covers(PAGE..PAGE), "an empty range is not covered");
    assert!(!set.covers(100 * PAGE..101 * PAGE));
    assert_eq!(
        set.runs(0..7 * PAGE),
        vec![
            (0..PAGE, false),
            (PAGE..3 * PAGE, true),
            (3 * PAGE..5 * PAGE, false),
            (5 * PAGE..6 * PAGE, true),
            (6 * PAGE..7 * PAGE, false),
        ]
    );
    // An image that ends inside a page.
    assert_eq!(
        set.runs(2 * PAGE..5 * PAGE + 100),
        vec![
            (2 * PAGE..3 * PAGE, true),
            (3 * PAGE..5 * PAGE, false),
            (5 * PAGE..5 * PAGE + 100, true),
        ]
    );
}

#[test]
fn merging_joins_touching_ranges() {
    assert_eq!(merge(vec![0..4, 4..8, 6..7, 10..12]), vec![0..8, 10..12]);
    assert_eq!(merge(Vec::new()), Vec::<Range<u64>>::new());
}
