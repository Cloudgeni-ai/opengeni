use super::runtime::{Format, cpu_model, runtime_of};
use super::*;
use crate::spec::Network;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;

/// The core retries a transient failure at once, so a launch reports one
/// only when nothing it started can still run.
#[test]
fn a_launch_that_could_not_clean_up_is_fatal() {
    let cleaned = launch_failed("boot", "attaching failed".into(), Ok(()));
    assert_eq!(cleaned.kind, ErrorKind::Transient);
    let stuck = launch_failed(
        "boot",
        "attaching failed".into(),
        Err(io::Error::other("the cgroup is still populated")),
    );
    assert_eq!(stuck.kind, ErrorKind::Fatal);
}

#[test]
fn the_runtime_names_the_processor_model() {
    let cpuinfo = "processor\t: 0\nvendor_id\t: AuthenticAMD\nmodel name\t: AMD EPYC 9B14\n";
    assert_eq!(cpu_model(cpuinfo), "AMD EPYC 9B14");
    assert_eq!(cpu_model("processor : 0\n"), "an unknown processor");
    assert!(runtime_of(Path::new("/nonexistent/firecracker")).is_err());
}

fn binary(runtime: &str) -> Binary {
    Binary {
        path: PathBuf::from("/usr/bin/firecracker"),
        runtime: runtime.to_owned(),
        format: Format::of_runtime(runtime),
    }
}

/// Firecracker loads snapshots of its own major format version up to its
/// own minor one, whatever processor the label names.
#[test]
fn snapshot_formats_parse_and_read_like_firecracker() {
    let format = |text| Format::parse(text).unwrap();
    assert_eq!(format("v8.1.0"), format("8.1.0"));
    assert_eq!(format("v12.0.3").to_string(), "v12.0.3");
    for bad in ["", "v8", "v8.1", "v8.1.0.1", "vx.1.0", "8.1.0-rc1"] {
        assert_eq!(Format::parse(bad), None, "{bad:?}");
    }
    assert!(format("v8.2.0").reads(format("v8.1.5")));
    assert!(format("v8.2.0").reads(format("v8.2.9")));
    assert!(!format("v8.1.0").reads(format("v8.2.0")));
    assert!(!format("v12.0.0").reads(format("v8.0.0")));
    assert_eq!(
        Format::of_runtime("Firecracker snapshot format v8.0.0 on AMD EPYC 9B14"),
        Some(format("v8.0.0"))
    );
    assert_eq!(
        Format::of_runtime("Firecracker v1.13.1 on AMD EPYC 9B14"),
        None
    );
    assert_eq!(Format::of_runtime(""), None);
}

/// Only proof gives an image up: a format every kept binary names and
/// none reads. Another processor, an unnamed format, or a binary too old
/// to name its own leaves the question open, and an image goes to the
/// binary that made it, else to one that reads its format.
#[test]
fn an_image_is_unreadable_only_when_no_binary_reads_its_format() {
    let new = binary("Firecracker snapshot format v12.1.0 on Intel Xeon");
    let old = binary("Firecracker snapshot format v8.0.0 on Intel Xeon");
    let legacy = binary("Firecracker v1.13.1 on Intel Xeon");
    let current = [&new];
    let both = [&new, &old];
    let with_legacy = [&new, &legacy];

    assert_eq!(readable(&current, &new.runtime), Readable::Yes);
    let elsewhere = "Firecracker snapshot format v12.0.0 on AMD EPYC";
    assert_eq!(readable(&current, elsewhere), Readable::Yes);
    assert_eq!(
        chosen(&current, elsewhere).map(|binary| &binary.runtime),
        Some(&new.runtime)
    );
    assert!(matches!(
        readable(&current, &old.runtime),
        Readable::No(why) if why.contains("v8.0.0") && why.contains("v12.1.0")
    ));
    assert_eq!(readable(&both, &old.runtime), Readable::Yes);
    assert_eq!(
        chosen(&both, &old.runtime).map(|binary| &binary.runtime),
        Some(&old.runtime)
    );
    assert_eq!(
        chosen(&both, "Firecracker snapshot format v8.0.0 on AMD EPYC")
            .map(|binary| &binary.runtime),
        Some(&old.runtime)
    );
    assert_eq!(readable(&current, &legacy.runtime), Readable::Unknown);
    assert_eq!(readable(&current, ""), Readable::Unknown);
    assert_eq!(readable(&with_legacy, &old.runtime), Readable::Unknown);
    assert_eq!(chosen(&current, &legacy.runtime).map(|_| ()), None);
}

/// Only a VMM that answered, or died loading, has judged the image; a lost
/// or late request has not, and must not cost the sandbox its memory.
#[test]
fn only_a_refusal_or_an_exit_while_loading_counts_against_an_image() {
    let refused = || ApiError::Status {
        method: "PUT",
        path: "/snapshot/load".into(),
        status: 400,
        body: "unsupported snapshot version".into(),
    };
    assert_eq!(load_failure(refused(), true).kind, ErrorKind::MemoryLost);
    assert_eq!(load_failure(refused(), false).kind, ErrorKind::MemoryLost);
    let lost = [
        ApiError::Connect(io::ErrorKind::ConnectionRefused.into()),
        ApiError::Io(io::ErrorKind::BrokenPipe.into()),
        ApiError::Timeout(Duration::from_secs(1)),
        ApiError::Malformed("no status line"),
    ];
    for error in lost {
        assert_eq!(load_failure(error, true).kind, ErrorKind::Transient);
    }
    let died = ApiError::Io(io::ErrorKind::BrokenPipe.into());
    assert_eq!(load_failure(died, false).kind, ErrorKind::MemoryLost);
}

/// A launch records its runtime beside the jail, so an agent that takes
/// the VMM back later knows which runtime its snapshots belong to.
#[test]
fn a_launch_leaves_its_runtime_for_a_later_agent() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vm/firecracker/a/root");
    std::fs::create_dir_all(&root).unwrap();
    let spec = VmSpec {
        dir: root.clone(),
        logs: root.parent().unwrap().to_owned(),
        ..spec()
    };
    let jail = Jail::new(&spec).unwrap();
    assert_eq!(recorded_runtime(&jail), "", "unknown before any launch");
    record_runtime(&jail, "Firecracker snapshot format v12.0.0 on a").unwrap();
    record_runtime(&jail, "Firecracker snapshot format v13.0.0 on a").unwrap();
    assert_eq!(
        recorded_runtime(&jail),
        "Firecracker snapshot format v13.0.0 on a"
    );
    assert!(
        !root.join("vmm.runtime").exists(),
        "the VMM could change it"
    );
}

/// A trim that measured the previous launch's log and punches it out late
/// reaches only that file, never what the next launch has begun to write.
#[test]
fn a_late_trim_of_the_last_log_spares_the_new_one() {
    use std::io::Write;
    use std::os::unix::fs::FileExt;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vmm.log");
    fs::write(&path, vec![b'o'; 64 << 10]).unwrap();
    // The trimmer opens and measures the old log...
    let trimming = File::options().write(true).open(&path).unwrap();
    let measured = trimming.metadata().unwrap().len();
    // ...a new launch starts its log meanwhile...
    let mut fresh = fresh_log(&path).unwrap();
    fresh.write_all(b"new launch\n").unwrap();
    // ...and the trim lands on what it measured.
    let zeros = vec![0; usize::try_from(measured).unwrap()];
    trimming.write_all_at(&zeros, 0).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"new launch\n");
}

/// A VMM API that answers `PATCH /vm` with `patch` and `GET /` with
/// `get`.
fn vmm(patch: Answer, get: Answer) -> (Socket, Api) {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let socket = std::env::temp_dir().join(format!(
        "compute-engine-vmm-{}-{}.sock",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).unwrap();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut request = vec![0_u8; 4096];
            let read = stream.read(&mut request).await.unwrap_or(0);
            let answer = if request[..read].starts_with(b"PATCH") {
                patch
            } else {
                get
            };
            match answer {
                Answer::Reply(reply) => {
                    let _ = stream.write_all(reply.as_bytes()).await;
                }
                Answer::Close => {}
                Answer::Hang => {
                    tokio::spawn(async move {
                        let _open = stream;
                        std::future::pending::<()>().await;
                    });
                }
            }
        }
    });
    let limit = Duration::from_millis(200);
    let api = Api::new(&socket).with_limits(limit, limit);
    (Socket(socket), api)
}

/// How the fake VMM answers a request.
#[derive(Clone, Copy)]
enum Answer {
    Reply(&'static str),
    /// Drops the connection without answering.
    Close,
    /// Keeps the connection open and never answers.
    Hang,
}

/// Removes the socket file when the test ends.
struct Socket(PathBuf);

impl Drop for Socket {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

const NO_CONTENT: &str = "HTTP/1.1 204 \r\n\r\n";
const REFUSED: &str = "HTTP/1.1 400 \r\ncontent-length: 2\r\n\r\n{}";
const RUNNING: &str = "HTTP/1.1 200 \r\ncontent-length: 19\r\n\r\n{\"state\":\"Running\"}";
const PAUSED: &str = "HTTP/1.1 200 \r\ncontent-length: 18\r\n\r\n{\"state\":\"Paused\"}";

async fn resume(api: &Api, alive: bool) -> Result<(), ErrorKind> {
    set_run_state(api, || alive, "resume", RunState::Running)
        .await
        .map_err(|error| error.kind)
}

#[tokio::test]
async fn a_run_state_change_fails_only_when_nothing_changed() {
    use Answer::{Close, Hang, Reply};
    let (_s1, api) = vmm(Reply(NO_CONTENT), Close);
    assert_eq!(resume(&api, true).await, Ok(()));
    let (_s2, api) = vmm(Reply(REFUSED), Reply(PAUSED));
    assert_eq!(
        resume(&api, true).await,
        Err(ErrorKind::Transient),
        "refused"
    );
    // The answer is lost: the VMM says what actually happened.
    let (_s3, api) = vmm(Close, Reply(RUNNING));
    assert_eq!(resume(&api, true).await, Ok(()), "it did resume");
    let (_s4, api) = vmm(Close, Reply(PAUSED));
    assert_eq!(resume(&api, true).await, Err(ErrorKind::Transient));
    // The answer is late: likewise.
    let (_s5, api) = vmm(Hang, Reply(RUNNING));
    assert_eq!(resume(&api, true).await, Ok(()), "it did resume");
    // Nobody can say whether the guest ran.
    let (_s6, api) = vmm(Close, Close);
    assert_eq!(resume(&api, true).await, Err(ErrorKind::MemoryLost));
    assert_eq!(resume(&api, false).await, Err(ErrorKind::MemoryLost));
    // A VMM that stops answering is beyond control, and noticing that
    // takes no longer than the deadlines.
    let (_s7, api) = vmm(Hang, Hang);
    let started = std::time::Instant::now();
    assert_eq!(resume(&api, true).await, Err(ErrorKind::MemoryLost));
    assert!(started.elapsed() < Duration::from_secs(2));
    // Never sent: nothing changed.
    let gone = Api::new(std::env::temp_dir().join("compute-engine-no-such-vmm.sock"));
    assert_eq!(resume(&gone, true).await, Err(ErrorKind::Transient));
}

#[test]
fn boot_pins_the_clock_source_restore_can_correct() {
    assert_eq!(
        boot_args("console=ttyS0 quiet"),
        "console=ttyS0 quiet clocksource=kvm-clock"
    );
    assert_eq!(boot_args(""), "clocksource=kvm-clock");
    assert_eq!(
        boot_args("console=ttyS0 clocksource=tsc"),
        "console=ttyS0 clocksource=tsc"
    );
}

#[test]
fn restore_takes_host_paths_from_the_spec_not_the_snapshot() {
    let jail_dir = "/lab/vm/firecracker/a/root";
    let mut spec = VmSpec {
        name: "a".into(),
        dir: jail_dir.into(),
        logs: "/lab/vm/firecracker/a".into(),
        uid: 4_000_000,
        gid: 4_000_000,
        vcpus: 1,
        memory_mib: 512,
        kernel: format!("{jail_dir}/vmlinux").into(),
        boot_args: String::new(),
        drives: Vec::new(),
        network: None,
        free_page_reporting: true,
    };
    let files = RestoreFiles {
        state: format!("{jail_dir}/vm.state").into(),
        memory: MemorySource::File(format!("{jail_dir}/vm.mem").into()),
        made_under: None,
    };
    let jail = Jail::new(&spec).unwrap();
    let bare = MemoryProfile::bare_metal();
    let body = load_request(&spec, &jail, &files, bare).unwrap();
    assert_eq!(body["clock_realtime"], true);
    assert_eq!(body["resume_vm"], false);
    assert_eq!(body["snapshot_path"], "/vm.state");
    assert_eq!(body["mem_backend"]["backend_path"], "/vm.mem");
    assert_eq!(body["vsock_override"]["uds_path"], "/vsock.sock");
    assert!(body.get("network_overrides").is_none());

    spec.network = Some(Network {
        tap: "tap0".into(),
        mac: "06:00:ac:10:00:02".into(),
        namespace: None,
    });
    let body = load_request(&spec, &jail, &files, bare).unwrap();
    assert_eq!(
        body["network_overrides"],
        json!([{ "iface_id": "eth0", "host_dev_name": "tap0" }])
    );

    let outside = RestoreFiles {
        state: "/elsewhere/vm.state".into(),
        memory: MemorySource::File(format!("{jail_dir}/vm.mem").into()),
        made_under: None,
    };
    assert!(load_request(&spec, &jail, &outside, bare).is_err());
}

fn spec() -> VmSpec {
    VmSpec {
        name: "a".into(),
        dir: "/lab/vm/firecracker/a/root".into(),
        logs: "/lab/vm/firecracker/a".into(),
        uid: 4_000_000,
        gid: 4_000_000,
        vcpus: 2,
        memory_mib: 512,
        kernel: "/lab/vm/firecracker/a/root/vmlinux".into(),
        boot_args: String::new(),
        drives: Vec::new(),
        network: None,
        free_page_reporting: true,
    }
}

#[test]
fn the_profile_decides_page_size_and_dirty_tracking() {
    let bare = machine_config(&spec(), MemoryProfile::bare_metal());
    assert_eq!(bare["track_dirty_pages"], true);
    assert_eq!(bare["huge_pages"], "None");
    let nested = machine_config(&spec(), MemoryProfile::nested());
    assert_eq!(nested["track_dirty_pages"], false);
    assert_eq!(nested["huge_pages"], "2M");

    let jail = Jail::new(&spec()).unwrap();
    let paged = RestoreFiles {
        state: "/lab/vm/firecracker/a/root/vm.state".into(),
        memory: paged_source(),
        made_under: None,
    };
    let body = load_request(&spec(), &jail, &paged, MemoryProfile::nested()).unwrap();
    assert_eq!(body["mem_backend"]["backend_type"], "Uffd");
    assert_eq!(body["mem_backend"]["backend_path"], "/uffd.sock");
    assert_eq!(body["huge_pages"], "2M");
    assert_eq!(body["track_dirty_pages"], false);
    let body = load_request(&spec(), &jail, &paged, MemoryProfile::bare_metal()).unwrap();
    assert_eq!(body["huge_pages"], "None");
    assert_eq!(body["track_dirty_pages"], true);
}

#[test]
fn huge_pages_are_never_restored_from_a_mapped_file() {
    let mapped = MemorySource::File("/lab/vm/firecracker/a/root/vm.mem".into());
    assert_eq!(
        check_source(&mapped, MemoryProfile::nested()),
        Err(ProfileError::FileBackedHugePages)
    );
    assert_eq!(check_source(&mapped, MemoryProfile::bare_metal()), Ok(()));
    let paged = paged_source();
    assert_eq!(check_source(&paged, MemoryProfile::nested()), Ok(()));
}

#[test]
fn snapshots_are_durable_and_name_their_kind() {
    let jail = Jail::new(&spec()).unwrap();
    let files = SnapshotFiles {
        state: "/lab/vm/firecracker/a/root/diff.state".into(),
        memory: "/lab/vm/firecracker/a/root/diff.mem".into(),
    };
    let diff = create_request(&jail, &files, SnapshotKind::Diff).unwrap();
    assert_eq!(diff["snapshot_type"], "Diff");
    assert_eq!(diff["sync_snapshot_files"], true);
    assert_eq!(diff["mem_file_path"], "/diff.mem");
    assert_eq!(
        create_request(&jail, &files, SnapshotKind::Full).unwrap()["snapshot_type"],
        "Full"
    );
}

fn paged_source() -> MemorySource {
    MemorySource::Pager(crate::PagerSpec {
        socket: "/lab/vm/firecracker/a/root/uffd.sock".into(),
        program: "/usr/bin/compute-host".into(),
        args: vec!["pager".into()],
    })
}
