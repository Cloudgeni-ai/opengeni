use super::*;

const MEMINFO: &str = "\
MemTotal:       65536000 kB
MemFree:         1000000 kB
MemAvailable:   60000000 kB
Zswap:             10240 kB
Zswapped:          40960 kB
HugePages_Total:     100
HugePages_Free:       60
Hugepagesize:       2048 kB
";

#[test]
fn host_memory_reads_the_counters_it_needs() {
    assert_eq!(
        HostMemory::parse(MEMINFO),
        HostMemory {
            available: 60_000_000 * 1024,
            zswap: 10 << 20,
            zswapped: 40 << 20,
            huge_pages_used: 40 * (2 << 20),
        }
    );
}

#[test]
fn missing_counters_read_as_zero() {
    assert_eq!(
        HostMemory::parse("MemAvailable: 4 kB\n"),
        HostMemory {
            available: 4096,
            ..HostMemory::default()
        }
    );
}

#[test]
fn scan_finds_the_record_and_its_status() {
    assert_eq!(
        scan(b"out\n\x1ecompute-bench-done 0\x1e", 0).unwrap(),
        Scan::Done {
            output: 4,
            status: 0
        }
    );
    assert_eq!(
        scan(b"\x1ecompute-bench-done 127\x1e", 0).unwrap(),
        Scan::Done {
            output: 0,
            status: 127
        }
    );
}

#[test]
fn scan_holds_back_what_may_become_the_record() {
    // A record split across reads is neither output nor done yet.
    assert_eq!(
        scan(b"out\x1ecompute-be", 0).unwrap(),
        Scan::Running { output: 3 }
    );
    assert_eq!(
        scan(b"out\x1ecompute-bench-done 1", 0).unwrap(),
        Scan::Running { output: 3 }
    );
    // Output that only looks like the start for a while is released.
    assert_eq!(
        scan(b"out\x1ecompute-x", 0).unwrap(),
        Scan::Running { output: 13 }
    );
    // Nothing printed yet: no first byte.
    assert_eq!(scan(b"\x1e", 0).unwrap(), Scan::Running { output: 0 });
}

#[test]
fn scan_resumes_where_the_last_one_stopped() {
    let mut buffer = b"abc\x1ecompute-bench".to_vec();
    let Scan::Running { output } = scan(&buffer, 0).unwrap() else {
        panic!("not done yet");
    };
    assert_eq!(output, 3);
    buffer.extend_from_slice(b"-done 3\x1e");
    assert_eq!(
        scan(&buffer, output).unwrap(),
        Scan::Done {
            output: 3,
            status: 3
        }
    );
}

#[test]
fn scan_rejects_a_malformed_record() {
    assert!(scan(b"\x1ecompute-bench-done x\x1e", 0).is_err());
    assert!(scan(b"\x1ecompute-bench-done \x1e", 0).is_err());
    assert!(scan(b"\x1ecompute-bench-done 1234", 0).is_err());
}

/// Feeds `script`, framed, to a real shell, as the guest's would get it.
fn run_framed(script: &str) -> (String, i32) {
    use std::io::Write as _;
    let mut shell = std::process::Command::new("sh")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    shell
        .stdin
        .take()
        .unwrap()
        .write_all(framed(script).as_bytes())
        .unwrap();
    let stdout = shell.wait_with_output().unwrap().stdout;
    let Scan::Done { output, status } = scan(&stdout, 0).unwrap() else {
        panic!("no completion record in {stdout:?}");
    };
    (
        String::from_utf8(stdout[..output].to_vec()).unwrap(),
        status,
    )
}

#[test]
fn the_record_carries_the_scripts_exit_status() {
    assert_eq!(run_framed("echo hi"), ("hi\n".into(), 0));
    assert_eq!(run_framed("false"), (String::new(), 1));
    assert_eq!(run_framed("echo partial; exit 7"), ("partial\n".into(), 7));
}

#[test]
fn exit_exec_and_syntax_errors_cannot_swallow_the_record() {
    assert_eq!(run_framed("exit 0"), (String::new(), 0));
    assert_eq!(run_framed("exec echo replaced"), ("replaced\n".into(), 0));
    assert_ne!(run_framed("if then fi").1, 0);
}

#[test]
fn scripts_keep_their_quotes_and_cannot_read_the_lines_after_them() {
    assert_eq!(run_framed("echo 'a  b' \"c'd\""), ("a  b c'd\n".into(), 0));
    // Reading stdin finds nothing instead of the record's own lines.
    assert_eq!(run_framed("cat; echo after"), ("after\n".into(), 0));
}

#[test]
fn scripts_run_under_bash_whatever_the_outer_shell() {
    assert_eq!(
        run_framed("for i in {1..3}; do printf x; done"),
        ("xxx".into(), 0)
    );
}

#[test]
fn per_sandbox_cost_divides_what_changed() {
    let before = HostMemory {
        available: 1000 << 20,
        zswap: 0,
        zswapped: 0,
        huge_pages_used: 0,
    };
    let now = HostMemory {
        available: 600 << 20,
        zswap: 40 << 20,
        zswapped: 160 << 20,
        huge_pages_used: 200 << 20,
    };
    assert_eq!(
        now.per_sandbox(before, 4),
        MemoryPerSandbox {
            available_lost: 100 << 20,
            zswap: 10 << 20,
            huge_pages: 50 << 20,
        }
    );
    // Memory freed elsewhere shows as a negative cost, not a wrap.
    assert!(before.per_sandbox(now, 4).available_lost < 0);
}
