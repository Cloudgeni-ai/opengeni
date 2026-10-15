//! The always-on service manager used by the ordinary post-connect `start` flow.
//!
//! `opengeni-agent run` remains the explicit foreground mode. This module is the
//! cross-platform service mechanism behind one [`ServiceManager`] trait so the
//! behavior is cargo-unit-tested ONCE, not duplicated in three shell dialects.
//!
//! Per-OS impls:
//!   * **Linux** — a systemd USER unit (`~/.config/systemd/user/opengeni-agent.service`,
//!     `Restart=always`, `WantedBy=default.target`) installed with `systemctl
//!     --user enable --now` + `loginctl enable-linger` so it survives logout WITHOUT
//!     root. A `--system` unit (`/etc/systemd/system`, needs root) is the headless
//!     fallback. The unit-file generation is PURE + testable; a `--print` mode dumps
//!     it without touching the system. **This is the concrete, testable path.**
//!   * **macOS** — a per-user LaunchAgent plist (`~/Library/LaunchAgents/
//!     ai.opengeni.agent.plist`, `RunAtLoad`+`KeepAlive`). LaunchAgent NOT
//!     LaunchDaemon deliberately: desktop/computer-use needs the user's GUI Aqua
//!     session + TCC. Structured + compiling; the plist generation is pure + tested.
//!   * **Windows** — a per-user Task Scheduler task (`Opengeni Agent`) that starts
//!     at logon in the user's own desktop session, NOT a Windows Service:
//!     services run in session 0, where screenshots, input and the user's browser
//!     are out of reach, and registering one needs elevation. The task runs the
//!     agent inside a headless console host (no window), a one-minute repetition
//!     restarts it if it ever exits, and pausing disables the task. Registering
//!     it needs no elevation. The task XML is generated + tested.
//!
//! The coarse outer restart loop (the service manager) sits ABOVE the in-process
//! full-jitter backoff (the fine loop) — two independent layers of resiliency.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::error::{PlatformError, PlatformResult};

/// Which OS service backend to target. Resolved from the compile-time target by
/// [`ServiceSpec::for_host`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceBackend {
    /// systemd (Linux).
    Systemd,
    /// launchd (macOS).
    Launchd,
    /// a per-user logon task in the Windows Task Scheduler.
    WindowsTask,
    /// no supported service manager on this target.
    Unsupported,
}

/// The scope a Linux systemd unit is installed at: a per-user unit (no root) or a
/// system unit (root, for headless servers with no logind session).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceScope {
    /// A per-user unit (`systemctl --user`, no root). The default.
    User,
    /// A system-wide unit (`/etc/systemd/system`, needs root).
    System,
}

/// The inputs needed to render a per-OS service definition: the absolute path to
/// the installed binary, the run arguments, and the scope.
#[derive(Debug, Clone)]
pub struct ServiceSpec {
    /// The absolute path to the `opengeni-agent` binary the service runs (a service
    /// uses an ABSOLUTE path so it runs regardless of the user's PATH).
    pub binary_path: PathBuf,
    /// The arguments passed to the binary (e.g. `["run"]`).
    pub args: Vec<String>,
    /// The install scope (Linux only; ignored elsewhere).
    pub scope: ServiceScope,
    /// Command lookup path inherited from the interactive installer. Service
    /// managers commonly provide a much narrower default (notably on NixOS),
    /// which would make otherwise valid connected-machine commands disappear.
    pub environment_path: Option<String>,
}

impl ServiceSpec {
    /// A spec for the host's default service backend running `opengeni-agent run`
    /// at the user scope.
    #[must_use]
    pub fn for_host(binary_path: impl Into<PathBuf>) -> Self {
        Self {
            binary_path: binary_path.into(),
            args: vec!["run".to_string()],
            scope: ServiceScope::User,
            environment_path: std::env::var("PATH").ok().filter(|value| !value.is_empty()),
        }
    }

    /// The service backend for the compile-time target.
    #[must_use]
    pub fn backend() -> ServiceBackend {
        #[cfg(target_os = "linux")]
        {
            ServiceBackend::Systemd
        }
        #[cfg(target_os = "macos")]
        {
            ServiceBackend::Launchd
        }
        #[cfg(target_os = "windows")]
        {
            ServiceBackend::WindowsTask
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        {
            ServiceBackend::Unsupported
        }
    }
}

/// The canonical service identifiers (shared across OSes for consistency).
pub mod ids {
    /// The systemd unit name (Linux).
    pub const SYSTEMD_UNIT: &str = "opengeni-agent.service";
    /// The launchd label (macOS) + the plist file stem.
    pub const LAUNCHD_LABEL: &str = "ai.opengeni.agent";
    /// The per-user Task Scheduler task (Windows).
    pub const WINDOWS_TASK: &str = "Opengeni Agent";
    /// The Windows Service earlier releases registered. It could never start (the
    /// binary does not host the service control dispatcher), so `start` removes
    /// it when it finds it.
    pub const LEGACY_WINDOWS_SERVICE: &str = "OpengeniAgent";
}

/// Renders the systemd unit-file body for `spec`. PURE (no IO) so it is fully
/// unit-tested; `service install` writes this to the unit path and the `--print`
/// mode dumps it.
#[must_use]
pub fn render_systemd_unit(spec: &ServiceSpec) -> String {
    render_systemd_unit_with_browser_shutdown(spec, true)
}

/// Exact v2 generated unit, retained solely for ownership-checked migration.
#[doc(hidden)]
#[must_use]
pub fn render_legacy_systemd_unit_before_browser_shutdown(spec: &ServiceSpec) -> String {
    render_systemd_unit_with_browser_shutdown(spec, false)
}

/// Shutdown-safe definition for managers predating DelegateSubgroup.
#[must_use]
pub fn render_systemd_unit_without_supervisor_subgroup(spec: &ServiceSpec) -> String {
    let legacy = render_legacy_systemd_unit_before_supervisor_subgroup(spec);
    format!("# X-OpenGeni-Managed-Service=v3-compatible\n{}", legacy.replace(
        "# A clean stop sends SIGTERM so the agent emits its going-offline message.\nKillSignal=SIGTERM\nTimeoutStopSec=15\n",
        COORDINATED_BROWSER_SHUTDOWN,
    ))
}

const COORDINATED_BROWSER_SHUTDOWN: &str = "# Signal only the supervisor; it cooperatively closes its browser sidecars.\nKillMode=mixed\nKillSignal=SIGTERM\nTimeoutStopSec=90\n";

/// Browserd owns a 30-second graceful close followed by exact daemon/browser
/// termination. Scopes drain concurrently within this process-wide budget.
pub const BROWSER_SIDECAR_SHUTDOWN_TIMEOUT_SECS: u64 = 60;

fn render_systemd_unit_with_browser_shutdown(spec: &ServiceSpec, coordinated: bool) -> String {
    let version = if coordinated { "v3" } else { "v2" };
    let shutdown = if coordinated {
        COORDINATED_BROWSER_SHUTDOWN
    } else {
        "# A clean stop sends SIGTERM so the agent emits its going-offline message.\nKillSignal=SIGTERM\nTimeoutStopSec=15\n"
    };
    let exec = exec_line(&spec.binary_path, &spec.args);
    let path = spec
        .environment_path
        .as_deref()
        .map(|value| format!("Environment=\"PATH={}\"\n", systemd_escape(value)))
        .unwrap_or_default();
    let wanted_by = match spec.scope {
        ServiceScope::User => "default.target",
        ServiceScope::System => "multi-user.target",
    };
    format!(
        "# X-OpenGeni-Managed-Service={version}\n\
         # Generated by opengeni-agent; use a drop-in for operator policy.\n\
         [Unit]\n\
         Description=Opengeni self-hosted agent\n\
         Documentation=https://get.opengeni.ai\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         # Don't hammer on a crash-loop; the in-process backoff is the fine loop.\n\
         StartLimitIntervalSec=60\n\
         StartLimitBurst=5\n\
         \n\
         [Service]\n\
         Type=simple\n\
         {path}\
         ExecStart={exec}\n\
         Restart=always\n\
         RestartSec=5\n\
         # Keep the tiny control supervisor behind ordinary host work in the\n\
         # kernel's global OOM victim order. An unprivileged user manager may\n\
         # clamp this to its own inherited floor; startup reports the effective\n\
         # /proc value instead of assuming the request took effect.\n\
         OOMScoreAdjust=-100\n\
         # An OOM-killed command child must not make systemd stop the surviving\n\
         # supervisor. If the main process is killed, Restart=always recovers it.\n\
         OOMPolicy=continue\n\
         {shutdown}\
         # OOM containment (issue #345). Delegate a cgroup subtree so the agent can\n\
         # place each host exec in its own resource-accounting sub-cgroup (see\n\
         # cgroup.rs). This separates accounting/systemd-oomd domains; global kernel\n\
         # OOM selection is\n\
         # governed separately by the supervisor/child OOMScoreAdjust values above.\n\
         # ManagedOOMPreference=avoid biases systemd-oomd away from selecting this unit.\n\
         # Delegate exactly CPU and memory. I/O and PID are intentionally omitted\n\
         # until an explicit policy needs them, because enabling hierarchical\n\
         # control can change host behavior even without a numeric limit. Commands retain the\n\
         # machine's full available memory unless an operator explicitly configures\n\
         # a per-operation limit. Linux-only directives;\n\
         # they are inert on the macOS/Windows service backends.\n\
         Delegate=cpu memory\n\
         # Keep the service root empty even across a supervisor crash. cgroup v2\n\
         # cannot start a replacement process in a root whose controllers are\n\
         # enabled for operation children; systemd must place every generation\n\
         # directly in the stable supervisor leaf.\n\
         DelegateSubgroup=supervisor\n\
         ManagedOOMPreference=avoid\n\
         MemoryAccounting=yes\n\
         # The service aggregate is intentionally unrestricted. Optional machine\n\
         # policy is applied to command leaves, never to the control supervisor.\n\
         MemoryHigh=infinity\n\
         MemoryMax=infinity\n\
         TasksMax=infinity\n\
         \n\
         [Install]\n\
         WantedBy={wanted_by}\n"
    )
}

/// Renders the exact manager-owned Linux unit emitted immediately before the
/// stable `DelegateSubgroup=supervisor` topology existed. It is retained only as
/// a byte-for-byte ownership proof for the one-time self-update migration; new
/// installs must use [`render_systemd_unit`].
#[doc(hidden)]
#[must_use]
pub fn render_legacy_systemd_unit_before_supervisor_subgroup(spec: &ServiceSpec) -> String {
    let exec = exec_line(&spec.binary_path, &spec.args);
    let path = spec
        .environment_path
        .as_deref()
        .map(|value| format!("Environment=\"PATH={}\"\n", systemd_escape(value)))
        .unwrap_or_default();
    let wanted_by = match spec.scope {
        ServiceScope::User => "default.target",
        ServiceScope::System => "multi-user.target",
    };
    format!(
        "[Unit]\n\
         Description=Opengeni self-hosted agent\n\
         Documentation=https://get.opengeni.ai\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         # Don't hammer on a crash-loop; the in-process backoff is the fine loop.\n\
         StartLimitIntervalSec=60\n\
         StartLimitBurst=5\n\
         \n\
         [Service]\n\
         Type=simple\n\
         {path}\
         ExecStart={exec}\n\
         Restart=always\n\
         RestartSec=5\n\
         # Keep the tiny control supervisor behind ordinary host work in the\n\
         # kernel's global OOM victim order. An unprivileged user manager may\n\
         # clamp this to its own inherited floor; startup reports the effective\n\
         # /proc value instead of assuming the request took effect.\n\
         OOMScoreAdjust=-100\n\
         # An OOM-killed command child must not make systemd stop the surviving\n\
         # supervisor. If the main process is killed, Restart=always recovers it.\n\
         OOMPolicy=continue\n\
         # A clean stop sends SIGTERM so the agent emits its going-offline message.\n\
         KillSignal=SIGTERM\n\
         TimeoutStopSec=15\n\
         # OOM containment (issue #345). Delegate a cgroup subtree so the agent can\n\
         # place each host exec in its own memory sub-cgroup (see cgroup.rs). This\n\
         # separates accounting/systemd-oomd domains; global kernel OOM selection is\n\
         # governed separately by the supervisor/child OOMScoreAdjust values above.\n\
         # ManagedOOMPreference=avoid biases systemd-oomd away from selecting this unit\n\
         # for a whole-unit kill. MemoryAccounting enables the delegated memory\n\
         # controller without imposing a unit-wide throttle: commands retain the\n\
         # machine's full available memory unless an operator explicitly configures\n\
         # a per-operation limit. Linux-only directives;\n\
         # they are inert on the macOS/Windows service backends.\n\
         Delegate=yes\n\
         ManagedOOMPreference=avoid\n\
         MemoryAccounting=yes\n\
         # The service aggregate is intentionally unrestricted. Optional machine\n\
         # policy is applied to command leaves, never to the control supervisor.\n\
         MemoryHigh=infinity\n\
         MemoryMax=infinity\n\
         TasksMax=infinity\n\
         \n\
         [Install]\n\
         WantedBy={wanted_by}\n"
    )
}

/// Resolve the home used by service installation and dry-run rendering.
///
/// # Errors
///
/// Returns an OS error when neither HOME nor USERPROFILE is configured.
pub fn service_user_home() -> PlatformResult<PathBuf> {
    service_user_home_from_environment(std::env::var_os("HOME"), std::env::var_os("USERPROFILE"))
}

fn service_user_home_from_environment(
    home: Option<OsString>,
    userprofile: Option<OsString>,
) -> PlatformResult<PathBuf> {
    home.or(userprofile)
        .map(PathBuf::from)
        .ok_or_else(|| PlatformError::os("could not resolve a home directory ($HOME/$USERPROFILE)"))
}

/// Environment switch for a service manager that captures the agent's stderr
/// itself: `off` keeps `tracing` output only in the agent's own bounded log.
pub const AGENT_STDERR_LOG_ENV: &str = "OPENGENI_AGENT_STDERR_LOG";

/// The file launchd appends the agent's stdout and stderr to. It sits in the
/// agent's default config directory (`~/.config/opengeni/agent`, which is what a
/// LaunchAgent without `$XDG_CONFIG_HOME` resolves) beside the agent's own log,
/// which also bounds its size at startup. Without it launchd discards a crashed
/// agent's last words.
#[must_use]
pub fn launchd_stderr_log_path(user_home: &Path) -> PathBuf {
    user_home
        .join(".config")
        .join("opengeni")
        .join("agent")
        .join("logs")
        .join("agent.stderr.log")
}

/// Renders the macOS LaunchAgent plist body for `spec`. PURE + tested.
/// The user home is explicit: launchd otherwise starts in `/`, which is read-only
/// on macOS and cannot hold session attachments. Never inherit the installer's
/// cwd (it can itself be an older launchd process during an update).
///
/// # Errors
///
/// Returns an OS error if the supplied home is not an absolute non-root path,
/// or contains characters unsuitable for XML or launchctl line-oriented output.
pub fn render_launchd_plist(spec: &ServiceSpec, user_home: &Path) -> PlatformResult<String> {
    // This pure renderer is also tested on Windows; validate macOS/POSIX syntax
    // rather than the build host's interpretation of an absolute path.
    let user_home = user_home
        .to_str()
        .ok_or_else(|| PlatformError::os("LaunchAgent user home must be a UTF-8 path"))?;
    if !user_home.starts_with('/')
        || user_home
            .split('/')
            .all(|part| part.is_empty() || part == ".")
        || user_home.split('/').any(|part| part == "..")
        || user_home
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '\u{fffe}' | '\u{ffff}'))
    {
        return Err(PlatformError::os(
            "LaunchAgent working directory requires an absolute non-root user home without control or XML-invalid characters",
        ));
    }
    let mut args = vec![spec.binary_path.to_string_lossy().into_owned()];
    args.extend(spec.args.iter().cloned());
    let program_args = args
        .iter()
        .map(|a| format!("    <string>{}</string>", xml_escape(a)))
        .collect::<Vec<_>>()
        .join("\n");
    let path = spec
        .environment_path
        .as_deref()
        .map(|value| {
            format!(
                "    <key>PATH</key>\n    <string>{}</string>\n",
                xml_escape(value)
            )
        })
        .unwrap_or_default();
    // The agent writes its own bounded log; launchd's capture keeps only output
    // that bypasses it (panics during abort, allocator failures, raw prints).
    let environment = format!(
        "  <key>EnvironmentVariables</key>\n  <dict>\n{path}    <key>{AGENT_STDERR_LOG_ENV}</key>\n    <string>off</string>\n  </dict>\n"
    );
    // Joined as a POSIX path on every build host, like the home it extends.
    let stderr_log = xml_escape(&format!(
        "{}/.config/opengeni/agent/logs/agent.stderr.log",
        user_home.trim_end_matches('/')
    ));
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \x20 <key>Label</key>\n\
         \x20 <string>{label}</string>\n\
         \x20 <key>ProgramArguments</key>\n\
         \x20 <array>\n\
         {program_args}\n\
         \x20 </array>\n\
         {environment}\
         \x20 <key>WorkingDirectory</key>\n\
         \x20 <string>{working_directory}</string>\n\
         \x20 <key>RunAtLoad</key>\n\
         \x20 <true/>\n\
         \x20 <key>KeepAlive</key>\n\
         \x20 <true/>\n\
         \x20 <key>ThrottleInterval</key>\n\
         \x20 <integer>5</integer>\n\
         \x20 <key>StandardOutPath</key>\n\
         \x20 <string>{stderr_log}</string>\n\
         \x20 <key>StandardErrorPath</key>\n\
         \x20 <string>{stderr_log}</string>\n\
         </dict>\n\
         </plist>\n",
        label = ids::LAUNCHD_LABEL,
        program_args = program_args,
        working_directory = xml_escape(user_home),
    ))
}

/// The account and folders a Windows logon task is rendered for.
#[derive(Debug, Clone)]
pub struct WindowsTaskHost {
    /// The security identifier of the user the task runs as (`S-1-5-21-…`). A SID
    /// rather than `DOMAIN\name`, which is ambiguous outside a desktop logon.
    pub user_sid: String,
    /// The user's profile folder, the agent's working directory.
    pub user_home: PathBuf,
    /// `%SystemRoot%`, where the console host lives.
    pub system_root: PathBuf,
}

/// Checks the SID and paths a task definition embeds, returning the trimmed SID.
fn validate_windows_task_inputs<'a>(
    spec: &ServiceSpec,
    host: &'a WindowsTaskHost,
) -> PlatformResult<&'a str> {
    let sid = host.user_sid.trim();
    let well_formed_sid = sid.starts_with("S-1-")
        && sid.len() > 4
        && sid[4..]
            .split('-')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()));
    if !well_formed_sid {
        return Err(PlatformError::os(format!(
            "not a Windows user SID: {sid:?}"
        )));
    }
    let windows_absolute = |path: &Path| {
        let text = path.to_string_lossy();
        let bytes = text.as_bytes();
        (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/'))
            || text.starts_with("\\\\")
    };
    for (label, path) in [
        ("agent binary", spec.binary_path.as_path()),
        ("user home", host.user_home.as_path()),
        ("system root", host.system_root.as_path()),
    ] {
        if !windows_absolute(path) {
            return Err(PlatformError::os(format!(
                "the {label} must be an absolute Windows path: {}",
                path.display()
            )));
        }
    }
    Ok(sid)
}

/// Renders the Task Scheduler definition for the per-user Windows agent. PURE +
/// tested; `service install --print` shows it.
///
/// * It runs as the user with their interactive token, in their desktop session,
///   so computer use and the user's browser work, and needs no elevation.
/// * `conhost.exe --headless` gives the agent and every command it runs one
///   hidden console, so nothing flashes on screen.
/// * A logon trigger starts it at sign-in; a one-minute repetition starts it
///   again if it ever exits (a running instance makes the repetition a no-op).
///   Task Scheduler's own restart-on-failure only covers launch failures, not a
///   process that exits, so the repetition is the restart loop.
/// * No execution time limit (the default stops a task after three days), normal
///   priority (the default is below normal), and battery power never stops it.
///
/// # Errors
///
/// Returns an OS error for a malformed SID or a relative path.
pub fn render_windows_task_xml(
    spec: &ServiceSpec,
    host: &WindowsTaskHost,
) -> PlatformResult<String> {
    let sid = validate_windows_task_inputs(spec, host)?;
    let console_host = format!(
        "{}\\System32\\conhost.exe",
        host.system_root
            .to_string_lossy()
            .trim_end_matches(['\\', '/'])
    );
    let mut arguments = format!(
        "--headless \"{}\"",
        without_verbatim_prefix(&spec.binary_path.to_string_lossy())
    );
    for arg in &spec.args {
        arguments.push(' ');
        arguments.push_str(arg);
    }
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n\
         <Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n\
         \x20 <RegistrationInfo>\n\
         \x20   <Author>Opengeni</Author>\n\
         \x20   <Description>Keeps the Opengeni agent running while you are signed in, so agents you allow can use this computer. Pause or remove it with opengeni-agent stop or opengeni-agent uninstall.</Description>\n\
         \x20 </RegistrationInfo>\n\
         \x20 <Triggers>\n\
         \x20   <LogonTrigger>\n\
         \x20     <Enabled>true</Enabled>\n\
         \x20     <UserId>{sid}</UserId>\n\
         \x20   </LogonTrigger>\n\
         \x20   <TimeTrigger>\n\
         \x20     <Enabled>true</Enabled>\n\
         \x20     <StartBoundary>2000-01-01T00:00:00</StartBoundary>\n\
         \x20     <Repetition>\n\
         \x20       <Interval>PT1M</Interval>\n\
         \x20       <StopAtDurationEnd>false</StopAtDurationEnd>\n\
         \x20     </Repetition>\n\
         \x20   </TimeTrigger>\n\
         \x20 </Triggers>\n\
         \x20 <Principals>\n\
         \x20   <Principal id=\"Author\">\n\
         \x20     <UserId>{sid}</UserId>\n\
         \x20     <LogonType>InteractiveToken</LogonType>\n\
         \x20     <RunLevel>LeastPrivilege</RunLevel>\n\
         \x20   </Principal>\n\
         \x20 </Principals>\n\
         \x20 <Settings>\n\
         \x20   <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n\
         \x20   <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n\
         \x20   <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n\
         \x20   <AllowHardTerminate>true</AllowHardTerminate>\n\
         \x20   <StartWhenAvailable>false</StartWhenAvailable>\n\
         \x20   <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\n\
         \x20   <IdleSettings>\n\
         \x20     <StopOnIdleEnd>false</StopOnIdleEnd>\n\
         \x20     <RestartOnIdle>false</RestartOnIdle>\n\
         \x20   </IdleSettings>\n\
         \x20   <AllowStartOnDemand>true</AllowStartOnDemand>\n\
         \x20   <Enabled>true</Enabled>\n\
         \x20   <Hidden>false</Hidden>\n\
         \x20   <RunOnlyIfIdle>false</RunOnlyIfIdle>\n\
         \x20   <WakeToRun>false</WakeToRun>\n\
         \x20   <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\n\
         \x20   <Priority>5</Priority>\n\
         \x20 </Settings>\n\
         \x20 <Actions Context=\"Author\">\n\
         \x20   <Exec>\n\
         \x20     <Command>{command}</Command>\n\
         \x20     <Arguments>{arguments}</Arguments>\n\
         \x20     <WorkingDirectory>{working_directory}</WorkingDirectory>\n\
         \x20   </Exec>\n\
         \x20 </Actions>\n\
         </Task>\n",
        command = xml_escape(&console_host),
        arguments = xml_escape(&arguments),
        working_directory = xml_escape(&without_verbatim_prefix(
            &host.user_home.to_string_lossy()
        )),
    ))
}

/// `canonicalize` on Windows returns `\\?\C:\…` paths; the plain form is what a
/// user sees in Task Scheduler and what every program accepts as argv[0].
fn without_verbatim_prefix(path: &str) -> String {
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    match path.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.to_string(),
        _ => path.to_string(),
    }
}

/// The systemd unit path for a scope.
#[must_use]
pub fn systemd_unit_path(scope: ServiceScope, home: &std::path::Path) -> PathBuf {
    match scope {
        ServiceScope::User => systemd_user_unit_path(home),
        ServiceScope::System => systemd_system_unit_path(),
    }
}

/// Returns the per-user systemd unit path.
#[must_use]
pub fn systemd_user_unit_path(home: &std::path::Path) -> PathBuf {
    home.join(".config/systemd/user").join(ids::SYSTEMD_UNIT)
}

/// Returns the system-wide systemd unit path without requiring a home directory.
#[must_use]
pub fn systemd_system_unit_path() -> PathBuf {
    PathBuf::from("/etc/systemd/system").join(ids::SYSTEMD_UNIT)
}

/// The macOS LaunchAgent plist path.
#[must_use]
pub fn launchd_plist_path(home: &std::path::Path) -> PathBuf {
    home.join("Library/LaunchAgents")
        .join(format!("{}.plist", ids::LAUNCHD_LABEL))
}

/// Builds an `ExecStart=`-style line: the absolute binary path followed by its
/// args, each space-joined (systemd splits on whitespace; our args have none).
fn exec_line(binary: &std::path::Path, args: &[String]) -> String {
    let mut parts = vec![binary.to_string_lossy().into_owned()];
    parts.extend(args.iter().cloned());
    parts.join(" ")
}

/// Minimal XML escaping for the plist string values.
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn systemd_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// A not-yet-supported service backend error (a target with no service manager).
#[must_use]
pub fn unsupported_backend() -> PlatformError {
    PlatformError::Unsupported(
        "no supported service manager on this platform; use the foreground `run`".to_string(),
    )
}

/// Convenience: the rendered service definition for the host backend, or an
/// [`PlatformError::Unsupported`] on an unsupported target. Used by `service
/// install --print`.
///
/// # Errors
///
/// [`PlatformError::Unsupported`] when the host has no supported service manager,
/// or an OS error when the LaunchAgent user home cannot be resolved.
pub fn render_for_host(spec: &ServiceSpec) -> PlatformResult<String> {
    match ServiceSpec::backend() {
        ServiceBackend::Systemd => Ok(render_systemd_unit(spec)),
        ServiceBackend::Launchd => {
            let user_home = service_user_home()?;
            render_launchd_plist(spec, &user_home)
        }
        ServiceBackend::WindowsTask => render_windows_task_xml(spec, &current_windows_task_host()?),
        ServiceBackend::Unsupported => Err(unsupported_backend()),
    }
}

/// The signed-in user's SID, profile folder and `%SystemRoot%`, for
/// [`render_windows_task_xml`]. The SID comes from `whoami`, which reports the
/// process token on every Windows edition without elevation.
///
/// # Errors
///
/// Returns an OS error when `whoami` cannot run or reports no SID, or when the
/// profile folder cannot be resolved.
pub fn current_windows_task_host() -> PlatformResult<WindowsTaskHost> {
    let output = std::process::Command::new("whoami")
        .args(["/user", "/fo", "csv", "/nh"])
        .output()
        .map_err(|error| PlatformError::os(format!("could not run whoami: {error}")))?;
    if !output.status.success() {
        return Err(PlatformError::os(format!(
            "whoami /user exited with {}",
            output.status
        )));
    }
    let user_sid = parse_whoami_user_sid(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| PlatformError::os("whoami /user reported no SID"))?;
    let system_root = std::env::var_os("SystemRoot")
        .filter(|value| !value.is_empty())
        .map_or_else(|| PathBuf::from("C:\\Windows"), PathBuf::from);
    Ok(WindowsTaskHost {
        user_sid,
        user_home: service_user_home()?,
        system_root,
    })
}

/// The SID in `whoami /user /fo csv /nh` output: `"host\user","S-1-5-21-…"`.
#[must_use]
pub fn parse_whoami_user_sid(output: &str) -> Option<String> {
    output
        .lines()
        .filter_map(|line| line.trim().rsplit(',').next())
        .map(|field| field.trim().trim_matches('"'))
        .find(|sid| sid.starts_with("S-1-"))
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> ServiceSpec {
        ServiceSpec {
            binary_path: PathBuf::from("/home/u/.local/bin/opengeni-agent"),
            args: vec!["run".to_string()],
            scope: ServiceScope::User,
            environment_path: Some("/home/u/.local/bin:/usr/bin:/bin".to_string()),
        }
    }

    #[test]
    fn systemd_unit_has_the_required_directives() {
        let unit = render_systemd_unit(&spec());
        assert!(unit.contains("ExecStart=/home/u/.local/bin/opengeni-agent run"));
        assert!(unit.contains("Environment=\"PATH=/home/u/.local/bin:/usr/bin:/bin\""));
        assert!(unit.contains("Restart=always"));
        assert!(unit.contains("OOMScoreAdjust=-100"));
        assert!(unit.contains("OOMPolicy=continue"));
        assert!(unit.contains("WantedBy=default.target"));
        assert!(unit.contains("KillMode=mixed\n"));
        assert!(unit.contains("TimeoutStopSec=90\n"));
        let legacy = render_legacy_systemd_unit_before_browser_shutdown(&spec());
        assert!(legacy.contains("TimeoutStopSec=15\n"));
        assert!(!legacy.contains("KillMode="));
        assert!(
            unit.contains("KillSignal=SIGTERM"),
            "clean stop must SIGTERM for going-offline"
        );
    }

    #[test]
    fn launchd_plist_preserves_the_installer_command_path() {
        let plist = render_launchd_plist(&spec(), Path::new("/Users/runner")).unwrap();
        assert!(plist.contains("<key>EnvironmentVariables</key>"));
        assert!(plist.contains("<key>PATH</key>"));
        assert!(plist.contains("/home/u/.local/bin:/usr/bin:/bin"));
    }

    #[test]
    fn systemd_start_limit_keys_are_in_unit_section() {
        let unit = render_systemd_unit(&spec());
        let service_start = unit.find("[Service]").expect("service section");
        let unit_section = &unit[..service_start];
        let service_section = &unit[service_start..];

        assert!(unit_section.contains("StartLimitIntervalSec=60"));
        assert!(unit_section.contains("StartLimitBurst=5"));
        assert!(!service_section.contains("StartLimitIntervalSec=60"));
        assert!(!service_section.contains("StartLimitBurst=5"));
    }

    #[test]
    fn systemd_system_scope_targets_multi_user() {
        let mut s = spec();
        s.scope = ServiceScope::System;
        let unit = render_systemd_unit(&s);
        assert!(unit.contains("WantedBy=multi-user.target"));
    }

    #[test]
    fn systemd_unit_carries_oom_containment_directives_in_both_scopes() {
        // Issue #345: both the user and the system unit must delegate a cgroup
        // subtree, bias systemd-oomd away from a whole-unit kill, and enable resource
        // accounting without installing unit-wide resource limits.
        // These live in [Service], never [Unit] or [Install].
        for scope in [ServiceScope::User, ServiceScope::System] {
            let mut s = spec();
            s.scope = scope;
            let unit = render_systemd_unit(&s);
            let service_start = unit.find("[Service]").expect("service section");
            let install_start = unit.find("[Install]").expect("install section");
            let service_section = &unit[service_start..install_start];
            for directive in [
                "Delegate=cpu memory",
                "DelegateSubgroup=supervisor",
                "ManagedOOMPreference=avoid",
                "MemoryAccounting=yes",
            ] {
                assert!(
                    service_section.contains(directive),
                    "{scope:?} unit [Service] must contain {directive}; got:\n{unit}"
                );
            }
            assert!(!service_section.contains("IOAccounting="));
            assert!(!service_section.contains("CPUAccounting="));
            assert!(unit.starts_with("# X-OpenGeni-Managed-Service=v3\n"));
            for directive in [
                "MemoryHigh=infinity",
                "MemoryMax=infinity",
                "TasksMax=infinity",
            ] {
                assert!(
                    service_section.contains(directive),
                    "{scope:?} unit must explicitly leave the aggregate unrestricted with {directive}"
                );
            }
        }
    }

    #[test]
    fn legacy_unit_is_an_exact_unmarked_ownership_shape() {
        let legacy = render_legacy_systemd_unit_before_supervisor_subgroup(&spec());
        assert!(legacy.starts_with("[Unit]\n"));
        assert!(legacy.contains("Delegate=yes"));
        assert!(!legacy.contains("DelegateSubgroup="));
        assert!(!legacy.contains("X-OpenGeni-Managed-Service"));
    }

    #[test]
    fn systemd_unit_path_is_scope_aware() {
        let home = std::path::Path::new("/home/user");
        assert_eq!(
            systemd_unit_path(ServiceScope::User, home),
            systemd_user_unit_path(home)
        );
        assert_eq!(
            systemd_unit_path(ServiceScope::System, home),
            systemd_system_unit_path()
        );
        assert_eq!(
            systemd_system_unit_path(),
            PathBuf::from("/etc/systemd/system/opengeni-agent.service")
        );
    }

    #[test]
    fn launchd_plist_keeps_crash_output_in_the_agent_log_directory() {
        let plist = render_launchd_plist(&spec(), Path::new("/Users/Runner & Co")).unwrap();
        let log =
            "<string>/Users/Runner &amp; Co/.config/opengeni/agent/logs/agent.stderr.log</string>";
        assert!(plist.contains(&format!("<key>StandardOutPath</key>\n  {log}")));
        assert!(plist.contains(&format!("<key>StandardErrorPath</key>\n  {log}")));
        assert!(plist.contains(
            "    <key>OPENGENI_AGENT_STDERR_LOG</key>\n    <string>off</string>\n  </dict>"
        ));
        let mut without_path = spec();
        without_path.environment_path = None;
        let plist = render_launchd_plist(&without_path, Path::new("/Users/runner")).unwrap();
        assert!(!plist.contains("<key>PATH</key>"));
        assert!(plist.contains(
            "<key>EnvironmentVariables</key>\n  <dict>\n    <key>OPENGENI_AGENT_STDERR_LOG</key>"
        ));
    }

    #[test]
    fn launchd_plist_is_a_keepalive_runatload_agent() {
        let plist = render_launchd_plist(&spec(), Path::new("/Users/runner")).unwrap();
        assert!(plist.contains("<string>ai.opengeni.agent</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("<key>KeepAlive</key>"));
        assert!(plist.contains("<string>/home/u/.local/bin/opengeni-agent</string>"));
        assert!(plist.contains("<string>run</string>"));
    }

    #[test]
    fn launchd_starts_in_the_explicit_user_home() {
        // The launch root becomes the default cwd for commands and attachments.
        // It must come from the home passed by the installer, not its ambient cwd
        // or the binary's bundle directory.
        let home = Path::new("/Users/Runner & Co");
        let plist = render_launchd_plist(&spec(), home).unwrap();
        assert!(plist
            .contains("<key>WorkingDirectory</key>\n  <string>/Users/Runner &amp; Co</string>"));
    }

    #[test]
    fn service_home_resolution_is_shared_with_print_mode() {
        let home = OsString::from("/Users/user");
        let profile = OsString::from("/Users/me");
        assert_eq!(
            service_user_home_from_environment(Some(home), Some(profile.clone())).unwrap(),
            PathBuf::from("/Users/user")
        );
        assert_eq!(
            service_user_home_from_environment(None, Some(profile)).unwrap(),
            PathBuf::from("/Users/me")
        );
        assert!(service_user_home_from_environment(None, None).is_err());
    }

    #[test]
    fn launchd_refuses_home_characters_that_break_xml_or_loaded_path_observation() {
        for ch in [
            '\0', '\u{1}', '\u{b}', '\n', '\r', '\t', '\u{7f}', '\u{fffe}', '\u{ffff}',
        ] {
            let home = format!("/Users/Runner{ch}");
            assert!(render_launchd_plist(&spec(), Path::new(&home)).is_err());
        }
        assert!(render_launchd_plist(&spec(), Path::new("/Users/Åsa 🐈")).is_ok());
    }

    #[test]
    fn launchd_refuses_an_unusable_home_instead_of_defaulting_to_root() {
        for home in ["", "/", "/.", "////", "/Users/..", "Users/runner", "~"] {
            assert!(render_launchd_plist(&spec(), Path::new(home)).is_err());
        }
    }

    #[test]
    fn launchd_plist_path_is_a_user_launchagent() {
        let p = launchd_plist_path(std::path::Path::new("/Users/runner"));
        assert_eq!(
            p,
            PathBuf::from("/Users/runner/Library/LaunchAgents/ai.opengeni.agent.plist")
        );
    }

    fn windows_spec() -> ServiceSpec {
        ServiceSpec {
            binary_path: PathBuf::from(
                "C:\\Users\\Åsa & Co\\AppData\\Local\\Opengeni\\bin\\opengeni-agent.exe",
            ),
            args: vec!["run".to_string()],
            scope: ServiceScope::User,
            environment_path: None,
        }
    }

    fn windows_host() -> WindowsTaskHost {
        WindowsTaskHost {
            user_sid: "S-1-5-21-1945257197-2579421453-2829175806-1001".to_string(),
            user_home: PathBuf::from("C:\\Users\\Åsa & Co"),
            system_root: PathBuf::from("C:\\WINDOWS\\"),
        }
    }

    #[test]
    fn windows_task_runs_in_the_users_desktop_session_without_a_window() {
        let xml = render_windows_task_xml(&windows_spec(), &windows_host()).unwrap();
        // The signed-in user's own token, so computer use reaches their desktop.
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert_eq!(
            xml.matches("<UserId>S-1-5-21-1945257197-2579421453-2829175806-1001</UserId>")
                .count(),
            2,
            "both the logon trigger and the principal name the user by SID"
        );
        // One hidden console for the agent and every command it runs.
        assert!(xml.contains("<Command>C:\\WINDOWS\\System32\\conhost.exe</Command>"));
        assert!(xml.contains(
            "<Arguments>--headless \"C:\\Users\\Åsa &amp; Co\\AppData\\Local\\Opengeni\\bin\\opengeni-agent.exe\" run</Arguments>"
        ));
        assert!(xml.contains("<WorkingDirectory>C:\\Users\\Åsa &amp; Co</WorkingDirectory>"));
    }

    #[test]
    fn windows_task_keeps_the_agent_running() {
        let xml = render_windows_task_xml(&windows_spec(), &windows_host()).unwrap();
        assert!(xml.contains("<LogonTrigger>"));
        assert!(
            xml.contains("<Interval>PT1M</Interval>"),
            "restarts an exited agent"
        );
        assert!(xml.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(xml.contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"));
        assert!(xml.contains("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"));
        assert!(xml.contains("<Priority>5</Priority>"));
        assert!(!xml.contains("<Duration>"), "the repetition never ends");
    }

    #[test]
    fn windows_task_refuses_a_bad_sid_or_relative_paths() {
        let mut host = windows_host();
        host.user_sid = "WORKGROUP\\asa".to_string();
        assert!(render_windows_task_xml(&windows_spec(), &host).is_err());
        host.user_sid = "S-1-5-21-x".to_string();
        assert!(render_windows_task_xml(&windows_spec(), &host).is_err());
        assert!(render_windows_task_xml(&spec(), &windows_host()).is_err());
        let mut host = windows_host();
        host.user_home = PathBuf::from("Users\\asa");
        assert!(render_windows_task_xml(&windows_spec(), &host).is_err());
    }

    #[test]
    fn windows_task_names_the_binary_without_the_verbatim_prefix() {
        let mut spec = windows_spec();
        spec.binary_path =
            PathBuf::from(r"\\?\C:\Users\asa\AppData\Local\Opengeni\bin\opengeni-agent.exe");
        let xml = render_windows_task_xml(&spec, &windows_host()).unwrap();
        assert!(xml.contains(
            "<Arguments>--headless \"C:\\Users\\asa\\AppData\\Local\\Opengeni\\bin\\opengeni-agent.exe\" run</Arguments>"
        ));
        assert_eq!(
            without_verbatim_prefix(r"\\?\UNC\srv\share\a.exe"),
            r"\\srv\share\a.exe"
        );
        assert_eq!(without_verbatim_prefix(r"C:\a.exe"), r"C:\a.exe");
    }

    #[test]
    fn whoami_sid_is_parsed_from_csv() {
        assert_eq!(
            parse_whoami_user_sid(
                "\"win-b0koha156e9\\ogstd\",\"S-1-5-21-1945-2579-2829-1001\"\r\n"
            )
            .as_deref(),
            Some("S-1-5-21-1945-2579-2829-1001")
        );
        assert_eq!(
            parse_whoami_user_sid("\r\n\"a\\b\",\"S-1-5-18\"\r\n").as_deref(),
            Some("S-1-5-18")
        );
        assert_eq!(parse_whoami_user_sid("ERROR: something"), None);
    }

    #[test]
    fn plist_escapes_xml_metacharacters() {
        let mut s = spec();
        s.args = vec!["run".to_string(), "--name".to_string(), "a<b&c".to_string()];
        let plist = render_launchd_plist(&s, Path::new("/Users/runner")).unwrap();
        assert!(plist.contains("a&lt;b&amp;c"));
        assert!(!plist.contains("a<b&c"));
    }

    #[test]
    fn render_for_host_matches_the_compiled_backend() {
        // On the build host this returns the host's definition without error.
        let spec = if ServiceSpec::backend() == ServiceBackend::WindowsTask {
            windows_spec()
        } else {
            spec()
        };
        let out = render_for_host(&spec);
        match ServiceSpec::backend() {
            ServiceBackend::Unsupported => assert!(out.is_err()),
            _ => assert!(out.is_ok()),
        }
    }
}
