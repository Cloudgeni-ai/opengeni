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

use std::io;
use std::ops::Range;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use compute_engine::{CancellationToken, EngineError, ErrorKind};
use compute_pager::control::{self, ToHost, ToPager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, sleep, timeout};

use crate::image::{CHUNK_BYTES, Depth, Generation, Images, Verified, chunk_count, chunk_range};
use crate::lazy::{Fetcher, Hydration};
use crate::working_set::PageSet;

/// How long a starting pager may take to listen.
const START_WITHIN: Duration = Duration::from_secs(60);
/// How long a pager whose connection dropped may take to accept again.
const RECONNECT_WITHIN: Duration = Duration::from_secs(1);
/// How long a pager may take to greet a new connection.
const HELLO_WITHIN: Duration = Duration::from_secs(5);
/// The pause between attempts to connect.
const RETRY_EVERY: Duration = Duration::from_millis(5);

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
}

/// A connection to a pager that has greeted it.
struct Connected {
    lines: Lines<BufReader<OwnedReadHalf>>,
    write: OwnedWriteHalf,
    missing: Vec<(u64, u64)>,
    prefetched: bool,
    /// Device and inode of the memory file the pager reads.
    reads: (u64, u64),
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
    /// `identity`. `filled` are byte ranges of the file in place already;
    /// `hydration` fills the rest. Returns at once: the conversation waits
    /// for the pager to listen.
    pub fn start(
        control: PathBuf,
        tag: String,
        identity: (u64, u64),
        hydration: Option<(Arc<Hydration>, mpsc::UnboundedReceiver<usize>)>,
        filled: Vec<Range<u64>>,
    ) -> Self {
        let link = Link {
            control,
            tag,
            identity,
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
        let mut link = Link {
            control: control.to_owned(),
            tag,
            identity: (0, 0),
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
    let stream = UnixStream::connect(&link.control)
        .await
        .map_err(Refused::Gone)?;
    let (read, write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let greeting = match timeout(HELLO_WITHIN, lines.next_line()).await {
        Ok(Ok(Some(greeting))) => greeting,
        Ok(Ok(None)) => return Err(Refused::Gone(io::ErrorKind::UnexpectedEof.into())),
        Ok(Err(error)) => return Err(Refused::Gone(error)),
        Err(_) => return Err(Refused::Wrong("the pager did not greet".into())),
    };
    match control::parse::<ToHost>(greeting.as_bytes()) {
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
            Ok(Connected {
                lines,
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
            mut lines,
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
                line = lines.next_line() => {
                    let Ok(Some(line)) = line else {
                        return Ended::Lost;
                    };
                    match control::parse::<ToHost>(line.as_bytes()) {
                        Ok(ToHost::Want { offset, len, urgent }) => self.ask(offset, len, urgent),
                        Ok(ToHost::Prefetched) => {
                            let _ = self.prefetched.send(true);
                        }
                        Ok(ToHost::Complete) => {
                            let _ = self.complete.send(true);
                        }
                        Ok(ToHost::Done) => return Ended::Done,
                        Ok(ToHost::Hello { .. }) | Err(_) => {
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
mod tests {
    use super::*;

    #[test]
    fn a_resumed_hydration_keeps_what_the_pager_has() {
        let len = 3 * CHUNK_BYTES;
        let page = 4096;
        let missing = [(page, 2 * page), (CHUNK_BYTES + page, 2 * CHUNK_BYTES)];
        let (filled, settled) = resumed(&missing, len);
        assert_eq!(settled, vec![false, false, true]);
        assert!(filled.covers(0..page));
        assert!(!filled.covers(page..2 * page));
        assert!(filled.covers(2 * page..CHUNK_BYTES + page));
        assert!(!filled.covers(CHUNK_BYTES + page..CHUNK_BYTES + 2 * page));
        assert!(filled.covers(2 * CHUNK_BYTES..len));
    }

    #[test]
    fn arrived_chunks_are_told_as_merged_ranges() {
        let len = 4 * CHUNK_BYTES - 4096;
        assert_eq!(
            coalesce(len, [3, 0, 1, 1].into_iter()),
            vec![(0, 2 * CHUNK_BYTES), (3 * CHUNK_BYTES, len)]
        );
    }

    /// A pager on `control` that greets with `missing` and passes on what
    /// the agent first tells it, then says the file is complete and, if
    /// `done`, that it is done; it stays connected until the agent goes.
    fn fake_pager(
        control: &Path,
        tag: String,
        identity: (u64, u64),
        missing: Vec<(u64, u64)>,
        done: bool,
    ) -> tokio::sync::oneshot::Receiver<ToPager> {
        let listener = tokio::net::UnixListener::bind(control).unwrap();
        let (pass, told) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let hello = ToHost::Hello {
                protocol: control::PROTOCOL,
                tag,
                device: identity.0,
                inode: identity.1,
                missing,
                prefetched: true,
            };
            write
                .write_all(&control::line(&hello).unwrap())
                .await
                .unwrap();
            let mut lines = BufReader::new(read).lines();
            let line = lines.next_line().await.unwrap().unwrap();
            let _ = pass.send(control::parse::<ToPager>(line.as_bytes()).unwrap());
            write
                .write_all(&control::line(&ToHost::Complete).unwrap())
                .await
                .unwrap();
            if done {
                write
                    .write_all(&control::line(&ToHost::Done).unwrap())
                    .await
                    .unwrap();
            }
            while let Ok(Some(_)) = lines.next_line().await {}
        });
        told
    }

    /// A local image, its launch marker and the pager's control socket.
    fn local_image(dir: &Path) -> (Images, Generation, PathBuf, PathBuf, String) {
        let images = Images::new(dir.join("images"));
        let (state, memory) = (dir.join("state"), dir.join("memory"));
        std::fs::write(&state, b"s").unwrap();
        std::fs::write(&memory, vec![7_u8; 3 * 4096]).unwrap();
        let image = images
            .publish(crate::image::Parts::Whole {
                state: &state,
                memory: &memory,
                len: 3 * 4096,
            })
            .unwrap();
        let generation = image.generation();
        let tag = tag(generation);
        let marker = dir.join("paged");
        std::fs::write(&marker, &tag).unwrap();
        (images, generation, marker, dir.join("pager.sock"), tag)
    }

    #[tokio::test]
    async fn a_pager_that_missed_word_of_a_local_image_is_told_it_is_whole() {
        let dir = tempfile::tempdir().unwrap();
        let (images, generation, marker, control, tag) = local_image(dir.path());
        let identity = identity(&images.memory(generation)).unwrap();
        // The last fill was written but never acknowledged before the
        // agent died, and the image has since become local.
        let pager = fake_pager(&control, tag, identity, vec![(4096, 3 * 4096)], false);
        let paging = Paging::reconnect(&marker, &control, images, None)
            .await
            .unwrap()
            .expect("the pager runs");
        let told = timeout(Duration::from_secs(5), pager)
            .await
            .expect("the pager is told")
            .unwrap();
        assert_eq!(
            told,
            ToPager::Filled {
                ranges: vec![(4096, 3 * 4096)]
            }
        );
        timeout(Duration::from_secs(5), paging.complete())
            .await
            .expect("the pager says it is complete")
            .unwrap();
        paging.close().await;
    }

    #[tokio::test]
    async fn a_conversation_that_ended_still_reads_as_complete() {
        let dir = tempfile::tempdir().unwrap();
        let (images, generation, marker, control, tag) = local_image(dir.path());
        let identity = identity(&images.memory(generation)).unwrap();
        let pager = fake_pager(&control, tag, identity, vec![(4096, 3 * 4096)], true);
        let paging = Paging::reconnect(&marker, &control, images, None)
            .await
            .unwrap()
            .expect("the pager runs");
        timeout(Duration::from_secs(5), pager)
            .await
            .expect("the pager is told")
            .unwrap();
        // Once the conversation has ended, both channels are closed and
        // either may look ready to a waiter.
        let (mut complete, mut failed) = (paging.complete.clone(), paging.failed.clone());
        timeout(Duration::from_secs(5), async {
            while complete.changed().await.is_ok() {}
            while failed.changed().await.is_ok() {}
        })
        .await
        .expect("the conversation ends");
        assert!(*complete.borrow() && !*failed.borrow());
        for _ in 0..200 {
            timeout(Duration::from_secs(1), paging.complete())
                .await
                .expect("completion is seen, whichever channel is polled first")
                .unwrap();
        }
        paging.close().await;
    }

    #[tokio::test]
    async fn a_pager_gone_without_word_leaves_the_verdict_to_the_vmm() {
        let dir = tempfile::tempdir().unwrap();
        let (images, _, marker, control, _) = local_image(dir.path());
        // Nothing to reconnect to, done or not: the engine's adoption
        // decides from the VMM whether its memory was lost.
        for done in [false, true] {
            if done {
                std::fs::write(done_file(&control), b"").unwrap();
            }
            assert!(
                Paging::reconnect(&marker, &control, images.clone(), None)
                    .await
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[tokio::test]
    async fn a_pager_of_an_unknown_protocol_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let control = dir.path().join("pager.sock");
        let link = Link {
            control: control.clone(),
            tag: "7".into(),
            identity: (0, 0),
        };
        let listener = tokio::net::UnixListener::bind(&control).unwrap();
        for (protocol, accepted) in [
            (control::PROTOCOL, true),
            (control::PROTOCOL + 1, false),
            (control::OLDEST_PROTOCOL - 1, false),
        ] {
            let pager = {
                let hello = ToHost::Hello {
                    protocol,
                    tag: "7".into(),
                    device: 1,
                    inode: 2,
                    missing: Vec::new(),
                    prefetched: true,
                };
                let accept = listener.accept();
                async move {
                    let (mut stream, _) = accept.await.unwrap();
                    stream
                        .write_all(&control::line(&hello).unwrap())
                        .await
                        .unwrap();
                    stream
                }
            };
            let (greeted, _stream) = tokio::join!(greet(&link), pager);
            match greeted {
                Ok(_) => assert!(accepted, "protocol {protocol} was accepted"),
                Err(Refused::Wrong(why)) => {
                    assert!(!accepted, "protocol {protocol} was refused: {why}");
                    assert!(why.contains("protocol"), "{why}");
                }
                Err(Refused::Gone(error)) => panic!("the pager seemed gone: {error}"),
            }
        }
    }

    /// A pager that greets, misses part of its image, and exits without a
    /// word when told to.
    fn exiting_pager(
        socket: &Path,
        tag: String,
        identity: (u64, u64),
    ) -> tokio::sync::oneshot::Sender<()> {
        let listener = tokio::net::UnixListener::bind(socket).unwrap();
        let socket = socket.to_owned();
        let (exit, exited) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (_read, mut write) = stream.into_split();
            let hello = ToHost::Hello {
                protocol: control::PROTOCOL,
                tag,
                device: identity.0,
                inode: identity.1,
                missing: vec![(4096, 3 * 4096)],
                prefetched: true,
            };
            write
                .write_all(&control::line(&hello).unwrap())
                .await
                .unwrap();
            let _ = exited.await;
            drop(listener);
            let _ = std::fs::remove_file(&socket);
        });
        exit
    }

    #[tokio::test]
    async fn a_pager_ended_with_its_vm_is_not_lost_memory() {
        for ending in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let (images, generation, marker, control, tag) = local_image(dir.path());
            let identity = identity(&images.memory(generation)).unwrap();
            let exit = exiting_pager(&control, tag, identity);
            let paging = Paging::reconnect(&marker, &control, images, None)
                .await
                .unwrap()
                .expect("the pager runs");
            if ending {
                paging.ending();
            }
            exit.send(()).unwrap();
            let verdict = timeout(Duration::from_secs(5), paging.complete())
                .await
                .expect("the conversation ends");
            // Only a pager that went while its VM was meant to go on
            // running means memory that can no longer be served.
            if ending {
                assert!(matches!(verdict, Err(Incomplete::Stopped)), "{verdict:?}");
                assert!(!*paging.failed.borrow());
            } else {
                assert!(matches!(verdict, Err(Incomplete::Failed)), "{verdict:?}");
            }
            paging.close().await;
        }
    }

    #[test]
    fn launch_tags_name_their_generation() {
        let generation = Generation::parse("00000000000000a7").unwrap();
        let tag = tag(generation);
        assert_eq!(generation_of(&tag), Some(generation));
        assert_ne!(tag, super::tag(generation));
        assert_eq!(generation_of("00000000000000a7"), None);
    }
}
