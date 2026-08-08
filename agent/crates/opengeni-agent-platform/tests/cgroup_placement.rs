//! Live cgroup-placement integration test for OOM fate isolation (issue #345).
//!
//! Exercises the REAL path — [`establish_oom_isolation`] runs the startup dance
//! and a real shell `exec` immediately forks a child — then asserts BOTH the shell
//! and the fast descendant land in one `op-<n>` memory leaf with
//! `oom_score_adj=500` while the supervisor (this process) stays in the
//! `supervisor` leaf. This is the live regression proof for the post-spawn fork
//! race observed in production.
//!
//! # Why it is environment-gated
//!
//! The dance MOVES this process's own cgroup and enables a controller, which only
//! works in a delegated cgroup v2 service cgroup where this process is the SOLE
//! member. A shared or non-delegated cgroup (a normal `cargo test`, most CI) fails
//! the gate and the test SKIPS LOUDLY without mutating anything. To run the
//! positive path, launch the test binary alone in a delegated scope, e.g.:
//!
//! ```text
//! bin=$(cargo test -p opengeni-agent-platform --test cgroup_placement --no-run \
//!         --message-format=json | jq -r 'select(.executable!=null).executable')
//! systemd-run --user --scope -p Delegate=yes -p MemoryAccounting=yes -- \
//!   "$bin" --exact child_lands_in_op_cgroup_supervisor_stays_isolated --nocapture
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

    /// The cgroup v2 unified path (after the `0::` prefix) for a PID's cgroup file.
    fn unified_cgroup_of(cgroup_file: &str) -> Option<String> {
        cgroup_file
            .lines()
            .find_map(|line| line.strip_prefix("0::"))
            .map(|p| p.trim().to_string())
    }

    /// Read-only gate: returns the service cgroup dir only when this process is the
    /// SOLE member of a delegated cgroup v2 service cgroup with the memory
    /// controller available — i.e. it is safe to run the (mutating) startup dance
    /// here. Everything else (shared cgroup, no delegation, no cgroup v2) returns
    /// `None` and the caller skips WITHOUT touching any cgroup.
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
        let dir = mount.join(unified.trim_start_matches('/'));
        let controllers = std::fs::read_to_string(dir.join("cgroup.controllers")).ok()?;
        if !controllers.split_whitespace().any(|c| c == "memory") {
            return None;
        }
        // Sole-member check: refuse to move a cgroup we share with other processes.
        let procs = std::fs::read_to_string(dir.join("cgroup.procs")).ok()?;
        let members: Vec<&str> = procs.split_whitespace().collect();
        let me = std::process::id().to_string();
        if members != [me.as_str()] {
            return None;
        }
        Some(dir)
    }

    #[tokio::test]
    async fn child_lands_in_op_cgroup_supervisor_stays_isolated() {
        let Some(service_dir) = delegated_and_isolated() else {
            eprintln!(
                "SKIP: not the sole member of a delegated cgroup v2 service cgroup; \
                 re-run the binary alone under `systemd-run --user --scope -p Delegate=yes` \
                 to exercise the live placement path (see the module docs)"
            );
            return;
        };

        // Run the REAL startup dance: this moves us into `<service>/supervisor` and
        // delegates the memory controller to per-op leaves.
        let cgroups = establish_oom_isolation(OpCgroupConfig::default())
            .expect("delegated + isolated cgroup should establish per-op isolation");
        let platform = std::sync::Arc::new(
            NativePlatform::with_root(std::env::temp_dir()).with_oom_isolation(cgroups),
        );

        // The supervisor (this process) must now live in the `supervisor` leaf.
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

        // Run a real shell exec that IMMEDIATELY forks a descendant. Both publish
        // their PIDs and stay alive so the test catches a child that escaped into
        // the supervisor leaf before post-spawn placement.
        let pid_file = std::env::temp_dir().join(format!("oom-itest-{}.pid", std::process::id()));
        let _ = std::fs::remove_file(&pid_file);
        let req = ExecRequest {
            command: vec![format!(
                "while :; do :; done & echo $$ $! > {}; wait",
                pid_file.display()
            )],
            shell: true,
            ..Default::default()
        };
        let task_platform = platform.clone();
        let exec_task = tokio::spawn(async move { task_platform.exec(&req).await });

        let (shell_pid, descendant_pid) = read_fixture_pids(&pid_file).await;

        let shell_unified = poll_child_cgroup(shell_pid).await;
        let descendant_unified = poll_child_cgroup(descendant_pid).await;
        let score = std::fs::read_to_string(format!("/proc/{shell_pid}/oom_score_adj"))
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let descendant_score =
            std::fs::read_to_string(format!("/proc/{descendant_pid}/oom_score_adj"))
                .map(|s| s.trim().to_string())
                .unwrap_or_default();

        exec_task.abort();
        let _ = exec_task.await;
        let _ = std::fs::remove_file(&pid_file);

        eprintln!("LIVE EVIDENCE (issue #345 OOM fate isolation):");
        eprintln!("  supervisor (this process) cgroup: {self_unified}");
        eprintln!("  exec shell {shell_pid} cgroup:      {shell_unified}");
        eprintln!("  descendant {descendant_pid} cgroup: {descendant_unified}");
        eprintln!("  exec shell {shell_pid} oom_score_adj: {score}");
        eprintln!("  descendant {descendant_pid} oom_score_adj: {descendant_score}");

        assert!(
            shell_unified.contains("/op-"),
            "exec shell {shell_pid} must run in an op-<n> leaf, got {shell_unified}"
        );
        assert_eq!(
            descendant_unified, shell_unified,
            "fast descendant {descendant_pid} must share the shell's op leaf"
        );
        assert!(
            shell_unified.starts_with(&self_unified[..self_unified.len() - "/supervisor".len()]),
            "the op leaf must be a sibling of the supervisor leaf under the service cgroup \
             ({shell_unified} vs {self_unified})"
        );
        assert_eq!(
            score, "500",
            "exec shell {shell_pid} must carry oom_score_adj=500"
        );
        assert_eq!(
            descendant_score, "500",
            "fast descendant {descendant_pid} must carry oom_score_adj=500"
        );

        // The op leaf is a real child of the resolved service cgroup.
        assert!(
            service_dir
                .join(shell_unified.rsplit('/').next().expect("op leaf name"))
                .exists(),
            "the op leaf {shell_unified} should exist under {}",
            service_dir.display()
        );
    }

    /// Waits for the shell fixture to publish both PIDs (bounded), then parses them.
    async fn read_fixture_pids(pid_file: &Path) -> (u32, u32) {
        for _ in 0..200 {
            if let Ok(raw) = tokio::fs::read_to_string(pid_file).await {
                let mut parts = raw.split_whitespace();
                if let (Some(shell), Some(descendant), None) =
                    (parts.next(), parts.next(), parts.next())
                {
                    if let (Ok(shell), Ok(descendant)) =
                        (shell.parse::<u32>(), descendant.parse::<u32>())
                    {
                        return (shell, descendant);
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "child fixture never published both PIDs to {}",
            pid_file.display()
        );
    }

    /// Polls the child's unified cgroup path until it is placed in an op leaf (the
    /// move is post-spawn), returning the last observed value.
    async fn poll_child_cgroup(child_pid: u32) -> String {
        let mut last = String::new();
        for _ in 0..200 {
            if let Ok(text) = tokio::fs::read_to_string(format!("/proc/{child_pid}/cgroup")).await {
                if let Some(unified) = unified_cgroup_of(&text) {
                    last = unified;
                    if last.contains("/op-") {
                        break;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        last
    }
}
