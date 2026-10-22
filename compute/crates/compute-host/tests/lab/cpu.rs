//! Processor time is guaranteed: with every processor contended, by
//! sandboxes using all their vCPUs above their requests and by work on the
//! host beside the VMs, each awake sandbox still gets at least its CPU
//! request, and a create whose request no longer fits is refused at once as
//! host full.

use std::sync::atomic::{AtomicBool, Ordering};

use compute_host::protocol::ErrorCode;

use super::memory::hold_running;
use super::*;

const NEVER: SleepConfig = SleepConfig {
    pause_after_ms: None,
    save_after_ms: None,
    archive_after_ms: None,
    drop_after_ms: None,
    evict_after_ms: None,
    forget_after_ms: None,
    compress: false,
    checkpoint_every_ms: None,
};

/// How long processor use is measured, once every processor is busy.
const WINDOW: Duration = Duration::from_secs(20);

/// The percentage of its request a sandbox must get at least: the rest is
/// measurement, the scheduler sharing time in slices rather than exactly.
const LEAST_PERCENT: u64 = 90;

/// Microseconds of processor time the group at `path` has used.
fn usage_us(path: &Path) -> u64 {
    let stat = std::fs::read_to_string(path.join("cpu.stat"))
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    stat.lines()
        .find_map(|line| line.strip_prefix("usage_usec "))
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or_else(|| panic!("{}: no usage_usec", path.display()))
}

/// Idle and total time of every processor together, in ticks.
fn host_ticks() -> (u64, u64) {
    let stat = std::fs::read_to_string("/proc/stat").unwrap();
    let fields: Vec<u64> = stat
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("cpu "))
        .unwrap()
        .split_whitespace()
        .map(|field| field.parse().unwrap())
        .collect();
    // user nice system idle iowait irq softirq steal; guest time is
    // already counted in user.
    (fields[3] + fields[4], fields[..8].iter().sum())
}

/// Keeps `threads` processors busy in the test's own group, beside the
/// VMs', until dropped.
struct Burn {
    stop: Arc<AtomicBool>,
    threads: Vec<std::thread::JoinHandle<()>>,
}

impl Burn {
    fn start(threads: usize) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let threads = (0..threads)
            .map(|_| {
                let stop = stop.clone();
                std::thread::spawn(move || {
                    while !stop.load(Ordering::Relaxed) {
                        std::hint::spin_loop();
                    }
                })
            })
            .collect();
        Self { stop, threads }
    }
}

impl Drop for Burn {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

/// Sandboxes held awake.
struct Awake {
    ids: Vec<Id>,
    /// The CPU request of each, in millicores.
    request: u64,
    /// The vCPUs of each, one more than its request needs.
    vcpus: u8,
}

/// Creates and holds awake `count` sandboxes whose CPU requests fill
/// `capacity` millicores, each with a vCPU more than its request needs,
/// so that all of them busy want more than there is.
async fn fill(agent: &Agent, count: usize, capacity: u64) -> Awake {
    let request = capacity / u64::try_from(count).unwrap() / 10 * 10;
    assert!(request >= 10, "{count} sandboxes on {capacity} millicores");
    let vcpus = u8::try_from(request.div_ceil(1000) + 1).unwrap();
    let ids: Vec<Id> = (0..count).map(id).collect();
    for sandbox in &ids {
        let config = SandboxConfig {
            cpu_request_millis: Some(u32::try_from(request).unwrap()),
            ..SandboxConfig::new(vcpus, 512, NEVER)
        };
        let reply = agent
            .client
            .call(&Request::Create {
                id: *sandbox,
                config,
            })
            .await
            .unwrap();
        assert_eq!(reply, Reply::Done, "create {sandbox}");
        hold_running(agent, *sandbox).await;
    }
    for sandbox in &ids {
        let weight = std::fs::read_to_string(
            Path::new(CGROUP)
                .join(sandbox.to_string())
                .join("cpu.weight"),
        )
        .unwrap();
        assert_eq!(weight.trim(), (request / 10).to_string(), "{sandbox}");
    }
    Awake {
        ids,
        request,
        vcpus,
    }
}

/// Asks for `sandbox` requesting `millis`, just more than the host has
/// left, and checks the create is refused at once for processor time: a
/// host takes a sandbox only while it can wake it.
async fn refused_for_processor_time(agent: &Agent, sandbox: Id, millis: u64) {
    let config = SandboxConfig {
        cpu_request_millis: Some(u32::try_from(millis).unwrap()),
        ..SandboxConfig::new(1, 512, NEVER)
    };
    let begin = Instant::now();
    let reply = agent
        .client
        .call(&Request::Create {
            id: sandbox,
            config,
        })
        .await
        .unwrap();
    let refusal = begin.elapsed();
    let Reply::Error {
        code: ErrorCode::HostFull,
        message,
    } = reply
    else {
        panic!("{sandbox} was taken beyond the processor capacity: {reply:?}");
    };
    assert!(message.contains("processor time"), "{message}");
    assert!(refusal < Duration::from_millis(100), "{refusal:?}");
}

/// What each of `groups` used over [`WINDOW`], in millicores, and the
/// host's idle time meanwhile, in thousandths.
async fn measure(groups: &[PathBuf]) -> (Vec<u64>, u64) {
    let before: Vec<u64> = groups.iter().map(|group| usage_us(group)).collect();
    let (idle_before, ticks_before) = host_ticks();
    let started = Instant::now();
    sleep(WINDOW).await;
    let after: Vec<u64> = groups.iter().map(|group| usage_us(group)).collect();
    let (idle_after, ticks_after) = host_ticks();
    let elapsed_us = u64::try_from(started.elapsed().as_micros()).unwrap();
    let got = before
        .iter()
        .zip(&after)
        .map(|(before, after)| (after - before) * 1000 / elapsed_us)
        .collect();
    let idle = (idle_after - idle_before) * 1000 / (ticks_after - ticks_before).max(1);
    (got, idle)
}

#[tokio::test(flavor = "multi_thread")]
async fn every_awake_sandbox_gets_its_cpu_request_when_every_processor_is_busy() {
    let Some(lab) = lab() else {
        eprintln!("skipped: set COMPUTE_TEST_LAB to run against Firecracker");
        return;
    };
    let host = Host::new(&lab, "cpu", &[]);
    let agent = host.start().await;
    let cpu = agent
        .status()
        .await
        .cpu
        .expect("the host guarantees processor time");
    assert_eq!((cpu.reserved, cpu.free), (0, cpu.total));
    let processors = std::thread::available_parallelism().unwrap().get();
    let parent_weight = std::fs::read_to_string(Path::new(CGROUP).join("cpu.weight")).unwrap();
    // Whatever covers the capacity against the groups beside it, which
    // the share measured below shows; any weight, on a host with nothing
    // else busy.
    let parent_weight = parent_weight.trim().to_owned();

    let count = count();
    let awake = fill(&agent, count, cpu.total).await;
    let request = awake.request;
    let cpu = agent.status().await.cpu.unwrap();
    let reserved = request * u64::try_from(count).unwrap();
    assert_eq!((cpu.reserved, cpu.free), (reserved, cpu.total - reserved));
    refused_for_processor_time(&agent, id(count), cpu.free + 10).await;

    // Every vCPU of every sandbox busy, and as many busy threads on the
    // host, beside the VMs, as it has processors.
    let script = "for n in $(seq $(nproc)); do \
                  setsid sh -c 'while :; do :; done' </dev/null >/dev/null 2>&1 & done; \
                  echo burning";
    for sandbox in &awake.ids {
        let (output, _) = exec(&agent.client, *sandbox, script).await;
        assert_eq!(output.trim(), "burning", "{sandbox}");
    }
    let burn = Burn::start(processors);
    sleep(Duration::from_secs(2)).await;
    let groups: Vec<PathBuf> = awake
        .ids
        .iter()
        .map(|sandbox| Path::new(CGROUP).join(sandbox.to_string()))
        .collect();
    let (got, idle) = measure(&groups).await;
    drop(burn);

    let least = got.iter().copied().min().unwrap();
    let all: u64 = got.iter().sum();
    eprintln!(
        "{count} sandboxes of {} vCPUs requesting {request} millicores each on {processors} \
         processors (capacity {}, VMs' group weight {parent_weight}), host idle {idle}/1000: \
         least {least}, all VMs {all} millicores",
        awake.vcpus, cpu.total,
    );
    if let Some(dir) = std::env::var_os("COMPUTE_TEST_RESULTS") {
        let result = serde_json::json!({
            "sandboxes": count,
            "vcpus": awake.vcpus,
            "request_millis": request,
            "processors": processors,
            "capacity_millis": cpu.total,
            "parent_weight": parent_weight,
            "host_idle_permille": idle,
            "got_millis": got,
        });
        std::fs::write(
            PathBuf::from(dir).join("cpu-guarantee.json"),
            serde_json::to_vec_pretty(&result).unwrap(),
        )
        .unwrap();
    }
    assert!(idle < 50, "the host was not contended: {idle}/1000 idle");
    assert!(
        least * 100 >= request * LEAST_PERCENT,
        "a sandbox requesting {request} millicores got {least}: {got:?}"
    );

    agent.remove_all().await;
    drop(agent);
    host.finish("cpu");
}
