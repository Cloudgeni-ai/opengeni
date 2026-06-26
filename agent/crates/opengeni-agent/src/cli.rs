//! The `opengeni-agent` command-line surface.
//!
//! Subcommands (dossier §23.0/§23.1/§23.2):
//!
//! * [`Command::Run`] — the DEFAULT, FOREGROUND run model: enroll-if-needed, then
//!   dial the control plane and serve until stopped. The machine is online while
//!   this runs and offline when it stops.
//! * [`Command::Enroll`] — the device-flow enrollment only (print a user-code +
//!   URL, poll to completion, persist credentials `0600`), then exit.
//! * [`Command::Service`] — the opt-in always-on daemon path (systemd-user /
//!   LaunchAgent / Windows Service). The default supported model is FOREGROUND
//!   `run`; this is the explicit opt-in for a dedicated machine.
//! * [`Command::Update`] — check for and apply a signed self-update (minisign +
//!   sha256 verify, atomic swap, rollback on a failed health gate).
//! * [`Command::Uninstall`] — stop any service, remove the binary, and (with
//!   `--purge`) delete credentials + deactivate the enrollment.

use clap::{Parser, Subcommand};

/// The OpenGeni self-hosted agent: run your own machine as a first-class OpenGeni
/// sandbox.
#[derive(Debug, Parser)]
#[command(name = "opengeni-agent", version, about, long_about = None)]
pub struct Cli {
    /// The subcommand to run. Defaults to `run` when omitted.
    #[command(subcommand)]
    pub command: Option<Command>,

    /// The control-plane API base URL used for enrollment (e.g.
    /// `https://api.opengeni.ai`). Falls back to `$OPENGENI_API_URL`.
    #[arg(long, global = true, env = "OPENGENI_API_URL")]
    pub api_url: Option<String>,
}

/// The agent subcommands.
#[derive(Debug, Subcommand)]
pub enum Command {
    /// Enroll if needed, then dial the control plane and serve in the foreground
    /// (the default). The machine is online while this process runs.
    Run(RunArgs),
    /// Run the device-flow enrollment only and persist credentials, then exit.
    Enroll(EnrollArgs),
    /// Manage the OPT-IN always-on service (install/uninstall/start/stop/status).
    ///
    /// The default, supported run model is FOREGROUND `opengeni-agent run`. A
    /// service (systemd user unit / macOS LaunchAgent / Windows Service) is for a
    /// genuinely dedicated machine (a build box, a CI Mac mini) — install it only
    /// if you want the agent to start on boot and run unattended.
    Service(ServiceArgs),
    /// Check for and apply a signed self-update for this channel + target.
    Update(UpdateArgs),
    /// Remove the agent: stop any service, delete the binary, and (with `--purge`)
    /// remove credentials + deactivate the enrollment.
    Uninstall(UninstallArgs),
}

impl Default for Command {
    fn default() -> Self {
        Self::Run(RunArgs::default())
    }
}

/// Arguments for the foreground `run` subcommand.
#[derive(Debug, Default, clap::Args)]
pub struct RunArgs {
    /// The update channel to follow when enrolling (`stable` or `beta`).
    #[arg(long, default_value = "stable")]
    pub channel: String,

    /// Override the machine name advertised to the control plane (defaults to the
    /// hostname).
    #[arg(long)]
    pub machine_name: Option<String>,

    /// Spawn an Xvfb virtual framebuffer so a HEADLESS Linux box exposes a desktop
    /// (off by default; dossier §3). On a host with a real display this is ignored.
    /// Linux-only.
    #[arg(long)]
    pub virtual_desktop: bool,

    /// The Xvfb display + geometry used by `--virtual-desktop` (e.g. `:99`).
    #[arg(long, default_value = ":99")]
    pub virtual_display: String,

    /// The virtual-desktop framebuffer geometry `WIDTHxHEIGHT`.
    #[arg(long, default_value = "1280x800")]
    pub virtual_geometry: String,
}

/// Arguments for the `enroll` subcommand.
#[derive(Debug, Default, clap::Args)]
pub struct EnrollArgs {
    /// The update channel to follow (`stable` or `beta`).
    #[arg(long, default_value = "stable")]
    pub channel: String,

    /// Override the machine name advertised to the control plane.
    #[arg(long)]
    pub machine_name: Option<String>,

    /// Re-enroll even if credentials already exist on disk.
    #[arg(long)]
    pub force: bool,

    /// A non-interactive enrollment token (CI/automation): skip the device flow
    /// and enroll directly. Pair with `--non-interactive`.
    #[arg(long, env = "OPENGENI_ENROLL_TOKEN")]
    pub token: Option<String>,

    /// Do not prompt or print a device-flow code; fail if a token is not provided.
    #[arg(long)]
    pub non_interactive: bool,
}

/// Arguments for the `service` subcommand (the opt-in always-on daemon).
#[derive(Debug, clap::Args)]
pub struct ServiceArgs {
    /// The service action to perform.
    #[command(subcommand)]
    pub action: ServiceAction,
}

/// The service lifecycle actions.
#[derive(Debug, Subcommand)]
pub enum ServiceAction {
    /// Install + enable the always-on service (writes the unit/plist/registration
    /// and enables it). The default is a per-user service (no root).
    Install(ServiceInstallArgs),
    /// Uninstall the service (disable + remove the unit/plist/registration).
    Uninstall(ServiceScopeArgs),
    /// Start the installed service.
    Start(ServiceScopeArgs),
    /// Stop the running service.
    Stop(ServiceScopeArgs),
    /// Report the service status.
    Status(ServiceScopeArgs),
}

/// Arguments for `service install`.
#[derive(Debug, Default, clap::Args)]
pub struct ServiceInstallArgs {
    /// Install a system-wide service (Linux `/etc/systemd/system`, needs root)
    /// instead of the default per-user service.
    #[arg(long)]
    pub system: bool,

    /// Print the generated service definition (systemd unit / launchd plist /
    /// Windows registration commands) and exit WITHOUT touching the system — a
    /// dry-run so you can review exactly what would be installed.
    #[arg(long)]
    pub print: bool,
}

/// Shared scope argument for the non-install service actions.
#[derive(Debug, Default, clap::Args)]
pub struct ServiceScopeArgs {
    /// Operate on the system-wide service rather than the per-user one (Linux).
    #[arg(long)]
    pub system: bool,
}

/// Arguments for the `update` subcommand.
#[derive(Debug, Default, clap::Args)]
pub struct UpdateArgs {
    /// Only CHECK whether a newer build is available (verify the manifest), do not
    /// download or apply.
    #[arg(long)]
    pub check: bool,

    /// Override the release base URL (defaults to the enrolled value /
    /// `https://get.opengeni.ai`). Honors `$OPENGENI_INSTALL_BASE_URL`.
    #[arg(long, env = "OPENGENI_INSTALL_BASE_URL")]
    pub base_url: Option<String>,

    /// Override the channel (defaults to the enrolled channel).
    #[arg(long)]
    pub channel: Option<String>,
}

/// Arguments for the `uninstall` subcommand.
#[derive(Debug, Default, clap::Args)]
pub struct UninstallArgs {
    /// Also remove credentials + ask the control plane to deactivate the
    /// enrollment (so the machine does not linger in the dashboard). Without this
    /// the credentials are kept so a re-install reconnects.
    #[arg(long)]
    pub purge: bool,
}

impl ServiceAction {
    /// A stable label for the action, for status/log messages.
    #[must_use]
    pub fn label(&self) -> &'static str {
        match self {
            Self::Install(_) => "install",
            Self::Uninstall(_) => "uninstall",
            Self::Start(_) => "start",
            Self::Stop(_) => "stop",
            Self::Status(_) => "status",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory as _;

    #[test]
    fn cli_definition_is_valid() {
        // clap's own assert catches duplicate args / bad definitions at test time.
        Cli::command().debug_assert();
    }

    #[test]
    fn run_is_the_default_command() {
        let cli = Cli::parse_from(["opengeni-agent"]);
        assert!(cli.command.is_none());
        assert!(matches!(Command::default(), Command::Run(_)));
    }

    #[test]
    fn enroll_parses_flags() {
        let cli = Cli::parse_from(["opengeni-agent", "enroll", "--channel", "beta", "--force"]);
        match cli.command {
            Some(Command::Enroll(args)) => {
                assert_eq!(args.channel, "beta");
                assert!(args.force);
            }
            other => panic!("expected enroll, got {other:?}"),
        }
    }

    #[test]
    fn enroll_parses_non_interactive_token() {
        let cli = Cli::parse_from([
            "opengeni-agent",
            "enroll",
            "--token",
            "tok-123",
            "--non-interactive",
        ]);
        match cli.command {
            Some(Command::Enroll(args)) => {
                assert_eq!(args.token.as_deref(), Some("tok-123"));
                assert!(args.non_interactive);
            }
            other => panic!("expected enroll, got {other:?}"),
        }
    }

    #[test]
    fn service_subcommands_parse() {
        let cli = Cli::parse_from(["opengeni-agent", "service", "status"]);
        match cli.command {
            Some(Command::Service(args)) => assert_eq!(args.action.label(), "status"),
            other => panic!("expected service, got {other:?}"),
        }
    }

    #[test]
    fn service_install_parses_print_and_system() {
        let cli = Cli::parse_from([
            "opengeni-agent",
            "service",
            "install",
            "--print",
            "--system",
        ]);
        match cli.command {
            Some(Command::Service(args)) => match args.action {
                ServiceAction::Install(a) => {
                    assert!(a.print);
                    assert!(a.system);
                }
                other => panic!("expected install, got {other:?}"),
            },
            other => panic!("expected service, got {other:?}"),
        }
    }

    #[test]
    fn update_parses_check_flag() {
        let cli = Cli::parse_from(["opengeni-agent", "update", "--check"]);
        match cli.command {
            Some(Command::Update(args)) => assert!(args.check),
            other => panic!("expected update, got {other:?}"),
        }
    }

    #[test]
    fn uninstall_parses_purge() {
        let cli = Cli::parse_from(["opengeni-agent", "uninstall", "--purge"]);
        match cli.command {
            Some(Command::Uninstall(args)) => assert!(args.purge),
            other => panic!("expected uninstall, got {other:?}"),
        }
    }

    #[test]
    fn api_url_is_global() {
        let cli = Cli::parse_from(["opengeni-agent", "--api-url", "https://x", "run"]);
        assert_eq!(cli.api_url.as_deref(), Some("https://x"));
    }

    #[test]
    fn run_parses_virtual_desktop_flags() {
        let cli = Cli::parse_from([
            "opengeni-agent",
            "run",
            "--virtual-desktop",
            "--virtual-display",
            ":99",
            "--virtual-geometry",
            "1920x1080",
        ]);
        match cli.command {
            Some(Command::Run(args)) => {
                assert!(args.virtual_desktop);
                assert_eq!(args.virtual_display, ":99");
                assert_eq!(args.virtual_geometry, "1920x1080");
            }
            other => panic!("expected run, got {other:?}"),
        }
    }

    #[test]
    fn virtual_desktop_defaults_off() {
        let cli = Cli::parse_from(["opengeni-agent", "run"]);
        match cli.command {
            Some(Command::Run(args)) => {
                assert!(!args.virtual_desktop);
                assert_eq!(args.virtual_display, ":99");
            }
            other => panic!("expected run, got {other:?}"),
        }
    }
}
