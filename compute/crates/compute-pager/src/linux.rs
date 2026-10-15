//! Linux UFFD transport and serialized pager. The owner must keep the snapshot
//! immutable and supervise both the pager and VMM: a dead pager stalls the VM.

use crate::{Layout, Mapping, Page, Profile};
use memmap2::{Mmap, MmapMut, MmapOptions};
use nix::sys::socket::{ControlMessageOwned, MsgFlags, recvmsg};
use serde::Serialize;
use std::{
    collections::VecDeque,
    fs::File,
    io::{self, IoSliceMut, Read},
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
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
    let a = u64::from_ne_bytes(bytes[8..16].try_into().expect("fixed slice"));
    let b = u64::from_ne_bytes(bytes[16..24].try_into().expect("fixed slice"));
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
#[derive(Default, Debug, Serialize)]
pub struct Stats {
    pub faults: u64,
    pub copy_calls: u64,
    pub copied_bytes: u64,
    pub zero_bytes: u64,
    pub existing_pages: u64,
    pub retry_events: u64,
    pub remove_events: u64,
    pub unmap_events: u64,
    pub prefetch_ms: f64,
}

/// One snapshot and UFFD. No global runtime or thread pool is required.
#[derive(Debug)]
pub struct Pager {
    fd: OwnedFd,
    // Keep the stream alive; its HUP signals VMM exit, unlike the shared UFFD.
    peer: UnixStream,
    source: Mmap,
    zero: MmapMut,
    layout: Layout,
    state: Vec<u8>,
    trace: Vec<u64>,
    pending: VecDeque<u64>,
    started: Instant,
    record_for: Duration,
    pub stats: Stats,
}

impl Pager {
    #[must_use]
    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    /// # Safety
    /// The file must not be modified or truncated while this pager is alive.
    pub unsafe fn new(peer: UnixStream, snapshot: &File, record_for: Duration) -> io::Result<Self> {
        peer.set_read_timeout(Some(Duration::from_secs(10)))?;
        let (fd, regions) = handshake(&peer)?;
        let layout = Layout::new(regions, snapshot.metadata()?.len())?;
        // SAFETY: the caller guarantees an immutable snapshot for the map lifetime.
        let source = unsafe { MmapOptions::new().map(snapshot)? };
        let zero = MmapMut::map_anon(2_097_152)?;
        let state = vec![0; layout.page_count()];
        Ok(Self {
            fd,
            peer,
            source,
            zero,
            layout,
            state,
            trace: Vec::new(),
            pending: VecDeque::new(),
            started: Instant::now(),
            record_for,
            stats: Stats::default(),
        })
    }

    #[must_use]
    pub fn profile(&self, snapshot_id: String) -> Profile {
        Profile {
            version: 1,
            snapshot_id,
            offsets: self.trace.clone(),
        }
    }

    fn read_event(&self) -> io::Result<Option<Event>> {
        let mut bytes = [0_u8; 32];
        // SAFETY: valid writable buffer; fd remains owned for the call.
        let count =
            unsafe { libc::read(self.fd.as_raw_fd(), bytes.as_mut_ptr().cast(), bytes.len()) };
        if count == 32 {
            return decode(&bytes).map(Some);
        }
        if count == -1 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::WouldBlock {
                return Ok(None);
            }
            if error.kind() == io::ErrorKind::Interrupted {
                return self.read_event();
            }
            return Err(error);
        }
        Err(invalid("short UFFD event read"))
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

    /// Drain notifications before copying. REMOVE invalidates snapshot content
    /// permanently, whereas UNMAP retires the destination and forbids copying.
    pub fn service_pending(&mut self) -> io::Result<()> {
        while let Some(event) = self.read_event()? {
            match event {
                Event::Fault(address) => {
                    self.stats.faults += 1;
                    self.pending.push_back(address);
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
        while let Some(address) = self.pending.pop_front() {
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
            if self.copy(page, 1)? == 0 {
                self.pending.push_front(address);
                break;
            }
        }
        Ok(())
    }

    fn copy(&mut self, page: Page, pages: usize) -> io::Result<usize> {
        let zero = self.state[page.index] & REMOVED != 0;
        let length = page.size * u64::try_from(pages).map_err(|_| invalid("batch overflow"))?;
        let source = if zero {
            self.zero.as_ptr()
        } else {
            let offset = usize::try_from(page.offset).map_err(|_| invalid("offset overflow"))?;
            self.source[offset..].as_ptr()
        };
        let mut range = CopyRange {
            dst: page.address,
            src: source as u64,
            len: length,
            ..CopyRange::default()
        };
        self.stats.copy_calls += 1;
        // SAFETY: the UAPI structure is repr(C); layout and batching validate
        // the destination and mapped source bounds. The kernel validates the FD.
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
            return Ok(done);
        }
        if result < 0 {
            let error = io::Error::last_os_error();
            // A mapping-changing event raced the copy. Read it before retrying
            // so REMOVE can replace the snapshot source with zero contents.
            if matches!(
                error.raw_os_error(),
                Some(libc::EAGAIN | libc::EINTR | libc::ENOENT)
            ) {
                self.stats.retry_events += 1;
                return Ok(0);
            }
            if error.raw_os_error() == Some(libc::EEXIST) {
                self.state[page.index] |= PRESENT;
                self.stats.existing_pages += 1;
                let mut range = [page.address, page.size];
                // SAFETY: repr-compatible uffdio_range; valid registered page.
                if unsafe { libc::ioctl(self.fd.as_raw_fd(), WAKE, range.as_mut_ptr()) } < 0 {
                    return Err(io::Error::last_os_error());
                }
                return Ok(1);
            }
            return Err(error);
        }
        Err(invalid("UFFD copy made no progress"))
    }

    /// Bulk-copy contiguous profile runs, bounded by `max_batch` bytes. Demand
    /// faults and discard events take priority at each batch boundary.
    pub fn prefetch(&mut self, pages: &[Page], max_batch: u64) -> io::Result<()> {
        let started = Instant::now();
        let mut cursor = 0;
        while cursor < pages.len() {
            self.service_pending()?;
            let first = pages[cursor];
            // Revalidate public Page inputs rather than trusting caller indices.
            if self.layout.offset(first.offset) != Some(first) {
                return Err(invalid("invalid prefetch page"));
            }
            let region_end = self
                .layout
                .region_end(first.address)
                .ok_or_else(|| invalid("invalid prefetch region"))?;
            if self.state[first.index] & (PRESENT | UNMAPPED) != 0 {
                cursor += 1;
                continue;
            }
            let mut count = 1;
            while self.state[first.index] & REMOVED == 0 && cursor + count < pages.len() {
                let next = pages[cursor + count];
                let distance =
                    u64::try_from(count).map_err(|_| invalid("batch overflow"))? * first.size;
                if distance + first.size > max_batch
                    || distance + first.size > region_end - first.address
                    || next.address != first.address + distance
                    || next.offset != first.offset + distance
                    || next.size != first.size
                    || next.index != first.index + count
                    || self.layout.offset(next.offset) != Some(next)
                    || self.state[next.index] & (PRESENT | REMOVED | UNMAPPED) != 0
                {
                    break;
                }
                count += 1;
            }
            cursor += self.copy(first, count)?;
        }
        self.stats.prefetch_ms += started.elapsed().as_secs_f64() * 1000.0;
        Ok(())
    }

    /// Service until cancellation or VMM disconnect. Intended for a dedicated
    /// thread (or Tokio `spawn_blocking`), never an async executor's poll thread.
    pub fn run(&mut self, stopped: &AtomicBool) -> io::Result<()> {
        while !stopped.load(Ordering::Relaxed) {
            if let Err(error) = self.service_pending() {
                // The VMM can disappear between the last peer poll and COPY.
                // ESRCH means its mm no longer exists, not a paging failure.
                if error.raw_os_error() == Some(libc::ESRCH) {
                    return Ok(());
                }
                return Err(error);
            }
            let mut poll = [
                libc::pollfd {
                    fd: self.fd.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: self.peer.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            // SAFETY: valid pollfd array with the matching element count.
            let result = unsafe {
                libc::poll(
                    poll.as_mut_ptr(),
                    2,
                    if self.pending.is_empty() { 100 } else { 1 },
                )
            };
            if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                return Err(io::Error::last_os_error());
            }
            if poll[1].revents & libc::POLLHUP != 0 {
                return Ok(());
            }
            if poll[0].revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
                return Err(invalid("UFFD disconnected"));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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

    fn live_pager() -> (Pager, MmapMut, UnixStream) {
        use nix::sys::socket::{ControlMessage, sendmsg};
        use std::io::{IoSlice, Write};
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
        // SAFETY: nul-terminated name, valid memfd flags.
        let raw_source = unsafe { libc::memfd_create(c"pager-test".as_ptr(), libc::MFD_CLOEXEC) };
        assert!(raw_source >= 0);
        // SAFETY: memfd_create returned a new owned FD.
        let mut source = unsafe { File::from_raw_fd(raw_source) };
        source.write_all(&vec![0x5a; 16384]).unwrap();
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
        // SAFETY: source is private to this test and never changed after mapping.
        let pager = unsafe { Pager::new(peer, &source, Duration::from_secs(60)) }.unwrap();
        (pager, memory, sender)
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
                pager.service_pending().unwrap();
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
                pager.service_pending().unwrap();
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
                pager.service_pending().unwrap();
                std::thread::yield_now();
            }
            unmapper.join().unwrap();
        });
        let calls = pager.stats.copy_calls;
        let plan = pager.layout.plan(&[0, 4096, 8192, 12288]).unwrap();
        pager.prefetch(&plan, 16384).unwrap();
        assert_eq!(pager.stats.copy_calls, calls);
    }
}
