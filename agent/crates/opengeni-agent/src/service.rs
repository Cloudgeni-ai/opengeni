//! The opt-in service install/uninstall/start/stop/status handlers.
//!
//! The default supported model is FOREGROUND `run`; this is the explicit opt-in
//! (dossier §23.0/§23.1). The cross-platform service mechanism lives in
//! [`opengeni_agent_platform::service`] (one trait, cargo-unit-tested); this module
//! is the thin binary-side glue that resolves the installed binary path, writes the
//! rendered unit/plist, and drives the platform service tool (`systemctl` /
//! `launchctl`). Linux is the concrete live path and macOS uses a user LaunchAgent.
//! Windows deliberately returns unsupported for every action: the foreground
//! `run` process is not an SCM service host, and registering it would be false.

use std::path::PathBuf;
use std::process::{Command, ExitStatus};

use opengeni_agent_platform::service::{self, ServiceBackend, ServiceScope, ServiceSpec};
use tracing::info;

use crate::cli::{
    ServiceAction, ServiceArgs, ServiceInstallArgs, ServiceLogsArgs, ServiceScopeArgs,
};

/// Dispatches a `service` subcommand. Returns a human-facing result string on
/// success or an error message on failure.
pub fn run(args: &ServiceArgs) -> Result<(), String> {
    info!(action = args.action.label(), "service subcommand");
    ensure_supported_service_backend(ServiceSpec::backend())?;
    match &args.action {
        ServiceAction::Install(a) => install(a),
        ServiceAction::Uninstall(a) => uninstall(scope(a)),
        ServiceAction::Start(a) => lifecycle("start", scope(a)),
        ServiceAction::Stop(a) => lifecycle("stop", scope(a)),
        ServiceAction::Status(a) => status(scope(a)),
        ServiceAction::Logs(a) => logs(a),
    }
}

fn ensure_supported_service_backend(backend: ServiceBackend) -> Result<(), String> {
    if backend == ServiceBackend::WindowsScm {
        return Err(windows_service_error());
    }
    Ok(())
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

fn spec_for(install_scope: ServiceScope) -> Result<ServiceSpec, String> {
    let home = home()?;
    Ok(ServiceSpec {
        binary_path: binary_path()?,
        args: vec!["run".to_string()],
        scope: install_scope,
        log_dir: Some(service::launchd_log_dir(&home)),
    })
}

/// `service install` — write the rendered unit/plist + enable it. `--print` is a
/// dry-run that dumps the definition and exits without touching the system.
fn install(args: &ServiceInstallArgs) -> Result<(), String> {
    let install_scope = if args.system {
        ServiceScope::System
    } else {
        ServiceScope::User
    };
    // Do this before `--print` too: dry-run output must never normalize a
    // forbidden LaunchDaemon/system-scope configuration as supported.
    if ServiceSpec::backend() == ServiceBackend::Launchd {
        require_launchagent_scope(install_scope)?;
    }
    let spec = spec_for(install_scope)?;

    if args.print {
        let definition = service::render_for_host(&spec).map_err(|e| e.to_string())?;
        println!("{definition}");
        return Ok(());
    }

    match ServiceSpec::backend() {
        ServiceBackend::Systemd => install_systemd(&spec),
        ServiceBackend::Launchd => install_launchd(&spec),
        ServiceBackend::WindowsScm => install_windows(&spec),
        ServiceBackend::Unsupported => Err(service::unsupported_backend().to_string()),
    }
}

/// Linux: write the user (or system) unit, reload systemd, enable+start it, and —
/// for a user unit — enable lingering so it survives logout / boots without a
/// session. This is the concrete, testable live path.
fn install_systemd(spec: &ServiceSpec) -> Result<(), String> {
    let unit_path = service::systemd_unit_path(spec.scope, &home()?);
    let body = service::render_systemd_unit(spec);
    if let Some(parent) = unit_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    std::fs::write(&unit_path, body).map_err(|e| format!("write {}: {e}", unit_path.display()))?;
    info!(path = %unit_path.display(), "wrote systemd unit");

    match spec.scope {
        ServiceScope::User => {
            systemctl(&["--user", "daemon-reload"])?;
            // Linger so the user service runs without an active login session.
            if let Ok(user) = std::env::var("USER") {
                let _ = run_tool("loginctl", &["enable-linger", &user]);
            }
            systemctl(&["--user", "enable", "--now", service::ids::SYSTEMD_UNIT])?;
        }
        ServiceScope::System => {
            systemctl(&["daemon-reload"])?;
            systemctl(&["enable", "--now", service::ids::SYSTEMD_UNIT])?;
        }
    }
    println!(
        "installed + started the opengeni-agent service ({} scope).",
        scope_label(spec.scope)
    );
    Ok(())
}

/// macOS: write the LaunchAgent plist and bootstrap it into the user's GUI session.
fn install_launchd(spec: &ServiceSpec) -> Result<(), String> {
    require_launchagent_scope(spec.scope)?;
    let plist_path = service::launchd_plist_path(&home()?);
    let uid = unsafe_uid();
    // KeepAlive jobs are replaced by unloading the exact plist before it is
    // rewritten. A genuinely absent job is idempotent; every other launchctl
    // failure is ambiguous and preserves the prior plist for recovery.
    let bootout = service::launchctl_bootout_args(&uid, &plist_path);
    run_tool_owned_allow_absent("launchctl", &bootout)?;

    let body = service::render_launchd_plist(spec);
    if let Some(parent) = plist_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    std::fs::write(&plist_path, body)
        .map_err(|e| format!("write {}: {e}", plist_path.display()))?;
    info!(path = %plist_path.display(), "wrote LaunchAgent plist");

    let log_dir = spec
        .log_dir
        .as_ref()
        .expect("launchd log dir is configured");
    std::fs::create_dir_all(log_dir).map_err(|e| format!("mkdir {}: {e}", log_dir.display()))?;
    let bootstrap = service::launchctl_bootstrap_args(&uid, &plist_path);
    run_tool_owned("launchctl", &bootstrap)?;
    println!(
        "installed the opengeni-agent LaunchAgent at {}.",
        plist_path.display()
    );
    Ok(())
}

/// Windows service hosting is absent. This pure, portable contract lets Linux CI
/// prove the Windows branch fails before `sc.exe` could be spawned; a native
/// Windows compile proves compatibility, not live SCM service behavior.
fn install_windows(_spec: &ServiceSpec) -> Result<(), String> {
    Err(windows_service_error())
}

fn uninstall(_requested_scope: ServiceScope) -> Result<(), String> {
    match ServiceSpec::backend() {
        ServiceBackend::Systemd => uninstall_systemd_all_scopes(),
        ServiceBackend::Launchd => uninstall_launchd(),
        ServiceBackend::WindowsScm => Err(windows_service_error()),
        ServiceBackend::Unsupported => Err(service::unsupported_backend().to_string()),
    }
}

/// The POSIX installer does not retain which systemd scope was selected, so an
/// uninstall probes BOTH canonical unit paths. Each scope is attempted even when
/// the other fails, and the deterministic aggregate remains an error until every
/// installed scope was confirmed disabled and removed.
fn uninstall_systemd_all_scopes() -> Result<(), String> {
    let results = [ServiceScope::User, ServiceScope::System]
        .into_iter()
        .map(|scope| (scope, uninstall_systemd_scope(scope)))
        .collect::<Vec<_>>();
    aggregate_scope_cleanup(&results)?;
    println!("uninstalled the opengeni-agent service from all installed systemd scopes.");
    Ok(())
}

fn uninstall_systemd_scope(scope: ServiceScope) -> Result<(), String> {
    let home = if scope == ServiceScope::User {
        home()?
    } else {
        PathBuf::new()
    };
    let unit_path = service::systemd_unit_path(scope, &home);
    if !unit_path
        .try_exists()
        .map_err(|e| format!("inspect {}: {e}", unit_path.display()))?
    {
        return Ok(());
    }

    let disable = service::systemctl_disable_args(scope);
    run_tool_owned_allow_absent("systemctl", &disable)?;
    match std::fs::remove_file(&unit_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("remove {}: {error}", unit_path.display())),
    }
    let reload = service::systemctl_daemon_reload_args(scope);
    run_tool_owned("systemctl", &reload)
}

fn aggregate_scope_cleanup(results: &[(ServiceScope, Result<(), String>)]) -> Result<(), String> {
    let failures = results
        .iter()
        .filter_map(|(scope, result)| {
            result
                .as_ref()
                .err()
                .map(|error| format!("{} scope: {error}", scope_label(*scope)))
        })
        .collect::<Vec<_>>();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "service cleanup was not confirmed; {}",
            failures.join("; ")
        ))
    }
}

fn uninstall_launchd() -> Result<(), String> {
    let plist_path = service::launchd_plist_path(&home()?);
    let uid = unsafe_uid();
    let args = service::launchctl_bootout_args(&uid, &plist_path);
    run_tool_owned_allow_absent("launchctl", &args)?;
    match std::fs::remove_file(&plist_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("remove {}: {error}", plist_path.display())),
    }
    println!("uninstalled the opengeni-agent LaunchAgent.");
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
            require_launchagent_scope(install_scope)?;
            let uid = unsafe_uid();
            let plist = service::launchd_plist_path(&home()?);
            if action == "start" {
                let print = service::launchctl_print_args(&uid);
                let refs = print.iter().map(String::as_str).collect::<Vec<_>>();
                let current = invoke("launchctl", &refs)?;
                if !current.status.success() && !output_indicates_absent(&current) {
                    return Err(tool_failure("launchctl", &refs, &current));
                }
                if !current.status.success() {
                    let bootstrap = service::launchctl_bootstrap_args(&uid, &plist);
                    run_tool_owned("launchctl", &bootstrap)?;
                }
            } else {
                let bootout = service::launchctl_bootout_args(&uid, &plist);
                run_tool_owned_allow_absent("launchctl", &bootout)?;
            }
            println!("{action}ed the opengeni-agent LaunchAgent.");
            Ok(())
        }
        ServiceBackend::WindowsScm => Err(windows_service_error()),
        ServiceBackend::Unsupported => Err(service::unsupported_backend().to_string()),
    }
}

fn status(install_scope: ServiceScope) -> Result<(), String> {
    match ServiceSpec::backend() {
        ServiceBackend::Systemd => {
            let unit = service::ids::SYSTEMD_UNIT;
            let args = match install_scope {
                ServiceScope::User => vec!["--user", "is-active", unit],
                ServiceScope::System => vec!["is-active", unit],
            };
            let out = invoke("systemctl", &args)?;
            let state = out.stdout.trim();
            if out.status.success()
                || matches!(state, "inactive" | "failed" | "activating" | "deactivating")
            {
                println!("opengeni-agent service: {state}");
                Ok(())
            } else if output_indicates_absent(&out) || state == "unknown" {
                println!("opengeni-agent service: not installed");
                Ok(())
            } else {
                Err(tool_failure("systemctl", &args, &out))
            }
        }
        ServiceBackend::Launchd => {
            require_launchagent_scope(install_scope)?;
            let args = service::launchctl_print_args(&unsafe_uid());
            let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
            let out = invoke("launchctl", &refs)?;
            if out.status.success() {
                println!("opengeni-agent LaunchAgent: loaded");
                Ok(())
            } else if output_indicates_absent(&out) {
                println!("opengeni-agent LaunchAgent: not loaded");
                Ok(())
            } else {
                Err(tool_failure("launchctl", &refs, &out))
            }
        }
        ServiceBackend::WindowsScm => Err(windows_service_error()),
        ServiceBackend::Unsupported => Err(service::unsupported_backend().to_string()),
    }
}

fn logs(args: &ServiceLogsArgs) -> Result<(), String> {
    let install_scope = scope(&args.scope);
    match ServiceSpec::backend() {
        ServiceBackend::Systemd => {
            let command = service::journalctl_args(install_scope, args.lines, args.follow);
            run_tool_owned("journalctl", &command)
        }
        ServiceBackend::Launchd => {
            require_launchagent_scope(install_scope)?;
            let command = service::launchd_tail_args(
                &service::launchd_log_dir(&home()?),
                args.lines,
                args.follow,
            );
            run_tool_owned("tail", &command)
        }
        ServiceBackend::WindowsScm => Err(windows_service_error()),
        ServiceBackend::Unsupported => Err(service::unsupported_backend().to_string()),
    }
}

fn require_launchagent_scope(scope: ServiceScope) -> Result<(), String> {
    if scope == ServiceScope::System {
        Err("macOS supports only the logged-in user's Aqua LaunchAgent; --system/LaunchDaemon scope is intentionally unsupported".to_string())
    } else {
        Ok(())
    }
}

fn windows_service_error() -> String {
    service::windows_service_unsupported().to_string()
}

fn scope_label(s: ServiceScope) -> &'static str {
    match s {
        ServiceScope::User => "user",
        ServiceScope::System => "system",
    }
}

/// Captured tool result used to distinguish a genuinely absent service from
/// permission, bus, and unknown failures. The latter must fail closed.
#[derive(Debug)]
struct ToolOutput {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

fn invoke(tool: &str, args: &[&str]) -> Result<ToolOutput, String> {
    let out = Command::new(tool)
        .args(args)
        .output()
        .map_err(|e| format!("could not run {tool}: {e}"))?;
    Ok(ToolOutput {
        status: out.status,
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

fn output_indicates_absent(out: &ToolOutput) -> bool {
    let text = format!("{}\n{}", out.stdout, out.stderr).to_ascii_lowercase();
    [
        "not loaded",
        "not found",
        "could not find service",
        "could not be found",
        "does not exist",
        "no such file or directory",
    ]
    .iter()
    .any(|marker| text.contains(marker))
}

fn tool_failure(tool: &str, args: &[&str], out: &ToolOutput) -> String {
    let detail = if out.stderr.trim().is_empty() {
        out.stdout.trim()
    } else {
        out.stderr.trim()
    };
    if detail.is_empty() {
        format!("{tool} {args:?} exited with {}", out.status)
    } else {
        format!("{tool} {args:?} exited with {}: {detail}", out.status)
    }
}

/// Runs `systemctl` with args, mapping a non-zero exit to an error string.
fn systemctl(args: &[&str]) -> Result<(), String> {
    run_tool("systemctl", args)
}

/// Runs an external tool, erroring on a non-zero exit or a spawn failure.
fn run_tool(tool: &str, args: &[&str]) -> Result<(), String> {
    let out = invoke(tool, args)?;
    if out.status.success() {
        Ok(())
    } else {
        Err(tool_failure(tool, args, &out))
    }
}

fn run_tool_owned(tool: &str, args: &[String]) -> Result<(), String> {
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_tool(tool, &refs)
}

fn run_tool_owned_allow_absent(tool: &str, args: &[String]) -> Result<(), String> {
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let out = invoke(tool, &refs)?;
    if out.status.success() || output_indicates_absent(&out) {
        Ok(())
    } else {
        Err(tool_failure(tool, &refs, &out))
    }
}

/// Runs an external tool and captures its stdout.
fn capture(tool: &str, args: &[&str]) -> Result<String, String> {
    let out = invoke(tool, args)?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(tool_failure(tool, args, &out))
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
    fn launchagent_system_scope_error_is_explicit() {
        let error = require_launchagent_scope(ServiceScope::System).expect_err("system scope");
        assert!(error.contains("Aqua LaunchAgent"));
        assert!(error.contains("LaunchDaemon"));
    }

    #[test]
    fn windows_service_install_is_an_exact_side_effect_free_rejection() {
        let spec = ServiceSpec {
            binary_path: PathBuf::from(r"C:\Program Files\OpenGeni\opengeni-agent.exe"),
            args: vec!["run".to_string()],
            scope: ServiceScope::User,
            log_dir: None,
        };
        let error = install_windows(&spec).expect_err("Windows service must stay unsupported");
        assert_eq!(error, windows_service_error());
        assert!(error.contains("no service was registered or changed"));
        assert!(error.contains("opengeni-agent run"));
        assert!(!error.contains("sc.exe create"));
    }

    #[test]
    fn windows_service_dispatch_rejects_every_action_before_handler_work() {
        let error = ensure_supported_service_backend(ServiceBackend::WindowsScm)
            .expect_err("Windows service dispatch must fail before action handling");
        assert_eq!(error, windows_service_error());
        assert!(ensure_supported_service_backend(ServiceBackend::Systemd).is_ok());
        assert!(ensure_supported_service_backend(ServiceBackend::Launchd).is_ok());
    }

    #[cfg(unix)]
    fn output(code: i32, stdout: &str, stderr: &str) -> ToolOutput {
        use std::os::unix::process::ExitStatusExt;
        ToolOutput {
            status: ExitStatus::from_raw(code << 8),
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
        }
    }

    #[cfg(unix)]
    #[test]
    fn absence_classifier_never_masks_bus_or_permission_failures() {
        assert!(output_indicates_absent(&output(
            5,
            "",
            "Could not find service"
        )));
        assert!(output_indicates_absent(&output(
            5,
            "",
            "Unit file does not exist"
        )));
        assert!(!output_indicates_absent(&output(
            1,
            "",
            "Failed to connect to bus"
        )));
        assert!(!output_indicates_absent(&output(
            1,
            "",
            "Permission denied"
        )));
    }

    #[test]
    fn dual_scope_cleanup_errors_are_aggregated_in_stable_order() {
        let results = vec![
            (ServiceScope::User, Err("user bus unavailable".to_string())),
            (ServiceScope::System, Err("permission denied".to_string())),
        ];
        assert_eq!(
            aggregate_scope_cleanup(&results),
            Err("service cleanup was not confirmed; user scope: user bus unavailable; system scope: permission denied".to_string())
        );
        assert!(aggregate_scope_cleanup(&[
            (ServiceScope::User, Ok(())),
            (ServiceScope::System, Ok(())),
        ])
        .is_ok());
    }
}
