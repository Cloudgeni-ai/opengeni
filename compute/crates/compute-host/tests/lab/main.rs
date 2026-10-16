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
use std::net::{IpAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use compute_core::SandboxId;
use compute_host::client::Client;
use compute_host::protocol::{
    DurabilityName, HostStatus, Id, LevelName, PriorityName, Reply, Request, SandboxConfig,
    SandboxStatus, SleepConfig,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::task::JoinSet;
use tokio::time::{Instant, sleep, timeout};

mod spoofing;

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
            .arg(CGROUP)
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

/// The parent cgroup of every VM the lab tests start.
const CGROUP: &str = "/sys/fs/cgroup/compute-test";

impl Drop for Agent {
    /// A test that fails part way must not leave its agent holding the
    /// host lock, nor its VMs holding sandbox networks the next test reuses.
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if std::thread::panicking()
            && let Ok(vms) = std::fs::read_dir(CGROUP)
        {
            for vm in vms.flatten().filter(|vm| vm.path().is_dir()) {
                let _ = std::fs::write(vm.path().join("cgroup.kill"), "1");
            }
        }
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

    async fn create(&self, sandbox: Id, sleep: SleepConfig) {
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

/// Creates `sandbox` with sleep settings `sleep`.
async fn create(client: &Client, sandbox: Id, sleep: SleepConfig) {
    let config = SandboxConfig {
        vcpus: 1,
        memory_mib: 512,
        sleep,
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
    /// Paused, with a saved copy on disk.
    SavedInPlace,
    Saved,
}

/// Never sleeps on its own.
const NEVER: SleepConfig = SleepConfig {
    pause_after_ms: None,
    save_after_ms: None,
    archive_after_ms: None,
    drop_after_ms: None,
    evict_after_ms: None,
    forget_after_ms: None,
    compress: false,
};

/// Pauses, saves and lets go of the VM soon after each use.
const SAVE_SOON: SleepConfig = SleepConfig {
    pause_after_ms: Some(300),
    save_after_ms: Some(600),
    drop_after_ms: Some(900),
    ..NEVER
};

impl Kind {
    fn of(n: usize) -> Self {
        [Self::Running, Self::Paused, Self::SavedInPlace, Self::Saved][n % 4]
    }

    fn sleep(self) -> SleepConfig {
        match self {
            Self::Running => NEVER,
            Self::Paused => SleepConfig {
                pause_after_ms: Some(500),
                ..NEVER
            },
            Self::SavedInPlace => SleepConfig {
                pause_after_ms: Some(500),
                save_after_ms: Some(1_000),
                ..NEVER
            },
            Self::Saved => SleepConfig {
                pause_after_ms: Some(500),
                save_after_ms: Some(1_000),
                drop_after_ms: Some(1_500),
                ..NEVER
            },
        }
    }

    /// Whether `sandbox` has settled where this kind goes.
    fn reached(self, sandbox: &SandboxStatus) -> bool {
        let (level, durability) = match self {
            Self::Running => (LevelName::Running, DurabilityName::Volatile),
            Self::Paused => (LevelName::Paused, DurabilityName::Volatile),
            Self::SavedInPlace => (LevelName::Paused, DurabilityName::Local),
            Self::Saved => (LevelName::Saved, DurabilityName::Local),
        };
        sandbox.step.is_none() && sandbox.level == level && sandbox.durability == durability
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
            create(&client, sandbox, Kind::of(n).sleep()).await;
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
                .all(|(n, sandbox)| Kind::of(n).reached(sandbox))
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
            (old.id, old.level, old.durability, old.generation),
            (new.id, new.level, new.durability, new.generation),
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
fn host_addresses() -> Vec<IpAddr> {
    let output = Command::new("hostname").arg("-I").output().unwrap();
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .filter_map(|address| address.parse().ok())
        .collect()
}

/// `address:port`, with an IPv6 address in brackets.
fn target(address: IpAddr, port: u16) -> String {
    match address {
        IpAddr::V4(address) => format!("{address}:{port}"),
        IpAddr::V6(address) => format!("[{address}]:{port}"),
    }
}

/// The link-local address of each sandbox's gateway, which every tap
/// derives from the MAC they all share.
const GATEWAY_LINK_LOCAL: &str = "fe80::400:a9ff:fefe:16%eth0";

/// The inner end of the second sandbox's link, inside its namespace.
const NEIGHBOUR_INNER: &str = "198.18.0.3";

/// A TCP listener inside sandbox `id`'s network namespace, on `address`,
/// proven reachable from inside that namespace. Ends when dropped.
struct NamespaceListener(Child);

impl NamespaceListener {
    fn start(id: Id, address: &str, port: u16) -> Self {
        let namespace = format!("ogc-{id}");
        let program = format!(
            "import socket\ns=socket.socket()\ns.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)\ns.bind(('{address}',{port}))\ns.listen(512)\nwhile True: s.accept()[0].close()"
        );
        let child = Command::new("ip")
            .args(["netns", "exec", &namespace, "python3", "-c", &program])
            .spawn()
            .unwrap();
        let listener = Self(child);
        // The positive control: the same connection succeeds from inside.
        let probe = format!("exec 3<>/dev/tcp/{address}/{port}");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let reached = Command::new("ip")
                .args(["netns", "exec", &namespace, "bash", "-c", &probe])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success();
            if reached {
                return listener;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the listener in {namespace} never answered"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for NamespaceListener {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Every destination a guest must never reach, whatever the host's trust:
/// the cloud metadata service (also as an IPv4-mapped IPv6 address), each
/// host address, the host's end of a sandbox link, a listening address
/// inside another sandbox's namespace, the gateway's IPv6 link-local
/// address and the IPv6 internet.
fn forbidden(port: u16) -> Vec<String> {
    let mut blocked: Vec<String> = vec![
        "169.254.169.254:80".into(),
        "[::ffff:169.254.169.254]:80".into(),
    ];
    blocked.extend(
        host_addresses()
            .into_iter()
            .map(|address| target(address, port)),
    );
    blocked.push(format!("198.18.0.0:{port}"));
    blocked.push(format!("{NEIGHBOUR_INNER}:{port}"));
    blocked.push(format!("[{GATEWAY_LINK_LOCAL}]:{port}"));
    blocked.push("[2606:4700:4700::1111]:80".into());
    blocked
}

/// Connects to each target given after the source address (`-` for the
/// guest's own) and prints `target outcome micros`: `open`, `timeout`, or
/// the name of the error the attempt failed with.
const PROBE: &str = r#"
import errno, socket, sys, time
source = sys.argv[1]
for target in sys.argv[2:]:
    host, port = target.rsplit(":", 1)
    host = host.strip("[]")
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    s = socket.socket(family)
    s.settimeout(3)
    started = time.monotonic_ns()
    try:
        if source != "-":
            s.bind((source, 0))
        s.connect(socket.getaddrinfo(host, int(port), family)[0][4])
        outcome = "open"
    except socket.timeout:
        outcome = "timeout"
    except OSError as error:
        outcome = errno.errorcode.get(error.errno, str(error.errno))
    print(target, outcome, (time.monotonic_ns() - started) // 1000, flush=True)
    s.close()
"#;

/// A guest command probing each of `targets` from the guest's own address;
/// see [`PROBE`]. How each attempt ended, unlike its duration, does not
/// depend on how busy the guest is.
fn probe_script(targets: &[String]) -> String {
    probe_from("-", targets)
}

/// Like [`probe_script`], with connections made from `source`.
fn probe_from(source: &str, targets: &[String]) -> String {
    format!("python3 -c '{PROBE}' {source} {}", targets.join(" "))
}

/// How a blocked IPv4 TCP connection must end: the firewall's reset. Any
/// other failure (a timeout, an unreachable network) would not show that
/// the firewall, and not something on the way, stopped it.
const REFUSED: &str = "ECONNREFUSED";

/// Whether `outcome` is a blocked connection to `target` failing as it
/// should. IPv4 attempts must meet the firewall's reset; guests have no
/// IPv6 route beyond their link, so IPv6 attempts may also fail before
/// leaving the guest or meet the firewall's ICMP refusal. Nothing may be
/// left to time out, as a dropped packet would be, except a link-local
/// address: IPv6 is off in the sandbox's namespace, so neighbour discovery
/// goes unanswered and gives up after about as long as a probe waits.
fn blocked_as_expected(target: &str, outcome: &str) -> bool {
    const V6_FAILURES: [&str; 5] = [
        "ECONNREFUSED",
        "ENETUNREACH",
        "EHOSTUNREACH",
        "EACCES",
        "EADDRNOTAVAIL",
    ];
    let mapped_v4 = target.starts_with("[::ffff:");
    if target.starts_with("[fe80:") {
        outcome == "timeout" || V6_FAILURES.contains(&outcome)
    } else if target.starts_with('[') && !mapped_v4 {
        V6_FAILURES.contains(&outcome)
    } else {
        outcome == REFUSED
    }
}

/// Checks that `lines` hold one row per target, in order: those in `open`
/// connected, every other one failed as [`blocked_as_expected`] says.
/// Returns the refusal times in milliseconds and how often each outcome
/// was seen.
fn check_probes(
    context: &str,
    lines: &[&str],
    targets: &[String],
    open: &[&str],
) -> (Vec<f64>, BTreeMap<String, usize>) {
    assert_eq!(
        lines.len(),
        targets.len(),
        "{context}: missing probe rows: {lines:?}"
    );
    let mut refusals = Vec::new();
    let mut outcomes = BTreeMap::new();
    for (line, target) in lines.iter().zip(targets) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        assert_eq!(fields.first(), Some(&target.as_str()), "{context}: {line}");
        let outcome = fields.get(1).copied().unwrap_or_default();
        *outcomes.entry(outcome.to_owned()).or_default() += 1;
        if open.contains(&target.as_str()) {
            assert_eq!(outcome, "open", "{context}: {line}");
            continue;
        }
        assert!(
            blocked_as_expected(target, outcome),
            "{context}: {target} was not blocked as expected: {line}"
        );
        if outcome == "timeout" {
            continue;
        }
        let micros: u64 = fields[2].parse().unwrap();
        #[allow(clippy::cast_precision_loss)]
        refusals.push(micros as f64 / 1e3);
    }
    (refusals, outcomes)
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
    let count = count().max(2);
    // Something to reach on every host address and on the sandboxes' link
    // addresses, which are the host's too.
    let (listener, port) = listen_everywhere();
    std::thread::spawn(move || for _ in listener.incoming() {});
    let host = Host::new(&lab, "net", &["--network"]);
    let agent = host.start().await;
    let ids: Vec<Id> = (0..count).map(id).collect();
    for sandbox in &ids {
        agent.create(*sandbox, SAVE_SOON).await;
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
    let neighbour = NamespaceListener::start(id(1), NEIGHBOUR_INNER, port);

    let blocked = forbidden(port);
    // The first command after the restore is the outbound connection, then
    // a second one to tell network latency from the restored guest's first
    // page faults, then a name lookup; then each forbidden destination must
    // fail, and fast.
    let script = format!(
        "s=$(date +%s%N); if exec 3<>/dev/tcp/1.1.1.1/80; then echo out $(( ($(date +%s%N) - s) / 1000 )); else echo out-failed; fi
s=$(date +%s%N); if exec 4<>/dev/tcp/1.1.1.1/80; then echo again $(( ($(date +%s%N) - s) / 1000 )); else echo again-failed; fi
if getent hosts example.com >/dev/null; then echo dns ok; else echo dns-failed; fi
{}",
        probe_script(&blocked)
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
    let mut outcomes: BTreeMap<String, usize> = BTreeMap::new();
    while let Some(done) = wakes.join_next().await {
        let (sandbox, (output, waited)) = done.unwrap();
        let lines: Vec<&str> = output.lines().collect();
        let first = lines.first().copied().unwrap_or_default();
        let Some(micros) = first.strip_prefix("out ") else {
            panic!("{sandbox}: the first connection failed: {output}");
        };
        #[allow(clippy::cast_precision_loss)]
        first_connect_ms.push(micros.trim().parse::<u64>().unwrap() as f64 / 1e3);
        let second = lines.get(1).copied().unwrap_or_default();
        let Some(micros) = second.strip_prefix("again ") else {
            panic!("{sandbox}: the second connection failed: {output}");
        };
        #[allow(clippy::cast_precision_loss)]
        second_connect_ms.push(micros.trim().parse::<u64>().unwrap() as f64 / 1e3);
        assert_eq!(lines.get(2).copied(), Some("dns ok"), "{sandbox}: {output}");
        wake_ms.push(waited.as_secs_f64() * 1e3);
        let context = format!("sandbox {sandbox}");
        let (refusals, seen) = check_probes(&context, &lines[3..], &blocked, &[]);
        refusal_ms.extend(refusals);
        for (outcome, times) in seen {
            *outcomes.entry(outcome).or_default() += times;
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
            "blocked_refusals_over_100ms": refusal_ms.iter().filter(|ms| **ms > 100.0).count(),
            "blocked_outcomes": outcomes,
        }),
    );
    // A process inside a namespace keeps it, and its link, alive, so
    // removing that sandbox would wait for it.
    drop(neighbour);
    agent.remove_all().await;
    agent.kill();
    host.finish(&format!("network-restore-{count}"));
}

/// A TCP listener on every host address, IPv4 and IPv6, and its port.
fn listen_everywhere() -> (TcpListener, u16) {
    let listener = TcpListener::bind("[::]:0")
        .or_else(|_| TcpListener::bind("0.0.0.0:0"))
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    (listener, port)
}

/// On a trusted host guests reach the local network; on any other host the
/// same address is blocked. Either way the host, the metadata service and
/// other sandboxes stay out of reach. Runs only when
/// `COMPUTE_TEST_LAN_TARGET` names a listening `address:port` on the
/// host's local network (not the host).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn only_trusted_hosts_let_guests_reach_the_local_network() {
    let (Some(lab), Some(target)) = (lab(), std::env::var_os("COMPUTE_TEST_LAN_TARGET")) else {
        eprintln!("skipped: set COMPUTE_TEST_LAB and COMPUTE_TEST_LAN_TARGET");
        return;
    };
    let lan = target.to_string_lossy().into_owned();
    let (listener, port) = listen_everywhere();
    std::thread::spawn(move || for _ in listener.incoming() {});
    let mut targets = vec![lan.clone()];
    targets.extend(forbidden(port));
    let script = probe_script(&targets);
    for trusted in [false, true] {
        let flags: &[&str] = if trusted {
            &["--network", "--trusted"]
        } else {
            &["--network"]
        };
        let host = Host::new(&lab, "lan", flags);
        let agent = host.start().await;
        agent.create(id(0), NEVER).await;
        agent.create(id(1), NEVER).await;
        exec(&agent.client, id(1), "true").await;
        let neighbour = NamespaceListener::start(id(1), NEIGHBOUR_INNER, port);
        let (output, _) = exec(&agent.client, id(0), &script).await;
        let lines: Vec<&str> = output.lines().collect();
        let open: &[&str] = if trusted { &[lan.as_str()] } else { &[] };
        check_probes(&format!("trusted={trusted}"), &lines, &targets, open);
        spoofing::check_spoofing(&agent.client, &targets, &lan, trusted).await;
        drop(neighbour);
        agent.remove_all().await;
        agent.kill();
        host.finish(&format!("lan-trusted-{trusted}"));
    }
}
