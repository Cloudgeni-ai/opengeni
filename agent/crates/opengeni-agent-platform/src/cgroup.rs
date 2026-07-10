//! Per-op memory cgroup isolation for host execs (issue #345).
//!
//! # The failure this closes
//!
//! The agent's control supervisor (heartbeat + `ping`) and every native `exec`
//! descendant share ONE systemd service cgroup. On a swapless host under memory
//! pressure, `systemd-oomd` — or the kernel OOM killer — can select that cgroup
//! and SIGKILL the whole unit, taking the supervisor down with a runaway command.
//! Bounded concurrency (the supervisor's work pool) is not resource-aware and does
//! not give process/cgroup FATE isolation.
//!
//! # What this module does (Linux, cgroup v2 only)
//!
//! Given a delegated cgroup v2 service cgroup (the hardened unit renders
//! `Delegate=yes` + `MemoryHigh=` — see [`crate::service`]), it:
//!
//! 1. **Startup dance** ([`establish_oom_isolation`]). cgroup v2 forbids a cgroup
//!    from holding member processes AND enabling controllers for its children (the
//!    "no internal processes" rule), so we move the agent process into a
//!    `<service>/supervisor` leaf, then enable the memory controller in
//!    `<service>/cgroup.subtree_control`. Per-op cgroups are then
//!    `<service>/op-<n>` siblings of `supervisor`, each with its own memory
//!    accounting.
//! 2. **Per-exec placement** ([`OpCgroups::place_op`]). After a child is spawned,
//!    its PID and the #344 process-group anchor's PID are written into a fresh
//!    `op-<n>` leaf (optionally capped by [`OpCgroupConfig`]). A memory blow-up in
//!    that leaf is contained to the leaf; the supervisor in its own leaf survives.
//! 3. **Teardown** ([`OpCgroupHandle`]). The op leaf is `rmdir`'d after the op's
//!    process tree is reaped, tolerating a transient `EBUSY` with a bounded retry.
//!
//! # Fallback ladder — never fail to serve
//!
//! Every step degrades gracefully: not Linux, no cgroup v2, the memory controller
//! is not delegated, or any step returns `EPERM`/IO error → the reason is logged
//! ONCE and the agent keeps serving with today's behavior (all work in the service
//! cgroup, no per-op isolation). Isolation being unavailable must never stop the
//! agent from answering control RPCs.
//!
//! # Cross-platform posture
//!
//! This is a Linux-first feature. On macOS/Windows [`establish_oom_isolation`]
//! returns `None` (a documented no-op) and no cgroup is ever touched — the same
//! honest-degradation posture the metrics reader uses for its `/proc` sources.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

/// The cgroup v2 unified mount on a standard systemd host.
#[cfg(target_os = "linux")]
const CGROUP2_MOUNT: &str = "/sys/fs/cgroup";

/// The leaf the agent process is moved into so the service cgroup itself holds no
/// member processes (the cgroup v2 no-internal-processes rule) and can delegate
/// the memory controller to per-op sibling leaves.
#[cfg(target_os = "linux")]
const SUPERVISOR_LEAF: &str = "supervisor";

/// How many times [`OpCgroupHandle::teardown`] retries an `rmdir` that returns
/// `EBUSY` (the op's processes are reaped a moment after the group is killed).
#[cfg(target_os = "linux")]
const TEARDOWN_ATTEMPTS: u32 = 5;

/// The delay between the bounded teardown `rmdir` retries.
#[cfg(target_os = "linux")]
const TEARDOWN_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(20);

/// Environment variable naming an optional per-op `memory.max` hard cap, in bytes.
const OP_MEMORY_MAX_ENV: &str = "OPENGENI_AGENT_OP_MEMORY_MAX";

/// Environment variable naming an optional per-op `memory.high` throttle, in bytes.
const OP_MEMORY_HIGH_ENV: &str = "OPENGENI_AGENT_OP_MEMORY_HIGH";

/// Optional per-op memory limits applied to each `op-<n>` leaf. Both default to
/// unset: the leaf still ACCOUNTS memory separately (which is what fate-isolates
/// the supervisor), and only caps the op when an operator opts in.
#[derive(Debug, Clone, Copy, Default)]
pub struct OpCgroupConfig {
    /// The per-op `memory.max` hard limit in bytes (a hit is an in-op OOM). Unset =
    /// no hard cap.
    pub memory_max: Option<u64>,
    /// The per-op `memory.high` throttle in bytes (reclaim pressure, not a kill).
    /// Unset = no throttle.
    pub memory_high: Option<u64>,
}

impl OpCgroupConfig {
    /// Reads the optional per-op limits from the environment
    /// ([`OP_MEMORY_MAX_ENV`], [`OP_MEMORY_HIGH_ENV`]); an unset/zero/invalid value
    /// leaves that limit unset.
    #[must_use]
    pub fn from_env() -> Self {
        Self {
            memory_max: parse_bytes_env(OP_MEMORY_MAX_ENV),
            memory_high: parse_bytes_env(OP_MEMORY_HIGH_ENV),
        }
    }
}

/// Parses a positive byte count from environment variable `key`; `None` when
/// unset, empty, non-numeric, or zero.
fn parse_bytes_env(key: &str) -> Option<u64> {
    std::env::var(key)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|&n| n > 0)
}

/// An established per-op cgroup manager: the resolved service cgroup, the per-op
/// limits, and a monotonic op-id counter. Constructed ONLY by a successful
/// [`establish_oom_isolation`] (so its presence means the startup dance ran and
/// the memory controller is delegated to per-op leaves).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Debug)]
pub struct OpCgroups {
    /// The absolute path of the delegated service cgroup (`op-<n>` leaves and the
    /// `supervisor` leaf are its children).
    service_dir: PathBuf,
    /// The per-op memory limits to stamp on each leaf.
    config: OpCgroupConfig,
    /// The next op-id; each `place_op` allocates a unique `op-<n>` sibling.
    next_op: AtomicU64,
    /// Guards the "log once" of the per-op placement fallback so a persistent
    /// degradation is reported exactly once, not per exec.
    fallback_logged: AtomicBool,
}

impl OpCgroups {
    /// Places one exec's processes into a fresh `op-<n>` memory leaf and returns a
    /// teardown handle. `pids` is the requested child plus the #344 group anchor —
    /// both are moved so the whole op shares one memory fate.
    ///
    /// Best-effort by contract: a failure to create the leaf, stamp a cap, or move
    /// a PID (e.g. the process already exited) is logged once and the op keeps
    /// running in the service cgroup. Returns a handle whenever the leaf exists (so
    /// it is torn down), or `None` when the leaf could not be created.
    #[cfg(target_os = "linux")]
    pub(crate) fn place_op(&self, pids: &[u32]) -> Option<OpCgroupHandle> {
        let op_id = self.next_op.fetch_add(1, Ordering::Relaxed);
        let dir = self.service_dir.join(op_cgroup_name(op_id));
        if let Err(error) = create_dir_idempotent(&dir) {
            self.note_fallback(format_args!(
                "cannot create op cgroup {}: {error}",
                dir.display()
            ));
            return None;
        }

        // Optional per-op caps (default: unset). A failing cap is non-fatal: the
        // leaf still accounts memory separately, which is what isolates the
        // supervisor; the cap only bounds a single op when an operator opts in.
        if let Some(max) = self.config.memory_max {
            if let Err(error) = std::fs::write(dir.join("memory.max"), max.to_string()) {
                self.note_fallback(format_args!(
                    "cannot set memory.max on {}: {error}",
                    dir.display()
                ));
            }
        }
        if let Some(high) = self.config.memory_high {
            if let Err(error) = std::fs::write(dir.join("memory.high"), high.to_string()) {
                self.note_fallback(format_args!(
                    "cannot set memory.high on {}: {error}",
                    dir.display()
                ));
            }
        }

        // Move the exec's processes into the leaf. cgroup.procs takes one PID per
        // write; the tiny window between spawn and this move is the accepted
        // post-spawn billing window (no async-signal-unsafe pre_exec tricks).
        let procs = dir.join("cgroup.procs");
        for pid in pids {
            if let Err(error) = std::fs::write(&procs, pid.to_string()) {
                self.note_fallback(format_args!(
                    "cannot place pid {pid} into {}: {error}",
                    dir.display()
                ));
            }
        }

        Some(OpCgroupHandle { dir })
    }

    /// Non-Linux no-op: no manager is ever constructed off Linux, so this is never
    /// reached; it exists so the cross-platform exec path type-checks.
    #[cfg(not(target_os = "linux"))]
    pub(crate) fn place_op(&self, _pids: &[u32]) -> Option<OpCgroupHandle> {
        None
    }

    /// Logs the per-op placement fallback reason exactly once (a persistent
    /// degradation must not spam a line per exec).
    #[cfg(target_os = "linux")]
    fn note_fallback(&self, reason: std::fmt::Arguments<'_>) {
        if !self.fallback_logged.swap(true, Ordering::Relaxed) {
            tracing::info!(
                %reason,
                "per-op OOM cgroup placement degraded; continuing to serve in the service cgroup (logged once)"
            );
        }
    }
}

/// A handle to one placed `op-<n>` leaf, responsible for removing it once the op's
/// process tree is reaped.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) struct OpCgroupHandle {
    /// The op leaf's absolute path.
    dir: PathBuf,
}

#[cfg(target_os = "linux")]
impl OpCgroupHandle {
    /// Removes the op leaf after the op's processes are reaped, tolerating a
    /// transient `EBUSY` (the kernel drops reaped PIDs from `cgroup.procs` a moment
    /// after the group is killed) with a bounded retry. A leaf that stays busy past
    /// the retries is left in place and logged — a leaked EMPTY cgroup is cosmetic
    /// and the whole subtree is reclaimed when systemd stops the unit. Awaited on
    /// the normal completion path, where the caller has already reaped the tree.
    pub(crate) async fn teardown(self) {
        for attempt in 1..=TEARDOWN_ATTEMPTS {
            match std::fs::remove_dir(&self.dir) {
                Ok(()) => return,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
                Err(_) if attempt < TEARDOWN_ATTEMPTS => {
                    tokio::time::sleep(TEARDOWN_RETRY_DELAY).await;
                }
                Err(error) => {
                    tracing::debug!(
                        dir = %self.dir.display(),
                        %error,
                        "left an empty op cgroup after bounded teardown retries (cosmetic)"
                    );
                }
            }
        }
    }

    /// A single, non-blocking teardown attempt for the drop path (a cancelled or
    /// timed-out exec). The group was just SIGKILL'd, so the processes usually
    /// outlive this one `rmdir`; the reaped-later leaf is a cosmetic leak the next
    /// unit stop reclaims. Kept sync so it is safe to call from `Drop`.
    pub(crate) fn teardown_best_effort(&self) {
        if let Err(error) = std::fs::remove_dir(&self.dir) {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::debug!(
                    dir = %self.dir.display(),
                    %error,
                    "op cgroup not removed on the cancel/timeout path (reaped later; cosmetic)"
                );
            }
        }
    }
}

/// Non-Linux stubs so the cross-platform exec path type-checks; never reached off
/// Linux (no handle is ever constructed).
#[cfg(not(target_os = "linux"))]
impl OpCgroupHandle {
    #[allow(dead_code)]
    pub(crate) async fn teardown(self) {}

    #[allow(dead_code)]
    pub(crate) fn teardown_best_effort(&self) {}
}

/// Runs the startup dance and returns an active [`OpCgroups`], or `None` (with a
/// once-logged reason) when isolation is unavailable — the agent then serves with
/// today's behavior. Call this ONCE at startup, before any host exec runs and
/// before spawning agent-infra children (e.g. Xvfb), so those children inherit the
/// `supervisor` leaf and only host work lands in per-op leaves.
#[cfg(target_os = "linux")]
#[must_use]
pub fn establish_oom_isolation(config: OpCgroupConfig) -> Option<Arc<OpCgroups>> {
    // 1. cgroup v2 unified hierarchy at the standard mount?
    let mount = Path::new(CGROUP2_MOUNT);
    if !mount.join("cgroup.controllers").exists() {
        tracing::info!(
            mount = CGROUP2_MOUNT,
            "OOM cgroup isolation unavailable: no cgroup v2 unified hierarchy; serving without per-op isolation"
        );
        return None;
    }

    // 2. Our own service cgroup, from the `0::` line of /proc/self/cgroup.
    let proc_cgroup = match std::fs::read_to_string("/proc/self/cgroup") {
        Ok(text) => text,
        Err(error) => {
            tracing::info!(%error, "OOM cgroup isolation unavailable: cannot read /proc/self/cgroup; serving without per-op isolation");
            return None;
        }
    };
    let Some(unified) = parse_unified_cgroup_path(&proc_cgroup) else {
        tracing::info!("OOM cgroup isolation unavailable: not in a cgroup v2 unified hierarchy; serving without per-op isolation");
        return None;
    };
    if unified == "/" {
        tracing::info!("OOM cgroup isolation unavailable: running in the root cgroup (not a delegated service); serving without per-op isolation");
        return None;
    }
    let service_dir = service_cgroup_dir(mount, &unified);

    // 3. Is the memory controller delegated to our service cgroup? (Delegate=yes +
    //    MemoryAccounting on the unit make systemd enable it in our parent's
    //    subtree_control, so it shows up in our cgroup.controllers.)
    let controllers = match std::fs::read_to_string(service_dir.join("cgroup.controllers")) {
        Ok(text) => text,
        Err(error) => {
            tracing::info!(%error, dir = %service_dir.display(), "OOM cgroup isolation unavailable: cannot read the service cgroup controllers; serving without per-op isolation");
            return None;
        }
    };
    if !controllers_contains(&controllers, "memory") {
        tracing::info!(
            dir = %service_dir.display(),
            "OOM cgroup isolation unavailable: the memory controller is not delegated to this unit (needs Delegate=yes + memory accounting); serving without per-op isolation"
        );
        return None;
    }

    // 4. No-internal-processes dance: move ourselves into the supervisor leaf, then
    //    delegate the memory controller to our children. Order matters — the
    //    service cgroup must hold no member processes before subtree_control can
    //    enable a controller.
    let supervisor_dir = service_dir.join(SUPERVISOR_LEAF);
    if let Err(error) = create_dir_idempotent(&supervisor_dir) {
        tracing::info!(%error, dir = %supervisor_dir.display(), "OOM cgroup isolation unavailable: cannot create the supervisor leaf; serving without per-op isolation");
        return None;
    }
    if let Err(error) = std::fs::write(
        supervisor_dir.join("cgroup.procs"),
        std::process::id().to_string(),
    ) {
        tracing::info!(%error, "OOM cgroup isolation unavailable: cannot move the supervisor into its leaf; serving without per-op isolation");
        return None;
    }
    if let Err(error) = std::fs::write(service_dir.join("cgroup.subtree_control"), "+memory") {
        tracing::info!(
            %error,
            "OOM cgroup isolation unavailable: cannot delegate the memory controller to per-op leaves; serving without per-op isolation (the supervisor already runs in its own leaf)"
        );
        return None;
    }

    tracing::info!(
        service_cgroup = %service_dir.display(),
        memory_max = ?config.memory_max,
        memory_high = ?config.memory_high,
        "established per-op OOM cgroup isolation: host execs run in memory sub-cgroups; the control supervisor is fate-isolated in its own leaf"
    );
    Some(Arc::new(OpCgroups {
        service_dir,
        config,
        next_op: AtomicU64::new(0),
        fallback_logged: AtomicBool::new(false),
    }))
}

/// Non-Linux no-op: per-op cgroup isolation is a Linux cgroup v2 feature. Returns
/// `None` so the agent runs unchanged on macOS/Windows.
#[cfg(not(target_os = "linux"))]
#[must_use]
pub fn establish_oom_isolation(_config: OpCgroupConfig) -> Option<Arc<OpCgroups>> {
    tracing::debug!("per-op OOM cgroup isolation is Linux-only; running without it on this OS");
    None
}

/// Creates `dir`, treating an already-existing directory as success (a leaked leaf
/// from a prior run is reusable).
#[cfg(target_os = "linux")]
fn create_dir_idempotent(dir: &Path) -> std::io::Result<()> {
    match std::fs::create_dir(dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

// --- oom_score_adj: bias the kernel OOM killer toward host work ----------------

/// The `oom_score_adj` stamped on every exec child. A positive bias makes the
/// kernel's GLOBAL OOM killer sacrifice a runaway child (and its descendants,
/// which inherit the value on fork) before the supervisor, which stays at its
/// default. Raising the value is unprivileged-legal; the mid-range 500 is a strong
/// bias without pinning the child as the unconditional first victim.
#[cfg(target_os = "linux")]
const EXEC_OOM_SCORE_ADJ: i32 = 500;

/// Guards the "log once" of an `oom_score_adj` write failure so a restrictive host
/// policy is reported once, not per exec.
#[cfg(target_os = "linux")]
static OOM_SCORE_ADJ_WARNED: AtomicBool = AtomicBool::new(false);

/// Raises `/proc/<pid>/oom_score_adj` on a freshly-spawned exec child so the kernel
/// OOM killer prefers it over the control supervisor (issue #345). Composes with
/// the per-op cgroup: this biases the GLOBAL kernel OOM killer, the cgroup gives
/// systemd-oomd a bounded scope — both apply. Best-effort: a failure (the child
/// already exited, or a locked-down policy) is logged once and ignored.
#[cfg(target_os = "linux")]
pub(crate) fn raise_exec_oom_score_adj(pid: u32) {
    let path = format!("/proc/{pid}/oom_score_adj");
    if let Err(error) = std::fs::write(&path, EXEC_OOM_SCORE_ADJ.to_string()) {
        if !OOM_SCORE_ADJ_WARNED.swap(true, Ordering::Relaxed) {
            tracing::info!(
                %error,
                pid,
                target = EXEC_OOM_SCORE_ADJ,
                "could not raise exec child oom_score_adj; continuing (logged once)"
            );
        }
    }
}

// --- Pure, cross-platform helpers (unit-tested on any host) -------------------

/// Extracts the cgroup v2 unified path from `/proc/self/cgroup` — the path after
/// the `0::` prefix of the unified line. `None` when there is no unified line (a
/// pure cgroup v1 host) or its path is empty.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_unified_cgroup_path(contents: &str) -> Option<String> {
    contents
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(ToString::to_string)
}

/// Joins the cgroup v2 mount and a unified path (which is absolute-from-mount, e.g.
/// `/user.slice/.../opengeni-agent.service`) into the service cgroup's real dir.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn service_cgroup_dir(mount: &Path, unified_path: &str) -> PathBuf {
    mount.join(unified_path.trim_start_matches('/'))
}

/// Whether a `cgroup.controllers`/`cgroup.subtree_control` body (space-separated
/// controller names) lists `controller`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn controllers_contains(contents: &str, controller: &str) -> bool {
    contents.split_whitespace().any(|name| name == controller)
}

/// The name of the `op-<n>` leaf for op id `op_id`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn op_cgroup_name(op_id: u64) -> String {
    format!("op-{op_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_unified_line_from_a_hybrid_proc_cgroup() {
        // A hybrid host lists v1 controllers then the `0::` unified line last.
        let contents = "\
12:pids:/user.slice
1:name=systemd:/user.slice/session-3.scope
0::/user.slice/user-1000.slice/user@1000.service/app.slice/opengeni-agent.service
";
        assert_eq!(
            parse_unified_cgroup_path(contents).as_deref(),
            Some("/user.slice/user-1000.slice/user@1000.service/app.slice/opengeni-agent.service")
        );
    }

    #[test]
    fn parses_a_pure_v2_proc_cgroup() {
        assert_eq!(
            parse_unified_cgroup_path("0::/system.slice/opengeni-agent.service\n").as_deref(),
            Some("/system.slice/opengeni-agent.service")
        );
    }

    #[test]
    fn no_unified_line_is_none() {
        // A pure cgroup v1 host has no `0::` line.
        assert!(parse_unified_cgroup_path("3:memory:/foo\n1:name=systemd:/bar\n").is_none());
        // An empty unified path (the root, but reported blank) is not a service.
        assert!(parse_unified_cgroup_path("0::\n").is_none());
    }

    #[test]
    fn service_dir_joins_mount_and_absolute_unified_path() {
        let dir = service_cgroup_dir(
            Path::new("/sys/fs/cgroup"),
            "/system.slice/opengeni-agent.service",
        );
        assert_eq!(
            dir,
            PathBuf::from("/sys/fs/cgroup/system.slice/opengeni-agent.service")
        );
    }

    #[test]
    fn controllers_contains_matches_whole_names_only() {
        assert!(controllers_contains("cpuset cpu io memory pids", "memory"));
        assert!(!controllers_contains("cpuset cpu io pids", "memory"));
        // A prefix/substring must not match a different controller name.
        assert!(!controllers_contains("memoryfoo", "memory"));
        assert!(controllers_contains("memory", "memory"));
    }

    #[test]
    fn op_cgroup_names_are_unique_per_id() {
        assert_eq!(op_cgroup_name(0), "op-0");
        assert_eq!(op_cgroup_name(42), "op-42");
        assert_ne!(op_cgroup_name(1), op_cgroup_name(2));
    }

    #[test]
    fn config_from_env_reads_positive_byte_limits_only() {
        // Serialize the env mutation so parallel tests don't clobber the vars.
        static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        std::env::remove_var(OP_MEMORY_MAX_ENV);
        std::env::remove_var(OP_MEMORY_HIGH_ENV);
        assert_eq!(OpCgroupConfig::from_env().memory_max, None);
        assert_eq!(OpCgroupConfig::from_env().memory_high, None);

        std::env::set_var(OP_MEMORY_MAX_ENV, "1073741824");
        std::env::set_var(OP_MEMORY_HIGH_ENV, "0"); // zero is "unset"
        let cfg = OpCgroupConfig::from_env();
        assert_eq!(cfg.memory_max, Some(1_073_741_824));
        assert_eq!(cfg.memory_high, None, "zero disables the limit");

        std::env::set_var(OP_MEMORY_MAX_ENV, "not-a-number");
        assert_eq!(OpCgroupConfig::from_env().memory_max, None);

        std::env::remove_var(OP_MEMORY_MAX_ENV);
        std::env::remove_var(OP_MEMORY_HIGH_ENV);
    }
}
