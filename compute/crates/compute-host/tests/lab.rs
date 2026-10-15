//! The host agent binary against real Firecracker, jailed and networked.
//!
//! Runs only when `COMPUTE_TEST_LAB` names a directory prepared by
//! `lab/host-setup.sh` (`bin/firecracker`, `bin/jailer`, `vmlinux`,
//! `base.ext4`), as root:
//!
//! ```text
//! CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER="sudo -E" COMPUTE_TEST_LAB=/lab \
//!   cargo test --release -p compute-host --test lab -- --nocapture --test-threads 1
//! ```
//!
//! `COMPUTE_TEST_SANDBOXES` sets how many sandboxes each test uses
//! (default 12) and `COMPUTE_TEST_RESULTS` a directory for JSON results.

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use compute_core::SandboxId;
use compute_host::client::Client;
use compute_host::protocol::{
    HostStatus, Id, LevelName, PriorityName, Reply, Request, SandboxConfig, SleepRule,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::task::JoinSet;
use tokio::time::{Instant, sleep, timeout};

const PORT: u32 = 52;

fn lab() -> Option<PathBuf> {
    std::env::var_os("COMPUTE_TEST_LAB").map(PathBuf::from)
}

fn count() -> usize {
    std::env::var("COMPUTE_TEST_SANDBOXES")
        .ok()
        .and_then(|count| count.parse().ok())
        .unwrap_or(12)
}

fn id(n: usize) -> Id {
    Id(SandboxId((0x1ab << 64) | n as u128))
}

/// One run of the agent binary.
struct Agent {
    child: Child,
    client: Client,
}

struct Host {
    lab: PathBuf,
    root: PathBuf,
    socket: PathBuf,
    extra: Vec<String>,
}

impl Host {
    fn new(lab: &Path, name: &str, extra: &[&str]) -> Self {
        let root = lab.join("t").join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        Self {
            lab: lab.to_owned(),
            socket: root.join("agent.sock"),
            root,
            extra: extra.iter().map(|&arg| arg.to_owned()).collect(),
        }
    }

    async fn start(&self) -> Agent {
        let _ = std::fs::remove_file(&self.socket);
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.root.join("agent.log"))
            .unwrap();
        let lab = &self.lab;
        let child = Command::new(env!("CARGO_BIN_EXE_compute-host"))
            .arg("--socket")
            .arg(&self.socket)
            .arg("serve")
            .arg("--root")
            .arg(self.root.join("state"))
            .arg("--firecracker")
            .arg(lab.join("bin/firecracker"))
            .arg("--jailer")
            .arg(lab.join("bin/jailer"))
            .arg("--kernel")
            .arg(lab.join("vmlinux"))
            .arg("--base-image")
            .arg(lab.join("base.ext4"))
            .arg("--cgroup")
            .arg("/sys/fs/cgroup/compute-test")
            .args(["--limit", "boot=32", "--limit", "restore=32"])
            .args(&self.extra)
            .env(
                "RUST_LOG",
                std::env::var("COMPUTE_TEST_LOG").unwrap_or_else(|_| "info".into()),
            )
            .stdout(Stdio::null())
            .stderr(log)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        let client = Client::new(&self.socket);
        loop {
            if self.socket.exists() && client.call(&Request::Status).await.is_ok() {
                break;
            }
            assert!(Instant::now() < deadline, "the agent never came up");
            sleep(Duration::from_millis(20)).await;
        }
        Agent { child, client }
    }

    /// Keeps the agent's log with the results, then deletes the host's
    /// files.
    fn finish(self, name: &str) {
        if let Some(dir) = std::env::var_os("COMPUTE_TEST_RESULTS") {
            let _ = std::fs::copy(
                self.root.join("agent.log"),
                PathBuf::from(dir).join(format!("{name}-agent.log")),
            );
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

impl Agent {
    /// Ends the agent the hard way: SIGKILL, no chance to clean up.
    fn kill(mut self) {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
    }

    async fn status(&self) -> HostStatus {
        match self.client.call(&Request::Status).await.unwrap() {
            Reply::Status(status) => *status,
            other => panic!("{other:?}"),
        }
    }

    async fn create(&self, sandbox: Id, sleep: &[(LevelName, u64)]) {
        create(&self.client, sandbox, sleep).await;
    }

    async fn remove_all(&self) {
        for sandbox in self.status().await.sandboxes {
            let reply = self
                .client
                .call(&Request::Remove {
                    id: sandbox.id,
                    generation: None,
                })
                .await
                .unwrap();
            assert_eq!(reply, Reply::Done);
        }
    }

    async fn wait_until(&self, what: &str, done: impl Fn(&HostStatus) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(300);
        loop {
            let status = self.status().await;
            if done(&status) {
                return;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            sleep(Duration::from_millis(50)).await;
        }
    }
}

/// Creates `sandbox` with the sleep ladder `sleep`.
async fn create(client: &Client, sandbox: Id, sleep: &[(LevelName, u64)]) {
    let config = SandboxConfig {
        vcpus: 1,
        memory_mib: 512,
        sleep: sleep
            .iter()
            .map(|&(level, after_ms)| SleepRule { level, after_ms })
            .collect(),
    };
    let reply = client
        .call(&Request::Create {
            id: sandbox,
            config,
        })
        .await
        .unwrap();
    assert_eq!(reply, Reply::Done, "create {sandbox}");
}

/// Wakes `sandbox`, runs `script` in its shell and returns the output and
/// how long the wake took.
async fn exec(client: &Client, sandbox: Id, script: &str) -> (String, Duration) {
    let started = Instant::now();
    let (reply, mut stream) = client
        .connect(sandbox, PORT, PriorityName::Interactive)
        .await
        .unwrap();
    let Reply::Connected { waited_us, .. } = reply else {
        panic!("{sandbox}: {reply:?}");
    };
    let mut input = script.to_owned();
    input.push_str("\nexit\n");
    stream.get_mut().write_all(input.as_bytes()).await.unwrap();
    let mut output = String::new();
    timeout(Duration::from_secs(120), stream.read_to_string(&mut output))
        .await
        .unwrap_or_else(|_| panic!("{sandbox}: script timed out after {:?}", started.elapsed()))
        .unwrap();
    (output, Duration::from_micros(waited_us))
}

fn percentile(values: &mut [f64], percent: f64) -> f64 {
    values.sort_by(f64::total_cmp);
    if values.is_empty() {
        return 0.0;
    }
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss
    )]
    let index = ((values.len() as f64 - 1.0) * percent / 100.0).round() as usize;
    values[index]
}

fn summary(values: &[f64]) -> serde_json::Value {
    let mut values = values.to_vec();
    serde_json::json!({
        "n": values.len(),
        "p50": percentile(&mut values, 50.0),
        "p90": percentile(&mut values, 90.0),
        "p99": percentile(&mut values, 99.0),
        "max": percentile(&mut values, 100.0),
    })
}

fn save_results(name: &str, results: &serde_json::Value) {
    println!("{name}: {}", serde_json::to_string_pretty(results).unwrap());
    if let Some(dir) = std::env::var_os("COMPUTE_TEST_RESULTS") {
        let dir = PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{name}.json")),
            serde_json::to_vec_pretty(results).unwrap(),
        )
        .unwrap();
    }
}

fn firecrackers() -> usize {
    let output = Command::new("pgrep")
        .args(["-c", "-x", "firecracker"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .unwrap_or(0)
}

/// What each sandbox is left doing before the agent is killed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Kind {
    Running,
    Paused,
    Saved,
}

impl Kind {
    fn of(n: usize) -> Self {
        [Self::Running, Self::Paused, Self::Saved][n % 3]
    }

    fn ladder(self) -> &'static [(LevelName, u64)] {
        match self {
            Self::Running => &[],
            Self::Paused => &[(LevelName::Paused, 500)],
            Self::Saved => &[(LevelName::Paused, 500), (LevelName::Saved, 1_000)],
        }
    }

    fn level(self) -> LevelName {
        match self {
            Self::Running => LevelName::Running,
            Self::Paused => LevelName::Paused,
            Self::Saved => LevelName::Saved,
        }
    }
}

/// Sandboxes running, paused and saved survive the agent being killed with
/// SIGKILL and restarted: every one wakes with the processes and in-memory
/// files its guest had.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn sandboxes_survive_the_agent_being_killed() {
    let Some(lab) = lab() else {
        eprintln!("skipped: set COMPUTE_TEST_LAB to run against Firecracker");
        return;
    };
    let count = count();
    let host = Host::new(&lab, "kill", &["--network"]);
    let agent = host.start().await;
    let ids: Vec<Id> = (0..count).map(id).collect();
    let mut creates = JoinSet::new();
    for (n, sandbox) in ids.iter().copied().enumerate() {
        let client = agent.client.clone();
        creates.spawn(async move {
            create(&client, sandbox, Kind::of(n).ladder()).await;
            // A background process and a file in memory: both live only in
            // the guest's RAM.
            let script = format!(
                "sleep 1000000 & echo $! > /dev/shm/pid; echo token-{n} > /dev/shm/token; cat /dev/shm/token"
            );
            let (output, _) = exec(&client, sandbox, &script).await;
            assert_eq!(output.trim(), format!("token-{n}"));
        });
    }
    while let Some(done) = creates.join_next().await {
        done.unwrap();
    }
    agent
        .wait_until("every sandbox to settle", |status| {
            status
                .sandboxes
                .iter()
                .enumerate()
                .all(|(n, sandbox)| sandbox.step.is_none() && sandbox.level == Kind::of(n).level())
        })
        .await;
    let before = agent.status().await;
    let live = ids
        .iter()
        .enumerate()
        .filter(|(n, _)| Kind::of(*n) != Kind::Saved)
        .count();
    assert_eq!(
        firecrackers(),
        live,
        "one VMM per running or paused sandbox"
    );

    agent.kill();
    assert_eq!(firecrackers(), live, "VMMs outlive a killed agent");
    let restarted = Instant::now();
    let agent = host.start().await;
    let recovery = restarted.elapsed();
    let after = agent.status().await;
    assert_eq!(after.sandboxes.len(), count);
    for (old, new) in before.sandboxes.iter().zip(&after.sandboxes) {
        assert_eq!(
            (old.id, old.level, old.generation),
            (new.id, new.level, new.generation),
            "the restart changed a sandbox"
        );
    }

    let waits = wake_and_check_state(&agent.client, &ids).await;
    let status = agent.status().await;
    let restore = status
        .steps
        .iter()
        .find(|(name, _)| name == "restore")
        .map(|(_, stats)| *stats);
    save_results(
        &format!("kill-restart-{count}"),
        &serde_json::json!({
            "sandboxes": count,
            "agent_restart_to_serving_ms": recovery.as_secs_f64() * 1e3,
            "wake_ms_after_restart": waits
                .iter()
                .map(|(kind, values)| (format!("{kind:?}").to_lowercase(), summary(values)))
                .collect::<BTreeMap<_, _>>(),
            "restore_steps": restore,
        }),
    );
    agent.remove_all().await;
    assert_eq!(firecrackers(), 0);
    agent.kill();
    host.finish(&format!("kill-restart-{count}"));
}

/// Wakes every sandbox at once and checks its guest kept the background
/// process and in-memory file it had; returns wake times by kind.
async fn wake_and_check_state(client: &Client, ids: &[Id]) -> BTreeMap<Kind, Vec<f64>> {
    let client = Arc::new(client.clone());
    let mut wakes = JoinSet::new();
    for (n, sandbox) in ids.iter().copied().enumerate() {
        let client = Arc::clone(&client);
        wakes.spawn(async move {
            let script = "cat /dev/shm/token; kill -0 $(cat /dev/shm/pid) && echo alive";
            let (output, waited) = exec(&client, sandbox, script).await;
            (n, output, waited)
        });
    }
    let mut waits: BTreeMap<Kind, Vec<f64>> = BTreeMap::new();
    while let Some(done) = wakes.join_next().await {
        let (n, output, waited) = done.unwrap();
        assert_eq!(
            output.split_whitespace().collect::<Vec<_>>(),
            [format!("token-{n}").as_str(), "alive"],
            "sandbox {n} ({:?}) lost its state",
            Kind::of(n)
        );
        waits
            .entry(Kind::of(n))
            .or_default()
            .push(waited.as_secs_f64() * 1e3);
    }
    waits
}

/// The host's addresses guests must not reach, with a listener on each so a
/// connection would succeed if the firewall let it through.
fn host_addresses() -> Vec<Ipv4Addr> {
    let output = Command::new("hostname").arg("-I").output().unwrap();
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .filter_map(|address| address.parse().ok())
        .collect()
}

/// Every restored guest reaches the internet with its very first
/// connection, and none reaches the cloud metadata service, the host, or
/// another sandbox.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn restored_guests_reach_the_internet_at_once_and_nothing_else() {
    let Some(lab) = lab() else {
        eprintln!("skipped: set COMPUTE_TEST_LAB to run against Firecracker");
        return;
    };
    let count = count();
    // Something to reach on every host address and on the sandboxes' link
    // addresses, which are the host's too.
    let listener = TcpListener::bind("0.0.0.0:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || for _ in listener.incoming() {});
    let host = Host::new(&lab, "net", &["--network"]);
    let agent = host.start().await;
    let ids: Vec<Id> = (0..count).map(id).collect();
    let ladder = [(LevelName::Paused, 300), (LevelName::Saved, 600)];
    for sandbox in &ids {
        agent.create(*sandbox, &ladder).await;
    }
    let mut boots = JoinSet::new();
    for sandbox in ids.iter().copied() {
        let client = agent.client.clone();
        boots.spawn(async move { exec(&client, sandbox, "true").await });
    }
    while let Some(done) = boots.join_next().await {
        done.unwrap();
    }
    agent
        .wait_until("every sandbox to be saved", |status| {
            status
                .sandboxes
                .iter()
                .all(|sandbox| sandbox.level == LevelName::Saved && sandbox.step.is_none())
        })
        .await;

    let mut blocked: Vec<String> = vec!["169.254.169.254:80".into()];
    blocked.extend(
        host_addresses()
            .iter()
            .map(|address| format!("{address}:{port}")),
    );
    // The host's and another sandbox's ends of their links.
    blocked.push(format!("198.18.0.0:{port}"));
    blocked.push(format!("198.18.0.3:{port}"));
    // The first command after the restore is the outbound connection, then
    // a second one to tell network latency from the restored guest's first
    // page faults, then a name lookup; then each forbidden destination must
    // fail, and fast.
    let script = format!(
        "s=$(date +%s%N); if exec 3<>/dev/tcp/1.1.1.1/80; then echo out $(( ($(date +%s%N) - s) / 1000 )); else echo out-failed; fi
s=$(date +%s%N); if exec 4<>/dev/tcp/1.1.1.1/80; then echo again $(( ($(date +%s%N) - s) / 1000 )); else echo again-failed; fi
if getent hosts example.com >/dev/null; then echo dns ok; else echo dns-failed; fi
for t in {}; do s=$(date +%s%N); if timeout 3 bash -c \"exec 3<>/dev/tcp/${{t%:*}}/${{t#*:}}\" 2>/dev/null; then r=open; else r=closed; fi; echo $t $r $(( ($(date +%s%N) - s) / 1000 )); done",
        blocked.join(" ")
    );
    let started = Instant::now();
    let client = Arc::new(agent.client.clone());
    let mut wakes = JoinSet::new();
    for sandbox in ids.iter().copied() {
        let (client, script) = (Arc::clone(&client), script.clone());
        wakes.spawn(async move { (sandbox, exec(&client, sandbox, &script).await) });
    }
    let mut first_connect_ms = Vec::new();
    let mut second_connect_ms = Vec::new();
    let mut wake_ms = Vec::new();
    let mut refusal_ms = Vec::new();
    while let Some(done) = wakes.join_next().await {
        let (sandbox, (output, waited)) = done.unwrap();
        let mut lines = output.lines();
        let first = lines.next().unwrap_or_default();
        let Some(micros) = first.strip_prefix("out ") else {
            panic!("{sandbox}: the first connection failed: {output}");
        };
        #[allow(clippy::cast_precision_loss)]
        first_connect_ms.push(micros.trim().parse::<u64>().unwrap() as f64 / 1e3);
        let second = lines.next().unwrap_or_default();
        let Some(micros) = second.strip_prefix("again ") else {
            panic!("{sandbox}: the second connection failed: {output}");
        };
        #[allow(clippy::cast_precision_loss)]
        second_connect_ms.push(micros.trim().parse::<u64>().unwrap() as f64 / 1e3);
        assert_eq!(lines.next(), Some("dns ok"), "{sandbox}: {output}");
        wake_ms.push(waited.as_secs_f64() * 1e3);
        for line in lines {
            let fields: Vec<&str> = line.split_whitespace().collect();
            assert_eq!(fields.get(1), Some(&"closed"), "{sandbox}: {line}");
            #[allow(clippy::cast_precision_loss)]
            refusal_ms.push(fields[2].parse::<u64>().unwrap() as f64 / 1e3);
        }
    }
    let total = started.elapsed();
    save_results(
        &format!("network-restore-{count}"),
        &serde_json::json!({
            "sandboxes": count,
            "blocked_destinations": blocked,
            "all_wakes_s": total.as_secs_f64(),
            "wake_ms": summary(&wake_ms),
            "first_outbound_connect_ms": summary(&first_connect_ms),
            "second_outbound_connect_ms": summary(&second_connect_ms),
            "blocked_refusal_ms": summary(&refusal_ms),
        }),
    );
    agent.remove_all().await;
    agent.kill();
    host.finish(&format!("network-restore-{count}"));
}

/// On a trusted host guests reach the local network; on any other host the
/// same address is blocked. Runs only when `COMPUTE_TEST_LAN_TARGET` names a
/// listening `address:port` on the host's local network (not the host).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn only_trusted_hosts_let_guests_reach_the_local_network() {
    let (Some(lab), Some(target)) = (lab(), std::env::var_os("COMPUTE_TEST_LAN_TARGET")) else {
        eprintln!("skipped: set COMPUTE_TEST_LAB and COMPUTE_TEST_LAN_TARGET");
        return;
    };
    let target = target.to_string_lossy().into_owned();
    let (address, port) = target.rsplit_once(':').unwrap();
    let script = format!(
        "if timeout 3 bash -c 'exec 3<>/dev/tcp/{address}/{port}' 2>/dev/null; then echo open; else echo closed; fi"
    );
    for (trusted, expected) in [(false, "closed"), (true, "open")] {
        let flags: &[&str] = if trusted {
            &["--network", "--trusted"]
        } else {
            &["--network"]
        };
        let host = Host::new(&lab, "lan", flags);
        let agent = host.start().await;
        agent.create(id(0), &[]).await;
        let (output, _) = exec(&agent.client, id(0), &script).await;
        assert_eq!(output.trim(), expected, "trusted={trusted}: {target}");
        agent.remove_all().await;
        agent.kill();
        host.finish(&format!("lan-trusted-{trusted}"));
    }
}
