//! Linux UFFD transport and serialized pager. The owner must keep the image
//! immutable and supervise both the pager and VMM: a dead pager stalls the VM.
//!
//! [`serve`] runs a pager as a process of its own, one per VM, so the VM's
//! memory never depends on the host agent that started it.

pub mod serve;

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
const UNREGISTER: libc::c_ulong = 0x8010_aa01;
const PRESENT: u8 = 1;
const REMOVED: u8 = 2;
const UNMAPPED: u8 = 4;
const RECORDED: u8 = 8;
/// Queued for prefetch and waiting on the source.
const WAITING: u8 = 16;
/// Never copied in because the image holds zeros there: once the range is
/// unregistered, the kernel's own zero page serves it.
const ZERO: u8 = 32;
/// Needs nothing more from the pager.
const SETTLED: u8 = PRESENT | REMOVED | UNMAPPED | ZERO;
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
    /// Pages left to the kernel's zero page rather than copied.
    pub zero_pages: u64,
    /// Time from the pager starting to every page being settled.
    pub settled_ms: f64,
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
    /// Every page is in place and the guest's memory is no longer
    /// registered with the UFFD (see [`Pager::finish_when_complete`]): the
    /// VM needs no pager any more, and [`Pager::run`] returns.
    Settled,
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

/// One memory image served to one VMM through its UFFD. A single owner
/// serializes demand faults, discard events and prefetch; nothing here
/// blocks on the source.
#[derive(Debug)]
pub struct Pager<S> {
    fd: OwnedFd,
    /// The socket the VMM's handshake arrived on, which hangs up when the
    /// VMM exits. The UFFD cannot say: the VMM shares it with the pager.
    vmm: UnixStream,
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
    /// Whether to settle every page once the source is complete.
    finish: bool,
    /// Whether every unsettled page has been queued.
    completing: bool,
    pub stats: Stats,
}

impl<S: Source> Pager<S> {
    /// Completes the VMM's handshake on `peer` and serves its memory from
    /// `source`, recording the order the guest first touches pages for
    /// `record_for`.
    pub fn new(peer: UnixStream, source: S, record_for: Duration) -> io::Result<Self> {
        peer.set_read_timeout(Some(Duration::from_secs(10)))?;
        let (fd, regions) = handshake(&peer)?;
        let layout = Layout::new(regions, source.len())?;
        let zero = MmapMut::map_anon(usize::try_from(MAX_BATCH).map_err(|_| invalid("batch"))?)?;
        let state = vec![0; layout.page_count()];
        Ok(Self {
            fd,
            vmm: peer,
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
            finish: false,
            completing: false,
            stats: Stats::default(),
        })
    }

    /// Makes [`Pager::run`] bring every page of the image in once the
    /// source is complete and the first-touch recording window has closed,
    /// leaving zero pages to the kernel, then unregister the guest's
    /// memory from the UFFD and return with [`Progress::Settled`]. From
    /// then on the kernel serves the VM's memory on its own: a page the
    /// guest discards reads as zeros without anyone's help.
    #[must_use]
    pub fn finish_when_complete(mut self) -> Self {
        self.finish = true;
        self
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
            if self.state[index] & SETTLED == 0 {
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
            self.state[page.index] &= !(PRESENT | ZERO);
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
            if self.state[first.index] & (PRESENT | UNMAPPED | WAITING | ZERO) != 0 {
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
                    || self.state[next.index] & (SETTLED | WAITING) != 0
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
                fd: self.vmm.as_raw_fd(),
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
        Ok(poll[1].revents & libc::POLLHUP != 0)
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
            if self.finish && self.recorded {
                if !self.completing && self.source.complete() {
                    self.complete()?;
                }
                if self.completing && self.settled() {
                    self.stats.settled_ms = self.started.elapsed().as_secs_f64() * 1000.0;
                    self.unregister()?;
                    progress(Progress::Settled);
                    return Ok(());
                }
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

impl<S: Source> Pager<S> {
    /// Queues every page that is neither in place nor discarded, after
    /// everything already queued, except pages the image holds zeros for:
    /// those are left to the kernel's zero page. Call once the source is
    /// complete.
    fn complete(&mut self) -> io::Result<()> {
        self.completing = true;
        let regions = self.layout.regions().to_vec();
        for region in regions {
            let mut offset = region.offset;
            while offset < region.offset + region.size {
                let page = self
                    .layout
                    .offset(offset)
                    .ok_or_else(|| invalid("page outside the memory layout"))?;
                offset += region.page_size;
                if self.state[page.index] & (SETTLED | WAITING) != 0 {
                    continue;
                }
                let zero = matches!(
                    self.source.get(page.offset, page.size, false)?,
                    Some(bytes) if bytes.iter().all(|byte| *byte == 0)
                );
                if zero {
                    self.state[page.index] |= ZERO;
                    self.stats.zero_pages += 1;
                } else {
                    self.plan.push_back(page);
                }
            }
        }
        Ok(())
    }

    /// Whether nothing is left to do and every page is in place, discarded
    /// or zero in the image.
    fn settled(&self) -> bool {
        self.faults.is_empty()
            && self.parked.is_empty()
            && self.plan.is_empty()
            && self.waiting.is_empty()
            && self.state.iter().all(|state| state & SETTLED != 0)
    }

    /// Unregisters the guest's memory from the UFFD, which wakes any fault
    /// still waiting so the kernel serves it, then reads what events were
    /// already queued: a discard waits until its event is read, and the
    /// VMM keeps its own reference to the UFFD, so an unread one would hold
    /// the discarding VMM thread forever.
    fn unregister(&mut self) -> io::Result<()> {
        /// Events stop once nothing is registered; a discard that had
        /// already looked at the registration queues its event within
        /// moments, so the queue is read until it has been quiet this long.
        const QUIET: Duration = Duration::from_millis(250);
        for region in self.layout.regions() {
            let mut range = [region.base_host_virt_addr, region.size];
            // SAFETY: repr-compatible uffdio_range over a region the VMM
            // registered. Unregistering acts on the UFFD's own address
            // space, whichever process asks.
            if unsafe { libc::ioctl(self.fd.as_raw_fd(), UNREGISTER, range.as_mut_ptr()) } < 0 {
                let error = io::Error::last_os_error();
                // The VMM's address space is gone with it: nothing to do.
                if error.raw_os_error() == Some(libc::ESRCH) {
                    return Ok(());
                }
                return Err(error);
            }
        }
        let deadline = Instant::now() + QUIET * 8;
        while poll_in(self.fd.as_raw_fd(), QUIET)? && Instant::now() < deadline {
            while self.read_event()?.is_some() {}
        }
        Ok(())
    }
}

/// Waits up to `timeout` for `fd` to turn readable; returns whether it did.
fn poll_in(fd: RawFd, timeout: Duration) -> io::Result<bool> {
    Ok(poll(&[fd], timeout)?[0])
}

/// Waits up to `timeout` for any of `fds` to turn readable or hang up, and
/// says which did. Negative descriptors are ignored. An interrupted wait
/// reports every descriptor, which costs a look but misses nothing.
pub(crate) fn poll(fds: &[RawFd], timeout: Duration) -> io::Result<Vec<bool>> {
    let mut poll: Vec<libc::pollfd> = fds
        .iter()
        .map(|&fd| libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        })
        .collect();
    let millis = libc::c_int::try_from(timeout.as_millis()).unwrap_or(libc::c_int::MAX);
    let count = libc::nfds_t::try_from(poll.len()).map_err(|_| invalid("too many descriptors"))?;
    // SAFETY: a valid pollfd array and its element count.
    let result = unsafe { libc::poll(poll.as_mut_ptr(), count, millis) };
    if result < 0 {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            return Ok(fds.iter().map(|fd| *fd >= 0).collect());
        }
        return Err(error);
    }
    Ok(poll
        .iter()
        .map(|entry| entry.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0)
        .collect())
}

/// Whether `fd` is readable right now.
fn readable(fd: RawFd) -> io::Result<bool> {
    poll_in(fd, Duration::ZERO)
}

#[cfg(test)]
mod tests;
