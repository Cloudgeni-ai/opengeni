//! The `opengeni-agent` command-line surface.
//!
//! Subcommands (dossier §23.0/§23.1):
//!
//! * [`Command::Run`] — the DEFAULT, FOREGROUND run model: enroll-if-needed, then
//!   dial the control plane and serve until stopped. The machine is online while
//!   this runs and offline when it stops.
//! * [`Command::Enroll`] — the device-flow enrollment only (print a user-code +
//!   URL, poll to completion, persist credentials `0600`), then exit.
//! * [`Command::Service`] — the opt-in always-on daemon path. A STRUCTURED STUB
//!   here: the per-OS `ServiceManager` (systemd-user / LaunchAgent / Windows
//!   Service) is M11. The subcommand exists, parses, and prints an honest
//!   not-yet-implemented message so the surface is stable.

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
    /// Manage the opt-in always-on service (install/uninstall/start/stop/status).
    /// A structured stub until M11.
    Service(ServiceArgs),
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
}

/// Arguments for the `service` subcommand (M11 stub).
#[derive(Debug, clap::Args)]
pub struct ServiceArgs {
    /// The service action to perform.
    #[command(subcommand)]
    pub action: ServiceAction,
}

/// The service lifecycle actions. Each is a stub until the per-OS
/// `ServiceManager` lands in M11.
#[derive(Debug, Subcommand)]
pub enum ServiceAction {
    /// Install + enable the always-on service (M11).
    Install,
    /// Uninstall the service (M11).
    Uninstall,
    /// Start the service (M11).
    Start,
    /// Stop the service (M11).
    Stop,
    /// Report the service status (M11).
    Status,
}

impl ServiceAction {
    /// A stable label for the action, for the stub message.
    #[must_use]
    pub fn label(&self) -> &'static str {
        match self {
            Self::Install => "install",
            Self::Uninstall => "uninstall",
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Status => "status",
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
    fn service_subcommands_parse() {
        let cli = Cli::parse_from(["opengeni-agent", "service", "status"]);
        match cli.command {
            Some(Command::Service(args)) => assert_eq!(args.action.label(), "status"),
            other => panic!("expected service, got {other:?}"),
        }
    }

    #[test]
    fn api_url_is_global() {
        let cli = Cli::parse_from(["opengeni-agent", "--api-url", "https://x", "run"]);
        assert_eq!(cli.api_url.as_deref(), Some("https://x"));
    }
}
