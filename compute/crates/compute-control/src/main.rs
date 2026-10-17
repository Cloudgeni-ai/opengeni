//! `compute-control`: the fleet service, and adding API keys to its store.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use clap::{Args, Parser, Subcommand};
use compute_control::api::key_digest;
use compute_control::group::{COMPUTE_API, GcpGroup, METADATA};
use compute_control::leader::Scaling;
use compute_control::service::Settings;
use compute_control::store::{MemoryStore, PostgresStore, Store};
use compute_control::tls::{Tls, TlsFiles, database_client};
use compute_control::{Config, start};
use compute_fleet::ScalePolicy;
use compute_storage::store::ChunkStore;

#[derive(Parser)]
#[command(about = "The Opengeni compute fleet service")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Runs a replica of the service.
    Serve(Box<Serve>),
    /// Adds a new API key for a team to the store and prints it.
    AddKey {
        #[command(flatten)]
        database: StoreArgs,
        /// The team the key acts for.
        #[arg(long)]
        team: String,
    },
}

#[derive(Args)]
struct StoreArgs {
    /// The store: a Postgres connection string or URL, or `memory` to keep
    /// everything in memory (one replica, forgotten when it stops).
    #[arg(long, env = "COMPUTE_CONTROL_DATABASE")]
    database: String,
    /// Trust this authority for TLS to the database; without it the
    /// connection is unencrypted, for a database on the same machine.
    #[arg(long)]
    database_ca: Option<PathBuf>,
    /// Connections to keep to the database.
    #[arg(long, default_value_t = 32)]
    connections: usize,
}

#[derive(Args)]
struct Serve {
    #[command(flatten)]
    database: StoreArgs,
    /// Where the public API listens.
    #[arg(long, default_value = "0.0.0.0:8080")]
    api: SocketAddr,
    /// Where hosts reach the service, over mutual TLS.
    #[arg(long, default_value = "0.0.0.0:8443")]
    hosts: SocketAddr,
    /// The service's certificate chain (PEM), which hosts check.
    #[arg(long)]
    cert: PathBuf,
    /// The service's private key (PEM).
    #[arg(long)]
    key: PathBuf,
    /// The authority that signs hosts' certificates (PEM).
    #[arg(long)]
    host_ca: PathBuf,
    /// The object store hosts archive to, as they are given it.
    #[arg(long)]
    archive: Option<String>,
    /// The image a create that names none starts from.
    #[arg(long, default_value = "base")]
    image: String,
    /// Disk in MiB each sandbox is booked for where it is placed.
    #[arg(long, default_value_t = 1024)]
    disk_mib: u64,
    /// Seconds a wake or connect may take in all.
    #[arg(long, default_value_t = 60)]
    wake_within_s: u64,
    /// The team whose keys manage hosts.
    #[arg(long, default_value = "operator")]
    operator_team: String,
    /// A file of `team key` lines whose keys are added at start.
    #[arg(long)]
    keys_file: Option<PathBuf>,
    /// A Google Cloud managed instance group of hosts to grow, as
    /// `projects/P/zones/Z/instanceGroupManagers/N`.
    #[arg(long)]
    gcp_group: Option<String>,
    #[arg(long, default_value = COMPUTE_API, hide = true)]
    gcp_api: String,
    #[arg(long, default_value = METADATA, hide = true)]
    gcp_metadata: String,
    /// Fewest hosts the group keeps.
    #[arg(long, default_value_t = 1)]
    scale_min: u32,
    /// Most hosts the group may have.
    #[arg(long, default_value_t = 10)]
    scale_max: u32,
    /// Spare memory to keep, in thousandths of the group's.
    #[arg(long, default_value_t = 200)]
    scale_spare_per_mille: u32,
    /// And room for at least this many of the largest sandboxes.
    #[arg(long, default_value_t = 2)]
    scale_spare_largest: u32,
    /// The largest sandbox's guaranteed memory, in MiB.
    #[arg(long, default_value_t = 4096)]
    scale_largest_mib: u64,
    /// Memory in MiB a new host brings for sandboxes.
    #[arg(long, default_value_t = 0)]
    scale_host_memory_mib: u64,
    /// Seconds between looks at the group.
    #[arg(long, default_value_t = 10)]
    scale_every_s: u64,
}

impl Serve {
    fn scaling(&self) -> anyhow::Result<Option<Scaling>> {
        let Some(path) = &self.gcp_group else {
            return Ok(None);
        };
        anyhow::ensure!(
            self.scale_host_memory_mib > 0,
            "--scale-host-memory-mib is needed to grow a group"
        );
        Ok(Some(Scaling {
            group: std::sync::Arc::new(GcpGroup::new(path, &self.gcp_api, &self.gcp_metadata)?),
            policy: ScalePolicy {
                spare_per_mille: self.scale_spare_per_mille,
                spare_largest: self.scale_spare_largest,
                largest_mib: self.scale_largest_mib,
                host_memory_mib: self.scale_host_memory_mib,
                min_hosts: self.scale_min,
                max_hosts: self.scale_max,
            },
            every: Duration::from_secs(self.scale_every_s),
        }))
    }
}

fn seed() -> anyhow::Result<u64> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).context("random bytes")?;
    Ok(u64::from_le_bytes(bytes))
}

async fn add_keys<S: Store>(store: &S, file: &Path) -> anyhow::Result<()> {
    let text =
        std::fs::read_to_string(file).with_context(|| format!("reading {}", file.display()))?;
    for line in text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        let (team, key) = line
            .split_once(char::is_whitespace)
            .with_context(|| format!("{}: lines are `team key`", file.display()))?;
        store.add_key(&key_digest(key.trim()), team).await?;
    }
    Ok(())
}

async fn serve<S: Store>(store: Arc<S>, args: Serve) -> anyhow::Result<()> {
    if let Some(file) = &args.keys_file {
        add_keys(&*store, file).await?;
    }
    let tls = Tls::load(&TlsFiles {
        cert: args.cert.clone(),
        key: args.key.clone(),
        host_ca: args.host_ca.clone(),
    })?;
    let archive = match &args.archive {
        Some(url) => Some(
            ChunkStore::from_url(url)
                .with_context(|| format!("the archive store {url}"))?
                .with_context(|| format!("{url} names no object store"))?,
        ),
        None => None,
    };
    let config = Config {
        api: args.api,
        hosts: args.hosts,
        tls,
        archive,
        settings: Settings {
            disk_mib: args.disk_mib,
            wake_within: Duration::from_secs(args.wake_within_s),
            image: args.image.clone(),
            ..Settings::default()
        },
        operator: args.operator_team.clone(),
        scaling: args.scaling()?,
        seed: seed()?,
    };
    let running = start(store, config).await?;
    tracing::info!(api = %running.api, hosts = %running.hosts, "serving");
    shutdown().await;
    Ok(())
}

async fn shutdown() {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("a SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
}

async fn postgres(database: &StoreArgs) -> anyhow::Result<PostgresStore> {
    let tls = database
        .database_ca
        .as_deref()
        .map(database_client)
        .transpose()?;
    Ok(PostgresStore::connect(&database.database, tls, database.connections).await?)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    match Cli::parse().command {
        Command::Serve(args) => {
            if args.database.database == "memory" {
                serve(Arc::new(MemoryStore::new()), *args).await
            } else {
                let store = postgres(&args.database).await?;
                serve(Arc::new(store), *args).await
            }
        }
        Command::AddKey { database, team } => {
            anyhow::ensure!(
                database.database != "memory",
                "a memory store forgets its keys"
            );
            let store = postgres(&database).await?;
            let mut bytes = [0u8; 24];
            getrandom::fill(&mut bytes).context("random bytes")?;
            let key: String = std::iter::once("ck_".to_owned())
                .chain(bytes.iter().map(|byte| format!("{byte:02x}")))
                .collect();
            store.add_key(&key_digest(&key), &team).await?;
            println!("{key}");
            Ok(())
        }
    }
}
