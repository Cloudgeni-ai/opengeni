//! Live cgroup-placement integration test for OOM fate isolation (issue #345).
//!
//! Exercises the REAL path — the service manager starts the test in the stable
//! supervisor subgroup and [`establish_oom_isolation`] verifies the topology
//! and a real shell `exec` forks a session-detached child — then asserts BOTH the shell
//! and the descendant land in one `op-<n>` leaf with CPU/I/O/memory/PID
//! accounting and `oom_score_adj=500` while the supervisor (this process) stays
//! in the `supervisor` leaf. It then aborts the owning task and proves the
//! operation cgroup disappears. Because the child has a different process group,
//! this is the live regression proof for cgroup-owned cancellation as well as
//! cancellation-safe lifecycle cleanup.
//!
//! # Why it is environment-gated
//!
//! The test enables child controllers, which is safe only when a service manager
//! has already placed this sole process in a dedicated supervisor subgroup under
//! an empty delegated cgroup root. A shared or non-delegated cgroup (a normal
//! `cargo test`, most CI) fails
//! the gate and the test SKIPS LOUDLY without mutating anything. To run the
//! positive path, launch the test binary alone in a delegated scope, e.g.:
//!
//! ```text
//! bin=$(cargo test -p opengeni-agent-platform --test cgroup_placement --no-run \
//!         --message-format=json | jq -r 'select(.executable!=null).executable')
//! systemd-run --user --wait --collect -p Delegate=yes \
//!   -p DelegateSubgroup=supervisor -p CPUAccounting=yes -p IOAccounting=yes \
//!   -p MemoryAccounting=yes -p TasksAccounting=yes -- \
//!   "$bin" --exact child_is_accounted_and_task_abort_removes_op_cgroup --nocapture
//! ```
//!
//! Off Linux the whole test compiles to a loud skip (isolation is Linux-only).

#[cfg(not(target_os = "linux"))]
#[test]
fn cgroup_placement_is_linux_only() {
    eprintln!(
        "SKIP: per-op cgroup placement is a Linux cgroup v2 feature; nothing to verify on this OS"
    );
}

#[cfg(target_os = "linux")]
mod linux {
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use opengeni_agent_platform::{
        establish_oom_isolation, NativePlatform, OpCgroupConfig, Platform,
    };
    use opengeni_agent_proto::v1::ExecRequest;
    use tokio::io::{AsyncBufReadExt as _, BufReader};

    /// The cgroup v2 unified path (after the `0::` prefix) for a PID's cgroup file.
    fn unified_cgroup_of(cgroup_file: &str) -> Option<String> {
        cgroup_file
            .lines()
            .find_map(|line| line.strip_prefix("0::"))
            .map(|p| p.trim().to_string())
    }

    /// Read-only gate: returns the service cgroup root only when this process is
    /// the sole member of its `supervisor` child, the delegated root is empty, and
    /// every required accounting controller is available. Everything else skips
    /// without touching a cgroup.
    fn delegated_and_isolated() -> Option<PathBuf> {
        let mount = Path::new("/sys/fs/cgroup");
        if !mount.join("cgroup.controllers").exists() {
            return None;
        }
        let proc_cgroup = std::fs::read_to_string("/proc/self/cgroup").ok()?;
        let unified = unified_cgroup_of(&proc_cgroup)?;
        if unified == "/" || unified.is_empty() {
            return None;
        }
        let supervisor_dir = mount.join(unified.trim_start_matches('/'));
        if supervisor_dir.file_name()? != "supervisor" {
            return None;
        }
        let dir = supervisor_dir.parent()?.to_path_buf();
        let controllers = std::fs::read_to_string(dir.join("cgroup.controllers")).ok()?;
        if ["cpu", "io", "memory", "pids"].iter().any(|required| {
            !controllers
                .split_whitespace()
                .any(|actual| actual == *required)
        }) {
            return None;
        }
        let procs = std::fs::read_to_string(supervisor_dir.join("cgroup.procs")).ok()?;
        let members: Vec<&str> = procs.split_whitespace().collect();
        let me = std::process::id().to_string();
        if members != [me.as_str()] {
            return None;
        }
        if std::fs::read_to_string(dir.join("cgroup.procs"))
            .ok()?
            .split_whitespace()
            .next()
            .is_some()
        {
            return None;
        }
        Some(dir)
    }

    #[tokio::test]
    async fn child_is_accounted_and_task_abort_removes_op_cgroup() {
        let Some(service_dir) = delegated_and_isolated() else {
            eprintln!(
                "SKIP: not the sole member of a manager-owned delegated supervisor subgroup; \
                 re-run the binary alone under `systemd-run --user -p Delegate=yes \
                 -p DelegateSubgroup=supervisor` \
                 with CPU/IO/Memory/Tasks accounting enabled \
                 to exercise the live placement path (see the module docs)"
            );
            return;
        };

        // Run the real startup path: verify `<service>/supervisor` and delegate
        // accounting controllers from the empty service root to per-op leaves.
        let config = test_policy();
        let cgroups = establish_oom_isolation(config)
            .expect("delegated + isolated cgroup should establish per-op isolation");
        let self_unified = assert_supervisor_setup(&service_dir);
        let platform = std::sync::Arc::new(
            NativePlatform::with_root(std::env::temp_dir()).with_oom_isolation(cgroups),
        );

        assert_fixture_prerequisites();

        // Run a real shell exec that forks a descendant into a different session.
        // Both publish their PIDs and stay alive. Process-group kill cannot reach
        // that descendant; task-abort cleanup must use the operation cgroup.
        let io_file = std::env::temp_dir().join(format!("cgroup-io-{}.bin", std::process::id()));
        let _ = std::fs::remove_file(&io_file);
        let req = ExecRequest {
            command: vec![format!(
                "setsid sh -c 'while :; do :; done' & child=$!; \
                 page=$(getconf PAGESIZE); dd if=/dev/zero of={} bs=$page count=1 \
                 oflag=direct conv=fsync \
                 >/dev/null 2>&1; echo $$ $child; wait",
                io_file.display(),
            )],
            shell: true,
            ..Default::default()
        };
        let mut contained = platform.spawn_exec(&req).expect("spawn contained fixture");
        drop(contained.stdin.take());
        let stdout = contained.stdout.take().expect("fixture stdout");
        let mut stdout = BufReader::new(stdout);
        let mut exec_task = tokio::spawn(async move { contained.wait().await });
        let (leader_pid, detached_pid) = require_fixture_pids(&mut stdout, &mut exec_task).await;
        assert_distinct_process_groups(leader_pid, detached_pid);

        // The fixture publishes only after user code has already created its
        // session-detached descendant. Both paths must therefore be correct on the
        // first observation; retrying here would hide a pre-exec placement race.
        let shell_unified = child_cgroup(leader_pid);
        let descendant_unified = child_cgroup(detached_pid);
        let score = std::fs::read_to_string(format!("/proc/{leader_pid}/oom_score_adj"))
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let descendant_score =
            std::fs::read_to_string(format!("/proc/{detached_pid}/oom_score_adj"))
                .map(|s| s.trim().to_string())
                .unwrap_or_default();

        eprintln!("LIVE EVIDENCE (issue #345 OOM fate isolation):");
        eprintln!("  supervisor (this process) cgroup: {self_unified}");
        eprintln!("  exec shell {leader_pid} cgroup:      {shell_unified}");
        eprintln!("  descendant {detached_pid} cgroup: {descendant_unified}");
        eprintln!("  exec shell {leader_pid} oom_score_adj: {score}");
        eprintln!("  descendant {detached_pid} oom_score_adj: {descendant_score}");

        assert!(
            shell_unified.contains("/op-"),
            "exec shell {leader_pid} must run in an op-<n> leaf, got {shell_unified}"
        );
        assert_eq!(
            descendant_unified, shell_unified,
            "fast descendant {detached_pid} must share the shell's op leaf"
        );
        assert!(
            shell_unified.starts_with(&self_unified[..self_unified.len() - "/supervisor".len()]),
            "the op leaf must be a sibling of the supervisor leaf under the service cgroup \
             ({shell_unified} vs {self_unified})"
        );
        assert_eq!(
            score, "500",
            "exec shell {leader_pid} must carry oom_score_adj=500"
        );
        assert_eq!(
            descendant_score, "500",
            "fast descendant {detached_pid} must carry oom_score_adj=500"
        );
        let op_leaf = service_dir.join(shell_unified.rsplit('/').next().expect("op leaf name"));
        assert_eq!(
            std::fs::read_to_string(op_leaf.join("memory.oom.group"))
                .expect("read operation OOM grouping")
                .trim(),
            "1",
            "a memcg OOM must terminate the complete operation"
        );

        // The op leaf is a real child of the resolved service cgroup.
        assert!(
            op_leaf.exists(),
            "the op leaf {shell_unified} should exist under {}",
            service_dir.display()
        );
        assert_controller_accounting(&op_leaf, config);

        exec_task.abort();
        assert!(exec_task
            .await
            .expect_err("aborted task must be cancelled")
            .is_cancelled());
        wait_for_removal(&op_leaf).await;
        assert!(
            !Path::new(&format!("/proc/{detached_pid}")).exists(),
            "session-detached descendant survived operation-cgroup cleanup"
        );
        let _ = std::fs::remove_file(&io_file);
    }

    fn assert_fixture_prerequisites() {
        assert!(
            std::process::Command::new("setsid")
                .arg("--version")
                .output()
                .is_ok_and(|output| output.status.success()),
            "the live lifecycle fixture requires util-linux setsid"
        );
    }

    fn assert_distinct_process_groups(leader_pid: u32, detached_pid: u32) {
        let process_group = |pid: u32| {
            nix::unistd::getpgid(Some(nix::unistd::Pid::from_raw(
                i32::try_from(pid).expect("fixture pid fits i32"),
            )))
            .expect("read fixture process group")
        };
        assert_ne!(
            process_group(leader_pid),
            process_group(detached_pid),
            "fixture descendant must escape process-group kill so cgroup.kill owns cleanup"
        );
    }

    fn assert_supervisor_setup(service_dir: &Path) -> String {
        let subtree = std::fs::read_to_string(service_dir.join("cgroup.subtree_control"))
            .expect("read effective subtree controllers");
        for controller in ["cpu", "io", "memory", "pids"] {
            assert!(
                subtree
                    .split_whitespace()
                    .any(|actual| actual == controller),
                "runner must enable delegated {controller} accounting; effective: {subtree}"
            );
        }

        let self_cgroup =
            std::fs::read_to_string("/proc/self/cgroup").expect("read own cgroup after dance");
        let self_unified = unified_cgroup_of(&self_cgroup).expect("own unified cgroup");
        assert!(
            self_unified.ends_with("/supervisor"),
            "supervisor must be fate-isolated in its own leaf, got {self_unified}"
        );
        let oomd_avoid = xattr::get(service_dir.join("supervisor"), "user.oomd_avoid")
            .expect("read supervisor oomd preference")
            .expect("supervisor oomd preference must be present");
        assert_eq!(
            oomd_avoid, b"1",
            "the actual supervisor leaf must be protected from systemd-oomd"
        );
        self_unified
    }

    fn test_policy() -> OpCgroupConfig {
        if std::env::var_os("OPENGENI_CGROUP_TEST_EXPLICIT_POLICY").is_none() {
            return OpCgroupConfig::default();
        }
        let total_kib = std::fs::read_to_string("/proc/meminfo")
            .expect("read guest memory capacity")
            .lines()
            .find_map(|line| line.strip_prefix("MemTotal:"))
            .and_then(|value| value.split_whitespace().next())
            .and_then(|value| value.parse::<u64>().ok())
            .expect("parse guest MemTotal");
        let page_bytes = std::fs::read_to_string("/proc/self/smaps")
            .expect("read guest kernel page size")
            .lines()
            .find_map(|line| line.strip_prefix("KernelPageSize:"))
            .and_then(|value| value.split_whitespace().next())
            .and_then(|value| value.parse::<u64>().ok())
            .map(|kib| kib * 1024)
            .expect("parse guest kernel page size");
        // Use the measured guest capacity itself rather than inventing a test
        // quota or reserve. Align to the kernel's reported page granularity so
        // desired and effective values are directly comparable; the fixture does
        // not allocate toward this ceiling.
        let memory_max = (total_kib.saturating_mul(1024) / page_bytes) * page_bytes;
        OpCgroupConfig {
            memory_max: Some(memory_max),
            memory_high: Some(memory_max),
        }
    }

    fn assert_controller_accounting(op_leaf: &Path, config: OpCgroupConfig) {
        let pids_current = std::fs::read_to_string(op_leaf.join("pids.current"))
            .expect("operation PID accounting")
            .trim()
            .parse::<u64>()
            .expect("numeric pids.current");
        assert!(
            pids_current >= 2,
            "shell and descendant must both be charged"
        );
        assert!(op_leaf.join("cpu.stat").is_file(), "CPU accounting file");
        assert!(
            op_leaf.join("memory.current").is_file(),
            "memory accounting file"
        );
        assert_eq!(
            std::fs::read_to_string(op_leaf.join("pids.max"))
                .expect("read operation PID limit")
                .trim(),
            "max",
            "accounting must not install an implicit PID limit"
        );
        let memory_max = std::fs::read_to_string(op_leaf.join("memory.max"))
            .expect("read operation memory limit");
        match config.memory_max {
            Some(expected) => assert_eq!(memory_max.trim(), expected.to_string()),
            None => assert_eq!(
                memory_max.trim(),
                "max",
                "accounting must not install an implicit memory limit"
            ),
        }
        let memory_high = std::fs::read_to_string(op_leaf.join("memory.high"))
            .expect("read operation memory throttle");
        match config.memory_high {
            Some(expected) => assert_eq!(memory_high.trim(), expected.to_string()),
            None => assert_eq!(
                memory_high.trim(),
                "max",
                "accounting must not install an implicit memory throttle"
            ),
        }
        assert!(
            std::fs::read_to_string(op_leaf.join("cpu.max"))
                .expect("read operation CPU limit")
                .starts_with("max "),
            "accounting must not install an implicit CPU quota"
        );

        let io = std::fs::read_to_string(op_leaf.join("io.stat"))
            .expect("read operation I/O accounting");
        assert!(
            io_stat_reports_activity(&io),
            "operation I/O accounting did not charge the completed direct fixture write; io.stat={io:?}"
        );
    }

    fn io_stat_reports_activity(contents: &str) -> bool {
        contents.split_whitespace().any(|field| {
            let Some((name, value)) = field.split_once('=') else {
                return false;
            };
            matches!(name, "rbytes" | "wbytes" | "rios" | "wios")
                && value.parse::<u64>().is_ok_and(|value| value > 0)
        })
    }

    async fn wait_for_removal(op_leaf: &Path) {
        for _ in 0..200 {
            if !op_leaf.exists() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let events = std::fs::read_to_string(op_leaf.join("cgroup.events")).unwrap_or_default();
        let procs = std::fs::read_to_string(op_leaf.join("cgroup.procs")).unwrap_or_default();
        let process_evidence = procs
            .split_whitespace()
            .map(|pid| {
                let status =
                    std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap_or_default();
                let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
                format!("pid={pid} status={status:?} stat={stat:?}")
            })
            .collect::<Vec<_>>();
        panic!(
            "task abort retained operation cgroup {}; events={events:?} procs={procs:?} process_evidence={process_evidence:?}",
            op_leaf.display()
        );
    }

    /// Waits on the fixture's stdout readiness signal rather than guessing a
    /// disk-I/O polling deadline. If the direct command exits first, surface its
    /// exact result immediately.
    async fn require_fixture_pids(
        stdout: &mut BufReader<tokio::process::ChildStdout>,
        exec_task: &mut tokio::task::JoinHandle<std::io::Result<std::process::ExitStatus>>,
    ) -> (u32, u32) {
        let mut line = String::new();
        let read = tokio::select! {
            read = stdout.read_line(&mut line) => read.expect("read fixture readiness line"),
            result = &mut *exec_task => panic!("exec ended before publishing fixture PIDs: {result:?}"),
        };
        assert_ne!(read, 0, "fixture stdout closed before publishing both PIDs");
        let mut parts = line.split_whitespace();
        let (Some(shell), Some(descendant), None) = (parts.next(), parts.next(), parts.next())
        else {
            panic!("fixture published malformed PID line: {line:?}");
        };
        (
            shell.parse::<u32>().expect("numeric shell PID"),
            descendant.parse::<u32>().expect("numeric descendant PID"),
        )
    }

    fn child_cgroup(child_pid: u32) -> String {
        let text = std::fs::read_to_string(format!("/proc/{child_pid}/cgroup"))
            .expect("read live fixture cgroup");
        unified_cgroup_of(&text).expect("fixture has a unified cgroup")
    }
}
