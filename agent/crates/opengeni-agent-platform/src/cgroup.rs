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
//! `Delegate=yes` plus the relevant accounting directives — see
//! [`crate::service`]), it:
//!
//! 1. **Startup topology** ([`establish_oom_isolation`]). cgroup v2 forbids a
//!    cgroup from holding member processes AND enabling controllers for its
//!    children (the "no internal processes" rule). The generated systemd unit
//!    therefore uses `DelegateSubgroup=supervisor`, which places the first and
//!    every replacement agent process directly in `<service>/supervisor`. The
//!    agent verifies that manager-owned topology, then enables every delegated
//!    accounting controller used by the runner (`cpu`, `io`, `memory`, and `pids`) in
//!    `<service>/cgroup.subtree_control`. Per-op cgroups are then
//!    `<service>/op-<n>` siblings of `supervisor`, each with its own resource
//!    accounting and systemd-oomd selection. Enabling a controller does not set a
//!    quota: separate leaves do not by themselves constrain the operation or
//!    change the global kernel OOM victim order.
//! 2. **Per-exec placement** ([`OpCgroups::prepare_op`]). Before either direct
//!    child is spawned, the runner creates and configures a fresh `op-<n>` leaf and
//!    pre-opens its `cgroup.procs`. An async-signal-safe pre-exec hook migrates each
//!    forked child before `execve(2)`, so user code and every descendant are born in
//!    the operation leaf even if they immediately call `setsid` or double-fork.
//!    The post-spawn barrier verifies both direct roots and retains a same-group
//!    supervisor drain only as observable best-effort fallback for an unrestricted
//!    request. Optional per-op limits contain a memory blow-up to that leaf.
//!    Without a limit, the child score bias below is what makes global kernel OOM
//!    prefer host work over the supervisor.
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
//! With the unrestricted default, every isolation step degrades gracefully: not
//! Linux, no cgroup v2, the memory controller is not delegated, or any step returns
//! `EPERM`/IO error → the reason is logged once and the agent keeps serving with
//! the host's ambient behavior. An explicit resource policy instead fails the
//! affected operation closed if it cannot be proved enforced. Either way, an
//! isolation failure never stops the supervisor from answering control RPCs.
//!
//! # Cross-platform posture
//!
//! This is a Linux-first feature. On macOS/Windows [`establish_oom_isolation`]
//! returns `None` (a documented no-op) and no cgroup is ever touched — the same
//! honest-degradation posture the metrics reader uses for its `/proc` sources.

#[cfg(target_os = "linux")]
use std::collections::HashSet;
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

/// Controllers whose leaf files provide the resource-accounting contract. The
/// runner enables only the subset delegated by the service manager. None of these
/// controller activations installs a resource limit.
#[cfg(target_os = "linux")]
const OP_ACCOUNTING_CONTROLLERS: [&str; 4] = ["memory", "cpu", "io", "pids"];

/// Environment variable naming an optional per-op `memory.max` hard cap, in bytes.
const OP_MEMORY_MAX_ENV: &str = "OPENGENI_AGENT_OP_MEMORY_MAX";

/// Environment variable naming an optional per-op `memory.high` throttle, in bytes.
const OP_MEMORY_HIGH_ENV: &str = "OPENGENI_AGENT_OP_MEMORY_HIGH";

/// Optional per-op memory limits applied to each `op-<n>` leaf. Both default to
/// unset: the leaf still ACCOUNTS memory separately (which is what fate-isolates
/// the supervisor), and only caps the op when an operator opts in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
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
        let config = Self {
            memory_max,
            memory_high,
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
    fn tightened_by(self, requested: Self) -> Self {
        let memory_max = tighter_limit(self.memory_max, requested.memory_max);
        let memory_high = tighter_limit(self.memory_high, requested.memory_high)
            .map(|high| memory_max.map_or(high, |max| high.min(max)));
        Self {
            memory_max,
            // Do not invent a soft throttle from a hard ceiling. If a soft limit
            // was requested, cap it at the effective hard ceiling so the leaf
            // cannot claim an impossible throttle-above-ceiling policy.
            memory_high,
        }
    }

    /// Whether an operator explicitly requested enforcement. When true, missing
    /// cgroup support or a failed per-op setting must fail closed instead of
    /// silently granting unlimited resources.
    #[must_use]
    pub fn has_limits(self) -> bool {
        self.memory_max.is_some() || self.memory_high.is_some()
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

fn policy_enforcement_error(action: &str, source: &std::io::Error) -> std::io::Error {
    // A missing controller file/cgroup is a host containment capability failure,
    // not a missing command or request path. Normalize the I/O kind so the typed
    // platform layer does not publish a misleading `NotFound` wire error.
    std::io::Error::other(format!(
        "explicit operation memory policy could not {action}: {source}"
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
    /// Exact OS ceiling on unique supervisor-leaf PIDs observed during one spawn.
    /// Crossing it means an active fork pathology, not normal concurrency.
    placement_pid_breaker: usize,
    /// The next op-id; each `place_op` allocates a unique `op-<n>` sibling.
    next_op: AtomicU64,
    /// Guards the "log once" of the per-op placement fallback so a persistent
    /// degradation is reported exactly once, not per exec.
    fallback_logged: AtomicBool,
    /// Last explicit-policy snapshot reported. The next operation re-reads kernel
    /// leaf and ancestor state and logs only when desired/effective/external truth
    /// changed.
    policy_report: Mutex<Option<MemoryPolicyReport>>,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MemoryPolicyReport {
    desired_max: Option<u64>,
    desired_high: Option<u64>,
    local_max: Option<u64>,
    local_high: Option<u64>,
    leaf_max: Option<u64>,
    leaf_high: Option<u64>,
    external_max: Option<u64>,
    external_high: Option<u64>,
    effective_max: Option<u64>,
    effective_high: Option<u64>,
}

impl OpCgroups {
    /// Installs the pre-exec migration hook on one direct operation child. Opening
    /// `cgroup.procs` occurs in the parent; the post-fork hook performs only the
    /// async-signal-safe PID write. Explicit policy makes a migration failure a
    /// spawn failure before user code runs. The unrestricted path records the
    /// degradation and leaves the post-spawn verifier to attempt recovery.
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
                self.note_fallback(format_args!(
                    "cannot pre-open {} for atomic operation placement: {error}",
                    procs_path.display()
                ));
                return if prepared.policy_required {
                    Err(policy_enforcement_error(
                        "prepare atomic pre-exec cgroup placement",
                        &error,
                    ))
                } else {
                    Ok(())
                };
            }
        };
        opengeni_agent_linux_ffi::configure_process_cgroup_before_exec(
            command,
            procs,
            prepared.policy_required,
        );
        Ok(())
    }

    /// Stops an exec process group, verifies its direct roots in the prepared
    /// operation cgroup, then drains any same-group process still inherited in
    /// the supervisor leaf before resuming it.
    ///
    /// A `killpg(SIGSTOP)` return is not itself a barrier: delivery may still be
    /// pending on another CPU. Correctness therefore comes from the pre-exec
    /// migration and cgroup inheritance, not signal timing. The direct-root writes
    /// verify that migration and repair a best-effort write failure. The drain then
    /// catches a same-group process only when unrestricted execution had to use the
    /// compatibility path. The loop ends when no such live member remains; a
    /// repeated set means the kernel refused every repair, so the degradation is
    /// reported instead of spinning.
    #[cfg(target_os = "linux")]
    pub(crate) fn place_process_group(
        &self,
        pgid: i32,
        direct_pids: &[u32],
        prepared: PreparedOpCgroup,
    ) -> std::io::Result<OpCgroupHandle> {
        signal_process_group(pgid, nix::sys::signal::Signal::SIGSTOP)?;

        let PreparedOpCgroup {
            handle,
            policy_required,
        } = prepared;
        self.place_pids_in(
            handle
                .dir
                .as_deref()
                .expect("a live operation handle must own its cgroup path"),
            direct_pids,
            policy_required,
        )?;

        let mut prior_members: Option<Vec<u32>> = None;
        let mut observed_pids = HashSet::new();
        loop {
            let members = match self.supervisor_process_group_members(pgid) {
                Ok(members) => members,
                Err(error) => {
                    self.note_fallback(format_args!(
                        "cannot drain process-group {pgid} from the supervisor cgroup: {error}"
                    ));
                    if policy_required {
                        return Err(std::io::Error::other(format!(
                            "explicit operation memory policy could not verify process-group {pgid} containment: {error}"
                        )));
                    }
                    break;
                }
            };
            if members.is_empty() {
                break;
            }
            if prior_members.as_ref() == Some(&members) {
                self.note_fallback(format_args!(
                    "process-group {pgid} cgroup drain made no progress for pids {members:?}"
                ));
                if policy_required {
                    return Err(std::io::Error::other(format!(
                        "explicit operation memory policy could not contain process-group {pgid} members {members:?}"
                    )));
                }
                break;
            }
            prior_members = Some(members.clone());

            observed_pids.extend(members.iter().copied());
            if observed_pids.len() > self.placement_pid_breaker {
                let error = std::io::Error::other(format!(
                    "process-group {pgid} cgroup drain observed more unique PIDs than the host-derived ceiling of {} while containing an active fork storm",
                    self.placement_pid_breaker
                ));
                tracing::warn!(
                    group_id = pgid,
                    observed_pids = observed_pids.len(),
                    pending_pids = members.len(),
                    breaker = self.placement_pid_breaker,
                    "terminating exec whose pre-containment fork storm tripped the cgroup placement breaker"
                );
                let _ = signal_process_group(pgid, nix::sys::signal::Signal::SIGKILL);
                drop(handle);
                return Err(error);
            }

            // A descendant in this fallback path may have forked before the direct
            // child received its OOM bias. Re-stamp every discovered member; later
            // descendants inherit from their corrected parent after it moves.
            for pid in &members {
                raise_exec_oom_score_adj(*pid);
            }
            self.place_pids_in(
                handle
                    .dir
                    .as_deref()
                    .expect("a live operation handle must own its cgroup path"),
                &members,
                policy_required,
            )?;
            if let Err(error) = signal_process_group(pgid, nix::sys::signal::Signal::SIGSTOP) {
                let _ = signal_process_group(pgid, nix::sys::signal::Signal::SIGKILL);
                drop(handle);
                return Err(error);
            }
        }

        if let Err(error) = signal_process_group(pgid, nix::sys::signal::Signal::SIGCONT) {
            let _ = signal_process_group(pgid, nix::sys::signal::Signal::SIGKILL);
            drop(handle);
            return Err(error);
        }
        Ok(handle)
    }

    /// Enumerates live members of `pgid` that still inherit the supervisor leaf.
    #[cfg(target_os = "linux")]
    fn supervisor_process_group_members(&self, pgid: i32) -> std::io::Result<Vec<u32>> {
        let supervisor_procs = self.service_dir.join(SUPERVISOR_LEAF).join("cgroup.procs");
        let contents = std::fs::read_to_string(supervisor_procs)?;
        let mut members = Vec::new();
        for raw in contents.split_whitespace() {
            let Ok(member_pid) = raw.parse::<u32>() else {
                continue;
            };
            let Ok(member_raw_pid) = i32::try_from(member_pid) else {
                continue;
            };
            if nix::unistd::getpgid(Some(nix::unistd::Pid::from_raw(member_raw_pid)))
                .is_ok_and(|member_pgid| member_pgid.as_raw() == pgid)
            {
                members.push(member_pid);
            }
        }
        members.sort_unstable();
        members.dedup();
        Ok(members)
    }

    /// Creates and configures one fresh `op-<n>` leaf before any operation child
    /// is forked. The returned preparation owns the teardown handle and records
    /// whether every pre-exec/post-spawn placement step is policy-critical.
    ///
    /// With the unrestricted default, a placement failure degrades loudly and the
    /// operation retains the host's ambient behavior. When an operator explicitly
    /// configured a memory policy, every policy and live-PID placement write fails
    /// closed so the runner never presents an unenforced limit as effective.
    #[cfg(target_os = "linux")]
    pub(crate) fn prepare_op(
        &self,
        requested_config: OpCgroupConfig,
    ) -> std::io::Result<Option<PreparedOpCgroup>> {
        let applied_config = self.local_config.tightened_by(requested_config);
        let policy_required = applied_config.has_limits();
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
            self.note_fallback(format_args!(
                "cannot create op cgroup {}: {error}",
                dir.display()
            ));
            return if policy_required {
                Err(policy_enforcement_error(
                    "create the operation cgroup",
                    &error,
                ))
            } else {
                Ok(None)
            };
        }
        let handle = OpCgroupHandle {
            dir: Some(dir.clone()),
        };

        // If this leaf is selected by a memcg OOM, kill the complete operation
        // instead of leaving sibling descendants running with partial state.
        if let Err(error) = std::fs::write(dir.join("memory.oom.group"), "1") {
            self.note_fallback(format_args!(
                "cannot set memory.oom.group on {}: {error}",
                dir.display()
            ));
            if policy_required {
                return Err(policy_enforcement_error("set memory.oom.group", &error));
            }
        }

        // Optional per-op caps (default: unset). Explicit policy is fail-closed:
        // silently continuing would turn an operator's ceiling into unlimited work.
        if let Some(max) = applied_config.memory_max {
            if let Err(error) = std::fs::write(dir.join("memory.max"), max.to_string()) {
                self.note_fallback(format_args!(
                    "cannot set memory.max on {}: {error}",
                    dir.display()
                ));
                return Err(policy_enforcement_error("set memory.max", &error));
            }
        }
        if let Some(high) = applied_config.memory_high {
            if let Err(error) = std::fs::write(dir.join("memory.high"), high.to_string()) {
                self.note_fallback(format_args!(
                    "cannot set memory.high on {}: {error}",
                    dir.display()
                ));
                return Err(policy_enforcement_error("set memory.high", &error));
            }
        }

        if policy_required {
            self.report_memory_policy(&dir, requested_config)
                .map_err(|error| {
                    policy_enforcement_error(
                        "read back the effective operation memory policy",
                        &error,
                    )
                })?;
        }

        Ok(Some(PreparedOpCgroup {
            handle,
            policy_required,
        }))
    }

    /// Moves each live PID into an existing operation leaf. `cgroup.procs` moves
    /// the entire thread group and returns only after the migration is visible.
    #[cfg(target_os = "linux")]
    fn place_pids_in(
        &self,
        dir: &Path,
        pids: &[u32],
        policy_required: bool,
    ) -> std::io::Result<()> {
        let procs = dir.join("cgroup.procs");
        for pid in pids {
            if let Err(error) = std::fs::write(&procs, pid.to_string()) {
                // A direct child may complete between spawn and placement. With no
                // live process left at that PID there is no policy to enforce.
                if !Path::new(&format!("/proc/{pid}")).exists() {
                    continue;
                }
                self.note_fallback(format_args!(
                    "cannot place pid {pid} into {}: {error}",
                    dir.display()
                ));
                if policy_required {
                    return Err(policy_enforcement_error(
                        &format!("place live pid {pid} in the operation cgroup"),
                        &error,
                    ));
                }
            }
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn report_memory_policy(
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
        let external_max = tightest_ancestor_limit(op_dir, "memory.max")?;
        let external_high = tightest_ancestor_limit(op_dir, "memory.high")?;
        let effective_max = tighter_limit(leaf_max, external_max);
        let effective_high = tighter_limit(tighter_limit(leaf_high, external_high), effective_max);
        let report = MemoryPolicyReport {
            desired_max: requested_config.memory_max,
            desired_high: requested_config.memory_high,
            local_max: self.local_config.memory_max,
            local_high: self.local_config.memory_high,
            leaf_max,
            leaf_high,
            external_max,
            external_high,
            effective_max,
            effective_high,
        };
        let mut prior = self
            .policy_report
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if prior.as_ref() != Some(&report) {
            tracing::info!(
                desired_memory_max = ?report.desired_max,
                desired_memory_high = ?report.desired_high,
                local_memory_max = ?report.local_max,
                local_memory_high = ?report.local_high,
                leaf_memory_max = ?report.leaf_max,
                leaf_memory_high = ?report.leaf_high,
                external_memory_max = ?report.external_max,
                external_memory_high = ?report.external_high,
                effective_memory_max = ?report.effective_max,
                effective_memory_high = ?report.effective_high,
                "effective operation memory policy changed"
            );
            *prior = Some(report);
        }
        Ok(())
    }

    /// Non-Linux no-op: no manager is ever constructed off Linux, so this is never
    /// reached; it exists so the cross-platform exec path type-checks.
    #[cfg(not(target_os = "linux"))]
    #[allow(clippy::unused_self)]
    pub(crate) fn place_op(
        &self,
        _pids: &[u32],
        _requested_config: OpCgroupConfig,
    ) -> std::io::Result<Option<OpCgroupHandle>> {
        Ok(None)
    }

    /// Logs the per-op placement fallback reason exactly once (a persistent
    /// degradation must not spam a line per exec).
    #[cfg(target_os = "linux")]
    fn note_fallback(&self, reason: std::fmt::Arguments<'_>) {
        if !self.fallback_logged.swap(true, Ordering::Relaxed) {
            tracing::warn!(
                %reason,
                "per-op OOM containment partially degraded; continuing to serve (logged once)"
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
    policy_required: bool,
}

/// A handle to one placed `op-<n>` leaf, responsible for removing it once the op's
/// process tree is reaped.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) struct OpCgroupHandle {
    /// The op leaf's absolute path.
    dir: Option<PathBuf>,
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
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            tracing::warn!(
                dir = %dir.display(),
                "cannot schedule operation-cgroup cleanup outside the agent runtime"
            );
            return;
        };
        runtime.spawn(async move {
            if let Err(error) = remove_op_cgroup(&dir).await {
                tracing::warn!(
                    dir = %dir.display(),
                    %error,
                    "failed to remove a runner-owned operation cgroup after task cancellation"
                );
            }
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
    let (enabled_controllers, unavailable_controllers) = establish_delegated_subtree(&startup)?;
    let Some(placement_pid_breaker) = placement_pid_breaker(&startup.service_dir) else {
        tracing::warn!(
            service_cgroup = %startup.service_dir.display(),
            "OOM cgroup isolation unavailable: cannot read a delegated, process, or PID-namespace ceiling for bounded pre-containment placement"
        );
        return None;
    };
    tracing::info!(
        service_cgroup = %startup.service_dir.display(),
        ?enabled_controllers,
        ?unavailable_controllers,
        memory_max = ?config.memory_max,
        memory_high = ?config.memory_high,
        placement_pid_breaker,
        stale_operations_cleanup_scheduled = startup.stale_op_cgroups.len(),
        "established per-op cgroups: host execs have separate resource accounting and systemd-oomd fate; no controller limit was added implicitly and kernel OOM selection remains score-based"
    );
    Some(Arc::new(OpCgroups {
        service_dir: startup.service_dir,
        local_config: config,
        placement_pid_breaker,
        next_op: AtomicU64::new(startup.next_op),
        fallback_logged: AtomicBool::new(false),
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
) -> Option<(Vec<&'static str>, Vec<&'static str>)> {
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

    Some((enabled_controllers, unavailable_controllers))
}

/// Non-Linux no-op: per-op cgroup isolation is a Linux cgroup v2 feature. Returns
/// `None` so the agent runs unchanged on macOS/Windows.
#[cfg(not(target_os = "linux"))]
#[must_use]
pub fn establish_oom_isolation(_config: OpCgroupConfig) -> Option<Arc<OpCgroups>> {
    tracing::debug!("per-op OOM cgroup isolation is Linux-only; running without it on this OS");
    None
}

/// Signals an owned process group. ESRCH is success: the group completed before
/// the placement barrier and has nothing left to isolate or resume.
#[cfg(target_os = "linux")]
fn signal_process_group(pgid: i32, signal: nix::sys::signal::Signal) -> std::io::Result<()> {
    use nix::errno::Errno;
    use nix::sys::signal::killpg;
    use nix::unistd::Pid;

    match killpg(Pid::from_raw(pgid), signal) {
        Ok(()) | Err(Errno::ESRCH) => Ok(()),
        Err(error) => Err(std::io::Error::from(error)),
    }
}

/// Derives a one-spawn fork-pathology breaker from the delegated service's PID
/// ceiling, then the user's process rlimit, then the PID namespace ceiling. The
/// exact first authoritative OS ceiling is used: containment does not invent a
/// smaller reserve or operation limit. This breaker limits only the synchronous
/// pre-containment drain; it does not limit a successfully-contained command's
/// lifetime or eventual process count.
#[cfg(target_os = "linux")]
fn placement_pid_breaker(service_dir: &Path) -> Option<usize> {
    let cgroup_ceiling = std::fs::read_to_string(service_dir.join("pids.max"))
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok());
    let rlimit_ceiling = std::fs::read_to_string("/proc/self/limits")
        .ok()
        .and_then(|limits| parse_soft_process_limit(&limits));
    let namespace_ceiling = std::fs::read_to_string("/proc/sys/kernel/pid_max")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok());
    derive_placement_pid_breaker(cgroup_ceiling.or(rlimit_ceiling).or(namespace_ceiling))
}

/// Converts a known positive OS PID ceiling to the host word size. An absent or
/// zero ceiling disables containment explicitly rather than inventing a fallback.
#[cfg(target_os = "linux")]
fn derive_placement_pid_breaker(pid_ceiling: Option<u64>) -> Option<usize> {
    pid_ceiling
        .filter(|ceiling| *ceiling > 0)
        .map(|ceiling| usize::try_from(ceiling).unwrap_or(usize::MAX))
}

/// Parses the soft `RLIMIT_NPROC` value from `/proc/self/limits`; `unlimited`
/// deliberately falls through to the kernel PID namespace ceiling.
#[cfg(target_os = "linux")]
fn parse_soft_process_limit(limits: &str) -> Option<u64> {
    let value = limits
        .lines()
        .find_map(|line| line.strip_prefix("Max processes"))?
        .split_whitespace()
        .next()?;
    (value != "unlimited").then(|| value.parse().ok()).flatten()
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

/// Combines two cgroup limits: unlimited yields to finite and two finite ceilings
/// resolve to the tighter value.
fn tighter_limit(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

/// Enables the delegated controller subset used for per-operation accounting.
/// Memory is the fate-isolation prerequisite and therefore errors out; the other
/// accounting controllers degrade independently and are reported as unavailable.
#[cfg(target_os = "linux")]
fn enable_op_accounting_controllers(
    service_dir: &Path,
    available: &str,
) -> std::io::Result<(Vec<&'static str>, Vec<&'static str>)> {
    let mut enabled = Vec::new();
    let mut unavailable = Vec::new();
    for controller in OP_ACCOUNTING_CONTROLLERS {
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

// --- oom_score_adj: bias the kernel OOM killer toward host work ----------------

/// The `oom_score_adj` stamped on every exec child. A positive bias makes the
/// kernel's GLOBAL OOM killer sacrifice a runaway child (and its descendants,
/// which inherit the value on fork) before the supervisor, whose effective bias
/// is reported separately. Raising the value is unprivileged-legal; 500 is a strong
/// bias without pinning the child as the unconditional first victim.
#[cfg(target_os = "linux")]
const EXEC_OOM_SCORE_ADJ: i32 = 500;

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
            "control supervisor has neutral kernel OOM victim bias"
        ),
        Some(score) => tracing::warn!(
            oom_score_adj = score,
            "control supervisor has positive kernel OOM victim bias; delegated cgroups do not protect it from host-wide kernel OOM"
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
pub(crate) fn configure_exec_oom_score_adj_before_exec(command: &mut tokio::process::Command) {
    opengeni_agent_linux_ffi::configure_oom_score_adj_before_exec(command);
}

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
            tracing::warn!(
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
            .contains("explicit operation memory policy could not read back memory.max"));
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

    #[cfg(target_os = "linux")]
    #[test]
    fn placement_pid_breaker_uses_the_exact_host_ceiling() {
        assert_eq!(derive_placement_pid_breaker(Some(28_708)), Some(28_708));
        assert_eq!(derive_placement_pid_breaker(Some(1)), Some(1));
        assert_eq!(derive_placement_pid_breaker(Some(0)), None);
        assert_eq!(derive_placement_pid_breaker(None), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parses_finite_process_rlimit_and_skips_unlimited() {
        let finite = "Limit                     Soft Limit           Hard Limit           Units\n\
                      Max processes             95695                95695                processes\n";
        assert_eq!(parse_soft_process_limit(finite), Some(95_695));

        let unlimited = "Limit                     Soft Limit           Hard Limit           Units\n\
                         Max processes             unlimited            unlimited            processes\n";
        assert_eq!(parse_soft_process_limit(unlimited), None);
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
        let unset = OpCgroupConfig::from_env().expect("unset policy is valid");
        assert_eq!(unset.memory_max, None);
        assert_eq!(unset.memory_high, None);

        std::env::set_var(OP_MEMORY_MAX_ENV, "1073741824");
        std::env::set_var(OP_MEMORY_HIGH_ENV, "0"); // zero is "unset"
        let cfg = OpCgroupConfig::from_env().expect("numeric policy is valid");
        assert_eq!(cfg.memory_max, Some(1_073_741_824));
        assert_eq!(cfg.memory_high, None, "zero disables the limit");

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
    }

    #[test]
    fn per_connection_policy_can_only_tighten_local_policy() {
        let local = OpCgroupConfig::from_limits(Some(1_073_741_824), Some(805_306_368))
            .expect("local policy");
        let requested =
            OpCgroupConfig::from_limits(Some(536_870_912), None).expect("requested policy");
        assert_eq!(
            local.tightened_by(requested),
            OpCgroupConfig {
                memory_max: Some(536_870_912),
                memory_high: Some(536_870_912),
            }
        );

        let unlimited = OpCgroupConfig::default();
        assert_eq!(unlimited.tightened_by(unlimited), unlimited);
    }

    #[test]
    fn wire_policy_rejects_zero_and_an_impossible_order() {
        assert_eq!(
            OpCgroupConfig::from_limits(Some(0), None),
            Err(OpCgroupConfigError::ZeroByteCount {
                setting: "memory.max",
            })
        );
        assert_eq!(
            OpCgroupConfig::from_limits(Some(1024), Some(2048)),
            Err(OpCgroupConfigError::MemoryHighExceedsMax {
                high: 2048,
                max: 1024,
            })
        );
    }

    #[test]
    fn hard_ceiling_does_not_invent_a_soft_throttle() {
        let local = OpCgroupConfig::default();
        let requested =
            OpCgroupConfig::from_limits(Some(536_870_912), None).expect("requested policy");
        assert_eq!(
            local.tightened_by(requested),
            OpCgroupConfig {
                memory_max: Some(536_870_912),
                memory_high: None,
            }
        );
    }
}
