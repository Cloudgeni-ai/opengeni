//! The opt-in always-on service manager (dossier §23.0/§23.1).
//!
//! FOREGROUND `opengeni-agent run` is the DEFAULT (the machine is online while it
//! runs). A service is an EXPLICIT OPT-IN (`opengeni-agent service install`) for a
//! genuinely dedicated machine — a build box, a CI Mac mini. This module is the
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
//!   * **Windows** — a true Windows Service (`OpengeniAgent`) via the SCM, with
//!     restart-on-failure recovery + Automatic-(Delayed) start. Structured +
//!     compiling; the registration command is generated + tested.
//!
//! The coarse outer restart loop (the service manager) sits ABOVE the in-process
//! full-jitter backoff (the fine loop) — two independent layers of resiliency.

use std::path::PathBuf;

use crate::error::{PlatformError, PlatformResult};

/// Which OS service backend to target. Resolved from the compile-time target by
/// [`ServiceSpec::for_host`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceBackend {
    /// systemd (Linux).
    Systemd,
    /// launchd (macOS).
    Launchd,
    /// the Windows Service Control Manager.
    WindowsScm,
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
            ServiceBackend::WindowsScm
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
    /// The Windows Service name (Windows).
    pub const WINDOWS_SERVICE: &str = "OpengeniAgent";
}

/// Renders the systemd unit-file body for `spec`. PURE (no IO) so it is fully
/// unit-tested; `service install` writes this to the unit path and the `--print`
/// mode dumps it.
#[must_use]
pub fn render_systemd_unit(spec: &ServiceSpec) -> String {
    let exec = exec_line(&spec.binary_path, &spec.args);
    let wanted_by = match spec.scope {
        ServiceScope::User => "default.target",
        ServiceScope::System => "multi-user.target",
    };
    format!(
        "[Unit]\n\
         Description=OpenGeni self-hosted agent\n\
         Documentation=https://get.opengeni.ai\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         # Don't hammer on a crash-loop; the in-process backoff is the fine loop.\n\
         StartLimitIntervalSec=60\n\
         StartLimitBurst=5\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={exec}\n\
         Restart=always\n\
         RestartSec=5\n\
         # A clean stop sends SIGTERM so the agent emits its going-offline message.\n\
         KillSignal=SIGTERM\n\
         TimeoutStopSec=15\n\
         # OOM fate isolation (issue #345). Delegate a cgroup subtree so the agent can\n\
         # place each host exec in its own memory sub-cgroup (see cgroup.rs), keeping a\n\
         # runaway command from making the heartbeat/control supervisor the OOM victim.\n\
         # ManagedOOMPreference=avoid biases systemd-oomd away from selecting this unit\n\
         # for a whole-unit kill; MemoryHigh throttles the unit under sustained\n\
         # pressure (and turns on the memory accounting the delegated sub-cgroups need)\n\
         # instead of letting the kernel SIGKILL the supervisor. Linux-only directives;\n\
         # they are inert on the macOS/Windows service backends.\n\
         Delegate=yes\n\
         ManagedOOMPreference=avoid\n\
         MemoryHigh=75%\n\
         \n\
         [Install]\n\
         WantedBy={wanted_by}\n"
    )
}

/// Renders the macOS LaunchAgent plist body for `spec`. PURE + tested.
#[must_use]
pub fn render_launchd_plist(spec: &ServiceSpec) -> String {
    let mut args = vec![spec.binary_path.to_string_lossy().into_owned()];
    args.extend(spec.args.iter().cloned());
    let program_args = args
        .iter()
        .map(|a| format!("    <string>{}</string>", xml_escape(a)))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
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
         \x20 <key>RunAtLoad</key>\n\
         \x20 <true/>\n\
         \x20 <key>KeepAlive</key>\n\
         \x20 <true/>\n\
         \x20 <key>ThrottleInterval</key>\n\
         \x20 <integer>5</integer>\n\
         </dict>\n\
         </plist>\n",
        label = ids::LAUNCHD_LABEL,
        program_args = program_args,
    )
}

/// Renders the `sc.exe create` command line registering the Windows Service. The
/// recovery action (`sc failure … restart`) is a separate command, returned by
/// [`windows_recovery_command`]. PURE + tested.
#[must_use]
pub fn windows_create_command(spec: &ServiceSpec) -> String {
    let bin = spec.binary_path.to_string_lossy();
    let args = spec.args.join(" ");
    // binPath embeds the binary + its run args; Automatic-Delayed start; the
    // service hosts itself via the windows-service crate's service_dispatcher.
    format!(
        "sc.exe create {name} binPath= \"\\\"{bin}\\\" {args}\" start= delayed-auto DisplayName= \"OpenGeni Agent\"",
        name = ids::WINDOWS_SERVICE,
    )
}

/// The `sc.exe failure` recovery command (restart on failure with a 5s delay).
#[must_use]
pub fn windows_recovery_command() -> String {
    format!(
        "sc.exe failure {name} reset= 0 actions= restart/5000/restart/5000/restart/5000",
        name = ids::WINDOWS_SERVICE,
    )
}

/// The systemd unit path for a scope.
#[must_use]
pub fn systemd_unit_path(scope: ServiceScope, home: &std::path::Path) -> PathBuf {
    match scope {
        ServiceScope::User => home.join(".config/systemd/user").join(ids::SYSTEMD_UNIT),
        ServiceScope::System => PathBuf::from("/etc/systemd/system").join(ids::SYSTEMD_UNIT),
    }
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

/// A not-yet-supported service backend error (a target with no service manager).
#[must_use]
pub fn unsupported_backend() -> PlatformError {
    PlatformError::Unsupported(
        "no supported service manager on this platform (use the foreground `run`)".to_string(),
    )
}

/// Convenience: the rendered service definition for the host backend, or an
/// [`PlatformError::Unsupported`] on an unsupported target. Used by `service
/// install --print`.
///
/// # Errors
///
/// [`PlatformError::Unsupported`] when the host has no supported service manager.
pub fn render_for_host(spec: &ServiceSpec) -> PlatformResult<String> {
    match ServiceSpec::backend() {
        ServiceBackend::Systemd => Ok(render_systemd_unit(spec)),
        ServiceBackend::Launchd => Ok(render_launchd_plist(spec)),
        ServiceBackend::WindowsScm => Ok(format!(
            "{}\n{}",
            windows_create_command(spec),
            windows_recovery_command()
        )),
        ServiceBackend::Unsupported => Err(unsupported_backend()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> ServiceSpec {
        ServiceSpec {
            binary_path: PathBuf::from("/home/u/.local/bin/opengeni-agent"),
            args: vec!["run".to_string()],
            scope: ServiceScope::User,
        }
    }

    #[test]
    fn systemd_unit_has_the_required_directives() {
        let unit = render_systemd_unit(&spec());
        assert!(unit.contains("ExecStart=/home/u/.local/bin/opengeni-agent run"));
        assert!(unit.contains("Restart=always"));
        assert!(unit.contains("WantedBy=default.target"));
        assert!(
            unit.contains("KillSignal=SIGTERM"),
            "clean stop must SIGTERM for going-offline"
        );
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
    fn systemd_unit_carries_oom_fate_isolation_directives_in_both_scopes() {
        // Issue #345: both the user and the system unit must delegate a cgroup
        // subtree, bias systemd-oomd away from a whole-unit kill, and set a memory
        // high-watermark (which also enables the accounting the sub-cgroups need).
        // These live in [Service], never [Unit] or [Install].
        for scope in [ServiceScope::User, ServiceScope::System] {
            let mut s = spec();
            s.scope = scope;
            let unit = render_systemd_unit(&s);
            let service_start = unit.find("[Service]").expect("service section");
            let install_start = unit.find("[Install]").expect("install section");
            let service_section = &unit[service_start..install_start];
            for directive in [
                "Delegate=yes",
                "ManagedOOMPreference=avoid",
                "MemoryHigh=75%",
            ] {
                assert!(
                    service_section.contains(directive),
                    "{scope:?} unit [Service] must contain {directive}; got:\n{unit}"
                );
            }
        }
    }

    #[test]
    fn systemd_unit_path_is_scope_aware() {
        let home = std::path::Path::new("/home/u");
        assert_eq!(
            systemd_unit_path(ServiceScope::User, home),
            PathBuf::from("/home/u/.config/systemd/user/opengeni-agent.service")
        );
        assert_eq!(
            systemd_unit_path(ServiceScope::System, home),
            PathBuf::from("/etc/systemd/system/opengeni-agent.service")
        );
    }

    #[test]
    fn launchd_plist_is_a_keepalive_runatload_agent() {
        let plist = render_launchd_plist(&spec());
        assert!(plist.contains("<string>ai.opengeni.agent</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("<key>KeepAlive</key>"));
        assert!(plist.contains("<string>/home/u/.local/bin/opengeni-agent</string>"));
        assert!(plist.contains("<string>run</string>"));
    }

    #[test]
    fn launchd_plist_path_is_a_user_launchagent() {
        let p = launchd_plist_path(std::path::Path::new("/Users/u"));
        assert_eq!(
            p,
            PathBuf::from("/Users/u/Library/LaunchAgents/ai.opengeni.agent.plist")
        );
    }

    #[test]
    fn windows_commands_register_and_set_recovery() {
        let create = windows_create_command(&spec());
        assert!(create.contains("sc.exe create OpengeniAgent"));
        assert!(create.contains("start= delayed-auto"));
        assert!(create.contains("opengeni-agent"));
        let recovery = windows_recovery_command();
        assert!(recovery.contains("sc.exe failure OpengeniAgent"));
        assert!(recovery.contains("restart/5000"));
    }

    #[test]
    fn plist_escapes_xml_metacharacters() {
        let mut s = spec();
        s.args = vec!["run".to_string(), "--name".to_string(), "a<b&c".to_string()];
        let plist = render_launchd_plist(&s);
        assert!(plist.contains("a&lt;b&amp;c"));
        assert!(!plist.contains("a<b&c"));
    }

    #[test]
    fn render_for_host_matches_the_compiled_backend() {
        // On the build host this returns the host's definition without error.
        let out = render_for_host(&spec());
        match ServiceSpec::backend() {
            ServiceBackend::Unsupported => assert!(out.is_err()),
            _ => assert!(out.is_ok()),
        }
    }
}
