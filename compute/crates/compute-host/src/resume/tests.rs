use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream as Socket;
use std::path::{Path, PathBuf};

use compute_guest::resume::relay::{Ended, relay};
use tokio::sync::mpsc;
use tokio::task::{JoinHandle, JoinSet};

use super::*;

const WAIT: Duration = Duration::from_secs(10);

type Serve = Box<dyn Fn(DuplexStream) + Send + Sync>;

/// A sandbox's streams behind a socket, and the hub ends they begin.
struct Rig {
    socket: PathBuf,
    hub: mpsc::UnboundedReceiver<DuplexStream>,
    /// The launch each connection let in came in under.
    let_in: mpsc::UnboundedReceiver<Launch>,
    streams: Streams<Serve>,
    clock: RunClock,
    _dir: tempfile::TempDir,
    accept: JoinHandle<()>,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

fn rig(limit: usize, take_up: Duration) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("link.sock");
    let (began, hub) = mpsc::unbounded_channel();
    let clock = RunClock::running();
    let door = Door::new(
        std::os::unix::net::UnixListener::bind(&socket).unwrap(),
        clock.clone(),
    )
    .unwrap();
    let (entered, let_in) = mpsc::unbounded_channel();
    let streams = Streams::new(
        Arc::from("sandbox"),
        Box::new(move |end| {
            let _ = began.send(end);
        }) as Serve,
        limit,
        take_up,
        clock.clone(),
    );
    let serving = streams.clone();
    let accept = tokio::spawn(async move {
        let mut hellos = JoinSet::new();
        loop {
            let (connection, launch) = door.accept().await.unwrap();
            let _ = entered.send(launch);
            hellos.spawn(serving.clone().take(connection, launch));
        }
    });
    Rig {
        socket,
        hub,
        let_in,
        streams,
        clock,
        _dir: dir,
        accept,
    }
}

impl Rig {
    /// The launch the next connection let in came in under.
    async fn next_let_in(&mut self) -> Launch {
        tokio::time::timeout(WAIT, self.let_in.recv())
            .await
            .expect("no connection was let in")
            .unwrap()
    }

    async fn next_stream(&mut self) -> DuplexStream {
        tokio::time::timeout(WAIT, self.hub.recv())
            .await
            .expect("no stream began")
            .unwrap()
    }

    /// Waits until the host has seen the connection under stream `id`
    /// end, as it does a moment after the connection ends.
    async fn until_uncarried(&self, id: u128) {
        let seen = async {
            while self
                .streams
                .inner
                .lock()
                .streams
                .get(&StreamId(id))
                .is_some_and(|entry| entry.shared.lock().carried)
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        };
        tokio::time::timeout(WAIT, seen)
            .await
            .expect("the host never saw the connection end");
    }
}

/// The guest's relay of an agent connection on a thread, its dialed
/// connections kept so a test can end them as a snapshot does.
struct Guest {
    agent: Socket,
    dialed: Arc<Mutex<Vec<Socket>>>,
    ended: std::sync::mpsc::Receiver<Ended>,
}

impl Guest {
    fn start(socket: &Path, id: u128) -> Self {
        let (agent, local) = Socket::pair().unwrap();
        agent.set_read_timeout(Some(WAIT)).unwrap();
        let dialed = Arc::new(Mutex::new(Vec::new()));
        let (done, ended) = std::sync::mpsc::channel();
        let (socket, kept) = (socket.to_path_buf(), Arc::clone(&dialed));
        std::thread::spawn(move || {
            let ended = relay(
                local,
                StreamId(id),
                || {
                    let connection = Socket::connect(&socket)?;
                    kept.lock().unwrap().push(connection.try_clone()?);
                    Ok(connection)
                },
                |_| {},
            );
            let _ = done.send(ended);
        });
        Self {
            agent,
            dialed,
            ended,
        }
    }

    /// Ends every connection under the stream, as a snapshot does.
    fn reset(&self) {
        for connection in self.dialed.lock().unwrap().drain(..) {
            let _ = connection.shutdown(Shutdown::Both);
        }
    }
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    tokio::task::spawn_blocking(work).await.unwrap()
}

async fn read_exactly(end: &mut DuplexStream, length: usize) -> Vec<u8> {
    let mut bytes = vec![0; length];
    tokio::time::timeout(WAIT, end.read_exact(&mut bytes))
        .await
        .expect("the hub end got nothing")
        .unwrap();
    bytes
}

async fn ends_within(end: &mut DuplexStream, limit: Duration) -> bool {
    let mut rest = Vec::new();
    matches!(
        tokio::time::timeout(limit, end.read_to_end(&mut rest)).await,
        Ok(Ok(_))
    )
}

/// A guest connection that speaks the protocol by hand, and the answer
/// to its hello.
fn raw(socket: &Path, hello: &Hello) -> (Socket, String) {
    let mut connection = Socket::connect(socket).unwrap();
    connection.set_read_timeout(Some(WAIT)).unwrap();
    connection.write_all(hello.line().as_bytes()).unwrap();
    let mut line = Vec::new();
    let mut byte = [0];
    while connection.read(&mut byte).unwrap() == 1 {
        line.push(byte[0]);
        if byte[0] == b'\n' {
            break;
        }
    }
    (connection, String::from_utf8(line).unwrap())
}

async fn raw_hello(rig: &Rig, id: u128, received: u64, sent: u64) -> (Socket, String) {
    let socket = rig.socket.clone();
    let hello = Hello {
        id: StreamId(id),
        received,
        sent,
    };
    blocking(move || raw(&socket, &hello)).await
}

fn data(offset: u64, bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    Frame::Data { offset, bytes }.encode(&mut out);
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stream_outlives_the_connections_under_it_and_the_hub_sees_one() {
    let mut rig = rig(4, TAKE_UP);
    let guest = Guest::start(&rig.socket, 1);
    let mut agent = guest.agent.try_clone().unwrap();
    blocking(move || agent.write_all(b"CONNECT {}\r\nPING\r\n").unwrap()).await;
    let mut end = rig.next_stream().await;
    assert_eq!(read_exactly(&mut end, 18).await, b"CONNECT {}\r\nPING\r\n");

    // A snapshot ends the connection; what the agent and the hub send
    // crosses on the next one, each byte once, and no stream begins.
    for round in 0..3_u8 {
        guest.reset();
        let mut agent = guest.agent.try_clone().unwrap();
        let sent = vec![b'a' + round; 300_000];
        let expected = sent.clone();
        blocking(move || agent.write_all(&sent).unwrap()).await;
        assert_eq!(read_exactly(&mut end, 300_000).await, expected);
        let reply = vec![b'z' - round; 70_000];
        end.write_all(&reply).await.unwrap();
        let mut agent = guest.agent.try_clone().unwrap();
        let got = blocking(move || {
            let mut got = vec![0; 70_000];
            agent.read_exact(&mut got).unwrap();
            got
        })
        .await;
        assert_eq!(got, reply);
    }
    assert!(rig.hub.try_recv().is_err(), "one stream throughout");

    // The agent hangs up, then the hub: the stream finishes.
    guest.agent.shutdown(Shutdown::Write).unwrap();
    assert!(ends_within(&mut end, WAIT).await);
    drop(end);
    let ended = blocking(move || guest.ended.recv_timeout(WAIT)).await;
    assert_eq!(ended, Ok(Ended::Finished));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_guest_the_host_cannot_go_on_with_is_told_gone_and_the_hub_end_closes() {
    let mut rig = rig(4, TAKE_UP);
    let (mut connection, answer) = raw_hello(&rig, 7, 0, 0).await;
    assert_eq!(answer, "ok 0\n");
    connection.write_all(&data(0, b"abc")).unwrap();
    let mut end = rig.next_stream().await;
    assert_eq!(read_exactly(&mut end, 3).await, b"abc");

    // Restored from before it sent "abc": the host cannot take it back.
    let (_, answer) = raw_hello(&rig, 7, 0, 1).await;
    assert_eq!(answer, "gone\n");
    assert!(ends_within(&mut end, WAIT).await, "the hub's end went too");

    // A stream the host never had, with something received, is gone.
    let (_, answer) = raw_hello(&rig, 8, 5, 5).await;
    assert_eq!(answer, "gone\n");
    assert!(rig.hub.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn streams_not_taken_up_again_end_and_those_taken_up_go_on() {
    let take_up = Duration::from_millis(300);
    let mut rig = rig(4, take_up);
    let mut ends = Vec::new();
    for id in [1, 2] {
        let (connection, answer) = raw_hello(&rig, id, 0, 0).await;
        assert_eq!(answer, "ok 0\n");
        ends.push(rig.next_stream().await);
        drop(connection);
    }
    // Both ends seen before the take-up, as after a restore: the
    // guest is launched anew, and only its take-up starts the window.
    rig.until_uncarried(1).await;
    rig.until_uncarried(2).await;
    rig.clock.launched().unwrap();
    let (mut kept, answer) = raw_hello(&rig, 1, 0, 0).await;
    assert_eq!(answer, "ok 0\n");
    let mut not_taken_up = ends.pop().unwrap();
    let mut resumed = ends.pop().unwrap();
    assert!(ends_within(&mut not_taken_up, take_up * 10).await);
    resumed.write_all(b"still").await.unwrap();
    let frame = blocking(move || {
        let mut frame = vec![0; 13 + 5];
        kept.read_exact(&mut frame).unwrap();
        frame
    })
    .await;
    assert_eq!(frame, data(0, b"still"));
}

/// A stream whose connection the host sees end only after the guest,
/// launched anew, took another up (a reset that reaches the host after
/// the guest's new hello) ends on a window of its own, with no take-up
/// after it: the guest that took one up takes up every stream it has
/// at once, and the hub must not keep a connection no agent holds.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stream_seen_uncarried_after_a_take_up_ends_on_its_own() {
    let take_up = Duration::from_millis(300);
    let mut rig = rig(4, take_up);
    let mut connections = Vec::new();
    let mut ends = Vec::new();
    for id in [1, 2] {
        let (connection, answer) = raw_hello(&rig, id, 0, 0).await;
        assert_eq!(answer, "ok 0\n");
        connections.push(connection);
        ends.push(rig.next_stream().await);
    }
    let late = connections.pop().unwrap();
    drop(connections.pop().unwrap());
    rig.until_uncarried(1).await;
    rig.clock.launched().unwrap();
    let (mut first, answer) = raw_hello(&rig, 1, 0, 0).await;
    assert_eq!(answer, "ok 0\n");
    // Past that take-up's window: only the end seen after it is left.
    tokio::time::sleep(take_up * 2).await;
    drop(late);
    rig.until_uncarried(2).await;
    let mut not_taken_up = ends.pop().unwrap();
    assert!(ends_within(&mut not_taken_up, take_up * 10).await);
    // The stream taken up goes on.
    let mut kept = ends.pop().unwrap();
    kept.write_all(b"still").await.unwrap();
    let frame = blocking(move || {
        let mut frame = vec![0; 13 + 5];
        first.read_exact(&mut frame).unwrap();
        frame
    })
    .await;
    assert_eq!(frame, data(0, b"still"));
}

/// A guest launched anew has yet to prove it runs, as its memory may
/// still be coming in: streams whose connections ended before it
/// connected stay, however long it takes, windows begun before the
/// launch lapse, and an end seen before its first take-up begins none.
/// Its first take-up's window ends those it does not take up.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_guest_launched_anew_keeps_its_streams_until_it_takes_one_up() {
    let take_up = Duration::from_millis(300);
    let mut rig = rig(4, take_up);
    let mut connections = Vec::new();
    let mut ends = Vec::new();
    for id in [1, 2, 3] {
        let (connection, answer) = raw_hello(&rig, id, 0, 0).await;
        assert_eq!(answer, "ok 0\n");
        connections.push(connection);
        ends.push(rig.next_stream().await);
    }
    // Two ends seen while the guest that took them up still ran: each
    // begins a window, which the launch after them ends.
    let third = connections.pop().unwrap();
    connections.clear();
    rig.until_uncarried(1).await;
    rig.until_uncarried(2).await;
    rig.clock.launched().unwrap();
    // One seen after the launch, before the new guest connects.
    drop(third);
    rig.until_uncarried(3).await;
    for end in &mut ends {
        assert!(
            !ends_within(end, take_up * 2).await,
            "a stream ended before its new guest connected"
        );
    }
    let (_kept, answer) = raw_hello(&rig, 1, 0, 0).await;
    assert_eq!(answer, "ok 0\n");
    assert!(ends_within(&mut ends[1], take_up * 10).await);
    assert!(ends_within(&mut ends[2], take_up * 10).await);
    assert!(
        !ends_within(&mut ends[0], take_up).await,
        "the stream taken up goes on"
    );
}

/// A connection the VM process before made, let in but its hello not yet
/// read when the next is launched, is closed unanswered: it says nothing
/// of the new guest, which has yet to prove it runs, so it begins no
/// window and takes no stream over.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_connection_from_an_earlier_vm_process_is_closed_unanswered() {
    let take_up = Duration::from_millis(300);
    let mut rig = rig(4, take_up);
    let mut ends = Vec::new();
    for id in [1, 2] {
        let (connection, answer) = raw_hello(&rig, id, 0, 0).await;
        assert_eq!(answer, "ok 0\n");
        assert_eq!(rig.next_let_in().await, Launch(0));
        ends.push(rig.next_stream().await);
        drop(connection);
    }
    rig.until_uncarried(1).await;
    rig.until_uncarried(2).await;
    let mut stale = Socket::connect(&rig.socket).unwrap();
    stale.set_read_timeout(Some(WAIT)).unwrap();
    assert_eq!(rig.next_let_in().await, Launch(0));
    rig.clock.launched().unwrap();
    let hello = Hello {
        id: StreamId(1),
        received: 0,
        sent: 0,
    };
    let answer = blocking(move || {
        stale.write_all(hello.line().as_bytes()).unwrap();
        let mut answer = Vec::new();
        stale.read_to_end(&mut answer).unwrap();
        answer
    })
    .await;
    assert!(
        answer.is_empty(),
        "an earlier VM process's connection was answered"
    );
    for end in &mut ends {
        assert!(
            !ends_within(end, take_up * 3).await,
            "a stream ended on an earlier VM process's hello"
        );
    }
    // The new guest's take-up begins the window.
    let (_kept, answer) = raw_hello(&rig, 1, 0, 0).await;
    assert_eq!(answer, "ok 0\n");
    assert_eq!(rig.next_let_in().await, Launch(1));
    assert!(ends_within(&mut ends[1], take_up * 10).await);
    assert!(
        !ends_within(&mut ends[0], take_up).await,
        "the stream taken up goes on"
    );
}

/// The connections still waiting to be let in when the sandbox's VM is
/// launched anew are an earlier VM process's: the launch closes them, and
/// the next is let in as of the new launch.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_launch_closes_the_connections_still_waiting_at_the_door() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("link.sock");
    let clock = RunClock::running();
    let door = Door::new(
        std::os::unix::net::UnixListener::bind(&socket).unwrap(),
        clock.clone(),
    )
    .unwrap();
    let mut waiting = Socket::connect(&socket).unwrap();
    waiting.set_read_timeout(Some(WAIT)).unwrap();
    clock.launched().unwrap();
    let read = blocking(move || waiting.read_to_end(&mut Vec::new()).unwrap()).await;
    assert_eq!(read, 0, "a waiting connection was not closed");
    let _next = Socket::connect(&socket).unwrap();
    let (_, launch) = tokio::time::timeout(WAIT, door.accept())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(launch, Launch(1));
}

/// A launch that cannot close the connections waiting at the door is not
/// counted, and fails: one left waiting would be let in as the new
/// launch's.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_launch_that_cannot_close_the_waiting_connections_fails() {
    let (clock, _door) = RunClock::with_broken_door();
    assert!(clock.launched().is_err());
    assert_eq!(clock.launches(), 0);
}

/// A window asked for while a sweep waits never replaces a later one, so
/// ends seen out of the order of their times still leave the latest
/// window, which covers every stream the earlier would end.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_waiting_window_never_moves_back() {
    let rig = rig(4, Duration::from_secs(60));
    let at = |millis| At {
        time: Duration::from_millis(millis),
        launch: 0,
    };
    let inner = &rig.streams.inner;
    let mut map = inner.lock();
    sweep_later(inner, &mut map, at(10));
    sweep_later(inner, &mut map, at(30));
    sweep_later(inner, &mut map, at(20));
    assert_eq!(map.next_sweep, Some(at(30)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sandbox_may_hold_only_so_many_streams() {
    let mut rig = rig(2, TAKE_UP);
    let mut held = Vec::new();
    for id in 1..=3 {
        let (connection, answer) = raw_hello(&rig, id, 0, 0).await;
        assert_eq!(answer, if id <= 2 { "ok 0\n" } else { "gone\n" });
        held.push(connection);
    }
    rig.next_stream().await;
    rig.next_stream().await;
    assert!(rig.hub.try_recv().is_err());
}

/// The next frame on a raw guest connection.
fn next_frame(connection: &mut Socket) -> Vec<u8> {
    let mut pending = Vec::new();
    let mut buffer = vec![0; CHUNK + 16];
    loop {
        if let Some((_, length)) = Frame::decode(&pending).unwrap() {
            pending.truncate(length);
            return pending;
        }
        let read = connection.read(&mut buffer).unwrap();
        assert!(read > 0, "the host ended the connection");
        pending.extend_from_slice(&buffer[..read]);
    }
}

fn ack(through: u64) -> Vec<u8> {
    let mut out = Vec::new();
    Frame::Ack(through).encode(&mut out);
    out
}

/// A guest whose window is full sends nothing more until it hears an
/// acknowledgement, so the host repeats on a new connection the one
/// it may have lost with the connection before.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_acknowledgement_lost_with_its_connection_is_repeated_on_the_next() {
    const WINDOW: u64 = compute_guest::resume::stream::WINDOW as u64;
    let mut rig = rig(4, TAKE_UP);
    let (mut connection, answer) = raw_hello(&rig, 9, 0, 0).await;
    assert_eq!(answer, "ok 0\n");
    let writing = tokio::task::spawn_blocking(move || {
        let mut offset = 0;
        while offset < WINDOW {
            let length = CHUNK.min(usize::try_from(WINDOW - offset).unwrap());
            connection
                .write_all(&data(offset, &vec![7; length]))
                .unwrap();
            offset += length as u64;
        }
        connection
    });
    let mut end = rig.next_stream().await;
    let window = usize::try_from(WINDOW).unwrap();
    assert_eq!(read_exactly(&mut end, window).await, vec![7; window]);
    // The connection ends before the guest reads the acknowledgement.
    writing.await.unwrap().shutdown(Shutdown::Both).unwrap();

    let (mut connection, answer) = raw_hello(&rig, 9, 0, WINDOW).await;
    assert_eq!(answer, format!("ok {WINDOW}\n"));
    let frame = blocking(move || next_frame(&mut connection)).await;
    assert_eq!(frame, ack(WINDOW));
}

/// A connection another took the stream over from reads nothing more
/// into it, whatever it still has: aborting its task is no fence, as
/// the task may be past its last wait.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_connection_taken_over_reads_nothing_more_into_the_stream() {
    let mut rig = rig(4, TAKE_UP);
    let (first, answer) = raw_hello(&rig, 10, 0, 0).await;
    assert_eq!(answer, "ok 0\n");
    let mut end = rig.next_stream().await;
    let shared = Arc::clone(&rig.streams.inner.lock().streams[&StreamId(10)].shared);
    let old = shared.lock().carrier;
    // A restored guest says hello again, having sent nothing.
    let (mut second, answer) = raw_hello(&rig, 10, 0, 0).await;
    assert_eq!(answer, "ok 0\n");
    drop(first);
    // What the connection before still had, read after the take-over.
    let (mut late, reader) = tokio::io::duplex(1024);
    late.write_all(&data(0, b"OLD")).await.unwrap();
    drop(late);
    read_frames(
        reader,
        Arc::clone(&shared),
        old,
        Arc::downgrade(&rig.streams.inner),
        StreamId(10),
    )
    .await;
    assert_eq!(shared.lock().stream.received(), 0);
    blocking(move || second.write_all(&data(0, b"NEW")).unwrap()).await;
    assert_eq!(read_exactly(&mut end, 3).await, b"NEW");
}

/// A sandbox at its limit whose streams no connection carries, none
/// taken up since, still ends those its guest no longer has: the next
/// fresh connection is refused, but starts the sweep, and one after
/// it is let in.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sandbox_at_its_limit_still_ends_streams_its_guest_no_longer_has() {
    let take_up = Duration::from_millis(300);
    let mut rig = rig(2, take_up);
    let mut held = Vec::new();
    for id in [1, 2] {
        let (connection, answer) = raw_hello(&rig, id, 0, 0).await;
        assert_eq!(answer, "ok 0\n");
        held.push((connection, rig.next_stream().await));
    }
    let mut ends = Vec::new();
    for (connection, end) in held {
        drop(connection);
        ends.push(end);
    }
    rig.until_uncarried(1).await;
    rig.until_uncarried(2).await;
    // Restored: past the windows begun before the launch.
    rig.clock.launched().unwrap();
    tokio::time::sleep(take_up * 2).await;
    let (_, answer) = raw_hello(&rig, 3, 0, 0).await;
    assert_eq!(answer, "gone\n");
    for end in &mut ends {
        assert!(ends_within(end, take_up * 10).await);
    }
    let (_, answer) = raw_hello(&rig, 4, 0, 0).await;
    assert_eq!(answer, "ok 0\n");
}

/// Time the guest cannot run does not count against the streams it
/// has yet to take up: paused just after taking one up, it takes the
/// other up once it runs again, however long the pause.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_guest_paused_mid_take_up_keeps_the_streams_it_has_yet_to_take_up() {
    let take_up = Duration::from_millis(300);
    let mut rig = rig(4, take_up);
    let mut held = Vec::new();
    for id in [1, 2] {
        let (connection, answer) = raw_hello(&rig, id, 0, 0).await;
        assert_eq!(answer, "ok 0\n");
        held.push((connection, rig.next_stream().await));
    }
    tokio::time::sleep(take_up * 2).await;
    let mut ends = Vec::new();
    for (connection, end) in held {
        drop(connection);
        ends.push(end);
    }
    rig.until_uncarried(1).await;
    rig.until_uncarried(2).await;
    rig.clock.launched().unwrap();
    let (_kept, answer) = raw_hello(&rig, 1, 0, 0).await;
    assert_eq!(answer, "ok 0\n");
    rig.clock.set(false);
    assert!(
        !ends_within(&mut ends[1], take_up * 4).await,
        "a paused guest's stream is kept"
    );
    rig.clock.set(true);
    let (_resumed, answer) = raw_hello(&rig, 2, 0, 0).await;
    assert_eq!(answer, "ok 0\n");
}

/// A sandbox's streams that go while its guest cannot run take their
/// sweep with them: it does not wait on a clock that may never run
/// again.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_sweep_ends_with_the_sandboxs_streams() {
    let rig = rig(4, Duration::from_millis(300));
    let (connection, answer) = raw_hello(&rig, 1, 0, 0).await;
    assert_eq!(answer, "ok 0\n");
    rig.clock.set(false);
    let clock = rig.clock.clone();
    drop((rig, connection));
    let deadline = tokio::time::Instant::now() + WAIT;
    while Arc::strong_count(&clock.inner) > 1 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "something still waits on the clock"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
