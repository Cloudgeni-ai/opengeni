use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;

use super::*;
use crate::Error;
use crate::fake::Fake;
use crate::fresh::{Clock, period_of};
use crate::store::{ChunkStore, Held};

const HOUR: Duration = Duration::from_secs(3_600);

/// The simulated time: tokio's paused clock, from the start of an hour.
fn paused_clock() -> Clock {
    let start = tokio::time::Instant::now();
    let base = std::time::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
    Clock::from_fn(move || base + start.elapsed())
}

fn chunk(n: u8) -> EncodedChunk {
    // Varied bytes, so each compresses to a different length.
    let plain: Vec<u8> = (0..65_536_u32)
        .map(|i| n.wrapping_mul((i % 251) as u8))
        .collect();
    EncodedChunk::encode(&plain, 1).unwrap()
}

fn plain(n: u8) -> Vec<u8> {
    (0..65_536_u32)
        .map(|i| n.wrapping_mul((i % 251) as u8))
        .collect()
}

fn packer(chunks: &[u8]) -> Packer {
    let mut packer = Packer::new();
    for &n in chunks {
        packer.push(&chunk(n));
    }
    packer
}

fn counts(fake: &Fake) -> (u32, u32, u32, u32) {
    (
        *fake.puts.lock().unwrap(),
        *fake.gets.lock().unwrap(),
        *fake.heads.lock().unwrap(),
        *fake.copies.lock().unwrap(),
    )
}

/// Chunks stored together are one object under the hour and the hash of
/// its bytes; each is read with a range read of its own bytes, and one look
/// at the pack's size and tag on S3 proves every chunk in it.
#[tokio::test(start_paused = true)]
async fn a_pack_is_one_object_and_each_chunk_in_it_is_read_with_a_range() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake_s3(&fake, "p");
    let put = store.put_pack(packer(&[1, 2, 3])).await.unwrap();
    assert!(put.new && !put.copied);
    let period = period_of(store.now());
    let digest = &put.references[0].pack.as_ref().unwrap().digest;
    assert_eq!(fake.names(), [format!("p/packs/v1/{period}/{digest}")]);
    assert_eq!(put.len, fake.bytes(&fake.names()[0]).unwrap().len() as u64);
    let mut at = 0;
    for reference in &put.references {
        reference.validate().unwrap();
        assert_eq!(reference.day, Some(period));
        assert_eq!(reference.stored_range().start, at, "end to end, in order");
        at = reference.stored_range().end;
        assert_eq!(reference.key(), put.references[0].key(), "one object");
    }
    assert_eq!(at, put.len);
    let ids: std::collections::HashSet<String> = put.references.iter().map(ChunkRef::id).collect();
    assert_eq!(ids.len(), 3, "each chunk told apart by its place");
    let (puts, gets, ..) = counts(&fake);
    for (reference, n) in put.references.iter().zip([1, 2, 3]) {
        assert_eq!(store.get_chunk(reference).await.unwrap(), plain(n));
    }
    assert_eq!(counts(&fake).1, gets + 3, "one ranged read a chunk");
    for reference in &put.references {
        assert!(store.has_chunk(reference).await.unwrap());
    }
    let (_, after, heads, _) = counts(&fake);
    assert_eq!((after, heads), (gets + 3, 3), "looks, no downloads");
    assert_eq!(counts(&fake).0, puts);
}

/// Chunks one after another in a pack, as a wake's demand fetch and its
/// readahead, come in one read, each checked against its own hashes; when
/// the pack is damaged the read of each on its own finds which chunk is bad.
#[tokio::test(start_paused = true)]
async fn consecutive_chunks_of_a_pack_come_in_one_read() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake_s3(&fake, "p");
    let references = store
        .put_pack(packer(&[1, 2, 3, 4, 5]))
        .await
        .unwrap()
        .references;
    assert!(
        references
            .windows(2)
            .all(|pair| follows(&pair[0], &pair[1]))
    );
    assert!(!follows(&references[1], &references[0]), "in order only");
    let gets = counts(&fake).1;
    let fetched = store.get_chunks(&references[1..5]).await.unwrap();
    assert_eq!(fetched, [plain(2), plain(3), plain(4), plain(5)]);
    assert_eq!(counts(&fake).1, gets + 1, "one GET for four chunks");
    // Chunks not one after another are each read on their own.
    let gets = counts(&fake).1;
    let apart = [references[0].clone(), references[2].clone()];
    assert_eq!(
        store.get_chunks(&apart).await.unwrap(),
        [plain(1), plain(3)]
    );
    assert_eq!(counts(&fake).1, gets + 2);

    // Damage the third chunk's bytes in place.
    let key = format!("p/{}", references[0].key());
    let mut bytes = fake.bytes(&key).unwrap().to_vec();
    let at = usize::try_from(references[2].stored_range().start).unwrap();
    bytes[at] ^= 0xff;
    fake.put_raw(&key, Bytes::from(bytes));
    let damaged = store.get_chunks(&references[1..4]).await;
    assert!(matches!(damaged, Err(Error::Integrity)), "{damaged:?}");
    assert_eq!(store.get_chunk(&references[1]).await.unwrap(), plain(2));
    assert!(
        !store.has_chunk(&references[0]).await.unwrap(),
        "the pack is not whole"
    );
}

/// A pack stored again the same hour, as by an archive started again whose
/// packs come out the same, is looked at, not sent; the next hour it is
/// copied within the store under that hour's name.
#[tokio::test(start_paused = true)]
async fn a_pack_stored_again_is_checked_the_same_hour_and_copied_the_next() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake_s3(&fake, "p");
    let first = store.put_pack(packer(&[1, 2])).await.unwrap();
    let (puts, gets, ..) = counts(&fake);
    let again = store.put_pack(packer(&[1, 2])).await.unwrap();
    assert!(!again.new);
    assert_eq!(again.references, first.references);
    assert_eq!(counts(&fake).0, puts, "nothing sent");
    assert_eq!(counts(&fake).1, gets, "nothing read back");

    tokio::time::advance(HOUR).await;
    let next = store.put_pack(packer(&[1, 2])).await.unwrap();
    assert!(next.new && next.copied);
    assert_eq!(counts(&fake).0, puts, "copied, not uploaded");
    assert_eq!(counts(&fake).3, 1);
    assert_eq!(
        next.references[0].day,
        Some(first.references[0].day.unwrap() + 1)
    );
    assert_eq!(fake.names().len(), 2);
    for (reference, n) in next.references.iter().zip([1, 2]) {
        assert_eq!(store.get_chunk(reference).await.unwrap(), plain(n));
    }
}

/// A pack missing, cut short or holding other bytes proves none of its
/// chunks, so a local copy naming them is not evicted (ADR 7).
#[tokio::test(start_paused = true)]
async fn a_pack_not_as_stored_proves_none_of_its_chunks() {
    for s3 in [false, true] {
        let fake = Fake::new(paused_clock());
        let store = if s3 {
            ChunkStore::over_fake_s3(&fake, "p")
        } else {
            ChunkStore::over_fake(&fake, "p")
        };
        let references = store.put_pack(packer(&[1, 2])).await.unwrap().references;
        let key = format!("p/{}", references[0].key());
        let stored = fake.bytes(&key).unwrap();
        assert!(store.has_chunk(&references[1]).await.unwrap());
        let mut other = stored.to_vec();
        *other.last_mut().unwrap() ^= 1;
        fake.put_raw(&key, Bytes::from(other));
        assert!(!store.has_chunk(&references[0]).await.unwrap(), "s3: {s3}");
        fake.put_raw(&key, stored.slice(..stored.len() - 1));
        assert!(!store.has_chunk(&references[0]).await.unwrap(), "s3: {s3}");
        assert!(store.delete(&references[0].key()).await.unwrap());
        assert!(!store.has_chunk(&references[1]).await.unwrap(), "s3: {s3}");
    }
}

/// An archive in flight carries each pack it holds into the new hour once,
/// with one copy, and holds every chunk in it by the new name.
#[tokio::test(start_paused = true)]
async fn an_archive_carries_a_pack_into_the_new_hour_with_one_copy() {
    let fake = Fake::new(paused_clock());
    let held = Arc::new(Held::new());
    let store = ChunkStore::over_fake_s3(&fake, "p").holding(Arc::clone(&held));
    let first = store.put_pack(packer(&[1, 2, 3])).await.unwrap();
    store.put_pack(packer(&[4])).await.unwrap();
    assert_eq!(held.len(), 4);
    let kept = store.keep(&held).await;
    assert_eq!(kept.copied, 0, "nothing earlier");
    tokio::time::advance(HOUR).await;
    let kept = store.keep(&held).await;
    assert_eq!((kept.copied, kept.lost, kept.failed), (2, 0, 0), "{kept:?}");
    assert_eq!(kept.copied_bytes, first.len + chunk(4).bytes.len() as u64);
    assert_eq!(*fake.copies.lock().unwrap(), 2);
    assert_eq!(held.len(), 4);
    // What a try that starts again stores is found under the new name.
    let puts = counts(&fake).0;
    let again = store.put_pack(packer(&[1, 2, 3])).await.unwrap();
    assert!(!again.new);
    assert_eq!(
        again.references[0].day,
        Some(first.references[0].day.unwrap() + 1)
    );
    assert_eq!(counts(&fake).0, puts);
}

/// What an old reference names is read as before: a chunk of its own, not
/// in a pack.
#[tokio::test(start_paused = true)]
async fn a_chunk_stored_on_its_own_reads_as_before() {
    let fake = Fake::new(paused_clock());
    let store = ChunkStore::over_fake_s3(&fake, "p");
    let put = store.put_chunk(&chunk(7)).await.unwrap();
    assert!(put.reference.pack.is_none());
    assert!(put.reference.key().starts_with("chunks/v2/"));
    assert_eq!(store.get_chunk(&put.reference).await.unwrap(), plain(7));
    assert_eq!(
        store
            .get_chunks(std::slice::from_ref(&put.reference))
            .await
            .unwrap(),
        [plain(7)]
    );
    assert!(store.has_chunk(&put.reference).await.unwrap());
}

/// A reference to a chunk in a pack is checked like any: a pack it does
/// not fit in, or a digest that is no hash, is refused.
#[test]
fn a_reference_must_fit_in_its_pack() {
    let mut packer = packer(&[1, 2]);
    let (bytes, chunks) = std::mem::take(&mut packer).finish();
    let len = bytes.len() as u64;
    let digest = blake3::hash(&bytes).to_hex().to_string();
    let references = named(chunks, 500_000, &digest, len, "x");
    references[1].validate().unwrap();
    let mut past = references[1].clone();
    past.pack.as_mut().unwrap().len -= 1;
    assert!(past.validate().is_err());
    let mut undated = references[1].clone();
    undated.day = None;
    assert!(undated.validate().is_err());
    let mut bad = references[1].clone();
    bad.pack.as_mut().unwrap().digest = "z".repeat(64);
    assert!(bad.validate().is_err());
    let mut huge = references[0].clone();
    huge.pack.as_mut().unwrap().len = crate::chunk::MAX_PACK + 1;
    assert!(huge.validate().is_err());
}

/// How long a store over [`Crowded`] takes to store an upload for each
/// upload under way, and the client's deadline for one.
const PER_UPLOAD: Duration = Duration::from_secs(4);
const DEADLINE: Duration = Duration::from_secs(30);

/// A store whose bandwidth uploads share: each takes [`PER_UPLOAD`] for
/// every upload under way with it, and one that would take longer than
/// [`DEADLINE`] times out then, stored or not, as a busy store's uploads
/// time out together.
#[derive(Debug, Default)]
struct Crowded {
    inner: object_store::memory::InMemory,
    in_flight: std::sync::atomic::AtomicU32,
    most_in_flight: std::sync::atomic::AtomicU32,
    timed_out: std::sync::atomic::AtomicU32,
}

impl std::fmt::Display for Crowded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("crowded")
    }
}

#[async_trait::async_trait]
impl object_store::ObjectStore for Crowded {
    async fn put_opts(
        &self,
        location: &object_store::path::Path,
        payload: object_store::PutPayload,
        opts: object_store::PutOptions,
    ) -> object_store::Result<object_store::PutResult> {
        use std::sync::atomic::Ordering::SeqCst;
        let now = self.in_flight.fetch_add(1, SeqCst) + 1;
        self.most_in_flight.fetch_max(now, SeqCst);
        // Uploads sent together are under way together.
        tokio::time::sleep(Duration::from_millis(1)).await;
        let takes = PER_UPLOAD * self.in_flight.load(SeqCst);
        tokio::time::sleep(takes.min(DEADLINE)).await;
        self.in_flight.fetch_sub(1, SeqCst);
        if takes > DEADLINE {
            self.timed_out.fetch_add(1, SeqCst);
            return Err(object_store::Error::Generic {
                store: "crowded",
                source: "Error performing PUT in 30s - HTTP error: error sending request".into(),
            });
        }
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

/// Thirty-two packs sent at once to a store that takes about seven at a
/// time within the deadline. Sent all together, as archives did, every
/// one timed out together and none was stored. Now the store is sent
/// fewer at once once uploads time out, and those that did are sent
/// again: every pack is stored.
#[tokio::test(start_paused = true)]
async fn packs_sent_at_once_to_a_crowded_store_are_all_stored() {
    use std::sync::atomic::Ordering::SeqCst;
    let backend = Arc::new(Crowded::default());
    let store = ChunkStore::new(backend.clone(), object_store::path::Path::from("p"))
        .with_clock(paused_clock());
    let puts = (1..=32_u8).map(|n| store.put_pack(packer(&[n])));
    let stored = futures::future::join_all(puts).await;
    for put in &stored {
        let put = put.as_ref().expect("every pack is stored");
        assert!(put.new);
        assert!(store.has_chunk(&put.references[0]).await.unwrap());
    }
    // Never more at once than at first, and some timed out on the way.
    assert!(backend.most_in_flight.load(SeqCst) <= 8);
    assert!(backend.timed_out.load(SeqCst) > 0);
}
