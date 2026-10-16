//! A full host: a wake it cannot hold is refused at once as host full,
//! saying what it needs, and goes through as soon as an idle sandbox is
//! paused and saved, whose VM then ends at once to make room, losing
//! nothing. VM cgroups get the sandboxes' guarantees.

use compute_host::protocol::ErrorCode;

use super::*;

const MIB: u64 = 1 << 20;

/// Pauses and saves soon after it goes idle, but keeps its VM process
/// until another sandbox needs the memory. Saved only once the busy grace
/// (the 1 s busy window and two samples) has passed, so its VM can then
/// end at once for another.
const SAVE_SOON: SleepConfig = SleepConfig {
    pause_after_ms: Some(1_000),
    save_after_ms: Some(4_000),
    archive_after_ms: None,
    drop_after_ms: None,
    evict_after_ms: None,
    forget_after_ms: None,
    compress: false,
};

/// How long the guests' own background work (a disk flush seconds after a
/// command) may keep an idle sandbox busy, and so awake.
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

/// Runs `script` in `sandbox` once the host has room for it: it answers
/// host full until another sandbox is paused and saved, which may take a
/// while after work of its own. Returns the output and the refusals
/// before.
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

/// Checks that the cgroup of `sandbox`'s VM carries what it is guaranteed
/// and that the out-of-memory killer ends nearly anything else before its
/// VMM, and the VMM before the agent, whose own cgroup lies outside it.
async fn check_guarantees(agent: &Agent, sandbox: Id) {
    // What a VM holds counts its huge pages too, which a cgroup v2 mount
    // without hugetlb accounting leaves out of its memory.current.
    agent
        .wait_until("the sampler to see the VM's memory", |status| {
            status.sandboxes.iter().any(|found| {
                found.id == sandbox && found.resident_bytes.is_some_and(|bytes| bytes > 32 * MIB)
            })
        })
        .await;
    assert_eq!(cgroup_value(sandbox, "cpu.weight"), "100");
    assert_eq!(cgroup_value(sandbox, "memory.low"), (512 * MIB).to_string());
    assert_eq!(cgroup_value(sandbox, "memory.zswap.max"), "0");
    assert_eq!(cgroup_value(sandbox, "memory.swap.max"), "0");
    // Protection reaches no further than the parent's: it claims what
    // its running VMs do, the two held awake.
    let parent = std::fs::read_to_string(Path::new(CGROUP).join("memory.low")).unwrap();
    assert_eq!(parent.trim(), (1024 * MIB).to_string());
    let vmms: Vec<String> = cgroup_value(sandbox, "cgroup.procs")
        .lines()
        .filter(|pid| {
            std::fs::read_to_string(format!("/proc/{pid}/comm"))
                .is_ok_and(|comm| comm.trim() == "firecracker")
        })
        .map(|pid| {
            std::fs::read_to_string(format!("/proc/{pid}/oom_score_adj"))
                .unwrap()
                .trim()
                .to_owned()
        })
        .collect();
    assert_eq!(vmms, ["-900"]);
    let pid = agent.child.id();
    let adjust = std::fs::read_to_string(format!("/proc/{pid}/oom_score_adj")).unwrap();
    assert_eq!(adjust.trim(), "-999");
    let own = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap();
    let own = Path::new(own.trim().strip_prefix("0::").unwrap());
    let parent = Path::new(CGROUP.strip_prefix("/sys/fs/cgroup").unwrap());
    assert!(
        own == Path::new("/") || !parent.starts_with(own),
        "the agent's cgroup {} encloses the VMs' {}",
        own.display(),
        parent.display()
    );
}

/// A value from `/proc/<pid>/<file>`.
fn proc_value(pid: &str, file: &str) -> i64 {
    std::fs::read_to_string(format!("/proc/{pid}/{file}"))
        .unwrap_or_else(|error| panic!("{pid}/{file}: {error}"))
        .trim()
        .parse()
        .unwrap()
}

/// The host's out-of-memory killer picks an ordinary process first, then
/// a VMM or pager, and the agent last, by the scores it reports, not only
/// the adjustments: older kernels clamped adjusted scores into ties.
fn check_oom_order(agent: &Agent) {
    let agent_score = proc_value(&agent.child.id().to_string(), "oom_score");
    let mut ordinary = Command::new("sleep").arg("30").spawn().unwrap();
    let pid = ordinary.id().to_string();
    assert_eq!(proc_value(&pid, "oom_score_adj"), 0);
    let ordinary_score = proc_value(&pid, "oom_score");
    let _ = ordinary.kill();
    let _ = ordinary.wait();
    let mut checked = 0;
    for group in std::fs::read_dir(CGROUP).unwrap() {
        let group = group.unwrap().path();
        let Ok(procs) = std::fs::read_to_string(group.join("cgroup.procs")) else {
            continue;
        };
        for pid in procs.lines() {
            // A holder keeps a descriptor and nothing else; it may share
            // the agent's score.
            if std::fs::read_to_string(format!("/proc/{pid}/comm"))
                .is_ok_and(|comm| comm.trim() == "sleep")
            {
                continue;
            }
            assert_eq!(proc_value(pid, "oom_score_adj"), -900, "{pid}");
            let score = proc_value(pid, "oom_score");
            assert!(
                agent_score < score && score < ordinary_score,
                "agent {agent_score}, {pid} {score}, ordinary {ordinary_score}"
            );
            checked += 1;
        }
    }
    assert!(checked > 0, "no VMM found");
}

/// On a full host, waking `sandbox` and creating then waking `unknown` are
/// both refused at once, saying what they need.
async fn refused_at_once(agent: &Agent, sandbox: Id, unknown: Id) {
    let begin = Instant::now();
    let message = refused(&agent.client, sandbox).await;
    let refusal = begin.elapsed();
    assert!(
        message.contains(&(512 * MIB).to_string()),
        "says what it needs: {message}"
    );
    let begin = Instant::now();
    agent.create(unknown, SAVE_SOON).await;
    refused(&agent.client, unknown).await;
    let create_and_refusal = begin.elapsed();
    eprintln!(
        "on a full host: wake refused in {refusal:?}, create then wake refused in \
         {create_and_refusal:?}"
    );
    assert!(refusal < Duration::from_millis(100), "{refusal:?}");
}

/// Holds each of `sandboxes` awake and leaves a token in its memory.
async fn hold_with_tokens(agent: &Agent, sandboxes: &[Id]) {
    for (n, sandbox) in sandboxes.iter().copied().enumerate() {
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
}

/// Waits until `sandbox` is paused with its state saved on the host.
async fn wait_paused_and_saved(agent: &Agent, sandbox: Id) {
    agent
        .wait_until("it to be paused and saved", |status| {
            status.sandboxes.iter().any(|found| {
                found.id == sandbox
                    && found.level == LevelName::Paused
                    && found.durability == DurabilityName::Local
            })
        })
        .await;
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
        &[
            "--memory-capacity-mib",
            "1024",
            "--memory-buffer-mib",
            "0",
            "--busy-window",
            "1s",
        ],
    );
    let agent = host.start().await;
    let ids: Vec<Id> = (0..3).map(id).collect();
    for sandbox in &ids[..2] {
        agent.create(*sandbox, SAVE_SOON).await;
    }
    let third = SandboxConfig {
        cpu_request_millis: Some(250),
        ..SandboxConfig::new(1, 512, SAVE_SOON)
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
    let unknown = id(3);

    // Two sandboxes held awake fill the host.
    hold_with_tokens(&agent, &ids[..2]).await;
    check_guarantees(&agent, ids[0]).await;
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

    // Nothing idle and saved to end: the third is refused at once, and so
    // is a sandbox created on the full host and woken.
    refused_at_once(&agent, ids[2], unknown).await;
    let status = agent.status().await;
    let waiting = status
        .sandboxes
        .iter()
        .find(|sandbox| sandbox.id == ids[2])
        .unwrap();
    assert_eq!((waiting.level, waiting.holds), (LevelName::Saved, 0));

    // Released, the first pauses and saves once quiet; then its VM ends at
    // once for the third, whose wake goes straight through.
    let release = Request::Release {
        id: ids[0],
        generation: None,
        hold: "work".into(),
    };
    hold(&agent.client, ids[0], release).await;
    let started = Instant::now();
    wait_paused_and_saved(&agent, ids[0]).await;
    let saved = started.elapsed();
    let begin = Instant::now();
    let (output, refusals) = exec_when_room(&agent.client, ids[2], "echo third=ok").await;
    assert!(output.contains("third=ok"), "{output}");
    assert_eq!(refusals, 0, "the saved VM ended for it at once");
    eprintln!(
        "the first was paused and saved {saved:?} after release; the third then woke in {:?}",
        begin.elapsed()
    );
    assert_eq!(cgroup_value(ids[2], "cpu.weight"), "25");
    let status = agent.status().await;
    let first = status
        .sandboxes
        .iter()
        .find(|sandbox| sandbox.id == ids[0])
        .unwrap();
    assert_eq!(first.level, LevelName::Saved, "ended to make room");
    assert!(first.memory_saved);

    // Ended, it lost nothing: once the third is paused and saved, it makes
    // room in turn for the first, whose memory comes back as it was.
    let (output, _) = exec_when_room(&agent.client, ids[0], "cat /dev/shm/token").await;
    assert_eq!(output.trim(), "token-0");

    let release = Request::Release {
        id: ids[1],
        generation: None,
        hold: "work".into(),
    };
    hold(&agent.client, ids[1], release).await;
    // A new agent takes the VMs back, each still a late choice for the
    // out-of-memory killer, and the agent the last.
    agent.kill();
    let agent = host.start().await;
    check_oom_order(&agent);
    agent.remove_all().await;
    agent.kill();
    host.finish("full-host");
}
