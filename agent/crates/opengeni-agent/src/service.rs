//! Always-on service install/start/stop/status handlers.
//!
//! The normal post-connect model is the always-on background service; `run` is
//! the explicit foreground mode. The cross-platform service mechanism lives in
//! [`opengeni_agent_platform::service`] (one trait, cargo-unit-tested); this module
//! is the thin binary-side glue that resolves the installed binary path, writes the
//! rendered unit/plist, and drives the platform service tool (`systemctl` /
//! `launchctl` / `sc.exe`).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};
#[cfg(target_os = "linux")]
use std::{io::Write as _, os::unix::fs::OpenOptionsExt as _};

use opengeni_agent_platform::service::{self, ServiceBackend, ServiceScope, ServiceSpec};
use tracing::info;

use crate::browser_bridge;
use crate::cli::{ServiceAction, ServiceArgs, ServiceInstallArgs, ServiceScopeArgs, StartArgs};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LaunchdInstallAction {
    KeepLoaded,
    Bootstrap,
    Reload,
}

const SYSTEMD_DELEGATE_SUBGROUP_MIN_VERSION: u32 = 254;

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ManagedSystemdDefinition {
    LegacyOwned,
    CurrentOwned,
    Unowned,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ManagedSystemdCgroup {
    ServiceRoot,
    Supervisor,
}

fn launchd_install_action(
    loaded_program_matches: Option<bool>,
    restart: bool,
    definition_changed: bool,
) -> LaunchdInstallAction {
    if loaded_program_matches.is_none() {
        LaunchdInstallAction::Bootstrap
    } else if restart || definition_changed || loaded_program_matches == Some(false) {
        LaunchdInstallAction::Reload
    } else {
        LaunchdInstallAction::KeepLoaded
    }
}

fn launchd_loaded_program_matches(output: &str, binary_path: &Path) -> bool {
    let expected = binary_path.to_string_lossy();
    output.lines().any(|line| {
        line.trim()
            .strip_prefix("program = ")
            .is_some_and(|program| program == expected)
    })
}

/// Idempotently installs, enables, and starts the ordinary background service.
pub fn ensure_running(args: &StartArgs) -> Result<(), String> {
    install(&ServiceInstallArgs {
        system: args.system,
        print: false,
        restart: args.restart,
    })
}

/// Stops the ordinary background service.
pub fn stop(args: &ServiceScopeArgs) -> Result<(), String> {
    lifecycle("stop", scope(args))
}

/// Prints the ordinary background service status.
pub fn show_status(args: &ServiceScopeArgs) -> Result<(), String> {
    status(scope(args))
}

/// Dispatches a `service` subcommand. Returns a human-facing result string on
/// success or an error message on failure.
pub fn run(args: &ServiceArgs) -> Result<(), String> {
    info!(action = args.action.label(), "service subcommand");
    match &args.action {
        ServiceAction::Install(a) => install(a),
        ServiceAction::Uninstall(a) => uninstall(scope(a)),
        ServiceAction::Start(a) => lifecycle("start", scope(a)),
        ServiceAction::Stop(a) => lifecycle("stop", scope(a)),
        ServiceAction::Status(a) => status(scope(a)),
    }
}

fn scope(a: &ServiceScopeArgs) -> ServiceScope {
    if a.system {
        ServiceScope::System
    } else {
        ServiceScope::User
    }
}

/// Resolves the absolute path to the running binary (a service uses an absolute
/// path so it runs regardless of the user's PATH).
fn binary_path() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|e| format!("could not resolve the agent binary path: {e}"))?
        .canonicalize()
        .map_err(|e| format!("could not canonicalize the agent binary path: {e}"))
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "could not resolve a home directory ($HOME/$USERPROFILE)".to_string())
}

fn systemd_unit_path_for_scope(install_scope: ServiceScope) -> Result<PathBuf, String> {
    match install_scope {
        ServiceScope::User => Ok(service::systemd_user_unit_path(&home()?)),
        ServiceScope::System => Ok(service::systemd_system_unit_path()),
    }
}

fn spec_for(install_scope: ServiceScope) -> Result<ServiceSpec, String> {
    Ok(ServiceSpec {
        binary_path: binary_path()?,
        args: vec!["run".to_string()],
        scope: install_scope,
        environment_path: std::env::var("PATH").ok().filter(|value| !value.is_empty()),
    })
}

/// Upgrades the exact old OpenGeni-owned systemd unit after a verified binary
/// self-update. This runs before any host-work admission. It never adopts a
/// custom unit: live manager identity, canonical fragment path, exact ExecStart,
/// and byte-identical legacy generated content must all agree.
///
/// `Ok(true)` means the manager accepted a non-blocking restart and this process
/// must return cleanly so the successor starts directly in `supervisor`.
#[cfg_attr(not(target_os = "linux"), allow(clippy::unnecessary_wraps))]
pub fn refresh_managed_service_definition() -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        refresh_managed_systemd_definition()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(false)
    }
}

#[cfg(target_os = "linux")]
fn refresh_managed_systemd_definition() -> Result<bool, String> {
    let Some((cgroup_path, cgroup_location)) = current_managed_systemd_cgroup()? else {
        return Ok(false);
    };
    let Some((install_scope, unit_path)) = find_live_managed_systemd_scope(&binary_path()?)? else {
        return Ok(false);
    };
    let spec = spec_for(install_scope)?;
    let existing = std::fs::read_to_string(&unit_path)
        .map_err(|error| format!("read {}: {error}", unit_path.display()))?;
    match managed_systemd_definition(&existing, &spec) {
        ManagedSystemdDefinition::Unowned => {
            tracing::warn!(
                path = %unit_path.display(),
                "the active systemd unit is custom; leaving it untouched. Run `opengeni-agent service install --restart` to adopt the generated containment topology"
            );
            Ok(false)
        }
        ManagedSystemdDefinition::CurrentOwned => {
            if cgroup_location == ManagedSystemdCgroup::Supervisor {
                return Ok(false);
            }
            tracing::warn!(
                path = %unit_path.display(),
                cgroup = cgroup_path,
                "the managed unit already requests the supervisor subgroup but systemd did not place this process there; continuing without operation-cgroup capability to avoid a restart loop"
            );
            Ok(false)
        }
        ManagedSystemdDefinition::LegacyOwned => {
            migrate_legacy_systemd_unit(install_scope, &unit_path, &spec, &existing)
        }
    }
}

#[cfg(target_os = "linux")]
fn current_managed_systemd_cgroup() -> Result<Option<(String, ManagedSystemdCgroup)>, String> {
    let current_cgroup = std::fs::read_to_string("/proc/self/cgroup")
        .map_err(|error| format!("read /proc/self/cgroup: {error}"))?;
    let Some(path) = current_cgroup
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .map(str::trim)
    else {
        return Ok(None);
    };
    let Some(cgroup_location) = managed_systemd_cgroup(path) else {
        return Ok(None);
    };
    Ok(Some((path.to_string(), cgroup_location)))
}

#[cfg(target_os = "linux")]
fn find_live_managed_systemd_scope(
    binary: &Path,
) -> Result<Option<(ServiceScope, PathBuf)>, String> {
    let current_pid = std::process::id();
    let mut matched = Vec::new();
    for install_scope in [ServiceScope::User, ServiceScope::System] {
        let prefix = match install_scope {
            ServiceScope::User => vec!["--user"],
            ServiceScope::System => Vec::new(),
        };
        let mut show = prefix.clone();
        show.extend([
            "show",
            service::ids::SYSTEMD_UNIT,
            "--property=MainPID",
            "--value",
        ]);
        let Ok(main_pid) = capture_systemctl(&show) else {
            continue;
        };
        if main_pid.trim().parse::<u32>().ok() != Some(current_pid) {
            continue;
        }

        let mut fragment_args = prefix.clone();
        fragment_args.extend([
            "show",
            service::ids::SYSTEMD_UNIT,
            "--property=FragmentPath",
            "--value",
        ]);
        let fragment = capture_systemctl(&fragment_args)?;
        let canonical_fragment = systemd_unit_path_for_scope(install_scope)?;
        if !systemd_show_path_matches(&fragment, &canonical_fragment) {
            continue;
        }

        let mut exec_args = prefix;
        exec_args.extend([
            "show",
            service::ids::SYSTEMD_UNIT,
            "--property=ExecStart",
            "--value",
        ]);
        let exec_start = capture_systemctl(&exec_args)?;
        if !systemd_exec_start_matches(&exec_start, binary) {
            continue;
        }
        matched.push((install_scope, canonical_fragment));
    }

    match matched.as_slice() {
        [] => Ok(None),
        [(scope, path)] => Ok(Some((*scope, path.clone()))),
        _ => Err("multiple canonical systemd scopes claim this runner MainPID".to_string()),
    }
}

#[cfg(target_os = "linux")]
fn migrate_legacy_systemd_unit(
    install_scope: ServiceScope,
    unit_path: &Path,
    spec: &ServiceSpec,
    existing: &str,
) -> Result<bool, String> {
    let version = capture_systemctl(&["--version"])
        .ok()
        .and_then(|output| parse_systemd_version(&output));
    if version.is_none_or(|version| version < SYSTEMD_DELEGATE_SUBGROUP_MIN_VERSION) {
        tracing::warn!(
            ?version,
            required = SYSTEMD_DELEGATE_SUBGROUP_MIN_VERSION,
            "systemd is too old for DelegateSubgroup; keeping the proven legacy unit and continuing without operation-cgroup capability"
        );
        return Ok(false);
    }

    remove_legacy_opengeni_control_dropins(install_scope)?;
    atomic_replace_managed_unit(unit_path, &service::render_systemd_unit(spec))?;
    let scope_prefix = match install_scope {
        ServiceScope::User => Some("--user"),
        ServiceScope::System => None,
    };
    let mut reload = Vec::new();
    if let Some(prefix) = scope_prefix {
        reload.push(prefix);
    }
    reload.push("daemon-reload");
    if let Err(error) = systemctl(&reload) {
        rollback_managed_unit(unit_path, existing, &reload);
        return Err(format!("reload the migrated systemd definition: {error}"));
    }

    let mut restart = Vec::new();
    if let Some(prefix) = scope_prefix {
        restart.push(prefix);
    }
    restart.extend(["restart", "--no-block", service::ids::SYSTEMD_UNIT]);
    if let Err(error) = systemctl(&restart) {
        rollback_managed_unit(unit_path, existing, &reload);
        return Err(format!(
            "queue the migrated systemd manager restart: {error}"
        ));
    }
    info!(
        path = %unit_path.display(),
        "migrated the owned systemd unit; manager restart will enter the stable supervisor subgroup"
    );
    Ok(true)
}

#[cfg(target_os = "linux")]
fn rollback_managed_unit(path: &Path, prior: &str, reload_args: &[&str]) {
    if let Err(error) = atomic_replace_managed_unit(path, prior) {
        tracing::error!(
            %error,
            path = %path.display(),
            "failed to roll back the owned unit after migration activation failed"
        );
        return;
    }
    if let Err(error) = systemctl(reload_args) {
        tracing::error!(
            %error,
            path = %path.display(),
            "restored the owned unit on disk but systemd could not reload it"
        );
    }
}

/// Removes only the exact systemd control drop-ins produced by the old
/// OpenGeni `set-property ... infinity` reset. Unknown names, comments plus extra
/// directives, and ordinary operator drop-ins are preserved byte-for-byte.
#[cfg(target_os = "linux")]
fn remove_legacy_opengeni_control_dropins(install_scope: ServiceScope) -> Result<(), String> {
    let suffix = PathBuf::from(format!("{}.d", service::ids::SYSTEMD_UNIT));
    let roots = systemd_control_roots(install_scope)?;

    for root in roots {
        let directory = root.join(&suffix);
        for name in [
            "50-MemoryHigh.conf",
            "50-MemoryMax.conf",
            "50-TasksMax.conf",
            "50-CPUQuota.conf",
            "50-CPUQuotaPerSecUSec.conf",
        ] {
            let path = directory.join(name);
            let contents = match std::fs::read_to_string(&path) {
                Ok(contents) => contents,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(format!("read {}: {error}", path.display())),
            };
            if legacy_opengeni_control_dropin(name, &contents) {
                std::fs::remove_file(&path)
                    .map_err(|error| format!("remove {}: {error}", path.display()))?;
                info!(path = %path.display(), "removed an obsolete OpenGeni-owned aggregate-limit reset");
            }
        }
    }
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
fn systemd_control_roots(install_scope: ServiceScope) -> Result<Vec<PathBuf>, String> {
    let mut roots = match install_scope {
        ServiceScope::User => vec![home()?.join(".config/systemd/user.control")],
        ServiceScope::System => vec![PathBuf::from("/etc/systemd/system.control")],
    };
    match install_scope {
        ServiceScope::User => {
            if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") {
                roots.push(PathBuf::from(runtime).join("systemd/user.control"));
            }
        }
        ServiceScope::System => roots.push(PathBuf::from("/run/systemd/system.control")),
    }

    Ok(roots)
}

#[cfg(any(target_os = "linux", test))]
fn legacy_opengeni_control_dropin(name: &str, contents: &str) -> bool {
    const SYSTEMCTL_PROVENANCE: &str =
        "# This is a drop-in unit file extension, created via systemctl.";
    let property = match name {
        "50-MemoryHigh.conf" => "MemoryHigh=infinity",
        "50-MemoryMax.conf" => "MemoryMax=infinity",
        "50-TasksMax.conf" => "TasksMax=infinity",
        "50-CPUQuota.conf" => "CPUQuota=",
        "50-CPUQuotaPerSecUSec.conf" => "CPUQuotaPerSecUSec=infinity",
        _ => return false,
    };
    contents == format!("{SYSTEMCTL_PROVENANCE}\n[Service]\n{property}\n")
}

#[cfg(any(target_os = "linux", test))]
fn managed_systemd_definition(existing: &str, spec: &ServiceSpec) -> ManagedSystemdDefinition {
    if existing == service::render_legacy_systemd_unit_before_supervisor_subgroup(spec) {
        ManagedSystemdDefinition::LegacyOwned
    } else if existing == service::render_systemd_unit(spec) {
        ManagedSystemdDefinition::CurrentOwned
    } else {
        ManagedSystemdDefinition::Unowned
    }
}

#[cfg(any(target_os = "linux", test))]
fn managed_systemd_cgroup(path: &str) -> Option<ManagedSystemdCgroup> {
    let service_suffix = format!("/{}", service::ids::SYSTEMD_UNIT);
    if path.ends_with(&format!("{service_suffix}/supervisor")) {
        Some(ManagedSystemdCgroup::Supervisor)
    } else if path.ends_with(&service_suffix) {
        Some(ManagedSystemdCgroup::ServiceRoot)
    } else {
        None
    }
}

fn parse_systemd_version(output: &str) -> Option<u32> {
    let mut fields = output.lines().next()?.split_whitespace();
    (fields.next()? == "systemd")
        .then(|| fields.next()?.parse::<u32>().ok())
        .flatten()
}

#[cfg(any(target_os = "linux", test))]
fn systemd_exec_start_matches(output: &str, binary: &Path) -> bool {
    let expected = binary.to_string_lossy();
    let expected_argv = format!("{expected} run");
    let paths = output
        .split(';')
        .filter_map(|field| field.trim().strip_prefix("{ path="))
        .map(decode_systemd_show_value)
        .collect::<Option<Vec<_>>>();
    let argvs = output
        .split(';')
        .filter_map(|field| field.trim().strip_prefix("argv[]="))
        .map(decode_systemd_show_value)
        .collect::<Option<Vec<_>>>();
    matches!(
        (paths.as_deref(), argvs.as_deref()),
        (Some([path]), Some([argv]))
            if path == expected.as_ref() && argv == &expected_argv
    )
}

#[cfg(any(target_os = "linux", test))]
fn systemd_show_path_matches(output: &str, expected: &Path) -> bool {
    decode_systemd_show_value(output.trim()).is_some_and(|path| Path::new(&path) == expected)
}

/// Decodes systemd's own C-style `show` escaping. This is deliberately not shell
/// parsing: manager output is a serialized value, and every unknown or incomplete
/// escape fails ownership proof rather than being guessed.
#[cfg(any(target_os = "linux", test))]
fn decode_systemd_show_value(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'\\' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        index += 1;
        let escaped = *bytes.get(index)?;
        index += 1;
        match escaped {
            b'\\' => decoded.push(b'\\'),
            b'"' => decoded.push(b'"'),
            b'\'' => decoded.push(b'\''),
            b's' => decoded.push(b' '),
            b'n' => decoded.push(b'\n'),
            b'r' => decoded.push(b'\r'),
            b't' => decoded.push(b'\t'),
            b'x' => {
                let high = hex_nibble(*bytes.get(index)?)?;
                let low = hex_nibble(*bytes.get(index + 1)?)?;
                decoded.push(high << 4 | low);
                index += 2;
            }
            _ => return None,
        }
    }
    String::from_utf8(decoded).ok()
}

#[cfg(any(target_os = "linux", test))]
fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(target_os = "linux")]
fn atomic_replace_managed_unit(path: &Path, body: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("service unit {} has no parent", path.display()))?;
    let temporary = parent.join(format!(
        ".{}.{}.{}.tmp",
        service::ids::SYSTEMD_UNIT,
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true).mode(0o644);
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("create {}: {error}", temporary.display()))?;
    if let Err(error) = file
        .write_all(body.as_bytes())
        .and_then(|()| file.sync_all())
    {
        drop(file);
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("write {}: {error}", temporary.display()));
    }
    drop(file);
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("replace managed unit {}: {error}", path.display()));
    }
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("sync service unit directory {}: {error}", parent.display()))
}

/// `service install` — write the rendered unit/plist + enable it. `--print` is a
/// dry-run that dumps the definition and exits without touching the system.
fn install(args: &ServiceInstallArgs) -> Result<(), String> {
    let install_scope = if args.system {
        ServiceScope::System
    } else {
        ServiceScope::User
    };
    let spec = spec_for(install_scope)?;

    if args.print {
        let definition = service::render_for_host(&spec).map_err(|e| e.to_string())?;
        println!("{definition}");
        return Ok(());
    }

    match ServiceSpec::backend() {
        ServiceBackend::Systemd => install_systemd(&spec, args.restart),
        ServiceBackend::Launchd => install_launchd(&spec, args.restart),
        ServiceBackend::WindowsScm => install_windows(&spec, args.restart),
        ServiceBackend::Unsupported => Err(service::unsupported_backend().to_string()),
    }?;
    if install_scope == ServiceScope::User {
        let manifests = browser_bridge::install_native_host_manifests(&spec.binary_path, &home()?)
            .map_err(|error| error.to_string())?;
        for manifest in manifests {
            info!(path = %manifest.display(), "installed Chrome Native Messaging host");
        }
    }
    Ok(())
}

/// Linux: write the user (or system) unit, reload systemd, enable+start it, and —
/// for a user unit — enable lingering so it survives logout / boots without a
/// session. This is the concrete, testable live path.
fn install_systemd(spec: &ServiceSpec, restart: bool) -> Result<(), String> {
    let unit_path = systemd_unit_path_for_scope(spec.scope)?;
    let systemd_version = capture_systemctl(&["--version"])
        .ok()
        .and_then(|output| parse_systemd_version(&output));
    let subgroup_supported =
        systemd_version.is_some_and(|version| version >= SYSTEMD_DELEGATE_SUBGROUP_MIN_VERSION);
    let body = if subgroup_supported {
        service::render_systemd_unit(spec)
    } else {
        tracing::warn!(
            ?systemd_version,
            required = SYSTEMD_DELEGATE_SUBGROUP_MIN_VERSION,
            "systemd lacks DelegateSubgroup; installing the compatible service definition without operation-cgroup capability"
        );
        service::render_legacy_systemd_unit_before_supervisor_subgroup(spec)
    };
    if let Some(parent) = unit_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    std::fs::write(&unit_path, body).map_err(|e| format!("write {}: {e}", unit_path.display()))?;
    info!(path = %unit_path.display(), "wrote systemd unit");
    #[cfg(target_os = "linux")]
    remove_legacy_opengeni_control_dropins(spec.scope)?;

    match spec.scope {
        ServiceScope::User => {
            systemctl(&["--user", "daemon-reload"])?;
            // Linger so the user service runs without an active login session.
            if let Ok(user) = std::env::var("USER") {
                let _ = run_tool_path(&systemd_tool("loginctl"), &["enable-linger", &user]);
            }
            systemctl(&["--user", "enable", "--now", service::ids::SYSTEMD_UNIT])?;
            if restart {
                systemctl(&["--user", "restart", service::ids::SYSTEMD_UNIT])?;
            }
        }
        ServiceScope::System => {
            systemctl(&["daemon-reload"])?;
            systemctl(&["enable", "--now", service::ids::SYSTEMD_UNIT])?;
            if restart {
                systemctl(&["restart", service::ids::SYSTEMD_UNIT])?;
            }
        }
    }
    println!(
        "installed + started the opengeni-agent service ({} scope).",
        scope_label(spec.scope)
    );
    Ok(())
}

/// macOS: write the LaunchAgent plist and bootstrap it into the user's GUI session.
fn install_launchd(spec: &ServiceSpec, restart: bool) -> Result<(), String> {
    let plist_path = service::launchd_plist_path(&home()?);
    let body = service::render_launchd_plist(spec);
    let definition_changed =
        std::fs::read(&plist_path).map_or(true, |existing| existing != body.as_bytes());
    if let Some(parent) = plist_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    std::fs::write(&plist_path, body)
        .map_err(|e| format!("write {}: {e}", plist_path.display()))?;
    info!(path = %plist_path.display(), "wrote LaunchAgent plist");

    let uid = unsafe_uid();
    let domain = format!("gui/{uid}");
    let target = format!("{domain}/{}", service::ids::LAUNCHD_LABEL);
    let loaded_definition = capture("launchctl", &["print", &target]).ok();
    let loaded_program_matches = loaded_definition
        .as_deref()
        .map(|output| launchd_loaded_program_matches(output, &spec.binary_path));
    match launchd_install_action(loaded_program_matches, restart, definition_changed) {
        LaunchdInstallAction::KeepLoaded => {}
        LaunchdInstallAction::Reload => {
            // launchd caches a loaded job's definition. Rewriting the plist and
            // kickstarting the label restarts the *old* ProgramArguments, which
            // makes an apparently successful binary upgrade keep executing the
            // previous build indefinitely. Boot the loaded definition out and
            // bootstrap the exact plist we just wrote so the restarted process
            // is definition-coherent with disk.
            if let Err(error) = run_tool("launchctl", &["bootout", &target]) {
                if capture("launchctl", &["print", &target]).is_ok() {
                    return Err(error);
                }
            }
            activate_launchd_definition(&domain, &target, &plist_path, &spec.binary_path)?;
        }
        LaunchdInstallAction::Bootstrap => {
            activate_launchd_definition(&domain, &target, &plist_path, &spec.binary_path)?;
        }
    }
    println!(
        "installed the opengeni-agent LaunchAgent at {}.",
        plist_path.display()
    );
    Ok(())
}

/// `bootout` may return before launchd has completely retired the old job.
/// Retrying `bootstrap` blindly is still safe only if every iteration first
/// inspects the exact label and accepts success solely when launchd reports the
/// expected program path. This also recovers a lost successful bootstrap reply
/// without ever admitting two definitions.
fn activate_launchd_definition(
    domain: &str,
    target: &str,
    plist_path: &Path,
    expected_binary: &Path,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let plist = plist_path.to_string_lossy();
    let mut last_error = "launchd did not accept the new service definition".to_string();
    loop {
        if let Ok(definition) = capture("launchctl", &["print", target]) {
            if launchd_loaded_program_matches(&definition, expected_binary) {
                return Ok(());
            }
            last_error = "launchd loaded the label with an unexpected program path".to_string();
        } else {
            match capture("launchctl", &["bootstrap", domain, &plist]) {
                Ok(_) => {}
                Err(error) => last_error = error,
            }
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "could not converge the LaunchAgent to {} within five seconds: {last_error}",
                expected_binary.display()
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

/// Windows: register the SCM service + set restart-on-failure recovery. The binary
/// hosts the SCM service via the windows-service crate on its native build. The
/// `Result` return is uniform with the other backends (it only ever fails on the
/// Windows build, where `sc.exe` can error).
#[cfg_attr(not(windows), allow(clippy::unnecessary_wraps, unused_variables))]
fn install_windows(spec: &ServiceSpec, restart: bool) -> Result<(), String> {
    // We invoke sc.exe with the rendered argument vectors. On non-Windows builds
    // this code is still compiled (so the surface never rots) but only runs on
    // Windows; the commands are exactly what `--print` shows.
    println!("{}", service::windows_create_command(spec));
    println!("{}", service::windows_recovery_command());
    #[cfg(windows)]
    {
        let bin_path = format!("\"{}\" run", spec.binary_path.to_string_lossy());
        let prior = capture("sc.exe", &["query", service::ids::WINDOWS_SERVICE]).ok();
        if prior.is_some() {
            run_tool(
                "sc.exe",
                &[
                    "config",
                    service::ids::WINDOWS_SERVICE,
                    "binPath=",
                    &bin_path,
                    "start=",
                    "delayed-auto",
                ],
            )?;
        } else {
            run_tool(
                "sc.exe",
                &[
                    "create",
                    service::ids::WINDOWS_SERVICE,
                    "binPath=",
                    &bin_path,
                    "start=",
                    "delayed-auto",
                ],
            )?;
        }
        run_tool(
            "sc.exe",
            &[
                "failure",
                service::ids::WINDOWS_SERVICE,
                "reset=",
                "0",
                "actions=",
                "restart/5000/restart/5000/restart/5000",
            ],
        )?;
        let was_running = prior
            .as_deref()
            .is_some_and(|output| output.contains("RUNNING"));
        if restart && was_running {
            run_tool("sc.exe", &["stop", service::ids::WINDOWS_SERVICE])?;
            wait_for_windows_service_state("STOPPED")?;
        }
        if !was_running || restart {
            run_tool("sc.exe", &["start", service::ids::WINDOWS_SERVICE])?;
            wait_for_windows_service_state("RUNNING")?;
        }
    }
    println!("registered the OpengeniAgent Windows Service.");
    Ok(())
}

/// `sc stop` returns while the service is still stopping. Starting immediately
/// after that races the SCM and intermittently leaves an upgraded machine
/// offline, so native Windows installs wait for the authoritative state.
#[cfg(windows)]
fn wait_for_windows_service_state(wanted: &str) -> Result<(), String> {
    for _ in 0..100 {
        if capture("sc.exe", &["query", service::ids::WINDOWS_SERVICE])
            .is_ok_and(|output| output.contains(wanted))
        {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err(format!(
        "Windows Service {} did not reach {wanted} within 10 seconds",
        service::ids::WINDOWS_SERVICE
    ))
}

fn uninstall(install_scope: ServiceScope) -> Result<(), String> {
    match ServiceSpec::backend() {
        ServiceBackend::Systemd => {
            let unit = service::ids::SYSTEMD_UNIT;
            match install_scope {
                ServiceScope::User => {
                    let _ = systemctl(&["--user", "disable", "--now", unit]);
                }
                ServiceScope::System => {
                    let _ = systemctl(&["disable", "--now", unit]);
                }
            }
            let unit_path = systemd_unit_path_for_scope(install_scope)?;
            let _ = std::fs::remove_file(&unit_path);
            let _ = match install_scope {
                ServiceScope::User => systemctl(&["--user", "daemon-reload"]),
                ServiceScope::System => systemctl(&["daemon-reload"]),
            };
            println!("uninstalled the opengeni-agent service.");
            Ok(())
        }
        ServiceBackend::Launchd => {
            let plist_path = service::launchd_plist_path(&home()?);
            let uid = unsafe_uid();
            let _ = run_tool(
                "launchctl",
                &[
                    "bootout",
                    &format!("gui/{uid}/{}", service::ids::LAUNCHD_LABEL),
                ],
            );
            let _ = std::fs::remove_file(&plist_path);
            println!("uninstalled the opengeni-agent LaunchAgent.");
            Ok(())
        }
        ServiceBackend::WindowsScm => {
            #[cfg(windows)]
            {
                let _ = run_tool("sc.exe", &["stop", service::ids::WINDOWS_SERVICE]);
                let _ = run_tool("sc.exe", &["delete", service::ids::WINDOWS_SERVICE]);
            }
            println!("uninstalled the OpengeniAgent Windows Service.");
            Ok(())
        }
        ServiceBackend::Unsupported => Err(service::unsupported_backend().to_string()),
    }?;
    if install_scope == ServiceScope::User {
        browser_bridge::remove_native_host_manifests(&home()?)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn lifecycle(action: &str, install_scope: ServiceScope) -> Result<(), String> {
    match ServiceSpec::backend() {
        ServiceBackend::Systemd => {
            let unit = service::ids::SYSTEMD_UNIT;
            match install_scope {
                ServiceScope::User => systemctl(&["--user", action, unit])?,
                ServiceScope::System => systemctl(&[action, unit])?,
            }
            println!("{action}ed the opengeni-agent service.");
            Ok(())
        }
        ServiceBackend::Launchd => {
            let uid = unsafe_uid();
            let domain = format!("gui/{uid}");
            let target = format!("gui/{uid}/{}", service::ids::LAUNCHD_LABEL);
            if action == "start" {
                if capture("launchctl", &["print", &target]).is_ok() {
                    run_tool("launchctl", &["kickstart", &target])?;
                } else {
                    let plist = service::launchd_plist_path(&home()?);
                    run_tool(
                        "launchctl",
                        &["bootstrap", &domain, &plist.to_string_lossy()],
                    )?;
                }
            } else {
                run_tool("launchctl", &["bootout", &target])?;
            }
            println!("{action}ed the opengeni-agent LaunchAgent.");
            Ok(())
        }
        ServiceBackend::WindowsScm => {
            #[cfg(windows)]
            {
                run_tool("sc.exe", &[action, service::ids::WINDOWS_SERVICE])?;
            }
            println!("{action}ed the OpengeniAgent Windows Service.");
            Ok(())
        }
        ServiceBackend::Unsupported => Err(service::unsupported_backend().to_string()),
    }
}

fn status(install_scope: ServiceScope) -> Result<(), String> {
    match ServiceSpec::backend() {
        ServiceBackend::Systemd => {
            let unit = service::ids::SYSTEMD_UNIT;
            let out = match install_scope {
                ServiceScope::User => capture_systemctl(&["--user", "is-active", unit]),
                ServiceScope::System => capture_systemctl(&["is-active", unit]),
            };
            match out {
                Ok(s) => println!("opengeni-agent service: {}", s.trim()),
                Err(_) => println!("opengeni-agent service: not installed"),
            }
            Ok(())
        }
        ServiceBackend::Launchd => {
            let out = capture("launchctl", &["list", service::ids::LAUNCHD_LABEL]);
            match out {
                Ok(_) => println!("opengeni-agent LaunchAgent: loaded"),
                Err(_) => println!("opengeni-agent LaunchAgent: not loaded"),
            }
            Ok(())
        }
        ServiceBackend::WindowsScm => {
            #[cfg(windows)]
            {
                let out = capture("sc.exe", &["query", service::ids::WINDOWS_SERVICE]);
                match out {
                    Ok(s) => println!("{s}"),
                    Err(_) => println!("OpengeniAgent Windows Service: not installed"),
                }
            }
            #[cfg(not(windows))]
            {
                println!("OpengeniAgent Windows Service: (status available on Windows)");
            }
            Ok(())
        }
        ServiceBackend::Unsupported => Err(service::unsupported_backend().to_string()),
    }
}

fn scope_label(s: ServiceScope) -> &'static str {
    match s {
        ServiceScope::User => "user",
        ServiceScope::System => "system",
    }
}

/// Runs `systemctl` with args, mapping a non-zero exit to an error string.
fn systemctl(args: &[&str]) -> Result<(), String> {
    run_tool_path(&systemd_tool("systemctl"), args)
}

fn capture_systemctl(args: &[&str]) -> Result<String, String> {
    capture_path(&systemd_tool("systemctl"), args)
}

/// Resolves systemd's own tools ahead of PATH. Agent command execution should
/// preserve the user's PATH, but service lifecycle commands must not be hijacked
/// by an unrelated user shim with the same name.
fn systemd_tool(name: &str) -> PathBuf {
    resolve_systemd_tool(
        name,
        &[
            Path::new("/run/current-system/sw/bin"),
            Path::new("/usr/bin"),
            Path::new("/bin"),
        ],
    )
}

fn resolve_systemd_tool(name: &str, trusted_dirs: &[&Path]) -> PathBuf {
    trusted_dirs
        .iter()
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| PathBuf::from(name))
}

/// Runs an external tool, erroring on a non-zero exit or a spawn failure.
fn run_tool(tool: &str, args: &[&str]) -> Result<(), String> {
    run_tool_path(Path::new(tool), args)
}

fn run_tool_path(tool: &Path, args: &[&str]) -> Result<(), String> {
    let status = Command::new(tool)
        .args(args)
        .status()
        .map_err(|e| format!("could not run {}: {e}", tool.display()))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{} {args:?} exited with {status}", tool.display()))
    }
}

/// Runs an external tool and captures its stdout.
fn capture(tool: &str, args: &[&str]) -> Result<String, String> {
    capture_path(Path::new(tool), args)
}

fn capture_path(tool: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new(tool)
        .args(args)
        .output()
        .map_err(|e| format!("could not run {}: {e}", tool.display()))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!(
            "{} {args:?} exited with {}",
            tool.display(),
            out.status
        ))
    }
}

/// The current user's uid for the launchd `gui/<uid>` domain. On non-unix it is a
/// harmless placeholder (the Windows/other paths never use it). We avoid an FFI
/// `getuid` (the workspace forbids `unsafe`) by reading `$UID` / the `id -u` output;
/// the name keeps the historical call-sites unchanged.
fn unsafe_uid() -> String {
    if let Ok(uid) = std::env::var("UID") {
        if !uid.is_empty() {
            return uid;
        }
    }
    // Fall back to `id -u`.
    capture("id", &["-u"]).map_or_else(|_| "0".to_string(), |s| s.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::ServiceScopeArgs;
    use std::fs;

    #[test]
    fn scope_maps_system_flag() {
        assert_eq!(
            scope(&ServiceScopeArgs { system: true }),
            ServiceScope::System
        );
        assert_eq!(
            scope(&ServiceScopeArgs { system: false }),
            ServiceScope::User
        );
    }

    #[test]
    fn scope_label_is_human_readable() {
        assert_eq!(scope_label(ServiceScope::User), "user");
        assert_eq!(scope_label(ServiceScope::System), "system");
    }

    #[test]
    fn systemd_system_scope_path_does_not_require_a_home_directory() {
        assert_eq!(
            systemd_unit_path_for_scope(ServiceScope::System).unwrap(),
            PathBuf::from("/etc/systemd/system/opengeni-agent.service")
        );
        assert_eq!(
            systemd_control_roots(ServiceScope::System).unwrap(),
            vec![
                PathBuf::from("/etc/systemd/system.control"),
                PathBuf::from("/run/systemd/system.control")
            ]
        );
    }

    #[test]
    fn launchd_restart_reloads_the_definition_instead_of_kickstarting_the_cached_job() {
        for (loaded_program_matches, restart, definition_changed, expected) in [
            (Some(true), true, false, LaunchdInstallAction::Reload),
            (Some(true), false, false, LaunchdInstallAction::KeepLoaded),
            (None, false, false, LaunchdInstallAction::Bootstrap),
            (Some(true), false, true, LaunchdInstallAction::Reload),
            (Some(false), false, false, LaunchdInstallAction::Reload),
        ] {
            assert_eq!(
                launchd_install_action(loaded_program_matches, restart, definition_changed),
                expected
            );
        }
    }

    #[test]
    fn launchd_loaded_program_match_is_exact_and_space_safe() {
        let expected = Path::new("/Applications/OpenGeni Agent/opengeni-agent");
        assert!(launchd_loaded_program_matches(
            "gui/501/ai.opengeni.agent = {\n\tprogram = /Applications/OpenGeni Agent/opengeni-agent\n}\n",
            expected,
        ));
        assert!(!launchd_loaded_program_matches(
            "gui/501/ai.opengeni.agent = {\n\tprogram = /tmp/old/opengeni-agent\n}\n",
            expected,
        ));
    }

    #[test]
    fn systemd_tool_prefers_the_os_binary_over_path_fallback() {
        let temp = tempfile::tempdir().expect("temp dir");
        let first = temp.path().join("nix-system");
        let second = temp.path().join("usr-bin");
        fs::create_dir_all(&first).expect("first trusted dir");
        fs::create_dir_all(&second).expect("second trusted dir");
        fs::write(second.join("systemctl"), b"real systemctl").expect("trusted tool");

        assert_eq!(
            resolve_systemd_tool("systemctl", &[&first, &second]),
            second.join("systemctl")
        );
    }

    #[test]
    fn systemd_tool_uses_path_only_when_the_os_has_no_binary() {
        let temp = tempfile::tempdir().expect("temp dir");

        assert_eq!(
            resolve_systemd_tool("systemctl", &[temp.path()]),
            PathBuf::from("systemctl")
        );
    }

    #[test]
    fn systemd_version_parser_is_strict_and_suffix_tolerant() {
        assert_eq!(
            parse_systemd_version("systemd 254 (254.5-1)\n+PAM"),
            Some(254)
        );
        assert_eq!(parse_systemd_version("systemd 255\n"), Some(255));
        assert_eq!(parse_systemd_version("not-systemd 254\n"), None);
        assert_eq!(parse_systemd_version("systemd unknown\n"), None);
    }

    #[test]
    fn live_systemd_exec_start_requires_exact_binary_and_run_argv() {
        let binary = Path::new("/home/u/.local/bin/opengeni-agent");
        assert!(systemd_exec_start_matches(
            "{ path=/home/u/.local/bin/opengeni-agent ; argv[]=/home/u/.local/bin/opengeni-agent run ; ignore_errors=no ; }\n",
            binary,
        ));
        assert!(!systemd_exec_start_matches(
            "{ path=/home/u/.local/bin/opengeni-agent ; argv[]=/home/u/.local/bin/opengeni-agent run --extra ; ignore_errors=no ; }\n",
            binary,
        ));
        assert!(!systemd_exec_start_matches(
            "{ path=/tmp/opengeni-agent ; argv[]=/tmp/opengeni-agent run ; ignore_errors=no ; }\n",
            binary,
        ));
        let spaced = Path::new("/opt/Open Geni/opengeni-agent");
        assert!(systemd_exec_start_matches(
            "{ path=/opt/Open\\x20Geni/opengeni-agent ; argv[]=/opt/Open\\x20Geni/opengeni-agent\\srun ; ignore_errors=no ; }\n",
            spaced,
        ));
        assert!(!systemd_exec_start_matches(
            "{ path=/opt/Open\\x2Geni/opengeni-agent ; argv[]=/opt/Open\\x20Geni/opengeni-agent\\srun ; ignore_errors=no ; }\n",
            spaced,
        ));
        assert!(!systemd_exec_start_matches(
            "{ path=/home/u/.local/bin/opengeni-agent ; argv[]=/home/u/.local/bin/opengeni-agent run ; ignore_errors=no ; } ; { path=/tmp/other ; argv[]=/tmp/other ; ignore_errors=no ; }\n",
            binary,
        ));
    }

    #[test]
    fn systemd_cgroup_migration_accepts_only_root_or_single_supervisor_leaf() {
        assert_eq!(
            managed_systemd_cgroup(
                "/user.slice/user-1000.slice/user@1000.service/app.slice/opengeni-agent.service"
            ),
            Some(ManagedSystemdCgroup::ServiceRoot)
        );
        assert_eq!(
            managed_systemd_cgroup(
                "/user.slice/user-1000.slice/user@1000.service/app.slice/opengeni-agent.service/supervisor"
            ),
            Some(ManagedSystemdCgroup::Supervisor)
        );
        assert_eq!(
            managed_systemd_cgroup(
                "/user.slice/user-1000.slice/user@1000.service/app.slice/opengeni-agent.service/supervisor/nested"
            ),
            None
        );
        assert_eq!(managed_systemd_cgroup("/system.slice/custom.service"), None);
    }

    #[test]
    fn systemd_fragment_path_comparison_decodes_manager_escaping_only() {
        assert!(systemd_show_path_matches(
            "/opt/Open\\x20Geni/opengeni-agent.service\n",
            Path::new("/opt/Open Geni/opengeni-agent.service")
        ));
        assert!(!systemd_show_path_matches(
            "/opt/Open\\qGeni/opengeni-agent.service\n",
            Path::new("/opt/Open Geni/opengeni-agent.service")
        ));
    }

    #[test]
    fn only_exact_generated_systemd_definitions_are_owned() {
        let spec = ServiceSpec {
            binary_path: PathBuf::from("/home/u/.local/bin/opengeni-agent"),
            args: vec!["run".to_string()],
            scope: ServiceScope::User,
            environment_path: Some("/usr/bin:/bin".to_string()),
        };
        let legacy = service::render_legacy_systemd_unit_before_supervisor_subgroup(&spec);
        let current = service::render_systemd_unit(&spec);
        assert_eq!(
            managed_systemd_definition(&legacy, &spec),
            ManagedSystemdDefinition::LegacyOwned
        );
        assert_eq!(
            managed_systemd_definition(&current, &spec),
            ManagedSystemdDefinition::CurrentOwned
        );

        let custom = legacy.replace("MemoryMax=infinity", "MemoryMax=8G");
        assert_eq!(
            managed_systemd_definition(&custom, &spec),
            ManagedSystemdDefinition::Unowned
        );
        let forged_marker = format!("# X-OpenGeni-Managed-Service=v2\n{custom}");
        assert_eq!(
            managed_systemd_definition(&forged_marker, &spec),
            ManagedSystemdDefinition::Unowned,
            "a marker alone must never adopt a custom unit"
        );
    }

    #[test]
    fn legacy_control_dropin_cleanup_requires_exact_known_property() {
        let generated = "# This is a drop-in unit file extension, created via systemctl.\n\
                         [Service]\nMemoryMax=infinity\n";
        assert!(legacy_opengeni_control_dropin(
            "50-MemoryMax.conf",
            generated
        ));
        assert!(!legacy_opengeni_control_dropin(
            "50-MemoryMax.conf",
            "[Service]\nMemoryMax=8G\n"
        ));
        assert!(!legacy_opengeni_control_dropin(
            "50-MemoryMax.conf",
            "[Service]\nMemoryMax=infinity\nCPUWeight=200\n"
        ));
        assert!(!legacy_opengeni_control_dropin("operator.conf", generated));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn atomic_owned_unit_upgrade_and_rollback_are_retry_safe_and_preserve_drop_ins() {
        let root = tempfile::tempdir().expect("temp service root");
        let unit = root.path().join(service::ids::SYSTEMD_UNIT);
        let drop_in_dir = root
            .path()
            .join(format!("{}.d", service::ids::SYSTEMD_UNIT));
        std::fs::create_dir(&drop_in_dir).expect("drop-in directory");
        let drop_in = drop_in_dir.join("operator.conf");
        std::fs::write(&drop_in, "[Service]\nMemoryMax=8G\n").expect("custom drop-in");
        std::fs::write(&unit, "legacy").expect("legacy unit");

        atomic_replace_managed_unit(&unit, "current").expect("atomic upgrade");
        assert_eq!(std::fs::read_to_string(&unit).unwrap(), "current");
        assert_eq!(
            std::fs::read_to_string(&drop_in).unwrap(),
            "[Service]\nMemoryMax=8G\n"
        );

        atomic_replace_managed_unit(&unit, "legacy").expect("rollback legacy bytes");
        assert_eq!(std::fs::read_to_string(&unit).unwrap(), "legacy");
        atomic_replace_managed_unit(&unit, "current").expect("retry upgrade");
        assert_eq!(std::fs::read_to_string(&unit).unwrap(), "current");
        assert_eq!(
            std::fs::read_to_string(&drop_in).unwrap(),
            "[Service]\nMemoryMax=8G\n"
        );
    }
}
