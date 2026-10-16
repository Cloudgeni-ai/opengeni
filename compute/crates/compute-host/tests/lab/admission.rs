//! A full host: a wake it cannot hold is refused as host full, saying what
//! it needs, and succeeds once an idle sandbox can be pushed out to make
//! room, losing nothing of it. VM cgroups get the sandboxes' guarantees.

use compute_host::protocol::ErrorCode;

use super::*;

const MIB: u64 = 1 << 20;

/// Sleeps only when the host needs the room: after an hour otherwise.
const SAVE_WHEN_NEEDED: SleepConfig = SleepConfig {
    pause_after_ms: Some(3_600_000),
    save_after_ms: Some(7_200_000),
    archive_after_ms: None,
    drop_after_ms: None,
    evict_after_ms: None,
    forget_after_ms: None,
    compress: false,
};

/// How long the guests' own background work (a disk flush seconds after a
/// command) may keep an idle sandbox busy, and so not pushed out.
const SETTLE: Duration = Duration::from_secs(30);

async fn hold(client: &Client, sandbox: Id, request: Request) {
    let reply = client.call(&request).await.unwrap();
    assert_eq!(reply, Reply::Done, "{sandbox}: {request:?}");
}

/// The value of `file` in the cgroup of VM `sandbox`.
fn cgroup_value(sandbox: Id, file: &str) -> String {
    let path = Path::new(CGROUP).join(sandbox.to_string()).join(file);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()))
        .trim()
        .to_owned()
}

/// Connects to `sandbox`, expecting the host to be full.
async fn refused(client: &Client, sandbox: Id) -> String {
    match connect(client, sandbox).await {
        Err(message) => message,
        Ok(_) => panic!("{sandbox} woke on a full host"),
    }
}

/// Connects to `sandbox`: the stream, or the host-full message.
async fn connect(
    client: &Client,
    sandbox: Id,
) -> Result<tokio::io::BufReader<tokio::net::UnixStream>, String> {
    let (reply, stream) = client
        .connect(sandbox, PORT, PriorityName::Interactive)
        .await
        .unwrap();
    match reply {
        Reply::Connected { .. } => Ok(stream),
        Reply::Error {
            code: ErrorCode::HostFull,
            message,
        } => Err(message),
        other => panic!("{sandbox}: {other:?}"),
    }
}

/// Runs `script` in `sandbox` once the host has room for it: it may answer
/// host full while the sandboxes it would push out are still busy with
/// work of their own. Returns the output and the refusals before.
async fn exec_when_room(client: &Client, sandbox: Id, script: &str) -> (String, u32) {
    let deadline = Instant::now() + SETTLE;
    let mut refusals = 0;
    let mut stream = loop {
        match connect(client, sandbox).await {
            Ok(stream) => break stream,
            Err(message) => {
                assert!(Instant::now() < deadline, "never made room: {message}");
                refusals += 1;
                sleep(Duration::from_millis(500)).await;
            }
        }
    };
    let mut input = script.to_owned();
    input.push_str("\nexit\n");
    stream.get_mut().write_all(input.as_bytes()).await.unwrap();
    let mut output = String::new();
    stream.read_to_string(&mut output).await.unwrap();
    (output, refusals)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_full_host_says_so_and_makes_room_from_idle_sandboxes() {
    let Some(lab) = lab() else {
        eprintln!("skipped: set COMPUTE_TEST_LAB to run against Firecracker");
        return;
    };
    // Room for two of these 512 MiB sandboxes.
    let host = Host::new(
        &lab,
        "full",
        &["--memory-capacity-mib", "1024", "--busy-window", "1s"],
    );
    let agent = host.start().await;
    let ids: Vec<Id> = (0..3).map(id).collect();
    for sandbox in &ids[..2] {
        agent.create(*sandbox, SAVE_WHEN_NEEDED).await;
    }
    let third = SandboxConfig {
        cpu_request_millis: Some(250),
        ..SandboxConfig::new(1, 512, SAVE_WHEN_NEEDED)
    };
    let reply = agent
        .client
        .call(&Request::Create {
            id: ids[2],
            config: third,
        })
        .await
        .unwrap();
    assert_eq!(reply, Reply::Done);

    // Two sandboxes held awake fill the host.
    for (n, sandbox) in ids[..2].iter().copied().enumerate() {
        let request = Request::Hold {
            id: sandbox,
            generation: None,
            hold: "work".into(),
            ttl_ms: None,
            priority: PriorityName::Interactive,
        };
        hold(&agent.client, sandbox, request).await;
        let script = format!("echo token-{n} > /dev/shm/token; cat /dev/shm/token");
        let (output, _) = exec(&agent.client, sandbox, &script).await;
        assert_eq!(output.trim(), format!("token-{n}"));
    }
    // Each VM's cgroup carries what it is guaranteed.
    assert_eq!(cgroup_value(ids[0], "cpu.weight"), "100");
    assert_eq!(cgroup_value(ids[0], "memory.low"), (512 * MIB).to_string());
    let capacity = agent.status().await.capacity.expect("admission is on");
    assert_eq!(
        (
            capacity.total,
            capacity.reserved,
            capacity.free,
            capacity.awake
        ),
        (1024 * MIB, 1024 * MIB, 0, 2)
    );

    // Nothing idle to push out: the third is refused at once.
    let message = refused(&agent.client, ids[2]).await;
    assert!(
        message.contains(&(512 * MIB).to_string()),
        "says what it needs: {message}"
    );
    let status = agent.status().await;
    let waiting = status
        .sandboxes
        .iter()
        .find(|sandbox| sandbox.id == ids[2])
        .unwrap();
    assert_eq!((waiting.level, waiting.holds), (LevelName::Saved, 0));

    // Released and quiet, the first makes room: the wake goes through.
    let release = Request::Release {
        id: ids[0],
        generation: None,
        hold: "work".into(),
    };
    hold(&agent.client, ids[0], release).await;
    let started = Instant::now();
    let (output, refusals) = exec_when_room(&agent.client, ids[2], "echo third=ok").await;
    assert!(output.contains("third=ok"), "{output}");
    eprintln!(
        "made room and woke in {:?} after {refusals} refusals while the other was busy",
        started.elapsed()
    );
    assert_eq!(cgroup_value(ids[2], "cpu.weight"), "25");
    let status = agent.status().await;
    let first = status
        .sandboxes
        .iter()
        .find(|sandbox| sandbox.id == ids[0])
        .unwrap();
    assert_eq!(first.level, LevelName::Saved, "pushed out to make room");
    assert!(first.memory_saved);

    // Pushed out, it lost nothing: once the third is quiet, it makes room
    // in turn for the first, whose memory comes back as it was.
    let (output, _) = exec_when_room(&agent.client, ids[0], "cat /dev/shm/token").await;
    assert_eq!(output.trim(), "token-0");

    let release = Request::Release {
        id: ids[1],
        generation: None,
        hold: "work".into(),
    };
    hold(&agent.client, ids[1], release).await;
    agent.remove_all().await;
    agent.kill();
    host.finish("full-host");
}
