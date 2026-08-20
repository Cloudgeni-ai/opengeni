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
//! Given a delegated cgroup v2 service cgroup (the generated unit delegates only
//! `cpu` and `memory` — see
//! [`crate::service`]), it:
//!
//! 1. **Startup topology** ([`establish_oom_isolation`]). cgroup v2 forbids a
//!    cgroup from holding member processes AND enabling controllers for its
//!    children (the "no internal processes" rule). The generated systemd unit
//!    therefore uses `DelegateSubgroup=supervisor`, which places the first and
//!    every replacement agent process directly in `<service>/supervisor`. The
//!    agent verifies that manager-owned topology, then enables only `memory` in
//!    `<service>/cgroup.subtree_control`. Per-op cgroups are then
//!    `<service>/op-<n>` siblings of `supervisor`, each with its own resource
//!    accounting and systemd-oomd selection. CPU remains disabled unless an
//!    explicit CPU quota leases it; I/O and PID remain untouched. This preserves
//!    ambient CPU/I/O scheduling for the unlimited default.
//! 2. **Per-exec placement** ([`OpCgroups::prepare_op`]). Before either direct
//!    child is spawned, the runner creates and configures a fresh `op-<n>` leaf and
//!    pre-opens its `cgroup.procs`. An async-signal-safe pre-exec hook migrates each
//!    forked child before `execve(2)`, so user code and every descendant are born in
//!    the operation leaf even if they immediately call `setsid` or double-fork.
//!    The post-spawn barrier only verifies both direct roots. Once the manager is
//!    established, failure to create, configure, pre-open, migrate, or verify an
//!    operation leaf aborts that operation; user code never runs ambient after a
//!    partial admission. Optional per-op limits contain work in that leaf.
//!    Without a limit, the child score bias below makes global kernel OOM prefer
//!    host work when a higher score is representable; a supervisor already at the
//!    ABI ceiling remains equal to its children.
//! 3. **Teardown** ([`OpCgroupHandle`]). The op leaf is `rmdir`'d after the op's
//!    complete cgroup-owned process tree is killed and reaped. This includes a
//!    descendant that changed its process group after admission, but excludes an
//!    explicitly service-manager-owned process moved into another cgroup. If
//!    teardown races the kernel's final descendant release, it waits for the
//!    `cgroup.events` `populated 0` transition instead of guessing at a retry
//!    count. Dropping a task schedules the same cleanup.
//!
//! # Fallback and enforcement posture
//!
//! Startup capability discovery degrades gracefully: not Linux, no cgroup v2, no
//! manager-owned subgroup, or no delegated memory controller means the runner keeps
//! serving with ambient host behavior. Once a manager is established, each exec is
//! admitted atomically into a complete operation leaf or that exec fails before
//! user code runs. An explicit resource policy also fails closed when the exact
//! controller is unavailable. Failures never stop control RPCs.
//!
//! # Cross-platform posture
//!
//! This is a Linux-first feature. On macOS/Windows [`establish_oom_isolation`]
//! returns `None` (a documented no-op) and no cgroup is ever touched — the same
//! honest-degradation posture the metrics reader uses for its `/proc` sources.

use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::sync::atomic::Ordering;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
#[cfg(target_os = "linux")]
use tokio::io::unix::AsyncFd;
#[cfg(target_os = "linux")]
use tokio::io::Interest;

/// The cgroup v2 unified mount on a standard systemd host.
#[cfg(target_os = "linux")]
const CGROUP2_MOUNT: &str = "/sys/fs/cgroup";

/// The manager-owned leaf in which every supervisor generation starts, so the
/// service root stays empty across crashes and can keep controllers delegated to
/// per-op sibling leaves.
#[cfg(target_os = "linux")]
const SUPERVISOR_LEAF: &str = "supervisor";

/// systemd-oomd reads this cgroup xattr directly. Attributes set by
/// `ManagedOOMPreference=avoid` on the service cgroup are not inherited by the
/// delegated child cgroup, so the agent must stamp the leaf before moving into it.
#[cfg(target_os = "linux")]
const SYSTEMD_OOMD_AVOID_XATTR: &str = "user.oomd_avoid";

/// Controller required continuously for fate/lifecycle containment. CPU is
/// deliberately absent: enabling it changes hierarchical scheduling between
/// sibling operation leaves, so it is leased only while an explicit CPU quota is
/// active. I/O and PID controllers are not enabled until a concrete opt-in policy
/// needs them.
#[cfg(target_os = "linux")]
const OP_ALWAYS_ON_CONTROLLERS: [&str; 1] = ["memory"];

/// Environment variable naming an optional per-op `memory.max` hard cap, in bytes.
const OP_MEMORY_MAX_ENV: &str = "OPENGENI_AGENT_OP_MEMORY_MAX";

/// Environment variable naming an optional per-op `memory.high` throttle, in bytes.
const OP_MEMORY_HIGH_ENV: &str = "OPENGENI_AGENT_OP_MEMORY_HIGH";

/// Environment variable naming an optional per-op hard CPU quota in exact
/// thousandths of one CPU (1000 = one CPU).
const OP_CPU_MAX_MILLICORES_ENV: &str = "OPENGENI_AGENT_OP_CPU_MAX_MILLICORES";

/// `cpu.max` quota and period are microseconds. The cgroup-v2 ABI accepts values
/// from 1 ms through 1 s; these are kernel contract bounds, not runner tuning.
#[cfg(any(target_os = "linux", test))]
const CGROUP_CPU_MIN_MICROS: u64 = 1_000;
#[cfg(any(target_os = "linux", test))]
const CGROUP_CPU_MAX_PERIOD_MICROS: u64 = 1_000_000;
#[cfg(any(target_os = "linux", test))]
const MILLICORES_PER_CPU: u64 = 1_000;

/// Optional per-op resource limits applied to each `op-<n>` leaf. All default to
/// unset: the leaf still accounts memory separately (which fate-isolates the
/// supervisor), and only constrains the op when an operator opts in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OpCgroupConfig {
    /// The per-op `memory.max` hard limit in bytes (a hit is an in-op OOM). Unset =
    /// no hard cap.
    pub memory_max: Option<u64>,
    /// The per-op `memory.high` throttle in bytes (reclaim pressure, not a kill).
    /// Unset = no throttle.
    pub memory_high: Option<u64>,
    /// Exact thousandths of one CPU available to the operation. Unset = no hard
    /// CPU quota. With no CPU-limited operations, the runner removes `+cpu` so
    /// unlimited leaves retain the host's ambient scheduling topology.
    pub cpu_max_millicores: Option<u32>,
}

impl OpCgroupConfig {
    /// Reads the optional per-op limits from the environment
    /// ([`OP_MEMORY_MAX_ENV`], [`OP_MEMORY_HIGH_ENV`]); unset or zero leaves that
    /// limit unrestricted. A malformed explicit policy is an error rather than a
    /// silent fallback to unlimited execution.
    ///
    /// # Errors
    ///
    /// Returns [`OpCgroupConfigError`] when a present value is not an unsigned byte
    /// count or when `memory.high` exceeds an explicit `memory.max`.
    pub fn from_env() -> Result<Self, OpCgroupConfigError> {
        Self::from_limits(
            parse_bytes_env(OP_MEMORY_MAX_ENV)?,
            parse_bytes_env(OP_MEMORY_HIGH_ENV)?,
            parse_millicores_env(OP_CPU_MAX_MILLICORES_ENV)?,
        )
    }

    /// Validates one explicit policy snapshot. This is shared by local
    /// environment policy and the per-connection wire policy so neither path can
    /// present an impossible throttle-above-ceiling request as enforced.
    ///
    /// # Errors
    ///
    /// Returns [`OpCgroupConfigError`] when either limit is zero or when
    /// `memory.high` exceeds `memory.max`.
    pub fn from_limits(
        memory_max: Option<u64>,
        memory_high: Option<u64>,
        cpu_max_millicores: Option<u32>,
    ) -> Result<Self, OpCgroupConfigError> {
        if memory_max == Some(0) {
            return Err(OpCgroupConfigError::ZeroByteCount {
                setting: "memory.max",
            });
        }
        if memory_high == Some(0) {
            return Err(OpCgroupConfigError::ZeroByteCount {
                setting: "memory.high",
            });
        }
        if cpu_max_millicores == Some(0) {
            return Err(OpCgroupConfigError::ZeroCpuCount);
        }
        let config = Self {
            memory_max,
            memory_high,
            cpu_max_millicores,
        };
        if let (Some(max), Some(high)) = (config.memory_max, config.memory_high) {
            if high > max {
                return Err(OpCgroupConfigError::MemoryHighExceedsMax { high, max });
            }
        }
        Ok(config)
    }

    /// Returns the tighter composite of runner-local policy and a connection's
    /// requested policy. A finite value always wins over unlimited; neither
    /// authority can loosen the other.
    #[must_use]
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    fn tightened_by(self, requested: Self) -> Self {
        let memory_max = tighter_limit(self.memory_max, requested.memory_max);
        let memory_high = tighter_limit(self.memory_high, requested.memory_high)
            .map(|high| memory_max.map_or(high, |max| high.min(max)));
        let cpu_max_millicores = tighter_limit(
            self.cpu_max_millicores.map(u64::from),
            requested.cpu_max_millicores.map(u64::from),
        )
        .map(|value| u32::try_from(value).expect("a tightened u32 CPU policy remains a u32"));
        Self {
            memory_max,
            // Do not invent a soft throttle from a hard ceiling. If a soft limit
            // was requested, cap it at the effective hard ceiling so the leaf
            // cannot claim an impossible throttle-above-ceiling policy.
            memory_high,
            cpu_max_millicores,
        }
    }

    /// Whether an operator explicitly requested enforcement. When true, missing
    /// cgroup support or a failed per-op setting must fail closed instead of
    /// silently granting unlimited resources.
    #[must_use]
    pub fn has_limits(self) -> bool {
        self.memory_max.is_some() || self.memory_high.is_some() || self.cpu_max_millicores.is_some()
    }
}

/// An invalid explicit local operation-cgroup policy.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum OpCgroupConfigError {
    /// A present environment value is not an unsigned integer byte count.
    #[error("{name} must be an unsigned byte count or zero for unlimited")]
    InvalidByteCount {
        /// The environment variable containing the malformed value.
        name: &'static str,
    },
    /// A present environment CPU quota is not an unsigned 32-bit millicore count.
    #[error("{name} must be an unsigned 32-bit millicore count or zero for unlimited")]
    InvalidCpuCount {
        /// The environment variable containing the malformed value.
        name: &'static str,
    },
    /// Wire/API policy uses field absence for unlimited; a present zero is
    /// rejected so a serialization mistake cannot unexpectedly freeze/kill work.
    #[error("operation {setting} must be a positive byte count when present")]
    ZeroByteCount {
        /// The cgroup controller setting carrying zero.
        setting: &'static str,
    },
    /// A throttle above the hard ceiling cannot become the requested effective
    /// policy, so reject it rather than accepting a misleading configuration.
    #[error("operation memory.high ({high} bytes) cannot exceed memory.max ({max} bytes)")]
    MemoryHighExceedsMax {
        /// Requested `memory.high`, in bytes.
        high: u64,
        /// Requested `memory.max`, in bytes.
        max: u64,
    },
    /// A present wire CPU quota must be positive; absence represents unlimited.
    #[error("operation CPU quota must be positive millicores when present")]
    ZeroCpuCount,
}

/// Parses a byte count from environment variable `key`; `None` when unset or
/// explicitly zero (unlimited).
fn parse_bytes_env(key: &'static str) -> Result<Option<u64>, OpCgroupConfigError> {
    let Ok(value) = std::env::var(key) else {
        return Ok(None);
    };
    let parsed = value
        .trim()
        .parse::<u64>()
        .map_err(|_| OpCgroupConfigError::InvalidByteCount { name: key })?;
    Ok((parsed > 0).then_some(parsed))
}

fn parse_millicores_env(key: &'static str) -> Result<Option<u32>, OpCgroupConfigError> {
    let Ok(value) = std::env::var(key) else {
        return Ok(None);
    };
    let parsed = value
        .trim()
        .parse::<u32>()
        .map_err(|_| OpCgroupConfigError::InvalidCpuCount { name: key })?;
    Ok((parsed > 0).then_some(parsed))
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn policy_enforcement_error(action: &str, source: &std::io::Error) -> std::io::Error {
    // A missing controller file/cgroup is a host containment capability failure,
    // not a missing command or request path. Normalize the I/O kind so the typed
    // platform layer does not publish a misleading `NotFound` wire error.
    std::io::Error::other(format!(
        "explicit operation resource policy could not {action}: {source}"
    ))
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
    local_config: OpCgroupConfig,
    /// Lazily activates the delegated CPU controller only while at least one
    /// CPU-limited operation leaf exists.
    #[cfg(target_os = "linux")]
    cpu_controller: Option<Arc<CpuControllerState>>,
    /// The next op-id; each `place_op` allocates a unique `op-<n>` sibling.
    next_op: AtomicU64,
    /// Guards the "log once" of an operation admission failure so a persistent
    /// host fault is reported exactly once, not per exec.
    admission_failure_logged: AtomicBool,
    /// Last explicit-policy snapshot reported. The next operation re-reads kernel
    /// leaf and ancestor state and logs only when desired/effective/external truth
    /// changed.
    policy_report: Mutex<Option<ResourcePolicyReport>>,
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
struct CpuControllerState {
    service_dir: PathBuf,
    active_leases: Mutex<usize>,
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
struct CpuControllerLease {
    state: Arc<CpuControllerState>,
}

#[cfg(target_os = "linux")]
impl CpuControllerState {
    fn acquire(self: &Arc<Self>) -> std::io::Result<CpuControllerLease> {
        let mut active = self
            .active_leases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *active == 0 {
            enable_subtree_controller(&self.service_dir, "cpu")?;
        }
        *active = active.checked_add(1).ok_or_else(|| {
            std::io::Error::other("operation CPU-controller lease count is exhausted")
        })?;
        Ok(CpuControllerLease {
            state: Arc::clone(self),
        })
    }
}

#[cfg(target_os = "linux")]
impl Drop for CpuControllerLease {
    fn drop(&mut self) {
        let mut active = self
            .state
            .active_leases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        debug_assert!(*active > 0, "a live CPU lease must be counted");
        *active = active.saturating_sub(1);
        if *active == 0 {
            if let Err(error) = disable_subtree_controller(&self.state.service_dir, "cpu") {
                tracing::warn!(
                    %error,
                    "could not return the operation subtree to ambient CPU scheduling after the last explicit quota ended"
                );
            }
        }
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ResourcePolicyReport {
    desired_memory_max: Option<u64>,
    desired_memory_high: Option<u64>,
    local_memory_max: Option<u64>,
    local_memory_high: Option<u64>,
    leaf_memory_max: Option<u64>,
    leaf_memory_high: Option<u64>,
    ancestor_aggregate_memory_max: Option<u64>,
    ancestor_aggregate_memory_high: Option<u64>,
    combined_memory_upper_bound_max: Option<u64>,
    combined_memory_upper_bound_high: Option<u64>,
    desired_cpu_millicores: Option<u32>,
    local_cpu_millicores: Option<u32>,
    leaf_cpu: Option<CpuMax>,
    external_cpu: Option<CpuMax>,
    effective_cpu: Option<CpuMax>,
}

/// One parsed cgroup-v2 `cpu.max` ratio. `quota = None` means `max` (unlimited);
/// period is always the kernel's positive microsecond scheduling window.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CpuMax {
    quota: Option<u64>,
    period: u64,
}

impl OpCgroups {
    /// Whether this exact manager can enforce the CPU portion of the wire policy.
    /// The controller remains disabled until a limited operation acquires it.
    #[must_use]
    pub fn cpu_quota_supported(&self) -> bool {
        #[cfg(target_os = "linux")]
        {
            self.cpu_controller.is_some()
        }
        #[cfg(not(target_os = "linux"))]
        {
            false
        }
    }

    /// Whether every field in a local or wire policy can be enforced by this
    /// manager. Memory support is established by construction; CPU is additive.
    #[must_use]
    pub fn supports_policy(&self, policy: OpCgroupConfig) -> bool {
        policy.cpu_max_millicores.is_none() || self.cpu_quota_supported()
    }

    /// Installs the pre-exec migration hook on one direct operation child. Opening
    /// `cgroup.procs` occurs in the parent; the post-fork hook performs only the
    /// async-signal-safe PID write. After a manager exists, migration failure always
    /// fails spawn before user code runs, including for an unlimited operation.
    #[cfg(target_os = "linux")]
    pub(crate) fn configure_process_cgroup_before_exec(
        &self,
        prepared: &PreparedOpCgroup,
        command: &mut tokio::process::Command,
    ) -> std::io::Result<()> {
        let procs_path = prepared
            .handle
            .dir
            .as_deref()
            .expect("a prepared operation must own its cgroup path")
            .join("cgroup.procs");
        let procs = match std::fs::OpenOptions::new().write(true).open(&procs_path) {
            Ok(procs) => procs,
            Err(error) => {
                self.note_admission_failure(format_args!(
                    "cannot pre-open {} for atomic operation placement: {error}",
                    procs_path.display()
                ));
                return Err(contextual_io_error(
                    "prepare atomic pre-exec operation-cgroup placement",
                    &error,
                ));
            }
        };
        // Once a cgroup manager prepared a leaf, placement is the admission
        // boundary even for an unlimited request. Failing the pre-exec write
        // aborts spawn before user code can fork; there is no racy repair loop.
        opengeni_agent_linux_ffi::configure_process_cgroup_before_exec(command, procs);
        Ok(())
    }

    /// Verifies both direct operation roots after spawn. Every child already had
    /// to migrate in the pre-exec hook before user code ran, so descendants inherit
    /// the leaf and there is no changing-member repair/fork-storm loop.
    #[cfg(target_os = "linux")]
    pub(crate) fn place_process_group(
        &self,
        _pgid: i32,
        direct_pids: &[u32],
        prepared: PreparedOpCgroup,
    ) -> std::io::Result<OpCgroupHandle> {
        let PreparedOpCgroup { handle } = prepared;
        self.verify_pids_in(
            handle
                .dir
                .as_deref()
                .expect("a live operation handle must own its cgroup path"),
            direct_pids,
        )?;
        Ok(handle)
    }

    /// Creates and configures one fresh `op-<n>` leaf before any operation child
    /// is forked. The returned preparation owns the teardown handle. Once this
    /// manager exists, every leaf creation/configuration/placement step is an
    /// admission invariant and fails the operation closed; ambient execution is
    /// reserved for hosts where startup established no manager at all.
    #[cfg(target_os = "linux")]
    pub(crate) fn prepare_op(
        &self,
        requested_config: OpCgroupConfig,
    ) -> std::io::Result<Option<PreparedOpCgroup>> {
        let applied_config = self.local_config.tightened_by(requested_config);
        let cpu_lease = self.acquire_cpu_lease(applied_config.cpu_max_millicores)?;
        let dir = self.create_op_cgroup()?;
        let handle = OpCgroupHandle {
            dir: Some(dir.clone()),
            cpu_lease,
        };

        self.configure_op_cgroup(&dir, applied_config)?;
        if applied_config.has_limits() {
            self.report_resource_policy(&dir, requested_config)
                .map_err(|error| {
                    policy_enforcement_error(
                        "read back the operation resource policy and ancestor bounds",
                        &error,
                    )
                })?;
        }

        Ok(Some(PreparedOpCgroup { handle }))
    }

    #[cfg(target_os = "linux")]
    fn acquire_cpu_lease(
        &self,
        cpu_max_millicores: Option<u32>,
    ) -> std::io::Result<Option<CpuControllerLease>> {
        let lease = if cpu_max_millicores.is_some() {
            Some(
                self.cpu_controller
                    .as_ref()
                    .ok_or_else(|| {
                        std::io::Error::other(
                            "explicit operation CPU quota requires a delegated cgroup-v2 CPU controller",
                        )
                    })?
                    .acquire()
                    .map_err(|error| {
                        policy_enforcement_error("activate the CPU controller", &error)
                    })?,
            )
        } else {
            None
        };
        Ok(lease)
    }

    #[cfg(target_os = "linux")]
    fn create_op_cgroup(&self) -> std::io::Result<PathBuf> {
        let mut op_id = self.next_op.load(Ordering::Relaxed);
        loop {
            let next = op_id
                .checked_add(1)
                .ok_or_else(|| std::io::Error::other("operation cgroup id space is exhausted"))?;
            match self.next_op.compare_exchange_weak(
                op_id,
                next,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(observed) => op_id = observed,
            }
        }
        let dir = self.service_dir.join(op_cgroup_name(op_id));
        // Every numeric operation id is allocated exactly once by this runner
        // generation. Refuse an existing path instead of adopting and later
        // killing a cgroup whose ownership cannot be proved.
        if let Err(error) = std::fs::create_dir(&dir) {
            self.note_admission_failure(format_args!(
                "cannot create op cgroup {}: {error}",
                dir.display()
            ));
            return Err(contextual_io_error(
                "create the operation cgroup after containment was established",
                &error,
            ));
        }
        Ok(dir)
    }

    #[cfg(target_os = "linux")]
    fn configure_op_cgroup(&self, dir: &Path, config: OpCgroupConfig) -> std::io::Result<()> {
        // If this leaf is selected by a memcg OOM, kill the complete operation
        // instead of leaving sibling descendants running with partial state.
        if let Err(error) = std::fs::write(dir.join("memory.oom.group"), "1") {
            self.note_admission_failure(format_args!(
                "cannot set memory.oom.group on {}: {error}",
                dir.display()
            ));
            return Err(contextual_io_error(
                "set the operation cgroup OOM ownership boundary",
                &error,
            ));
        }

        // Optional per-op caps (default: unset). Explicit policy is fail-closed:
        // silently continuing would turn an operator's ceiling into unlimited work.
        if let Some(max) = config.memory_max {
            if let Err(error) = std::fs::write(dir.join("memory.max"), max.to_string()) {
                self.note_admission_failure(format_args!(
                    "cannot set memory.max on {}: {error}",
                    dir.display()
                ));
                return Err(policy_enforcement_error("set memory.max", &error));
            }
        }
        if let Some(high) = config.memory_high {
            if let Err(error) = std::fs::write(dir.join("memory.high"), high.to_string()) {
                self.note_admission_failure(format_args!(
                    "cannot set memory.high on {}: {error}",
                    dir.display()
                ));
                return Err(policy_enforcement_error("set memory.high", &error));
            }
        }

        if let Some(millicores) = config.cpu_max_millicores {
            let cpu_max_path = dir.join("cpu.max");
            let inherited = read_cpu_max(&cpu_max_path).map_err(|error| {
                policy_enforcement_error("read the operation cpu.max period", &error)
            })?;
            let exact = exact_cpu_max(millicores, inherited.period).map_err(|error| {
                policy_enforcement_error("derive an exact operation CPU quota", &error)
            })?;
            let quota = exact
                .quota
                .expect("an exact configured CPU policy has a finite quota");
            if let Err(error) = std::fs::write(&cpu_max_path, format!("{quota} {}", exact.period)) {
                self.note_admission_failure(format_args!(
                    "cannot set cpu.max on {}: {error}",
                    dir.display()
                ));
                return Err(policy_enforcement_error("set cpu.max", &error));
            }
        }
        Ok(())
    }

    /// Rewrites each live direct PID to the already-inherited operation leaf.
    /// `cgroup.procs` returns only after placement is visible, making this a
    /// post-spawn verification rather than a race-closing repair mechanism.
    #[cfg(target_os = "linux")]
    fn verify_pids_in(&self, dir: &Path, pids: &[u32]) -> std::io::Result<()> {
        let procs = dir.join("cgroup.procs");
        for pid in pids {
            if let Err(error) = std::fs::write(&procs, pid.to_string()) {
                // A direct child may complete between spawn and placement. With no
                // live process left at that PID there is no policy to enforce.
                if !Path::new(&format!("/proc/{pid}")).exists() {
                    continue;
                }
                self.note_admission_failure(format_args!(
                    "cannot verify pid {pid} in {}: {error}",
                    dir.display()
                ));
                return Err(contextual_io_error(
                    &format!("verify live pid {pid} in the operation cgroup"),
                    &error,
                ));
            }
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn report_resource_policy(
        &self,
        op_dir: &Path,
        requested_config: OpCgroupConfig,
    ) -> std::io::Result<()> {
        let leaf_max_path = op_dir.join("memory.max");
        let leaf_high_path = op_dir.join("memory.high");
        let leaf_max = read_cgroup_limit(&leaf_max_path).map_err(|error| {
            contextual_io_error(&format!("read {}", leaf_max_path.display()), &error)
        })?;
        let leaf_high = read_cgroup_limit(&leaf_high_path).map_err(|error| {
            contextual_io_error(&format!("read {}", leaf_high_path.display()), &error)
        })?;
        // Ancestor memory controls are shared aggregate bounds. They cap what this
        // operation could consume but do not promise that much availability while
        // sibling cgroups compete for the same pool.
        let ancestor_aggregate_max = tightest_ancestor_limit(op_dir, "memory.max")?;
        let ancestor_aggregate_high = tightest_ancestor_limit(op_dir, "memory.high")?;
        let combined_upper_bound_max = tighter_limit(leaf_max, ancestor_aggregate_max);
        let combined_upper_bound_high = tighter_limit(
            tighter_limit(leaf_high, ancestor_aggregate_high),
            combined_upper_bound_max,
        );
        let (leaf_cpu, external_cpu, effective_cpu) =
            if requested_config.cpu_max_millicores.is_some()
                || self.local_config.cpu_max_millicores.is_some()
            {
                let leaf = read_cpu_max(&op_dir.join("cpu.max"))?;
                let external = tightest_ancestor_cpu_max(op_dir)?;
                (Some(leaf), external, Some(tighter_cpu_max(leaf, external)))
            } else {
                (None, None, None)
            };
        let report = ResourcePolicyReport {
            desired_memory_max: requested_config.memory_max,
            desired_memory_high: requested_config.memory_high,
            local_memory_max: self.local_config.memory_max,
            local_memory_high: self.local_config.memory_high,
            leaf_memory_max: leaf_max,
            leaf_memory_high: leaf_high,
            ancestor_aggregate_memory_max: ancestor_aggregate_max,
            ancestor_aggregate_memory_high: ancestor_aggregate_high,
            combined_memory_upper_bound_max: combined_upper_bound_max,
            combined_memory_upper_bound_high: combined_upper_bound_high,
            desired_cpu_millicores: requested_config.cpu_max_millicores,
            local_cpu_millicores: self.local_config.cpu_max_millicores,
            leaf_cpu,
            external_cpu,
            effective_cpu,
        };
        let mut prior = self
            .policy_report
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if prior.as_ref() != Some(&report) {
            tracing::info!(
                desired_memory_max = ?report.desired_memory_max,
                desired_memory_high = ?report.desired_memory_high,
                local_memory_max = ?report.local_memory_max,
                local_memory_high = ?report.local_memory_high,
                leaf_memory_max = ?report.leaf_memory_max,
                leaf_memory_high = ?report.leaf_memory_high,
                ancestor_aggregate_memory_max = ?report.ancestor_aggregate_memory_max,
                ancestor_aggregate_memory_high = ?report.ancestor_aggregate_memory_high,
                combined_memory_upper_bound_max = ?report.combined_memory_upper_bound_max,
                combined_memory_upper_bound_high = ?report.combined_memory_upper_bound_high,
                desired_cpu_millicores = ?report.desired_cpu_millicores,
                local_cpu_millicores = ?report.local_cpu_millicores,
                leaf_cpu = ?report.leaf_cpu,
                external_cpu = ?report.external_cpu,
                effective_cpu = ?report.effective_cpu,
                "operation resource policy and observed bounds changed"
            );
            *prior = Some(report);
        }
        Ok(())
    }

    /// Non-Linux no-op: no manager is ever constructed off Linux, so this is never
    /// reached; it exists so the cross-platform exec path type-checks.
    #[cfg(not(target_os = "linux"))]
    #[allow(clippy::unused_self)]
    #[allow(clippy::unnecessary_wraps)]
    pub(crate) fn place_op(
        &self,
        _pids: &[u32],
        _requested_config: OpCgroupConfig,
    ) -> std::io::Result<Option<OpCgroupHandle>> {
        Ok(None)
    }

    /// Logs an operation admission fault exactly once; a persistent host failure
    /// must not spam a line per exec.
    #[cfg(target_os = "linux")]
    fn note_admission_failure(&self, reason: std::fmt::Arguments<'_>) {
        if !self.admission_failure_logged.swap(true, Ordering::Relaxed) {
            tracing::warn!(
                %reason,
                "operation-cgroup admission failed; the affected operation is rejected while control service continues (logged once)"
            );
        }
    }
}

/// A configured but not-yet-spawned operation cgroup. Keeping creation and policy
/// writes ahead of `fork` lets the child migrate in pre-exec, closing the window
/// in which user code could create an uncontained descendant.
#[cfg(target_os = "linux")]
pub(crate) struct PreparedOpCgroup {
    handle: OpCgroupHandle,
}

/// A handle to one placed `op-<n>` leaf, responsible for removing it once the op's
/// process tree is reaped.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) struct OpCgroupHandle {
    /// The op leaf's absolute path.
    dir: Option<PathBuf>,
    /// Keeps hierarchical CPU scheduling active until this exact limited leaf is
    /// killed, unpopulated, and removed.
    #[cfg(target_os = "linux")]
    cpu_lease: Option<CpuControllerLease>,
}

#[cfg(target_os = "linux")]
impl OpCgroupHandle {
    /// Kills every process still owned by this operation cgroup. Unlike a POSIX
    /// process-group signal, the kernel cgroup boundary also covers a descendant
    /// that called `setsid`; a service manager that deliberately moved a durable
    /// service into another cgroup remains outside this ownership boundary.
    pub(crate) fn kill_all(&self) -> std::io::Result<()> {
        let Some(dir) = self.dir.as_ref() else {
            return Ok(());
        };
        Self::kill_all_at(dir)
    }

    fn kill_all_at(dir: &Path) -> std::io::Result<()> {
        match std::fs::write(dir.join("cgroup.kill"), "1") {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !dir.exists() => Ok(()),
            Err(error) => Err(contextual_io_error(
                &format!("kill operation cgroup {}", dir.display()),
                &error,
            )),
        }
    }

    /// Removes the op leaf after the op's processes are reaped. The cleanup is
    /// cancellation-safe: if this future is dropped, [`Drop`] schedules another
    /// owner for the same leaf.
    pub(crate) async fn teardown(mut self) {
        let Some(dir) = self.dir.as_ref() else {
            return;
        };
        match remove_op_cgroup(dir).await {
            Ok(()) => self.dir = None,
            Err(error) => {
                tracing::warn!(
                    dir = %dir.display(),
                    %error,
                    "failed to remove a runner-owned operation cgroup; scheduling one cancellation-safe retry"
                );
                // Keep ownership in `self`: Drop hands it to a runtime task so a
                // transient post-reap kernel race does not permanently leak the
                // runner-owned leaf.
            }
        }
    }
}

#[cfg(target_os = "linux")]
impl Drop for OpCgroupHandle {
    fn drop(&mut self) {
        let Some(dir) = self.dir.take() else {
            return;
        };
        // Drop means the operation did not complete normal teardown. Kill the
        // complete cgroup synchronously before returning from the error/cancel
        // path; process-group cleanup alone misses setsid/double-fork descendants.
        if let Err(error) = Self::kill_all_at(&dir) {
            tracing::warn!(
                dir = %dir.display(),
                %error,
                "failed to recursively kill a dropped operation cgroup"
            );
        }
        let cpu_lease = self.cpu_lease.take();
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            tracing::warn!(
                dir = %dir.display(),
                "cannot schedule operation-cgroup cleanup outside the agent runtime"
            );
            // Retain a CPU lease rather than lift a hard quota while descendants
            // may still be alive. Process exit ultimately releases the hierarchy.
            if let Some(lease) = cpu_lease {
                std::mem::forget(lease);
            }
            return;
        };
        runtime.spawn(async move {
            if let Err(error) = remove_op_cgroup(&dir).await {
                tracing::warn!(
                    dir = %dir.display(),
                    %error,
                    "failed to remove a runner-owned operation cgroup after task cancellation"
                );
                if let Some(lease) = cpu_lease {
                    std::mem::forget(lease);
                }
            }
            // On success, dropping `cpu_lease` after removal may disable +cpu
            // when this was the final limited operation.
        });
    }
}

/// Removes one operation leaf. A busy leaf means process release is still in
/// flight, so wait on the kernel's cgroup-v2 population notification and retry
/// after it reports empty.
#[cfg(target_os = "linux")]
async fn remove_op_cgroup(dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir(dir) {
        Ok(()) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) if error.raw_os_error() == Some(nix::libc::EBUSY) => {}
        Err(error) => return Err(error),
    }

    let events_file = std::fs::File::open(dir.join("cgroup.events"))?;
    let interest = Interest::PRIORITY.add(Interest::ERROR);
    let mut events = AsyncFd::with_interest(events_file, interest)?;

    if cgroup_is_populated(events.get_mut())? {
        loop {
            let mut ready = events.ready_mut(interest).await?;
            let populated = cgroup_is_populated(ready.get_inner_mut())?;
            ready.clear_ready();
            if !populated {
                break;
            }
        }
    }

    match std::fs::remove_dir(dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "linux")]
fn cgroup_is_populated(events: &mut std::fs::File) -> std::io::Result<bool> {
    use std::io::{Read as _, Seek as _};

    events.rewind()?;
    let mut contents = String::new();
    events.read_to_string(&mut contents)?;
    parse_cgroup_populated(&contents).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "cgroup.events does not contain a valid populated field",
        )
    })
}

/// Non-Linux stubs so the cross-platform exec path type-checks; never reached off
/// Linux (no handle is ever constructed).
#[cfg(not(target_os = "linux"))]
impl OpCgroupHandle {
    #[allow(dead_code)]
    #[allow(clippy::unused_self, clippy::unnecessary_wraps)]
    pub(crate) fn kill_all(&self) -> std::io::Result<()> {
        Ok(())
    }

    #[allow(dead_code)]
    #[allow(clippy::unused_async)]
    pub(crate) async fn teardown(self) {}
}

/// Verifies the manager-owned startup topology and returns active [`OpCgroups`], or `None` (with a
/// once-logged reason) when isolation is unavailable — the agent then serves with
/// today's behavior. Call this ONCE at startup, before any host exec or
/// agent-infrastructure child (for example Xvfb) is spawned, so only host work
/// lands in per-op leaves.
#[cfg(target_os = "linux")]
#[must_use]
pub fn establish_oom_isolation(config: OpCgroupConfig) -> Option<Arc<OpCgroups>> {
    report_supervisor_oom_score_adj();

    let startup = discover_delegated_service()?;
    let (enabled_controllers, unavailable_controllers, cpu_delegated) =
        establish_delegated_subtree(&startup)?;
    tracing::info!(
        service_cgroup = %startup.service_dir.display(),
        ?enabled_controllers,
        ?unavailable_controllers,
        memory_max = ?config.memory_max,
        memory_high = ?config.memory_high,
        cpu_max_millicores = ?config.cpu_max_millicores,
        cpu_quota_supported = cpu_delegated,
        stale_operations_cleanup_scheduled = startup.stale_op_cgroups.len(),
        "established per-op cgroups: host execs have separate resource accounting and systemd-oomd fate; no controller limit was added implicitly and kernel OOM selection remains score-based"
    );
    let service_dir = startup.service_dir;
    let cpu_controller = cpu_delegated.then(|| {
        Arc::new(CpuControllerState {
            service_dir: service_dir.clone(),
            active_leases: Mutex::new(0),
        })
    });
    Some(Arc::new(OpCgroups {
        service_dir,
        local_config: config,
        cpu_controller,
        next_op: AtomicU64::new(startup.next_op),
        admission_failure_logged: AtomicBool::new(false),
        policy_report: Mutex::new(None),
    }))
}

#[cfg(target_os = "linux")]
struct CgroupStartup {
    service_dir: PathBuf,
    supervisor_dir: PathBuf,
    controllers: String,
    next_op: u64,
    stale_op_cgroups: Vec<PathBuf>,
}

/// Discovers a delegated cgroup-v2 service whose manager placed this runner in
/// the stable supervisor subgroup. Requiring that topology preserves systemd's
/// ability to start a replacement after the service root enables controllers.
#[cfg(target_os = "linux")]
fn discover_delegated_service() -> Option<CgroupStartup> {
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
    let supervisor_dir = service_cgroup_dir(mount, &unified);
    let Some(service_dir) = manager_owned_service_dir(&supervisor_dir) else {
        tracing::info!(
            cgroup = %supervisor_dir.display(),
            expected_subgroup = SUPERVISOR_LEAF,
            "OOM cgroup isolation unavailable: the service manager did not place the runner in a dedicated supervisor subgroup (systemd units need DelegateSubgroup=supervisor); serving without per-op isolation so crash restart remains safe"
        );
        return None;
    };

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
    let current_pid = std::process::id();
    let sole_supervisor_member = std::fs::read_to_string(supervisor_dir.join("cgroup.procs"))
        .ok()
        .and_then(|contents| {
            let members = contents
                .split_whitespace()
                .map(str::parse::<u32>)
                .collect::<Result<Vec<_>, _>>()
                .ok()?;
            (members == [current_pid]).then_some(())
        })
        .is_some();
    if !sole_supervisor_member {
        tracing::warn!(
            dir = %supervisor_dir.display(),
            "OOM cgroup isolation unavailable: the supervisor subgroup is not owned solely by this runner process"
        );
        return None;
    }
    let service_root_empty = std::fs::read_to_string(service_dir.join("cgroup.procs"))
        .is_ok_and(|contents| contents.split_whitespace().next().is_none());
    if !service_root_empty {
        tracing::warn!(
            dir = %service_dir.display(),
            "OOM cgroup isolation unavailable: the delegated service root contains direct processes; refusing to enable child controllers"
        );
        return None;
    }
    let (next_op, stale_op_cgroups) = match discover_operation_cgroups(&service_dir) {
        Ok(discovered) => discovered,
        Err(error) => {
            tracing::warn!(
                %error,
                dir = %service_dir.display(),
                "OOM cgroup isolation unavailable: cannot enumerate runner-owned operation cgroups"
            );
            return None;
        }
    };
    Some(CgroupStartup {
        service_dir,
        supervisor_dir,
        controllers,
        next_op,
        stale_op_cgroups,
    })
}

/// Proves the manager-owned supervisor leaf, reclaims stale operation siblings,
/// and enables leaf accounting without ever moving the live supervisor.
#[cfg(target_os = "linux")]
fn establish_delegated_subtree(
    startup: &CgroupStartup,
) -> Option<(Vec<&'static str>, Vec<&'static str>, bool)> {
    let service_dir = &startup.service_dir;
    let supervisor_dir = &startup.supervisor_dir;
    // `ManagedOOMPreference=avoid` lives as an xattr on the service cgroup and is
    // not inherited by this child. Stamp the actual leaf. systemd-oomd honors it
    // only when the monitored ancestor and candidate have the same cgroup owner;
    // host policy must preserve that ownership relationship.
    match std::fs::read_to_string(supervisor_dir.join("cgroup.events"))
        .ok()
        .as_deref()
        .and_then(parse_cgroup_populated)
    {
        Some(true) => {}
        Some(false) => {
            tracing::warn!(dir = %supervisor_dir.display(), "OOM cgroup isolation unavailable: the manager-owned supervisor subgroup does not contain the running agent");
            return None;
        }
        None => {
            tracing::warn!(
                dir = %supervisor_dir.display(),
                "OOM cgroup isolation unavailable: cannot prove the runner-owned supervisor leaf is populated"
            );
            return None;
        }
    }
    // `cgroup.kill` is the lifecycle ownership primitive. Probe it in an empty
    // disposable child; writing the populated supervisor leaf would kill us.
    if let Err(error) = probe_cgroup_kill(service_dir) {
        tracing::info!(
            %error,
            dir = %service_dir.display(),
            "operation cgroup lifecycle unavailable: cgroup.kill is not writable; serving without per-op isolation"
        );
        return None;
    }
    if let Err(error) = xattr::set(supervisor_dir, SYSTEMD_OOMD_AVOID_XATTR, b"1") {
        tracing::warn!(
            %error,
            dir = %supervisor_dir.display(),
            "OOM cgroup isolation unavailable: cannot protect the supervisor leaf from systemd-oomd; keeping the supervisor in the unit cgroup"
        );
        return None;
    }
    if let Err(error) = reclaim_stale_operation_cgroups(&startup.stale_op_cgroups) {
        tracing::warn!(
            %error,
            "OOM cgroup isolation unavailable: cannot reclaim a stale runner-owned operation"
        );
        return None;
    }
    let cpu_delegated = controllers_contains(&startup.controllers, "cpu");
    if let Err(error) = disable_subtree_controller(service_dir, "cpu") {
        tracing::warn!(
            %error,
            "OOM cgroup isolation unavailable: cannot restore ambient CPU scheduling before accepting unrestricted operations"
        );
        return None;
    }
    let (enabled_controllers, unavailable_controllers) = match enable_op_accounting_controllers(
        service_dir,
        &startup.controllers,
    ) {
        Ok(report) => report,
        Err(error) => {
            tracing::info!(
                %error,
                "OOM cgroup isolation unavailable: cannot delegate the memory controller to per-op leaves; serving without per-op isolation"
            );
            return None;
        }
    };

    Some((enabled_controllers, unavailable_controllers, cpu_delegated))
}

/// Non-Linux no-op: per-op cgroup isolation is a Linux cgroup v2 feature. Returns
/// `None` so the agent runs unchanged on macOS/Windows.
#[cfg(not(target_os = "linux"))]
#[must_use]
pub fn establish_oom_isolation(_config: OpCgroupConfig) -> Option<Arc<OpCgroups>> {
    tracing::debug!("per-op OOM cgroup isolation is Linux-only; running without it on this OS");
    None
}

/// Finds exact `op-<u64>` leaves left by an earlier runner process. The next live
/// id starts above every discovered id, so asynchronous stale-leaf removal can
/// never collide with new work.
#[cfg(target_os = "linux")]
fn discover_operation_cgroups(service_dir: &Path) -> std::io::Result<(u64, Vec<PathBuf>)> {
    let mut highest = None;
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(service_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let Some(id) = name
            .to_str()
            .and_then(|name| name.strip_prefix("op-"))
            .and_then(|value| value.parse::<u64>().ok())
        else {
            continue;
        };
        highest = Some(highest.map_or(id, |prior: u64| prior.max(id)));
        paths.push(entry.path());
    }
    let next = match highest {
        Some(id) => id.checked_add(1).ok_or_else(|| {
            std::io::Error::other(
                "operation cgroup id space is exhausted by a stale op-u64::MAX leaf",
            )
        })?,
        None => 0,
    };
    Ok((next, paths))
}

/// Kills and asynchronously removes stale runner-owned operation leaves before
/// the new supervisor begins accepting work. An explicitly service-manager-owned
/// durable service has already moved to a different cgroup and is not affected.
#[cfg(target_os = "linux")]
fn reclaim_stale_operation_cgroups(paths: &[PathBuf]) -> std::io::Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let runtime = tokio::runtime::Handle::try_current().map_err(|error| {
        std::io::Error::other(format!(
            "cannot schedule stale operation cleanup outside the agent runtime: {error}"
        ))
    })?;
    for dir in paths {
        std::fs::write(dir.join("cgroup.kill"), "1").map_err(|error| {
            contextual_io_error(
                &format!("kill stale operation cgroup {}", dir.display()),
                &error,
            )
        })?;
        let dir = dir.clone();
        runtime.spawn(async move {
            if let Err(error) = remove_op_cgroup(&dir).await {
                tracing::warn!(
                    %error,
                    dir = %dir.display(),
                    "failed to remove a reclaimed stale operation cgroup"
                );
            }
        });
    }
    Ok(())
}

/// Proves that the kernel's recursive cgroup kill primitive is writable without
/// targeting the populated supervisor. A prior crash during this probe may leave
/// the exact empty probe leaf behind; reclaim only that proven-empty shape.
#[cfg(target_os = "linux")]
fn probe_cgroup_kill(service_dir: &Path) -> std::io::Result<()> {
    let probe = service_dir.join("op-lifecycle-probe");
    match std::fs::create_dir(&probe) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let populated = std::fs::read_to_string(probe.join("cgroup.events"))
                .ok()
                .as_deref()
                .and_then(parse_cgroup_populated);
            if populated != Some(false) {
                return Err(std::io::Error::other(format!(
                    "existing lifecycle probe {} is not provably empty",
                    probe.display()
                )));
            }
            std::fs::remove_dir(&probe)?;
            std::fs::create_dir(&probe)?;
        }
        Err(error) => return Err(error),
    }

    let write_result = std::fs::write(probe.join("cgroup.kill"), "1");
    let remove_result = std::fs::remove_dir(&probe);
    write_result?;
    remove_result
}

/// Reads one cgroup-v2 `max`/byte limit. `None` is the kernel's unlimited state.
#[cfg(target_os = "linux")]
fn read_cgroup_limit(path: &Path) -> std::io::Result<Option<u64>> {
    let value = std::fs::read_to_string(path)?;
    let value = value.trim();
    if value == "max" {
        return Ok(None);
    }
    value.parse::<u64>().map(Some).map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("invalid cgroup limit in {}: {error}", path.display()),
        )
    })
}

/// Parses the two-field cgroup-v2 `cpu.max` ABI (`max|quota period`).
#[cfg(target_os = "linux")]
fn read_cpu_max(path: &Path) -> std::io::Result<CpuMax> {
    let value = std::fs::read_to_string(path)?;
    parse_cpu_max(&value).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("invalid cpu.max value in {}", path.display()),
        )
    })
}

#[cfg(any(target_os = "linux", test))]
fn parse_cpu_max(value: &str) -> Option<CpuMax> {
    let mut fields = value.split_whitespace();
    let quota = match fields.next()? {
        "max" => None,
        quota => Some(quota.parse::<u64>().ok()?),
    };
    let period = fields.next()?.parse::<u64>().ok()?;
    if fields.next().is_some()
        || !(CGROUP_CPU_MIN_MICROS..=CGROUP_CPU_MAX_PERIOD_MICROS).contains(&period)
        || quota.is_some_and(|quota| quota < CGROUP_CPU_MIN_MICROS)
    {
        return None;
    }
    Some(CpuMax { quota, period })
}

/// Converts an exact integer-millicore contract to the cgroup-v2 microsecond
/// ratio without rounding. Preserve the leaf's inherited period when possible.
/// Otherwise lengthen it only enough to meet the kernel's 1 ms minimum quota and
/// make the reduced millicore ratio integral. The kernel's 1 s ABI maximum
/// represents even 1 millicore exactly (1000/1_000_000).
#[cfg(any(target_os = "linux", test))]
fn exact_cpu_max(millicores: u32, inherited_period: u64) -> std::io::Result<CpuMax> {
    if millicores == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "CPU quota must be positive millicores",
        ));
    }
    if !(CGROUP_CPU_MIN_MICROS..=CGROUP_CPU_MAX_PERIOD_MICROS).contains(&inherited_period) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "inherited cpu.max period is outside the cgroup-v2 ABI range",
        ));
    }

    let millicores = u64::from(millicores);
    let divisor = greatest_common_divisor(millicores, MILLICORES_PER_CPU);
    let reduced_numerator = millicores / divisor;
    let reduced_denominator = MILLICORES_PER_CPU / divisor;
    let minimum_for_quota = CGROUP_CPU_MIN_MICROS
        .checked_mul(MILLICORES_PER_CPU)
        .and_then(|numerator| numerator.checked_add(millicores - 1))
        .map(|numerator| numerator / millicores)
        .ok_or_else(|| std::io::Error::other("CPU period derivation overflow"))?;
    let required = inherited_period
        .max(minimum_for_quota)
        .max(CGROUP_CPU_MIN_MICROS);
    let period = required
        .checked_add(reduced_denominator - 1)
        .map(|value| value / reduced_denominator * reduced_denominator)
        .ok_or_else(|| std::io::Error::other("CPU period alignment overflow"))?;
    if period > CGROUP_CPU_MAX_PERIOD_MICROS {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "CPU quota cannot be represented within the cgroup-v2 period range",
        ));
    }
    let quota = (period / reduced_denominator)
        .checked_mul(reduced_numerator)
        .filter(|quota| *quota >= CGROUP_CPU_MIN_MICROS)
        .ok_or_else(|| std::io::Error::other("CPU quota derivation overflow"))?;
    Ok(CpuMax {
        quota: Some(quota),
        period,
    })
}

#[cfg(any(target_os = "linux", test))]
fn greatest_common_divisor(mut left: u64, mut right: u64) -> u64 {
    while right != 0 {
        (left, right) = (right, left % right);
    }
    left
}

/// Preserves an I/O error's stable kind while attaching the exact cgroup path and
/// action. This keeps capability and policy failures diagnosable after the native
/// platform maps them onto its typed wire error.
#[cfg(target_os = "linux")]
fn contextual_io_error(context: &str, source: &std::io::Error) -> std::io::Error {
    std::io::Error::new(source.kind(), format!("{context}: {source}"))
}

/// Finds the tightest finite ancestor policy outside `op_dir`. Ancestor controls
/// are external machine policy and always win over a looser runner leaf. The
/// cgroup-v2 root is not a policy-bearing child and intentionally lacks controller
/// limit files such as `memory.max`, so traversal stops before it.
#[cfg(target_os = "linux")]
fn tightest_ancestor_limit(op_dir: &Path, file: &str) -> std::io::Result<Option<u64>> {
    let mount = Path::new(CGROUP2_MOUNT);
    let mut tightest = None;
    let mut current = op_dir.parent();
    while let Some(dir) = current.filter(|dir| dir.starts_with(mount) && *dir != mount) {
        let path = dir.join(file);
        let limit = read_cgroup_limit(&path)
            .map_err(|error| contextual_io_error(&format!("read {}", path.display()), &error))?;
        tightest = tighter_limit(tightest, limit);
        current = dir.parent();
    }
    Ok(tightest)
}

#[cfg(target_os = "linux")]
fn tightest_ancestor_cpu_max(op_dir: &Path) -> std::io::Result<Option<CpuMax>> {
    let mount = Path::new(CGROUP2_MOUNT);
    let mut tightest = None;
    let mut current = op_dir.parent();
    while let Some(dir) = current.filter(|dir| dir.starts_with(mount) && *dir != mount) {
        let path = dir.join("cpu.max");
        let limit = read_cpu_max(&path)
            .map_err(|error| contextual_io_error(&format!("read {}", path.display()), &error))?;
        if limit.quota.is_some() {
            tightest = Some(tightest.map_or(limit, |prior| tighter_cpu_max(prior, Some(limit))));
        }
        current = dir.parent();
    }
    Ok(tightest)
}

/// Compares CPU ratios with `u128` cross-products so differing periods and large
/// protocol values never overflow or lose precision.
#[cfg(any(target_os = "linux", test))]
fn tighter_cpu_max(left: CpuMax, right: Option<CpuMax>) -> CpuMax {
    let Some(right) = right else {
        return left;
    };
    match (left.quota, right.quota) {
        (None, _) => right,
        (_, None) => left,
        (Some(left_quota), Some(right_quota)) => {
            let left_scaled = u128::from(left_quota) * u128::from(right.period);
            let right_scaled = u128::from(right_quota) * u128::from(left.period);
            if left_scaled <= right_scaled {
                left
            } else {
                right
            }
        }
    }
}

/// Combines two cgroup limits: unlimited yields to finite and two finite ceilings
/// resolve to the tighter value.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn tighter_limit(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

/// Enables the always-on delegated controller subset. Today that is memory only:
/// it is the fate-isolation prerequisite and therefore errors out. CPU has a
/// separate opt-in lease; I/O and PID remain disabled.
#[cfg(target_os = "linux")]
fn enable_op_accounting_controllers(
    service_dir: &Path,
    available: &str,
) -> std::io::Result<(Vec<&'static str>, Vec<&'static str>)> {
    let mut enabled = Vec::new();
    let mut unavailable = Vec::new();
    for controller in OP_ALWAYS_ON_CONTROLLERS {
        if !controllers_contains(available, controller) {
            unavailable.push(controller);
            continue;
        }
        match enable_subtree_controller(service_dir, controller) {
            Ok(()) => enabled.push(controller),
            Err(error) if controller == "memory" => return Err(error),
            Err(error) => {
                unavailable.push(controller);
                tracing::warn!(
                    %error,
                    controller,
                    "operation-cgroup accounting controller is unavailable"
                );
            }
        }
    }
    Ok((enabled, unavailable))
}

/// Enables one already-delegated controller for the service's direct children and
/// verifies the effective kernel state. Writes to `cgroup.subtree_control` are
/// commands (`+controller`), not replacement file contents.
#[cfg(target_os = "linux")]
fn enable_subtree_controller(service_dir: &Path, controller: &str) -> std::io::Result<()> {
    let subtree = service_dir.join("cgroup.subtree_control");
    if std::fs::read_to_string(&subtree)
        .is_ok_and(|contents| controllers_contains(&contents, controller))
    {
        return Ok(());
    }
    std::fs::write(&subtree, format!("+{controller}"))?;
    let effective = std::fs::read_to_string(&subtree)?;
    if controllers_contains(&effective, controller) {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "kernel did not enable delegated controller {controller}"
        )))
    }
}

/// Disables one controller for the service's direct children and verifies the
/// effective state. This restores ambient scheduling after the last explicit CPU
/// quota; leaving `+cpu` sticky would silently change future unrestricted work.
#[cfg(target_os = "linux")]
fn disable_subtree_controller(service_dir: &Path, controller: &str) -> std::io::Result<()> {
    let subtree = service_dir.join("cgroup.subtree_control");
    if std::fs::read_to_string(&subtree)
        .is_ok_and(|contents| !controllers_contains(&contents, controller))
    {
        return Ok(());
    }
    std::fs::write(&subtree, format!("-{controller}"))?;
    let effective = std::fs::read_to_string(&subtree)?;
    if controllers_contains(&effective, controller) {
        Err(std::io::Error::other(format!(
            "kernel did not disable delegated controller {controller}"
        )))
    } else {
        Ok(())
    }
}

// --- oom_score_adj: bias the kernel OOM killer toward host work ----------------

/// Derives the minimal child OOM bias above the supervisor when the kernel ABI can
/// represent one. A manager-protected negative supervisor needs only neutral
/// children. If the manager clamps the supervisor to neutral or positive, one
/// point is the smallest legal preference. At the ABI ceiling (1000) no stronger
/// relative preference is representable, so the child remains equal.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn minimal_exec_oom_score_adj(supervisor: i32) -> u16 {
    if supervisor < 0 {
        0
    } else {
        u16::try_from(supervisor.saturating_add(1).min(1000))
            .expect("a parsed nonnegative OOM adjustment fits u16")
    }
}

/// Reads the current supervisor's authoritative kernel value and derives the
/// minimal child bias. `None` leaves the host policy untouched when `/proc` cannot
/// be read or contains an invalid ABI value.
#[cfg(target_os = "linux")]
fn exec_oom_score_adj() -> Option<u16> {
    std::fs::read_to_string("/proc/self/oom_score_adj")
        .ok()
        .and_then(|value| parse_oom_score_adj(&value))
        .map(minimal_exec_oom_score_adj)
}

/// Reports the effective supervisor victim bias. Service managers are allowed to
/// clamp a requested negative value, so the generated unit text is not evidence
/// that kernel OOM protection is active; `/proc` is authoritative.
#[cfg(target_os = "linux")]
fn report_supervisor_oom_score_adj() {
    match std::fs::read_to_string("/proc/self/oom_score_adj")
        .ok()
        .and_then(|value| parse_oom_score_adj(&value))
    {
        Some(score) if score < 0 => tracing::info!(
            oom_score_adj = score,
            "control supervisor has negative kernel OOM victim bias"
        ),
        Some(0) => tracing::info!(
            oom_score_adj = 0,
            child_oom_score_adj = minimal_exec_oom_score_adj(0),
            "control supervisor has neutral kernel OOM victim bias; children receive the smallest available relative preference"
        ),
        Some(score) => tracing::warn!(
            oom_score_adj = score,
            child_oom_score_adj = minimal_exec_oom_score_adj(score),
            relative_preference_representable = score < 1000,
            "control supervisor has nonnegative kernel OOM victim bias; children receive the smallest higher bias when representable, otherwise the equal ABI ceiling, and delegated cgroups do not protect against host-wide kernel OOM"
        ),
        None => tracing::warn!(
            "could not read the control supervisor's effective kernel OOM victim bias"
        ),
    }
}

#[cfg(any(target_os = "linux", test))]
fn parse_oom_score_adj(value: &str) -> Option<i32> {
    value
        .trim()
        .parse::<i32>()
        .ok()
        .filter(|score| (-1000..=1000).contains(score))
}

/// Guards the "log once" of an `oom_score_adj` write failure so a restrictive host
/// policy is reported once, not per exec.
#[cfg(target_os = "linux")]
static OOM_SCORE_ADJ_WARNED: AtomicBool = AtomicBool::new(false);

/// Installs an async-signal-safe pre-exec hook that raises the forked process's
/// own OOM bias before user code can run or fork. The post-spawn write below is
/// retained as a best-effort verification/fallback, but is no longer the only
/// protection on hosts without delegated cgroups.
#[cfg(target_os = "linux")]
pub(crate) fn configure_exec_oom_score_adj_before_exec(
    command: &mut tokio::process::Command,
) -> Option<u16> {
    let score = exec_oom_score_adj();
    if let Some(score) = score {
        opengeni_agent_linux_ffi::configure_oom_score_adj_before_exec(command, score);
    }
    score
}

/// Raises `/proc/<pid>/oom_score_adj` on a freshly-spawned exec child so the kernel
/// OOM killer prefers it over the control supervisor (issue #345). Composes with
/// the per-op cgroup: this biases the GLOBAL kernel OOM killer, the cgroup gives
/// systemd-oomd a bounded scope — both apply. Best-effort: a failure (the child
/// already exited, or a locked-down policy) is logged once and ignored.
#[cfg(target_os = "linux")]
pub(crate) fn raise_exec_oom_score_adj(pid: u32, target: Option<u16>) {
    let Some(target) = target else {
        return;
    };
    let path = format!("/proc/{pid}/oom_score_adj");
    if let Err(error) = std::fs::write(&path, target.to_string()) {
        if !OOM_SCORE_ADJ_WARNED.swap(true, Ordering::Relaxed) {
            tracing::warn!(
                %error,
                pid,
                target,
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

/// Resolves the delegated service root only when the current process is already
/// in the stable manager-owned supervisor leaf. This is a topology requirement,
/// not a naming convenience: starting in the root and moving later prevents
/// systemd from placing a crash replacement after child controllers are enabled.
#[cfg(target_os = "linux")]
fn manager_owned_service_dir(supervisor_dir: &Path) -> Option<PathBuf> {
    (supervisor_dir.file_name()? == std::ffi::OsStr::new(SUPERVISOR_LEAF))
        .then(|| supervisor_dir.parent().map(Path::to_path_buf))
        .flatten()
}

/// Whether a `cgroup.controllers`/`cgroup.subtree_control` body (space-separated
/// controller names) lists `controller`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn controllers_contains(contents: &str, controller: &str) -> bool {
    contents.split_whitespace().any(|name| name == controller)
}

/// Parses the `populated` field from a cgroup-v2 `cgroup.events` document.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_cgroup_populated(contents: &str) -> Option<bool> {
    contents.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        match (fields.next(), fields.next(), fields.next()) {
            (Some("populated"), Some("0"), None) => Some(false),
            (Some("populated"), Some("1"), None) => Some(true),
            _ => None,
        }
    })
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
    fn parses_only_valid_kernel_oom_adjustments() {
        assert_eq!(parse_oom_score_adj("-200\n"), Some(-200));
        assert_eq!(parse_oom_score_adj("1000"), Some(1000));
        assert_eq!(parse_oom_score_adj("1001"), None);
        assert_eq!(parse_oom_score_adj("invalid"), None);
    }

    #[test]
    fn child_oom_bias_is_the_minimal_representable_target() {
        assert_eq!(minimal_exec_oom_score_adj(-100), 0);
        assert_eq!(minimal_exec_oom_score_adj(-1), 0);
        assert_eq!(minimal_exec_oom_score_adj(0), 1);
        assert_eq!(minimal_exec_oom_score_adj(999), 1000);
        assert_eq!(minimal_exec_oom_score_adj(1000), 1000);
    }

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

    #[cfg(target_os = "linux")]
    #[test]
    fn manager_owned_topology_requires_the_exact_supervisor_leaf() {
        let supervisor = Path::new("/sys/fs/cgroup/system.slice/opengeni-agent.service/supervisor");
        assert_eq!(
            manager_owned_service_dir(supervisor),
            Some(PathBuf::from(
                "/sys/fs/cgroup/system.slice/opengeni-agent.service"
            ))
        );
        assert_eq!(
            manager_owned_service_dir(Path::new(
                "/sys/fs/cgroup/system.slice/opengeni-agent.service"
            )),
            None
        );
        assert_eq!(
            manager_owned_service_dir(Path::new(
                "/sys/fs/cgroup/system.slice/opengeni-agent.service/supervisor-extra"
            )),
            None
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
    fn parses_cgroup_population_without_accepting_malformed_values() {
        assert_eq!(
            parse_cgroup_populated("populated 1\nfrozen 0\n"),
            Some(true)
        );
        assert_eq!(
            parse_cgroup_populated("populated 0\nfrozen 0\n"),
            Some(false)
        );
        assert_eq!(parse_cgroup_populated("populated 2\n"), None);
        assert_eq!(parse_cgroup_populated("populated 0 extra\n"), None);
        assert_eq!(parse_cgroup_populated("frozen 0\n"), None);
    }

    #[test]
    fn finite_cgroup_policy_always_wins_over_unlimited_or_looser_policy() {
        assert_eq!(tighter_limit(None, None), None);
        assert_eq!(tighter_limit(Some(1024), None), Some(1024));
        assert_eq!(tighter_limit(None, Some(2048)), Some(2048));
        assert_eq!(tighter_limit(Some(2048), Some(1024)), Some(1024));
    }

    #[test]
    fn explicit_policy_io_failures_are_not_misclassified_as_missing_commands() {
        let missing_controller = std::io::Error::from(std::io::ErrorKind::NotFound);
        let error = policy_enforcement_error("read back memory.max", &missing_controller);
        assert_eq!(error.kind(), std::io::ErrorKind::Other);
        assert!(error
            .to_string()
            .contains("explicit operation resource policy could not read back memory.max"));
    }

    #[test]
    fn op_cgroup_names_are_unique_per_id() {
        assert_eq!(op_cgroup_name(0), "op-0");
        assert_eq!(op_cgroup_name(42), "op-42");
        assert_ne!(op_cgroup_name(1), op_cgroup_name(2));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn stale_operation_discovery_is_exact_and_advances_the_id_space() {
        let root = tempfile::tempdir().expect("temporary service cgroup shape");
        for name in ["supervisor", "op-not-an-id", "op-3-extra", "op-2", "op-7"] {
            std::fs::create_dir(root.path().join(name)).expect("create fixture directory");
        }
        std::fs::write(root.path().join("op-99-file"), "not a directory")
            .expect("create ignored fixture file");

        let (next, mut paths) =
            discover_operation_cgroups(root.path()).expect("discover stale leaves");
        paths.sort();
        assert_eq!(next, 8);
        assert_eq!(paths, [root.path().join("op-2"), root.path().join("op-7")]);
    }

    #[test]
    fn config_from_env_accepts_explicit_limits_and_rejects_malformed_policy() {
        // Serialize the env mutation so parallel tests don't clobber the vars.
        static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        std::env::remove_var(OP_MEMORY_MAX_ENV);
        std::env::remove_var(OP_MEMORY_HIGH_ENV);
        std::env::remove_var(OP_CPU_MAX_MILLICORES_ENV);
        let unset = OpCgroupConfig::from_env().expect("unset policy is valid");
        assert_eq!(unset.memory_max, None);
        assert_eq!(unset.memory_high, None);
        assert_eq!(unset.cpu_max_millicores, None);

        std::env::set_var(OP_MEMORY_MAX_ENV, "1073741824");
        std::env::set_var(OP_MEMORY_HIGH_ENV, "0"); // zero is "unset"
        std::env::set_var(OP_CPU_MAX_MILLICORES_ENV, "1750");
        let cfg = OpCgroupConfig::from_env().expect("numeric policy is valid");
        assert_eq!(cfg.memory_max, Some(1_073_741_824));
        assert_eq!(cfg.memory_high, None, "zero disables the limit");
        assert_eq!(cfg.cpu_max_millicores, Some(1750));

        std::env::set_var(OP_MEMORY_MAX_ENV, "not-a-number");
        assert_eq!(
            OpCgroupConfig::from_env(),
            Err(OpCgroupConfigError::InvalidByteCount {
                name: OP_MEMORY_MAX_ENV
            })
        );

        std::env::set_var(OP_MEMORY_MAX_ENV, "1024");
        std::env::set_var(OP_MEMORY_HIGH_ENV, "2048");
        assert_eq!(
            OpCgroupConfig::from_env(),
            Err(OpCgroupConfigError::MemoryHighExceedsMax {
                high: 2048,
                max: 1024
            })
        );

        std::env::remove_var(OP_MEMORY_MAX_ENV);
        std::env::remove_var(OP_MEMORY_HIGH_ENV);
        std::env::remove_var(OP_CPU_MAX_MILLICORES_ENV);
    }

    #[test]
    fn per_connection_policy_can_only_tighten_local_policy() {
        let local =
            OpCgroupConfig::from_limits(Some(1_073_741_824), Some(805_306_368), Some(2_000))
                .expect("local policy");
        let requested = OpCgroupConfig::from_limits(Some(536_870_912), None, Some(3_000))
            .expect("requested policy");
        assert_eq!(
            local.tightened_by(requested),
            OpCgroupConfig {
                memory_max: Some(536_870_912),
                memory_high: Some(536_870_912),
                cpu_max_millicores: Some(2_000),
            }
        );

        let unlimited = OpCgroupConfig::default();
        assert_eq!(unlimited.tightened_by(unlimited), unlimited);
    }

    #[test]
    fn wire_policy_rejects_zero_and_an_impossible_order() {
        assert_eq!(
            OpCgroupConfig::from_limits(Some(0), None, None),
            Err(OpCgroupConfigError::ZeroByteCount {
                setting: "memory.max",
            })
        );
        assert_eq!(
            OpCgroupConfig::from_limits(Some(1024), Some(2048), None),
            Err(OpCgroupConfigError::MemoryHighExceedsMax {
                high: 2048,
                max: 1024,
            })
        );
        assert_eq!(
            OpCgroupConfig::from_limits(None, None, Some(0)),
            Err(OpCgroupConfigError::ZeroCpuCount)
        );
    }

    #[test]
    fn hard_ceiling_does_not_invent_a_soft_throttle() {
        let local = OpCgroupConfig::default();
        let requested =
            OpCgroupConfig::from_limits(Some(536_870_912), None, None).expect("requested policy");
        assert_eq!(
            local.tightened_by(requested),
            OpCgroupConfig {
                memory_max: Some(536_870_912),
                memory_high: None,
                cpu_max_millicores: None,
            }
        );
    }

    #[test]
    fn cpu_max_parser_accepts_only_the_kernel_two_field_abi() {
        assert_eq!(
            parse_cpu_max("max 100000\n"),
            Some(CpuMax {
                quota: None,
                period: 100_000,
            })
        );
        assert_eq!(
            parse_cpu_max("25000 100000"),
            Some(CpuMax {
                quota: Some(25_000),
                period: 100_000,
            })
        );
        assert_eq!(parse_cpu_max("999 100000"), None);
        assert_eq!(parse_cpu_max("max 100000 extra"), None);
    }

    #[test]
    fn exact_millicores_preserve_or_minimally_lengthen_the_kernel_period() {
        assert_eq!(
            exact_cpu_max(1, 100_000).expect("1m is exactly representable"),
            CpuMax {
                quota: Some(1_000),
                period: 1_000_000,
            }
        );
        assert_eq!(
            exact_cpu_max(9, 100_000).expect("9m is exactly representable"),
            CpuMax {
                quota: Some(1_008),
                period: 112_000,
            }
        );
        assert_eq!(
            exact_cpu_max(10, 100_000).expect("10m preserves the default period"),
            CpuMax {
                quota: Some(1_000),
                period: 100_000,
            }
        );
        assert_eq!(
            exact_cpu_max(500, 100_001).expect("odd period aligns upward exactly"),
            CpuMax {
                quota: Some(50_001),
                period: 100_002,
            }
        );
        assert_eq!(
            exact_cpu_max(u32::MAX, 100_000).expect("largest wire value fits"),
            CpuMax {
                quota: Some(429_496_729_500),
                period: 100_000,
            }
        );
        assert!(exact_cpu_max(0, 100_000).is_err());
        assert!(exact_cpu_max(1, 1_000_001).is_err());
    }

    #[test]
    fn cpu_ratio_comparison_is_exact_across_periods_and_large_values() {
        let leaf = CpuMax {
            quota: Some(50_000),
            period: 100_000,
        };
        let tighter_ancestor = CpuMax {
            quota: Some(4_000),
            period: 10_000,
        };
        assert_eq!(
            tighter_cpu_max(leaf, Some(tighter_ancestor)),
            tighter_ancestor
        );
        let huge = CpuMax {
            quota: Some(u64::MAX),
            period: 1_000_000,
        };
        assert_eq!(tighter_cpu_max(huge, Some(leaf)), leaf);
    }
}
