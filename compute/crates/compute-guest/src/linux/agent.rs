//! Opengeni's agent in the guest (see [`crate::agent`]): it starts once the
//! sandbox has its own identity and an init that names it, starts again
//! when it ends, and reaches its host's agent link through the forwarder
//! from its local NATS port, each connection as a stream that outlives the
//! vsock connections under it (see [`crate::resume`]). When the host has
//! no stream to go on with, the agent is told to reconnect at once (see
//! [`Guest::agent_link_gone`]).

use std::fs;
use std::io::{self, Read as _, Write as _};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use super::guest::Guest;
use super::supervise::{self, Children};
use super::vsock::Stream;
use super::{log, spawn, sys};
use crate::AGENT_LINK_PORT;
use crate::agent::{self, ACTIVITY_DIR, AGENT_PATH, LINK_DIR, LINK_FILE, NATS_PORT};
use crate::envd::AgentInit;
use crate::resume::StreamId;
use crate::resume::relay::{self as resume, Ended};

/// Keeps the agent running from the moment the sandbox wants it, with
/// back-off between starts. Never returns.
pub fn supervise(guest: &Arc<Guest>, children: &Children) {
    let mut forwarding = false;
    let mut pause = Duration::from_millis(200);
    loop {
        let (wanted, env) = guest.wait_agent();
        if !forwarding {
            forwarding = forward(guest);
        }
        if let Err(error) = write_link(&wanted) {
            log(&format!("the agent's link file: {error}"));
            thread::sleep(pause);
            pause = (pause * 2).min(Duration::from_secs(10));
            continue;
        }
        let started = Instant::now();
        let mut command = supervise::command(AGENT_PATH);
        command
            .args(agent::args(&wanted))
            .env_clear()
            .envs(env)
            .current_dir("/")
            .stdin(Stdio::null());
        match children.spawn(&mut command) {
            Ok((pid, exited)) => {
                guest.agent_started(pid, wanted);
                log(&format!("the agent runs as pid {pid}"));
                let exit = exited.recv();
                guest.agent_stopped(pid);
                log(&format!("the agent (pid {pid}) ended: {exit:?}"));
            }
            Err(error) => log(&format!("the agent did not start: {error}")),
        }
        if started.elapsed() > Duration::from_secs(60) {
            pause = Duration::from_millis(200);
        }
        thread::sleep(pause);
        pause = (pause * 2).min(Duration::from_secs(10));
    }
}

/// Writes the file the agent starts with, root's only, in one step.
fn write_link(wanted: &AgentInit) -> io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(LINK_DIR)?;
    let staged = Path::new(LINK_DIR).join(".link.json");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&staged)?;
    file.write_all(agent::link_file(wanted).as_bytes())?;
    file.sync_all()?;
    fs::rename(&staged, LINK_FILE)
}

/// Forwards each connection to the agent's local NATS port to the host's
/// agent link as a resumable stream. Whether it listens.
fn forward(guest: &Arc<Guest>) -> bool {
    let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, NATS_PORT)) {
        Ok(listener) => listener,
        Err(error) => {
            log(&format!("the agent link's port {NATS_PORT}: {error}"));
            return false;
        }
    };
    let guest = Arc::clone(guest);
    spawn("agent-link", move || {
        loop {
            match listener.accept() {
                Ok((tcp, _)) => {
                    let opened_in = guest.agent_link_epoch();
                    let guest = Arc::clone(&guest);
                    spawn("agent-link", move || relay(tcp, &guest, opened_in));
                }
                Err(error) => {
                    log(&format!("the agent link's port {NATS_PORT}: {error}"));
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
    })
    .is_some()
}

/// Relays `tcp` as a new stream to the host's agent link, both ways, until
/// both sides are done or the host has no stream to go on with. With no
/// host to reach, `tcp` closes and the agent dials again. `opened_in` is
/// the agent's link epoch when it connected.
fn relay(tcp: TcpStream, guest: &Guest, opened_in: u64) {
    let _ = tcp.set_nodelay(true);
    let mut bytes = [0; 16];
    if let Err(error) =
        fs::File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes))
    {
        log(&format!("the agent link's stream id: {error}"));
        return;
    }
    let id = StreamId::from_bytes(bytes);
    let ended = resume::relay(
        tcp,
        id,
        || Stream::connect_host(AGENT_LINK_PORT),
        |ended| {
            // Before the agent sees its connection end, so that it dials
            // once, at once.
            if *ended == Ended::Gone {
                guest.agent_link_gone(opened_in);
            }
        },
    );
    match ended {
        Ended::Finished => {}
        Ended::Gone => log(&format!("the agent link's stream {id}: the host has none")),
        Ended::Lost => log(&format!(
            "the agent link's stream {id}: the host could not be reached again"
        )),
        Ended::Unreachable(error) => log(&format!("the host's agent link: {error}")),
        Ended::Broken(error) => log(&format!("the agent link's stream {id}: {error}")),
    }
}

/// What keeps the sandbox awake, as the agent registers it: the sum of the
/// counts in the activity files of processes still alive.
pub fn activity() -> u32 {
    let Ok(entries) = fs::read_dir(ACTIVITY_DIR) else {
        return 0;
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let pid = agent::activity_pid(entry.file_name().to_str()?)?;
            if !sys::alive(pid) {
                return None;
            }
            agent::activity_count(&fs::read_to_string(entry.path()).ok()?)
        })
        .fold(0, u32::saturating_add)
}

/// Empties the activity directory at boot: whatever it counted belonged to
/// processes of an earlier boot.
pub fn clear_activity() {
    match fs::remove_dir_all(ACTIVITY_DIR) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => log(&format!("{ACTIVITY_DIR}: {error}")),
    }
    if let Err(error) = fs::DirBuilder::new()
        .recursive(true)
        .mode(0o755)
        .create(ACTIVITY_DIR)
    {
        log(&format!("{ACTIVITY_DIR}: {error}"));
    }
}
