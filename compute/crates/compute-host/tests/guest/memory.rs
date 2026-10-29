//! Sandboxes in use that borrow memory on a host short of it, with guests
//! that can shrink (ADR 24): the borrower pays, compressed and slowed,
//! never paused; a sandbox within its request is never compressed or
//! slowed; and memory that does not compress is given back by ending the
//! program that took it, never the sandbox.
//!
//! Each host declares a 6 GiB share of the machine's memory for its
//! sandboxes, as a host beside other VMs does, so the shortage is real
//! whatever else the machine has free: the VMs may hold 4.75 GiB together
//! before the kernel slows them and 4.875 GiB at most, and their bounds
//! keep 1 GiB of the 4.75 free. A borrower of 4 GiB guaranteed 1 GiB and a
//! neighbour of 3 GiB guaranteed 2 GiB that holds about 1.1 GiB leave the
//! borrower about 2.6 GiB, while it holds about 3.4: about 0.8 GiB more
//! than its bound, more than its guest's file cache, with the neighbour
//! still clear of every limit.

use std::sync::atomic::{AtomicBool, Ordering};

use compute_host::protocol::{PriorityName, SandboxStatus};

use super::*;

const MIB: u64 = 1 << 20;

const SHARE: &[&str] = &[
    "--memory-total-mib",
    "6144",
    "--memory-low-mib",
    "1024",
    "--memory-high-mib",
    "1280",
    "--memory-buffer-mib",
    "0",
];

const TOKEN: &str = "token-memory";

fn find(status: &HostStatus, sandbox: Id) -> &SandboxStatus {
    status
        .sandboxes
        .iter()
        .find(|found| found.id == sandbox)
        .unwrap()
}

fn compressed_pages(status: &HostStatus, sandbox: Id) -> u64 {
    find(status, sandbox)
        .memory
        .as_ref()
        .map_or(0, |memory| memory.zswpout)
}

/// Kills by the kernel's out-of-memory killer in the VMs' group so far.
fn oom_kills() -> u64 {
    let events = std::fs::read_to_string(Path::new(CGROUP).join("memory.events")).unwrap();
    events
        .lines()
        .find_map(|line| line.strip_prefix("oom_kill "))
        .map_or(0, |count| count.trim().parse().unwrap())
}

fn agent_log(host: &Host) -> String {
    std::fs::read_to_string(host.root.join("agent.log")).unwrap()
}

/// Creates `sandbox` guaranteed `request_mib` of its `memory_mib`, holds
/// it in use and gives it [`TOKEN`].
async fn start_held(host: &Host, sandbox: Id, memory_mib: u32, request_mib: u32) -> Envd<'_> {
    let config = SandboxConfig {
        memory_request_mib: Some(request_mib),
        ..SandboxConfig::new(2, memory_mib, SleepConfig::default())
    };
    host.create_as(sandbox, config).await.unwrap();
    let hold = Request::Hold {
        id: sandbox,
        generation: None,
        hold: "work".into(),
        ttl_ms: None,
        priority: PriorityName::Interactive,
    };
    assert_eq!(host.client.call(&hold).await.unwrap(), Reply::Done);
    Envd::new(&host.client, sandbox)
        .wait_healthy(Duration::from_secs(120))
        .await;
    init(&host.client, sandbox, &[], TOKEN).await;
    Envd::new(&host.client, sandbox).with_token(TOKEN)
}

/// What [`watch`] saw.
#[derive(Debug, Default)]
struct Watched {
    readings: usize,
    /// The highest share of ten seconds in which some of the neighbour's
    /// processes waited for memory, in hundredths of a percent.
    neighbour_stall: u32,
}

/// Reads the host until `done`, failing as soon as either sandbox is
/// anything but running, is paused for memory or was launched again.
async fn watch(host: &Host, borrower: Id, neighbour: Id, done: &AtomicBool) -> Watched {
    let first = host.status().await;
    let launches = [borrower, neighbour].map(|sandbox| find(&first, sandbox).launches);
    let mut watched = Watched::default();
    while !done.load(Ordering::Relaxed) {
        let status = host.status().await;
        for (sandbox, launches) in [borrower, neighbour].into_iter().zip(launches) {
            let found = find(&status, sandbox);
            assert_eq!(found.level, LevelName::Running, "{sandbox}: {found:?}");
            assert_eq!(found.paused_for_memory, None, "{sandbox}: {found:?}");
            assert_eq!(found.launches, launches, "{sandbox} was launched again");
        }
        if let Some(stall) = find(&status, neighbour)
            .memory
            .as_ref()
            .and_then(|memory| memory.pressure_some_avg10_hundredths)
        {
            watched.neighbour_stall = watched.neighbour_stall.max(stall);
        }
        watched.readings += 1;
        sleep(Duration::from_millis(200)).await;
    }
    watched
}

/// Fills 3.25 GiB with pages a quarter random and the rest text, which
/// compress to about a third, then touches its first GiB for 30 s.
const COMPRESSIBLE: &str = r"python3 - <<'EOF'
import os, time
size = 3328 << 20
b = bytearray(b'abcdefgh') * (size // 8)
mv = memoryview(b)
for i in range(0, size, 4096):
    mv[i:i + 1024] = os.urandom(1024)
open('/tmp/filled', 'w').close()
end, passes = time.time() + 30, 0
while time.time() < end:
    for i in range(0, 1 << 30, 4096):
        b[i] ^= 1
    passes += 1
print('passes', passes)
EOF";

/// Takes `mib` MiB and touches all of it for 30 s.
fn neighbour_script(mib: u64) -> String {
    format!(
        r"python3 - <<'EOF'
import time
b = bytearray(b'n') * ({mib} << 20)
end, passes = time.time() + 30, 0
while time.time() < end:
    for i in range(0, len(b), 4096):
        b[i] ^= 1
    passes += 1
print('passes', passes)
EOF"
    )
}

/// A sandbox borrowing memory that compresses is held to what the host can
/// spare when its neighbour grows within its own request: the kernel
/// compresses the borrower's coldest pages, and it runs its program to the
/// end, slower; the neighbour is never compressed and never waits for
/// memory, and neither is paused, ended or shrunk.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_borrower_is_compressed_and_its_neighbour_within_its_request_never_waits() {
    let Some((lab, guest)) = setup() else {
        return;
    };
    let image = image(&lab, &guest, SANDBOX);
    let host = Host::start(&lab, "borrower", &image, SHARE).await;
    let (borrower, neighbour) = (id(0), id(1));
    let borrower_shell = start_held(&host, borrower, 4096, 1024).await;
    let neighbour_shell = start_held(&host, neighbour, 3072, 2048).await;
    let kills = oom_kills();
    let done = AtomicBool::new(false);
    let started = Instant::now();
    let work = async {
        let ran = tokio::join!(borrower_shell.run(COMPRESSIBLE), async {
            // The neighbour grows only once the borrower holds its memory.
            while !borrower_shell
                .run("test -e /tmp/filled && echo yes")
                .await
                .is_ok_and(|ran| ran.stdout.contains("yes"))
            {
                sleep(Duration::from_millis(500)).await;
            }
            let filled = started.elapsed();
            (neighbour_shell.run(&neighbour_script(1024)).await, filled)
        });
        done.store(true, Ordering::Relaxed);
        ran
    };
    let ((borrower_ran, (neighbour_ran, filled)), watched) =
        tokio::join!(work, watch(&host, borrower, neighbour, &done));
    let borrower_ran = borrower_ran.unwrap();
    let neighbour_ran = neighbour_ran.unwrap();
    assert!(borrower_ran.stdout.contains("passes"), "{borrower_ran:?}");
    assert!(neighbour_ran.stdout.contains("passes"), "{neighbour_ran:?}");
    let status = host.status().await;
    let log = agent_log(&host);
    assert!(
        compressed_pages(&status, borrower) > 0,
        "the borrower was never compressed"
    );
    assert_eq!(
        compressed_pages(&status, neighbour),
        0,
        "the neighbour was compressed"
    );
    assert!(
        watched.neighbour_stall < 100,
        "the neighbour waited for memory: {watched:?}"
    );
    assert_eq!(oom_kills(), kills, "the kernel ended a VM");
    assert!(
        !log.contains("asking a guest to shrink"),
        "a guest was shrunk"
    );
    assert!(!log.contains("ending a VM"), "a VM was ended");
    eprintln!(
        "borrower filled in {filled:?}, {} / neighbour {}; {} pages compressed, resident \
         {} MiB; {watched:?}",
        borrower_ran.stdout.trim(),
        neighbour_ran.stdout.trim(),
        compressed_pages(&status, borrower),
        find(&status, borrower).resident_bytes.unwrap_or_default() / MIB,
    );
    host.finish().await;
}

/// Takes 3.25 GiB of random bytes, which do not compress, in 64 MiB
/// pieces, and holds it; says how it ended.
const INCOMPRESSIBLE: &str = r#"python3 - <<'EOF'
import os, time
held = [os.urandom(64 << 20) for _ in range(52)]
open('/tmp/filled', 'w').close()
time.sleep(600)
EOF
echo "exit $?""#;

/// A sandbox borrowing memory that does not compress, which the kernel
/// therefore cannot hold to its bound, gives it back when its neighbour
/// grows within its request: its guest ends the program that took the
/// memory, and the sandbox, its other programs and envd run on. Neither
/// is paused or ended, the kernel ends no VM, and the neighbour is never
/// compressed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_borrower_whose_memory_does_not_compress_loses_only_the_program_that_took_it() {
    let Some((lab, guest)) = setup() else {
        return;
    };
    let image = image(&lab, &guest, SANDBOX);
    let host = Host::start(&lab, "random", &image, SHARE).await;
    let (borrower, neighbour) = (id(0), id(1));
    let borrower_shell = start_held(&host, borrower, 4096, 1024).await;
    let neighbour_shell = start_held(&host, neighbour, 3072, 2048).await;
    let marker = borrower_shell
        .run("nohup sleep 600 >/dev/null 2>&1 & echo $!")
        .await
        .unwrap();
    let marker = marker.stdout.trim().to_owned();
    let kills = oom_kills();
    let done = AtomicBool::new(false);
    let started = Instant::now();
    let work = async {
        let ran = tokio::join!(
            async { (borrower_shell.run(INCOMPRESSIBLE).await, started.elapsed()) },
            async {
                while !borrower_shell
                    .run("test -e /tmp/filled && echo yes")
                    .await
                    .is_ok_and(|ran| ran.stdout.contains("yes"))
                {
                    sleep(Duration::from_millis(500)).await;
                }
                let filled = started.elapsed();
                (neighbour_shell.run(&neighbour_script(1024)).await, filled)
            }
        );
        done.store(true, Ordering::Relaxed);
        ran
    };
    let (((borrower_ran, ended), (neighbour_ran, filled)), watched) =
        tokio::join!(work, watch(&host, borrower, neighbour, &done));
    let borrower_ran = borrower_ran.unwrap();
    let neighbour_ran = neighbour_ran.unwrap();
    assert!(borrower_ran.stdout.contains("exit 137"), "{borrower_ran:?}");
    assert!(neighbour_ran.stdout.contains("passes"), "{neighbour_ran:?}");
    let alive = borrower_shell
        .run(&format!("kill -0 {marker} && echo alive"))
        .await
        .unwrap();
    assert!(
        alive.stdout.contains("alive"),
        "its other program ended: {alive:?}"
    );
    let status = host.status().await;
    let log = agent_log(&host);
    let shrank = log
        .lines()
        .find(|line| line.contains("a guest shrank for host memory"))
        .unwrap_or_else(|| panic!("no guest shrank:\n{log}"));
    assert!(shrank.contains("python3"), "{shrank}");
    assert!(!log.contains("ending a VM"), "a VM was ended");
    assert_eq!(oom_kills(), kills, "the kernel ended a VM");
    assert_eq!(
        compressed_pages(&status, neighbour),
        0,
        "the neighbour was compressed"
    );
    eprintln!(
        "borrower filled in {filled:?}, its program ended at {ended:?}; neighbour {}; \
         {shrank}; {watched:?}",
        neighbour_ran.stdout.trim(),
    );
    host.finish().await;
}
