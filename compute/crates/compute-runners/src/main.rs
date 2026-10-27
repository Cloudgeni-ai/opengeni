//! `compute-runners serve`: one GitHub Actions runner pool on compute
//! ([ADR 23](../../../docs/adr/0023-github-actions-runner-pools.md)).

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context as _, Result, bail};
use clap::{Args, Parser, Subcommand};
use compute_runners::cache::{self, Cache};
use compute_runners::compute::Compute;
use compute_runners::github::{App, Credentials, Github, Scope};
use compute_runners::pool::{self, Pool};
use compute_runners::warm;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Parser)]
#[command(
    name = "compute-runners",
    version,
    about = "GitHub Actions runner pools on Opengeni compute"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Runs one pool: a scale set whose every job gets a fresh sandbox.
    Serve(Box<Serve>),
}

#[derive(Debug, Args)]
#[allow(clippy::struct_excessive_bools)]
struct Serve {
    /// GitHub's web address (a GitHub Enterprise Server's own).
    #[arg(long, default_value = "https://github.com")]
    github_url: String,
    /// GitHub's REST API (a server's `<url>/api/v3`).
    #[arg(long, default_value = "https://api.github.com")]
    github_api_url: String,
    /// What the pool serves: an organization, or `owner/repo`.
    #[arg(long)]
    scope: String,
    /// A token with admin rights on the scope, instead of an App.
    #[arg(long, env = "GITHUB_TOKEN", hide_env_values = true)]
    github_token: Option<String>,
    /// The GitHub App (its id or client id) installed on the scope.
    #[arg(long, requires_all = ["app_installation", "app_key_file"])]
    app_id: Option<String>,
    /// The App's installation id.
    #[arg(long)]
    app_installation: Option<u64>,
    /// The App's private key (PEM).
    #[arg(long)]
    app_key_file: Option<PathBuf>,
    /// The runner group the scale set is in.
    #[arg(long, default_value = "default")]
    runner_group: String,

    /// The pool's name, which is its scale set's and the label workflows
    /// target it by (`runs-on: <name>`).
    #[arg(long)]
    name: String,
    /// More labels for the scale set, comma separated.
    #[arg(long, value_delimiter = ',')]
    labels: Vec<String>,
    /// The template runners start from, when no warm one is kept.
    #[arg(long)]
    template: String,
    /// Idle runners kept beyond the jobs assigned.
    #[arg(long, default_value_t = 0)]
    min_idle: u32,
    /// The most runners at once.
    #[arg(long, default_value_t = 10)]
    max: u32,
    /// The longest a runner's sandbox lives, in seconds (the longest job).
    #[arg(long, default_value_t = 6 * 3600)]
    timeout_s: u64,
    /// More environment for every runner, `NAME=value`.
    #[arg(long = "env", value_parser = name_value)]
    env: Vec<(String, String)>,

    /// Compute's E2B API.
    #[arg(long)]
    compute_url: String,
    /// Compute's API key.
    #[arg(long, env = "COMPUTE_API_KEY", hide_env_values = true)]
    compute_key: String,
    /// A certificate authority (PEM) compute's API is trusted under, beside
    /// the public ones: a fleet's own.
    #[arg(long)]
    compute_ca: Option<PathBuf>,

    /// Keep a warm template of this repository (`owner/repo`). Its names
    /// begin with the pool's name and its scale set's id, which together
    /// may then be at most 40 long.
    #[arg(long)]
    warm_repo: Option<String>,
    /// The branch it follows; the repository's default when not given.
    #[arg(long, requires = "warm_repo")]
    warm_branch: Option<String>,
    /// Run in the clone to warm it (install dependencies, build once).
    #[arg(long, default_value = "", requires = "warm_repo")]
    warm_prepare: String,
    /// The user the clone and prepare command run as: the runner's.
    #[arg(long, default_value = "runner")]
    warm_user: String,
    /// The runners' work folder.
    #[arg(long, default_value = "/home/runner/_work")]
    warm_work: String,
    /// At most one refresh in this many seconds.
    #[arg(long, default_value_t = 3600)]
    warm_every_s: u64,
    /// The longest a refresh's clone and prepare may take, in seconds.
    #[arg(long, default_value_t = 3600)]
    warm_within_s: u64,

    /// Serve a Turborepo remote cache kept here (`gs://bucket/prefix`,
    /// `s3://`, `az://`); the pool's artifacts go under its name.
    #[arg(long, requires_all = ["cache_url", "cache_token"])]
    cache_store: Option<String>,
    /// The cache's address as runners reach it.
    #[arg(long)]
    cache_url: Option<String>,
    /// The token runners give the cache.
    #[arg(long, env = "COMPUTE_RUNNERS_CACHE_TOKEN", hide_env_values = true)]
    cache_token: Option<String>,
    /// Artifacts neither stored nor read in this many days are deleted.
    #[arg(long, default_value_t = 14)]
    cache_days: u32,

    /// Where the cache and `/healthz` are served.
    #[arg(long, default_value = "0.0.0.0:8080")]
    listen: SocketAddr,
}

fn name_value(text: &str) -> Result<(String, String), String> {
    let (name, value) = text.split_once('=').ok_or("expected NAME=value")?;
    if name.is_empty() {
        return Err("expected NAME=value".into());
    }
    Ok((name.into(), value.into()))
}

/// Whether `name` is a pool's name: 1 to 40 lowercase letters, digits and
/// `-`, starting with a letter or digit, so its templates' names stay
/// within compute's limit.
fn valid_pool_name(name: &str) -> bool {
    (1..=40).contains(&name.len())
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    match Cli::parse().command {
        Command::Serve(serve) => run(*serve).await,
    }
}

fn credentials(serve: &Serve) -> Result<Credentials> {
    match (&serve.app_id, &serve.github_token) {
        (Some(id), _) => {
            let (Some(installation), Some(key_file)) =
                (serve.app_installation, &serve.app_key_file)
            else {
                bail!("--app-id needs --app-installation and --app-key-file");
            };
            let key = std::fs::read_to_string(key_file)
                .with_context(|| format!("reading {}", key_file.display()))?;
            Ok(Credentials::App(Box::new(App::new(
                id,
                installation,
                &key,
            )?)))
        }
        (None, Some(token)) => Ok(Credentials::Token(token.clone())),
        (None, None) => bail!("give GitHub credentials: --github-token (GITHUB_TOKEN) or --app-id"),
    }
}

async fn run(serve: Serve) -> Result<()> {
    if !valid_pool_name(&serve.name) {
        bail!(
            "--name {:?}: use 1 to 40 lowercase letters, digits and -",
            serve.name
        );
    }
    let (github, compute) = clients(&serve)?;
    let stop = CancellationToken::new();
    let (leading_tx, leading) = watch::channel(false);
    let mut tasks = tokio::task::JoinSet::new();

    let group = github.runner_group(&serve.runner_group).await?;
    let mut labels = vec![serve.name.clone()];
    labels.extend(
        serve
            .labels
            .iter()
            .filter(|label| !label.is_empty())
            .cloned(),
    );
    let set = github.ensure_scale_set(group, &serve.name, &labels).await?;
    tracing::info!(set = set.id, name = %set.name, ?labels, "the pool's scale set");
    let key = pool::key(&serve.name, set.id);
    if serve.warm_repo.is_some() && !warm::fits(&key) {
        bail!(
            "--name {:?} with scale set {}: too long for warm templates' names",
            serve.name,
            set.id
        );
    }

    let mut env: BTreeMap<String, String> = serve.env.iter().cloned().collect();
    let mut app = axum::Router::new().route("/healthz", axum::routing::get(|| async { "ok" }));
    if let Some(store) = &serve.cache_store {
        let (store, prefix) = cache::open(store)?;
        let token = serve.cache_token.clone().unwrap_or_default();
        let kept = Duration::from_secs(u64::from(serve.cache_days) * 86_400);
        let cache = Arc::new(Cache::new(
            store,
            prefix.child(key.as_str()),
            token.clone(),
            kept,
        ));
        env.insert(
            "TURBO_API".into(),
            serve.cache_url.clone().unwrap_or_default(),
        );
        env.insert("TURBO_TOKEN".into(), token);
        env.insert("TURBO_TEAM".into(), key.clone());
        app = app.merge(Arc::clone(&cache).router());
        tasks.spawn(sweep(cache, leading.clone(), stop.clone()));
    }
    let listener = tokio::net::TcpListener::bind(serve.listen).await?;
    tracing::info!(listen = %serve.listen, "serving");
    let served = stop.clone();
    tasks.spawn(async move {
        if let Err(error) = axum::serve(listener, app)
            .with_graceful_shutdown(served.cancelled_owned())
            .await
        {
            tracing::error!(%error, "serving failed");
        }
    });

    let (template_tx, template) = watch::channel(serve.template.clone());
    if let Some(repo) = &serve.warm_repo {
        tasks.spawn(warm::keep(
            warm_settings(&serve, &key, repo),
            Arc::clone(&github),
            compute.clone(),
            template_tx,
            leading.clone(),
            stop.clone(),
        ));
    }
    tokio::spawn(stop_on_signal(stop.clone()));

    let owner = std::env::var("HOSTNAME")
        .unwrap_or_else(|_| format!("compute-runners-{}", std::process::id()));
    let settings = pool::Settings {
        name: serve.name.clone(),
        min_idle: serve.min_idle,
        max: serve.max,
        timeout_s: serve.timeout_s,
        env,
        standby: pool::STANDBY_EVERY,
        retry: pool::RETRY_EVERY,
    };
    let pool = Pool::new(Arc::clone(&github), compute, set.id, settings, template);
    let result = pool::listen(pool, &owner, &leading_tx, &stop).await;
    stop.cancel();
    while tasks.join_next().await.is_some() {}
    result
}

fn warm_settings(serve: &Serve, key: &str, repo: &str) -> warm::Settings {
    warm::Settings {
        pool: key.into(),
        base: serve.template.clone(),
        repo: repo.into(),
        branch: serve.warm_branch.clone(),
        prepare: serve.warm_prepare.clone(),
        user: serve.warm_user.clone(),
        work: serve.warm_work.clone(),
        web: serve.github_url.clone(),
        every: Duration::from_secs(serve.warm_every_s),
        within: Duration::from_secs(serve.warm_within_s),
        look: warm::LOOK_EVERY,
    }
}

/// GitHub's client and compute's, which trusts `--compute-ca` too.
fn clients(serve: &Serve) -> Result<(Arc<Github>, Compute)> {
    let client = || {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(300))
    };
    let mut compute_http = client();
    if let Some(ca) = &serve.compute_ca {
        let pem = std::fs::read(ca).with_context(|| format!("reading {}", ca.display()))?;
        for certificate in reqwest::Certificate::from_pem_bundle(&pem)? {
            compute_http = compute_http.add_root_certificate(certificate);
        }
    }
    let github = Arc::new(Github::new(
        client().build()?,
        &serve.github_url,
        &serve.github_api_url,
        Scope::parse(&serve.scope)?,
        credentials(serve)?,
    ));
    let compute = Compute::new(
        compute_http.build()?,
        &serve.compute_url,
        &serve.compute_key,
    );
    Ok((github, compute))
}

/// Cancels `stop` on SIGTERM or an interrupt.
async fn stop_on_signal(stop: CancellationToken) {
    let mut term = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        Ok(term) => term,
        Err(error) => {
            tracing::error!(%error, "cannot watch for SIGTERM");
            return;
        }
    };
    tokio::select! {
        _ = term.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
    tracing::info!("stopping");
    stop.cancel();
}

/// Sweeps the cache while this replica leads.
async fn sweep(cache: Arc<Cache>, leading: watch::Receiver<bool>, stop: CancellationToken) {
    loop {
        if *leading.borrow() {
            match cache.sweep().await {
                Ok(gone) => tracing::info!(gone, "the build cache is swept"),
                Err(error) => tracing::warn!(
                    error = format!("{error:#}"),
                    "sweeping the build cache failed"
                ),
            }
        }
        let wait = if *leading.borrow() {
            cache::SWEEP_EVERY
        } else {
            Duration::from_secs(60)
        };
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            () = stop.cancelled() => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_names_leave_room_for_template_names() {
        for name in ["ci", "web-ci-2", &"a".repeat(40)] {
            assert!(valid_pool_name(name), "{name}");
        }
        for name in ["", "-ci", "CI", "ci_x", "ci.x", &"a".repeat(41)] {
            assert!(!valid_pool_name(name), "{name}");
        }
    }

    #[test]
    fn the_command_line_parses() {
        let cli = Cli::try_parse_from([
            "compute-runners",
            "serve",
            "--scope",
            "acme/web",
            "--name",
            "ci",
            "--template",
            "github-runner",
            "--compute-url",
            "https://compute.example",
            "--compute-key",
            "k",
            "--env",
            "A=b=c",
            "--warm-repo",
            "acme/web",
        ])
        .unwrap();
        let Command::Serve(serve) = cli.command;
        assert_eq!(serve.env, [("A".to_owned(), "b=c".to_owned())]);
        assert_eq!(serve.warm_repo.as_deref(), Some("acme/web"));
        assert!(
            Cli::try_parse_from(["compute-runners", "serve", "--warm-branch", "main"]).is_err()
        );
    }
}
