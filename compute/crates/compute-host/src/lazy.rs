//! Serving a restored VM's memory through a page-fault handler.
//!
//! A VM restored with [`MemorySource::Pager`](compute_engine::MemorySource)
//! gets every page of guest memory from a [`compute_pager::linux::Pager`]
//! running on its own thread here. The pager reads either a local image
//! ([`compute_pager::MappedFile`]: huge-page hosts, whose memory Firecracker
//! can only fill through a handler) or a [`ChunkSource`]: an image whose
//! memory is still in object storage, fetched chunk by chunk as the guest
//! touches it.
//!
//! A remote wake runs in three overlapping phases, after the fetch has
//! brought in the image's working-set pack (see [`crate::working_set`]):
//!
//! 1. **Prefetch.** The pages the guest touched after its previous wake
//!    (its learned profile, in first-touch order) are installed as soon as
//!    the VMM connects: those the pack filled at once, the rest fetched.
//!    The guest resumes once the first [`READY_BYTES`] of them are in
//!    place; the rest stream in behind it, still ahead of hydration.
//! 2. **Demand.** Any other page the guest touches is fetched at once,
//!    ahead of everything else, with a few chunks after it; the fault
//!    waits only for its own chunk.
//! 3. **Hydration.** Alongside, the remaining chunks are fetched in the
//!    background into the image's memory file, a few at a time per VM and
//!    a bounded number on the whole host, so the image becomes a complete
//!    local copy that the next save can merge over.
//!
//! Fetched chunks land in the image's own memory file, which is also the
//! source's cache. Every chunk read from the store is checked against its
//! content hash (see [`compute_storage::store::ChunkStore::get_chunk`]) and
//! against the image's chunk map. Pages the pack filled are never written
//! again: every one is compared with the chunk that holds it when that
//! chunk arrives, and a chunk the pack filled entirely is hashed in place
//! instead of fetched, so a pack that disagrees with the image is caught.

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io;
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use compute_pager::{MappedFile, Source};
use compute_storage::chunk::ChunkRef;
use compute_storage::store::ChunkStore;
use futures::FutureExt as _;
use futures::future::{BoxFuture, Shared};
use futures::stream::{FuturesUnordered, StreamExt as _};
use memmap2::{Mmap, MmapOptions};
use tokio::sync::{Semaphore, mpsc, watch};

use crate::image::{CHUNK_BYTES, Hash, ZERO, chunk_count, chunk_range};
use crate::working_set::{PageSet, READY_BYTES, WakeProfile};

/// Chunk fetches in flight per VM for demand and prefetch.
const FOREGROUND_PER_VM: usize = 64;
/// Chunk fetches in flight per VM for background hydration. Hydration runs
/// alongside demand: with 4 KiB pages a waking guest faults one chunk at a
/// time, so waiting for a pause in demand would leave it fetching serially.
const BACKGROUND_PER_VM: usize = 16;
/// Background hydration fetches in flight on the whole host, so many VMs
/// hydrating at once never starve a guest that is waiting on a page.
const BACKGROUND_PER_HOST: usize = 128;
/// Chunks after a demand-fetched one that are fetched along with it: a
/// guest that touches one chunk usually touches its neighbours next.
const READAHEAD_CHUNKS: usize = 4;
/// Chunk fetches in flight on the whole host.
const FETCHES_PER_HOST: usize = 512;
/// Recently fetched chunks kept in memory, shared by every VM: sandboxes
/// started from the same template share most of their memory.
const CACHE_BYTES: usize = 1 << 30;
/// How long a chunk keeps being retried while the store or host fails in
/// ways that may pass (timeouts, dropped connections, local resource
/// limits) before the VM's memory counts as lost. The guest waits on a
/// demand fetch meanwhile, which beats losing its programs.
const RETRY_FOR: Duration = Duration::from_secs(60);
/// The longest pause between two tries of a chunk.
const RETRY_DELAY_MAX: Duration = Duration::from_secs(2);
/// How long a pager waits for its VMM to connect.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the first-touch order is recorded after a wake. A VM that
/// sleeps sooner reports what it touched when its VMM goes. The window is
/// wall-clock time, and a first wake on a busy host may take tens of
/// seconds to reach the working set the next wake should prefetch, so it
/// is generous; the profile's order keeps the earliest pages first.
const RECORD_FOR: Duration = Duration::from_secs(120);

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
#[derive(Debug)]
pub(crate) struct Fetcher {
    chunks: ChunkStore,
    inflight: Mutex<HashMap<String, Shared<BoxFuture<'static, Fetched>>>>,
    cache: Mutex<Cache>,
    all: Arc<Semaphore>,
    background: Arc<Semaphore>,
}

#[derive(Debug, Default)]
struct Cache {
    bytes: usize,
    chunks: HashMap<String, Arc<Vec<u8>>>,
    order: VecDeque<String>,
}

impl Cache {
    fn insert(&mut self, key: String, chunk: Arc<Vec<u8>>) {
        if chunk.len() > CACHE_BYTES || self.chunks.contains_key(&key) {
            return;
        }
        self.bytes += chunk.len();
        self.order.push_back(key.clone());
        self.chunks.insert(key, chunk);
        while self.bytes > CACHE_BYTES {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(evicted) = self.chunks.remove(&oldest) {
                self.bytes -= evicted.len();
            }
        }
    }
}

impl Fetcher {
    pub fn new(chunks: ChunkStore) -> Self {
        Self {
            chunks,
            inflight: Mutex::default(),
            cache: Mutex::default(),
            all: Arc::new(Semaphore::new(FETCHES_PER_HOST)),
            background: Arc::new(Semaphore::new(BACKGROUND_PER_HOST)),
        }
    }

    /// The plain bytes of `reference`, checked against its hashes.
    async fn get(&self, reference: &ChunkRef, background: bool) -> Fetched {
        let key = reference.key();
        if let Some(chunk) = lock(&self.cache).chunks.get(&key) {
            return Ok(Arc::clone(chunk));
        }
        let _slot = if background {
            Some(self.background.acquire().await)
        } else {
            None
        };
        let shared = {
            let mut inflight = lock(&self.inflight);
            inflight
                .entry(key.clone())
                .or_insert_with(|| {
                    let chunks = self.chunks.clone();
                    let all = Arc::clone(&self.all);
                    let reference = reference.clone();
                    async move {
                        let _permit = all.acquire_owned().await;
                        chunks
                            .get_chunk(&reference)
                            .await
                            .map(Arc::new)
                            .map_err(Arc::new)
                    }
                    .boxed()
                    .shared()
                })
                .clone()
        };
        let result = shared.await;
        lock(&self.inflight).remove(&key);
        if let Ok(chunk) = &result {
            lock(&self.cache).insert(key, Arc::clone(chunk));
        }
        result
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
    /// Pages the working-set pack filled before the VM started: readable
    /// at once and never written again.
    filled: PageSet,
    /// Signalled whenever chunks arrive; the pager waits on it.
    arrived: OwnedFd,
    requests: mpsc::UnboundedSender<Request>,
    failure: Mutex<Option<Unavailable>>,
    done: watch::Sender<Option<Result<(), Unavailable>>>,
    /// Set when the image is going away: fetching stops.
    cancelled: compute_engine::CancellationToken,
}

impl Hydration {
    /// Starts filling `memory` (a sparse file of the image's full length)
    /// from `refs`, the chunk at each position, checked against `hashes`,
    /// the image's chunk map. `filled` are the pages already in the file;
    /// `first` are image offsets to fetch at once, in order.
    pub fn start(
        fetcher: Arc<Fetcher>,
        memory: &Path,
        refs: Vec<Option<ChunkRef>>,
        hashes: Vec<Hash>,
        filled: PageSet,
        first: &[u64],
    ) -> io::Result<Arc<Self>> {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(memory)?;
        let len = file.metadata()?.len();
        let count = chunk_count(len);
        if refs.len() != count || hashes.len() != count {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "chunk list does not cover the memory image",
            ));
        }
        let present: Vec<AtomicBool> = refs
            .iter()
            .map(|reference| AtomicBool::new(reference.is_none()))
            .collect();
        let missing = refs.iter().filter(|reference| reference.is_some()).count();
        let arrived = rustix::event::eventfd(
            0,
            rustix::event::EventfdFlags::CLOEXEC | rustix::event::EventfdFlags::NONBLOCK,
        )?;
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
            filled,
            arrived,
            requests,
            failure: Mutex::new(None),
            done,
            cancelled: compute_engine::CancellationToken::new(),
        });
        if missing == 0 {
            hydration.done.send_replace(Some(Ok(())));
        }
        for offset in first {
            if *offset < len && !hydration.filled.covers(*offset..*offset + 1) {
                hydration.ask(usize::try_from(offset / CHUNK_BYTES).unwrap_or(0), false);
            }
        }
        tokio::spawn(fill(fetcher, Arc::clone(&hydration), receiver));
        Ok(hydration)
    }

    fn ask(&self, index: usize, urgent: bool) {
        let wanted = if urgent { URGENT } else { ASKED };
        if self.present[index].load(Ordering::Acquire)
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

    /// Stops filling: the image is going away. Anyone waiting for the fill
    /// to finish is told it will not.
    pub fn cancel(&self) {
        self.cancelled.cancel();
        self.done.send_if_modified(|done| {
            if done.is_some() {
                return false;
            }
            *done = Some(Err(Unavailable::passing("filling cancelled".to_owned())));
            true
        });
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
                self.file.write_all_at(bytes, run.start).map_err(failed)?;
            }
        }
        self.arrived(index);
        Ok(())
    }

    /// Checks chunk `index`, which the pack filled entirely, against the
    /// image's chunk map in place, instead of fetching it.
    fn check_filled(&self, index: usize) -> Result<(), Unavailable> {
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
        self.arrived(index);
        Ok(())
    }

    fn arrived(&self, index: usize) {
        self.present[index].store(true, Ordering::Release);
        if self.missing.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.done.send_replace(Some(Ok(())));
        }
        self.signal();
    }

    fn fail(&self, why: Unavailable) {
        tracing::error!(reason = %why.reason, permanent = why.permanent, "remote memory unavailable");
        lock(&self.failure).get_or_insert(why.clone());
        self.done.send_replace(Some(Err(why)));
        self.signal();
    }

    fn signal(&self) {
        let _ = rustix::io::write(&self.arrived, &1_u64.to_ne_bytes());
    }
}

/// Fetches what `hydration` asks for, demand first, and then the rest.
async fn fill(
    fetcher: Arc<Fetcher>,
    hydration: Arc<Hydration>,
    mut requests: mpsc::UnboundedReceiver<Request>,
) {
    let mut urgent = VecDeque::new();
    let mut asked = VecDeque::new();
    let mut sweep = 0_usize;
    let mut inflight = vec![false; hydration.refs.len()];
    let mut foreground = FuturesUnordered::new();
    let mut background = FuturesUnordered::new();
    let mut open = true;
    loop {
        if hydration.done.borrow().is_some() && foreground.is_empty() && background.is_empty() {
            return;
        }
        while foreground.len() < FOREGROUND_PER_VM {
            let Some(Request { index, .. }) = urgent.pop_front().or_else(|| asked.pop_front())
            else {
                break;
            };
            if inflight[index] || hydration.present[index].load(Ordering::Acquire) {
                continue;
            }
            inflight[index] = true;
            foreground.push(fetch_one(&fetcher, &hydration, index, false));
        }
        while background.len() < BACKGROUND_PER_VM && sweep < inflight.len() {
            let index = sweep;
            sweep += 1;
            if inflight[index] || hydration.present[index].load(Ordering::Acquire) {
                continue;
            }
            inflight[index] = true;
            background.push(fetch_one(&fetcher, &hydration, index, true));
        }
        tokio::select! {
            biased;
            () = hydration.cancelled.cancelled() => return,
            request = requests.recv(), if open => match request {
                Some(request) if request.urgent => {
                    urgent.push_back(request);
                    let last = (request.index + READAHEAD_CHUNKS).min(inflight.len().saturating_sub(1));
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
                inflight[index] = false;
                if let Err(reason) = result {
                    hydration.fail(reason);
                }
            }
            Some((index, result)) = background.next(), if !background.is_empty() => {
                inflight[index] = false;
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
/// for up to [`RETRY_FOR`]. A chunk the store proves bad or gone fails at
/// once: [`ChunkStore::get_chunk`] has already read it twice.
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
        if hydration.filled.covers(chunk_range(index, hydration.len)) {
            let checking = Arc::clone(&hydration);
            let checked = tokio::task::spawn_blocking(move || checking.check_filled(index))
                .await
                .unwrap_or_else(|error| {
                    Err(Unavailable::passing(format!(
                        "checking chunk {index}: {error}"
                    )))
                });
            return (index, checked);
        }
        let started = tokio::time::Instant::now();
        let mut delay = Duration::from_millis(50);
        loop {
            match fetcher.get(&reference, background).await {
                Ok(plain) => {
                    let hydration = Arc::clone(&hydration);
                    let stored =
                        tokio::task::spawn_blocking(move || hydration.store(index, &plain))
                            .await
                            .unwrap_or_else(|error| {
                                Err(Unavailable::passing(format!(
                                    "storing chunk {index}: {error}"
                                )))
                            });
                    return (index, stored);
                }
                Err(error) if error.is_permanent() => {
                    return (
                        index,
                        Err(Unavailable::permanent(format!("chunk {index}: {error}"))),
                    );
                }
                Err(error) if started.elapsed() >= RETRY_FOR => {
                    return (
                        index,
                        Err(Unavailable::passing(format!("chunk {index}: {error}"))),
                    );
                }
                Err(error) => {
                    tracing::debug!(index, %error, "chunk fetch failed; trying again");
                }
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(RETRY_DELAY_MAX);
        }
    }
}

/// A remote image's memory as a pager source: the image's memory file,
/// read where chunks have arrived, fetched where they have not.
#[derive(Debug)]
pub(crate) struct ChunkSource {
    hydration: Arc<Hydration>,
    map: Mmap,
}

impl ChunkSource {
    pub fn new(hydration: Arc<Hydration>) -> io::Result<Self> {
        // SAFETY: a byte of the memory file is read only once it is filled
        // or its chunk is present, and never written after that: chunks are
        // written once, around the filled pages. So no byte is read while
        // it changes, and the file's length never changes.
        let map = unsafe { MmapOptions::new().map(&hydration.file)? };
        Ok(Self { hydration, map })
    }
}

impl Source for ChunkSource {
    fn len(&self) -> u64 {
        self.hydration.len
    }

    fn get(&mut self, offset: u64, len: u64, urgent: bool) -> io::Result<Option<&[u8]>> {
        let hydration = &self.hydration;
        if let Some(why) = lock(&hydration.failure).as_ref() {
            return Err(io::Error::other(why.clone()));
        }
        let end = offset
            .checked_add(len)
            .filter(|end| *end <= hydration.len && len > 0)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "range outside image"))?;
        let start = usize::try_from(offset).map_err(io::Error::other)?;
        let stop = usize::try_from(end).map_err(io::Error::other)?;
        if hydration.filled.covers(offset..end) {
            return Ok(self.map.get(start..stop));
        }
        let first = usize::try_from(offset / CHUNK_BYTES).unwrap_or(usize::MAX);
        let last = usize::try_from((end - 1) / CHUNK_BYTES).unwrap_or(usize::MAX);
        let mut ready = true;
        for index in first..=last {
            if !hydration.present[index].load(Ordering::Acquire) {
                hydration.ask(index, urgent);
                ready = false;
            }
        }
        if !ready {
            return Ok(None);
        }
        Ok(self.map.get(start..stop))
    }

    fn ready_fd(&self) -> Option<BorrowedFd<'_>> {
        Some(self.hydration.arrived.as_fd())
    }

    fn acknowledge(&mut self) -> io::Result<()> {
        let mut count = [0_u8; 8];
        match rustix::io::read(&self.hydration.arrived, &mut count) {
            Ok(_) | Err(rustix::io::Errno::AGAIN) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

/// Either kind of memory a pager serves.
#[derive(Debug)]
pub(crate) enum Memory {
    Local(MappedFile),
    Remote(ChunkSource),
}

impl Source for Memory {
    fn len(&self) -> u64 {
        match self {
            Self::Local(source) => source.len(),
            Self::Remote(source) => source.len(),
        }
    }

    fn get(&mut self, offset: u64, len: u64, urgent: bool) -> io::Result<Option<&[u8]>> {
        match self {
            Self::Local(source) => source.get(offset, len, urgent),
            Self::Remote(source) => source.get(offset, len, urgent),
        }
    }

    fn ready_fd(&self) -> Option<BorrowedFd<'_>> {
        match self {
            Self::Local(source) => source.ready_fd(),
            Self::Remote(source) => source.ready_fd(),
        }
    }

    fn acknowledge(&mut self) -> io::Result<()> {
        match self {
            Self::Local(source) => source.acknowledge(),
            Self::Remote(source) => source.acknowledge(),
        }
    }
}

/// A pager thread serving one VM's memory.
#[derive(Debug)]
pub(crate) struct Paging {
    stop: Arc<AtomicBool>,
    failed: watch::Receiver<bool>,
    prefetched: watch::Receiver<bool>,
    /// Set once the pager thread has ended and written all it will write.
    ended: watch::Receiver<bool>,
    /// For remote images: the filling of the memory file.
    pub hydration: Option<Arc<Hydration>>,
}

impl Paging {
    /// Listens on `socket` (which the VMM must be able to open) and serves
    /// `memory` to the first VMM that connects, prefetching `profile`'s
    /// pages first. The order the guest then touches pages is learned into
    /// `learned`. Once the VMM has connected, its memory layout is written
    /// to `layout`, so another pager can take over if this one goes.
    pub fn start(
        socket: &Path,
        memory: Memory,
        hydration: Option<Arc<Hydration>>,
        profile: WakeProfile,
        learned: PathBuf,
        layout: PathBuf,
    ) -> io::Result<Self> {
        let _ = std::fs::remove_file(socket);
        let listener = std::os::unix::net::UnixListener::bind(socket)?;
        listener.set_nonblocking(true)?;
        let socket = socket.to_owned();
        Self::spawn(hydration, move |stop, prefetched| {
            let result = serve(
                &listener, memory, &profile, &learned, &layout, stop, prefetched,
            );
            let _ = std::fs::remove_file(&socket);
            result
        })
    }

    /// Takes over serving `memory` to a running VM whose pager has gone,
    /// through what its engine handed over and the `regions` its first
    /// pager recorded. Nothing is learned: what this VM touches next is no
    /// wake's working set.
    pub fn adopt(
        handed: compute_engine::PagedMemory,
        regions: Vec<compute_pager::Mapping>,
        memory: Memory,
        hydration: Option<Arc<Hydration>>,
    ) -> io::Result<Self> {
        use compute_pager::linux::Pager;

        let mut pager = Pager::adopt(handed.uffd, regions, handed.vmm, memory, RECORD_FOR)?;
        Self::spawn(hydration, move |stop, prefetched| {
            let result = pager.run(stop, |progress| {
                if let compute_pager::linux::Progress::Prefetched = progress {
                    let _ = prefetched.send(true);
                }
            });
            tracing::debug!(stats = ?pager.stats, "pager finished");
            result
        })
    }

    /// Runs `body` on a pager thread of its own and reports how it ends.
    fn spawn(
        hydration: Option<Arc<Hydration>>,
        body: impl FnOnce(&AtomicBool, &watch::Sender<bool>) -> io::Result<()> + Send + 'static,
    ) -> io::Result<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let (failed_tx, failed) = watch::channel(false);
        let (prefetched_tx, prefetched) = watch::channel(false);
        let (ended_tx, ended) = watch::channel(false);
        let stopping = Arc::clone(&stop);
        std::thread::Builder::new()
            .name("pager".into())
            .spawn(move || {
                if let Err(error) = body(&stopping, &prefetched_tx) {
                    tracing::error!(%error, "pager failed; the VM cannot continue");
                    let _ = failed_tx.send(true);
                }
                // Never leave a wake waiting on a prefetch that will not come.
                let _ = prefetched_tx.send(true);
                let _ = ended_tx.send(true);
            })?;
        Ok(Self {
            stop,
            failed,
            prefetched,
            ended,
            hydration,
        })
    }

    /// Stops serving and filling for good, for a VM that has ended and whose
    /// files are about to go, and returns once the pager thread has ended,
    /// so nothing writes into the sandbox's directory any more.
    pub async fn close(&self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(hydration) = &self.hydration {
            hydration.cancel();
        }
        let mut ended = self.ended.clone();
        // An error means the thread is gone, which is just as good.
        let _ = ended.wait_for(|ended| *ended).await;
    }

    /// Waits until the prefetch plan is in place, for at most `limit`.
    pub async fn prefetched(&self, limit: Duration) {
        let mut prefetched = self.prefetched.clone();
        let _ = tokio::time::timeout(limit, prefetched.wait_for(|done| *done)).await;
    }

    /// Resolves if the pager fails: the VM must then be stopped, since its
    /// next fault would wait forever.
    pub fn failed(&self) -> impl Future<Output = ()> + Send + 'static {
        let mut failed = self.failed.clone();
        async move {
            if failed.wait_for(|failed| *failed).await.is_err() {
                // The pager ended normally; never resolve.
                std::future::pending::<()>().await;
            }
        }
    }
}

impl Drop for Paging {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn serve(
    listener: &std::os::unix::net::UnixListener,
    memory: Memory,
    profile: &WakeProfile,
    learned: &Path,
    layout: &Path,
    stop: &AtomicBool,
    prefetched: &watch::Sender<bool>,
) -> io::Result<()> {
    use compute_pager::linux::{MAX_BATCH, Pager, Progress};

    let started = std::time::Instant::now();
    let peer = loop {
        match listener.accept() {
            Ok((peer, _)) => break peer,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if stop.load(Ordering::Relaxed) || started.elapsed() > CONNECT_TIMEOUT {
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(error) => return Err(error),
        }
    };
    peer.set_nonblocking(false)?;
    let mut pager = Pager::new(peer, memory, RECORD_FOR)?;
    match serde_json::to_vec(pager.layout().regions()) {
        Ok(regions) => {
            if let Err(error) = crate::layout::write_atomic(layout, &regions) {
                tracing::warn!(%error, "memory layout not recorded; a restarted agent cannot take this VM over");
            }
        }
        Err(error) => tracing::warn!(%error, "memory layout not encodable"),
    }
    let plan: Vec<_> = profile
        .offsets
        .iter()
        .filter_map(|offset| pager.layout().offset(*offset))
        .collect();
    let (ready, rest) = plan.split_at(ready_prefix(&plan, READY_BYTES));
    pager.queue_prefetch(ready, MAX_BATCH)?;
    pager.queue_background(rest)?;
    let page_size = pager
        .layout()
        .regions()
        .first()
        .map_or(0, |region| region.page_size);
    let result = pager.run(stop, |progress| match progress {
        Progress::Prefetched => {
            let _ = prefetched.send(true);
        }
        Progress::Recorded(touched) => {
            let next = profile.learn(touched, page_size);
            if let Ok(bytes) = serde_json::to_vec(&next) {
                let _ = crate::layout::write_atomic(learned, &bytes);
            }
        }
    });
    tracing::debug!(stats = ?pager.stats, "pager finished");
    result
}

/// How many pages from the front of `plan` fit in `budget` bytes, and at
/// least one if there are any, so a wake always waits for its first page.
fn ready_prefix(plan: &[compute_pager::Page], budget: u64) -> usize {
    let mut bytes = 0_u64;
    plan.iter()
        .position(|page| {
            bytes = bytes.saturating_add(page.size);
            bytes > budget
        })
        .map_or(plan.len(), |over| over.max(1))
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

    fn pages(sizes: &[u64]) -> Vec<compute_pager::Page> {
        let mut offset = 0;
        sizes
            .iter()
            .enumerate()
            .map(|(index, &size)| {
                let page = compute_pager::Page {
                    address: offset,
                    offset,
                    size,
                    index,
                };
                offset += size;
                page
            })
            .collect()
    }

    #[test]
    fn a_wake_waits_for_the_profile_prefix_that_fits_its_budget() {
        assert_eq!(ready_prefix(&[], 4096), 0);
        assert_eq!(ready_prefix(&pages(&[4096; 10]), 4 * 4096), 4);
        assert_eq!(ready_prefix(&pages(&[4096; 3]), 1 << 20), 3);
        // A huge page larger than the budget is still waited for.
        assert_eq!(ready_prefix(&pages(&[2 << 20; 4]), 1 << 20), 1);
        assert_eq!(ready_prefix(&pages(&[2 << 20; 4]), 4 << 20), 2);
    }

    const PAGE: u64 = 4096;

    /// Hydrates a three-chunk image whose chunk 1 is never stored, with
    /// `filled` written into the memory file first by `prefill`.
    async fn hydrate(
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
        let hydration = Hydration::start(
            Arc::new(Fetcher::new(chunks)),
            &path,
            encoded
                .iter()
                .map(|chunk| Some(chunk.reference.clone()))
                .collect(),
            plain.iter().map(|bytes| chunk_hash(bytes)).collect(),
            PageSet::new(filled),
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
}
