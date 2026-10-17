//! What the guest keeps and what its vsock ports do.

use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpStream};
use std::os::unix::fs::OpenOptionsExt;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::vsock::Stream;
use super::{log, spawn, sys, system};
use crate::ENVD_PORT;
use crate::envd::{self, InitData};
use crate::gateway::{self, Header};
use crate::notice::{self, Notice, Orders};

/// Where the guest keeps what a create gave the sandbox, so a guest booted
/// again from its disk gives envd the same. Only root may read it: it
/// holds the access token.
const GIVEN_FILE: &str = "/opengeni/init-data.json";

/// Longest a notice or an `init` waits for envd to be up.
const ENVD_WAIT: Duration = Duration::from_secs(10);

/// Longest one `/init` call may take.
const INIT_LIMIT: Duration = Duration::from_secs(10);

/// Longest the guest waits for a header or a notice line.
const LINE_LIMIT: Duration = Duration::from_secs(10);

/// Longest connecting to a guest TCP port may take.
const CONNECT_LIMIT: Duration = Duration::from_secs(2);

/// The guest's state, shared by its threads.
#[derive(Debug)]
pub struct Guest {
    /// Serialises every `/init`.
    state: Mutex<State>,
    envd: Mutex<Envd>,
    envd_changed: Condvar,
}

#[derive(Debug)]
struct State {
    /// The image's defaults: its environment, user and directory.
    image: InitData,
    /// What a create gave the sandbox, if anything yet.
    given: Option<InitData>,
    orders: Orders,
}

impl State {
    /// What envd gets: the image's defaults, overlaid by what the sandbox
    /// was given.
    fn effective(&self) -> InitData {
        let mut data = self.image.clone();
        if let Some(given) = &self.given {
            data.env_vars.extend(given.env_vars.clone());
            data.access_token.clone_from(&given.access_token);
            if given.default_user.is_some() {
                data.default_user.clone_from(&given.default_user);
            }
            if given.default_workdir.is_some() {
                data.default_workdir.clone_from(&given.default_workdir);
            }
        }
        data
    }
}

#[derive(Debug, Default)]
struct Envd {
    up: bool,
}

fn now_nanos() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_nanos()).unwrap_or(u64::MAX)
        })
}

impl Guest {
    /// A guest whose image gives `image`, and which keeps what a create
    /// gave it before it was last booted.
    pub fn new(image: InitData) -> Self {
        let given = fs::read(GIVEN_FILE)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        Self {
            state: Mutex::new(State {
                image,
                given,
                orders: Orders::default(),
            }),
            envd: Mutex::new(Envd::default()),
            envd_changed: Condvar::new(),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// envd answers: gives it everything kept, with the time. Only then
    /// does it count as up.
    pub fn envd_started(&self) -> io::Result<()> {
        let state = self.state();
        call_init(&state.effective(), now_nanos())?;
        self.envd.lock().unwrap_or_else(PoisonError::into_inner).up = true;
        self.envd_changed.notify_all();
        Ok(())
    }

    /// envd ended.
    pub fn envd_stopped(&self) {
        self.envd.lock().unwrap_or_else(PoisonError::into_inner).up = false;
    }

    /// Waits until envd is up, at most `limit`.
    fn wait_envd(&self, limit: Duration) -> bool {
        let envd = self.envd.lock().unwrap_or_else(PoisonError::into_inner);
        let (envd, _) = self
            .envd_changed
            .wait_timeout_while(envd, limit, |envd| !envd.up)
            .unwrap_or_else(PoisonError::into_inner);
        envd.up
    }

    /// Handles one connection to the notice port. Notices are handled one
    /// at a time, on the listener's thread.
    pub fn notice(&self, mut stream: Stream) {
        let _ = stream.set_read_timeout(Some(LINE_LIMIT));
        let Ok((line, _)) = read_line(&mut stream, notice::MAX_LINE) else {
            return;
        };
        let Some(notice) = Notice::parse(&line) else {
            return;
        };
        if !self.state().orders.admits(notice.order) {
            return;
        }
        if let Err(error) = sys::set_clock(notice.nanos) {
            log(&format!("clock: {error}"));
        }
        if let Some(sandbox) = &notice.sandbox
            && let Err(error) =
                system::renew_identity(sandbox, notice.seed_hex.as_deref().unwrap_or(""))
        {
            // Not seeded, so the host does not use this clone; a retry
            // renews again.
            log(&format!("identity: {error}"));
            let _ = stream.write_all(notice::answer(false));
            return;
        }
        let seeded = notice.seed().is_some_and(|seed| system::reseed(&seed));
        // envd learns of the restore before the host may use the sandbox;
        // with no answer, the host tries again.
        if !self.wait_envd(ENVD_WAIT) {
            log("restore notice: envd is not up");
            return;
        }
        let mut state = self.state();
        if let Err(error) = call_init(&state.effective(), now_nanos()) {
            log(&format!("restore notice: envd /init: {error}"));
            return;
        }
        state.orders.applied(notice.order);
        drop(state);
        let _ = stream.write_all(notice::answer(seeded));
    }

    /// Handles one connection to the gateway port.
    pub fn gateway(&self, mut stream: Stream) {
        let _ = stream.set_read_timeout(Some(LINE_LIMIT));
        let (line, rest) = match read_line(&mut stream, gateway::MAX_HEADER) {
            Ok(read) => read,
            Err(error) => {
                let _ = stream.write_all(&gateway::error(&error.to_string()));
                return;
            }
        };
        match Header::parse(&line) {
            Ok(Header::Tcp(port)) => {
                let _ = stream.set_read_timeout(None);
                relay(stream, &rest, port);
            }
            Ok(Header::Init(data)) => {
                let answer = match self.init(*data) {
                    Ok(()) => gateway::OK.to_vec(),
                    Err(error) => gateway::error(&error.to_string()),
                };
                let _ = stream.write_all(&answer);
            }
            Err(reason) => {
                let _ = stream.write_all(&gateway::error(&reason));
            }
        }
    }

    /// A create gives the sandbox `given`: envd takes it, then the guest
    /// keeps it.
    fn init(&self, given: InitData) -> io::Result<()> {
        if !self.wait_envd(ENVD_WAIT) {
            return Err(io::Error::other("envd is not up"));
        }
        let mut state = self.state();
        let previous = state.given.replace(given);
        if let Err(error) = call_init(&state.effective(), now_nanos()) {
            state.given = previous;
            return Err(error);
        }
        if let Some(given) = &state.given
            && let Err(error) = keep(given)
        {
            log(&format!("keeping init data: {error}"));
        }
        Ok(())
    }
}

/// Writes `given` to [`GIVEN_FILE`].
fn keep(given: &InitData) -> io::Result<()> {
    let staged = format!("{GIVEN_FILE}.new");
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&staged)?;
    file.write_all(&serde_json::to_vec(given).map_err(io::Error::other)?)?;
    file.sync_all()?;
    fs::rename(&staged, GIVEN_FILE)
}

/// Reads up to the first newline, at most `limit` bytes. Returns the line
/// without it, and whatever came after it.
fn read_line(stream: &mut Stream, limit: usize) -> io::Result<(String, Vec<u8>)> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        if let Some(end) = buffer.iter().position(|&b| b == b'\n') {
            let rest = buffer.split_off(end + 1);
            buffer.truncate(end);
            let line = String::from_utf8(buffer)
                .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
            return Ok((line, rest));
        }
        if buffer.len() > limit {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "line too long"));
        }
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        buffer.extend_from_slice(&chunk[..n]);
    }
}

/// Calls envd's `/init` with `data` and the time `nanos`.
fn call_init(data: &InitData, nanos: u64) -> io::Result<()> {
    let body = data.body(Some(nanos));
    let status = call_envd(&envd::request("POST", "/init", Some(&body)), INIT_LIMIT)?;
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(io::Error::other(format!("envd answered {status}")))
    }
}

/// Whether envd answers its health check.
pub fn envd_healthy() -> bool {
    call_envd(
        &envd::request("GET", "/health", None),
        Duration::from_secs(1),
    )
    .is_ok_and(|status| (200..300).contains(&status))
}

/// Sends `request` to envd and returns the status of its answer.
fn call_envd(request: &[u8], limit: Duration) -> io::Result<u16> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, ENVD_PORT));
    let mut stream = TcpStream::connect_timeout(&address, limit)?;
    stream.set_read_timeout(Some(limit))?;
    stream.set_write_timeout(Some(limit))?;
    stream.write_all(request)?;
    let deadline = Instant::now() + limit;
    let mut response = Vec::new();
    let mut chunk = [0_u8; 1024];
    loop {
        if let Some(status) = envd::status(&response) {
            return Ok(status);
        }
        if response.len() > 8192 || Instant::now() >= deadline {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "no status line"));
        }
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        response.extend_from_slice(&chunk[..n]);
    }
}

/// Connects `stream` to TCP `port` on the guest's loopback, answers `ok`,
/// and relays both ways until both sides are done. `first` is what the
/// caller sent after its header.
fn relay(mut stream: Stream, first: &[u8], port: u16) {
    let addresses = [
        SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
    ];
    let mut last = io::Error::from(io::ErrorKind::ConnectionRefused);
    let mut tcp = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, CONNECT_LIMIT) {
            Ok(connected) => {
                tcp = Some(connected);
                break;
            }
            Err(error) => last = error,
        }
    }
    let Some(mut tcp) = tcp else {
        let _ = stream.write_all(&gateway::error(&format!("port {port}: {last}")));
        return;
    };
    let _ = tcp.set_nodelay(true);
    if stream.write_all(gateway::OK).is_err() || tcp.write_all(first).is_err() {
        return;
    }
    let (Ok(mut inbound), Ok(mut tcp_in)) = (stream.try_clone(), tcp.try_clone()) else {
        return;
    };
    let forward = spawn("relay", move || {
        let _ = io::copy(&mut inbound, &mut tcp_in);
        let _ = tcp_in.shutdown(Shutdown::Write);
    });
    let _ = io::copy(&mut tcp, &mut stream);
    let _ = stream.shutdown(Shutdown::Write);
    if let Some(forward) = forward {
        let _ = forward.join();
    }
}
