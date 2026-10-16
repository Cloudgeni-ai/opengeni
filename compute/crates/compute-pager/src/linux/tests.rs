use super::*;
use crate::source::MappedFile;
use std::fs::File;
use std::io::Write;
use std::os::unix::fs::FileExt;

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
fn kernel_a_finished_pager_leaves_the_memory_to_the_kernel() {
    let (fd, mut memory, peer, _sender) = registered_memory();
    // Declared after `memory`, so it is released first even when a failed
    // assertion unwinds; otherwise the unmap waits for an UNMAP reader.
    let _vmm_uffd = fd;
    // An image whose third page is all zeros.
    let image = image_file(0x5a);
    image.write_all_at(&[0; 4096], 8192).unwrap();
    // SAFETY: the image is private to this test and never changed.
    let source = unsafe { MappedFile::new(&image) }.unwrap();
    let (answer, answering) = Answer::new();
    answering.answer();
    let mut pager = Pager::new(peer, source, Duration::ZERO)
        .unwrap()
        .finish_when_complete(Box::new(answer));
    let settled = std::sync::atomic::AtomicBool::new(false);
    pager
        .run(&AtomicBool::new(false), |progress| {
            if let Progress::Settled = progress {
                settled.store(true, Ordering::Relaxed);
            }
        })
        .unwrap();
    assert!(settled.load(Ordering::Relaxed), "run ended before settling");
    assert_eq!(pager.stats.zero_pages, 1);
    assert_eq!(pager.stats.prefetched_pages, 3);
    // No pager serves this memory any more: the copied pages are in place,
    // the zero page comes from the kernel, and a discarded page reads as
    // zeros without a REMOVE event anyone has to read.
    drop(pager);
    assert!(memory[..8192].iter().all(|byte| *byte == 0x5a));
    assert!(memory[8192..12288].iter().all(|byte| *byte == 0));
    assert!(memory[12288..].iter().all(|byte| *byte == 0x5a));
    // SAFETY: live mapping, page-aligned range, valid advice.
    assert_eq!(
        unsafe { libc::madvise(memory.as_mut_ptr().cast(), 4096, libc::MADV_DONTNEED) },
        0
    );
    assert!(memory[..4096].iter().all(|byte| *byte == 0));
    memory[4096] = 7;
    assert_eq!(memory[4096], 7);
}

#[test]
#[ignore = "requires Linux userfaultfd permission"]
fn kernel_a_pager_does_not_finish_before_its_source_is_complete() {
    let (fd, _memory, peer, _sender) = registered_memory();
    let _vmm_uffd = fd;
    let (answer, answering) = Answer::new();
    answering.answer();
    let mut pager = Pager::new(peer, Delayed::new(3), Duration::ZERO)
        .unwrap()
        .finish_when_complete(Box::new(answer));
    let stopped = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let timer = scope.spawn(|| {
            std::thread::sleep(Duration::from_millis(300));
            stopped.store(true, Ordering::Relaxed);
        });
        let mut settled = false;
        pager
            .run(&stopped, |progress| {
                settled |= matches!(progress, Progress::Settled);
            })
            .unwrap();
        timer.join().unwrap();
        assert!(!settled, "a pager missing bytes settled");
    });
    assert_eq!(pager.stats.copied_bytes, 0);
}

/// A [`Quiesce`] the test answers when it likes.
#[derive(Debug)]
struct Answer(UnixStream);

/// The test's end of an [`Answer`].
struct Answering(UnixStream);

impl Answer {
    fn new() -> (Self, Answering) {
        let (ours, theirs) = UnixStream::pair().unwrap();
        ours.set_nonblocking(true).unwrap();
        (Self(ours), Answering(theirs))
    }
}

impl Answering {
    fn answer(&self) {
        (&self.0).write_all(&[1]).unwrap();
    }
}

impl Quiesce for Answer {
    fn ask(&mut self) -> io::Result<RawFd> {
        Ok(self.0.as_raw_fd())
    }

    fn answered(&mut self) -> io::Result<bool> {
        let mut byte = [0_u8; 1];
        match (&self.0).read(&mut byte) {
            Ok(1) => Ok(true),
            Ok(_) => Err(io::ErrorKind::UnexpectedEof.into()),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(false),
            Err(error) => Err(error),
        }
    }
}

#[test]
#[ignore = "requires Linux userfaultfd permission"]
fn kernel_a_finished_pager_exits_only_once_the_vmm_has_answered() {
    let (fd, memory, peer, _sender) = registered_memory();
    let _vmm_uffd = fd;
    let image = image_file(0x5a);
    // SAFETY: the image is private to this test and never changed.
    let source = unsafe { MappedFile::new(&image) }.unwrap();
    let (answer, answering) = Answer::new();
    let mut pager = Pager::new(peer, source, Duration::ZERO)
        .unwrap()
        .finish_when_complete(Box::new(answer));
    let settled_at = std::sync::Mutex::new(None);
    let answered_at = std::thread::scope(|scope| {
        let answered = scope.spawn(|| {
            std::thread::sleep(Duration::from_millis(400));
            let at = Instant::now();
            answering.answer();
            at
        });
        pager
            .run(&AtomicBool::new(false), |progress| {
                if let Progress::Settled = progress {
                    *settled_at.lock().unwrap() = Some(Instant::now());
                }
            })
            .unwrap();
        answered.join().unwrap()
    });
    let settled_at = settled_at.lock().unwrap().expect("the pager settled");
    assert!(settled_at >= answered_at, "settled before the VMM answered");
    // The memory was unregistered before the answer was asked for.
    assert!(memory.iter().all(|byte| *byte == 0x5a));
}
