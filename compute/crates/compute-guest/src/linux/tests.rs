//! Starting and supervising children, with real processes.

use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use super::supervise::{self, Children};
use super::sys::{Exit, Signals};
use super::{Started, start};

/// One set of children for every test here, with a reaper as PID 1 has.
fn children() -> &'static Arc<Children> {
    static CHILDREN: OnceLock<Arc<Children>> = OnceLock::new();
    CHILDREN.get_or_init(|| {
        let children = Arc::new(Children::default());
        let reaper = Arc::clone(&children);
        std::thread::spawn(move || {
            loop {
                reaper.reap();
                std::thread::sleep(Duration::from_millis(5));
            }
        });
        children
    })
}

fn shell(script: &str) -> std::process::Command {
    let mut command = supervise::command("/bin/sh");
    command.args(["-c", script]);
    command
}

#[test]
fn children_start_with_no_signal_blocked_and_handle_term() {
    // As in PID 1: the starting thread blocks the signals it takes.
    let _signals = Signals::block(&[libc::SIGTERM, libc::SIGCHLD, libc::SIGINT]).unwrap();
    let dir = std::env::temp_dir().join(format!("compute-guest-term-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let blocked = dir.join("blocked");
    let script = format!(
        "grep SigBlk /proc/self/status > {0}; trap 'exit 7' TERM; touch {0}.ready; \
         while :; do sleep 0.05; done",
        blocked.display()
    );
    let (pid, exited) = children().spawn(&mut shell(&script)).unwrap();
    let ready = dir.join("blocked.ready");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready.exists() {
        assert!(Instant::now() < deadline, "the child never started");
        std::thread::sleep(Duration::from_millis(10));
    }
    let mask = std::fs::read_to_string(&blocked).unwrap();
    assert!(
        mask.trim_start_matches("SigBlk:")
            .trim()
            .bytes()
            .all(|b| b == b'0'),
        "{mask}"
    );
    children().signal(pid, libc::SIGTERM).unwrap();
    let exit = exited.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(exit, Exit::Code(7), "its own TERM handler ran");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_daemon_that_never_comes_up_is_stopped_to_start_again() {
    let began = Instant::now();
    let (_, started) = start(
        children(),
        &mut shell("exec sleep 1000"),
        Duration::from_millis(300),
        || false,
    )
    .unwrap();
    assert!(
        matches!(started, Started::Ended(Some(Exit::Signal(libc::SIGKILL)))),
        "{started:?}"
    );
    assert!(began.elapsed() < Duration::from_secs(5));

    // One that comes up late, but in time, is up; it ends when it ends.
    let mut asked = 0;
    let (pid, started) = start(
        children(),
        &mut shell("exec sleep 1000"),
        Duration::from_secs(10),
        || {
            asked += 1;
            asked > 3
        },
    )
    .unwrap();
    let Started::Up(exited) = started else {
        panic!("{started:?}");
    };
    children().signal(pid, libc::SIGTERM).unwrap();
    assert_eq!(
        exited.recv_timeout(Duration::from_secs(10)).unwrap(),
        Exit::Signal(libc::SIGTERM)
    );

    // One that ends at once is reported as ended.
    let (_, started) = start(
        children(),
        &mut shell("exit 3"),
        Duration::from_secs(10),
        || false,
    )
    .unwrap();
    assert!(
        matches!(started, Started::Ended(Some(Exit::Code(3)))),
        "{started:?}"
    );
}
