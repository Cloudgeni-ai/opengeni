//! Ordinary exec API entry point for the durable command journal.

use std::io::{self, Read as _};
use std::path::PathBuf;

use clap::{Parser, Subcommand};
use opengeni_run::{
    boot_identity, execute_payload,
    model::{InputRequest, StartRequest},
    Journal, MAX_PAGE_BYTES,
};

#[derive(Parser)]
struct Cli {
    #[arg(long, default_value = "/var/lib/opengeni-run")]
    root: PathBuf,
    #[arg(long, default_value = "/usr/local/bin/opengeni-command-supervisor")]
    supervisor: PathBuf,
    #[command(subcommand)]
    action: Action,
}
#[derive(Subcommand)]
enum Action {
    /// Probe real kernel/image capability and physical boot identity.
    Capabilities,
    /// Consume an immutable StartRequest JSON object from stdin.
    Start,
    /// Consume one ordered input action JSON from stdin.
    Input,
    /// Read durable bytes and exact command state.
    Read {
        #[arg(long)]
        operation: String,
        #[arg(long, default_value_t = 0)]
        stdout: u64,
        #[arg(long, default_value_t = 0)]
        stderr: u64,
        #[arg(long, default_value_t = MAX_PAGE_BYTES)]
        bytes: usize,
        #[arg(long)]
        boot_id: String,
        #[arg(long)]
        disk_lineage: String,
    },
    /// Monotonically request cancellation of one exact command tree.
    Cancel {
        #[arg(long)]
        operation: String,
        #[arg(long)]
        boot_id: String,
        #[arg(long)]
        disk_lineage: String,
    },
    #[command(name = "__exec", hide = true)]
    Execute {
        #[arg(long)]
        payload: PathBuf,
        #[arg(long)]
        digest: String,
    },
}
fn run() -> io::Result<()> {
    let cli = Cli::parse();
    if let Action::Execute { payload, digest } = cli.action {
        return execute_payload(&payload, &digest);
    }
    let journal = Journal::open(cli.root, cli.supervisor)?;
    match cli.action {
        Action::Capabilities => {
            journal.capabilities()?;
            let io = journal.io_capabilities().is_ok();
            println!(
                "{}",
                serde_json::json!({ "protocol": "opengeni-run-v1", "bootId": boot_identity()?,
                "supervision": "native-subreaper-v1", "stdin": io, "pty": io })
            );
        }
        Action::Start => {
            let mut payload = String::new();
            io::stdin().read_to_string(&mut payload)?;
            let request: StartRequest = serde_json::from_str(&payload)
                .map_err(|_| io::Error::other("Invalid start request"))?;
            println!(
                "{}",
                serde_json::to_string(&journal.start(&request)?).map_err(io::Error::other)?
            );
        }
        Action::Input => {
            let mut payload = String::new();
            io::stdin().take(16_384).read_to_string(&mut payload)?;
            if payload.len() >= 16_384 {
                return Err(io::Error::other("Input request too large"));
            }
            let request: InputRequest = serde_json::from_str(&payload)
                .map_err(|_| io::Error::other("Invalid input request"))?;
            println!(
                "{}",
                serde_json::to_string(&journal.input(&request)?).map_err(io::Error::other)?
            );
        }
        Action::Read {
            operation,
            stdout,
            stderr,
            bytes,
            boot_id,
            disk_lineage,
        } => println!(
            "{}",
            serde_json::to_string(&journal.read_bound(
                &operation,
                stdout,
                stderr,
                bytes,
                &boot_id,
                &disk_lineage
            )?)
            .map_err(io::Error::other)?
        ),
        Action::Cancel {
            operation,
            boot_id,
            disk_lineage,
        } => println!(
            "{}",
            serde_json::to_string(&journal.cancel(&operation, &boot_id, &disk_lineage)?)
                .map_err(io::Error::other)?
        ),
        Action::Execute { .. } => unreachable!(),
    }
    Ok(())
}
fn main() {
    if let Err(_error) = run() {
        // Errors may contain user command paths or provider-specific identifiers.
        // The transport error never supplies launch/replay/quiescence authority.
        eprintln!(
            "opengeni-run: operation unavailable or conflicting; inspect exact journal state"
        );
        std::process::exit(125);
    }
}
