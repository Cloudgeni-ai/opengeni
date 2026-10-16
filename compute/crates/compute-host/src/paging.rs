//! The agent's side of a VM's memory pager process.
//!
//! A VM restored through a pager (on huge-page hosts always, and on any
//! host waking from object storage) gets its memory from a process of its
//! own beside the VMM ([`compute_pager::linux::serve`]), which the engine
//! starts with the VM. That process owns everything that must live exactly
//! as long as the VM does: the userfaultfd, which pages are in place, and
//! which the guest discarded. The agent only fills the image's memory file
//! ([`crate::lazy`]) and talks to the pager over its control socket
//! ([`compute_pager::control`]): it says which byte ranges are filled,
//! fetches first what the pager asks for, and learns when the wake's
//! prefetch is in place and when the pager is done.
//!
//! An agent that restarts reconnects ([`Paging::reconnect`]): the pager
//! says what it still misses and the new agent goes on filling. Nothing is
//! lost meanwhile; a fault on a missing page waits.
//!
//! The image a pager reads stays the VM's current one, untouched, until the
//! pager says it holds every byte ([`Paging::complete`]): only then may a
//! save seal it, replace it or retire it. So an agent that restarts at any
//! point finds the image the pager still misses bytes of, by name.
//!
//! A pager runs as its VM's user, so the agent trusts nothing it says: no
//! message may be longer than what a pager of that image could need to say
//! ([`Frames`]), and a greeting must name ranges inside the image.

use std::io;
use std::ops::Range;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use compute_engine::{CancellationToken, EngineError, ErrorKind};
use compute_pager::control::{self, ToHost, ToPager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, sleep, timeout};

use crate::image::{CHUNK_BYTES, Depth, Generation, Images, Verified, chunk_count, chunk_range};
use crate::lazy::{Fetcher, Hydration};
use crate::protocol::MAX_MEMORY_MIB;
use crate::working_set::PageSet;

/// How long a starting pager may take to listen.
const START_WITHIN: Duration = Duration::from_secs(60);
/// How long a pager whose connection dropped may take to accept again.
const RECONNECT_WITHIN: Duration = Duration::from_secs(1);
/// How long a pager may take to greet a new connection.
const HELLO_WITHIN: Duration = Duration::from_secs(5);
/// The pause between attempts to connect.
const RETRY_EVERY: Duration = Duration::from_millis(5);
/// The longest message a pager sends after its greeting. The longest it
/// needs is a `want` of two 20-digit numbers, under 100 bytes.
const MESSAGE_BYTES: usize = 1024;

/// The longest greeting a pager may send for an image of `len` bytes
/// that had `launched` ranges in place when the pager started. Every
/// range it misses then ends at one of those ranges, at a filled chunk or
/// at the end, and a range is at most two 20-digit numbers with their
/// punctuation.
fn greeting_bytes(len: u64, launched: usize) -> usize {
    const PER_RANGE: usize = 48;
    chunk_count(len)
        .saturating_add(launched)
        .saturating_add(1)
        .saturating_mul(PER_RANGE)
        .saturating_add(MESSAGE_BYTES)
}

/// Names one pager launch: the image generation it serves and a nonce, so
/// a pager left over from an earlier launch of the same image is never
/// taken for this one.
pub(crate) fn tag(generation: Generation) -> String {
    static LAUNCHES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let launch = LAUNCHES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{generation}-{nanos:x}.{launch}")
}

/// The generation a launch [`tag`] names.
fn generation_of(tag: &str) -> Option<Generation> {
    tag.split_once('-')
        .and_then(|(generation, _)| Generation::parse(generation))
}

/// Where a pager that has finished says so, in case it could not tell a
/// connected agent before it exited.
pub(crate) fn done_file(control: &Path) -> PathBuf {
    control.with_extension("done")
}

/// Device and inode of `path`.
pub(crate) fn identity(path: &Path) -> io::Result<(u64, u64)> {
    let metadata = std::fs::metadata(path)?;
    Ok((metadata.dev(), metadata.ino()))
}

/// The chunk at each position of remote `image`'s memory, and its chunk
/// map, for a [`Hydration`].
pub(crate) fn remote_chunks(
    images: &Images,
    image: &Verified,
    operation: &'static str,
) -> Result<
    (
        Vec<Option<compute_storage::chunk::ChunkRef>>,
        Vec<crate::image::Hash>,
    ),
    EngineError,
> {
    let io = |error| EngineError::io(operation, error);
    let manifest = std::fs::read(images.remote(image.generation())).map_err(io)?;
    let manifest = compute_storage::manifest::DiskManifest::decode(&manifest)
        .map_err(|error| EngineError::caused_by(ErrorKind::MemoryLost, operation, error))?;
    let refs = crate::chunked::chunk_refs(&manifest).ok_or_else(|| {
        EngineError::new(
            ErrorKind::MemoryLost,
            operation,
            "memory manifest not in chunks",
        )
    })?;
    let hashes = images.chunk_map(image).map_err(io)?.0;
    Ok((refs, hashes))
}

/// What the agent knows of one pager.
#[derive(Clone, Debug)]
struct Link {
    control: PathBuf,
    tag: String,
    /// Device and inode of the memory file the agent fills.
    identity: (u64, u64),
    /// The memory file's length, if known.
    len: Option<u64>,
    /// The longest greeting the pager may send.
    greeting: usize,
}

/// A connection to a pager that has greeted it.
struct Connected {
    frames: Frames,
    write: OwnedWriteHalf,
    missing: Vec<(u64, u64)>,
    prefetched: bool,
    /// Device and inode of the memory file the pager reads.
    reads: (u64, u64),
}

/// A pager's messages, one per line, read so that a line longer than its
/// bound is refused before more than the bound is held: a pager runs as
/// its VM's user and must never make the agent allocate at will.
struct Frames {
    read: BufReader<OwnedReadHalf>,
    /// A line read in part, kept across a cancelled read.
    line: Vec<u8>,
}

impl Frames {
    fn new(read: OwnedReadHalf) -> Self {
        Self {
            read: BufReader::new(read),
            line: Vec::new(),
        }
    }

    /// The next whole line, of at most `limit` bytes before its newline;
    /// `None` at the end of the stream. Cancel-safe: what was read of a
    /// line stays for the next call.
    async fn next(&mut self, limit: usize) -> io::Result<Option<Vec<u8>>> {
        loop {
            let room = (limit + 1).saturating_sub(self.line.len());
            let read = (&mut self.read)
                .take(u64::try_from(room).unwrap_or(u64::MAX))
                .read_until(b'\n', &mut self.line)
                .await?;
            if self.line.last() == Some(&b'\n') {
                return Ok(Some(std::mem::take(&mut self.line)));
            }
            if self.line.len() > limit {
                self.line = Vec::new();
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("the pager sent a line longer than {limit} bytes"),
                ));
            }
            if read == 0 {
                return Ok(None);
            }
        }
    }
}

/// Whether `missing` can be what a pager of an image of `len` bytes still
/// misses: ordered, disjoint, non-empty ranges inside the image.
fn plausible(missing: &[(u64, u64)], len: Option<u64>) -> bool {
    let mut at = 0;
    missing.iter().all(|&(start, end)| {
        let fits = start >= at && start < end && len.is_none_or(|len| end <= len);
        at = end;
        fits
    })
}

/// Why connecting failed.
enum Refused {
    /// Nothing accepts on the socket: the pager has exited.
    Gone(io::Error),
    /// Something else answers: an earlier launch's pager, or one serving
    /// another file. Nothing it asks for can be filled.
    Wrong(String),
}

/// How one conversation with a pager ended.
enum Ended {
    /// The pager is done and exits; the VM needs it no more.
    Done,
    /// The agent stopped talking.
    Cancelled,
    /// The connection dropped; the pager may still run.
    Lost,
    /// Its memory cannot be filled.
    Failed(String),
}

/// The agent's side of one VM's pager: talking to it and filling its file.
#[derive(Debug)]
pub(crate) struct Paging {
    /// For remote images: the filling of the memory file.
    pub hydration: Option<Arc<Hydration>>,
    cancel: CancellationToken,
    /// Set once the agent is ending the VM, whose pager then goes away by
    /// design.
    ending: CancellationToken,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    prefetched: watch::Receiver<bool>,
    complete: watch::Receiver<bool>,
    failed: watch::Receiver<bool>,
}

/// Why a pager will never report its memory file complete.
#[derive(Debug)]
pub(crate) enum Incomplete {
    /// The VM's memory can no longer be served.
    Failed,
    /// The agent stopped talking to the pager.
    Stopped,
}

impl Paging {
    /// Starts talking to the pager about to be launched as `tag` on
    /// `control`, for the memory file whose device and inode are
    /// `identity` and length is `len`. `filled` are byte ranges of the
    /// file in place already; `hydration` fills the rest. Returns at once:
    /// the conversation waits for the pager to listen.
    pub fn start(
        control: PathBuf,
        tag: String,
        (identity, len): ((u64, u64), u64),
        hydration: Option<(Arc<Hydration>, mpsc::UnboundedReceiver<usize>)>,
        filled: Vec<Range<u64>>,
    ) -> Self {
        let link = Link {
            control,
            tag,
            identity,
            len: Some(len),
            greeting: greeting_bytes(len, filled.len()),
        };
        let filled = filled.into_iter().map(|range| (range.start, range.end));
        Self::spawn(link, None, hydration, filled.collect())
    }

    /// Reconnects to the pager of a VM found running after an agent
    /// restart, as `marker` (written before its launch) names it, and goes
    /// on filling what it still misses from `images`.
    ///
    /// `None`: no pager listens because it finished, and the VM needs none.
    /// An error of kind [`ErrorKind::MemoryLost`] means the pager exited
    /// before it finished, or runs but what it needs can never be
    /// supplied: the VM can never run again. Other errors prove nothing.
    pub async fn reconnect(
        marker: &Path,
        control: &Path,
        images: Images,
        fetcher: Option<Arc<Fetcher>>,
    ) -> Result<Option<Self>, EngineError> {
        const OP: &str = "adopt";
        let lost = |why: String| EngineError::new(ErrorKind::MemoryLost, OP, why);
        let tag = match tokio::fs::read_to_string(marker).await {
            Ok(tag) => tag.trim().to_owned(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(EngineError::io(OP, error)),
        };
        // A marker without a launch tag names no pager that could still run.
        let Some(generation) = generation_of(&tag) else {
            return Ok(None);
        };
        let memory = images.memory(generation);
        let (len, launched) = launched(&images, generation, &memory).await;
        // Without its image, the pager may have started with as many
        // ranges in place as the file has chunks.
        let bound = len.unwrap_or(u64::from(MAX_MEMORY_MIB) << 20);
        let mut link = Link {
            control: control.to_owned(),
            tag,
            identity: (0, 0),
            len,
            greeting: greeting_bytes(bound, launched.unwrap_or_else(|| chunk_count(bound))),
        };
        let connected = match connect(&link, None, RECONNECT_WITHIN).await {
            Ok(connected) => connected,
            // A pager leaves word once it has handed the memory to the
            // kernel and nothing can wait on it any more.
            Err(Refused::Gone(_)) if done_file(control).exists() => return Ok(None),
            // It died without that word. Whether the VM can still run is
            // the VMM's to show: memory still registered, or a thread
            // waiting for an event reader, is established loss; a VMM that
            // answers its API after the pager unregistered everything is
            // whole. The engine looks when it adopts the VM.
            Err(Refused::Gone(error)) => {
                tracing::warn!(%error, "the pager exited before it said it was done");
                return Ok(None);
            }
            Err(Refused::Wrong(why)) => {
                return Err(EngineError::new(ErrorKind::Transient, OP, why));
            }
        };
        if connected.missing.is_empty() {
            return Ok(Some(Self::spawn(link, Some(connected), None, Vec::new())));
        }
        // Saves wait for hydration, so the image a pager still misses bytes
        // of stays the current one and keeps its memory file.
        let found = {
            let (images, memory) = (images.clone(), memory.clone());
            tokio::task::spawn_blocking(move || {
                let identity = identity(&memory)?;
                let image = images.verify(generation, Depth::Light);
                Ok::<_, io::Error>((identity, image))
            })
            .await
            .map_err(|error| EngineError::caused_by(ErrorKind::Transient, OP, error))?
        };
        let (identity, image) = match found {
            Ok(found) => found,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(lost(format!(
                    "the pager misses bytes of image {generation}, which is gone"
                )));
            }
            Err(error) => return Err(EngineError::io(OP, error)),
        };
        let image = image.map_err(|suspect| match suspect {
            crate::image::Suspect::Io(error) => EngineError::io(OP, error),
            suspect => EngineError::caused_by(ErrorKind::MemoryLost, OP, suspect),
        })?;
        if connected.reads != identity {
            return Err(lost(format!(
                "the pager misses bytes of a file other than image {generation}'s"
            )));
        }
        link.identity = identity;
        if !image.meta().remote {
            // A local image's file is whole: the pager only missed word.
            let filled = connected.missing.clone();
            return Ok(Some(Self::spawn(link, Some(connected), None, filled)));
        }
        let Some(fetcher) = fetcher else {
            return Err(lost(
                "the image is in a store this host cannot page from".into(),
            ));
        };
        let (refs, hashes) = remote_chunks(&images, &image, OP)?;
        let len = std::fs::metadata(&memory)
            .map_err(|error| EngineError::io(OP, error))?
            .len();
        let (filled, settled) = resumed(&connected.missing, len);
        let hydration = Hydration::start(fetcher, &memory, refs, hashes, filled, &settled, &[])
            .map_err(|error| EngineError::io(OP, error))?;
        Ok(Some(Self::spawn(
            link,
            Some(connected),
            Some(hydration),
            Vec::new(),
        )))
    }

    fn spawn(
        link: Link,
        connected: Option<Connected>,
        hydration: Option<(Arc<Hydration>, mpsc::UnboundedReceiver<usize>)>,
        filled: Vec<(u64, u64)>,
    ) -> Self {
        let (prefetched_tx, prefetched) = watch::channel(false);
        let (complete_tx, complete) = watch::channel(false);
        let (failed_tx, failed) = watch::channel(false);
        let cancel = CancellationToken::new();
        let ending = CancellationToken::new();
        let (hydration, arrivals) = hydration.map_or((None, None), |(hydration, arrivals)| {
            (Some(hydration), Some(arrivals))
        });
        let conversation = Talk {
            link,
            hydration: hydration.clone(),
            arrivals,
            filled,
            prefetched: prefetched_tx,
            complete: complete_tx,
            cancel: cancel.clone(),
            ending: ending.clone(),
        };
        let task = tokio::spawn(async move {
            if let Err(why) = conversation.run(connected).await {
                tracing::error!(reason = %why, "a VM's memory can no longer be served; the VM cannot continue");
                let _ = failed_tx.send(true);
            }
        });
        Self {
            hydration,
            cancel,
            ending,
            task: Mutex::new(Some(task)),
            prefetched,
            complete,
            failed,
        }
    }

    /// Says the agent is about to end the VM: its pager going away is then
    /// expected, and ends the conversation without counting as lost memory.
    /// Call it before stopping the VM, and [`Paging::close`] once it is gone.
    ///
    /// A pager that died just before, unnoticed so far, then also counts
    /// as expected. That loses nothing: whatever the agent ends a VM after
    /// does not rest on its pager. A save first waits for the pager to hold
    /// every byte ([`Paging::complete`]), and an image still being filled
    /// from the store stays current, so the next wake fetches it again.
    pub fn ending(&self) {
        self.ending.cancel();
    }

    /// Stops talking and filling, for a VM that has ended or whose files
    /// are about to go, and returns once nothing the agent started writes
    /// into the memory file any more.
    pub async fn close(&self) {
        self.cancel.cancel();
        let task = self
            .task
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(task) = task {
            let _ = task.await;
        }
        if let Some(hydration) = &self.hydration {
            hydration.stop().await;
        }
    }

    /// Waits until the wake's prefetch is in place, for at most `limit`.
    pub async fn prefetched(&self, limit: Duration) {
        let mut prefetched = self.prefetched.clone();
        let _ = timeout(limit, prefetched.wait_for(|done| *done)).await;
    }

    /// Waits until the pager holds every byte of its memory file, and so no
    /// longer needs the image it reads by name.
    pub async fn complete(&self) -> Result<(), Incomplete> {
        let mut complete = self.complete.clone();
        let mut failing = self.failed.clone();
        let failed = || *self.failed.borrow();
        // A conversation that ended closes both channels at once. A closed
        // `failed` without failure must then never win the race, or the
        // completion beside it would go unseen: it waits forever inside its
        // own future, and the other arm decides.
        tokio::select! {
            reached = async { complete.wait_for(|complete| *complete).await.is_ok() } => {
                // Without it the conversation ended: it failed, or the
                // agent stopped it.
                if reached {
                    Ok(())
                } else if failed() {
                    Err(Incomplete::Failed)
                } else {
                    Err(Incomplete::Stopped)
                }
            }
            () = async {
                if failing.wait_for(|failed| *failed).await.is_err() {
                    std::future::pending::<()>().await;
                }
            } => Err(Incomplete::Failed),
        }
    }

    /// Resolves if the VM's memory can no longer be served: the VM must
    /// then be stopped, since its next fault would wait forever.
    pub fn failed(&self) -> impl Future<Output = ()> + Send + 'static {
        let mut failed = self.failed.clone();
        async move {
            if failed.wait_for(|failed| *failed).await.is_err() {
                std::future::pending::<()>().await;
            }
        }
    }
}

impl Drop for Paging {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// For reconnecting to the pager of image `generation`: its memory file's
/// length and how many ranges of it were in place at launch, each if it
/// can be read.
async fn launched(
    images: &Images,
    generation: Generation,
    memory: &Path,
) -> (Option<u64>, Option<usize>) {
    let (images, memory) = (images.clone(), memory.to_owned());
    tokio::task::spawn_blocking(move || {
        let len = std::fs::metadata(&memory)
            .ok()
            .map(|metadata| metadata.len());
        let launched = images
            .verify(generation, Depth::Light)
            .ok()
            .and_then(|image| images.filled(&image).ok())
            .map(|filled| filled.len());
        (len, launched)
    })
    .await
    .unwrap_or((None, None))
}

/// The pages and chunks in place already, for a pager that misses only
/// `missing` of an image of `len` bytes.
fn resumed(missing: &[(u64, u64)], len: u64) -> (PageSet, Vec<bool>) {
    let mut present = Vec::new();
    let mut at = 0;
    for &(start, end) in missing {
        if start > at {
            present.push(at..start);
        }
        at = at.max(end);
    }
    if at < len {
        present.push(at..len);
    }
    let settled = (0..chunk_count(len))
        .map(|index| {
            let chunk = chunk_range(index, len);
            !missing
                .iter()
                .any(|&(start, end)| start < chunk.end && chunk.start < end)
        })
        .collect();
    (PageSet::new(&present), settled)
}

/// Connects to `link`'s pager. Until `patient` (or for `within` from now
/// if `None`), a socket that does not accept, or a pager of another
/// launch, is tried again.
async fn connect(
    link: &Link,
    patient: Option<Instant>,
    within: Duration,
) -> Result<Connected, Refused> {
    let until = patient.unwrap_or_else(|| Instant::now() + within);
    loop {
        let refused = match greet(link).await {
            Ok(connected) => return Ok(connected),
            Err(refused) => refused,
        };
        if Instant::now() >= until {
            return Err(refused);
        }
        sleep(RETRY_EVERY).await;
    }
}

/// One attempt at connecting to `link`'s pager and reading its greeting.
async fn greet(link: &Link) -> Result<Connected, Refused> {
    // The pager's directory belongs to its VM's user: never follow a link
    // there.
    let stream = compute_engine::confined::connect(&link.control)
        .await
        .map_err(Refused::Gone)?;
    let (read, write) = stream.into_split();
    let mut frames = Frames::new(read);
    let greeting = match timeout(HELLO_WITHIN, frames.next(link.greeting)).await {
        Ok(Ok(Some(greeting))) => greeting,
        Ok(Ok(None)) => return Err(Refused::Gone(io::ErrorKind::UnexpectedEof.into())),
        Ok(Err(error)) if error.kind() == io::ErrorKind::InvalidData => {
            return Err(Refused::Wrong(error.to_string()));
        }
        Ok(Err(error)) => return Err(Refused::Gone(error)),
        Err(_) => return Err(Refused::Wrong("the pager did not greet".into())),
    };
    match control::parse::<ToHost>(&greeting) {
        // Every message this agent sends exists in each protocol it serves.
        Ok(ToHost::Hello { protocol, .. })
            if !(control::OLDEST_PROTOCOL..=control::PROTOCOL).contains(&protocol) =>
        {
            Err(Refused::Wrong(format!(
                "the pager speaks protocol {protocol}, which this agent does not \
                 (it serves {} to {})",
                control::OLDEST_PROTOCOL,
                control::PROTOCOL
            )))
        }
        Ok(ToHost::Hello {
            tag,
            device,
            inode,
            missing,
            prefetched,
            ..
        }) if tag == link.tag => {
            if link.identity != (0, 0) && (device, inode) != link.identity {
                return Err(Refused::Wrong(
                    "the pager reads another file than the one filled".into(),
                ));
            }
            if !plausible(&missing, link.len) {
                return Err(Refused::Wrong(
                    "the pager misses ranges outside its image".into(),
                ));
            }
            Ok(Connected {
                frames,
                write,
                missing,
                prefetched,
                reads: (device, inode),
            })
        }
        Ok(ToHost::Hello { tag, .. }) => Err(Refused::Wrong(format!(
            "a pager of launch {tag} answers instead of {}",
            link.tag
        ))),
        _ => Err(Refused::Wrong("the pager did not greet".into())),
    }
}

/// The conversation with one pager, across reconnections.
struct Talk {
    link: Link,
    hydration: Option<Arc<Hydration>>,
    arrivals: Option<mpsc::UnboundedReceiver<usize>>,
    /// Ranges in place before hydration started.
    filled: Vec<(u64, u64)>,
    prefetched: watch::Sender<bool>,
    complete: watch::Sender<bool>,
    cancel: CancellationToken,
    ending: CancellationToken,
}

impl Talk {
    /// Talks until the pager is done or the agent stops; an error means
    /// the VM's memory cannot be served any more.
    async fn run(mut self, mut connected: Option<Connected>) -> Result<(), String> {
        let mut patient = connected.is_none().then(|| Instant::now() + START_WITHIN);
        loop {
            let connection = if let Some(connection) = connected.take() {
                connection
            } else if let Some(connection) = self.reach(patient).await? {
                connection
            } else {
                return Ok(());
            };
            patient = None;
            match self.converse(connection).await {
                Ended::Done => {
                    let _ = self.prefetched.send(true);
                    let _ = self.complete.send(true);
                    return Ok(());
                }
                Ended::Cancelled => return Ok(()),
                Ended::Failed(why) => return Err(why),
                // The agent is ending the VM, and the pager with it.
                Ended::Lost if self.ending.is_cancelled() => return Ok(()),
                Ended::Lost => tracing::debug!("pager connection lost; reconnecting"),
            }
        }
    }

    /// Connects again; `None` once the agent stops talking or the pager
    /// turns out to have finished.
    async fn reach(&self, patient: Option<Instant>) -> Result<Option<Connected>, String> {
        let attempt = tokio::select! {
            () = self.cancel.cancelled() => return Ok(None),
            attempt = connect(&self.link, patient, RECONNECT_WITHIN) => attempt,
        };
        match attempt {
            Ok(connection) => Ok(Some(connection)),
            // Gone without a word: done, if it left word.
            Err(Refused::Gone(_)) if done_file(&self.link.control).exists() => {
                let _ = self.prefetched.send(true);
                let _ = self.complete.send(true);
                Ok(None)
            }
            Err(Refused::Gone(_)) if self.ending.is_cancelled() => Ok(None),
            Err(Refused::Gone(error)) => Err(format!("the pager has gone: {error}")),
            Err(Refused::Wrong(why)) => Err(why),
        }
    }

    /// Talks over one connection.
    async fn converse(&mut self, connected: Connected) -> Ended {
        let Connected {
            mut frames,
            mut write,
            missing,
            prefetched,
            ..
        } = connected;
        if prefetched {
            let _ = self.prefetched.send(true);
        }
        if missing.is_empty() {
            let _ = self.complete.send(true);
        }
        // Whatever is in place that the pager may not know of.
        let mut ranges = self.filled.clone();
        if let Some(hydration) = &self.hydration {
            let present = (0..chunk_count(hydration.len())).filter(|index| {
                let chunk = chunk_range(*index, hydration.len());
                hydration.present(*index)
                    && missing
                        .iter()
                        .any(|&(start, end)| start < chunk.end && chunk.start < end)
            });
            ranges.extend(coalesce(hydration.len(), present));
        }
        if !ranges.is_empty() && send(&mut write, &ToPager::Filled { ranges }).await.is_err() {
            return Ended::Lost;
        }
        let mut hydrated = self.hydration.is_none();
        loop {
            tokio::select! {
                biased;
                () = self.cancel.cancelled() => return Ended::Cancelled,
                line = frames.next(MESSAGE_BYTES) => {
                    let line = match line {
                        Ok(Some(line)) => line,
                        Ok(None) => return Ended::Lost,
                        Err(error) => {
                            tracing::warn!(%error, "the pager's connection failed");
                            return Ended::Lost;
                        }
                    };
                    match control::parse::<ToHost>(&line) {
                        Ok(ToHost::Want { offset, len, urgent }) => self.ask(offset, len, urgent),
                        Ok(ToHost::Prefetched) => {
                            let _ = self.prefetched.send(true);
                        }
                        Ok(ToHost::Complete) => {
                            let _ = self.complete.send(true);
                        }
                        Ok(ToHost::Done) => return Ended::Done,
                        Ok(ToHost::Hello { .. }) | Err(_) => {
                            let line = String::from_utf8_lossy(&line);
                            tracing::warn!(%line, "the pager said something unexpected");
                            return Ended::Lost;
                        }
                    }
                }
                arrived = next(self.arrivals.as_mut()), if self.arrivals.is_some() => {
                    let Some(first) = arrived else {
                        self.arrivals = None;
                        continue;
                    };
                    let mut indices = vec![first];
                    if let Some(arrivals) = self.arrivals.as_mut() {
                        while let Ok(index) = arrivals.try_recv() {
                            indices.push(index);
                        }
                    }
                    let len = self.hydration.as_ref().map_or(0, |hydration| hydration.len());
                    let ranges = coalesce(len, indices.into_iter());
                    if send(&mut write, &ToPager::Filled { ranges }).await.is_err() {
                        return Ended::Lost;
                    }
                }
                finished = finished(self.hydration.as_ref()), if !hydrated => match finished {
                    Ok(()) => hydrated = true,
                    Err(why) => return Ended::Failed(why),
                },
            }
        }
    }

    /// Asks hydration for the chunks holding `len` bytes at `offset`.
    fn ask(&self, offset: u64, len: u64, urgent: bool) {
        let Some(hydration) = &self.hydration else {
            return;
        };
        let count = chunk_count(hydration.len());
        let first = usize::try_from(offset / CHUNK_BYTES).unwrap_or(usize::MAX);
        let last = usize::try_from(offset.saturating_add(len.max(1) - 1) / CHUNK_BYTES)
            .unwrap_or(usize::MAX)
            .min(count.saturating_sub(1));
        for index in first..=last {
            hydration.ask(index, urgent);
        }
    }
}

async fn next(arrivals: Option<&mut mpsc::UnboundedReceiver<usize>>) -> Option<usize> {
    match arrivals {
        Some(arrivals) => arrivals.recv().await,
        None => std::future::pending().await,
    }
}

async fn finished(hydration: Option<&Arc<Hydration>>) -> Result<(), String> {
    match hydration {
        Some(hydration) => hydration.finished().await.map_err(|why| why.reason),
        None => std::future::pending().await,
    }
}

/// The byte ranges of chunks `indices` of an image of `len` bytes, merged.
fn coalesce(len: u64, indices: impl Iterator<Item = usize>) -> Vec<(u64, u64)> {
    let mut indices: Vec<usize> = indices.collect();
    indices.sort_unstable();
    indices.dedup();
    let mut ranges: Vec<(u64, u64)> = Vec::new();
    for index in indices {
        let chunk = chunk_range(index, len);
        match ranges.last_mut() {
            Some(last) if last.1 == chunk.start => last.1 = chunk.end,
            _ => ranges.push((chunk.start, chunk.end)),
        }
    }
    ranges
}

async fn send(write: &mut OwnedWriteHalf, message: &ToPager) -> io::Result<()> {
    let line = control::line(message).map_err(io::Error::other)?;
    write.write_all(&line).await
}

#[cfg(test)]
mod tests;
