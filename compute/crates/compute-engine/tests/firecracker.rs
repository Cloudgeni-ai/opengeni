//! End-to-end lifecycle against a real Firecracker on a KVM host.
//!
//! Runs only when `COMPUTE_TEST_LAB` names a directory prepared by
//! `compute/lab/host-setup.sh` (it holds `bin/firecracker`, `vmlinux` and
//! `base.ext4`, whose guest runs a shell on vsock port 52), and only as root.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use compute_engine::firecracker::{Firecracker, FirecrackerConfig, FirecrackerVm};
use compute_engine::{
    CancellationToken, Completion, Drive, Engine, Found, MemorySource, RestoreFiles, SnapshotFiles,
    SnapshotKind, VmSpec, vsock,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const SHELL_PORT: u32 = 52;

fn lab() -> Option<PathBuf> {
    std::env::var_os("COMPUTE_TEST_LAB").map(PathBuf::from)
}

/// Runs `script` in the guest shell and returns its output and the time to
/// the first byte of it.
async fn exec(uds: &Path, script: &str) -> std::io::Result<(String, Duration)> {
    let started = Instant::now();
    let mut stream = vsock::connect(uds, SHELL_PORT).await?;
    stream
        .write_all(format!("{script}\nexit\n").as_bytes())
        .await?;
    let mut first = [0_u8; 1];
    let read = stream.read(&mut first).await?;
    let first_byte = started.elapsed();
    let mut output = first[..read].to_vec();
    stream.read_to_end(&mut output).await?;
    Ok((String::from_utf8_lossy(&output).into_owned(), first_byte))
}

async fn wait_for_shell(uds: &Path, timeout: Duration) -> Duration {
    let started = Instant::now();
    loop {
        if let Ok((output, _)) = exec(uds, "echo ready").await
            && output.contains("ready")
        {
            return started.elapsed();
        }
        assert!(
            started.elapsed() < timeout,
            "guest shell not ready within {timeout:?}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Fails unless the guest's wall clock agrees with the host's to the second.
async fn assert_guest_clock_is_current(uds: &Path) {
    let (output, _) = exec(uds, "date +%s").await.unwrap();
    let guest: u64 = output.trim().parse().unwrap();
    let host = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    assert!(
        guest.abs_diff(host) <= 1,
        "guest clock {guest} is not the host's {host}"
    );
}

/// Processor time is what the host's activity rule reads: guest work must show
/// up in it, and a paused VM must use none. Leaves the VM running.
async fn assert_processor_time_follows_work(engine: &Firecracker, vm: &FirecrackerVm, uds: &Path) {
    let used_since = |earlier: Duration| {
        engine
            .cpu_time(vm)
            .unwrap()
            .checked_sub(earlier)
            .expect("processor time went backwards")
    };
    // The loop spins until the clock has passed two second boundaries, so for
    // at least one full second.
    let before = engine.cpu_time(vm).unwrap();
    exec(
        uds,
        "end=$(($(date +%s) + 2)); while [ $(date +%s) -lt $end ]; do :; done",
    )
    .await
    .unwrap();
    let busy = used_since(before);
    assert!(
        busy >= Duration::from_millis(500),
        "at least a second of guest work showed only {busy:?} of processor time"
    );
    engine.pause(vm).await.unwrap();
    let before = engine.cpu_time(vm).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let paused = used_since(before);
    engine.resume(vm).await.unwrap();
    assert!(
        paused < Duration::from_millis(30),
        "a paused VM used {paused:?} of processor time"
    );
    eprintln!("processor time: busy loop {busy:?}, paused 300 ms {paused:?}");
}

/// A VM's spec in the jail layout the jailer expects, with its own copy of
/// the base disk and a hard link to the lab kernel.
fn jailed_spec(lab: &Path, name: &str, uid: u32) -> VmSpec {
    let dir = lab.join("rust-test/vm/firecracker").join(name);
    let jail = dir.join("root");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&jail).unwrap();
    let rootfs = jail.join("rootfs.ext4");
    let copied = std::process::Command::new("cp")
        .arg("--reflink=auto")
        .arg(lab.join("base.ext4"))
        .arg(&rootfs)
        .status()
        .unwrap();
    assert!(copied.success());
    let kernel = jail.join("vmlinux");
    std::fs::hard_link(lab.join("vmlinux"), &kernel).unwrap();
    VmSpec {
        name: name.to_owned(),
        dir: jail,
        logs: dir,
        uid,
        gid: uid,
        vcpus: 2,
        memory_mib: 2048,
        kernel,
        boot_args:
            "console=ttyS0 reboot=k panic=1 quiet loglevel=1 page_reporting.page_reporting_order=0"
                .into(),
        drives: vec![Drive {
            id: "rootfs".into(),
            path: rootfs,
            root: true,
            read_only: false,
        }],
        network: None,
        free_page_reporting: true,
    }
}

fn engine(lab: &Path) -> Firecracker {
    Firecracker::new(FirecrackerConfig {
        firecracker: lab.join("bin/firecracker"),
        jailer: lab.join("bin/jailer"),
        cgroup_parent: "/sys/fs/cgroup/compute-test".into(),
    })
    .unwrap()
}

/// Owner and command name of process `pid`.
fn owner_and_name(pid: i32) -> (u32, String) {
    use std::os::unix::fs::MetadataExt;
    let owner = std::fs::metadata(format!("/proc/{pid}")).unwrap().uid();
    let name = std::fs::read_to_string(format!("/proc/{pid}/comm")).unwrap();
    (owner, name.trim().to_owned())
}

#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::too_many_lines)]
async fn boot_pause_compress_snapshot_restore() {
    let Some(lab) = lab() else {
        eprintln!("skipped: set COMPUTE_TEST_LAB to run against Firecracker");
        return;
    };
    let name = format!("engine-test-{}", std::process::id());
    let engine = engine(&lab);
    let spec = jailed_spec(&lab, &name, 3_900_001);
    let dir = spec.logs.clone();
    let uds = spec.vsock_path();

    let started = Instant::now();
    let vm = engine.boot(&spec).await.unwrap();
    let booted = started.elapsed();
    assert_eq!(
        owner_and_name(vm.pid()),
        (spec.uid, "firecracker".to_owned())
    );
    let parent = std::fs::read_to_string(format!("/proc/{}/stat", vm.pid())).unwrap();
    let parent: i32 = parent
        .rsplit(')')
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    assert_ne!(
        parent,
        i32::try_from(std::process::id()).unwrap(),
        "the VMM is our child"
    );
    let ready = wait_for_shell(&uds, Duration::from_secs(60)).await;
    eprintln!("boot: VMM configured in {booted:?}, guest shell ready {ready:?} later");
    let (output, _) = exec(&uds, "echo marker > /root/marker && uname -r")
        .await
        .unwrap();
    assert_ne!(output.trim(), "");
    let awake = engine.resident_bytes(&vm).unwrap();
    assert_processor_time_follows_work(&engine, &vm, &uds).await;

    let started = Instant::now();
    engine.pause(&vm).await.unwrap();
    let pause = started.elapsed();
    let started = Instant::now();
    let completion = engine
        .compress(&vm, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(completion, Completion::Finished);
    let compress = started.elapsed();
    let compressed = engine.resident_bytes(&vm).unwrap();
    let started = Instant::now();
    engine.resume(&vm).await.unwrap();
    let (output, first_byte) = exec(&uds, "cat /root/marker").await.unwrap();
    assert_eq!(output.trim(), "marker");
    eprintln!(
        "pause {pause:?}; compress {compress:?}: {} MiB -> {} MiB; resume to first byte {first_byte:?}, done {:?}",
        awake >> 20,
        compressed >> 20,
        started.elapsed()
    );
    assert!(compressed < awake, "compression freed nothing");

    let files = SnapshotFiles {
        state: spec.dir.join("vm.state"),
        memory: spec.dir.join("vm.mem"),
    };
    engine.pause(&vm).await.unwrap();
    let started = Instant::now();
    // A fresh boot's memory source is all zeros, so its first diff stands
    // alone: every page the guest ever wrote is in it.
    engine
        .snapshot(&vm, &files, SnapshotKind::Diff)
        .await
        .unwrap();
    let snapshot = started.elapsed();
    engine.stop(vm).await.unwrap();
    // Long enough that a clock left standing during the save is caught below.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let started = Instant::now();
    let restore_files = RestoreFiles {
        state: files.state.clone(),
        memory: MemorySource::File(files.memory.clone()),
    };
    let vm = engine.restore(&spec, &restore_files).await.unwrap();
    engine.resume(&vm).await.unwrap();
    let restore = started.elapsed();
    let (output, first_byte) = exec(&uds, "cat /root/marker").await.unwrap();
    assert_eq!(
        output.trim(),
        "marker",
        "state did not survive the snapshot"
    );
    assert_guest_clock_is_current(&uds).await;
    eprintln!(
        "snapshot {snapshot:?}; restore {restore:?}; first byte after restore {first_byte:?}; total {:?}",
        started.elapsed()
    );

    let cgroup = vm.cgroup().path().to_owned();
    engine.stop(vm).await.unwrap();
    assert!(!cgroup.exists(), "cgroup left behind");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A VM outlives the engine instance that started it, and a new instance
/// takes it back with its guest's running programs intact, and with the
/// open file the first one had kept for it. The VM's end ends its holder,
/// and a holder left after its VMM died does not stop a clean-up.
#[tokio::test(flavor = "multi_thread")]
async fn a_new_engine_adopts_a_running_vm_without_disturbing_it() {
    let Some(lab) = lab() else {
        eprintln!("skipped: set COMPUTE_TEST_LAB to run against Firecracker");
        return;
    };
    let name = format!("adopt-test-{}", std::process::id());
    let spec = jailed_spec(&lab, &name, 3_900_002);
    let uds = spec.vsock_path();
    let first = engine(&lab);
    let vm = first.boot(&spec).await.unwrap();
    wait_for_shell(&uds, Duration::from_secs(60)).await;
    // A process that lives only in guest memory.
    let (output, _) = exec(&uds, "(sleep 1000 &) ; pgrep -n sleep").await.unwrap();
    let guest_pid = output.trim().to_owned();
    assert_ne!(guest_pid, "");
    let pid = vm.pid();
    let disk = std::fs::File::open(&spec.drives[0].path).unwrap();
    first
        .hold(&vm, disk.try_clone().unwrap().into())
        .await
        .unwrap();
    // The agent goes away: its handles are dropped, nothing is stopped.
    drop(vm);
    drop(first);

    let second = engine(&lab);
    let (vm, found) = second.adopt(&spec).await.unwrap().expect("VM not adopted");
    assert_eq!(found, Found::Running);
    assert_eq!(vm.pid(), pid);
    let kept = std::fs::File::from(second.held(&vm).await.unwrap().expect("nothing kept"));
    // One open file description: a status flag set through one descriptor
    // shows through the other.
    let flags = rustix::fs::fcntl_getfl(&kept).unwrap();
    assert!(!flags.contains(rustix::fs::OFlags::APPEND));
    rustix::fs::fcntl_setfl(&disk, flags | rustix::fs::OFlags::APPEND).unwrap();
    assert!(
        rustix::fs::fcntl_getfl(&kept)
            .unwrap()
            .contains(rustix::fs::OFlags::APPEND)
    );
    drop(kept);
    let (output, _) = exec(&uds, &format!("cat /proc/{guest_pid}/comm"))
        .await
        .unwrap();
    assert_eq!(output.trim(), "sleep", "the guest lost its programs");

    second.pause(&vm).await.unwrap();
    drop(vm);
    let (vm, found) = engine(&lab).adopt(&spec).await.unwrap().unwrap();
    assert_eq!(found, Found::Paused);
    second.resume(&vm).await.unwrap();
    let (output, _) = exec(&uds, "echo still here").await.unwrap();
    assert_eq!(output.trim(), "still here");

    let cgroup = vm.cgroup().path().to_owned();
    second.stop(vm).await.unwrap();
    assert!(!cgroup.exists(), "cgroup left behind");
    assert!(second.adopt(&spec).await.unwrap().is_none());

    // A VMM that dies leaves its holder behind, which ends with it.
    let vm = second.boot(&spec).await.unwrap();
    second
        .hold(&vm, disk.try_clone().unwrap().into())
        .await
        .unwrap();
    let pid = rustix::process::Pid::from_raw(vm.pid()).unwrap();
    rustix::process::kill_process(pid, rustix::process::Signal::KILL).unwrap();
    vm.exited().await;
    drop(vm);
    assert!(
        engine(&lab).adopt(&spec).await.unwrap().is_none(),
        "a dead VMM was taken back"
    );
    assert!(!cgroup.exists(), "the holder outlived its VM");
    for leftover in ["firecracker", "firecracker.pid", "dev", "api.sock"] {
        assert!(
            !spec.dir.join(leftover).exists(),
            "{leftover} left in the jail"
        );
    }
    std::fs::remove_dir_all(&spec.logs).unwrap();
}
