//! A disk the agent cannot read at once never holds up the agent (#6976).
//!
//! On a pressed XFS host, reading which of a disk's extents it shares
//! (FIEMAP) waits on the allocation group's lock, behind the saves that
//! write meanwhile, for seconds at a time. The agent read every disk at
//! rest, and every running disk, on its own loop, once a sample: it then
//! answered nothing, not even what the host can take on, and the lease's
//! watchdog stopped it as stuck. Here a disk is a named pipe, whose open
//! waits for a writer, so a read of it waits until the test ends it.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::mpsc::RecvTimeoutError;
use std::time::Duration;

use compute_core::HostPolicy;
use compute_host::client::Client;
use compute_host::protocol::{Id, LevelName, PriorityName, Reply, Request};
use tokio::time::{sleep, timeout};

use super::{Delays, Lab, NEVER, id};

/// How long the agent may take to answer while a disk cannot be read:
/// many samples, and far less than the lease's watchdog waits.
const ANSWERS_WITHIN: Duration = Duration::from_secs(3);

/// How long a whole test here may take. An agent that waits on the disk
/// holds up the workers of its runtime, and with them every timer the
/// test runs on that runtime, so the test is watched from outside it.
const TEST_WITHIN: Duration = Duration::from_secs(90);

/// Runs `test` on a runtime of its own, and fails unless it ends within
/// [`TEST_WITHIN`]: a stuck agent fails the test instead of hanging it.
pub(super) fn within<F, T>(test: F)
where
    F: FnOnce() -> T + Send + 'static,
    T: Future<Output = ()>,
{
    let (done, ended) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .unwrap();
        let outcome =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| runtime.block_on(test())));
        // Reads still waiting on a pipe end with the process.
        runtime.shutdown_background();
        let _ = done.send(outcome.err().map(|failure| {
            failure
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| failure.downcast_ref::<&str>().map(ToString::to_string))
                .unwrap_or_default()
        }));
    });
    match ended.recv_timeout(TEST_WITHIN) {
        Ok(None) => {}
        Ok(Some(failure)) => panic!("{failure}"),
        Err(RecvTimeoutError::Timeout) => {
            panic!("the test did not end: the agent waited on a disk it could not read")
        }
        Err(RecvTimeoutError::Disconnected) => panic!("the test's thread ended without a word"),
    }
}

/// A disk swapped for a named pipe, so whatever opens it to read waits;
/// dropped, it puts the disk back and lets those reads go on, failing.
pub(super) struct Stuck {
    path: PathBuf,
    kept: PathBuf,
}

impl Stuck {
    /// Sandbox `sandbox`'s disk in `lab`, stuck.
    fn disk(lab: &Lab, sandbox: Id) -> Self {
        Self::at(&lab.sandbox_dir(sandbox).join("root/disk.ext4"))
    }

    /// The disk at `path`, stuck.
    pub(super) fn at(path: &Path) -> Self {
        let path = path.to_path_buf();
        let kept = path.with_extension("kept");
        std::fs::rename(&path, &kept).unwrap();
        rustix::fs::mknodat(
            rustix::fs::CWD,
            &path,
            rustix::fs::FileType::Fifo,
            rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
            0,
        )
        .unwrap();
        Self { path, kept }
    }
}

impl Drop for Stuck {
    fn drop(&mut self) {
        // Held open for both reading and writing, the pipe has a writer:
        // every open waiting on it ends, and none that comes later waits.
        // Then the disk goes back, and the pipe once no open can still
        // come to it.
        let held = rustix::fs::open(
            &self.path,
            rustix::fs::OFlags::RDWR | rustix::fs::OFlags::NONBLOCK,
            rustix::fs::Mode::empty(),
        );
        let pipe = self.path.with_extension("pipe");
        let _ = std::fs::rename(&self.path, &pipe);
        let _ = std::fs::rename(&self.kept, &self.path);
        std::thread::sleep(Duration::from_millis(200));
        drop(held);
        let _ = std::fs::remove_file(&pipe);
    }
}

/// Asks for a status from a thread and runtime of its own, and fails
/// unless it is answered within [`ANSWERS_WITHIN`]: a loop that waits on
/// a disk holds up its runtime's worker, and with it whatever that worker
/// was to run next, the asking test too.
fn answers(lab: &Lab, while_: &str) {
    let socket = lab.root.join("host.sock");
    let (answered, answer) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let status = runtime.block_on(Client::new(&socket).call(&Request::Status));
        let _ = answered.send(matches!(status, Ok(Reply::Status(_))));
    });
    assert!(
        answer.recv_timeout(ANSWERS_WITHIN) == Ok(true),
        "the agent did not answer while {while_}"
    );
}

#[test]
fn a_disk_at_rest_that_cannot_be_read_holds_up_nothing() {
    within(a_disk_at_rest_that_cannot_be_read_holds_up_nothing_in);
}

async fn a_disk_at_rest_that_cannot_be_read_holds_up_nothing_in() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let (resting, other) = (id(1), id(2));
    lab.create(resting, NEVER).await;
    assert_eq!(lab.sleep_to(resting, LevelName::Saved).await, Reply::Done);
    lab.wait_level(resting, LevelName::Saved).await;

    let stuck = Stuck::disk(&lab, resting);
    // Many samples, each of which reads the disk at rest.
    for _ in 0..20 {
        answers(&lab, "a disk at rest could not be read");
        sleep(Duration::from_millis(25)).await;
    }
    // And it still does its work: another sandbox is made and runs.
    assert!(
        timeout(ANSWERS_WITHIN, lab.create(other, NEVER))
            .await
            .is_ok(),
        "a create waited on a disk at rest that could not be read"
    );
    assert!(matches!(lab.wake(other).await, Reply::Woken { .. }));
    lab.wait_level(other, LevelName::Running).await;
    drop(stuck);
    // Readable again, the disk at rest wakes as ever.
    assert!(matches!(lab.wake(resting).await, Reply::Woken { .. }));
    lab.wait_level(resting, LevelName::Running).await;
    lab.assert_clean();
}

#[test]
fn a_running_disk_that_cannot_be_read_holds_up_nothing() {
    within(a_running_disk_that_cannot_be_read_holds_up_nothing_in);
}

async fn a_running_disk_that_cannot_be_read_holds_up_nothing_in() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let (running, other) = (id(1), id(2));
    lab.create(running, NEVER).await;
    assert!(matches!(lab.wake(running).await, Reply::Woken { .. }));
    lab.wait_level(running, LevelName::Running).await;

    let stuck = Stuck::disk(&lab, running);
    // Many samples, each of which reads the running disk.
    for _ in 0..20 {
        answers(&lab, "a running disk could not be read");
        sleep(Duration::from_millis(25)).await;
    }
    assert!(
        timeout(ANSWERS_WITHIN, lab.create(other, NEVER))
            .await
            .is_ok(),
        "a create waited on a running disk that could not be read"
    );
    assert!(matches!(lab.wake(other).await, Reply::Woken { .. }));
    lab.wait_level(other, LevelName::Running).await;
    drop(stuck);
    answers(&lab, "the disk was readable again");
    lab.assert_clean();
}

/// A wake of a sandbox whose disk at rest cannot be read waits for that
/// disk a bounded time at most: it is booked at all it may take, and the
/// agent answers meanwhile.
#[test]
fn a_wake_of_a_disk_at_rest_that_cannot_be_read_holds_up_nothing() {
    within(a_wake_of_a_disk_at_rest_that_cannot_be_read_holds_up_nothing_in);
}

async fn a_wake_of_a_disk_at_rest_that_cannot_be_read_holds_up_nothing_in() {
    let lab = Lab::new(Delays::default(), HostPolicy::default()).await;
    let resting = id(1);
    lab.create(resting, NEVER).await;
    assert_eq!(lab.sleep_to(resting, LevelName::Saved).await, Reply::Done);
    lab.wait_level(resting, LevelName::Saved).await;

    let stuck = Stuck::disk(&lab, resting);
    // Asked from a thread of its own: its answer may wait for the disk.
    let socket = lab.root.join("host.sock");
    let (woke, woken) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let request = Request::Wake {
            id: resting,
            generation: None,
            priority: PriorityName::Interactive,
        };
        let _ = woke.send(runtime.block_on(Client::new(&socket).call(&request)));
    });
    for _ in 0..20 {
        answers(&lab, "a wake's disk at rest could not be read");
        std::thread::sleep(Duration::from_millis(25));
    }
    drop(stuck);
    let reply = woken
        .recv_timeout(Duration::from_secs(30))
        .expect("the wake was not answered once its disk could be read");
    assert!(matches!(reply, Ok(Reply::Woken { .. })), "{reply:?}");
    lab.wait_level(resting, LevelName::Running).await;
    lab.assert_clean();
}
