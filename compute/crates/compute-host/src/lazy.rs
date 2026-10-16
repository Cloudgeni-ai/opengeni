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
//! A remote wake runs in three overlapping phases:
//!
//! 1. **Prefetch.** The chunks the guest touched first after its previous
//!    wake (its learned profile) are requested as soon as the source
//!    exists, before the VMM even starts, and the guest resumes once they
//!    are in place.
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
//! against the image's chunk map.

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
use serde::{Deserialize, Serialize};
use tokio::sync::{Semaphore, mpsc, watch};

use crate::image::{CHUNK_BYTES, Hash, ZERO, chunk_count, chunk_range};

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
/// Most pages a learned profile keeps.
const PROFILE_PAGES: usize = 1 << 16;
/// How long a pager waits for its VMM to connect.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the first-touch order is recorded after a wake: long enough to
/// cover a slow first wake, whose working set the next wake prefetches.
const RECORD_FOR: Duration = Duration::from_secs(15);

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
    /// Signalled whenever chunks arrive; the pager waits on it.
    arrived: OwnedFd,
    requests: mpsc::UnboundedSender<Request>,
    failure: Mutex<Option<Unavailable>>,
    done: watch::Sender<Option<Result<(), Unavailable>>>,
}

impl Hydration {
    /// Starts filling `memory` (a sparse file of the image's full length)
    /// from `refs`, the chunk at each position, checked against `hashes`,
    /// the image's chunk map. `first` are image offsets to fetch at once,
    /// in order.
    pub fn start(
        fetcher: Arc<Fetcher>,
        memory: &Path,
        refs: Vec<Option<ChunkRef>>,
        hashes: Vec<Hash>,
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
            arrived,
            requests,
            failure: Mutex::new(None),
            done,
        });
        if missing == 0 {
            hydration.done.send_replace(Some(Ok(())));
        }
        for offset in first {
            if *offset < len {
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
        self.file
            .write_all_at(plain, range.start)
            .map_err(|error| Unavailable::passing(format!("writing chunk {index}: {error}")))?;
        self.present[index].store(true, Ordering::Release);
        if self.missing.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.done.send_replace(Some(Ok(())));
        }
        self.signal();
        Ok(())
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
        // SAFETY: the memory file is only ever written in whole chunks that
        // were not yet present, and read only once present, so no byte is
        // read while it changes; the file's length never changes.
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
        let start = usize::try_from(offset).map_err(io::Error::other)?;
        let stop = usize::try_from(end).map_err(io::Error::other)?;
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

/// The pages a guest touched first after a wake, in order, as image
/// offsets. Prefetched before the next wake.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct WakeProfile {
    pub version: u32,
    pub offsets: Vec<u64>,
}

impl WakeProfile {
    /// Reads a profile, or an empty one if there is none or it is unusable.
    pub fn load(path: &Path) -> Self {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Self>(&bytes).ok())
            .filter(|profile| profile.version == 1)
            .unwrap_or_default()
    }

    /// The profile after a wake that prefetched `self` and then faulted on
    /// `touched`: pages prefetched never fault, so the old order is kept and
    /// new pages follow it, up to a bound.
    #[must_use]
    pub fn learn(&self, touched: &[u64]) -> Self {
        let mut seen = std::collections::HashSet::new();
        let offsets = self
            .offsets
            .iter()
            .chain(touched)
            .copied()
            .filter(|offset| seen.insert(*offset))
            .take(PROFILE_PAGES)
            .collect();
        Self {
            version: 1,
            offsets,
        }
    }
}

/// A pager thread serving one VM's memory.
#[derive(Debug)]
pub(crate) struct Paging {
    stop: Arc<AtomicBool>,
    failed: watch::Receiver<bool>,
    prefetched: watch::Receiver<bool>,
    /// For remote images: the filling of the memory file.
    pub hydration: Option<Arc<Hydration>>,
}

impl Paging {
    /// Listens on `socket` (which the VMM must be able to open) and serves
    /// `memory` to the first VMM that connects, prefetching `profile`'s
    /// pages first. The order the guest then touches pages is learned into
    /// `learned`.
    pub fn start(
        socket: &Path,
        memory: Memory,
        hydration: Option<Arc<Hydration>>,
        profile: WakeProfile,
        learned: PathBuf,
    ) -> io::Result<Self> {
        let _ = std::fs::remove_file(socket);
        let listener = std::os::unix::net::UnixListener::bind(socket)?;
        listener.set_nonblocking(true)?;
        let stop = Arc::new(AtomicBool::new(false));
        let (failed_tx, failed) = watch::channel(false);
        let (prefetched_tx, prefetched) = watch::channel(false);
        let stopping = Arc::clone(&stop);
        let socket = socket.to_owned();
        std::thread::Builder::new()
            .name("pager".into())
            .spawn(move || {
                let result = serve(
                    &listener,
                    memory,
                    &profile,
                    &learned,
                    &stopping,
                    &prefetched_tx,
                );
                let _ = std::fs::remove_file(&socket);
                if let Err(error) = result {
                    tracing::error!(%error, "pager failed; the VM cannot continue");
                    let _ = failed_tx.send(true);
                }
                // Never leave a wake waiting on a prefetch that will not come.
                let _ = prefetched_tx.send(true);
            })?;
        Ok(Self {
            stop,
            failed,
            prefetched,
            hydration,
        })
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
    let plan: Vec<_> = profile
        .offsets
        .iter()
        .filter_map(|offset| pager.layout().offset(*offset))
        .collect();
    pager.queue_prefetch(&plan, MAX_BATCH)?;
    let result = pager.run(stop, |progress| match progress {
        Progress::Prefetched => {
            let _ = prefetched.send(true);
        }
        Progress::Recorded(touched) => {
            let next = profile.learn(touched);
            if let Ok(bytes) = serde_json::to_vec(&next) {
                let _ = crate::layout::write_atomic(learned, &bytes);
            }
        }
    });
    tracing::debug!(stats = ?pager.stats, "pager finished");
    result
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
