//! Filling a remote image's memory file from the store.
//!
//! A VM restored from an image whose memory is still in object storage gets
//! every page from its pager process ([`crate::paging`]), which reads the
//! image's own memory file once the bytes it needs are there. This module
//! puts them there: a [`Hydration`] fetches the image's chunks into the
//! file and reports each chunk once it is in place, which the agent passes
//! on to the pager. A remote wake runs in three overlapping phases, after
//! the fetch has brought in the image's working-set pack (see
//! [`crate::working_set`]):
//!
//! 1. **Prefetch.** The pages the guest touched after its previous wake
//!    (its learned profile, in first-touch order) are asked for first:
//!    those the pack filled are in place at once, the rest fetched. The
//!    pager installs them and the guest resumes once the first
//!    [`READY_BYTES`](crate::working_set::READY_BYTES) of them are in place.
//! 2. **Demand.** Any other page the guest touches is fetched at once,
//!    ahead of everything else, with a few chunks after it; the fault
//!    waits only for its own chunk.
//! 3. **Hydration.** Alongside, the remaining chunks are fetched in the
//!    background into the memory file, a few at a time per VM and a
//!    bounded number on the whole host, fewer while any wake or fault waits
//!    on the store (see [`crate::lanes`]), so the image becomes a complete
//!    local copy that the next save can merge over, and the pager can hand
//!    the guest's memory to the kernel and exit.
//!
//! Every chunk read from the store is checked against its content hash
//! (see [`compute_storage::store::ChunkStore::get_chunk`]) and against the
//! image's chunk map. Bytes already in place (filled by the pack, or by an
//! earlier agent for the same pager) are never written again, since the
//! pager may have read them: each is compared with the chunk that holds it
//! when that chunk arrives, and a chunk the pack filled entirely is hashed
//! in place instead of fetched, so a pack that disagrees with the image is
//! caught.

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io;
use std::os::unix::fs::FileExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use compute_storage::chunk::ChunkRef;
use compute_storage::store::ChunkStore;
use futures::FutureExt as _;
use futures::future::{BoxFuture, Shared};
use futures::stream::{FuturesUnordered, StreamExt as _};
use tokio::sync::{Semaphore, mpsc, watch};

use crate::image::{CHUNK_BYTES, Hash, ZERO, chunk_count, chunk_range};
use crate::lanes::Lanes;
use crate::working_set::PageSet;

/// Chunk fetches in flight per VM for demand and prefetch.
const FOREGROUND_PER_VM: usize = 64;
/// Chunk fetches in flight per VM for background hydration. Hydration runs
/// alongside demand: with 4 KiB pages a waking guest faults one chunk at a
/// time, so waiting for a pause in demand would leave it fetching serially.
const BACKGROUND_PER_VM: usize = 16;
/// Chunks after a demand-fetched one that are fetched along with it: a
/// guest that touches one chunk usually touches its neighbours next.
const READAHEAD_CHUNKS: usize = 4;
/// Chunk fetches in flight on the whole host.
const FETCHES_PER_HOST: usize = 512;
/// Recently fetched chunks kept in memory, shared by every VM: sandboxes
/// started from the same template share most of their memory.
const CACHE_BYTES: usize = 1 << 30;
/// How long a fetched chunk stays in that cache. The cache serves wakes
/// close together; between them its memory belongs to sandboxes, so a
/// chunk leaves this long after it arrived, used or not.
const CACHE_FOR: Duration = Duration::from_secs(60);
/// A chunk is retried for as long as its VM lives while the store or host
/// fails in ways that may pass (timeouts, dropped connections, refused
/// credentials, local resource limits): the guest stalls on a demand fetch
/// meanwhile and loses nothing. Only a chunk the store proves bad or gone
/// loses the VM's memory.
///
/// A chunk failing this long marks the store as stalled, which the host's
/// status shows until a fetch succeeds again.
const STALL_AFTER: Duration = Duration::from_secs(5);
/// How long failing tries follow each other quickly; after that the store
/// is probably down, and the host's fetches slow to
/// [`STALLED_RETRY_DELAY`] apart so they do not flood it as it comes back.
const RETRY_QUICKLY_FOR: Duration = Duration::from_secs(60);
/// The longest pause between two quick tries of a chunk.
const RETRY_DELAY_MAX: Duration = Duration::from_secs(2);
/// The pause between two tries of a chunk once the store seems down.
const STALLED_RETRY_DELAY: Duration = Duration::from_secs(10);
/// How long one try at a chunk may take once it has its transfer slot.
/// Every slot is held for at most this long, so a try waiting for one
/// waits a bounded time too.
const FETCH_DEADLINE: Duration = Duration::from_secs(30);
/// Blocking writes into one memory file that can be under way at once:
/// more than one VM's fetches can ever start.
const WRITERS: u32 = 1024;

type Fetched = Result<Arc<Vec<u8>>, Arc<compute_storage::Error>>;

/// Why a remote image's memory could not be filled.
#[derive(Clone, Debug, thiserror::Error)]
#[error("{reason}")]
pub(crate) struct Unavailable {
    /// What failed.
    pub reason: String,
    /// The store's copy is bad or gone, so no retry can bring it back. When
    /// false, the copy may still be good and the failure was the host's or
    /// the network's.
    pub permanent: bool,
}

impl Unavailable {
    fn permanent(reason: String) -> Self {
        Self {
            reason,
            permanent: true,
        }
    }

    fn passing(reason: String) -> Self {
        Self {
            reason,
            permanent: false,
        }
    }
}

/// Fetches chunks for every VM on the host: one request per chunk however
/// many VMs want it at once, and a bounded cache of recent chunks.
///
/// Each request runs as a task of its own, which releases its transfer
/// slot when it ends, and is aborted once nobody waits for it any more, so
/// requests a cancelled VM left behind never hold the host's slots.
#[derive(Debug)]
pub(crate) struct Fetcher {
    chunks: ChunkStore,
    inflight: Arc<Mutex<HashMap<String, Inflight>>>,
    cache: Arc<Mutex<Cache>>,
    /// Tells requests for the same chunk apart over time.
    requests: AtomicU64,
    all: Arc<Semaphore>,
    /// Background fetches give way to the ones somebody waits on.
    lanes: Arc<Lanes>,
    /// Chunks failing for longer than [`STALL_AFTER`], and since when.
    stall: Mutex<Stall>,
}

#[derive(Debug, Default)]
struct Stall {
    failing: usize,
    since: Option<std::time::Instant>,
}

/// One chunk failing for longer than [`STALL_AFTER`]; dropping it, however
/// the fetch ends, stops counting it.
struct Stalled<'a>(&'a Mutex<Stall>);

impl Drop for Stalled<'_> {
    fn drop(&mut self) {
        let mut stall = lock(self.0);
        stall.failing -= 1;
        if stall.failing == 0
            && let Some(since) = stall.since.take()
        {
            tracing::info!(stalled_for = ?since.elapsed(), "the store answers again");
        }
    }
}

/// A chunk request under way and how many wait for it.
#[derive(Debug)]
struct Inflight {
    id: u64,
    fetch: Shared<BoxFuture<'static, Fetched>>,
    waiters: usize,
    task: tokio::task::AbortHandle,
}

/// One caller waiting for an [`Inflight`] request; the last one to go
/// before the request ends aborts it.
struct Waiting<'a> {
    inflight: &'a Mutex<HashMap<String, Inflight>>,
    key: &'a str,
    id: u64,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        let mut inflight = lock(self.inflight);
        let Some(entry) = inflight
            .get_mut(self.key)
            .filter(|entry| entry.id == self.id)
        else {
            return;
        };
        entry.waiters -= 1;
        if entry.waiters == 0 {
            entry.task.abort();
            inflight.remove(self.key);
        }
    }
}

#[derive(Debug, Default)]
struct Cache {
    bytes: usize,
    chunks: HashMap<String, Arc<Vec<u8>>>,
    /// Keys oldest first, with when each arrived.
    order: VecDeque<(String, tokio::time::Instant)>,
}

impl Cache {
    /// Adds `chunk`, arrived `now`, and returns the chunks it pushed out
    /// (those older than [`CACHE_FOR`] first), for the caller to free once
    /// the lock is released: freeing 256 KiB buffers can wait on the
    /// allocator, and every fetch on the host waits for this lock.
    #[must_use]
    fn insert(
        &mut self,
        key: String,
        chunk: Arc<Vec<u8>>,
        now: tokio::time::Instant,
    ) -> Vec<Arc<Vec<u8>>> {
        let mut evicted = self.expire(now);
        if chunk.len() > CACHE_BYTES || self.chunks.contains_key(&key) {
            return evicted;
        }
        self.bytes += chunk.len();
        self.order.push_back((key.clone(), now));
        self.chunks.insert(key, chunk);
        while self.bytes > CACHE_BYTES {
            let Some((oldest, _)) = self.order.pop_front() else {
                break;
            };
            if let Some(chunk) = self.chunks.remove(&oldest) {
                self.bytes -= chunk.len();
                evicted.push(chunk);
            }
        }
        evicted
    }

    /// Takes out the chunks that arrived [`CACHE_FOR`] or more before
    /// `now`, and returns them for the caller to free as
    /// [`Self::insert`]'s are.
    #[must_use]
    fn expire(&mut self, now: tokio::time::Instant) -> Vec<Arc<Vec<u8>>> {
        let mut expired = Vec::new();
        while let Some((key, _)) = self
            .order
            .front()
            .filter(|(_, arrived)| now.saturating_duration_since(*arrived) >= CACHE_FOR)
        {
            if let Some(chunk) = self.chunks.remove(key) {
                self.bytes -= chunk.len();
                expired.push(chunk);
            }
            self.order.pop_front();
        }
        expired
    }
}

impl Fetcher {
    pub fn new(chunks: ChunkStore, lanes: Arc<Lanes>) -> Self {
        Self {
            chunks,
            inflight: Arc::default(),
            cache: Arc::default(),
            requests: AtomicU64::new(0),
            all: Arc::new(Semaphore::new(FETCHES_PER_HOST)),
            lanes,
            stall: Mutex::default(),
        }
    }

    /// How long chunks have been failing to arrive from a store that does
    /// not answer, if they are. Sandboxes waiting on remote memory stall
    /// meanwhile and lose nothing.
    pub fn stalled_for(&self) -> Option<Duration> {
        lock(&self.stall).since.map(|since| since.elapsed())
    }

    /// Frees the cached chunks older than [`CACHE_FOR`]; the agent calls
    /// this as it samples, so the cache empties once wakes stop.
    pub fn forget_old(&self) {
        let expired = lock(&self.cache).expire(tokio::time::Instant::now());
        drop(expired);
    }

    /// Counts a chunk as failing for longer than [`STALL_AFTER`] until the
    /// returned guard drops.
    fn stalled(&self, error: &str) -> Stalled<'_> {
        let mut stall = lock(&self.stall);
        stall.failing += 1;
        if stall.since.is_none() {
            tracing::warn!(%error, "remote memory cannot be filled; sandboxes waiting on it stall until it can");
            stall.since = Some(std::time::Instant::now());
        }
        Stalled(&self.stall)
    }

    /// The plain bytes of `reference`, checked against its hashes.
    async fn get(&self, reference: &ChunkRef, background: bool) -> Fetched {
        let key = reference.key();
        let cached = || lock(&self.cache).chunks.get(&key).cloned();
        if let Some(chunk) = cached() {
            return Ok(chunk);
        }
        let (_waited_on, _background) = if background {
            (None, Some(self.lanes.background().await))
        } else {
            (Some(self.lanes.foreground()), None)
        };
        // Another VM may have brought it in meanwhile.
        if let Some(chunk) = cached() {
            return Ok(chunk);
        }
        let (id, fetch) = {
            let mut inflight = lock(&self.inflight);
            let entry = inflight
                .entry(key.clone())
                .or_insert_with(|| self.request(&key, reference));
            entry.waiters += 1;
            (entry.id, entry.fetch.clone())
        };
        let _waiting = Waiting {
            inflight: &self.inflight,
            key: &key,
            id,
        };
        fetch.await
    }

    /// Starts fetching `reference`, stored under `key`.
    fn request(&self, key: &str, reference: &ChunkRef) -> Inflight {
        let id = self.requests.fetch_add(1, Ordering::Relaxed);
        let (chunks, all, reference) = (
            self.chunks.clone(),
            Arc::clone(&self.all),
            reference.clone(),
        );
        let (inflight, cache, key) = (
            Arc::clone(&self.inflight),
            Arc::clone(&self.cache),
            key.to_owned(),
        );
        let task = tokio::spawn(async move {
            let fetched = match all.acquire_owned().await {
                Ok(_slot) => {
                    match tokio::time::timeout(FETCH_DEADLINE, chunks.get_chunk(&reference)).await {
                        Ok(fetched) => fetched.map(Arc::new).map_err(Arc::new),
                        Err(_) => Err(Arc::new(compute_storage::Error::Transfer(format!(
                            "no answer within {FETCH_DEADLINE:?}"
                        )))),
                    }
                }
                Err(error) => Err(Arc::new(compute_storage::Error::Transfer(
                    error.to_string(),
                ))),
            };
            if let Ok(chunk) = &fetched {
                let evicted = lock(&cache).insert(
                    key.clone(),
                    Arc::clone(chunk),
                    tokio::time::Instant::now(),
                );
                drop(evicted);
            }
            let mut inflight = lock(&inflight);
            if inflight.get(&key).is_some_and(|entry| entry.id == id) {
                inflight.remove(&key);
            }
            fetched
        });
        let abort = task.abort_handle();
        let fetch = async move {
            task.await.unwrap_or_else(|error| {
                Err(Arc::new(compute_storage::Error::Transfer(format!(
                    "chunk request ended: {error}"
                ))))
            })
        }
        .boxed()
        .shared();
        Inflight {
            id,
            fetch,
            waiters: 0,
            task: abort,
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Chunk state for [`Hydration::requested`].
const NOT_ASKED: u8 = 0;
const ASKED: u8 = 1;
const URGENT: u8 = 2;

/// A request for one chunk.
#[derive(Clone, Copy, Debug)]
struct Request {
    index: usize,
    urgent: bool,
}

/// The filling of one remote image's memory file, shared by its pager
/// thread (which reads) and its fetch task (which writes).
#[derive(Debug)]
pub(crate) struct Hydration {
    file: File,
    len: u64,
    refs: Vec<Option<ChunkRef>>,
    hashes: Vec<Hash>,
    present: Vec<AtomicBool>,
    requested: Vec<AtomicU8>,
    missing: AtomicUsize,
    /// Taken by the one fetch of a chunk that stores it: a chunk can be
    /// fetched twice at once (hydration's, then a demand's), but is written
    /// and counted once.
    claimed: Vec<AtomicBool>,
    /// Pages the working-set pack filled before the VM started: readable
    /// at once and never written again.
    filled: PageSet,
    /// Told the index of each chunk once it is in place.
    arrivals: mpsc::UnboundedSender<usize>,
    requests: mpsc::UnboundedSender<Request>,
    failure: Mutex<Option<Unavailable>>,
    done: watch::Sender<Option<Result<(), Unavailable>>>,
    /// Set when the image is going away: fetching stops.
    cancelled: compute_engine::CancellationToken,
    /// A permit for each write into the memory file under way, so stopping
    /// can wait for writes that started before it.
    writers: Arc<Semaphore>,
    /// The task that fetches and writes; joined when stopping.
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Hydration {
    /// Starts filling `memory` (a sparse file of the image's full length)
    /// from `refs`, the chunk at each position, checked against `hashes`,
    /// the image's chunk map. `filled` are the pages already in the file,
    /// and `settled` (empty, or one entry per chunk) the chunks known to be
    /// complete in it already; `first` are image offsets to fetch at once,
    /// in order. Returns the hydration and the index of each chunk once it
    /// is in place, zero chunks and settled ones excepted.
    pub fn start(
        fetcher: Arc<Fetcher>,
        memory: &Path,
        refs: Vec<Option<ChunkRef>>,
        hashes: Vec<Hash>,
        filled: PageSet,
        settled: &[bool],
        first: &[u64],
    ) -> io::Result<(Arc<Self>, mpsc::UnboundedReceiver<usize>)> {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(memory)?;
        let len = file.metadata()?.len();
        let count = chunk_count(len);
        if refs.len() != count
            || hashes.len() != count
            || !(settled.is_empty() || settled.len() == count)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "chunk list does not cover the memory image",
            ));
        }
        let in_place =
            |index: usize| refs[index].is_none() || settled.get(index).copied().unwrap_or(false);
        let present: Vec<AtomicBool> = (0..count)
            .map(|index| AtomicBool::new(in_place(index)))
            .collect();
        let missing = (0..count).filter(|index| !in_place(*index)).count();
        let (arrivals, arrived) = mpsc::unbounded_channel();
        let (requests, receiver) = mpsc::unbounded_channel();
        let (done, _) = watch::channel(None);
        let hydration = Arc::new(Self {
            file,
            len,
            refs,
            hashes,
            present,
            requested: (0..count).map(|_| AtomicU8::new(NOT_ASKED)).collect(),
            missing: AtomicUsize::new(missing),
            claimed: (0..count).map(|_| AtomicBool::new(false)).collect(),
            filled,
            arrivals,
            requests,
            failure: Mutex::new(None),
            done,
            cancelled: compute_engine::CancellationToken::new(),
            writers: Arc::new(Semaphore::new(WRITERS as usize)),
            task: Mutex::new(None),
        });
        if missing == 0 {
            hydration.done.send_replace(Some(Ok(())));
        }
        for offset in first {
            if *offset < len && !hydration.filled.covers(*offset..*offset + 1) {
                hydration.ask(usize::try_from(offset / CHUNK_BYTES).unwrap_or(0), false);
            }
        }
        let task = tokio::spawn(fill(fetcher, Arc::clone(&hydration), receiver));
        *lock(&hydration.task) = Some(task);
        Ok((hydration, arrived))
    }

    /// The memory file's length.
    pub fn len(&self) -> u64 {
        self.len
    }

    /// Whether chunk `index` is in place.
    pub fn present(&self, index: usize) -> bool {
        self.present
            .get(index)
            .is_some_and(|present| present.load(Ordering::Acquire))
    }

    /// Asks for chunk `index` ahead of the background sweep; `urgent` when
    /// a guest processor waits for it.
    pub fn ask(&self, index: usize, urgent: bool) {
        let wanted = if urgent { URGENT } else { ASKED };
        if index >= self.present.len()
            || self.present[index].load(Ordering::Acquire)
            || self.requested[index].fetch_max(wanted, Ordering::AcqRel) >= wanted
        {
            return;
        }
        let _ = self.requests.send(Request { index, urgent });
    }

    /// Waits until every chunk is in the memory file, or fetching failed.
    pub async fn finished(&self) -> Result<(), Unavailable> {
        let mut done = self.done.subscribe();
        let result = done
            .wait_for(Option::is_some)
            .await
            .map_err(|_| Unavailable::passing("hydration stopped".to_owned()))?
            .clone();
        result.unwrap_or(Ok(()))
    }

    /// Why filling failed, if it did.
    pub fn failure(&self) -> Option<Unavailable> {
        lock(&self.failure).clone()
    }

    /// Whether filling has ended: every chunk is in place, or it failed or
    /// was stopped, after which no new write into the memory file starts.
    /// A write already under way then may still land, as the VM ends.
    pub fn is_finished(&self) -> bool {
        self.done.borrow().is_some()
    }

    /// Stops filling: the image is going away. Anyone waiting for the fill
    /// to finish is told it will not. Writes may still be under way: see
    /// [`Self::stop`].
    fn cancel(&self) {
        self.cancelled.cancel();
        self.done.send_if_modified(|done| {
            if done.is_some() {
                return false;
            }
            *done = Some(Err(Unavailable::passing("filling cancelled".to_owned())));
            true
        });
    }

    /// Stops filling for good and returns once nothing writes into the
    /// memory file any more: the fetch task has ended and every write it
    /// started has finished. Only then may another hydration of the same
    /// file start, or the file go.
    pub async fn stop(&self) {
        self.cancel();
        let task = lock(&self.task).take();
        if let Some(task) = task {
            // An error means the task panicked or was aborted: ended too.
            let _ = task.await;
        }
        // Writes run on blocking threads that outlive the task's futures;
        // each holds a permit until it is done.
        if let Ok(all) = self.writers.acquire_many(WRITERS).await {
            all.forget();
        }
        self.writers.close();
    }

    /// Takes the right to store chunk `index`, unless another fetch has.
    fn claim(&self, index: usize) -> bool {
        !self.claimed[index].swap(true, Ordering::AcqRel)
    }

    /// Writes chunk `index`, fetched as `plain`, around the pages already
    /// filled, which must hold the same bytes.
    fn store(&self, index: usize, plain: &[u8]) -> Result<(), Unavailable> {
        let range = chunk_range(index, self.len);
        if plain.len() as u64 != range.end - range.start {
            return Err(Unavailable::permanent(format!(
                "chunk {index} has the wrong length"
            )));
        }
        if *blake3::hash(plain).as_bytes() != self.hashes[index] {
            return Err(Unavailable::permanent(format!(
                "chunk {index} does not match the image's chunk map"
            )));
        }
        if !self.claim(index) {
            return Ok(());
        }
        let written = self.write_chunk(index, &range, plain);
        self.settle(index, written)
    }

    /// Writes the pages of chunk `index` the pack did not fill, and checks
    /// those it did.
    fn write_chunk(
        &self,
        index: usize,
        range: &std::ops::Range<u64>,
        plain: &[u8],
    ) -> Result<(), Unavailable> {
        let failed = |error: io::Error| Unavailable::passing(format!("chunk {index}: {error}"));
        let within = |at: u64| usize::try_from(at - range.start).unwrap_or(usize::MAX);
        for (run, filled) in self.filled.runs(range.clone()) {
            let Some(bytes) = plain.get(within(run.start)..within(run.end)) else {
                return Err(Unavailable::permanent(format!(
                    "chunk {index} has the wrong length"
                )));
            };
            if filled {
                let mut held = vec![0; bytes.len()];
                self.file
                    .read_exact_at(&mut held, run.start)
                    .map_err(failed)?;
                if held != bytes {
                    return Err(Unavailable::permanent(format!(
                        "pages the working-set pack filled differ from chunk {index}"
                    )));
                }
            } else {
                #[cfg(test)]
                tests::failing_write(&self.file).map_err(failed)?;
                self.file.write_all_at(bytes, run.start).map_err(failed)?;
            }
        }
        Ok(())
    }

    /// Checks chunk `index`, which the pack filled entirely, against the
    /// image's chunk map in place, instead of fetching it.
    fn check_filled(&self, index: usize) -> Result<(), Unavailable> {
        if !self.claim(index) {
            return Ok(());
        }
        let checked = self.check_in_place(index);
        self.settle(index, checked)
    }

    fn check_in_place(&self, index: usize) -> Result<(), Unavailable> {
        let range = chunk_range(index, self.len);
        let mut held = vec![0; usize::try_from(range.end - range.start).unwrap_or(0)];
        self.file
            .read_exact_at(&mut held, range.start)
            .map_err(|error| Unavailable::passing(format!("chunk {index}: {error}")))?;
        if *blake3::hash(&held).as_bytes() != self.hashes[index] {
            return Err(Unavailable::permanent(format!(
                "pages the working-set pack filled differ from chunk {index}"
            )));
        }
        Ok(())
    }

    /// Counts chunk `index`, claimed by this caller, as in place once
    /// `outcome` succeeded; otherwise lets go of it, so the next try writes
    /// it again.
    fn settle(&self, index: usize, outcome: Result<(), Unavailable>) -> Result<(), Unavailable> {
        match outcome {
            Ok(()) => self.arrived(index),
            Err(_) => self.claimed[index].store(false, Ordering::Release),
        }
        outcome
    }

    fn arrived(&self, index: usize) {
        self.present[index].store(true, Ordering::Release);
        let _ = self.arrivals.send(index);
        if self.missing.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.done.send_replace(Some(Ok(())));
        }
    }

    fn fail(&self, why: Unavailable) {
        tracing::error!(reason = %why.reason, permanent = why.permanent, "remote memory unavailable");
        lock(&self.failure).get_or_insert(why.clone());
        self.done.send_replace(Some(Err(why)));
    }
}

/// Fetches what `hydration` asks for, demand first, and then the rest.
///
/// A chunk hydration has queued (it may wait behind other VMs' background
/// fetches for a slot) is fetched again in the foreground when a fault
/// asks for it; whichever fetch comes back first stores it.
async fn fill(
    fetcher: Arc<Fetcher>,
    hydration: Arc<Hydration>,
    mut requests: mpsc::UnboundedReceiver<Request>,
) {
    let mut urgent = VecDeque::new();
    let mut asked = VecDeque::new();
    let mut sweep = 0_usize;
    let count = hydration.refs.len();
    let mut in_foreground = vec![false; count];
    let mut in_background = vec![false; count];
    let mut foreground = FuturesUnordered::new();
    let mut background = FuturesUnordered::new();
    let mut open = true;
    loop {
        if hydration.done.borrow().is_some() && foreground.is_empty() && background.is_empty() {
            return;
        }
        while foreground.len() < FOREGROUND_PER_VM {
            let Some(Request { index, urgent }) = urgent.pop_front().or_else(|| asked.pop_front())
            else {
                break;
            };
            if in_foreground[index]
                || (in_background[index] && !urgent)
                || hydration.present[index].load(Ordering::Acquire)
            {
                continue;
            }
            in_foreground[index] = true;
            foreground.push(fetch_one(&fetcher, &hydration, index, false));
        }
        while background.len() < BACKGROUND_PER_VM && sweep < count {
            let index = sweep;
            sweep += 1;
            if in_foreground[index]
                || in_background[index]
                || hydration.present[index].load(Ordering::Acquire)
            {
                continue;
            }
            in_background[index] = true;
            background.push(fetch_one(&fetcher, &hydration, index, true));
        }
        tokio::select! {
            biased;
            () = hydration.cancelled.cancelled() => return,
            request = requests.recv(), if open => match request {
                Some(request) if request.urgent => {
                    urgent.push_back(request);
                    let last = (request.index + READAHEAD_CHUNKS).min(count.saturating_sub(1));
                    for index in request.index + 1..=last {
                        asked.push_back(Request { index, urgent: false });
                    }
                }
                Some(request) => asked.push_back(request),
                // The VM is gone; finish what is in flight and stop.
                None => {
                    open = false;
                    if foreground.is_empty() && background.is_empty() {
                        return;
                    }
                }
            },
            Some((index, result)) = foreground.next(), if !foreground.is_empty() => {
                in_foreground[index] = false;
                if let Err(reason) = result {
                    hydration.fail(reason);
                }
            }
            Some((index, result)) = background.next(), if !background.is_empty() => {
                in_background[index] = false;
                if let Err(reason) = result {
                    hydration.fail(reason);
                }
            }
            else => {
                if !open {
                    return;
                }
            }
        }
        if !open && Arc::strong_count(&hydration) == 1 {
            return;
        }
    }
}

/// Fetches chunk `index` and stores it, retrying failures that may pass
/// until hydration stops (see [`STALL_AFTER`]): the store's, and the
/// host's own, such as a full disk, so the sandbox waits for room rather
/// than dying. A chunk the store proves bad or gone fails at once:
/// [`ChunkStore::get_chunk`] has already read it twice.
fn fetch_one(
    fetcher: &Arc<Fetcher>,
    hydration: &Arc<Hydration>,
    index: usize,
    background: bool,
) -> impl Future<Output = (usize, Result<(), Unavailable>)> + use<> {
    let fetcher = Arc::clone(fetcher);
    let hydration = Arc::clone(hydration);
    async move {
        let Some(reference) = hydration.refs[index].clone() else {
            return (index, Ok(()));
        };
        let in_place = hydration.filled.covers(chunk_range(index, hydration.len));
        let started = tokio::time::Instant::now();
        let mut delay = Duration::from_millis(50);
        let mut stalled = None;
        loop {
            let attempt = if in_place {
                write(&hydration, move |hydration| hydration.check_filled(index)).await
            } else {
                match fetcher.get(&reference, background).await {
                    Ok(plain) => {
                        write(&hydration, move |hydration| hydration.store(index, &plain)).await
                    }
                    Err(error) if error.is_permanent() => {
                        Err(Unavailable::permanent(format!("chunk {index}: {error}")))
                    }
                    Err(error) => Err(Unavailable::passing(format!("chunk {index}: {error}"))),
                }
            };
            match attempt {
                Err(failed) if !failed.permanent && !hydration.cancelled.is_cancelled() => {
                    tracing::debug!(index, reason = %failed.reason, "filling a chunk failed; trying again");
                    if stalled.is_none() && started.elapsed() >= STALL_AFTER {
                        stalled = Some(fetcher.stalled(&failed.reason));
                    }
                }
                done => return (index, done),
            }
            tokio::select! {
                () = hydration.cancelled.cancelled() => {
                    return (index, Err(Unavailable::passing("filling stopped".to_owned())));
                }
                () = tokio::time::sleep(delay) => {}
            }
            delay = if started.elapsed() < RETRY_QUICKLY_FOR {
                (delay * 2).min(RETRY_DELAY_MAX)
            } else {
                STALLED_RETRY_DELAY
            };
        }
    }
}

/// Runs `body`, which writes into the memory file or marks chunks
/// present, on a blocking thread, holding a writer permit throughout so
/// [`Hydration::stop`] can wait for it. Nothing runs once stopping began.
fn write<F>(
    hydration: &Arc<Hydration>,
    body: F,
) -> impl Future<Output = Result<(), Unavailable>> + use<F>
where
    F: FnOnce(&Hydration) -> Result<(), Unavailable> + Send + 'static,
{
    let hydration = Arc::clone(hydration);
    async move {
        let stopped = || Unavailable::passing("filling stopped".to_owned());
        if hydration.cancelled.is_cancelled() {
            return Err(stopped());
        }
        let Ok(permit) = Arc::clone(&hydration.writers).try_acquire_owned() else {
            return Err(stopped());
        };
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            body(hydration.as_ref())
        })
        .await
        .unwrap_or_else(|error| Err(Unavailable::passing(format!("writing memory: {error}"))))
    }
}

/// The chunk map entry for chunk bytes, as [`crate::image`] records it.
#[allow(dead_code)]
pub(crate) fn chunk_hash(plain: &[u8]) -> Hash {
    if plain.iter().all(|&byte| byte == 0) {
        ZERO
    } else {
        *blake3::hash(plain).as_bytes()
    }
}

#[cfg(test)]
mod tests {
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
        let finished = tokio::time::timeout(Duration::from_secs(10), hydration.finished())
            .await
            .unwrap_or_else(|_| Err(Unavailable::passing("still hydrating".to_owned())));
        let mut held = vec![0; 3 * chunk];
        file.read_exact_at(&mut held, 0).unwrap();
        (finished, held, plain.concat())
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
        ) -> futures::stream::BoxStream<'static, object_store::Result<object_store::ObjectMeta>>
        {
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
}
