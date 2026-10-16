//! The pager as a process of its own, against a stand-in VMM (this test
//! process, with a real userfaultfd) and stand-in host agents that are real
//! processes, killed with SIGKILL.
//!
//! Run with `cargo test -- --include-ignored` as a user allowed to create a
//! userfaultfd (root, or `vm.unprivileged_userfaultfd = 1`).

#![cfg(target_os = "linux")]

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use compute_pager::Mapping;
use compute_pager::control::{self, ToHost, ToPager};
use memmap2::MmapMut;

const PAGE: usize = 4096;
const PAGES: usize = 16;
const LEN: usize = PAGE * PAGES;
/// The page the image holds zeros for.
const ZERO_PAGE: usize = 5;

/// The image's byte for page `page`.
fn pattern(page: usize) -> u8 {
    if page == ZERO_PAGE {
        0
    } else {
        u8::try_from(page + 1).unwrap()
    }
}

/// A UFFD over fresh anonymous memory, registered for missing pages with
/// REMOVE and UNMAP events, as Firecracker sets it up.
fn registered() -> (OwnedFd, MmapMut) {
    // SAFETY: the userfaultfd syscall with valid flags.
    let raw = unsafe {
        libc::syscall(
            libc::SYS_userfaultfd,
            libc::O_CLOEXEC | libc::O_NONBLOCK | 1,
        )
    };
    assert!(raw >= 0, "{}", std::io::Error::last_os_error());
    // SAFETY: a new descriptor the syscall returned.
    let fd = unsafe { OwnedFd::from_raw_fd(i32::try_from(raw).unwrap()) };
    let mut api = [0xaa_u64, (1 << 3) | (1 << 6), 0];
    // SAFETY: three u64s match uffdio_api.
    assert_eq!(
        unsafe { libc::ioctl(fd.as_raw_fd(), 0xc018_aa3f, api.as_mut_ptr()) },
        0
    );
    let memory = MmapMut::map_anon(LEN).unwrap();
    let mut register = [memory.as_ptr() as u64, LEN as u64, 1, 0];
    // SAFETY: four u64s match uffdio_register over a live mapping.
    assert_eq!(
        unsafe { libc::ioctl(fd.as_raw_fd(), 0xc020_aa00, register.as_mut_ptr()) },
        0
    );
    (fd, memory)
}

/// Connects to the pager's VMM socket and hands over `uffd` with the
/// memory layout, as Firecracker's handshake does.
fn handshake(socket: &Path, uffd: &OwnedFd, memory: &MmapMut) -> UnixStream {
    use nix::sys::socket::{ControlMessage, MsgFlags, sendmsg};
    let stream = UnixStream::connect(socket).unwrap();
    let mapping = vec![Mapping {
        base_host_virt_addr: memory.as_ptr() as u64,
        size: LEN as u64,
        offset: 0,
        page_size: PAGE as u64,
        page_size_kib: PAGE as u64,
    }];
    let data = serde_json::to_vec(&mapping).unwrap();
    sendmsg::<()>(
        stream.as_raw_fd(),
        &[std::io::IoSlice::new(&data)],
        &[ControlMessage::ScmRights(&[uffd.as_raw_fd()])],
        MsgFlags::empty(),
        None,
    )
    .unwrap();
    stream
}

/// Reads a byte of guest memory on a thread of its own, since the read may
/// wait for the pager.
fn read_later(memory: &MmapMut, at: usize) -> std::thread::JoinHandle<u8> {
    let address = memory.as_ptr() as usize + at;
    std::thread::spawn(move || {
        // SAFETY: the mapping outlives every reader (the test joins them
        // before unmapping), and a volatile read keeps the access.
        unsafe { std::ptr::read_volatile(address as *const u8) }
    })
}

fn joined(reader: std::thread::JoinHandle<u8>, what: &str) -> u8 {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !reader.is_finished() {
        assert!(Instant::now() < deadline, "{what} never completed");
        std::thread::sleep(Duration::from_millis(5));
    }
    reader.join().unwrap()
}

/// Discards one page of guest memory, as a guest returning free pages does.
fn discard(memory: &MmapMut, page: usize) {
    // SAFETY: a page-aligned range inside a live mapping, valid advice.
    let result = unsafe {
        libc::madvise(
            memory.as_ptr().add(page * PAGE).cast_mut().cast(),
            PAGE,
            libc::MADV_DONTNEED,
        )
    };
    assert_eq!(result, 0, "{}", std::io::Error::last_os_error());
}

/// Starts a stand-in host agent: this test binary, running [`agent`].
fn start_agent(control: &Path, pages: std::ops::Range<usize>) -> Child {
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "agent", "--nocapture", "--include-ignored"])
        .env("PAGER_TEST_CONTROL", control)
        .env("PAGER_TEST_FILL", format!("{}-{}", pages.start, pages.end))
        .stdout(Stdio::piped())
        .spawn()
        .unwrap()
}

/// The stand-in host agent's body; does nothing in a normal test run. It
/// connects, checks the greeting and says pages `PAGER_TEST_FILL` are
/// filled, then waits for the pager to finish, printing `done` if it does.
/// (The test wrote the whole file up front, which a real agent never does
/// for bytes it has not announced; the pager reads only what was.)
#[test]
fn agent() {
    let Some(control) = std::env::var_os("PAGER_TEST_CONTROL") else {
        return;
    };
    let fill = std::env::var("PAGER_TEST_FILL").unwrap();
    let (first, last) = fill.split_once('-').unwrap();
    let (first, last): (usize, usize) = (first.parse().unwrap(), last.parse().unwrap());
    let stream = UnixStream::connect(control).unwrap();
    let mut lines = BufReader::new(stream.try_clone().unwrap());
    let mut line = Vec::new();
    lines.read_until(b'\n', &mut line).unwrap();
    let ToHost::Hello { tag, missing, .. } = control::parse(&line).unwrap() else {
        panic!("no greeting");
    };
    assert_eq!(tag, "image-1");
    println!("missing={missing:?}");
    let filled = ToPager::Filled {
        ranges: vec![((first * PAGE) as u64, (last * PAGE) as u64)],
    };
    (&stream)
        .write_all(&control::line(&filled).unwrap())
        .unwrap();
    loop {
        line.clear();
        if lines.read_until(b'\n', &mut line).unwrap() == 0 {
            return;
        }
        if control::parse::<ToHost>(&line).unwrap() == ToHost::Done {
            println!("done");
            return;
        }
    }
}

/// Whether this process has memory registered with a userfaultfd.
fn registered_anywhere() -> bool {
    fs::read_to_string("/proc/self/smaps")
        .unwrap()
        .lines()
        .filter_map(|line| line.strip_prefix("VmFlags:"))
        .any(|flags| flags.split_whitespace().any(|flag| flag == "um"))
}

/// Stands in for the VMM's API: answers every request with 200, from a
/// thread of this process, which issues the stand-in VMM's discards.
fn api(path: &Path) {
    let listener = std::os::unix::net::UnixListener::bind(path).unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut request = Vec::new();
            let mut buffer = [0_u8; 256];
            while !request.ends_with(b"\r\n\r\n") {
                match stream.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => request.extend_from_slice(&buffer[..count]),
                }
            }
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
        }
    });
}

#[test]
#[ignore = "requires Linux userfaultfd permission"]
fn discards_survive_the_agent_and_a_finished_pager_leaves() {
    let dir = tempfile::tempdir().unwrap();
    let image = dir.path().join("memory");
    let bytes: Vec<u8> = (0..PAGES).flat_map(|page| [pattern(page); PAGE]).collect();
    fs::write(&image, &bytes).unwrap();
    let (vmm_socket, control) = (dir.path().join("uffd.sock"), dir.path().join("pager.sock"));
    let api_socket = dir.path().join("api.sock");
    api(&api_socket);
    let mut pager = Command::new(env!("CARGO_BIN_EXE_compute-pager"))
        .arg("serve")
        .args(["--vmm-socket".as_ref(), vmm_socket.as_os_str()])
        .args(["--api-socket".as_ref(), api_socket.as_os_str()])
        .args(["--control".as_ref(), control.as_os_str()])
        .args(["--memory".as_ref(), image.as_os_str()])
        .args(["--tag", "image-1", "--ready-bytes", "0", "--record-ms", "0"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut ready = String::new();
    BufReader::new(pager.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    assert_eq!(ready, "ready\n");
    let (uffd, memory) = registered();
    // `vmm_uffd` stands for the VMM's own reference, which Firecracker
    // keeps; declared after `memory`, it is closed first, so the unmap at
    // the end never waits for an event reader.
    let vmm_uffd = uffd;
    let _vmm = handshake(&vmm_socket, &vmm_uffd, &memory);

    // The first agent fills the first half; the guest reads from it.
    let mut first = start_agent(&control, 0..PAGES / 2);
    assert_eq!(joined(read_later(&memory, PAGE), "first read"), pattern(1));
    // The guest discards that page; the madvise returns only once the
    // pager has read the REMOVE event.
    discard(&memory, 1);
    // The agent dies at once. Nothing the guest's memory depends on was
    // in it.
    first.kill().unwrap();
    first.wait().unwrap();
    // The discarded page reads as zeros, not as the image's bytes.
    assert_eq!(joined(read_later(&memory, PAGE), "discarded read"), 0);
    // A page nobody has filled waits for an agent rather than reading
    // anything.
    let waiting = read_later(&memory, 10 * PAGE);
    std::thread::sleep(Duration::from_millis(300));
    assert!(!waiting.is_finished(), "a missing page did not wait");

    // The next agent learns what is missing and fills it.
    let mut second = start_agent(&control, PAGES / 2..PAGES);
    assert_eq!(joined(waiting, "waiting read"), pattern(10));
    let mut said = String::new();
    second
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut said)
        .unwrap();
    assert!(second.wait().unwrap().success());
    let missing = [((PAGES / 2 * PAGE) as u64, LEN as u64)];
    assert!(said.contains(&format!("missing={missing:?}")), "{said}");
    assert!(said.contains("done"), "{said}");
    // The pager settled every page, unregistered the memory and left.
    assert!(pager.wait().unwrap().success());
    assert!(!registered_anywhere(), "memory still registered");
    for page in 0..PAGES {
        let expected = if page == 1 { 0 } else { pattern(page) };
        assert!(
            memory[page * PAGE..(page + 1) * PAGE]
                .iter()
                .all(|byte| *byte == expected),
            "page {page}"
        );
    }
    // With no pager left, a discard needs nobody and reads as zeros.
    discard(&memory, 2);
    assert_eq!(memory[2 * PAGE], 0);
    drop(vmm_uffd);
}

#[test]
#[ignore = "requires Linux userfaultfd permission"]
fn a_discard_nobody_reads_shows_in_its_wait_channel() {
    let (uffd, memory) = registered();
    let address = memory.as_ptr() as usize;
    let (told, tid) = std::sync::mpsc::channel();
    let discarding = std::thread::spawn(move || {
        // SAFETY: gettid has no preconditions.
        told.send(unsafe { libc::gettid() }).unwrap();
        // SAFETY: a page of a live mapping the test keeps until it joins.
        unsafe { libc::madvise(address as *mut libc::c_void, PAGE, libc::MADV_DONTNEED) }
    });
    let tid = tid.recv().unwrap();
    let started = Instant::now();
    let wchan = loop {
        let wchan = fs::read_to_string(format!("/proc/self/task/{tid}/wchan")).unwrap_or_default();
        if wchan.contains("userfault") || started.elapsed() > Duration::from_secs(5) {
            break wchan;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(
        !discarding.is_finished(),
        "the discard did not wait for a reader"
    );
    // What the engine looks for in a VMM whose pager died mid-discard.
    assert!(wchan.contains("userfault"), "wait channel {wchan:?}");
    // Reading the event lets the discard finish.
    let mut event = [0_u8; 32];
    let read = loop {
        // SAFETY: a valid buffer for the event; the descriptor stays open.
        let count = unsafe { libc::read(uffd.as_raw_fd(), event.as_mut_ptr().cast(), event.len()) };
        if count == 32 || started.elapsed() > Duration::from_secs(10) {
            break count;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(read, 32);
    assert_eq!(discarding.join().unwrap(), 0);
    // The descriptor goes first, so unmapping waits for nobody.
    drop(uffd);
    drop(memory);
}
