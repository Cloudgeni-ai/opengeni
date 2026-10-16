//! A pager running as a process of its own, one per VM.
//!
//! The process owns the VM's userfaultfd and everything the kernel tells
//! it about the guest's memory: which pages are in place and which the
//! guest discarded. A discard is final the moment its event is read, so
//! that knowledge must live exactly as long as the VM does, which a
//! process beside the VM gives and a thread of the host agent does not.
//!
//! The host agent only fills the memory file. It connects to the control
//! socket ([`crate::control`]), learns what is still missing, fetches it and
//! says which ranges are filled; the pager asks for what a fault or the
//! prefetch needs first. If the agent goes away, faults on missing bytes
//! wait and the next agent reconnects; nothing the pager knows is lost.
//!
//! Once every byte is in the file and every page in the guest (zero pages
//! left to the kernel), the pager unregisters the guest's memory and exits:
//! a VM that has been awake for a while carries no pager at all.

use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use super::quiesce::AskVmm;
use super::user::User;
use super::{MAX_BATCH, Pager, Progress, poll};
use crate::control::{self, ToHost, ToPager};
use crate::source::{Fill, FilledFile};
use crate::wake::{WakeProfile, ready_prefix};

/// How long the VMM may take to connect after the pager listens.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a write to the host may block before the connection is given
/// up; the next host reconnects.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long an exiting pager waits to tell the host it is done.
const GOODBYE: Duration = Duration::from_secs(2);

/// What one pager process serves, as its command line says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Options {
    /// Where the VMM connects for its handshake.
    pub vmm_socket: PathBuf,
    /// Where the host agent connects to filling the image.
    pub control: PathBuf,
    /// The image's memory file.
    pub memory: PathBuf,
    /// The image's name, reported back to the host.
    pub tag: String,
    /// Whether the memory file is already complete (a local image).
    pub complete: bool,
    /// The order to prefetch in, learned by the previous wake.
    pub profile: Option<PathBuf>,
    /// Where to write the order this wake learns.
    pub learned: Option<PathBuf>,
    /// How much of the profile's front the wake waits for.
    pub ready_bytes: u64,
    /// How long first touches are recorded.
    pub record_for: Duration,
    /// The VMM's API socket, which a finishing pager asks before it exits
    /// (see [`super::quiesce`]). The engine adds it when it starts the
    /// pager; the pager does not run without it.
    pub api_socket: Option<PathBuf>,
    /// The VM's user, which the pager becomes once its sockets listen and
    /// it has read what it needs; see [`super::user`]. The engine adds it
    /// too. Without it the pager keeps the user it was started as.
    pub user: Option<User>,
}

impl Options {
    /// Parses the arguments after the subcommand.
    ///
    /// # Errors
    ///
    /// An argument is unknown, missing its value or invalid.
    pub fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Self, String> {
        let mut args = args.into_iter();
        let mut vmm_socket = None;
        let mut control = None;
        let mut memory = None;
        let mut tag = None;
        let mut options = Self {
            vmm_socket: PathBuf::new(),
            control: PathBuf::new(),
            memory: PathBuf::new(),
            tag: String::new(),
            complete: false,
            profile: None,
            learned: None,
            ready_bytes: 0,
            record_for: Duration::ZERO,
            api_socket: None,
            user: None,
        };
        while let Some(arg) = args.next() {
            let arg = arg.to_string_lossy().into_owned();
            if arg == "--complete" {
                options.complete = true;
                continue;
            }
            let value = args.next().ok_or_else(|| format!("{arg} needs a value"))?;
            let number = || {
                value
                    .to_str()
                    .and_then(|text| text.parse::<u64>().ok())
                    .ok_or_else(|| format!("{arg} needs a number"))
            };
            match arg.as_str() {
                "--vmm-socket" => vmm_socket = Some(PathBuf::from(&value)),
                "--control" => control = Some(PathBuf::from(&value)),
                "--memory" => memory = Some(PathBuf::from(&value)),
                "--tag" => tag = Some(value.to_string_lossy().into_owned()),
                "--profile" => options.profile = Some(PathBuf::from(&value)),
                "--learned" => options.learned = Some(PathBuf::from(&value)),
                "--api-socket" => options.api_socket = Some(PathBuf::from(&value)),
                "--user" => options.user = Some(value.to_string_lossy().parse()?),
                "--ready-bytes" => options.ready_bytes = number()?,
                "--record-ms" => options.record_for = Duration::from_millis(number()?),
                _ => return Err(format!("unknown argument {arg}")),
            }
        }
        options.vmm_socket = vmm_socket.ok_or("--vmm-socket is required")?;
        options.control = control.ok_or("--control is required")?;
        options.memory = memory.ok_or("--memory is required")?;
        options.tag = tag.ok_or("--tag is required")?;
        Ok(options)
    }

    /// The arguments [`Self::parse`] reads back as `self`.
    #[must_use]
    pub fn args(&self) -> Vec<OsString> {
        let mut args: Vec<OsString> = vec![
            "--vmm-socket".into(),
            self.vmm_socket.clone().into(),
            "--control".into(),
            self.control.clone().into(),
            "--memory".into(),
            self.memory.clone().into(),
            "--tag".into(),
            self.tag.clone().into(),
            "--ready-bytes".into(),
            self.ready_bytes.to_string().into(),
            "--record-ms".into(),
            self.record_for.as_millis().to_string().into(),
        ];
        if self.complete {
            args.push("--complete".into());
        }
        if let Some(user) = self.user {
            args.extend(["--user".into(), user.to_string().into()]);
        }
        for (name, path) in [
            ("--profile", &self.profile),
            ("--learned", &self.learned),
            ("--api-socket", &self.api_socket),
        ] {
            if let Some(path) = path {
                args.extend([name.into(), path.clone().into()]);
            }
        }
        args
    }
}

/// Runs a pager process with the arguments after the subcommand. It prints
/// `ready` on standard output once both sockets listen and never writes
/// there again; everything else goes to standard error.
#[must_use]
pub fn main(args: impl IntoIterator<Item = OsString>) -> ExitCode {
    let options = match Options::parse(args) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("pager: {error}");
            return ExitCode::from(2);
        }
    };
    match run(&options) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pager for image {}: {error}", options.tag);
            ExitCode::FAILURE
        }
    }
}

/// What the pager has reached, shared with the thread talking to the host.
#[derive(Debug, Default)]
struct Status {
    prefetched: AtomicBool,
    done: AtomicBool,
    /// Set when the pager's work has ended either way.
    ended: AtomicBool,
    /// Set once the host was told of `done`, or could not be.
    farewell: (Mutex<bool>, Condvar),
}

impl Status {
    fn said_goodbye(&self) {
        let (said, changed) = &self.farewell;
        *said
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
        changed.notify_all();
    }

    fn await_goodbye(&self, limit: Duration) {
        let (said, changed) = &self.farewell;
        let said = said
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _ = changed.wait_timeout_while(said, limit, |said| !*said);
    }
}

fn run(options: &Options) -> io::Result<()> {
    let api_socket = options.api_socket.clone().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "--api-socket is required: a pager cannot finish without it",
        )
    })?;
    let stopped = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&stopped))?;
    let file = File::open(&options.memory)?;
    let metadata = file.metadata()?;
    let filling = Arc::new(Fill::new(metadata.len(), options.complete)?);
    let profile = options
        .profile
        .as_deref()
        .map(WakeProfile::load)
        .unwrap_or_default();
    let prepared = Prepared {
        source: crate::source::filled(&file, Arc::clone(&filling))?,
        profile,
        quiesce: AskVmm::new(api_socket),
    };
    let (control, _control_file) = bind(&options.control)?;
    let (vmm, _vmm_file) = bind(&options.vmm_socket)?;
    // Everything a pager opens by name is open now, while it has one
    // thread: from here on it is no more than the VM.
    if let Some(user) = options.user {
        user.assume()?;
    }
    {
        let mut out = io::stdout().lock();
        out.write_all(b"ready\n")?;
        out.flush()?;
    }
    let status = Arc::new(Status::default());
    let hello = Hello {
        tag: options.tag.clone(),
        device: metadata.dev(),
        inode: metadata.ino(),
    };
    {
        let (filling, status) = (Arc::clone(&filling), Arc::clone(&status));
        std::thread::Builder::new()
            .name("control".into())
            .spawn(move || talk(&control, &filling, &status, &hello))?;
    }
    let result = serve(&vmm, prepared, &filling, options, &status, &stopped);
    if result.is_ok() && status.done.load(Ordering::Acquire) {
        filling.signal_tell();
        status.await_goodbye(GOODBYE);
    }
    status.ended.store(true, Ordering::Release);
    filling.signal_tell();
    result
}

/// Binds a listening socket at `path`, replacing a stale one.
fn bind(path: &Path) -> io::Result<(UnixListener, Bound)> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let listener = UnixListener::bind(path)?;
    let metadata = fs::symlink_metadata(path)?;
    Ok((
        listener,
        Bound {
            path: path.to_owned(),
            identity: (metadata.dev(), metadata.ino()),
        },
    ))
}

/// A socket file this process bound, removed when dropped unless another
/// pager has bound its own at the same path since: a pager left over from
/// a restore that never finished may exit after the next one started.
struct Bound {
    path: PathBuf,
    identity: (u64, u64),
}

impl Drop for Bound {
    fn drop(&mut self) {
        let ours = fs::symlink_metadata(&self.path)
            .is_ok_and(|metadata| (metadata.dev(), metadata.ino()) == self.identity);
        if ours {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// What a pager readies before it gives up root.
struct Prepared {
    /// The memory file, mapped.
    source: FilledFile,
    /// The order to prefetch in.
    profile: WakeProfile,
    quiesce: AskVmm,
}

fn serve(
    vmm: &UnixListener,
    prepared: Prepared,
    filling: &Arc<Fill>,
    options: &Options,
    status: &Status,
    stopped: &AtomicBool,
) -> io::Result<()> {
    vmm.set_nonblocking(true)?;
    let started = Instant::now();
    let peer = loop {
        match vmm.accept() {
            Ok((peer, _)) => break peer,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if stopped.load(Ordering::Relaxed) {
                    return Ok(());
                }
                if started.elapsed() > CONNECT_TIMEOUT {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "the VMM never connected",
                    ));
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(error) => return Err(error),
        }
    };
    peer.set_nonblocking(false)?;
    let Prepared {
        source,
        profile,
        quiesce,
    } = prepared;
    let mut pager =
        Pager::new(peer, source, options.record_for)?.finish_when_complete(Box::new(quiesce));
    let plan: Vec<_> = profile
        .offsets
        .iter()
        .filter_map(|offset| pager.layout().offset(*offset))
        .collect();
    let (ready, rest) = plan.split_at(ready_prefix(&plan, options.ready_bytes));
    pager.queue_prefetch(ready, MAX_BATCH)?;
    pager.queue_background(rest)?;
    let page_size = pager
        .layout()
        .regions()
        .first()
        .map_or(0, |region| region.page_size);
    let result = pager.run(stopped, |progress| match progress {
        Progress::Prefetched => {
            status.prefetched.store(true, Ordering::Release);
            filling.signal_tell();
        }
        Progress::Recorded(touched) => {
            if let Some(path) = &options.learned {
                let learned = profile.learn(touched, page_size);
                if let Err(error) = serde_json::to_vec(&learned)
                    .map_err(io::Error::other)
                    .and_then(|bytes| write_atomic(path, &bytes))
                {
                    eprintln!("pager: learned profile not written: {error}");
                }
            }
        }
        Progress::Settled => {
            // Word for a host whose connection dropped just now, which
            // would otherwise take the pager's exit for its death.
            if let Err(error) = fs::write(options.control.with_extension("done"), b"") {
                eprintln!("pager: done not recorded: {error}");
            }
            status.done.store(true, Ordering::Release);
        }
    });
    eprintln!(
        "pager for image {}: {}",
        options.tag,
        serde_json::to_string(&pager.stats).unwrap_or_default()
    );
    result
}

/// Replaces `path` with `bytes` all at once.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let staging = path.with_extension("pager-tmp");
    fs::write(&staging, bytes)?;
    fs::rename(&staging, path)
}

/// What the pager tells every host that connects about itself.
struct Hello {
    tag: String,
    device: u64,
    inode: u64,
}

/// One host connection.
struct Host {
    stream: UnixStream,
    /// Bytes read but not yet a whole line.
    partial: Vec<u8>,
    told_prefetched: bool,
    told_complete: bool,
}

impl Host {
    fn send(&mut self, message: &ToHost) -> io::Result<()> {
        let line = control::line(message).map_err(io::Error::other)?;
        self.stream.write_all(&line)
    }

    /// Reads what the host sent and applies it. `false` once the host has
    /// gone or sent something invalid; it is then dropped.
    fn receive(&mut self, filling: &Fill) -> bool {
        let mut buffer = vec![0_u8; 64 << 10];
        let count = match self.stream.read(&mut buffer) {
            Ok(0) | Err(_) => return false,
            Ok(count) => count,
        };
        self.partial.extend_from_slice(&buffer[..count]);
        let mut arrived = false;
        while let Some(end) = self.partial.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.partial.drain(..=end).collect();
            match control::parse::<ToPager>(&line) {
                Ok(ToPager::Filled { ranges }) => {
                    for (start, end) in ranges {
                        if let Err(error) = filling.readable.mark(start..end) {
                            eprintln!("pager: host sent a bad range: {error}");
                            return false;
                        }
                    }
                    arrived = true;
                }
                Err(error) => {
                    eprintln!("pager: host sent a bad message: {error}");
                    return false;
                }
            }
        }
        if arrived {
            filling.signal_arrived();
        }
        true
    }
}

/// Talks to whichever host is connected, one at a time; a new connection
/// replaces the old one, since only one host agent runs.
fn talk(listener: &UnixListener, filling: &Fill, status: &Status, hello: &Hello) {
    if let Err(error) = listener.set_nonblocking(true) {
        eprintln!("pager: control socket unusable: {error}");
        return;
    }
    let mut host: Option<Host> = None;
    loop {
        if status.ended.load(Ordering::Acquire) {
            status.said_goodbye();
            return;
        }
        let host_fd: RawFd = host.as_ref().map_or(-1, |host| host.stream.as_raw_fd());
        let fds = [listener.as_raw_fd(), filling.tell_fd().as_raw_fd(), host_fd];
        let ready = match poll(&fds, Duration::from_millis(100)) {
            Ok(ready) => ready,
            Err(error) => {
                eprintln!("pager: control poll failed: {error}");
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
        };
        if ready[1] {
            filling.acknowledge_tell();
        }
        if ready[0]
            && let Ok((stream, _)) = listener.accept()
        {
            host = greet(stream, filling, status, hello);
        }
        if ready[2] && host.as_mut().is_some_and(|host| !host.receive(filling)) {
            host = None;
        }
        let Some(connected) = host.as_mut() else {
            if status.done.load(Ordering::Acquire) {
                status.said_goodbye();
                return;
            }
            continue;
        };
        if tell(connected, filling, status).is_err() {
            host = None;
        } else if status.done.load(Ordering::Acquire) {
            status.said_goodbye();
            return;
        }
    }
}

/// Starts a conversation with a newly connected host.
fn greet(stream: UnixStream, filling: &Fill, status: &Status, hello: &Hello) -> Option<Host> {
    stream.set_nonblocking(false).ok()?;
    stream.set_write_timeout(Some(WRITE_TIMEOUT)).ok()?;
    // Whatever was asked of an earlier host is asked of this one.
    filling.reconnected();
    let prefetched = status.prefetched.load(Ordering::Acquire);
    let mut host = Host {
        stream,
        partial: Vec::new(),
        told_prefetched: prefetched,
        told_complete: false,
    };
    host.send(&ToHost::Hello {
        tag: hello.tag.clone(),
        device: hello.device,
        inode: hello.inode,
        missing: filling.readable.missing(),
        prefetched,
    })
    .ok()?;
    Some(host)
}

/// Passes on what the pager wants and has reached.
fn tell(host: &mut Host, filling: &Fill, status: &Status) -> io::Result<()> {
    for want in filling.take_wants() {
        host.send(&ToHost::Want {
            offset: want.offset,
            len: want.len,
            urgent: want.urgent,
        })?;
    }
    if !host.told_prefetched && status.prefetched.load(Ordering::Acquire) {
        host.told_prefetched = true;
        host.send(&ToHost::Prefetched)?;
    }
    if !host.told_complete && filling.readable.complete() {
        host.told_complete = true;
        host.send(&ToHost::Complete)?;
    }
    if status.done.load(Ordering::Acquire) {
        host.send(&ToHost::Done)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_round_trip_through_their_arguments() {
        let options = Options {
            vmm_socket: "/j/uffd.sock".into(),
            control: "/s/pager.sock".into(),
            memory: "/s/images/7/memory".into(),
            tag: "7".into(),
            complete: true,
            profile: Some("/s/wake.json".into()),
            learned: Some("/s/wake.json".into()),
            ready_bytes: 1 << 27,
            record_for: Duration::from_secs(120),
            api_socket: Some("/j/api.sock".into()),
            user: Some(User {
                uid: 1_073_741_843,
                gid: 1_073_741_843,
            }),
        };
        assert_eq!(Options::parse(options.args()).unwrap(), options);
        assert!(Options::parse(["--tag".into()]).is_err());
        assert!(Options::parse(["--bogus".into(), "x".into()]).is_err());
        assert!(Options::parse(Vec::new()).is_err());
    }
}
