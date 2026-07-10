//! The opt-in service install/uninstall/start/stop/status handlers.
//!
//! The default supported model is FOREGROUND `run`; this is the explicit opt-in
//! (dossier §23.0/§23.1). The cross-platform service mechanism lives in
//! [`opengeni_agent_platform::service`] (one trait, cargo-unit-tested); this module
//! is the thin binary-side glue that resolves the installed binary path, writes the
//! rendered unit/plist, and drives the platform service tool (`systemctl` /
//! `launchctl` / `sc.exe`). Linux is the concrete, live path; macOS/Windows write
//! the definition + print the activation commands (structured + compiling, finished
//! on their native runners).

use std::path::PathBuf;
use std::process::Command;

use opengeni_agent_platform::service::{self, ServiceBackend, ServiceScope, ServiceSpec};
use tracing::info;

use crate::cli::{
    ServiceAction, ServiceArgs, ServiceInstallArgs, ServiceLogsArgs, ServiceScopeArgs,
};

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
        ServiceAction::Logs(a) => logs(a),
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
    // Idempotent reinstall: unload a prior instance if present. A not-loaded
    // target is harmless; the following bootstrap is strict and must succeed.
    let uid = unsafe_uid();
    let bootout = service::launchctl_bootout_args(&uid, &plist_path);
    let _ = run_tool_owned("launchctl", &bootout);
    let bootstrap = service::launchctl_bootstrap_args(&uid, &plist_path);
    run_tool_owned("launchctl", &bootstrap)?;
    println!(
        "installed the opengeni-agent LaunchAgent at {}.",
        plist_path.display()
    );
    Ok(())
}

/// Windows: register the SCM service + set restart-on-failure recovery. The binary
/// hosts the SCM service via the windows-service crate on its native build. The
/// `Result` return is uniform with the other backends (it only ever fails on the
/// Windows build, where `sc.exe` can error).
#[cfg_attr(not(windows), allow(clippy::unnecessary_wraps))]
fn install_windows(spec: &ServiceSpec) -> Result<(), String> {
    // We invoke sc.exe with the rendered argument vectors. On non-Windows builds
    // this code is still compiled (so the surface never rots) but only runs on
    // Windows; the commands are exactly what `--print` shows.
    println!("{}", service::windows_create_command(spec));
    println!("{}", service::windows_recovery_command());
    #[cfg(windows)]
    {
        run_tool(
            "sc.exe",
            &[
                "create",
                service::ids::WINDOWS_SERVICE,
                "binPath=",
                &format!("\"{}\" run", spec.binary_path.to_string_lossy()),
                "start=",
                "delayed-auto",
            ],
        )?;
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
        run_tool("sc.exe", &["start", service::ids::WINDOWS_SERVICE])?;
    }
    println!("registered the OpengeniAgent Windows Service.");
    Ok(())
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
            let unit_path = service::systemd_unit_path(install_scope, &home()?);
            let _ = std::fs::remove_file(&unit_path);
            let _ = match install_scope {
                ServiceScope::User => systemctl(&["--user", "daemon-reload"]),
                ServiceScope::System => systemctl(&["daemon-reload"]),
            };
            println!("uninstalled the opengeni-agent service.");
            Ok(())
        }
        ServiceBackend::Launchd => {
            require_launchagent_scope(install_scope)?;
            let plist_path = service::launchd_plist_path(&home()?);
            let uid = unsafe_uid();
            let args = service::launchctl_bootout_args(&uid, &plist_path);
            let _ = run_tool_owned("launchctl", &args);
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
    }
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
            let args = if action == "start" {
                service::launchctl_kickstart_args(&uid)
            } else {
                service::launchctl_kill_args(&uid)
            };
            run_tool_owned("launchctl", &args)?;
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
                ServiceScope::User => capture("systemctl", &["--user", "is-active", unit]),
                ServiceScope::System => capture("systemctl", &["is-active", unit]),
            };
            match out {
                Ok(s) => println!("opengeni-agent service: {}", s.trim()),
                Err(_) => println!("opengeni-agent service: not installed"),
            }
            Ok(())
        }
        ServiceBackend::Launchd => {
            require_launchagent_scope(install_scope)?;
            let args = service::launchctl_print_args(&unsafe_uid());
            let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
            let out = capture("launchctl", &refs);
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

fn logs(args: &ServiceLogsArgs) -> Result<(), String> {
    let install_scope = scope(&args.scope);
    match ServiceSpec::backend() {
        ServiceBackend::Systemd => {
            let command = service::journalctl_args(install_scope, args.lines, args.follow);
            run_tool_owned("journalctl", &command)
        }
        ServiceBackend::Launchd => {
            require_launchagent_scope(install_scope)?;
            let command = service::launchd_tail_args(&service::launchd_log_dir(&home()?), args.lines, args.follow);
            run_tool_owned("tail", &command)
        }
        ServiceBackend::WindowsScm => Err("service logs are not supported on Windows; use Event Viewer or your configured service log collector".to_string()),
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

fn scope_label(s: ServiceScope) -> &'static str {
    match s {
        ServiceScope::User => "user",
        ServiceScope::System => "system",
    }
}

/// Runs `systemctl` with args, mapping a non-zero exit to an error string.
fn systemctl(args: &[&str]) -> Result<(), String> {
    run_tool("systemctl", args)
}

/// Runs an external tool, erroring on a non-zero exit or a spawn failure.
fn run_tool(tool: &str, args: &[&str]) -> Result<(), String> {
    let status = Command::new(tool)
        .args(args)
        .status()
        .map_err(|e| format!("could not run {tool}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{tool} {args:?} exited with {status}"))
    }
}

fn run_tool_owned(tool: &str, args: &[String]) -> Result<(), String> {
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_tool(tool, &refs)
}

/// Runs an external tool and captures its stdout.
fn capture(tool: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(tool)
        .args(args)
        .output()
        .map_err(|e| format!("could not run {tool}: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!("{tool} {args:?} exited with {}", out.status))
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
}
