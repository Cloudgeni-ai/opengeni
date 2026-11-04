//! Starting and supervising children, with real processes.

use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use super::agent::{start_program, stream_id};
use super::program::Program;
use super::supervise::{self, Children};
use super::sys::{Exit, Signals};
use super::{Started, start, sys};

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

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("compute-guest-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_script(path: &std::path::Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn run(path: &std::path::Path) -> std::io::Result<(i32, std::sync::mpsc::Receiver<Exit>)> {
    children().spawn(&mut supervise::command(&path.to_string_lossy()))
}

/// The live repro: `mv /usr/local/bin/opengeni-agent …`, then the agent is
/// killed. The init starts it again from the program it kept.
#[test]
fn an_agent_whose_program_was_moved_away_starts_again() {
    let dir = scratch("moved-agent");
    let program = Program::new(
        dir.join("usr/local/bin/agent"),
        dir.join("opengeni/kept/agent"),
    );
    write_script(program.path(), "exit 7");
    program.keep(true).unwrap();
    std::fs::rename(program.path(), dir.join("agent.moved")).unwrap();

    let ((_, exited), file) = start_program(&program, false, run).unwrap();
    assert_eq!(
        exited.recv_timeout(Duration::from_secs(10)).unwrap(),
        Exit::Code(7)
    );
    assert!(file.is_some(), "it started from its usual path");
    assert!(program.holds_kept());
    let _ = std::fs::remove_dir_all(&dir);
}

/// A file that is no program, or a program that keeps ending at once, is
/// replaced with the kept program; a directory in its place is left, and
/// the kept program starts where it is.
#[test]
fn an_agent_whose_program_cannot_start_starts_from_the_kept_one() {
    let dir = scratch("broken-agent");
    let program = Program::new(dir.join("bin/agent"), dir.join("kept/agent"));
    write_script(program.path(), "exit 7");
    program.keep(true).unwrap();

    // A program that cannot start: its interpreter is gone.
    std::fs::remove_file(program.path()).unwrap();
    std::fs::write(program.path(), "#!/nonexistent/sh\n").unwrap();
    std::fs::set_permissions(
        program.path(),
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    assert!(run(program.path()).is_err());
    let ((_, exited), _) = start_program(&program, false, run).unwrap();
    assert_eq!(
        exited.recv_timeout(Duration::from_secs(10)).unwrap(),
        Exit::Code(7)
    );
    assert!(program.holds_kept());

    // One that ends at once each time, put back when its ends are counted.
    write_script(&dir.join("other"), "exit 3");
    std::fs::rename(dir.join("other"), program.path()).unwrap();
    let ((_, exited), _) = start_program(&program, false, run).unwrap();
    assert_eq!(
        exited.recv_timeout(Duration::from_secs(10)).unwrap(),
        Exit::Code(3)
    );
    let ((_, exited), _) = start_program(&program, true, run).unwrap();
    assert_eq!(
        exited.recv_timeout(Duration::from_secs(10)).unwrap(),
        Exit::Code(7)
    );

    // A directory in its place.
    std::fs::remove_file(program.path()).unwrap();
    std::fs::create_dir(program.path()).unwrap();
    let ((_, exited), file) = start_program(&program, false, run).unwrap();
    assert_eq!(
        exited.recv_timeout(Duration::from_secs(10)).unwrap(),
        Exit::Code(7)
    );
    assert!(file.is_none(), "it started where it is kept");
    assert!(program.path().is_dir());
    let _ = std::fs::remove_dir_all(&dir);
}

/// Run in a child process of this test binary, whose root holds nothing,
/// so there is no `/dev/urandom` to open. It writes what it found to
/// `result` in that root.
const NO_DEV_CHILD: &str = "COMPUTE_GUEST_TEST_NO_DEV";

/// The live repro: `/dev/urandom` (and more of `/dev`) removed, then the
/// agent killed. Each connection the new agent makes to its link needs a
/// random stream id, and with none the agent could never reach the host.
#[test]
fn agent_link_streams_get_ids_without_dev_urandom() {
    if std::env::var_os(NO_DEV_CHILD).is_some() {
        let empty = std::env::var(NO_DEV_CHILD).unwrap();
        if !sys::is_root() && sys::become_root_in_namespace().is_err() {
            std::fs::write(format!("{empty}/result"), "skipped").unwrap();
            return;
        }
        sys::enter_root(&empty).unwrap();
        assert!(std::fs::File::open("/dev/urandom").is_err());
        let ids: Vec<_> = (0..4).map(|_| stream_id().unwrap()).collect();
        for (i, id) in ids.iter().enumerate() {
            assert!(ids[i + 1..].iter().all(|other| other != id), "{ids:?}");
        }
        std::fs::write("/result", format!("stream ids without /dev: {ids:?}")).unwrap();
        return;
    }
    let empty = scratch("no-dev");
    let mut child = supervise::command(&std::env::current_exe().unwrap().to_string_lossy());
    child
        .args([
            "--exact",
            "linux::tests::agent_link_streams_get_ids_without_dev_urandom",
            "--test-threads=1",
            "--nocapture",
        ])
        .env(NO_DEV_CHILD, &empty);
    let (_, exited) = children().spawn(&mut child).unwrap();
    let exit = exited.recv_timeout(Duration::from_secs(60)).unwrap();
    let found = std::fs::read_to_string(empty.join("result")).unwrap_or_default();
    assert_eq!(exit, Exit::Code(0), "{found}");
    if found == "skipped" {
        eprintln!("skipping: cannot chroot here");
    } else {
        assert!(found.starts_with("stream ids without /dev"), "{found}");
    }
    let _ = std::fs::remove_dir_all(&empty);
}
