//! PID 1 on Linux: the order things start in, and the threads that keep
//! them going.

mod guest;
mod supervise;
mod sys;
mod system;
mod vsock;

use std::fs;
use std::os::unix::process::CommandExt;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::mpsc::Receiver;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use self::guest::Guest;
use self::supervise::Children;
use self::sys::{Exit, Signals};
use crate::cmdline::BootArgs;
use crate::config::{self, ImageConfig};
use crate::envd::InitData;
use crate::users;
use crate::{ENVD_PORT, GATEWAY_PORT, NOTICE_PORT, READY_PORT};

/// Writes one line to the console.
pub(crate) fn log(message: &str) {
    eprintln!("compute-guest: {message}");
}

/// Starts a thread with a small stack; `None` if it could not start.
pub(crate) fn spawn(
    name: &'static str,
    work: impl FnOnce() + Send + 'static,
) -> Option<JoinHandle<()>> {
    thread::Builder::new()
        .name(name.to_owned())
        .stack_size(128 * 1024)
        .spawn(work)
        .inspect_err(|error| log(&format!("thread {name}: {error}")))
        .ok()
}

/// How long the guest gives its processes to end on shutdown.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Runs the guest. Never returns: it ends with the machine.
pub fn run() -> ! {
    // Blocked before any thread starts, so every thread inherits the mask
    // and only the main loop below takes them.
    let signals = Signals::block(&[
        libc::SIGCHLD,
        libc::SIGTERM,
        libc::SIGINT,
        libc::SIGHUP,
        libc::SIGPWR,
    ])
    .unwrap_or_else(|error| {
        log(&format!("signals: {error}"));
        std::process::exit(1)
    });
    if let Err(error) = sys::ctrl_alt_del_signals() {
        log(&format!("ctrl-alt-del: {error}"));
    }
    system::mount_basics();
    let args = BootArgs::parse(&fs::read_to_string("/proc/cmdline").unwrap_or_default());
    system::network(args.network.as_ref());
    if let Some(sandbox) = &args.sandbox {
        system::boot_identity(sandbox);
    }
    let image: ImageConfig = fs::read(config::CONFIG_PATH)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let children = Arc::new(Children::default());
    let guest = Arc::new(Guest::new(InitData {
        env_vars: image.env_map(),
        access_token: None,
        default_user: Some(config::DEFAULT_USER.to_owned()),
        default_workdir: image.default_workdir().map(str::to_owned),
    }));
    listen(NOTICE_PORT, "notice", {
        let guest = Arc::clone(&guest);
        move |stream| guest.notice(stream)
    });
    listen(GATEWAY_PORT, "gateway", {
        let guest = Arc::clone(&guest);
        move |stream| {
            let guest = Arc::clone(&guest);
            spawn("gateway", move || guest.gateway(stream));
        }
    });
    spawn("envd", {
        let (guest, children) = (Arc::clone(&guest), Arc::clone(&children));
        move || supervise_envd(&guest, &children)
    });
    spawn("command", {
        let children = Arc::clone(&children);
        move || run_command(&image, &children)
    });
    loop {
        match signals.wait(Duration::from_secs(1)) {
            Some(libc::SIGTERM | libc::SIGINT | libc::SIGPWR) => shutdown(&signals, &children),
            _ => children.reap(),
        }
    }
}

/// Accepts connections on vsock `port` for ever, handing each to `handle`.
fn listen(port: u32, name: &'static str, handle: impl Fn(vsock::Stream) + Send + 'static) {
    let listener = match vsock::Listener::bind(port) {
        Ok(listener) => listener,
        Err(error) => {
            log(&format!("{name} port {port}: {error}"));
            return;
        }
    };
    spawn(name, move || {
        loop {
            match listener.accept() {
                Ok(stream) => handle(stream),
                Err(error) => {
                    log(&format!("{name} port {port}: {error}"));
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
    });
}

/// How long envd may take to answer after it starts.
const ENVD_START: Duration = Duration::from_secs(30);

/// Keeps envd running. Each time it starts, it gets its `/init` before the
/// guest counts it as up; the first time, the guest becomes ready.
fn supervise_envd(guest: &Guest, children: &Children) {
    let mut ready = false;
    let mut pause = Duration::from_millis(200);
    loop {
        let started = Instant::now();
        let mut command = supervise::command(config::ENVD_PATH);
        command
            .args(["-isnotfc", "-port", &ENVD_PORT.to_string()])
            .env_clear()
            .env("PATH", config::DEFAULT_PATH)
            .env("HOME", "/root")
            .stdin(Stdio::null());
        match children.spawn(&mut command) {
            Ok((pid, exited)) => {
                if bring_up(guest, &exited) && !ready {
                    ready = true;
                    // Template builders and the host wait on this port.
                    listen(READY_PORT, "ready", drop);
                }
                let exit = exited.recv();
                guest.envd_stopped();
                log(&format!("envd (pid {pid}) ended: {exit:?}"));
            }
            Err(error) => log(&format!("envd: {error}")),
        }
        if started.elapsed() > Duration::from_secs(60) {
            pause = Duration::from_millis(200);
        }
        thread::sleep(pause);
        pause = (pause * 2).min(Duration::from_secs(10));
    }
}

/// Waits for a started envd to answer, then gives it its `/init`. False if
/// it ended or never took it.
fn bring_up(guest: &Guest, exited: &Receiver<Exit>) -> bool {
    let deadline = Instant::now() + ENVD_START;
    while Instant::now() < deadline {
        if exited.try_recv().is_ok() {
            return false;
        }
        if guest::envd_healthy() {
            match guest.envd_started() {
                Ok(()) => return true,
                Err(error) => log(&format!("envd /init: {error}")),
            }
        }
        thread::sleep(Duration::from_millis(10));
    }
    log("envd did not come up");
    false
}

/// Runs the image's command once, as `docker run` would, under the image's
/// user.
fn run_command(image: &ImageConfig, children: &Children) {
    let command = image.command();
    let Some((program, args)) = command.split_first() else {
        return;
    };
    let accounts = users::parse_passwd(&fs::read_to_string("/etc/passwd").unwrap_or_default());
    let groups = users::parse_group(&fs::read_to_string("/etc/group").unwrap_or_default());
    let user = match users::resolve(&image.user, &accounts, &groups) {
        Ok(user) => user,
        Err(error) => {
            log(&format!("the image's command does not run: {error}"));
            return;
        }
    };
    let dir = image.working_dir();
    let _ = fs::create_dir_all(dir);
    let mut process = supervise::command(program);
    process
        .args(args)
        .env_clear()
        .envs(image.process_env(&user.home))
        .current_dir(dir)
        .process_group(0)
        .stdin(Stdio::null());
    sys::run_as(&mut process, user.uid, user.gid, user.groups);
    match children.spawn(&mut process) {
        Ok((pid, exited)) => {
            log(&format!("the image's command runs as pid {pid}"));
            if let Ok(exit) = exited.recv() {
                log(&format!("the image's command ended: {exit}"));
            }
        }
        Err(error) => log(&format!("the image's command did not start: {error}")),
    }
}

/// Ends every process, gently first, then the machine.
fn shutdown(signals: &Signals, children: &Children) -> ! {
    log("shutting down");
    sys::signal_all(libc::SIGTERM);
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    while Instant::now() < deadline && sys::others_alive() {
        let _ = signals.wait(Duration::from_millis(50));
        children.reap();
    }
    sys::signal_all(libc::SIGKILL);
    children.reap();
    sys::sync();
    if let Err(error) = sys::remount_root_read_only() {
        log(&format!("remount: {error}"));
    }
    sys::sync();
    let error = sys::restart_machine();
    log(&format!("restart: {error}"));
    std::process::exit(1)
}
