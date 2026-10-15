//! End-to-end lifecycle against a real Firecracker on a KVM host.
//!
//! Runs only when `COMPUTE_TEST_LAB` names a directory prepared by
//! `compute/lab/host-setup.sh` (it holds `bin/firecracker`, `vmlinux` and
//! `base.ext4`, whose guest runs a shell on vsock port 52), and only as root.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use compute_engine::firecracker::Firecracker;
use compute_engine::{CancellationToken, Completion, Drive, Engine, SnapshotFiles, VmSpec, vsock};
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

#[tokio::test(flavor = "multi_thread")]
async fn boot_pause_compress_snapshot_restore() {
    let Some(lab) = lab() else {
        eprintln!("skipped: set COMPUTE_TEST_LAB to run against Firecracker");
        return;
    };
    let name = format!("engine-test-{}", std::process::id());
    let dir = lab.join("rust-test").join(&name);
    std::fs::create_dir_all(&dir).unwrap();
    let rootfs = dir.join("rootfs.ext4");
    let copied = std::process::Command::new("cp")
        .arg("--reflink=auto")
        .arg(lab.join("base.ext4"))
        .arg(&rootfs)
        .status()
        .unwrap();
    assert!(copied.success());

    let engine =
        Firecracker::new(lab.join("bin/firecracker"), "/sys/fs/cgroup/compute-test").unwrap();
    let spec = VmSpec {
        name: name.clone(),
        dir: dir.clone(),
        vcpus: 2,
        memory_mib: 2048,
        kernel: lab.join("vmlinux"),
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
    };
    let uds = spec.vsock_path();

    let started = Instant::now();
    let vm = engine.boot(&spec).await.unwrap();
    let booted = started.elapsed();
    let ready = wait_for_shell(&uds, Duration::from_secs(60)).await;
    eprintln!("boot: VMM configured in {booted:?}, guest shell ready {ready:?} later");
    let (output, _) = exec(&uds, "echo marker > /root/marker && uname -r")
        .await
        .unwrap();
    assert_ne!(output.trim(), "");
    let awake = engine.resident_bytes(&vm).unwrap();

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
        state: dir.join("vm.state"),
        memory: dir.join("vm.mem"),
    };
    engine.pause(&vm).await.unwrap();
    let started = Instant::now();
    engine.snapshot(&vm, &files).await.unwrap();
    let snapshot = started.elapsed();
    engine.stop(vm).await.unwrap();
    let started = Instant::now();
    let vm = engine.restore(&spec, &files).await.unwrap();
    engine.resume(&vm).await.unwrap();
    let restore = started.elapsed();
    let (output, first_byte) = exec(&uds, "cat /root/marker").await.unwrap();
    assert_eq!(
        output.trim(),
        "marker",
        "state did not survive the snapshot"
    );
    eprintln!(
        "snapshot {snapshot:?}; restore {restore:?}; first byte after restore {first_byte:?}; total {:?}",
        started.elapsed()
    );

    let cgroup = vm.cgroup().path().to_owned();
    engine.stop(vm).await.unwrap();
    assert!(!cgroup.exists(), "cgroup left behind");
    std::fs::remove_dir_all(&dir).unwrap();
}
