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

use opengeni_agent_platform::service::{self, ServiceBackend, ServiceScope, ServiceSpec};
use tracing::info;

use crate::cli::{ServiceAction, ServiceArgs, ServiceInstallArgs, ServiceScopeArgs, StartArgs};

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

fn spec_for(install_scope: ServiceScope) -> Result<ServiceSpec, String> {
    Ok(ServiceSpec {
        binary_path: binary_path()?,
        args: vec!["run".to_string()],
        scope: install_scope,
        environment_path: std::env::var("PATH").ok().filter(|value| !value.is_empty()),
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
    }
}

/// Linux: write the user (or system) unit, reload systemd, enable+start it, and —
/// for a user unit — enable lingering so it survives logout / boots without a
/// session. This is the concrete, testable live path.
fn install_systemd(spec: &ServiceSpec, restart: bool) -> Result<(), String> {
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
            reset_systemd_aggregate_limits(ServiceScope::User)?;
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
            reset_systemd_aggregate_limits(ServiceScope::System)?;
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

/// Clears obsolete whole-service resource properties left by early agent
/// releases. Those properties include the supervisor itself and therefore break
/// the current architecture. Optional operator policy belongs on per-operation
/// leaves; the service aggregate is deliberately unlimited.
fn reset_systemd_aggregate_limits(install_scope: ServiceScope) -> Result<(), String> {
    let properties = [
        "set-property",
        service::ids::SYSTEMD_UNIT,
        "MemoryHigh=infinity",
        "MemoryMax=infinity",
        "TasksMax=infinity",
        "CPUQuota=",
    ];
    match install_scope {
        ServiceScope::User => {
            let mut args = vec!["--user"];
            args.extend(properties);
            systemctl(&args)
        }
        ServiceScope::System => systemctl(&properties),
    }
}

/// macOS: write the LaunchAgent plist and bootstrap it into the user's GUI session.
fn install_launchd(spec: &ServiceSpec, restart: bool) -> Result<(), String> {
    let plist_path = service::launchd_plist_path(&home()?);
    let body = service::render_launchd_plist(spec);
    if let Some(parent) = plist_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    std::fs::write(&plist_path, body)
        .map_err(|e| format!("write {}: {e}", plist_path.display()))?;
    info!(path = %plist_path.display(), "wrote LaunchAgent plist");

    let uid = unsafe_uid();
    let domain = format!("gui/{uid}");
    let target = format!("{domain}/{}", service::ids::LAUNCHD_LABEL);
    if capture("launchctl", &["print", &target]).is_ok() {
        if restart {
            run_tool("launchctl", &["kickstart", "-k", &target])?;
        }
    } else {
        run_tool(
            "launchctl",
            &["bootstrap", &domain, &plist_path.to_string_lossy()],
        )?;
    }
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
}
