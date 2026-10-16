//! Linux UFFD transport and serialized pager. The owner must keep the image
//! immutable and supervise both the pager and VMM: a dead pager stalls the VM.

use crate::source::Source;
use crate::{Layout, Mapping, Page, Profile};
use memmap2::MmapMut;
use nix::sys::socket::{ControlMessageOwned, MsgFlags, recvmsg};
use serde::Serialize;
use std::{
    collections::VecDeque,
    io::{self, IoSliceMut, Read},
    os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
    os::unix::net::UnixStream,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

const COPY: libc::c_ulong = 0xc028_aa03;
const WAKE: libc::c_ulong = 0x8010_aa02;
const PRESENT: u8 = 1;
const REMOVED: u8 = 2;
const UNMAPPED: u8 = 4;
const RECORDED: u8 = 8;
/// Queued for prefetch and waiting on the source.
const WAITING: u8 = 16;
/// Largest single copy, and largest range asked of a source.
pub const MAX_BATCH: u64 = 2 << 20;
/// Prefetch runs waiting on the source at once. Each one asks the source
/// for its bytes, so this is how far ahead of the copies fetching runs.
const LOOKAHEAD: usize = 256;

#[repr(C)]
#[derive(Default, Debug)]
struct CopyRange {
    dst: u64,
    src: u64,
    len: u64,
    mode: u64,
    copied: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Event {
    Fault(u64),
    Remove(u64, u64),
    Unmap(u64, u64),
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn decode(bytes: &[u8; 32]) -> io::Result<Event> {
    let word = |at: usize| {
        let mut word = [0_u8; 8];
        word.copy_from_slice(&bytes[at..at + 8]);
        u64::from_ne_bytes(word)
    };
    let (a, b) = (word(8), word(16));
    match bytes[0] {
        0x12 if a & !1 == 0 => Ok(Event::Fault(b)),
        0x15 if a < b => Ok(Event::Remove(a, b)),
        0x16 if a < b => Ok(Event::Unmap(a, b)),
        _ => Err(invalid("unsupported UFFD event or fault mode")),
    }
}

/// Accept one descriptor and a possibly fragmented JSON mapping message.
/// The stream should have a read timeout and reside in a private directory.
pub fn handshake(mut stream: &UnixStream) -> io::Result<(OwnedFd, Vec<Mapping>)> {
    let mut data = vec![0_u8; 65536];
    let mut control = nix::cmsg_space!([libc::c_int; 8]);
    let mut descriptors = Vec::new();
    let (count, flags) = {
        let mut iov = [IoSliceMut::new(&mut data)];
        let message = recvmsg::<()>(
            stream.as_raw_fd(),
            &mut iov,
            Some(&mut control),
            MsgFlags::MSG_CMSG_CLOEXEC,
        )?;
        for control in message.cmsgs()? {
            if let ControlMessageOwned::ScmRights(fds) = control {
                for fd in fds {
                    // SAFETY: SCM_RIGHTS hands us newly owned descriptors.
                    descriptors.push(unsafe { OwnedFd::from_raw_fd(fd) });
                }
            }
        }
        (message.bytes, message.flags)
    };
    if flags.intersects(MsgFlags::MSG_CTRUNC | MsgFlags::MSG_TRUNC)
        || descriptors.len() != 1
        || count == 0
    {
        return Err(invalid("truncated handshake or invalid descriptor count"));
    }
    data.truncate(count);
    loop {
        match serde_json::from_slice(&data) {
            Ok(regions) => {
                return Ok((
                    descriptors
                        .pop()
                        .ok_or_else(|| invalid("missing descriptor"))?,
                    regions,
                ));
            }
            Err(error) if error.is_eof() && data.len() < 1024 * 1024 => {
                let mut chunk = [0_u8; 4096];
                let count = stream.read(&mut chunk)?;
                if count == 0 {
                    return Err(invalid("incomplete mapping JSON"));
                }
                data.extend_from_slice(&chunk[..count]);
            }
            Err(error) => return Err(invalid(&error.to_string())),
        }
    }
}

/// Counters are cumulative; timing the caller's full wake also includes prefetch.
#[derive(Default, Debug, Clone, Serialize)]
pub struct Stats {
    pub faults: u64,
    /// Faults that had to wait for the source.
    pub parked_faults: u64,
    pub copy_calls: u64,
    pub copied_bytes: u64,
    pub zero_bytes: u64,
    pub existing_pages: u64,
    pub retry_events: u64,
    pub remove_events: u64,
    pub unmap_events: u64,
    /// Pages the prefetch plan copied in.
    pub prefetched_pages: u64,
    /// Time from queueing the prefetch plan to its last page arriving,
    /// including pages queued with [`Pager::queue_background`].
    pub prefetch_ms: f64,
    /// Time from queueing the prefetch plan to the last page queued with
    /// [`Pager::queue_prefetch`] being in place: how long a wake that waits
    /// for [`Progress::Prefetched`] waited.
    pub ready_ms: f64,
}

/// Something the caller of [`Pager::run`] may want to act on.
#[derive(Debug)]
pub enum Progress<'a> {
    /// Every page queued with [`Pager::queue_prefetch`] is in place (or was
    /// discarded). Pages queued with [`Pager::queue_background`] may still
    /// be arriving.
    Prefetched,
    /// The first-touch recording window closed; these are the image offsets
    /// the guest touched first, in order.
    Recorded(&'a [u64]),
}

/// How one copy attempt went.
enum Copied {
    /// This many pages are now in place.
    Pages(usize),
    /// A mapping change raced the copy; read events, then retry.
    Retry,
    /// The source does not have the bytes yet.
    Pending,
}

/// A contiguous run of pages: `count` pages starting at `first`.
#[derive(Clone, Copy, Debug)]
struct Run {
    first: Page,
    count: usize,
}

impl Run {
    fn page(&self, at: usize) -> Page {
        let step = self.first.size * at as u64;
        Page {
            address: self.first.address + step,
            offset: self.first.offset + step,
            size: self.first.size,
            index: self.first.index + at,
        }
    }
}

/// How the pager learns that the VMM has gone. The UFFD cannot say: the
/// VMM shares it with the pager.
#[derive(Debug)]
enum Vmm {
    /// The socket the VMM's handshake arrived on, which hangs up when the
    /// VMM exits.
    Socket(UnixStream),
    /// A pidfd of the VMM process, which turns readable when it exits.
    Process(OwnedFd),
}

impl Vmm {
    fn raw_fd(&self) -> RawFd {
        match self {
            Self::Socket(socket) => socket.as_raw_fd(),
            Self::Process(pidfd) => pidfd.as_raw_fd(),
        }
    }

    /// Whether `revents` from polling [`Self::raw_fd`] for input say the
    /// VMM has gone.
    fn gone(&self, revents: libc::c_short) -> bool {
        match self {
            Self::Socket(_) => revents & libc::POLLHUP != 0,
            Self::Process(_) => revents & (libc::POLLIN | libc::POLLHUP) != 0,
        }
    }
}

/// One memory image served to one VMM through its UFFD. A single owner
/// serializes demand faults, discard events and prefetch; nothing here
/// blocks on the source.
#[derive(Debug)]
pub struct Pager<S> {
    fd: OwnedFd,
    vmm: Vmm,
    source: S,
    zero: MmapMut,
    layout: Layout,
    state: Vec<u8>,
    trace: Vec<u64>,
    /// Faulting addresses ready to serve.
    faults: VecDeque<u64>,
    /// Faulting addresses waiting on the source.
    parked: Vec<u64>,
    /// Prefetch pages not tried yet, in priority order.
    plan: VecDeque<Page>,
    /// Indices of the pages the caller waits for, in plan order, and how
    /// many of them from the front are known to be in place.
    gate: Vec<usize>,
    gate_done: usize,
    /// Prefetch runs waiting on the source.
    waiting: Vec<Run>,
    max_batch: u64,
    started: Instant,
    record_for: Duration,
    recorded: bool,
    prefetch_started: Option<Instant>,
    pub stats: Stats,
}

impl<S: Source> Pager<S> {
    /// Completes the VMM's handshake on `peer` and serves its memory from
    /// `source`, recording the order the guest first touches pages for
    /// `record_for`.
    pub fn new(peer: UnixStream, source: S, record_for: Duration) -> io::Result<Self> {
        peer.set_read_timeout(Some(Duration::from_secs(10)))?;
        let (fd, regions) = handshake(&peer)?;
        Self::serving(fd, Vmm::Socket(peer), regions, source, record_for)
    }

    /// Takes over serving a VMM whose previous pager has gone (the process
    /// that ran it restarted, say). `uffd` is a duplicate of the VMM's
    /// UFFD, `regions` the layout its handshake announced, and `vmm` a
    /// pidfd of the VMM process. The VMM kept its own reference to the
    /// UFFD, so its faults waited for a handler rather than reading zeros;
    /// those the previous pager had read but not served are woken to fault
    /// again. Which pages are present is unknown: copying over one that is
    /// counts as done.
    pub fn adopt(
        uffd: OwnedFd,
        regions: Vec<Mapping>,
        vmm: OwnedFd,
        source: S,
        record_for: Duration,
    ) -> io::Result<Self> {
        // SAFETY: a flag query on a descriptor we own.
        let flags = unsafe { libc::fcntl(uffd.as_raw_fd(), libc::F_GETFL) };
        if flags < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a flag update on a descriptor we own.
        if unsafe { libc::fcntl(uffd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let pager = Self::serving(uffd, Vmm::Process(vmm), regions, source, record_for)?;
        for region in pager.layout.regions() {
            let mut range = [region.base_host_virt_addr, region.size];
            // SAFETY: repr-compatible uffdio_range over a region the VMM
            // registered; waking a range nobody waits on does nothing.
            if unsafe { libc::ioctl(pager.fd.as_raw_fd(), WAKE, range.as_mut_ptr()) } < 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(pager)
    }

    fn serving(
        fd: OwnedFd,
        vmm: Vmm,
        regions: Vec<Mapping>,
        source: S,
        record_for: Duration,
    ) -> io::Result<Self> {
        let layout = Layout::new(regions, source.len())?;
        let zero = MmapMut::map_anon(usize::try_from(MAX_BATCH).map_err(|_| invalid("batch"))?)?;
        let state = vec![0; layout.page_count()];
        Ok(Self {
            fd,
            vmm,
            source,
            zero,
            layout,
            state,
            trace: Vec::new(),
            faults: VecDeque::new(),
            parked: Vec::new(),
            plan: VecDeque::new(),
            gate: Vec::new(),
            gate_done: 0,
            waiting: Vec::new(),
            max_batch: MAX_BATCH,
            started: Instant::now(),
            record_for,
            recorded: false,
            prefetch_started: None,
            stats: Stats::default(),
        })
    }

    #[must_use]
    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    #[must_use]
    pub fn source(&self) -> &S {
        &self.source
    }

    /// The pages the guest touched first so far, bound to `snapshot_id`.
    #[must_use]
    pub fn profile(&self, snapshot_id: String) -> Profile {
        Profile {
            version: 1,
            snapshot_id,
            offsets: self.trace.clone(),
        }
    }

    /// Queues `pages` to be copied in ahead of demand, in order, in copies
    /// of at most `max_batch` bytes. Demand faults always go first.
    /// [`Progress::Prefetched`] waits for these pages.
    pub fn queue_prefetch(&mut self, pages: &[Page], max_batch: u64) -> io::Result<()> {
        self.validate(pages)?;
        self.max_batch = max_batch.clamp(1, MAX_BATCH);
        self.gate.extend(pages.iter().map(|page| page.index));
        self.plan.extend(pages);
        self.prefetch_started.get_or_insert_with(Instant::now);
        Ok(())
    }

    /// Queues `pages` to be copied in after everything already queued,
    /// without holding back [`Progress::Prefetched`]: the rest of a working
    /// set, streamed in while the guest already runs.
    pub fn queue_background(&mut self, pages: &[Page]) -> io::Result<()> {
        self.validate(pages)?;
        self.plan.extend(pages);
        self.prefetch_started.get_or_insert_with(Instant::now);
        Ok(())
    }

    /// Revalidates public Page inputs rather than trusting caller indices.
    fn validate(&self, pages: &[Page]) -> io::Result<()> {
        if pages
            .iter()
            .any(|page| self.layout.offset(page.offset) != Some(*page))
        {
            return Err(invalid("invalid prefetch page"));
        }
        Ok(())
    }

    /// Whether the prefetch plan is finished.
    #[must_use]
    pub fn prefetched(&self) -> bool {
        self.plan.is_empty() && self.waiting.is_empty()
    }

    /// Whether every page queued with [`Pager::queue_prefetch`] is in place
    /// or no longer needs to be. Amortized constant time: the pages are
    /// checked in plan order and each is passed once.
    pub fn ready(&mut self) -> bool {
        while let Some(&index) = self.gate.get(self.gate_done) {
            if self.state[index] & (PRESENT | REMOVED | UNMAPPED) == 0 {
                return false;
            }
            self.gate_done += 1;
        }
        true
    }

    /// Copies `pages` in ahead of demand and returns once they are all in
    /// place, serving demand faults meanwhile.
    pub fn prefetch(&mut self, pages: &[Page], max_batch: u64) -> io::Result<()> {
        self.queue_prefetch(pages, max_batch)?;
        while !self.prefetched() {
            self.turn()?;
            if !self.prefetched() && self.wait(Duration::from_millis(100))? {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "the VMM disconnected during prefetch",
                ));
            }
        }
        self.finish_prefetch();
        Ok(())
    }

    fn finish_prefetch(&mut self) {
        if let Some(started) = self.prefetch_started.take() {
            self.stats.prefetch_ms += started.elapsed().as_secs_f64() * 1000.0;
        }
    }

    fn read_event(&self) -> io::Result<Option<Event>> {
        let mut bytes = [0_u8; 32];
        loop {
            // SAFETY: valid writable buffer; fd remains owned for the call.
            let count =
                unsafe { libc::read(self.fd.as_raw_fd(), bytes.as_mut_ptr().cast(), bytes.len()) };
            if count == 32 {
                return decode(&bytes).map(Some);
            }
            if count != -1 {
                return Err(invalid("short UFFD event read"));
            }
            let error = io::Error::last_os_error();
            match error.kind() {
                io::ErrorKind::WouldBlock => return Ok(None),
                io::ErrorKind::Interrupted => {}
                _ => return Err(error),
            }
        }
    }

    fn invalidate(&mut self, start: u64, end: u64, unmapped: bool) -> io::Result<()> {
        let mut address = start;
        while address < end {
            let page = self
                .layout
                .address(address)
                .ok_or_else(|| invalid("discard outside memory layout"))?;
            if address != page.address || end - address < page.size {
                return Err(invalid("unaligned discard range"));
            }
            self.state[page.index] &= !PRESENT;
            self.state[page.index] |= if unmapped { UNMAPPED } else { REMOVED };
            address += page.size;
        }
        Ok(())
    }

    /// Reads every pending notification. REMOVE invalidates image contents
    /// permanently (the page reads as zeros from then on), whereas UNMAP
    /// retires the destination.
    fn drain_events(&mut self) -> io::Result<()> {
        while let Some(event) = self.read_event()? {
            match event {
                Event::Fault(address) => {
                    self.stats.faults += 1;
                    self.faults.push_back(address);
                }
                Event::Remove(start, end) => {
                    self.stats.remove_events += 1;
                    self.invalidate(start, end, false)?;
                }
                Event::Unmap(start, end) => {
                    self.stats.unmap_events += 1;
                    self.invalidate(start, end, true)?;
                }
            }
        }
        Ok(())
    }

    /// One round of work that never blocks: read notifications, serve every
    /// fault whose bytes are available, then advance prefetch.
    pub fn turn(&mut self) -> io::Result<()> {
        self.drain_events()?;
        if self.source.ready_fd().is_some() && readable(self.source_fd())? {
            self.source.acknowledge()?;
            self.unpark();
        }
        self.serve_faults()?;
        self.advance_prefetch()
    }

    /// Serves pending demand faults; an alias of [`Pager::turn`] kept for
    /// callers that drive the pager by hand.
    pub fn service_pending(&mut self) -> io::Result<()> {
        self.turn()
    }

    fn source_fd(&self) -> RawFd {
        self.source.ready_fd().map_or(-1, |fd| fd.as_raw_fd())
    }

    /// Retries everything that waited on the source.
    fn unpark(&mut self) {
        self.faults.extend(self.parked.drain(..));
        for run in self.waiting.drain(..).rev() {
            for at in (0..run.count).rev() {
                let page = run.page(at);
                self.state[page.index] &= !WAITING;
                self.plan.push_front(page);
            }
        }
    }

    fn serve_faults(&mut self) -> io::Result<()> {
        while let Some(address) = self.faults.pop_front() {
            let page = self
                .layout
                .address(address)
                .ok_or_else(|| invalid("fault outside memory layout"))?;
            if self.state[page.index] & UNMAPPED != 0 {
                continue;
            }
            if self.started.elapsed() <= self.record_for && self.state[page.index] & RECORDED == 0 {
                self.trace.push(page.offset);
                self.state[page.index] |= RECORDED;
            }
            match self.copy(
                Run {
                    first: page,
                    count: 1,
                },
                true,
            )? {
                Copied::Pages(_) => {}
                Copied::Retry => {
                    self.faults.push_front(address);
                    break;
                }
                Copied::Pending => {
                    self.stats.parked_faults += 1;
                    self.parked.push(address);
                }
            }
        }
        Ok(())
    }

    fn advance_prefetch(&mut self) -> io::Result<()> {
        while self.faults.is_empty() && self.waiting.len() < LOOKAHEAD {
            let Some(first) = self.plan.pop_front() else {
                break;
            };
            if self.state[first.index] & (PRESENT | UNMAPPED | WAITING) != 0 {
                continue;
            }
            let region_end = self
                .layout
                .region_end(first.address)
                .ok_or_else(|| invalid("invalid prefetch region"))?;
            let mut run = Run { first, count: 1 };
            while self.state[first.index] & REMOVED == 0 {
                let Some(&next) = self.plan.front() else {
                    break;
                };
                let expected = run.page(run.count);
                let length = first.size * (run.count as u64 + 1);
                if length > self.max_batch
                    || first.address + length > region_end
                    || next != expected
                    || self.state[next.index] & (PRESENT | REMOVED | UNMAPPED | WAITING) != 0
                {
                    break;
                }
                self.plan.pop_front();
                run.count += 1;
            }
            match self.copy(run, false)? {
                Copied::Pages(done) => {
                    self.stats.prefetched_pages += done as u64;
                    // Put back whatever the kernel did not copy this time.
                    for at in (done..run.count).rev() {
                        self.plan.push_front(run.page(at));
                    }
                }
                Copied::Retry => {
                    for at in (0..run.count).rev() {
                        self.plan.push_front(run.page(at));
                    }
                    break;
                }
                Copied::Pending => {
                    for at in 0..run.count {
                        self.state[run.page(at).index] |= WAITING;
                    }
                    self.waiting.push(run);
                }
            }
        }
        Ok(())
    }

    /// Copies `run` into guest memory: zeros for discarded pages, the
    /// image's bytes otherwise.
    fn copy(&mut self, run: Run, urgent: bool) -> io::Result<Copied> {
        let page = run.first;
        let zero = self.state[page.index] & REMOVED != 0;
        let length = page.size * run.count as u64;
        if length > MAX_BATCH {
            return Err(invalid("copy larger than a batch"));
        }
        let source = if zero {
            self.zero.as_ptr()
        } else {
            match self.source.get(page.offset, length, urgent)? {
                Some(bytes) if bytes.len() as u64 == length => bytes.as_ptr(),
                Some(_) => return Err(invalid("source returned the wrong length")),
                None => return Ok(Copied::Pending),
            }
        };
        let mut range = CopyRange {
            dst: page.address,
            src: source as u64,
            len: length,
            ..CopyRange::default()
        };
        self.stats.copy_calls += 1;
        // SAFETY: the UAPI structure is repr(C); the layout validated the
        // destination, and the source bytes stay valid until the next call
        // on the source, which cannot happen during this ioctl.
        let result = unsafe { libc::ioctl(self.fd.as_raw_fd(), COPY, &raw mut range) };
        if range.copied > 0 {
            let bytes = u64::try_from(range.copied).map_err(|_| invalid("negative copy count"))?;
            if bytes > length || !bytes.is_multiple_of(page.size) {
                return Err(invalid("invalid UFFD copy progress"));
            }
            let done =
                usize::try_from(bytes / page.size).map_err(|_| invalid("copy count overflow"))?;
            for state in &mut self.state[page.index..page.index + done] {
                *state |= PRESENT;
            }
            self.stats.copied_bytes += bytes;
            if zero {
                self.stats.zero_bytes += bytes;
            }
            return Ok(Copied::Pages(done));
        }
        if result < 0 {
            let error = io::Error::last_os_error();
            // A mapping-changing event raced the copy. Read it before retrying
            // so REMOVE can replace the image contents with zeros.
            if matches!(
                error.raw_os_error(),
                Some(libc::EAGAIN | libc::EINTR | libc::ENOENT)
            ) {
                self.stats.retry_events += 1;
                return Ok(Copied::Retry);
            }
            if error.raw_os_error() == Some(libc::EEXIST) {
                self.state[page.index] |= PRESENT;
                self.stats.existing_pages += 1;
                let mut range = [page.address, page.size];
                // SAFETY: repr-compatible uffdio_range; valid registered page.
                if unsafe { libc::ioctl(self.fd.as_raw_fd(), WAKE, range.as_mut_ptr()) } < 0 {
                    return Err(io::Error::last_os_error());
                }
                return Ok(Copied::Pages(1));
            }
            return Err(error);
        }
        Err(invalid("UFFD copy made no progress"))
    }

    /// Sleeps until the UFFD, the VMM's socket or the source has something,
    /// or `timeout` passes. Returns whether the VMM hung up.
    fn wait(&self, timeout: Duration) -> io::Result<bool> {
        let mut poll = [
            libc::pollfd {
                fd: self.fd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: self.vmm.raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: self.source_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        let millis = libc::c_int::try_from(timeout.as_millis()).unwrap_or(libc::c_int::MAX);
        // SAFETY: valid pollfd array with the matching element count; poll
        // ignores the negative descriptor of a source without one.
        let result = unsafe { libc::poll(poll.as_mut_ptr(), 3, millis) };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
        if poll[0].revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
            return Err(invalid("UFFD disconnected"));
        }
        Ok(self.vmm.gone(poll[1].revents))
    }

    /// Serves the VMM until `stopped` is set or the VMM disconnects,
    /// reporting [`Progress`] as it happens. Intended for a dedicated
    /// thread, never an async executor's poll thread. A recording window
    /// still open when the VMM goes is reported then, so a VM that sleeps
    /// again quickly still teaches the next wake what it touched.
    pub fn run(
        &mut self,
        stopped: &AtomicBool,
        mut progress: impl FnMut(Progress<'_>),
    ) -> io::Result<()> {
        let mut reported_ready = false;
        while !stopped.load(Ordering::Relaxed) {
            if let Err(error) = self.turn() {
                // The VMM can disappear between the last peer poll and COPY.
                // ESRCH means its mm no longer exists, not a paging failure.
                if error.raw_os_error() == Some(libc::ESRCH) {
                    break;
                }
                return Err(error);
            }
            if !reported_ready && self.ready() {
                reported_ready = true;
                if let Some(started) = self.prefetch_started {
                    self.stats.ready_ms = started.elapsed().as_secs_f64() * 1000.0;
                }
                progress(Progress::Prefetched);
            }
            if self.prefetch_started.is_some() && self.prefetched() {
                self.finish_prefetch();
            }
            if !self.recorded && self.started.elapsed() > self.record_for {
                self.recorded = true;
                progress(Progress::Recorded(&self.trace));
            }
            let busy = !self.faults.is_empty()
                || (!self.plan.is_empty() && self.waiting.len() < LOOKAHEAD);
            let timeout = if !self.faults.is_empty() {
                Duration::from_millis(1)
            } else if busy {
                Duration::ZERO
            } else {
                Duration::from_millis(100)
            };
            if self.wait(timeout)? {
                break;
            }
        }
        if !self.recorded {
            self.recorded = true;
            progress(Progress::Recorded(&self.trace));
        }
        Ok(())
    }
}

/// Whether `fd` is readable right now.
fn readable(fd: RawFd) -> io::Result<bool> {
    let mut poll = [libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    }];
    // SAFETY: one valid pollfd; a zero timeout never blocks.
    let result = unsafe { libc::poll(poll.as_mut_ptr(), 1, 0) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(poll[0].revents & libc::POLLIN != 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::MappedFile;
    use std::fs::File;

    #[test]
    fn event_decoding_is_strict() {
        let mut bytes = [0; 32];
        bytes[0] = 0x12;
        bytes[16..24].copy_from_slice(&0x1234_u64.to_ne_bytes());
        assert_eq!(decode(&bytes).unwrap(), Event::Fault(0x1234));
        bytes[8] = 2;
        assert!(decode(&bytes).is_err());
        bytes[0] = 0x15;
        bytes[8..16].copy_from_slice(&0x1000_u64.to_ne_bytes());
        bytes[16..24].copy_from_slice(&0x2000_u64.to_ne_bytes());
        assert_eq!(decode(&bytes).unwrap(), Event::Remove(0x1000, 0x2000));
        bytes[0] = 0x16;
        assert_eq!(decode(&bytes).unwrap(), Event::Unmap(0x1000, 0x2000));
    }

    #[test]
    fn copy_abi_size() {
        assert_eq!(size_of::<CopyRange>(), 40);
    }

    #[test]
    fn fragmented_handshake_retains_owned_descriptor() {
        use nix::sys::socket::{ControlMessage, sendmsg};
        use std::io::{IoSlice, Write};
        let (peer, mut sender) = UnixStream::pair().unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let file = File::open("/dev/null").unwrap();
        let json = br#"[{"base_host_virt_addr":4096,"size":4096,"offset":0,"page_size":4096}]"#;
        std::thread::scope(|scope| {
            let writer = scope.spawn(|| {
                sendmsg::<()>(
                    sender.as_raw_fd(),
                    &[IoSlice::new(&json[..8])],
                    &[ControlMessage::ScmRights(&[file.as_raw_fd()])],
                    MsgFlags::empty(),
                    None,
                )
                .unwrap();
                std::thread::sleep(Duration::from_millis(5));
                sender.write_all(&json[8..]).unwrap();
            });
            let (received, mappings) = handshake(&peer).unwrap();
            assert_eq!(mappings.len(), 1);
            assert_eq!(mappings[0].size, 4096);
            assert_ne!(received.as_raw_fd(), file.as_raw_fd());
            writer.join().unwrap();
        });
    }

    #[test]
    fn handshake_rejects_multiple_descriptors() {
        use nix::sys::socket::{ControlMessage, sendmsg};
        use std::io::IoSlice;
        let (peer, sender) = UnixStream::pair().unwrap();
        let file = File::open("/dev/null").unwrap();
        sendmsg::<()>(
            sender.as_raw_fd(),
            &[IoSlice::new(b"[]")],
            &[ControlMessage::ScmRights(&[
                file.as_raw_fd(),
                file.as_raw_fd(),
            ])],
            MsgFlags::empty(),
            None,
        )
        .unwrap();
        assert!(handshake(&peer).is_err());
    }

    /// A UFFD registered over 16 KiB of fresh anonymous memory, and the
    /// VMM end of the handshake socket, as Firecracker would send them.
    fn registered_memory() -> (OwnedFd, MmapMut, UnixStream, UnixStream) {
        use nix::sys::socket::{ControlMessage, sendmsg};
        use std::io::IoSlice;
        // SAFETY: standard Linux UFFD syscall with nonblocking and CLOEXEC flags.
        let raw = unsafe {
            libc::syscall(
                libc::SYS_userfaultfd,
                libc::O_CLOEXEC | libc::O_NONBLOCK | 1,
            )
        };
        assert!(raw >= 0, "UFFD unavailable: {}", io::Error::last_os_error());
        // SAFETY: successful syscall returned a new owned FD.
        let fd = unsafe { OwnedFd::from_raw_fd(i32::try_from(raw).unwrap()) };
        let mut api = [0xaa_u64, (1 << 3) | (1 << 6), 0];
        // SAFETY: three u64s match uffdio_api; features request REMOVE and UNMAP.
        assert_eq!(
            unsafe { libc::ioctl(fd.as_raw_fd(), 0xc018_aa3f, api.as_mut_ptr()) },
            0
        );
        let memory = MmapMut::map_anon(16384).unwrap();
        let mut register = [memory.as_ptr() as u64, 16384, 1, 0];
        // SAFETY: four u64s match uffdio_register with a live anonymous mapping.
        assert_eq!(
            unsafe { libc::ioctl(fd.as_raw_fd(), 0xc020_aa00, register.as_mut_ptr()) },
            0
        );
        let (peer, sender) = UnixStream::pair().unwrap();
        let mapping = vec![Mapping {
            base_host_virt_addr: memory.as_ptr() as u64,
            size: 16384,
            offset: 0,
            page_size: 4096,
            page_size_kib: 4096,
        }];
        let data = serde_json::to_vec(&mapping).unwrap();
        sendmsg::<()>(
            sender.as_raw_fd(),
            &[IoSlice::new(&data)],
            &[ControlMessage::ScmRights(&[fd.as_raw_fd()])],
            MsgFlags::empty(),
            None,
        )
        .unwrap();
        (fd, memory, peer, sender)
    }

    fn image_file(byte: u8) -> File {
        use std::io::Write;
        // SAFETY: nul-terminated name, valid memfd flags.
        let raw = unsafe { libc::memfd_create(c"pager-test".as_ptr(), libc::MFD_CLOEXEC) };
        assert!(raw >= 0);
        // SAFETY: memfd_create returned a new owned FD.
        let mut file = unsafe { File::from_raw_fd(raw) };
        file.write_all(&[byte; 16384]).unwrap();
        file
    }

    fn live_pager() -> (Pager<MappedFile>, MmapMut, UnixStream) {
        let (_fd, memory, peer, sender) = registered_memory();
        let image = image_file(0x5a);
        // SAFETY: the image is private to this test and never changed.
        let source = unsafe { MappedFile::new(&image) }.unwrap();
        let pager = Pager::new(peer, source, Duration::from_secs(60)).unwrap();
        (pager, memory, sender)
    }

    /// A source whose bytes arrive only when the test says so, signalled
    /// through an eventfd as a real remote source would.
    struct Delayed {
        bytes: Vec<u8>,
        arrived: bool,
        asked: Vec<(u64, bool)>,
        event: OwnedFd,
    }

    impl Delayed {
        fn new(fill: u8) -> Self {
            // SAFETY: eventfd with valid flags returns a new owned descriptor.
            let raw = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC | libc::EFD_NONBLOCK) };
            assert!(raw >= 0);
            Self {
                bytes: vec![fill; 16384],
                arrived: false,
                asked: Vec::new(),
                // SAFETY: eventfd returned a new owned descriptor.
                event: unsafe { OwnedFd::from_raw_fd(raw) },
            }
        }

        fn arrive(fd: RawFd) {
            let one = 1_u64.to_ne_bytes();
            // SAFETY: eight bytes to a valid eventfd.
            assert_eq!(unsafe { libc::write(fd, one.as_ptr().cast(), 8) }, 8);
        }
    }

    impl Source for Delayed {
        fn len(&self) -> u64 {
            self.bytes.len() as u64
        }

        fn get(&mut self, offset: u64, len: u64, urgent: bool) -> io::Result<Option<&[u8]>> {
            self.asked.push((offset, urgent));
            if !self.arrived {
                return Ok(None);
            }
            let start = usize::try_from(offset).unwrap();
            Ok(Some(
                &self.bytes[start..start + usize::try_from(len).unwrap()],
            ))
        }

        fn ready_fd(&self) -> Option<std::os::fd::BorrowedFd<'_>> {
            use std::os::fd::AsFd;
            Some(self.event.as_fd())
        }

        fn acknowledge(&mut self) -> io::Result<()> {
            let mut count = [0_u8; 8];
            // SAFETY: eight writable bytes from a valid eventfd.
            unsafe { libc::read(self.event.as_raw_fd(), count.as_mut_ptr().cast(), 8) };
            self.arrived = true;
            Ok(())
        }
    }

    /// Run with `cargo test -- --include-ignored` on a UFFD-enabled Linux host.
    #[test]
    #[ignore = "requires Linux userfaultfd permission"]
    fn kernel_partial_copy_existing_and_remove_zero_fill() {
        let (mut pager, memory, _sender) = live_pager();
        let plan = pager.layout.plan(&[0, 4096, 8192, 12288]).unwrap();
        let mut forged = plan[0];
        forged.index = usize::MAX;
        assert!(pager.prefetch(&[forged], 4096).is_err());
        pager.prefetch(&plan[1..2], 16384).unwrap();
        // Force the real partial-progress and EEXIST ioctl paths, not mocks.
        pager.state.fill(0);
        pager.prefetch(&plan, 16384).unwrap();
        assert!(memory.iter().all(|byte| *byte == 0x5a));
        assert_eq!(pager.stats.existing_pages, 1);
        std::thread::scope(|scope| {
            let discard = scope.spawn(|| {
                // SAFETY: live mapping, page-aligned range, valid advice.
                assert_eq!(
                    unsafe {
                        libc::madvise(
                            memory.as_ptr().cast_mut().cast(),
                            memory.len(),
                            libc::MADV_DONTNEED,
                        )
                    },
                    0
                );
            });
            let deadline = Instant::now() + Duration::from_secs(5);
            while pager.stats.remove_events == 0 {
                assert!(Instant::now() < deadline, "REMOVE notification timed out");
                pager.turn().unwrap();
                std::thread::yield_now();
            }
            discard.join().unwrap();
        });
        pager.prefetch(&plan, 16384).unwrap();
        assert!(memory.iter().all(|byte| *byte == 0));
        assert_eq!(pager.stats.zero_bytes, 16384);
        // Closing the last UFFD reference releases UNMAP monitoring before
        // this same thread drops its mapping; otherwise teardown waits on us.
        drop(pager);
    }

    #[test]
    #[ignore = "requires Linux userfaultfd permission"]
    fn kernel_demand_fault_and_unmap_retirement() {
        let (mut pager, memory, _sender) = live_pager();
        std::thread::scope(|scope| {
            let reader = scope.spawn(|| memory[0]);
            let deadline = Instant::now() + Duration::from_secs(5);
            while !reader.is_finished() {
                assert!(Instant::now() < deadline, "demand fault timed out");
                pager.turn().unwrap();
                std::thread::yield_now();
            }
            assert_eq!(reader.join().unwrap(), 0x5a);
        });
        assert_eq!(pager.profile("test".into()).offsets, vec![0]);
        std::thread::scope(|scope| {
            let unmapper = scope.spawn(move || drop(memory));
            let deadline = Instant::now() + Duration::from_secs(5);
            while pager.stats.unmap_events == 0 {
                assert!(Instant::now() < deadline, "UNMAP notification timed out");
                pager.turn().unwrap();
                std::thread::yield_now();
            }
            unmapper.join().unwrap();
        });
        let calls = pager.stats.copy_calls;
        let plan = pager.layout.plan(&[0, 4096, 8192, 12288]).unwrap();
        pager.prefetch(&plan, 16384).unwrap();
        assert_eq!(pager.stats.copy_calls, calls);
    }

    #[test]
    #[ignore = "requires Linux userfaultfd permission"]
    fn kernel_faults_wait_for_a_slow_source_without_blocking_the_pager() {
        let (fd, memory, peer, _sender) = registered_memory();
        let mut pager = Pager::new(peer, Delayed::new(0x33), Duration::from_secs(60)).unwrap();
        // Only the pager may hold the UFFD when the memory is unmapped, or the
        // unmap waits for someone to read its event.
        drop(fd);
        let event = pager.source().event.as_raw_fd();
        let plan = pager.layout.plan(&[8192, 12288]).unwrap();
        pager.queue_prefetch(&plan, 8192).unwrap();
        std::thread::scope(|scope| {
            let reader = scope.spawn(|| memory[4096]);
            let deadline = Instant::now() + Duration::from_secs(5);
            while pager.stats.parked_faults == 0 {
                assert!(Instant::now() < deadline, "fault never parked");
                pager.turn().unwrap();
                std::thread::yield_now();
            }
            // The demand fault asked urgently; prefetch asked as a batch.
            assert!(pager.source().asked.contains(&(4096, true)));
            assert!(pager.source().asked.contains(&(8192, false)));
            assert!(!reader.is_finished());
            Delayed::arrive(event);
            while !reader.is_finished() || !pager.prefetched() {
                assert!(Instant::now() < deadline, "parked work never resumed");
                pager.turn().unwrap();
                std::thread::yield_now();
            }
            assert_eq!(reader.join().unwrap(), 0x33);
        });
        assert!(memory[8192..].iter().all(|byte| *byte == 0x33));
        assert_eq!(pager.stats.prefetched_pages, 2);
        drop(pager);
    }

    #[test]
    #[ignore = "requires Linux userfaultfd permission"]
    fn kernel_the_wake_waits_only_for_the_gated_prefix() {
        let (mut pager, memory, _sender) = live_pager();
        let plan = pager.layout.plan(&[0, 4096, 8192, 12288]).unwrap();
        assert!(pager.ready(), "nothing queued, nothing to wait for");
        pager.queue_prefetch(&plan[..1], 4096).unwrap();
        pager.queue_background(&plan[1..]).unwrap();
        assert!(!pager.ready());
        // The gated page is copied first, in plan order; the tail is not
        // needed for the wake to go on.
        let deadline = Instant::now() + Duration::from_secs(5);
        while !pager.ready() {
            assert!(Instant::now() < deadline, "gated prefix never arrived");
            pager.turn().unwrap();
        }
        assert_eq!(memory[0], 0x5a);
        while !pager.prefetched() {
            assert!(Instant::now() < deadline, "background tail never arrived");
            pager.turn().unwrap();
        }
        assert!(memory.iter().all(|byte| *byte == 0x5a));
        assert_eq!(pager.stats.prefetched_pages, 4);
        let mut forged = plan[0];
        forged.index = usize::MAX;
        assert!(pager.queue_background(&[forged]).is_err());
        drop(pager);
    }

    #[test]
    #[ignore = "requires Linux userfaultfd permission"]
    fn kernel_a_new_pager_takes_over_a_fault_its_predecessor_dropped() {
        // `fd` stands for the VMM's own reference to its UFFD.
        let (fd, memory, peer, _sender) = registered_memory();
        // Declared after `memory`, so it is released first even when a
        // failed assertion unwinds; otherwise the unmap waits for an UNMAP
        // reader forever.
        let vmm_uffd = fd;
        let image = image_file(0x5a);
        // SAFETY: the image is private to this test and never changed.
        let source = unsafe { MappedFile::new(&image) }.unwrap();
        let mut first = Pager::new(peer, source, Duration::from_secs(60)).unwrap();
        let regions = first.layout().regions().to_vec();
        std::thread::scope(|scope| {
            // The first pager serves one fault in full...
            let served = scope.spawn(|| memory[0]);
            let deadline = Instant::now() + Duration::from_secs(5);
            while !served.is_finished() {
                assert!(Instant::now() < deadline, "first fault never served");
                first.turn().unwrap();
                std::thread::yield_now();
            }
            assert_eq!(served.join().unwrap(), 0x5a);
            // ...then reads another and goes without serving it.
            let reader = scope.spawn(|| memory[4096]);
            while first.faults.is_empty() {
                assert!(Instant::now() < deadline, "fault never arrived");
                first.drain_events().unwrap();
                std::thread::yield_now();
            }
            drop(first);
            std::thread::sleep(Duration::from_millis(50));
            assert!(
                !reader.is_finished(),
                "a fault without a handler waits rather than reading zeros"
            );
            // SAFETY: pidfd_open of this very process, without flags.
            let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0) };
            assert!(raw >= 0, "{}", io::Error::last_os_error());
            // SAFETY: pidfd_open returned a new owned descriptor.
            let pidfd = unsafe { OwnedFd::from_raw_fd(i32::try_from(raw).unwrap()) };
            // SAFETY: as above.
            let source = unsafe { MappedFile::new(&image) }.unwrap();
            let uffd = vmm_uffd.try_clone().unwrap();
            let mut second =
                Pager::adopt(uffd, regions, pidfd, source, Duration::from_secs(60)).unwrap();
            while !reader.is_finished() {
                assert!(
                    Instant::now() < deadline,
                    "the woken fault was never served"
                );
                second.turn().unwrap();
                std::thread::yield_now();
            }
            assert_eq!(reader.join().unwrap(), 0x5a);
            // The page the first pager put in place counts as done.
            let plan = second.layout.plan(&[0, 4096, 8192, 12288]).unwrap();
            second.prefetch(&plan, 4096).unwrap();
            assert_eq!(second.stats.existing_pages, 1);
            assert!(!second.wait(Duration::ZERO).unwrap(), "the VMM is alive");
            drop(second);
        });
        assert!(memory.iter().all(|byte| *byte == 0x5a));
    }
}
