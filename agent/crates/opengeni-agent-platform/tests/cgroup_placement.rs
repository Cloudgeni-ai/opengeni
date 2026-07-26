//! Live cgroup-placement integration test for OOM fate isolation (issue #345).
//!
//! Exercises the REAL path — [`establish_oom_isolation`] runs the startup dance
//! and a real `exec` places its child into an `op-<n>` memory leaf — then asserts
//! the child lands in that leaf with `oom_score_adj=500` while the supervisor (this
//! process) stays in the `supervisor` leaf.
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

        // Run a real exec whose direct child reports its PID and stays alive (a pure
        // shell busy-loop — no coreutil dependency) so we can inspect it live.
        let pid_file = std::env::temp_dir().join(format!("oom-itest-{}.pid", std::process::id()));
        let _ = std::fs::remove_file(&pid_file);
        let req = ExecRequest {
            command: vec![format!(
                "echo $$ > {}; while :; do :; done",
                pid_file.display()
            )],
            shell: true,
            ..Default::default()
        };
        let task_platform = platform.clone();
        let exec_task = tokio::spawn(async move { task_platform.exec(&req).await });

        let child_pid = read_child_pid(&pid_file).await;

        // Placement is post-spawn, so poll the child's cgroup + score for the target.
        let child_unified = poll_child_cgroup(child_pid).await;
        let score = std::fs::read_to_string(format!("/proc/{child_pid}/oom_score_adj"))
            .map(|s| s.trim().to_string())
            .unwrap_or_default();

        exec_task.abort();
        let _ = exec_task.await;
        let _ = std::fs::remove_file(&pid_file);

        eprintln!("LIVE EVIDENCE (issue #345 OOM fate isolation):");
        eprintln!("  supervisor (this process) cgroup: {self_unified}");
        eprintln!("  exec child {child_pid} cgroup:      {child_unified}");
        eprintln!("  exec child {child_pid} oom_score_adj: {score}");

        assert!(
            child_unified.contains("/op-"),
            "exec child {child_pid} must run in an op-<n> leaf, got {child_unified}"
        );
        assert!(
            child_unified.starts_with(&self_unified[..self_unified.len() - "/supervisor".len()]),
            "the op leaf must be a sibling of the supervisor leaf under the service cgroup \
             ({child_unified} vs {self_unified})"
        );
        assert_eq!(
            score, "500",
            "exec child {child_pid} must carry oom_score_adj=500"
        );

        // The op leaf is a real child of the resolved service cgroup.
        assert!(
            service_dir
                .join(child_unified.rsplit('/').next().expect("op leaf name"))
                .exists(),
            "the op leaf {child_unified} should exist under {}",
            service_dir.display()
        );
    }

    /// Waits for the child fixture to publish its PID (bounded), then parses it.
    async fn read_child_pid(pid_file: &Path) -> u32 {
        for _ in 0..200 {
            if let Ok(raw) = tokio::fs::read_to_string(pid_file).await {
                if let Ok(pid) = raw.trim().parse::<u32>() {
                    return pid;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "child fixture never published its PID to {}",
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
