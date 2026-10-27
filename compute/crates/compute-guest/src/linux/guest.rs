//! What the guest keeps and what its vsock ports do.

use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::supervise::Children;
use super::vsock::Stream;
use super::{agent, log, sys, system};
use crate::ENVD_PORT;
use crate::envd::{self, AgentInit, InitData};
use crate::gateway::{self, Header};
use crate::given::{self, GIVEN_FILE, Given};
use crate::notice::{self, Notice, Orders};

/// Longest a notice or an `init` waits for envd to be up.
const ENVD_WAIT: Duration = Duration::from_secs(10);

/// Longest one `/init` call may take.
const INIT_LIMIT: Duration = Duration::from_secs(10);

/// Longest the guest waits for a header or a notice line.
const LINE_LIMIT: Duration = Duration::from_secs(10);

/// Longest connecting to a guest TCP port may take.
const CONNECT_LIMIT: Duration = Duration::from_secs(2);

/// The shortest run of free space a trim gives back. Shorter runs hold
/// little, but can be many: deleting every other file of 100,000 left
/// runs whose trim took 4 s of a pause, where trimming only runs of 1 MiB
/// or more took 40 ms and still gave back the large deletions.
const TRIM_MIN: u64 = 1 << 20;

/// Gives the host back the root file system's free space, so that a disk
/// saved after this holds only what its files use. A device that takes no
/// discards (a host before they were turned on) says so the first time
/// only.
fn trim_root() {
    static REPORTED: AtomicBool = AtomicBool::new(false);
    if let Err(error) = sys::trim("/", TRIM_MIN)
        && !REPORTED.swap(true, Ordering::Relaxed)
    {
        log(&format!("trim: {error}"));
    }
}

/// The environment the image's command gets on top of the image's own.
pub type CommandEnv = BTreeMap<String, String>;

/// The guest's state, shared by its threads.
#[derive(Debug)]
pub struct Guest {
    /// Serialises every `/init`.
    state: Mutex<State>,
    /// Signalled when what the sandbox was given changes.
    given_changed: Condvar,
    envd: Mutex<Envd>,
    envd_changed: Condvar,
    /// Starts the image's command, once.
    command: Mutex<Option<Sender<CommandEnv>>>,
    /// Whether the image has envd. Without it the guest takes notices and
    /// inits on its own.
    has_envd: bool,
    /// Opengeni's agent, when the sandbox runs one.
    agent: Mutex<Agent>,
    agent_changed: Condvar,
    children: Arc<Children>,
}

#[derive(Debug, Default)]
struct Agent {
    /// What it is to run with, once the sandbox wants it.
    wanted: Option<(AgentInit, CommandEnv)>,
    /// The running agent's pid and what it started with.
    running: Option<(i32, AgentInit)>,
    /// The epoch its connections to its link port open in; see
    /// [`Guest::agent_link_gone`].
    link_epoch: crate::agent::LinkEpoch,
}

#[derive(Debug)]
struct State {
    /// The image's defaults: its environment, user and directory.
    image: InitData,
    /// What a create gave the sandbox, if anything yet.
    given: Given,
    orders: Orders,
}

impl State {
    /// What envd gets: the image's defaults, overlaid by what the sandbox
    /// was given. Fails while what it was given cannot be read: envd
    /// would then run without the sandbox's access token.
    fn effective(&self) -> io::Result<InitData> {
        let mut data = self.image.clone();
        if let Given::Unreadable(reason) = &self.given {
            return Err(io::Error::other(format!(
                "what the sandbox was given cannot be read: {reason}"
            )));
        }
        if let Given::Kept(given) = &self.given {
            data.env_vars.extend(given.env_vars.clone());
            data.access_token.clone_from(&given.access_token);
            if given.default_user.is_some() {
                data.default_user.clone_from(&given.default_user);
            }
            if given.default_workdir.is_some() {
                data.default_workdir.clone_from(&given.default_workdir);
            }
        }
        Ok(data)
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
    /// gave it before it was last booted. `command` starts the image's
    /// command; `has_envd` says whether the image has envd.
    pub fn new(
        image: InitData,
        command: Sender<CommandEnv>,
        has_envd: bool,
        children: Arc<Children>,
    ) -> Self {
        let given = given::load(Path::new(GIVEN_FILE));
        if let Given::Unreadable(reason) = &given {
            log(&format!(
                "envd waits for a new init: what the sandbox was given cannot be read: {reason}"
            ));
        }
        Self {
            state: Mutex::new(State {
                image,
                given,
                orders: Orders::default(),
            }),
            given_changed: Condvar::new(),
            envd: Mutex::new(Envd::default()),
            envd_changed: Condvar::new(),
            command: Mutex::new(Some(command)),
            has_envd,
            agent: Mutex::new(Agent::default()),
            agent_changed: Condvar::new(),
            children,
        }
    }

    /// Booted from the disk of a sandbox that a create already gave its
    /// init: the image's command and the agent start again, as after a
    /// restart. Otherwise they wait for that init (see [`Self::init`]).
    pub fn booted(&self, sandbox: Option<&str>) {
        let given = match &self.state().given {
            Given::Kept(given) if sandbox.is_some() => given.clone(),
            _ => return,
        };
        self.start_command(given.env_vars.clone());
        self.want_agent(&given);
    }

    /// Starts the image's command with `env`, unless it started already.
    fn start_command(&self, env: CommandEnv) {
        let sender = self
            .command
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(sender) = sender {
            let _ = sender.send(env);
        }
    }

    /// The sandbox runs the agent `given` names, if it names one: with the
    /// image's environment and then `given`'s, as root. An agent running
    /// with other settings is stopped, to start again with these.
    fn want_agent(&self, given: &InitData) {
        let Some(wanted) = &given.agent else {
            return;
        };
        if !Path::new(crate::agent::AGENT_PATH).exists() {
            log("the init names an agent, but the image has none");
            return;
        }
        let env = crate::agent::env(&self.state().image.env_vars, &given.env_vars);
        let mut agent = self.agent();
        let stale = agent
            .running
            .as_ref()
            .filter(|(_, running)| running != wanted)
            .map(|(pid, _)| *pid);
        agent.wanted = Some((wanted.clone(), env));
        drop(agent);
        self.agent_changed.notify_all();
        if let Some(pid) = stale
            && let Err(error) = self.children.signal(pid, libc::SIGTERM)
        {
            log(&format!("stopping the agent (pid {pid}): {error}"));
        }
    }

    fn agent(&self) -> MutexGuard<'_, Agent> {
        self.agent.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Waits until the sandbox wants the agent, and returns what it is to
    /// run with.
    pub fn wait_agent(&self) -> (AgentInit, CommandEnv) {
        let agent = self.agent();
        let agent = self
            .agent_changed
            .wait_while(agent, |agent| agent.wanted.is_none())
            .unwrap_or_else(PoisonError::into_inner);
        agent
            .wanted
            .clone()
            .unwrap_or_else(|| unreachable!("waited for it"))
    }

    /// The agent runs as `pid`, with `init`.
    pub fn agent_started(&self, pid: i32, init: AgentInit) {
        self.agent().running = Some((pid, init));
    }

    /// The agent `pid` ended.
    pub fn agent_stopped(&self, pid: i32) {
        let mut agent = self.agent();
        if agent
            .running
            .as_ref()
            .is_some_and(|(running, _)| *running == pid)
        {
            agent.running = None;
        }
    }

    /// The agent's link epoch, which a connection to its link port opens
    /// in.
    pub fn agent_link_epoch(&self) -> u64 {
        self.agent().link_epoch.current()
    }

    /// The stream of an agent connection opened in `opened_in` ended
    /// because its host had none to go on with: the sandbox moved, was
    /// recovered elsewhere or outlived its host agent, and the stream went
    /// with the host it knew. The host answers, so the agent dials again
    /// at once rather than after the back-off it takes for an outage, once
    /// for the connections it had then (see [`crate::agent::LinkEpoch`]).
    /// A restore alone tells it nothing: a host that kept its streams
    /// carries its connections on, with what was sent to them while it
    /// slept.
    pub fn agent_link_gone(&self, opened_in: u64) {
        let mut agent = self.agent();
        if !agent.link_epoch.gone(opened_in) {
            return;
        }
        let pid = agent.running.as_ref().map(|(pid, _)| *pid);
        drop(agent);
        if let Some(pid) = pid
            && let Err(error) = self.children.signal(pid, libc::SIGUSR1)
        {
            log(&format!(
                "telling the agent (pid {pid}) to reconnect: {error}"
            ));
        }
    }

    /// Waits while what the sandbox was given cannot be read: envd starts
    /// only with the sandbox's access token.
    pub fn wait_readable(&self) {
        let state = self.state();
        let _state = self
            .given_changed
            .wait_while(state, |state| matches!(state.given, Given::Unreadable(_)))
            .unwrap_or_else(PoisonError::into_inner);
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// envd answers: gives it everything kept. Only then
    /// does it count as up, and only then does the gateway reach it: until
    /// then it would take requests without the sandbox's access token.
    pub fn envd_started(&self) -> io::Result<()> {
        let state = self.state();
        call_init(&state.effective()?)?;
        self.envd.lock().unwrap_or_else(PoisonError::into_inner).up = true;
        self.envd_changed.notify_all();
        Ok(())
    }

    /// envd ended.
    pub fn envd_stopped(&self) {
        self.envd.lock().unwrap_or_else(PoisonError::into_inner).up = false;
    }

    /// Waits until envd is up, at most `limit`; at once in an image
    /// without it.
    fn wait_envd(&self, limit: Duration) -> bool {
        if !self.has_envd {
            return true;
        }
        let envd = self.envd.lock().unwrap_or_else(PoisonError::into_inner);
        let (envd, _) = self
            .envd_changed
            .wait_timeout_while(envd, limit, |envd| !envd.up)
            .unwrap_or_else(PoisonError::into_inner);
        envd.up
    }

    /// Connects to TCP `port` on the guest's loopback; `None` for envd's
    /// while envd is not up. envd's is connected to under the lock its stop
    /// takes, and a stopped envd starts again only after its stop: so a
    /// connection reaches only an envd that took what the sandbox was
    /// given, its access token included, never one started since.
    fn connect(&self, port: u16) -> Option<io::Result<TcpStream>> {
        if port != ENVD_PORT || !self.has_envd {
            return Some(connect(port));
        }
        let envd = self.envd.lock().unwrap_or_else(PoisonError::into_inner);
        envd.up.then(|| connect(port))
    }

    /// Handles one connection to the notice port. Notices are handled one
    /// at a time, on the listener's thread, and so is the host's
    /// `activity` question. Its `sync` request gets a thread of its own:
    /// a flush and trim can take a while, and must not hold up the notices
    /// after them, such as a restore's clock.
    pub fn notice(&self, mut stream: Stream) {
        let _ = stream.set_read_timeout(Some(LINE_LIMIT));
        let Ok((line, _)) = read_line(&mut stream, notice::MAX_LINE) else {
            return;
        };
        if line == "activity" {
            let _ = stream.write_all(crate::agent::activity_answer(agent::activity()).as_bytes());
            return;
        }
        if line == "sync" {
            // The host is about to save the disks: what they would hold
            // only in this memory reaches them first, then what the files
            // freed goes back to the host. The sync commits the deletions
            // first, so their space is free for the trim.
            super::spawn("sync", move || {
                sys::sync();
                trim_root();
                let _ = stream.write_all(notice::SYNCED);
            });
            return;
        }
        let Some(notice) = Notice::parse(&line) else {
            return;
        };
        let retry = {
            let state = self.state();
            if !state.orders.admits(notice.order) {
                // Said, so that a host sending it learns at once.
                let _ = stream.write_all(notice::STALE);
                return;
            }
            state.orders.is_latest(notice.order)
        };
        // Another attempt of the notice applied last carries the host's time
        // from when it was sent, and the guest may get to it late, after the
        // attempt before it: it moves the clock only forward.
        if (!retry || notice.nanos > now_nanos())
            && let Err(error) = sys::set_clock(notice.nanos)
        {
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
        if self.has_envd
            && let Err(error) = state.effective().and_then(|data| call_init(&data))
        {
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
            Ok(Header::Tcp(port)) => match self.connect(port) {
                Some(Ok(tcp)) => {
                    let _ = stream.set_read_timeout(None);
                    relay(stream, &rest, port, tcp);
                }
                Some(Err(error)) => {
                    let _ = stream.write_all(&gateway::error(&format!("port {port}: {error}")));
                }
                None => {
                    let _ = stream.write_all(&gateway::error(gateway::ENVD_NOT_UP));
                }
            },
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

    /// A create gives the sandbox `given`. The guest keeps it on disk for
    /// good, then gives it to envd, then starts the image's command if it
    /// has not yet, and the agent it names; it answers `ok` only after all
    /// of that. On a failure
    /// what it kept stays kept, so envd gets it with a retry or the next
    /// restore: the disk, the guest and the next `/init` always agree.
    fn init(&self, given: InitData) -> io::Result<()> {
        // The image's command must start in this sandbox only, never in a
        // template its clones copy.
        if system::current_sandbox().is_none() {
            return Err(io::Error::other("the guest is no sandbox yet"));
        }
        let env = given.env_vars.clone();
        let kept = given.clone();
        {
            let mut state = self.state();
            given::keep(Path::new(GIVEN_FILE), &given)
                .map_err(|error| io::Error::other(format!("keeping the init: {error}")))?;
            state.given = Given::Kept(given);
        }
        // envd may have waited for a readable init.
        self.given_changed.notify_all();
        if !self.wait_envd(ENVD_WAIT) {
            return Err(io::Error::other("envd is not up"));
        }
        if self.has_envd {
            let state = self.state();
            call_init(&state.effective()?)?;
            drop(state);
        }
        self.start_command(env);
        self.want_agent(&kept);
        Ok(())
    }
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

/// Calls envd's `/init` with `data`, and no time (see [`crate::envd`]).
fn call_init(data: &InitData) -> io::Result<()> {
    let body = data.body();
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

/// Connects to TCP `port` on the guest's loopback, over IPv4 or else IPv6.
fn connect(port: u16) -> io::Result<TcpStream> {
    let addresses = [
        SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
    ];
    let mut last = io::Error::from(io::ErrorKind::ConnectionRefused);
    for address in addresses {
        match TcpStream::connect_timeout(&address, CONNECT_LIMIT) {
            Ok(connected) => return Ok(connected),
            Err(error) => last = error,
        }
    }
    Err(last)
}

/// Answers `ok` on `stream`, connected to `tcp` on the guest's TCP `port`,
/// and relays both ways until both sides are done. `first` is what the
/// caller sent after its header.
fn relay(mut stream: Stream, first: &[u8], port: u16, mut tcp: TcpStream) {
    let _ = tcp.set_nodelay(true);
    if stream.write_all(gateway::OK).is_err() || tcp.write_all(first).is_err() {
        return;
    }
    if !crate::relay::relay(tcp, stream) {
        log(&format!("port {port}: the relay did not start"));
    }
}
