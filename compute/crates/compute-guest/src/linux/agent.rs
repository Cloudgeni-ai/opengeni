//! Opengeni's agent in the guest (see [`crate::agent`]): it starts once the
//! sandbox has its own identity and an init that names it, starts again
//! when it ends, is told to reconnect after each restore (see
//! [`Guest::notice`]), and reaches its host's agent link through the
//! forwarder from its local NATS port.

use std::fs;
use std::io::{self, Write as _};
use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream};
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
use std::path::Path;
use std::process::Stdio;
use std::thread;
use std::time::{Duration, Instant};

use super::guest::Guest;
use super::supervise::{self, Children};
use super::vsock::Stream;
use super::{log, spawn, sys};
use crate::AGENT_LINK_PORT;
use crate::agent::{self, ACTIVITY_DIR, AGENT_PATH, LINK_DIR, LINK_FILE, NATS_PORT};
use crate::envd::AgentInit;

/// Keeps the agent running from the moment the sandbox wants it, with
/// back-off between starts. Never returns.
pub fn supervise(guest: &Guest, children: &Children) {
    let mut forwarding = false;
    let mut pause = Duration::from_millis(200);
    loop {
        let (wanted, env) = guest.wait_agent();
        if !forwarding {
            forwarding = forward();
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
/// agent link, byte for byte. Whether it listens.
fn forward() -> bool {
    let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, NATS_PORT)) {
        Ok(listener) => listener,
        Err(error) => {
            log(&format!("the agent link's port {NATS_PORT}: {error}"));
            return false;
        }
    };
    spawn("agent-link", move || {
        loop {
            match listener.accept() {
                Ok((tcp, _)) => {
                    spawn("agent-link", move || relay(tcp));
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

/// Relays `tcp` to a new connection to the host's agent link, both ways,
/// until both sides are done. With no host to reach, `tcp` closes and the
/// agent dials again.
fn relay(mut tcp: TcpStream) {
    let mut host = match Stream::connect_host(AGENT_LINK_PORT) {
        Ok(host) => host,
        Err(error) => {
            log(&format!("the host's agent link: {error}"));
            return;
        }
    };
    let _ = tcp.set_nodelay(true);
    let (Ok(mut host_out), Ok(mut tcp_in)) = (host.try_clone(), tcp.try_clone()) else {
        return;
    };
    let outbound = spawn("agent-link", move || {
        let _ = io::copy(&mut tcp_in, &mut host_out);
        let _ = host_out.shutdown(Shutdown::Write);
    });
    let _ = io::copy(&mut host, &mut tcp);
    let _ = tcp.shutdown(Shutdown::Write);
    if let Some(outbound) = outbound {
        let _ = outbound.join();
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
