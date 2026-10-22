//! Live cgroup-placement integration test for OOM fate isolation (issue #345).
//!
//! Exercises the REAL path — the service manager starts the test in the stable
//! supervisor subgroup and [`establish_oom_isolation`] verifies the topology
//! and a real shell `exec` forks a session-detached child — then asserts BOTH the shell
//! and the descendant land in one `op-<n>` memory leaf with the minimal OOM
//! victim preference relative to the supervisor while this process stays
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
//! systemd-run --user --wait --collect --setenv="PATH=$PATH" -p 'Delegate=cpu memory' \
//!   -p DelegateSubgroup=supervisor -p MemoryAccounting=yes -- \
//!   "$bin" --exact linux::child_is_accounted_and_task_abort_removes_op_cgroup --nocapture
//! ```
//!
//! To exercise real process-image update handover with unlimited operations, use
//! a fresh service with the same properties and this exact test name instead:
//!
//! ```text
//! linux::exec_handover_preserves_operation_cgroups_with_supervisor_children
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
    use opengeni_agent_proto::v1::{ExecRequest, OperationResourcePolicy};
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
        if ["cpu", "memory"].iter().any(|required| {
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
                 re-run the binary alone under `systemd-run --user -p 'Delegate=cpu memory' \
                 -p DelegateSubgroup=supervisor` \
                 with memory accounting enabled \
                 to exercise the live placement path (see the module docs)"
            );
            return;
        };

        // Run the real startup path: verify `<service>/supervisor` and delegate
        // accounting controllers from the empty service root to per-op leaves.
        let config = test_policy();
        let cgroups = establish_oom_isolation(config, &[])
            .expect("delegated + isolated cgroup should establish per-op isolation");
        let self_unified = assert_supervisor_setup(&service_dir);
        let platform = std::sync::Arc::new(
            NativePlatform::with_root(std::env::temp_dir()).with_oom_isolation(cgroups),
        );

        assert_fixture_prerequisites();
        prove_descendant_placement_and_abort(&service_dir, &self_unified, &platform, config).await;
        prove_spawn_failure_cleanup(&service_dir, &platform).await;
        prove_cpu_lease_lifecycle(&service_dir, &platform).await;
    }

    #[tokio::test]
    async fn shell_exit_reports_session_detached_children_from_owned_cgroup() {
        let Some(service_dir) = delegated_and_isolated() else {
            eprintln!("SKIP: cleanup evidence requires a dedicated delegated supervisor subgroup");
            return;
        };
        // Unlimited operation: this exercises lifecycle ownership, not resource policy.
        let cgroups =
            establish_oom_isolation(OpCgroupConfig::default(), &[]).expect("owned cgroup");
        let root = tempfile::tempdir().expect("fixture directory");
        let platform = NativePlatform::with_root(root.path()).with_oom_isolation(cgroups);
        let ready = root.path().join("detached.pid");
        let request = ExecRequest {
            command: vec!["setsid sh -c 'echo $$ > \"$READY\"; exec sleep 60' >/dev/null 2>&1 & while [ ! -s \"$READY\" ]; do sleep 0.01; done; cat \"$READY\"".into()],
            shell: true, timeout_ms: 5_000,
            env: std::collections::HashMap::from([("READY".into(), ready.to_string_lossy().into_owned())]),
            ..Default::default()
        };
        let response = platform.exec(&request).await.expect("contained shell");
        assert!(!response.timed_out);
        assert!(response.background_children_stopped);
        let descendant = String::from_utf8(response.stdout.to_vec()).unwrap();
        // A killed orphan can remain a zombie until PID 1 reaps it. Presence of
        // /proc alone is not liveness; the process must be absent or terminal.
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{}/stat", descendant.trim())) {
            let state = stat.rsplit_once(')').unwrap().1.split_whitespace().next();
            assert!(
                matches!(state, Some("Z" | "X" | "x")),
                "child survived cleanup: {stat}"
            );
        }
        assert!(!std::fs::read_dir(service_dir).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("op-")));
    }

    /// Run this test alone under systemd-run as described above. The predecessor
    /// checks exclusive ownership before creating fixtures; the successor must
    /// accept the supervisor helper that legitimately survives process-image exec.
    #[tokio::test]
    async fn exec_handover_preserves_operation_cgroups_with_supervisor_children() {
        use std::os::unix::process::CommandExt as _;

        const STATE_ENV: &str = "OPENGENI_TEST_CGROUP_HANDOVER";
        if let Ok(state) = std::env::var(STATE_ENV) {
            let state: HandoverFixture = serde_json::from_str(&state).unwrap();
            // Match agent startup: inherited pipes/leases become private before
            // the successor can spawn another child.
            for fd in state.exec.descriptors() {
                opengeni_agent_platform::keep_inherited_fd_private(fd).unwrap();
            }
            resume_handover_fixture(state).await;
            return;
        }
        let Some(service_dir) = delegated_and_isolated() else {
            eprintln!("SKIP: exec handover requires a dedicated delegated supervisor subgroup");
            return;
        };
        let cgroups = establish_oom_isolation(OpCgroupConfig::default(), &[])
            .expect("predecessor establishes operation cgroups");
        let platform =
            NativePlatform::with_root(std::env::current_dir().unwrap()).with_oom_isolation(cgroups);
        let mut command = platform
            .spawn_exec(&ExecRequest {
                command: vec![
                    "printf 'ready\\n'; read -r line; printf '%s\\n' \"$line\"; exit 7".into(),
                ],
                shell: true,
                ..Default::default()
            })
            .expect("predecessor command");
        let mut ready = String::new();
        tokio::time::timeout(
            Duration::from_secs(5),
            BufReader::new(command.stdout.as_mut().unwrap()).read_line(&mut ready),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(ready, "ready\n");

        // Infrastructure children are not operation commands. exec preserves
        // them in the supervisor leaf; do not move or kill them to establish it.
        let mut helper = std::process::Command::new("sleep")
            .arg("60")
            .spawn()
            .unwrap();
        let exec = command
            .into_handover()
            .unwrap_or_else(|(_, error)| panic!("{error}"));
        let state = HandoverFixture {
            supervisor_pid: std::process::id(),
            helper_pid: helper.id(),
            service_dir,
            exec,
        };
        assert_process_cgroup(state.helper_pid, &state.service_dir.join("supervisor"));
        assert_process_cgroup(
            u32::try_from(state.exec.child.pid.unwrap()).unwrap(),
            state.exec.op_cgroup_dir().unwrap(),
        );
        state.exec.prepare_exec().unwrap();
        let error = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "linux::exec_handover_preserves_operation_cgroups_with_supervisor_children",
                "--nocapture",
            ])
            .env(STATE_ENV, serde_json::to_string(&state).unwrap())
            .exec();
        // On successful exec the successor reaps this child by PID. If exec
        // itself fails, the predecessor still owns and must reap the helper.
        let _ = helper.kill();
        let _ = helper.wait();
        panic!("fixture process-image exec failed: {error}");
    }

    #[derive(serde::Serialize, serde::Deserialize)]
    struct HandoverFixture {
        supervisor_pid: u32,
        helper_pid: u32,
        service_dir: PathBuf,
        exec: opengeni_agent_platform::ExecHandover,
    }

    async fn resume_handover_fixture(state: HandoverFixture) {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        assert_eq!(
            std::process::id(),
            state.supervisor_pid,
            "exec keeps the PID"
        );
        let supervisor_dir = state.service_dir.join("supervisor");
        assert_process_cgroup(state.supervisor_pid, &supervisor_dir);
        assert_process_cgroup(state.helper_pid, &supervisor_dir);
        let leaf = state.exec.op_cgroup_dir().unwrap().to_path_buf();
        let cgroups =
            establish_oom_isolation(OpCgroupConfig::default(), std::slice::from_ref(&leaf))
                .expect("successor must retain containment with a surviving supervisor helper");
        let platform =
            NativePlatform::with_root(std::env::current_dir().unwrap()).with_oom_isolation(cgroups);
        let mut adopted = platform
            .adopt_exec(&state.exec)
            .expect("adopt operation cgroup");
        assert_process_cgroup(u32::try_from(state.exec.child.pid.unwrap()).unwrap(), &leaf);
        assert_process_cgroup(
            u32::try_from(state.exec.anchor.pid.unwrap()).unwrap(),
            &leaf,
        );
        assert_eq!(
            std::fs::read_to_string(leaf.join("memory.max"))
                .unwrap()
                .trim(),
            "max"
        );
        assert_eq!(
            std::fs::read_to_string(leaf.join("memory.high"))
                .unwrap()
                .trim(),
            "max"
        );

        let mut fresh = platform
            .spawn_exec(&ExecRequest {
                command: vec!["read -r line".into()],
                shell: true,
                ..Default::default()
            })
            .unwrap();
        let fresh_handover = fresh
            .into_handover()
            .unwrap_or_else(|(_, error)| panic!("{error}"));
        let fresh_leaf = fresh_handover.op_cgroup_dir().unwrap().to_path_buf();
        assert_ne!(
            fresh_leaf, leaf,
            "successor allocates a distinct operation leaf"
        );
        assert_eq!(fresh_leaf.parent(), Some(state.service_dir.as_path()));
        assert_process_cgroup(
            u32::try_from(fresh_handover.child.pid.unwrap()).unwrap(),
            &fresh_leaf,
        );
        fresh = platform.adopt_exec(&fresh_handover).unwrap();
        fresh
            .stdin
            .take()
            .unwrap()
            .write_all(b"finish\n")
            .await
            .unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(5), fresh.wait())
            .await
            .unwrap()
            .unwrap()
            .success());
        assert!(
            !fresh_leaf.exists(),
            "new command's operation leaf is reclaimed"
        );

        adopted
            .stdin
            .take()
            .unwrap()
            .write_all(b"survived\n")
            .await
            .unwrap();
        let mut stdout = adopted.stdout.take().unwrap();
        let status = tokio::time::timeout(Duration::from_secs(5), adopted.wait())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status.code(), Some(7));
        let mut output = String::new();
        stdout.read_to_string(&mut output).await.unwrap();
        assert_eq!(output, "survived\n", "handed-over pipes still work");
        assert!(!leaf.exists(), "handed-over operation leaf is reclaimed");
        assert_process_cgroup(state.helper_pid, &supervisor_dir);
        let helper = nix::unistd::Pid::from_raw(i32::try_from(state.helper_pid).unwrap());
        nix::sys::signal::kill(helper, nix::sys::signal::Signal::SIGTERM).unwrap();
        nix::sys::wait::waitpid(helper, None).unwrap();
        eprintln!("PASS: real exec retained the helper, adopted command containment and fresh-command containment");
    }

    fn assert_process_cgroup(pid: u32, expected: &Path) {
        let actual = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap();
        assert_eq!(
            Path::new("/sys/fs/cgroup")
                .join(unified_cgroup_of(&actual).unwrap().trim_start_matches('/')),
            expected,
        );
    }

    async fn prove_descendant_placement_and_abort(
        service_dir: &Path,
        self_unified: &str,
        platform: &std::sync::Arc<NativePlatform>,
        config: OpCgroupConfig,
    ) {
        // Run a real shell exec that forks a descendant into a different session.
        // Both publish their PIDs and stay alive. Process-group kill cannot reach
        // that descendant; task-abort cleanup must use the operation cgroup.
        let req = ExecRequest {
            command: vec![
                "echo $$; setsid sh -c 'echo $$; while :; do :; done' & wait".to_string(),
            ],
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
        let expected_score = expected_exec_oom_score();
        assert_eq!(score, expected_score, "exec shell {leader_pid} OOM bias");
        assert_eq!(
            descendant_score, expected_score,
            "fast descendant {detached_pid} OOM bias"
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
        assert_controller_neutrality_after_cleanup(service_dir);
    }

    async fn prove_spawn_failure_cleanup(
        service_dir: &Path,
        platform: &std::sync::Arc<NativePlatform>,
    ) {
        // Fault injection through a real post-fork execve failure: the anchor has
        // already populated the fresh op leaf when the command spawn reports
        // ENOENT. Returning the error must cgroup.kill the anchor and remove the
        // leaf; a process-group-only cleanup would not prove recursive ownership.
        let prior_leaves = operation_leaves(service_dir);
        let missing = ExecRequest {
            command: vec![format!(
                "/definitely-missing-opengeni-cgroup-fixture-{}",
                std::process::id()
            )],
            ..Default::default()
        };
        assert!(
            platform.spawn_exec(&missing).is_err(),
            "missing executable must fail after the anchor spawn"
        );
        wait_for_operation_leaves(service_dir, &prior_leaves).await;
        assert_controller_neutrality_after_cleanup(service_dir);
    }

    async fn prove_cpu_lease_lifecycle(
        service_dir: &Path,
        platform: &std::sync::Arc<NativePlatform>,
    ) {
        // CPU is an opt-in controller lease, not sticky startup accounting. Prove
        // a populated unlimited sibling remains admitted, two limited leaves hold
        // the shared lease independently, and the final limited cleanup removes
        // +cpu again without waiting for the unlimited operation to exit.
        let (unlimited_leaf, unlimited_task) = spawn_live_operation(platform, None).await;
        assert_controller_neutrality_after_cleanup(service_dir);
        let cpu_policy = OperationResourcePolicy {
            cpu_max_millicores: Some(500),
            ..Default::default()
        };
        let (limited_leaf_one, limited_task_one) =
            spawn_live_operation(platform, Some(&cpu_policy)).await;
        let (limited_leaf_two, limited_task_two) =
            spawn_live_operation(platform, Some(&cpu_policy)).await;
        assert_subtree_controller(service_dir, "cpu", true);
        assert_exact_cpu_quota(&limited_leaf_one, 500);
        assert_exact_cpu_quota(&limited_leaf_two, 500);

        limited_task_one.abort();
        assert!(limited_task_one
            .await
            .expect_err("first limited task must be cancelled")
            .is_cancelled());
        wait_for_removal(&limited_leaf_one).await;
        assert_subtree_controller(service_dir, "cpu", true);

        limited_task_two.abort();
        assert!(limited_task_two
            .await
            .expect_err("second limited task must be cancelled")
            .is_cancelled());
        wait_for_removal(&limited_leaf_two).await;
        assert!(unlimited_leaf.exists(), "unlimited sibling remains live");
        assert_controller_neutrality_after_cleanup(service_dir);

        unlimited_task.abort();
        assert!(unlimited_task
            .await
            .expect_err("unlimited task must be cancelled")
            .is_cancelled());
        wait_for_removal(&unlimited_leaf).await;
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

    fn expected_exec_oom_score() -> String {
        let supervisor = std::fs::read_to_string("/proc/self/oom_score_adj")
            .expect("read supervisor OOM score")
            .trim()
            .parse::<i32>()
            .expect("numeric supervisor OOM score");
        if supervisor < 0 {
            "0".to_string()
        } else {
            supervisor.saturating_add(1).min(1000).to_string()
        }
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
        assert!(
            subtree.split_whitespace().any(|actual| actual == "memory"),
            "runner must enable memory containment; effective: {subtree}"
        );
        for controller in ["cpu", "io", "pids"] {
            assert!(
                !subtree
                    .split_whitespace()
                    .any(|actual| actual == controller),
                "unrestricted startup must not enable {controller}; effective: {subtree}"
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
            cpu_max_millicores: None,
        }
    }

    fn assert_controller_accounting(op_leaf: &Path, config: OpCgroupConfig) {
        assert!(
            op_leaf.join("memory.current").is_file(),
            "memory accounting file"
        );
        assert!(
            !op_leaf.join("pids.current").exists(),
            "the unrestricted default must not activate hierarchical PID control"
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
        match config.cpu_max_millicores {
            Some(millicores) => {
                let cpu_max = std::fs::read_to_string(op_leaf.join("cpu.max"))
                    .expect("read explicit operation CPU quota");
                let mut fields = cpu_max.split_whitespace();
                let quota = fields.next().unwrap().parse::<u64>().unwrap();
                let period = fields.next().unwrap().parse::<u64>().unwrap();
                assert_eq!(quota * 1_000, period * u64::from(millicores));
            }
            None => assert!(
                !op_leaf.join("cpu.max").exists(),
                "unrestricted work must not activate hierarchical CPU scheduling"
            ),
        }
        assert!(
            !op_leaf.join("io.stat").exists(),
            "unrestricted startup must not activate hierarchical I/O control"
        );
    }

    fn assert_controller_neutrality_after_cleanup(service_dir: &Path) {
        let subtree = std::fs::read_to_string(service_dir.join("cgroup.subtree_control"))
            .expect("read subtree after operation cleanup");
        for controller in ["cpu", "io", "pids"] {
            assert!(
                !subtree
                    .split_whitespace()
                    .any(|actual| actual == controller),
                "controller {controller} remained active after the final limited leaf: {subtree}"
            );
        }
    }

    fn assert_subtree_controller(service_dir: &Path, controller: &str, expected: bool) {
        let subtree = std::fs::read_to_string(service_dir.join("cgroup.subtree_control"))
            .expect("read subtree controller state");
        assert_eq!(
            subtree
                .split_whitespace()
                .any(|actual| actual == controller),
            expected,
            "controller {controller} state in {subtree:?}"
        );
    }

    fn assert_exact_cpu_quota(op_leaf: &Path, millicores: u32) {
        let cpu_max =
            std::fs::read_to_string(op_leaf.join("cpu.max")).expect("read explicit CPU quota");
        let mut fields = cpu_max.split_whitespace();
        let quota = fields.next().unwrap().parse::<u64>().unwrap();
        let period = fields.next().unwrap().parse::<u64>().unwrap();
        assert_eq!(fields.next(), None);
        assert_eq!(quota * 1_000, period * u64::from(millicores));
    }

    async fn spawn_live_operation(
        platform: &NativePlatform,
        policy: Option<&OperationResourcePolicy>,
    ) -> (
        PathBuf,
        tokio::task::JoinHandle<std::io::Result<std::process::ExitStatus>>,
    ) {
        let request = ExecRequest {
            command: vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                "echo $$; exec sleep infinity".to_string(),
            ],
            ..Default::default()
        };
        let mut contained = platform
            .spawn_exec_with_policy(&request, policy)
            .expect("spawn live controller-lease fixture");
        drop(contained.stdin.take());
        let mut stdout = BufReader::new(contained.stdout.take().expect("fixture stdout"));
        let mut task = tokio::spawn(async move { contained.wait().await });
        let mut line = String::new();
        let read = tokio::select! {
            read = stdout.read_line(&mut line) => read.expect("read live operation pid"),
            result = &mut task => panic!("live operation ended before readiness: {result:?}"),
        };
        assert_ne!(read, 0, "live operation closed stdout before readiness");
        let pid = line
            .trim()
            .parse::<u32>()
            .expect("numeric live operation pid");
        let unified = child_cgroup(pid);
        let leaf = Path::new("/sys/fs/cgroup").join(unified.trim_start_matches('/'));
        (leaf, task)
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

    fn operation_leaves(service_dir: &Path) -> Vec<PathBuf> {
        let mut leaves = std::fs::read_dir(service_dir)
            .expect("enumerate operation leaves")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.file_type().is_ok_and(|kind| kind.is_dir())
                    && entry
                        .file_name()
                        .to_str()
                        .is_some_and(|name| name.starts_with("op-"))
            })
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        leaves.sort();
        leaves
    }

    async fn wait_for_operation_leaves(service_dir: &Path, expected: &[PathBuf]) {
        for _ in 0..200 {
            if operation_leaves(service_dir) == expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "post-spawn failure leaked an operation leaf: expected {expected:?}, got {:?}",
            operation_leaves(service_dir)
        );
    }

    /// Waits on the fixture's stdout readiness signal rather than guessing a
    /// disk-I/O polling deadline. If the direct command exits first, surface its
    /// exact result immediately.
    async fn require_fixture_pids(
        stdout: &mut BufReader<tokio::process::ChildStdout>,
        exec_task: &mut tokio::task::JoinHandle<std::io::Result<std::process::ExitStatus>>,
    ) -> (u32, u32) {
        let shell = require_fixture_pid(stdout, exec_task, "shell").await;
        let descendant = require_fixture_pid(stdout, exec_task, "descendant").await;
        (shell, descendant)
    }

    async fn require_fixture_pid(
        stdout: &mut BufReader<tokio::process::ChildStdout>,
        exec_task: &mut tokio::task::JoinHandle<std::io::Result<std::process::ExitStatus>>,
        label: &str,
    ) -> u32 {
        let mut line = String::new();
        let read = tokio::select! {
            read = stdout.read_line(&mut line) => read.expect("read fixture readiness line"),
            result = &mut *exec_task => panic!("exec ended before publishing fixture PIDs: {result:?}"),
        };
        assert_ne!(
            read, 0,
            "fixture stdout closed before publishing {label} PID"
        );
        let mut parts = line.split_whitespace();
        let (Some(pid), None) = (parts.next(), parts.next()) else {
            panic!("fixture published malformed {label} PID line: {line:?}");
        };
        pid.parse::<u32>()
            .unwrap_or_else(|_| panic!("fixture published non-numeric {label} PID: {line:?}"))
    }

    fn child_cgroup(child_pid: u32) -> String {
        let text = std::fs::read_to_string(format!("/proc/{child_pid}/cgroup"))
            .expect("read live fixture cgroup");
        unified_cgroup_of(&text).expect("fixture has a unified cgroup")
    }
}
