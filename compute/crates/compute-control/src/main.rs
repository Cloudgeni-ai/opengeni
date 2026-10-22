//! `compute-control`: the control service, adding API keys to its store,
//! and the hosts' authority: making one and issuing a host's first
//! certificate where Google Cloud's identity tokens cannot.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use clap::{Args, Parser, Subcommand};
use compute_control::api::key_digest;
use compute_control::authority::{self, Authority};
use compute_control::e2b;
use compute_control::group::{COMPUTE_API, Credentials, GcpGroup, METADATA, ServiceAccountKey};
use compute_control::hostapi::Certificates;
use compute_control::identity::{Expected, GOOGLE_KEYS, GceIdentity, GoogleKeys};
use compute_control::leader::Scaling;
use compute_control::link::Links;
use compute_control::service::Settings;
use compute_control::store::{MemoryStore, PostgresStore, Store};
use compute_control::tls::{Tls, database_client};
use compute_control::{Config, start};
use compute_fleet::ScalePolicy;
use compute_protocol::host::{ImageId, SleepConfig};
use compute_storage::store::ChunkStore;

#[derive(Parser)]
#[command(about = "The Opengeni compute control service")]
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
    /// Makes a new hosts' authority, `ca.crt` and `ca.key`, in a directory:
    /// for a deployment without the Terraform module, which makes one.
    NewHostAuthority {
        /// The directory to write them to; it must not hold a key yet.
        #[arg(long)]
        out: PathBuf,
        /// The authority's common name.
        #[arg(long, default_value = "Opengeni compute hosts")]
        name: String,
    },
    /// Issues the first certificate of a host off Google Cloud, where the
    /// authority's key is, and prints it (PEM). The host renews it with
    /// itself from then on.
    IssueHostCertificate {
        /// The host's name in the fleet, its only DNS name.
        #[arg(long)]
        name: String,
        /// The host's certificate request, PEM; only its key is used.
        #[arg(long)]
        csr: PathBuf,
        /// The directory holding the authority: `ca.crt` and `ca.key`.
        #[arg(long, default_value = ".")]
        authority: PathBuf,
    },
}

#[derive(Args)]
struct StoreArgs {
    /// The store: a Postgres connection string or URL, or `memory` to keep
    /// everything in memory (one replica, forgotten when it stops).
    #[arg(long, env = "COMPUTE_CONTROL_DATABASE")]
    database: String,
    /// The database password, kept out of the connection string so that
    /// any password works as it is, without quoting.
    #[arg(
        long,
        env = "COMPUTE_CONTROL_DATABASE_PASSWORD",
        hide_env_values = true
    )]
    database_password: Option<String>,
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
    /// The public API's certificate chain, PEM; with it the API serves
    /// HTTPS itself, without it plain HTTP for a TLS terminator in front.
    #[arg(long, requires = "api_tls_key")]
    api_tls_cert: Option<PathBuf>,
    /// The key of `--api-tls-cert`, PEM.
    #[arg(long, requires = "api_tls_cert")]
    api_tls_key: Option<PathBuf>,
    /// Where hosts reach the service, over TLS.
    #[arg(long, default_value = "0.0.0.0:8443")]
    hosts: SocketAddr,
    /// Where Prometheus scrapes the service's metrics, `GET /metrics` over
    /// plain HTTP, such as `0.0.0.0:9464`; without it there are none.
    #[arg(long)]
    metrics_listen: Option<SocketAddr>,
    /// An OTLP/HTTP metrics endpoint that takes JSON, such as Prometheus's
    /// `http://prometheus:9090/api/v1/otlp/v1/metrics`: hosts' metrics are
    /// passed on to it. Without it hosts may not post any.
    #[arg(long)]
    host_metrics_to: Option<String>,
    /// The URL hosts reach the service at, such as
    /// `https://compute-control.example.com:8443`, exactly as they are given
    /// it: the service's own certificate is for its host, and hosts' identity
    /// tokens are for it.
    #[arg(long)]
    host_url: String,
    /// A further name hosts reach the service by, in its certificate; repeat
    /// for more.
    #[arg(long = "host-name")]
    host_names: Vec<String>,
    /// The directory holding the hosts' authority: `ca.crt` (its
    /// certificate, then any other authority trusted beside it) and `ca.key`
    /// (its key, PKCS#8 PEM).
    #[arg(long)]
    host_authority: PathBuf,
    /// The Google Cloud project whose instances may prove themselves hosts
    /// with an instance identity token.
    #[arg(long, requires = "gce_host_account")]
    gce_project: Option<String>,
    /// The service account those instances run as.
    #[arg(long, requires = "gce_project")]
    gce_host_account: Option<String>,
    #[arg(long, default_value = GOOGLE_KEYS, hide = true)]
    gce_keys: String,
    /// The object store hosts archive to, as they are given it.
    #[arg(long)]
    archive: Option<String>,
    /// The image a create that names none starts from.
    #[arg(long, default_value = "base")]
    image: String,
    /// A stored image creates may name, as `name=<image id>`; repeat for
    /// more. The default image is the hosts' base image unless named here.
    #[arg(long = "stored-image", value_parser = parse_image)]
    stored_images: Vec<(String, ImageId)>,
    /// Disk in MiB each sandbox is booked for where it is placed.
    #[arg(long, default_value_t = 1024)]
    disk_mib: u64,
    /// Seconds a wake or connect may take in all.
    #[arg(long, default_value_t = 60)]
    wake_within_s: u64,
    /// Seconds a sandbox whose create names no sleep config runs between
    /// checkpoints, the fleet's target for how much work losing a host
    /// costs; 0 takes none.
    #[arg(long, default_value_t = 600)]
    checkpoint_every_s: u64,
    /// The team whose keys manage hosts.
    #[arg(long, default_value = "operator")]
    operator_team: String,
    /// A file of `team key` lines whose keys are added at start.
    #[arg(long)]
    keys_file: Option<PathBuf>,
    /// The Ed25519 key (PKCS#8 PEM) agent-link tokens are signed with.
    /// Without it no sandbox may run Opengeni's agent.
    #[arg(long, env = "COMPUTE_CONTROL_LINK_KEY")]
    link_key: Option<PathBuf>,
    /// A key tokens were signed with before, still listed until they
    /// expire; repeat for more.
    #[arg(long = "link-previous-key")]
    link_previous_keys: Vec<PathBuf>,
    /// The issuer link tokens name.
    #[arg(long, default_value = "opengeni-compute")]
    link_issuer: String,
    /// A team's agent gateway, as `team=wss://...`; repeat for more.
    #[arg(long = "team-link", value_parser = parse_team_link)]
    team_links: Vec<(String, String)>,
    /// A Google Cloud managed instance group of hosts to grow, as
    /// `projects/P/zones/Z/instanceGroupManagers/N`.
    #[arg(long)]
    gcp_group: Option<String>,
    #[arg(long, default_value = COMPUTE_API, hide = true)]
    gcp_api: String,
    #[arg(long, default_value = METADATA, hide = true)]
    gcp_metadata: String,
    /// A service account key file whose account manages the group, for a
    /// service that runs off Google Cloud. Without one, its tokens come from
    /// the metadata server (the instance's or the GKE workload's account).
    #[arg(long, env = "GOOGLE_APPLICATION_CREDENTIALS")]
    gcp_credentials: Option<PathBuf>,
    /// Fewest hosts the group keeps.
    #[arg(long, default_value_t = 1)]
    scale_min: u32,
    /// Most hosts the group may have.
    #[arg(long, default_value_t = 10)]
    scale_max: u32,
    /// Spare memory to keep, in thousandths of the group's.
    #[arg(long, default_value_t = 200)]
    scale_spare_per_mille: u32,
    /// And rooms for this many of the largest sandboxes, each with its
    /// memory and processor time on one host.
    #[arg(long, default_value_t = 2)]
    scale_spare_largest: u32,
    /// The largest sandbox's guaranteed memory, in MiB.
    #[arg(long, default_value_t = 4096)]
    scale_largest_mib: u64,
    /// The largest sandbox's guaranteed processor time, in millicores.
    #[arg(long, default_value_t = 2000)]
    scale_largest_cpu_millis: u64,
    /// Memory in MiB a new host brings for sandboxes.
    #[arg(long, default_value_t = 0)]
    scale_host_memory_mib: u64,
    /// Seconds between looks at the group.
    #[arg(long, default_value_t = 10)]
    scale_every_s: u64,
    /// Seconds a member of the group without a registered host counts as
    /// booting; past it, it no longer stands in for capacity and the group
    /// grows around it.
    #[arg(long, default_value_t = 600)]
    scale_boot_within_s: u64,
    /// Where the E2B front door listens; without it there is none.
    #[arg(long)]
    e2b_listen: Option<SocketAddr>,
    /// The domain sandbox host names are under, `<port>-<id>.<domain>`.
    #[arg(long, default_value = "localhost")]
    e2b_domain: String,
    /// The front door's certificate chain, PEM, naming the API's host and
    /// `*.<domain>`; with it the front door serves HTTPS itself, without it
    /// plain HTTP for a TLS terminator in front.
    #[arg(long, requires = "e2b_tls_key")]
    e2b_tls_cert: Option<PathBuf>,
    /// The key of `--e2b-tls-cert`, PEM.
    #[arg(long, requires = "e2b_tls_cert")]
    e2b_tls_key: Option<PathBuf>,
    /// An E2B template, as `id=image:VCPUSxMEMORY_MIB`, for example
    /// `base=base:2x1024`; repeat for more. Without any, `base` is the
    /// default image at 2x1024.
    #[arg(long = "e2b-template", value_parser = parse_template)]
    e2b_templates: Vec<(String, e2b::Template)>,
}

fn parse_image(text: &str) -> Result<(String, ImageId), String> {
    let (name, id) = text
        .split_once('=')
        .ok_or("a stored image is `name=<image id>`")?;
    Ok((name.to_owned(), id.parse()?))
}

fn parse_team_link(text: &str) -> Result<(String, String), String> {
    let (team, url) = text
        .split_once('=')
        .ok_or("a team link is `team=wss://...`")?;
    Ok((team.to_owned(), url.to_owned()))
}

fn parse_template(text: &str) -> Result<(String, e2b::Template), String> {
    let shape = "a template is `id=image:VCPUSxMEMORY_MIB`";
    let (id, rest) = text.split_once('=').ok_or(shape)?;
    let (image, size) = rest.rsplit_once(':').ok_or(shape)?;
    let (vcpus, memory) = size.split_once('x').ok_or(shape)?;
    Ok((
        id.to_owned(),
        e2b::Template {
            image: image.to_owned(),
            vcpus: vcpus.parse().map_err(|_| shape)?,
            memory_mib: memory.parse().map_err(|_| shape)?,
            disk_mib: 0,
        },
    ))
}

/// The service's names in `url`, an `https://` URL, and `extra`.
fn host_names(url: &str, extra: &[String]) -> anyhow::Result<Vec<String>> {
    let parsed = reqwest::Url::parse(url).with_context(|| format!("--host-url {url:?}"))?;
    anyhow::ensure!(
        parsed.scheme() == "https",
        "--host-url must be https://host[:port], not {url:?}"
    );
    // An IPv6 address comes in brackets.
    let host = parsed
        .host_str()
        .with_context(|| format!("--host-url {url:?} names no host"))?
        .trim_start_matches('[')
        .trim_end_matches(']');
    // "control.example." is another name than "control.example" to a host
    // checking the certificate, so one form is configured, never both.
    anyhow::ensure!(
        !host.ends_with('.'),
        "--host-url {url:?}: give the host without its trailing dot"
    );
    let mut names = vec![host.to_owned()];
    for name in extra {
        anyhow::ensure!(
            !name.ends_with('.'),
            "--host-name {name:?}: give the name without its trailing dot"
        );
        if !names.contains(name) {
            names.push(name.clone());
        }
    }
    Ok(names)
}

impl Serve {
    fn tls(&self) -> anyhow::Result<(Tls, Option<GceIdentity>)> {
        let authority = Arc::new(Authority::load(&self.host_authority)?);
        let tls = Tls::new(authority, host_names(&self.host_url, &self.host_names)?)?;
        let identity = match (&self.gce_project, &self.gce_host_account) {
            (Some(project), Some(account)) => Some(GceIdentity::new(
                Expected {
                    audience: self.host_url.clone(),
                    project: project.clone(),
                    account: account.clone(),
                },
                Arc::new(GoogleKeys::new(&self.gce_keys)?),
            )),
            _ => None,
        };
        Ok((tls, identity))
    }

    fn links(&self) -> anyhow::Result<Option<Arc<Links>>> {
        let Some(key) = &self.link_key else {
            anyhow::ensure!(
                self.team_links.is_empty(),
                "--team-link needs --link-key to sign with"
            );
            return Ok(None);
        };
        let teams: BTreeMap<String, String> = self.team_links.iter().cloned().collect();
        anyhow::ensure!(
            teams.len() == self.team_links.len(),
            "a team has more than one --team-link"
        );
        Ok(Some(Arc::new(Links::load(
            key,
            &self.link_previous_keys,
            self.link_issuer.clone(),
            teams,
        )?)))
    }

    fn e2b_listen(&self) -> anyhow::Result<Option<e2b::listen::Listen>> {
        let Some(address) = self.e2b_listen else {
            return Ok(None);
        };
        let tls = match (&self.e2b_tls_cert, &self.e2b_tls_key) {
            (Some(cert), Some(key)) => Some(compute_control::tls::public_server(cert, key)?),
            _ => None,
        };
        Ok(Some(e2b::listen::Listen {
            address,
            tls,
            settings: self.e2b_settings(),
        }))
    }

    fn e2b_settings(&self) -> e2b::Settings {
        let mut settings = e2b::Settings {
            domain: self.e2b_domain.clone(),
            ..e2b::Settings::default()
        };
        if !self.e2b_templates.is_empty() {
            settings.templates = self
                .e2b_templates
                .iter()
                .map(|(id, template)| {
                    let mut template = template.clone();
                    template.disk_mib = self.disk_mib;
                    (id.clone(), template)
                })
                .collect();
        } else if let Some(base) = settings.templates.get_mut("base") {
            base.image.clone_from(&self.image);
            base.disk_mib = self.disk_mib;
        }
        settings
    }

    fn scaling(&self) -> anyhow::Result<Option<Scaling>> {
        let Some(path) = &self.gcp_group else {
            return Ok(None);
        };
        anyhow::ensure!(
            self.scale_host_memory_mib > 0,
            "--scale-host-memory-mib is needed to grow a group"
        );
        Ok(Some(Scaling {
            group: std::sync::Arc::new(GcpGroup::new(
                path,
                &self.gcp_api,
                self.gcp_credentials()?,
            )?),
            policy: ScalePolicy {
                spare_per_mille: self.scale_spare_per_mille,
                spare_largest: self.scale_spare_largest,
                largest_mib: self.scale_largest_mib,
                largest_cpu_millis: self.scale_largest_cpu_millis,
                host_memory_mib: self.scale_host_memory_mib,
                min_hosts: self.scale_min,
                max_hosts: self.scale_max,
            },
            every: Duration::from_secs(self.scale_every_s),
            boot_within: Duration::from_secs(self.scale_boot_within_s),
        }))
    }

    /// Where the group's tokens come from: the key file, if one is named.
    fn gcp_credentials(&self) -> anyhow::Result<Credentials> {
        let Some(file) = &self.gcp_credentials else {
            return Ok(Credentials::Metadata(self.gcp_metadata.clone()));
        };
        let json = std::fs::read(file).with_context(|| format!("reading {}", file.display()))?;
        let key = ServiceAccountKey::from_json(&json)
            .with_context(|| format!("the key file {}", file.display()))?;
        Ok(Credentials::Key(Box::new(key)))
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
    let (tls, identity) = args.tls()?;
    let archive = match &args.archive {
        Some(url) => Some(
            ChunkStore::from_url(url)
                .with_context(|| format!("the archive store {url}"))?
                .with_context(|| format!("{url} names no object store"))?,
        ),
        None => None,
    };
    let api_tls = match (&args.api_tls_cert, &args.api_tls_key) {
        (Some(cert), Some(key)) => Some(compute_control::tls::public_server(cert, key)?),
        _ => None,
    };
    let config = Config {
        api: args.api,
        api_tls,
        hosts: args.hosts,
        tls,
        identity,
        archive,
        settings: Settings {
            disk_mib: args.disk_mib,
            wake_within: Duration::from_secs(args.wake_within_s),
            sleep: SleepConfig {
                checkpoint_every_ms: (args.checkpoint_every_s > 0)
                    .then(|| args.checkpoint_every_s.saturating_mul(1000)),
                ..Settings::default().sleep
            },
            image: args.image.clone(),
            images: args
                .stored_images
                .iter()
                .map(|(name, id)| (name.clone(), Some(*id)))
                .collect::<BTreeMap<_, _>>(),
            links: args.links()?,
            ..Settings::default()
        },
        operator: args.operator_team.clone(),
        scaling: args.scaling()?,
        seed: seed()?,
        e2b: args.e2b_listen()?,
        metrics: args.metrics_listen,
        host_metrics: args.host_metrics_to.clone(),
    };
    let running = start(store, config).await?;
    tracing::info!(
        api = %running.api,
        hosts = %running.hosts,
        e2b = ?running.e2b,
        metrics = ?running.metrics,
        "serving"
    );
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
    Ok(PostgresStore::connect_with(database_config(database)?, tls, database.connections).await?)
}

/// The store's connection settings: the connection string, and the
/// password given apart from it, if any.
fn database_config(database: &StoreArgs) -> anyhow::Result<tokio_postgres::Config> {
    let mut config: tokio_postgres::Config = database
        .database
        .parse()
        .context("the database connection string")?;
    if let Some(password) = &database.database_password {
        config.password(password);
    }
    Ok(config)
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
        Command::NewHostAuthority { out, name } => new_host_authority(&out, &name),
        Command::IssueHostCertificate {
            name,
            csr,
            authority,
        } => {
            let csr = std::fs::read_to_string(&csr)
                .with_context(|| format!("reading {}", csr.display()))?;
            let certificates = Certificates {
                authority: Arc::new(Authority::load(&authority)?),
                identity: None,
                reserved: Vec::new(),
            };
            let issued = certificates
                .issue(
                    &name,
                    &csr,
                    std::time::SystemTime::now(),
                    authority::Proven::Certificate,
                )
                .map_err(|(_, message)| anyhow::anyhow!(message))?;
            print!("{}", issued.certificate);
            eprintln!(
                "issued a certificate for {}, serial {}",
                issued.name, issued.serial
            );
            Ok(())
        }
    }
}

/// Writes a new authority to `out`, refusing to replace one there.
fn new_host_authority(out: &Path, name: &str) -> anyhow::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};

    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(out)
        .with_context(|| format!("creating {}", out.display()))?;
    let (certificate, key) = authority::generate(name)?;
    let write = |file: &str, mode: u32, contents: &str| -> anyhow::Result<()> {
        let path = out.join(file);
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&path)
            .with_context(|| {
                format!(
                    "creating {} (an authority is never replaced in place)",
                    path.display()
                )
            })?
            .write_all(contents.as_bytes())
            .with_context(|| format!("writing {}", path.display()))
    };
    write(authority::KEY_FILE, 0o600, &key)?;
    write(authority::CERTIFICATE_FILE, 0o644, &certificate)?;
    eprintln!(
        "wrote {} and {} to {}",
        authority::CERTIFICATE_FILE,
        authority::KEY_FILE,
        out.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_service_is_named_by_its_host_url_and_extra_names() {
        assert_eq!(
            host_names("https://control.example:8443", &["10.0.0.2".into()]).unwrap(),
            ["control.example", "10.0.0.2"]
        );
        assert_eq!(
            host_names("https://10.0.0.2:8443/", &["10.0.0.2".into()]).unwrap(),
            ["10.0.0.2"]
        );
        assert!(host_names("http://control.example:8443", &[]).is_err());
        assert!(host_names("control.example", &[]).is_err());
        // A trailing dot, in the URL or an extra name, is refused at start.
        let error = host_names("https://control.example.:8443", &[]).unwrap_err();
        assert!(format!("{error:#}").contains("trailing dot"), "{error:#}");
        let error =
            host_names("https://control.example:8443", &["extra.example.".into()]).unwrap_err();
        assert!(format!("{error:#}").contains("trailing dot"), "{error:#}");
    }

    #[test]
    fn a_new_authority_issues_host_certificates_and_is_never_overwritten() {
        use rustls::pki_types::pem::PemObject as _;

        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("authority");
        new_host_authority(&out, "test hosts").unwrap();
        assert!(new_host_authority(&out, "again").is_err());
        let authority = Authority::load(&out).unwrap();
        let key = rcgen::KeyPair::generate().unwrap();
        let csr = rcgen::CertificateParams::new(vec!["asked.example".to_owned()])
            .unwrap()
            .serialize_request(&key)
            .unwrap()
            .pem()
            .unwrap();
        let certificates = Certificates {
            authority: Arc::new(authority),
            identity: None,
            reserved: Vec::new(),
        };
        let issued = certificates
            .issue(
                "host-9",
                &csr,
                std::time::SystemTime::now(),
                authority::Proven::Certificate,
            )
            .unwrap();
        assert_eq!(issued.name, "host-9");
        let der = rustls::pki_types::CertificateDer::from_pem_slice(issued.certificate.as_bytes())
            .unwrap();
        authority::verify(
            &certificates.authority.roots(),
            &der,
            std::time::SystemTime::now(),
            "host-9",
        )
        .unwrap();
        assert!(
            authority::verify(
                &certificates.authority.roots(),
                &der,
                std::time::SystemTime::now(),
                "asked.example"
            )
            .is_err(),
            "never the name the request asks for"
        );
        let mode = |file: &str| {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::metadata(out.join(file))
                .unwrap()
                .permissions()
                .mode()
                & 0o777
        };
        assert_eq!(mode(authority::KEY_FILE), 0o600);
    }

    #[test]
    fn a_password_given_apart_needs_no_quoting_in_quoted_settings() {
        // As the chart writes them: every value quoted, the password apart.
        let database = StoreArgs {
            database:
                r"host='db.example.com' port='5432' dbname='it\'s' user='compute' sslmode='disable'"
                    .into(),
            database_password: Some(r"two words \ and ' quote".into()),
            database_ca: None,
            connections: 1,
        };
        let config = database_config(&database).unwrap();
        assert_eq!(config.get_dbname(), Some("it's"));
        assert_eq!(config.get_user(), Some("compute"));
        assert_eq!(
            config.get_password(),
            Some(&b"two words \\ and ' quote"[..])
        );
    }
}
