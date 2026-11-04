//! Starting and supervising children, with real processes.

use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use super::agent::{Proving, ended_at_once, start_program, stream_id, wait_keeping};
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

fn write_program(path: &std::path::Path, bytes: &[u8]) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// Starts `command` as a child, again while its program is busy: a test
/// on another thread may have forked while this one wrote the program, and
/// that child holds it open for writing until it execs.
fn spawn_child(
    command: &mut std::process::Command,
) -> std::io::Result<(i32, std::sync::mpsc::Receiver<Exit>)> {
    let mut tries = 0;
    loop {
        match children().spawn(command) {
            Err(error) if error.raw_os_error() == Some(libc::ETXTBSY) && tries < 100 => {
                tries += 1;
                std::thread::sleep(Duration::from_millis(10));
            }
            spawned => return spawned,
        }
    }
}

fn run(path: &std::path::Path) -> std::io::Result<(i32, std::sync::mpsc::Receiver<Exit>)> {
    spawn_child(&mut supervise::command(&path.to_string_lossy()))
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

/// Set in a child process of this test binary, which can open no file, as
/// with `/dev/urandom` removed; it ends with [`PASSED`] once it passed.
const NO_FILES_CHILD: &str = "COMPUTE_GUEST_TEST_NO_FILES";
const PASSED: i32 = 42;

/// The live repro: `/dev/urandom` (and more of `/dev`) removed, then the
/// agent killed. Each connection the new agent makes to its link needs a
/// random stream id, and with none the agent could never reach the host.
/// Runs as any user: the child may open no file at all.
#[test]
fn agent_link_streams_get_ids_without_dev_urandom() {
    if std::env::var_os(NO_FILES_CHILD).is_some() {
        let none = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: a valid limit that outlives the call.
        assert_eq!(
            unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raw const none) },
            0
        );
        assert!(std::fs::File::open("/dev/urandom").is_err());
        let ids: Vec<_> = (0..4).map(|_| stream_id().unwrap()).collect();
        for (i, id) in ids.iter().enumerate() {
            assert!(ids[i + 1..].iter().all(|other| other != id), "{ids:?}");
        }
        std::process::exit(PASSED);
    }
    let mut child = supervise::command(&std::env::current_exe().unwrap().to_string_lossy());
    child
        .args([
            "--exact",
            "linux::tests::agent_link_streams_get_ids_without_dev_urandom",
            "--test-threads=1",
            "--nocapture",
        ])
        .env(NO_FILES_CHILD, "1");
    let (_, exited) = spawn_child(&mut child).unwrap();
    let exit = exited.recv_timeout(Duration::from_secs(60)).unwrap();
    assert_eq!(exit, Exit::Code(PASSED), "the child's output is above");
}

/// The agent updates itself: it renames its new program over its usual
/// path, then execs it as the same process. The init keeps the new one
/// once it has run a whole period, so a later move and kill puts back the
/// update, not the program from boot.
#[test]
fn a_self_update_the_agent_execs_is_kept_once_it_has_run() {
    let dir = scratch("self-update");
    let program = Program::new(dir.join("bin/agent"), dir.join("kept/agent"));
    let shell = std::fs::read("/bin/sh").unwrap();
    // The shell, told apart by what follows it, which it never reads.
    let version = |tag: &str| {
        let mut bytes = shell.clone();
        bytes.extend_from_slice(format!("\nopengeni-agent {tag}\n").as_bytes());
        bytes
    };
    write_program(program.path(), &version("1"));
    program.keep(true).unwrap();
    write_program(&dir.join("next"), &version("2"));
    let updated = dir.join("updated");
    let path = program.path().to_string_lossy().into_owned();
    let ((pid, exited), file) = start_program(&program, false, |at| {
        spawn_child(supervise::command(&at.to_string_lossy()).args([
            "-c",
            // The new program goes on running itself, whichever shell it is.
            "while [ ! -e \"$1\" ]; do sleep 0.02; done; exec \"$0\" -c 'while :; do sleep 1; done'",
            &path,
            &updated.to_string_lossy(),
        ]))
    })
    .unwrap();
    assert!(file.is_some());
    std::fs::rename(dir.join("next"), program.path()).unwrap();
    std::fs::write(&updated, "").unwrap();
    let watcher = std::thread::spawn({
        let kept = program.kept().to_owned();
        let wanted = version("2");
        move || {
            let deadline = Instant::now() + Duration::from_secs(20);
            let found = loop {
                if std::fs::read(&kept).is_ok_and(|bytes| bytes == wanted) {
                    break true;
                }
                if Instant::now() > deadline {
                    break false;
                }
                std::thread::sleep(Duration::from_millis(20));
            };
            children().signal(pid, libc::SIGKILL).unwrap();
            found
        }
    });
    let exit = wait_keeping(&program, pid, file, &exited, Duration::from_millis(100));
    assert_eq!(exit, Some(Exit::Signal(libc::SIGKILL)));
    assert!(watcher.join().unwrap(), "the update was never kept");
    assert_eq!(std::fs::read(program.kept()).unwrap(), version("2"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_program_run_a_whole_period_from_its_path_is_kept_once() {
    let (boot, update) = ((1, 10), (1, 11));
    // What a reboot starts, kept a period later, and only once.
    let mut proving = Proving::new(Some(boot));
    assert_eq!(proving.proven(Some(boot), Some(boot)), Some(boot));
    proving.kept(boot);
    assert_eq!(proving.proven(Some(boot), Some(boot)), None);
    // A self-update: not until it has run a whole period.
    assert_eq!(proving.proven(Some(update), Some(update)), None);
    assert_eq!(proving.proven(Some(update), Some(update)), Some(update));
    // One no longer at the usual path is never kept.
    let mut proving = Proving::new(Some(boot));
    assert_eq!(proving.proven(Some(boot), Some(update)), None);
    assert_eq!(proving.proven(Some(boot), None), None);
    // Nor one started from where it is kept.
    let mut proving = Proving::new(None);
    assert_eq!(proving.proven(None, None), None);
}

/// Failing to start for want of memory or processes says nothing about the
/// program: it is left as it is, to be tried again, and never swapped for
/// the older kept one.
#[test]
fn an_agent_that_cannot_start_for_want_of_resources_keeps_its_program() {
    let dir = scratch("no-resources");
    let program = Program::new(dir.join("bin/agent"), dir.join("kept/agent"));
    write_script(program.path(), "exit 7");
    program.keep(true).unwrap();
    write_script(&dir.join("newer"), "exit 3");
    std::fs::rename(dir.join("newer"), program.path()).unwrap();
    let mut tries = 0;
    let error = start_program(&program, false, |_| {
        tries += 1;
        Err::<(), _>(std::io::Error::from_raw_os_error(libc::EAGAIN))
    })
    .unwrap_err();
    assert_eq!(error.raw_os_error(), Some(libc::EAGAIN));
    assert_eq!(tries, 1);
    assert!(!program.holds_kept());
    assert_eq!(
        std::fs::read_to_string(program.path()).unwrap(),
        "#!/bin/sh\nexit 3\n"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn only_an_agent_ending_at_once_of_its_own_counts_toward_putting_back_the_kept_one() {
    let soon = Duration::from_secs(1);
    assert!(ended_at_once(Some(Exit::Code(0)), soon));
    assert!(ended_at_once(Some(Exit::Code(1)), soon));
    assert!(ended_at_once(Some(Exit::Signal(libc::SIGSEGV)), soon));
    // The init stopping an agent with old settings, and `pkill`.
    assert!(!ended_at_once(Some(Exit::Signal(libc::SIGTERM)), soon));
    assert!(!ended_at_once(Some(Exit::Signal(libc::SIGKILL)), soon));
    // It did not start.
    assert!(!ended_at_once(None, soon));
    assert!(!ended_at_once(Some(Exit::Code(1)), Duration::from_secs(30)));
}

/// Set (as CI sets it) to run a test that needs root again under `sudo -n`.
const SUDO: &str = "COMPUTE_GUEST_TEST_SUDO";

/// Whether the test `name` (its path in this binary) runs here: when this
/// process is root. Otherwise, with [`SUDO`] set, it runs again under
/// `sudo -n` and must pass there; else it is skipped, and says so.
pub(super) fn as_root(name: &str) -> bool {
    if sys::is_root() {
        return true;
    }
    if std::env::var_os(SUDO).is_none() {
        eprintln!("skipping {name}: it needs root (set {SUDO}=1 to run it with sudo -n)");
        return false;
    }
    let dir = scratch(&format!(
        "as-root-{}",
        name.rsplit("::").next().unwrap_or(name)
    ));
    let output = dir.join("output");
    let sudo = |args: &[&str]| {
        let file = std::fs::File::create(&output).unwrap();
        let mut command = supervise::command("sudo");
        command
            .arg("-n")
            .args(args)
            .stdin(std::process::Stdio::null())
            .stderr(file.try_clone().unwrap())
            .stdout(file);
        spawn_child(&mut command).map(|(_, exited)| exited.recv_timeout(Duration::from_secs(120)))
    };
    let exe = std::env::current_exe().unwrap();
    let ran = sudo(&[
        &exe.to_string_lossy(),
        "--exact",
        name,
        "--test-threads=1",
        "--nocapture",
    ]);
    let said = std::fs::read_to_string(&output).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&dir);
    assert!(
        matches!(ran, Ok(Ok(Exit::Code(0)))),
        "{name} as root: {ran:?}\n{said}"
    );
    assert!(
        said.contains("1 passed"),
        "{name} as root ran no test:\n{said}"
    );
    false
}
