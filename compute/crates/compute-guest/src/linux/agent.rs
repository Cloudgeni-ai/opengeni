//! Opengeni's agent in the guest (see [`crate::agent`]): it starts once the
//! sandbox has its own identity and an init that names it, starts again
//! when it ends, and reaches its host's agent link through the forwarder
//! from its local NATS port, each connection as a stream that outlives the
//! vsock connections under it (see [`crate::resume`]). When the host has
//! no stream to go on with, the agent is told to reconnect at once (see
//! [`Guest::agent_link_gone`]).
//!
//! It starts from the program the init keeps when its usual path no longer
//! holds one (see [`super::program`]), and with `/dev` as programs expect
//! it (see [`super::devices`]).

use std::fs;
use std::io::{self, Write as _};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use super::guest::Guest;
use super::program::{FileId, PROVEN, Program};
use super::supervise::{self, Children};
use super::sys::Exit;
use super::vsock::Stream;
use super::{log, spawn, sys, system};
use crate::AGENT_LINK_PORT;
use crate::agent::{self, ACTIVITY_DIR, LINK_DIR, LINK_FILE, NATS_PORT};
use crate::envd::AgentInit;
use crate::resume::StreamId;
use crate::resume::relay::{self as resume, Ended};

/// An agent that ends sooner than this after it started ended at once.
const QUICK: Duration = Duration::from_secs(10);

/// After this many quick ends in a row of a program that is not the one
/// kept, the kept one is put back in its place.
const QUICK_ENDS: u32 = 3;

/// Keeps the agent running from the moment the sandbox wants it, with
/// back-off between starts. Never returns.
pub fn supervise(guest: &Arc<Guest>, children: &Children) {
    let program = Program::agent();
    let mut forwarding = false;
    let mut pause = Duration::from_millis(200);
    let mut quick_ends = 0;
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
        // The agent, its commands and its link's port need what is there.
        system::keep_dev();
        let started = Instant::now();
        let spawned = start_program(&program, quick_ends >= QUICK_ENDS, |path| {
            let mut command = supervise::command(&path.to_string_lossy());
            command
                .args(agent::args(&wanted))
                .env_clear()
                .envs(&env)
                .current_dir("/")
                .stdin(Stdio::null());
            children.spawn(&mut command)
        });
        match spawned {
            Ok(((pid, exited), file)) => {
                guest.agent_started(pid, wanted);
                log(&format!("the agent runs as pid {pid}"));
                let exit = wait_keeping(&program, file, &exited);
                guest.agent_stopped(pid);
                log(&format!("the agent (pid {pid}) ended: {exit:?}"));
            }
            Err(error) => log(&format!("the agent did not start: {error}")),
        }
        if started.elapsed() < QUICK {
            quick_ends += 1;
        } else {
            quick_ends = 0;
        }
        if started.elapsed() > Duration::from_secs(60) {
            pause = Duration::from_millis(200);
        }
        thread::sleep(pause);
        pause = (pause * 2).min(Duration::from_secs(10));
    }
}

/// Starts `program` with `spawn`, from its usual path: first the kept
/// program is put back there when the path holds no program (or, with
/// `replace`, one that is not the kept one), and when what is there does
/// not start, the kept one is put back and started; where it cannot be put
/// back (a directory is in its place), it starts where it is kept. Returns
/// what `spawn` returned and the file it started from its usual path.
pub(super) fn start_program<T>(
    program: &Program,
    replace: bool,
    mut spawn: impl FnMut(&Path) -> io::Result<T>,
) -> io::Result<(T, Option<FileId>)> {
    put_back(program, replace);
    let file = program.current();
    let error = match spawn(program.path()) {
        Ok(started) => return Ok((started, file)),
        Err(error) => error,
    };
    log(&format!(
        "the agent's program {} did not start: {error}",
        program.path().display()
    ));
    match program.restore(true) {
        Ok(true) => {
            log(&format!(
                "put the agent's program the init keeps back at {}",
                program.path().display()
            ));
            Ok((spawn(program.path())?, program.current()))
        }
        Ok(false) => Err(error),
        Err(restore_error) => {
            log(&format!(
                "the agent's program cannot be put back at {}: {restore_error}; starting the one kept at {}",
                program.path().display(),
                program.kept().display()
            ));
            Ok((spawn(program.kept())?, None))
        }
    }
}

/// Puts the kept program back when the usual path holds none, or, with
/// `replace`, holds another that keeps ending at once; and says so.
fn put_back(program: &Program, replace: bool) {
    let missing = program.current().is_none();
    match program.restore(replace) {
        Ok(true) if missing => log(&format!(
            "the agent's program was missing from {}; put back the one the init keeps",
            program.path().display()
        )),
        Ok(true) => log(&format!(
            "the agent's program at {} ended at once {QUICK_ENDS} times; put back the one the init keeps",
            program.path().display()
        )),
        Ok(false) => {}
        Err(error) => log(&format!(
            "the agent's program cannot be put back at {}: {error}",
            program.path().display()
        )),
    }
}

/// Waits for the agent to end. Once it has run for [`PROVEN`] from the
/// file still at its usual path, that file is the one kept from then on.
fn wait_keeping(program: &Program, file: Option<FileId>, exited: &Receiver<Exit>) -> Option<Exit> {
    match exited.recv_timeout(PROVEN) {
        Ok(exit) => return Some(exit),
        Err(RecvTimeoutError::Disconnected) => return None,
        Err(RecvTimeoutError::Timeout) => {}
    }
    if file.is_some() && program.current() == file {
        match program.keep(false) {
            Ok(true) => log(&format!(
                "keeping the agent's program now at {}",
                program.path().display()
            )),
            Ok(false) => {}
            Err(error) => log(&format!("keeping the agent's program: {error}")),
        }
    }
    exited.recv().ok()
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
    let id = match stream_id() {
        Ok(id) => id,
        Err(error) => {
            log(&format!("the agent link's stream id: {error}"));
            return;
        }
    };
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

/// A new stream's id: random, from `getrandom(2)`, so that it needs no
/// device node a command could remove.
pub(super) fn stream_id() -> io::Result<StreamId> {
    let mut bytes = [0; 16];
    sys::random_bytes(&mut bytes)?;
    Ok(StreamId::from_bytes(bytes))
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
