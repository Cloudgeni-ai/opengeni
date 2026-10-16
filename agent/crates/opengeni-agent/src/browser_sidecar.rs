//! Supervised lifecycle for the loopback browser controller sidecar.
//!
//! One sidecar exists per authority scope (normally workspace + attached Chrome
//! profile) and physical browser connection generation. The control plane never
//! receives its token or loopback URL. Repeated ensures are idempotent; a changed
//! generation or authority replaces the child atomically from the caller's point
//! of view and fences every stale frame/control request.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use async_trait::async_trait;
use opengeni_agent_platform::{
    BrowserControlBackend, BrowserControlEndpoint, PlatformError, PlatformResult,
};
use opengeni_agent_proto::v1;
use serde::Deserialize;
use tokio::{
    io::{AsyncBufReadExt as _, AsyncReadExt as _, BufReader},
    process::{Child, ChildStderr, ChildStdin, Command},
    sync::Mutex,
    task::JoinHandle,
    time::Instant,
};

const BROWSERD_BINARY_ENV: &str = "OPENGENI_BROWSERD_BINARY";
const AGENT_BROWSER_BINARY_ENV: &str = "OPENGENI_BROWSERD_AGENT_BROWSER_BINARY";
const LIGHTPANDA_BINARY_ENV: &str = "OPENGENI_BROWSERD_LIGHTPANDA_BINARY";
const COMPUTER_NATIVE_BINARY_ENV: &str = "OPENGENI_BROWSERD_COMPUTER_NATIVE_BINARY";
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_READY_LINE_BYTES: usize = 4_096;
const MAX_STARTUP_DIAGNOSTIC_BYTES: usize = 4_096;
const MAX_SCOPES: usize = 1_000;
const MAX_SCOPE_BYTES: usize = 512;
const MAX_GENERATION_BYTES: usize = 512;
const MAX_ORIGINS: usize = 64;
const MAX_ORIGIN_BYTES: usize = 2_048;
const MIN_TOKEN_BYTES: usize = 32;
const MAX_TOKEN_BYTES: usize = 2_048;
const IDLE_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// How often the agent looks for controllers that hold nothing.
const EMPTY_CONTROLLER_CHECK_INTERVAL: Duration = Duration::from_secs(60);
/// A controller that stayed empty, and was not ensured, for this long is
/// stopped. Every scope (workspace, placement kind and placement) has its own
/// controller; without this one per scope ever used stays resident until the
/// agent exits. The next ensure starts a fresh one in about a second.
const EMPTY_CONTROLLER_GRACE: Duration = Duration::from_secs(10 * 60);
/// browserd opt-in: exit gracefully when the agent's end of stdin closes.
const PARENT_LIFELINE_ENV: &str = "OPENGENI_BROWSERD_PARENT_LIFELINE";
const MAX_IDLE_RESPONSE_BYTES: usize = 1_024;

#[derive(Debug)]
struct Sidecar {
    child: Child,
    /// The write end of the controller's stdin. Never written; the kernel
    /// closes it however this process ends (crash, SIGKILL, exec), and the
    /// controller then shuts down instead of outliving its agent in its own
    /// process group.
    _lifeline: ChildStdin,
    /// Last ensure or resolve of this scope.
    last_used: Instant,
    /// When the controller was first seen holding nothing, if it still is.
    empty_since: Option<Instant>,
    stderr_task: JoinHandle<()>,
    endpoint: BrowserControlEndpoint,
    scope_generation: String,
    token_digest: blake3::Hash,
    token_file: PathBuf,
    allowed_origins: Vec<String>,
    pending_update: Option<String>,
    exit_reported: bool,
}

impl Sidecar {
    /// Polls the controller process, recording an unexpected exit and its
    /// status once. Its stderr is already in the agent log; the status is what
    /// tells a crash (signal) from a clean exit apart afterwards.
    fn try_wait_logged(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        let status = self.child.try_wait()?;
        if let Some(status) = status {
            if !self.exit_reported {
                self.exit_reported = true;
                tracing::warn!(
                    service = "opengeni-browserd",
                    port = self.endpoint.port,
                    %status,
                    "browser controller exited unexpectedly"
                );
            }
        }
        Ok(status)
    }
}

/// Process owner for browserd children installed beside the connected agent.
#[derive(Debug)]
pub struct BrowserSidecarManager {
    config_dir: PathBuf,
    binary: PathBuf,
    sidecars: Mutex<HashMap<String, Sidecar>>,
    update_drain: Arc<crate::uploads::update_drain::UpdateDrain>,
    /// The local attached-Chrome inventory, once the bridge is listening.
    attached: std::sync::OnceLock<crate::browser_bridge::BrowserBridgeInventory>,
    /// Pooled loopback client for controller requests.
    http_client: reqwest::Client,
    /// Remainders of controller responses too large for one reply.
    http_spool: std::sync::Mutex<crate::browser_control_http::ResponseSpool>,
}

impl BrowserSidecarManager {
    /// Resolves the packaged sidecar and creates a manager rooted in the agent's
    /// owner-only configuration directory.
    pub fn discover(config_dir: impl Into<PathBuf>) -> PlatformResult<Self> {
        let config_dir = config_dir.into();
        let binary = select_packaged_browserd(
            &config_dir,
            std::env::var_os(BROWSERD_BINARY_ENV).is_some(),
            discover_browserd_binary,
        )?;
        Self::with_binary(config_dir, binary)
    }

    /// Constructs a manager with an explicit binary (the live-test seam).
    pub fn with_binary(
        config_dir: impl Into<PathBuf>,
        binary: impl Into<PathBuf>,
    ) -> PlatformResult<Self> {
        let config_dir = config_dir.into();
        let binary = binary.into();
        let metadata = std::fs::metadata(&binary)
            .map_err(|error| PlatformError::from_io("inspect browserd binary", &error))?;
        if !metadata.is_file() {
            return Err(PlatformError::NotFound(
                "browser controller sidecar is not a regular file".to_string(),
            ));
        }
        Ok(Self {
            config_dir,
            binary,
            sidecars: Mutex::new(HashMap::new()),
            update_drain: Arc::default(),
            attached: std::sync::OnceLock::new(),
            http_client: crate::browser_control_http::client()?,
            http_spool: std::sync::Mutex::default(),
        })
    }

    /// Share the host's admission boundary, including lost descendant cleanup.
    pub fn with_update_drain(
        mut self,
        drain: Arc<crate::uploads::update_drain::UpdateDrain>,
    ) -> Self {
        self.update_drain = drain;
        self
    }

    /// Lets the update gate see which attached-Chrome placements would not
    /// survive a restart of this process.
    pub fn observe_attached_inventory(
        &self,
        inventory: crate::browser_bridge::BrowserBridgeInventory,
    ) {
        let _ = self.attached.set(inventory);
    }

    /// Gracefully stops every scoped browser controller so it can terminate
    /// its browser daemons and release profile locks before the agent exits.
    pub async fn shutdown(&self) {
        let sidecars = {
            let mut sidecars = self.sidecars.lock().await;
            sidecars
                .drain()
                .map(|(_, sidecar)| sidecar)
                .collect::<Vec<_>>()
        };
        // Every authority receives its cooperative signal immediately. Serial
        // per-scope waits multiply the stop budget and let the service manager
        // kill later scopes before their profile cleanup even starts.
        futures::future::join_all(
            sidecars
                .into_iter()
                .map(|sidecar| stop_sidecar(sidecar, &self.update_drain)),
        )
        .await;
    }

    #[cfg(test)]
    async fn sidecar_pid(&self, scope_id: &str) -> Option<u32> {
        self.sidecars.lock().await.get(scope_id)?.child.id()
    }

    /// Stops controllers that hold nothing in the background, checking every
    /// minute. The task ends with the manager.
    pub fn spawn_empty_controller_reaper(self: &Arc<Self>) {
        let manager = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(EMPTY_CONTROLLER_CHECK_INTERVAL);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            tick.tick().await;
            loop {
                tick.tick().await;
                let Some(manager) = manager.upgrade() else {
                    return;
                };
                manager
                    .retire_empty_controllers(EMPTY_CONTROLLER_GRACE)
                    .await;
            }
        });
    }

    /// Stops each controller that has reported holding no session for at least
    /// `grace` and has not been ensured or resolved within it. A controller
    /// with any session, retained browser, in-flight work or pending update is
    /// kept. Returns how many were stopped.
    async fn retire_empty_controllers(&self, grace: Duration) -> usize {
        if self.update_drain.is_draining() {
            return 0;
        }
        let Ok(client) = runtime_client() else {
            return 0;
        };
        // Hold the map across the decision and the stop, so an ensure for the
        // same scope cannot start a second controller on its state root.
        let mut sidecars = self.sidecars.lock().await;
        let now = Instant::now();
        let mut retiring = Vec::new();
        for (scope_id, sidecar) in sidecars.iter_mut() {
            let empty = sidecar.pending_update.is_none()
                && matches!(sidecar.try_wait_logged(), Ok(None))
                && sidecar_is_empty(&client, sidecar).await.unwrap_or(false);
            if !empty {
                sidecar.empty_since = None;
                continue;
            }
            let since = *sidecar.empty_since.get_or_insert(now);
            if now.duration_since(since) >= grace && now.duration_since(sidecar.last_used) >= grace
            {
                retiring.push(scope_id.clone());
            }
        }
        for scope_id in &retiring {
            if let Some(sidecar) = sidecars.remove(scope_id) {
                tracing::info!(
                    service = "opengeni-browserd",
                    port = sidecar.endpoint.port,
                    "stopping a browser controller that holds no sessions"
                );
                stop_sidecar(sidecar, &self.update_drain).await;
            }
        }
        retiring.len()
    }

    async fn start(
        &self,
        scope_id: &str,
        scope_generation: &str,
        admin_token: &str,
        allowed_origins: &[String],
    ) -> PlatformResult<Sidecar> {
        let scope_key = scope_storage_key(scope_id);
        let root = self
            .config_dir
            .join("browserd")
            .join("scopes")
            .join(scope_key);
        let authority_dir = root.join("authority");
        let token_file = authority_dir.join("admin-token");
        write_owner_only(&token_file, format!("{admin_token}\n").as_bytes())?;

        let mut command = Command::new(&self.binary);
        command
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .env(PARENT_LIFELINE_ENV, "stdin")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("OPENGENI_BROWSERD_ROOT", root.join("state"))
            .env("OPENGENI_BROWSERD_ADMIN_TOKEN_FILE", &token_file)
            .env("OPENGENI_BROWSERD_HOSTNAME", "127.0.0.1")
            .env("OPENGENI_BROWSERD_PORT", "0")
            .env(
                "OPENGENI_BROWSERD_ALLOWED_ORIGINS",
                allowed_origins.join(","),
            )
            // The attached bridge resolves its authority from the same exact
            // config directory as the parent agent, including custom/XDG roots.
            .env("OPENGENI_CONFIG_DIR", &self.config_dir);
        #[cfg(unix)]
        // Keep terminal Ctrl-C/SIGHUP propagation from racing the manager's
        // single cooperative shutdown signal. Without a private process group,
        // browserd receives the terminal SIGINT first, unregisters that one-shot
        // handler, then the manager's second SIGINT kills it mid-cleanup and
        // leaves its browser daemon/profile lock behind.
        command.process_group(0);
        configure_companion_binaries(&mut command, &self.binary);
        let mut child = command
            .spawn()
            .map_err(|error| PlatformError::from_io("start browser controller sidecar", &error))?;
        let (lifeline, stdout, stderr) = take_sidecar_pipes(&mut child).inspect_err(|_| {
            self.update_drain.mark_unsettled();
        })?;
        let stderr_diagnostic = Arc::new(Mutex::new(Vec::new()));
        let stderr_task = tokio::spawn(drain_bounded_stderr(
            stderr,
            Arc::clone(&stderr_diagnostic),
            admin_token.to_string(),
        ));
        let ready = match tokio::time::timeout(READY_TIMEOUT, read_ready_line(stdout)).await {
            Ok(result) => result,
            Err(_) => Err(PlatformError::Timeout(
                "browser controller sidecar did not become ready".to_string(),
            )),
        };
        let ready = match ready {
            Ok(ready) => ready,
            Err(error) => {
                self.update_drain.mark_unsettled();
                return Err(stop_with_startup_diagnostic(
                    child,
                    stderr_task,
                    stderr_diagnostic,
                    admin_token,
                    error,
                )
                .await);
            }
        };
        if let Some(mismatches) = ready_document_mismatches(&ready, admin_token) {
            self.update_drain.mark_unsettled();
            return Err(stop_with_startup_diagnostic(
                child,
                stderr_task,
                stderr_diagnostic,
                admin_token,
                PlatformError::os(
                    format!("browser controller sidecar returned an incompatible ready document: {mismatches}"),
                ),
            )
            .await);
        }
        Ok(Sidecar {
            child,
            _lifeline: lifeline,
            last_used: Instant::now(),
            empty_since: None,
            stderr_task,
            endpoint: BrowserControlEndpoint {
                port: ready.port,
                sidecar_generation: uuid::Uuid::new_v4().to_string(),
            },
            scope_generation: scope_generation.to_string(),
            token_digest: blake3::hash(admin_token.as_bytes()),
            token_file,
            allowed_origins: allowed_origins.to_vec(),
            pending_update: None,
            exit_reported: false,
        })
    }
}

fn take_sidecar_pipes(
    child: &mut Child,
) -> PlatformResult<(ChildStdin, tokio::process::ChildStdout, ChildStderr)> {
    let missing = |pipe: &str| {
        PlatformError::os(format!(
            "browser controller sidecar {pipe} was not captured"
        ))
    };
    Ok((
        child.stdin.take().ok_or_else(|| missing("lifeline"))?,
        child.stdout.take().ok_or_else(|| missing("stdout"))?,
        child.stderr.take().ok_or_else(|| missing("stderr"))?,
    ))
}

fn configure_companion_binaries(command: &mut Command, browserd_binary: &Path) {
    for (environment, name) in [
        (AGENT_BROWSER_BINARY_ENV, companion_name("agent-browser")),
        (LIGHTPANDA_BINARY_ENV, companion_name("lightpanda")),
        (
            COMPUTER_NATIVE_BINARY_ENV,
            companion_name("opengeni-computer-native"),
        ),
    ] {
        // Explicit operator overrides remain authoritative. Release and local
        // app bundles need no configuration: companions installed beside
        // browserd are forwarded privately to the child.
        if std::env::var_os(environment).is_none() {
            if let Some(path) = discover_companion_binary(browserd_binary, &name) {
                command.env(environment, path);
            }
        }
    }
}

async fn add_allowed_origins(
    endpoint: &BrowserControlEndpoint,
    admin_token: &str,
    origins: &[String],
) -> PlatformResult<()> {
    let request = reqwest::Client::new()
        .put(format!("http://127.0.0.1:{}/v1/origins", endpoint.port))
        .bearer_auth(admin_token)
        .json(&serde_json::json!({ "origins": origins }))
        .send();
    let response = tokio::time::timeout(Duration::from_secs(5), request)
        .await
        .map_err(|_| {
            PlatformError::Timeout(
                "browser controller origin update exceeded its deadline".to_string(),
            )
        })?
        .map_err(|_| PlatformError::os("browser controller origin update failed"))?;
    if !response.status().is_success() {
        return Err(PlatformError::os(format!(
            "browser controller rejected its origin update with status {}",
            response.status().as_u16()
        )));
    }
    Ok(())
}

#[async_trait]
impl BrowserControlBackend for BrowserSidecarManager {
    async fn begin_update(&self, operation_id: &str) -> PlatformResult<bool> {
        sidecars_update_admission(self, operation_id, true).await
    }

    async fn release_update(&self, operation_id: &str) -> PlatformResult<()> {
        sidecars_update_admission(self, operation_id, false)
            .await
            .map(|_| ())
    }

    async fn is_idle(&self) -> PlatformResult<bool> {
        // Hold the generation map across the proof. The supervisor has already
        // fenced routed work; this also prevents an in-flight ensure replacing
        // one endpoint between observation and the update decision.
        tokio::time::timeout(IDLE_PROBE_TIMEOUT, async {
            let mut sidecars = self.sidecars.lock().await;
            if sidecars.is_empty() {
                return Ok(true);
            }
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(IDLE_PROBE_TIMEOUT)
                .build()
                .map_err(|_| PlatformError::os("browser controller idle probe unavailable"))?;
            for sidecar in sidecars.values_mut() {
                if sidecar
                    .try_wait_logged()
                    .map_err(|_| {
                        self.update_drain.mark_unsettled();
                        PlatformError::os("browser controller process state unavailable")
                    })?
                    .is_some()
                {
                    self.update_drain.mark_unsettled();
                    // A crashed controller may have left children behind. It
                    // cannot prove idle; ordinary scoped recovery owns cleanup.
                    return Err(PlatformError::os("browser controller is no longer running"));
                }
                if !sidecar_is_idle(&client, sidecar).await? {
                    return Ok(false);
                }
                // A controller bound to an older extension's per-port
                // placement would see it change when the bridge restarts,
                // ending that profile's sessions. Wait for idle instead.
                if self.attached.get().is_some_and(|attached| {
                    attached.placement_ends_on_reconnect(&sidecar.scope_generation)
                }) {
                    return Ok(false);
                }
            }
            Ok(true)
        })
        .await
        .map_err(|_| PlatformError::Timeout("browser controller idle probe timed out".into()))?
    }

    async fn ensure(
        &self,
        req: &v1::BrowserControlEnsureRequest,
    ) -> PlatformResult<BrowserControlEndpoint> {
        let scope_id =
            bounded_identifier(&req.scope_id, MAX_SCOPE_BYTES, "browser authority scope")?;
        let scope_generation = bounded_identifier(
            &req.scope_generation,
            MAX_GENERATION_BYTES,
            "attached browser generation",
        )?;
        let admin_token = validate_token(&req.admin_token)?;
        let allowed_origins = canonical_origins(&req.allowed_origins)?;
        let token_digest = blake3::hash(admin_token.as_bytes());

        let mut sidecars = self.sidecars.lock().await;
        if let Some(existing) = sidecars.get_mut(scope_id) {
            let live = existing
                .try_wait_logged()
                .map_err(|error| {
                    self.update_drain.mark_unsettled();
                    PlatformError::from_io("inspect browser controller sidecar", &error)
                })?
                .is_none();
            if !live {
                self.update_drain.mark_unsettled();
            }
            if live
                && existing.scope_generation == scope_generation
                && existing.token_digest == token_digest
            {
                recover_update_admission(existing, &self.update_drain).await?;
                existing.last_used = Instant::now();
                let additions = allowed_origins
                    .iter()
                    .filter(|origin| !existing.allowed_origins.contains(origin))
                    .cloned()
                    .collect::<Vec<_>>();
                if !additions.is_empty() {
                    add_allowed_origins(&existing.endpoint, admin_token, &additions).await?;
                    existing.allowed_origins.extend(additions);
                    existing.allowed_origins.sort_unstable();
                    existing.allowed_origins.dedup();
                }
                return Ok(existing.endpoint.clone());
            }
        }
        if sidecars.len() >= MAX_SCOPES && !sidecars.contains_key(scope_id) {
            return Err(PlatformError::os(
                "browser controller sidecar scope bound was reached",
            ));
        }
        if let Some(stale) = sidecars.remove(scope_id) {
            stop_sidecar(stale, &self.update_drain).await;
        }
        let sidecar = self
            .start(scope_id, scope_generation, admin_token, &allowed_origins)
            .await?;
        let endpoint = sidecar.endpoint.clone();
        sidecars.insert(scope_id.to_string(), sidecar);
        Ok(endpoint)
    }

    async fn resolve(
        &self,
        scope_id: &str,
        scope_generation: &str,
    ) -> PlatformResult<BrowserControlEndpoint> {
        let scope_id = bounded_identifier(scope_id, MAX_SCOPE_BYTES, "browser authority scope")?;
        let scope_generation = bounded_identifier(
            scope_generation,
            MAX_GENERATION_BYTES,
            "attached browser generation",
        )?;
        let mut sidecars = self.sidecars.lock().await;
        let sidecar = sidecars.get_mut(scope_id).ok_or_else(|| {
            PlatformError::NotFound("browser controller sidecar is not running".to_string())
        })?;
        if sidecar.scope_generation != scope_generation {
            return Err(PlatformError::Unsupported(
                "browser controller sidecar generation is stale".to_string(),
            ));
        }
        if sidecar
            .try_wait_logged()
            .map_err(|error| {
                self.update_drain.mark_unsettled();
                PlatformError::from_io("inspect browser controller sidecar", &error)
            })?
            .is_some()
        {
            self.update_drain.mark_unsettled();
            sidecar.stderr_task.abort();
            sidecars.remove(scope_id);
            return Err(PlatformError::NotFound(
                "browser controller sidecar is no longer running".to_string(),
            ));
        }
        recover_update_admission(sidecar, &self.update_drain).await?;
        sidecar.last_used = Instant::now();
        Ok(sidecar.endpoint.clone())
    }

    fn http_supported(&self) -> bool {
        true
    }

    async fn http(
        &self,
        req: &v1::BrowserControlHttpRequest,
        inline_limit: Option<usize>,
    ) -> PlatformResult<v1::BrowserControlHttpResponse> {
        let checked = crate::browser_control_http::check(req)?;
        // A replaced generation means the caller's controller is gone; like a
        // missing one, nothing was sent, so it may ensure and send again.
        let endpoint = self
            .resolve(&req.scope_id, &req.scope_generation)
            .await
            .map_err(|error| match error {
                PlatformError::Unsupported(message) => PlatformError::NotFound(message),
                other => other,
            })?;
        crate::browser_control_http::send(
            &self.http_client,
            endpoint.port,
            req,
            checked,
            inline_limit,
            &self.http_spool,
        )
        .await
    }

    async fn http_read(
        &self,
        req: &v1::BrowserControlHttpReadRequest,
        max_bytes: Option<usize>,
    ) -> PlatformResult<v1::BrowserControlHttpReadResponse> {
        self.http_spool
            .lock()
            .map_err(|_| PlatformError::os("browser controller response spool is unavailable"))?
            .read(req, max_bytes)
    }
}

async fn sidecar_is_idle(client: &reqwest::Client, sidecar: &Sidecar) -> PlatformResult<bool> {
    Ok(sidecar_runtime_request(client, sidecar, None).await?.idle)
}

/// Whether the controller reports that it holds no session at all. A
/// controller from before this report never counts as empty.
async fn sidecar_is_empty(client: &reqwest::Client, sidecar: &Sidecar) -> PlatformResult<bool> {
    Ok(sidecar_runtime_request(client, sidecar, None)
        .await?
        .empty
        .unwrap_or(false))
}

fn runtime_client() -> PlatformResult<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(IDLE_PROBE_TIMEOUT)
        .build()
        .map_err(|_| PlatformError::os("browser controller update admission unavailable"))
}

async fn release_sidecar_update(
    client: &reqwest::Client,
    sidecar: &mut Sidecar,
    operation_id: &str,
) -> PlatformResult<()> {
    sidecar_runtime_request(client, sidecar, Some((operation_id, false))).await?;
    if sidecar.pending_update.as_deref() == Some(operation_id) {
        sidecar.pending_update = None;
    }
    Ok(())
}

async fn recover_update_admission(
    sidecar: &mut Sidecar,
    drain: &crate::uploads::update_drain::UpdateDrain,
) -> PlatformResult<()> {
    if drain.is_draining() {
        return Ok(());
    }
    if let Some(operation_id) = sidecar.pending_update.clone() {
        release_sidecar_update(&runtime_client()?, sidecar, &operation_id).await?;
    }
    Ok(())
}

async fn sidecars_update_admission(
    manager: &BrowserSidecarManager,
    operation_id: &str,
    begin: bool,
) -> PlatformResult<bool> {
    tokio::time::timeout(IDLE_PROBE_TIMEOUT, async {
        let mut sidecars = manager.sidecars.lock().await;
        let client = runtime_client()?;
        let mut idle = true;
        let mut failure = None;
        for sidecar in sidecars.values_mut() {
            if !matches!(sidecar.try_wait_logged(), Ok(None)) {
                manager.update_drain.mark_unsettled();
                failure = Some(PlatformError::os("browser controller is no longer running"));
                continue;
            }
            if let Some(previous) = sidecar.pending_update.clone() {
                if previous != operation_id {
                    if !begin {
                        failure =
                            Some(PlatformError::os("browser controller update owner differs"));
                        continue;
                    }
                    if let Err(error) = release_sidecar_update(&client, sidecar, &previous).await {
                        failure = Some(error);
                        continue;
                    }
                }
            }
            // Remember before dispatch: cancellation or a lost reply does not
            // prove that the controller failed to install this exact fence.
            if begin {
                sidecar.pending_update = Some(operation_id.to_owned());
            }
            match sidecar_runtime_request(&client, sidecar, Some((operation_id, begin))).await {
                Ok(state) => {
                    idle &= state.idle;
                    if !begin {
                        sidecar.pending_update = None;
                    }
                }
                Err(error) => failure = Some(error),
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(idle),
        }
    })
    .await
    .map_err(|_| PlatformError::Timeout("browser controller update admission timed out".into()))?
}

async fn sidecar_runtime_request(
    client: &reqwest::Client,
    sidecar: &Sidecar,
    update: Option<(&str, bool)>,
) -> PlatformResult<RuntimeIdleState> {
    // Read the existing owner-only authority instead of keeping another bearer
    // in the manager's printable state. Refuse mutable authority drift.
    let file = tokio::fs::File::open(&sidecar.token_file)
        .await
        .map_err(|_| PlatformError::os("browser controller authority unavailable"))?;
    let mut token = String::new();
    file.take((MAX_TOKEN_BYTES + 2) as u64)
        .read_to_string(&mut token)
        .await
        .map_err(|_| PlatformError::os("browser controller authority unreadable"))?;
    let token = validate_token(token.trim())?;
    if blake3::hash(token.as_bytes()) != sidecar.token_digest {
        return Err(PlatformError::os("browser controller authority changed"));
    }
    let request = match update {
        Some((operation_id, begin)) => client
            .request(
                if begin {
                    reqwest::Method::POST
                } else {
                    reqwest::Method::DELETE
                },
                format!(
                    "http://127.0.0.1:{}/v1/runtime/update",
                    sidecar.endpoint.port
                ),
            )
            .json(&serde_json::json!({"operationId": operation_id})),
        None => client.get(format!(
            "http://127.0.0.1:{}/v1/runtime",
            sidecar.endpoint.port
        )),
    };
    let mut response = request
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| PlatformError::os("browser controller idle probe failed"))?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(PlatformError::os(
            "browser controller idle proof unavailable",
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| PlatformError::os("browser controller idle proof unreadable"))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_IDLE_RESPONSE_BYTES {
            return Err(PlatformError::os(
                "browser controller idle proof exceeded its bound",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let proof: RuntimeIdleResponse = serde_json::from_slice(&body)
        .map_err(|_| PlatformError::os("browser controller idle proof incompatible"))?;
    if !proof.ok
        || proof.protocol_version != 1
        || update.is_some_and(|(operation_id, _)| {
            proof.data.operation_id.as_deref() != Some(operation_id)
        })
        || update.is_some_and(|(_, begin)| !begin && proof.data.released != Some(true))
    {
        return Err(PlatformError::os(
            "browser controller idle proof incompatible",
        ));
    }
    Ok(proof.data)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeIdleResponse {
    protocol_version: u32,
    ok: bool,
    data: RuntimeIdleState,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeIdleState {
    idle: bool,
    #[serde(default)]
    empty: Option<bool>,
    #[serde(default)]
    operation_id: Option<String>,
    #[serde(default)]
    released: Option<bool>,
}

async fn stop_sidecar(mut sidecar: Sidecar, drain: &crate::uploads::update_drain::UpdateDrain) {
    let cooperative = matches!(sidecar.child.try_wait(), Ok(None))
        && signal_sidecar_termination(&mut sidecar.child);
    match tokio::time::timeout(
        Duration::from_secs(
            opengeni_agent_platform::service::BROWSER_SIDECAR_SHUTDOWN_TIMEOUT_SECS,
        ),
        sidecar.child.wait(),
    )
    .await
    {
        Ok(Ok(status)) if cooperative && status.success() => {}
        result => {
            drain.mark_unsettled();
            if result.is_err() {
                let _ = sidecar.child.kill().await;
                let _ = sidecar.child.wait().await;
            }
        }
    }
    if tokio::time::timeout(Duration::from_secs(1), &mut sidecar.stderr_task)
        .await
        .is_err()
    {
        sidecar.stderr_task.abort();
    }
}

#[cfg(unix)]
fn signal_sidecar_termination(child: &mut Child) -> bool {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;

    if let Some(id) = child.id().and_then(|id| i32::try_from(id).ok()) {
        // browserd's Bun standalone reliably runs its registered graceful
        // shutdown path for SIGINT. On macOS a SIGTERM exits the standalone at
        // the native launcher boundary before Bun dispatches the JS signal
        // listener, orphaning its private agent-browser/Chromium daemon. SIGINT
        // is still a cooperative termination request; the bounded wait + exact
        // child kill below remains the hard-stop fallback.
        return kill(Pid::from_raw(id), Signal::SIGINT).is_ok();
    }
    false
}

#[cfg(windows)]
fn signal_sidecar_termination(child: &mut Child) -> bool {
    let _ = child.start_kill();
    false
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadyDocument {
    service: String,
    status: String,
    protocol_version: u32,
    runtime_build_id: String,
    #[serde(rename = "computer")]
    _computer_available: bool,
    hostname: String,
    port: u16,
}

fn expected_runtime_build_id() -> &'static str {
    option_env!("OPENGENI_RUNTIME_BUILD_ID").unwrap_or("development")
}

fn ready_document_mismatches(ready: &ReadyDocument, admin_token: &str) -> Option<String> {
    let mut mismatches = Vec::new();
    for (field, expected, received) in [
        ("service", "opengeni-browserd", ready.service.as_str()),
        ("status", "ready", ready.status.as_str()),
        (
            "runtimeBuildId",
            expected_runtime_build_id(),
            ready.runtime_build_id.as_str(),
        ),
        ("hostname", "127.0.0.1", ready.hostname.as_str()),
    ] {
        if received != expected {
            mismatches.push(format!(
                "{field} expected {}, received {}",
                bounded_ready_value(expected, admin_token),
                bounded_ready_value(received, admin_token)
            ));
        }
    }
    if ready.protocol_version != 1 {
        mismatches.push(format!(
            "protocolVersion expected 1, received {}",
            ready.protocol_version
        ));
    }
    if ready.port == 0 {
        mismatches.push("port expected nonzero, received 0".to_string());
    }
    (!mismatches.is_empty()).then(|| mismatches.join("; "))
}

fn bounded_ready_value(value: &str, admin_token: &str) -> String {
    format!(
        "{:?}",
        value
            .replace(admin_token, "[redacted]")
            .chars()
            .take(128)
            .collect::<String>()
    )
}

async fn read_ready_line(stdout: tokio::process::ChildStdout) -> PlatformResult<ReadyDocument> {
    let mut lines = BufReader::new(stdout).lines();
    let line = lines
        .next_line()
        .await
        .map_err(|error| PlatformError::from_io("read browser controller ready line", &error))?
        .ok_or_else(|| PlatformError::os("browser controller sidecar exited before ready"))?;
    if line.is_empty() || line.len() > MAX_READY_LINE_BYTES {
        return Err(PlatformError::os(
            "browser controller sidecar returned an invalid ready line",
        ));
    }
    serde_json::from_str(&line)
        .map_err(|_| PlatformError::os("browser controller sidecar ready document is invalid"))
}

async fn drain_bounded_stderr(
    mut stderr: ChildStderr,
    diagnostic: Arc<Mutex<Vec<u8>>>,
    admin_token: String,
) {
    let mut chunk = [0_u8; 1_024];
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let count = match stderr.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(count) => count,
        };
        {
            let mut diagnostic = diagnostic.lock().await;
            let remaining = MAX_STARTUP_DIAGNOSTIC_BYTES.saturating_sub(diagnostic.len());
            diagnostic.extend_from_slice(&chunk[..count.min(remaining)]);
        }
        for byte in &chunk[..count] {
            if *byte == b'\n' {
                if oversized {
                    tracing::warn!(
                        service = "opengeni-browserd",
                        "controller diagnostic exceeded the line limit"
                    );
                } else if !line.is_empty() {
                    let message =
                        String::from_utf8_lossy(&line).replace(&admin_token, "[redacted]");
                    tracing::warn!(service = "opengeni-browserd", diagnostic = %message, "controller diagnostic");
                }
                line.clear();
                oversized = false;
            } else if !oversized {
                if line.len() < MAX_STARTUP_DIAGNOSTIC_BYTES {
                    line.push(*byte);
                } else {
                    // Discard the whole oversized line, including partial credentials.
                    line.clear();
                    oversized = true;
                }
            }
        }
    }
}

async fn stop_with_startup_diagnostic(
    mut child: Child,
    mut stderr_task: JoinHandle<()>,
    diagnostic: Arc<Mutex<Vec<u8>>>,
    admin_token: &str,
    error: PlatformError,
) -> PlatformError {
    let _ = child.kill().await;
    let _ = child.wait().await;
    if tokio::time::timeout(Duration::from_secs(1), &mut stderr_task)
        .await
        .is_err()
    {
        stderr_task.abort();
    }
    let diagnostic = diagnostic.lock().await;
    let rendered = String::from_utf8_lossy(&diagnostic)
        .replace(admin_token, "[redacted]")
        .chars()
        .map(|character| {
            if character.is_control() && !matches!(character, '\n' | '\r' | '\t') {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let rendered = rendered.trim();
    if rendered.is_empty() {
        error
    } else {
        let diagnostic = format!("browserd: {rendered}");
        append_platform_error(error, &diagnostic)
    }
}

fn append_platform_error(error: PlatformError, diagnostic: &str) -> PlatformError {
    match error {
        PlatformError::Unsupported(message) => {
            PlatformError::Unsupported(format!("{message}; {diagnostic}"))
        }
        PlatformError::NotFound(message) => {
            PlatformError::NotFound(format!("{message}; {diagnostic}"))
        }
        PlatformError::ConsentRequired(message) => {
            PlatformError::ConsentRequired(format!("{message}; {diagnostic}"))
        }
        PlatformError::Timeout(message) => {
            PlatformError::Timeout(format!("{message}; {diagnostic}"))
        }
        PlatformError::Os {
            message,
            mut detail,
        } => {
            detail.insert("browserd_stderr".to_string(), diagnostic.to_string());
            PlatformError::Os {
                message: format!("{message}; {diagnostic}"),
                detail,
            }
        }
        PlatformError::Stream { message, retryable } => PlatformError::Stream {
            message: format!("{message}; {diagnostic}"),
            retryable,
        },
    }
}

fn select_packaged_browserd(
    config_dir: &Path,
    explicit: bool,
    adjacent: impl FnOnce() -> PlatformResult<PathBuf>,
) -> PlatformResult<PathBuf> {
    if explicit {
        adjacent()
    } else if let Some(embedded) = crate::embedded_runtime::materialize(config_dir)? {
        Ok(embedded)
    } else {
        adjacent()
    }
}

fn discover_browserd_binary() -> PlatformResult<PathBuf> {
    let candidates = if let Some(explicit) = std::env::var_os(BROWSERD_BINARY_ENV) {
        vec![PathBuf::from(explicit)]
    } else {
        let executable = std::env::current_exe()
            .map_err(|error| PlatformError::from_io("resolve running agent path", &error))?;
        let parent = executable.parent().unwrap_or_else(|| Path::new("."));
        let name = if cfg!(windows) {
            "opengeni-browserd.exe"
        } else {
            "opengeni-browserd"
        };
        vec![
            parent.join(name),
            parent.join("../Helpers").join(name),
            parent.join("../Resources").join(name),
        ]
    };
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            PlatformError::NotFound(
                "browser controller sidecar is not installed beside the agent".to_string(),
            )
        })
}

fn companion_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

fn discover_companion_binary(browserd: &Path, name: &str) -> Option<PathBuf> {
    let browserd_parent = browserd.parent().unwrap_or_else(|| Path::new("."));
    let agent = std::env::current_exe().ok();
    let agent_parent = agent.as_deref().and_then(Path::parent);
    [
        Some(browserd_parent.join(name)),
        Some(browserd_parent.join("../Helpers").join(name)),
        Some(browserd_parent.join("../Resources").join(name)),
        agent_parent.map(|parent| parent.join(name)),
        agent_parent.map(|parent| parent.join("../Helpers").join(name)),
        agent_parent.map(|parent| parent.join("../Resources").join(name)),
    ]
    .into_iter()
    .flatten()
    .find(|candidate| candidate.is_file())
}

fn bounded_identifier<'a>(value: &'a str, maximum: usize, label: &str) -> PlatformResult<&'a str> {
    if value.is_empty()
        || value.len() > maximum
        || value.starts_with('/')
        || value.ends_with('/')
        || value
            .split('/')
            .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-/".contains(&byte))
    {
        return Err(PlatformError::os(format!("{label} is invalid")));
    }
    Ok(value)
}

fn validate_token(value: &str) -> PlatformResult<&str> {
    if value.len() < MIN_TOKEN_BYTES
        || value.len() > MAX_TOKEN_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._~-".contains(&byte))
    {
        return Err(PlatformError::os("browser controller authority is invalid"));
    }
    Ok(value)
}

fn canonical_origins(origins: &[String]) -> PlatformResult<Vec<String>> {
    if origins.len() > MAX_ORIGINS {
        return Err(PlatformError::os(
            "browser controller origin bound was reached",
        ));
    }
    let mut result = Vec::with_capacity(origins.len());
    for origin in origins {
        if origin.is_empty()
            || origin.len() > MAX_ORIGIN_BYTES
            || origin
                .bytes()
                .any(|byte| byte == b',' || byte.is_ascii_control())
        {
            return Err(PlatformError::os("browser controller origin is invalid"));
        }
        result.push(origin.clone());
    }
    result.sort_unstable();
    result.dedup();
    Ok(result)
}

fn scope_storage_key(scope_id: &str) -> String {
    blake3::hash(scope_id.as_bytes()).to_hex().to_string()
}

fn write_owner_only(destination: &Path, body: &[u8]) -> PlatformResult<()> {
    use std::io::Write as _;

    let parent = destination
        .parent()
        .ok_or_else(|| PlatformError::os("browser controller authority path has no parent"))?;
    std::fs::create_dir_all(parent).map_err(|error| {
        PlatformError::from_io("create browser controller authority directory", &error)
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).map_err(
            |error| PlatformError::from_io("secure browser controller authority directory", &error),
        )?;
        let temporary = parent.join(format!(
            ".admin-token.{}.{}.tmp",
            std::process::id(),
            TOKEN_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true).mode(0o600);
        let mut file = options.open(&temporary).map_err(|error| {
            PlatformError::from_io("create browser controller authority", &error)
        })?;
        file.write_all(body)
            .and_then(|()| file.sync_all())
            .map_err(|error| {
                PlatformError::from_io("write browser controller authority", &error)
            })?;
        std::fs::rename(&temporary, destination).map_err(|error| {
            PlatformError::from_io("publish browser controller authority", &error)
        })?;
    }
    #[cfg(windows)]
    {
        let temporary = parent.join(format!(
            ".admin-token.{}.{}.tmp",
            std::process::id(),
            TOKEN_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| {
                PlatformError::from_io("create browser controller authority", &error)
            })?;
        file.write_all(body)
            .and_then(|()| file.sync_all())
            .map_err(|error| {
                PlatformError::from_io("write browser controller authority", &error)
            })?;
        if destination.exists() {
            std::fs::remove_file(destination).map_err(|error| {
                PlatformError::from_io("replace browser controller authority", &error)
            })?;
        }
        std::fs::rename(&temporary, destination).map_err(|error| {
            PlatformError::from_io("publish browser controller authority", &error)
        })?;
    }
    Ok(())
}

static TOKEN_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn idle_fixture_manager(directory: &Path, port: u16) -> BrowserSidecarManager {
        use std::os::unix::fs::PermissionsExt as _;
        let binary = directory.join("idle-browserd");
        let ready = serde_json::json!({
            "service": "opengeni-browserd", "status": "ready", "protocolVersion": 1,
            "computer": true,
            "runtimeBuildId": expected_runtime_build_id(), "hostname": "127.0.0.1", "port": port,
        });
        std::fs::write(&binary, format!(
            "#!/bin/sh\nprintf '%s\\n' '{ready}'\ntrap 'exit 0' INT\nwhile :; do sleep 1 & wait $!; done\n"
        )).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        BrowserSidecarManager::with_binary(directory.join("config"), binary).unwrap()
    }

    #[cfg(unix)]
    async fn serve_idle_proofs(listener: tokio::net::TcpListener, replies: Vec<(u16, String)>) {
        use tokio::io::AsyncWriteExt as _;
        for (status, body) in replies {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1_024];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0 && request.len() + count <= 8_192);
                request.extend_from_slice(&chunk[..count]);
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("GET /v1/runtime HTTP/1.1\r\n"));
            assert!(request.contains(&format!("authorization: Bearer {}\r\n", "p".repeat(32))));
            socket.write_all(format!(
                "HTTP/1.1 {status} Fixture\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: {}\r\nlocation: http://127.0.0.1:1/refused\r\n\r\n{body}", body.len()
            ).as_bytes()).await.unwrap();
        }
    }

    #[cfg(unix)]
    async fn ensure_idle_fixture(manager: &BrowserSidecarManager, scope: &str) {
        manager
            .ensure(&v1::BrowserControlEnsureRequest {
                scope_id: scope.into(),
                scope_generation: "fixture-generation".into(),
                admin_token: "p".repeat(32),
                allowed_origins: vec![],
            })
            .await
            .unwrap();
    }

    #[cfg(target_os = "linux")]
    fn process_is_gone(pid: u32) -> bool {
        // An exited child of a dead parent may linger briefly as a zombie
        // until its new parent reaps it; it no longer runs either way.
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => stat
                .rsplit_once(") ")
                .is_some_and(|(_, rest)| rest.starts_with('Z')),
            Err(_) => true,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn http_resolves_the_exact_scope_and_never_guesses_a_port() {
        let directory = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let manager = idle_fixture_manager(directory.path(), listener.local_addr().unwrap().port());
        assert!(manager.http_supported());
        let request = |scope: &str, generation: &str| v1::BrowserControlHttpRequest {
            scope_id: scope.into(),
            scope_generation: generation.into(),
            method: "GET".into(),
            path: "/v1/runtime".into(),
            bearer_token: "p".repeat(32),
            body: prost::bytes::Bytes::new(),
            has_body: false,
            timeout_ms: 5_000,
            max_response_bytes: 4_096,
        };
        // Nothing ensured yet: the caller learns to ensure, and nothing is sent.
        let absent = manager
            .http(&request("scope-http", "fixture-generation"), None)
            .await
            .unwrap_err();
        assert!(matches!(absent, PlatformError::NotFound(_)), "{absent:?}");

        ensure_idle_fixture(&manager, "scope-http").await;
        let stale = manager
            .http(&request("scope-http", "older-generation"), None)
            .await
            .unwrap_err();
        assert!(matches!(stale, PlatformError::NotFound(_)), "{stale:?}");

        let body = r#"{"protocolVersion":1,"ok":true,"data":{"idle":true}}"#;
        let server = tokio::spawn(serve_idle_proofs(listener, vec![(200, body.into())]));
        let response = manager
            .http(&request("scope-http", "fixture-generation"), Some(16))
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.total_bytes, body.len() as u64);
        assert_eq!(&response.body[..], &body.as_bytes()[..16]);
        let rest = manager
            .http_read(
                &v1::BrowserControlHttpReadRequest {
                    spool_id: response.spool_id,
                    offset: 16,
                },
                None,
            )
            .await
            .unwrap();
        assert!(rest.done);
        assert_eq!(&rest.data[..], &body.as_bytes()[16..]);
        assert!(response
            .headers
            .iter()
            .any(|header| header.name == "content-type" && header.value == "application/json"));
        manager.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_empty_controller_is_stopped_after_its_grace_and_restarts_on_demand() {
        let directory = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let manager = idle_fixture_manager(directory.path(), listener.local_addr().unwrap().port());
        let empty = r#"{"protocolVersion":1,"ok":true,"data":{"idle":true,"empty":true}}"#;
        let server = tokio::spawn(serve_idle_proofs(
            listener,
            vec![(200, empty.into()), (200, empty.into())],
        ));
        ensure_idle_fixture(&manager, "unused").await;
        let pid = manager.sidecar_pid("unused").await.unwrap();
        let grace = Duration::from_millis(300);
        assert_eq!(
            manager.retire_empty_controllers(grace).await,
            0,
            "the first empty report only starts the grace period"
        );
        tokio::time::sleep(grace + Duration::from_millis(50)).await;
        assert_eq!(manager.retire_empty_controllers(grace).await, 1);
        assert!(manager.sidecars.lock().await.is_empty());
        assert!(
            nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(i32::try_from(pid).unwrap()),
                None
            )
            .is_err(),
            "the retired controller process was stopped and reaped"
        );
        ensure_idle_fixture(&manager, "unused").await;
        assert_ne!(manager.sidecar_pid("unused").await.unwrap(), pid);
        manager.shutdown().await;
        server.await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn controllers_with_sessions_older_reports_or_recent_use_are_kept() {
        let directory = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let manager = idle_fixture_manager(directory.path(), listener.local_addr().unwrap().port());
        // A retained live browser is idle (a restart preserves it) but not empty.
        let retained = r#"{"protocolVersion":1,"ok":true,"data":{"idle":true,"empty":false}}"#;
        // A controller from before the `empty` report.
        let older = r#"{"protocolVersion":1,"ok":true,"data":{"idle":true}}"#;
        let empty = r#"{"protocolVersion":1,"ok":true,"data":{"idle":true,"empty":true}}"#;
        let server = tokio::spawn(serve_idle_proofs(
            listener,
            vec![
                (200, retained.into()),
                (200, older.into()),
                (200, empty.into()),
                (200, empty.into()),
            ],
        ));
        ensure_idle_fixture(&manager, "first").await;
        ensure_idle_fixture(&manager, "second").await;
        assert_eq!(manager.retire_empty_controllers(Duration::ZERO).await, 0);
        assert_eq!(manager.sidecars.lock().await.len(), 2);
        manager.shutdown().await;

        ensure_idle_fixture(&manager, "busy").await;
        let grace = Duration::from_millis(300);
        assert_eq!(manager.retire_empty_controllers(grace).await, 0);
        tokio::time::sleep(grace + Duration::from_millis(50)).await;
        // An ensure is about to create a session; the controller stays.
        ensure_idle_fixture(&manager, "busy").await;
        assert_eq!(manager.retire_empty_controllers(grace).await, 0);
        assert_eq!(manager.sidecars.lock().await.len(), 1);
        manager.shutdown().await;
        server.await.unwrap();
    }

    const REAL_BROWSERD_ENTRYPOINT_ENV: &str = "OPENGENI_REAL_BROWSERD_ENTRYPOINT";
    const LIFELINE_CHILD_ENV: &str = "OPENGENI_TEST_LIFELINE_AGENT_CONFIG";

    #[cfg(unix)]
    fn real_browserd_manager(config: &Path) -> BrowserSidecarManager {
        use std::os::unix::fs::PermissionsExt as _;
        let entrypoint = std::env::var(REAL_BROWSERD_ENTRYPOINT_ENV)
            .expect("set OPENGENI_REAL_BROWSERD_ENTRYPOINT to packages/browserd/src/main.ts");
        let wrapper = config.join("browserd");
        std::fs::create_dir_all(config).unwrap();
        // `exec` keeps the controller's PID and inherited stdin.
        std::fs::write(&wrapper, format!("#!/bin/sh\nexec bun '{entrypoint}'\n")).unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
        BrowserSidecarManager::with_binary(config.join("config"), wrapper).unwrap()
    }

    /// Re-executed as the "agent" process by the lifeline test below.
    #[cfg(unix)]
    #[ignore = "needs bun and the browserd source (OPENGENI_REAL_BROWSERD_ENTRYPOINT)"]
    #[tokio::test]
    async fn real_controller_agent_process() {
        let Some(config) = std::env::var_os(LIFELINE_CHILD_ENV) else {
            return;
        };
        let manager = real_browserd_manager(Path::new(&config));
        ensure_idle_fixture(&manager, "lifeline").await;
        println!(
            "browserd-pid={}",
            manager.sidecar_pid("lifeline").await.unwrap()
        );
        tokio::time::sleep(Duration::from_secs(120)).await;
    }

    #[cfg(target_os = "linux")]
    #[ignore = "needs bun and the browserd source (OPENGENI_REAL_BROWSERD_ENTRYPOINT)"]
    #[test]
    fn a_real_controller_ends_with_its_killed_agent() {
        use std::io::BufRead as _;
        let directory = tempfile::tempdir().unwrap();
        let mut agent = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "browser_sidecar::tests::real_controller_agent_process",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(LIFELINE_CHILD_ENV, directory.path())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut lines = std::io::BufReader::new(agent.stdout.take().unwrap()).lines();
        let pid = loop {
            let line = lines
                .next()
                .expect("agent printed the controller pid")
                .unwrap();
            // libtest prints the test name on the same line.
            if let Some((_, pid)) = line.split_once("browserd-pid=") {
                break pid.trim().parse::<u32>().unwrap();
            }
        };
        assert!(!process_is_gone(pid), "the controller is running");
        // An abrupt agent death: no destructor or shutdown path runs.
        agent.kill().unwrap();
        agent.wait().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !process_is_gone(pid) {
            if std::time::Instant::now() > deadline {
                let _ = nix::sys::signal::kill(
                    nix::unistd::Pid::from_raw(i32::try_from(pid).unwrap()),
                    nix::sys::signal::Signal::SIGKILL,
                );
                panic!("the controller outlived its killed agent");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[cfg(unix)]
    #[ignore = "needs bun and the browserd source (OPENGENI_REAL_BROWSERD_ENTRYPOINT)"]
    #[tokio::test]
    async fn a_real_empty_controller_is_retired_gracefully() {
        let directory = tempfile::tempdir().unwrap();
        let manager = real_browserd_manager(directory.path());
        ensure_idle_fixture(&manager, "unused").await;
        let pid = manager.sidecar_pid("unused").await.unwrap();
        let grace = Duration::from_millis(200);
        assert_eq!(manager.retire_empty_controllers(grace).await, 0);
        tokio::time::sleep(grace + Duration::from_millis(50)).await;
        assert_eq!(manager.retire_empty_controllers(grace).await, 1);
        assert!(nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(i32::try_from(pid).unwrap()),
            None
        )
        .is_err());
        assert!(
            manager.update_drain.snapshot().is_some(),
            "the controller stopped cooperatively"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_older_extensions_attached_controller_holds_back_an_update() {
        let directory = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let manager = idle_fixture_manager(directory.path(), listener.local_addr().unwrap().port());
        let idle = r#"{"protocolVersion":1,"ok":true,"data":{"idle":true}}"#;
        let server = tokio::spawn(serve_idle_proofs(
            listener,
            vec![(200, idle.into()), (200, idle.into()), (200, idle.into())],
        ));
        ensure_idle_fixture(&manager, "attached").await;
        let bridge_directory = tempfile::tempdir().unwrap();
        let bridge = crate::browser_bridge::BrowserBridgeServer::start(bridge_directory.path())
            .await
            .unwrap();
        manager.observe_attached_inventory(bridge.inventory());
        let device = "11111111-1111-4111-8111-111111111111";
        // An older extension: its placement is the port the controller is
        // bound to, which a restart replaces.
        let legacy = crate::browser_bridge::test_support::connect_extension(
            bridge_directory.path(),
            device,
            "fixture-generation",
            None,
        )
        .await;
        while bridge.inventory().snapshot().devices.is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(
            !manager.is_idle().await.unwrap(),
            "a restart would end the older extension's sessions"
        );
        drop(legacy);
        while !bridge.inventory().snapshot().devices.is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        // A current extension keeps its placement across reconnects.
        let current = crate::browser_bridge::test_support::connect_extension(
            bridge_directory.path(),
            device,
            "port-2",
            Some("fixture-generation"),
        )
        .await;
        while bridge.inventory().snapshot().devices.is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(manager.is_idle().await.unwrap());
        drop(current);
        manager.shutdown().await;
        bridge.shutdown().await.unwrap();
        server.abort();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn update_idle_proof_checks_all_scopes_without_stopping_children() {
        let directory = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let manager = idle_fixture_manager(directory.path(), listener.local_addr().unwrap().port());
        let idle = r#"{"protocolVersion":1,"ok":true,"data":{"idle":true}}"#;
        let busy = r#"{"protocolVersion":1,"ok":true,"data":{"idle":false}}"#;
        let server = tokio::spawn(serve_idle_proofs(
            listener,
            vec![
                (200, idle.into()),
                (200, busy.into()),
                (200, idle.into()),
                (200, idle.into()),
            ],
        ));
        assert!(
            manager.is_idle().await.unwrap(),
            "never-started controller is idle"
        );
        ensure_idle_fixture(&manager, "first").await;
        ensure_idle_fixture(&manager, "second").await;
        assert!(
            !manager.is_idle().await.unwrap(),
            "one idle scope cannot authorize host restart"
        );
        assert!(manager.is_idle().await.unwrap());
        server.await.unwrap();
        for sidecar in manager.sidecars.lock().await.values_mut() {
            assert!(
                sidecar.child.try_wait().unwrap().is_none(),
                "proof must never stop a controller"
            );
        }
        manager.shutdown().await;
        assert!(manager.is_idle().await.unwrap());
    }

    #[cfg(unix)]
    async fn serve_update_proofs(
        listener: tokio::net::TcpListener,
        operations: Vec<(&str, String, u16)>,
    ) {
        use tokio::io::AsyncWriteExt as _;
        for (method, operation_id, status) in operations {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 1024];
            let (header_end, length) = loop {
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0 && request.len() + count <= 8192);
                request.extend_from_slice(&chunk[..count]);
                if let Some(index) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..index]);
                    assert!(headers.starts_with(&format!("{method} /v1/runtime/update HTTP/1.1")));
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|value| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    break (index + 4, length);
                }
            };
            while request.len() < header_end + length {
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                request.extend_from_slice(&chunk[..count]);
            }
            let body: serde_json::Value =
                serde_json::from_slice(&request[header_end..header_end + length]).unwrap();
            assert_eq!(body["operationId"], operation_id);
            if status == 0 {
                continue;
            } // Installed fence, lost response.
            let mut data = serde_json::json!({"idle":true,"operationId":operation_id});
            if method == "DELETE" {
                data["released"] = true.into();
            }
            let body = serde_json::json!({"protocolVersion":1,"ok":true,"data":data}).to_string();
            socket.write_all(format!(
                "HTTP/1.1 {status} Fixture\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}", body.len()
            ).as_bytes()).await.unwrap();
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn lost_update_release_retains_exact_owner_for_ordinary_recovery() {
        use crate::uploads::update_drain::{UpdateDrain, UpdateReservation};
        let directory = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let drain = Arc::new(UpdateDrain::default());
        let manager = idle_fixture_manager(directory.path(), listener.local_addr().unwrap().port())
            .with_update_drain(drain.clone());
        ensure_idle_fixture(&manager, "scope").await;
        let first = uuid::Uuid::new_v4().to_string();
        let next = uuid::Uuid::new_v4().to_string();
        let operations = vec![
            ("POST", first.clone(), 0),
            ("DELETE", first.clone(), 500),
            ("DELETE", first.clone(), 200),
            ("POST", next.clone(), 200),
            ("DELETE", next.clone(), 200),
        ];
        let server = tokio::spawn(serve_update_proofs(listener, operations));
        assert_eq!(drain.reserve_update(&first), UpdateReservation::Started);
        assert!(manager.begin_update(&first).await.is_err());
        assert!(manager.release_update(&first).await.is_err());
        assert_eq!(
            manager.sidecars.lock().await["scope"]
                .pending_update
                .as_deref(),
            Some(first.as_str())
        );
        manager
            .resolve("scope", "fixture-generation")
            .await
            .unwrap();
        assert_eq!(
            manager.sidecars.lock().await["scope"]
                .pending_update
                .as_deref(),
            Some(first.as_str()),
            "ordinary recovery cannot release a live updater"
        );
        drain.release_update(&first);
        manager
            .resolve("scope", "fixture-generation")
            .await
            .unwrap();
        assert!(manager.sidecars.lock().await["scope"]
            .pending_update
            .is_none());
        assert_eq!(drain.reserve_update(&next), UpdateReservation::Started);
        assert!(manager.begin_update(&next).await.unwrap());
        manager.release_update(&next).await.unwrap();
        drain.release_update(&next);
        server.await.unwrap();
        manager.shutdown().await;
        assert_eq!(drain.snapshot().unwrap().routed, 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn replacing_a_crashed_controller_does_not_erase_host_uncertainty() {
        use crate::uploads::update_drain::{UpdateDrain, UpdateReservation};
        let directory = tempfile::tempdir().unwrap();
        let drain = Arc::new(UpdateDrain::default());
        let manager = idle_fixture_manager(directory.path(), 1).with_update_drain(drain.clone());
        ensure_idle_fixture(&manager, "scope").await;
        {
            let mut sidecars = manager.sidecars.lock().await;
            let old = sidecars.get_mut("scope").unwrap();
            old.child.kill().await.unwrap();
            old.child.wait().await.unwrap();
        }
        assert!(manager
            .resolve("scope", "fixture-generation")
            .await
            .is_err());
        assert!(manager.sidecars.lock().await.is_empty());
        assert_eq!(
            drain.reserve_update("other-link"),
            UpdateReservation::Unavailable
        );
        // Ordinary scoped recovery still works, but is not descendant-exit proof.
        ensure_idle_fixture(&manager, "scope").await;
        assert_eq!(drain.snapshot(), None);
        assert_eq!(
            drain.reserve_update("other-link"),
            UpdateReservation::Unavailable
        );
        manager.shutdown().await;
        assert_eq!(drain.snapshot(), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn update_idle_proof_refuses_missing_incompatible_or_redirected_state() {
        let directory = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let manager = idle_fixture_manager(directory.path(), listener.local_addr().unwrap().port());
        let replies = vec![
            (404, "older controller".into()),
            (302, String::new()),
            (200, "not JSON".into()),
            (
                200,
                r#"{"protocolVersion":2,"ok":true,"data":{"idle":true}}"#.into(),
            ),
            (
                200,
                r#"{"protocolVersion":1,"ok":false,"data":{"idle":true}}"#.into(),
            ),
            (200, r#"{"protocolVersion":1,"ok":true,"data":{}}"#.into()),
            (200, "x".repeat(MAX_IDLE_RESPONSE_BYTES + 1)),
        ];
        let count = replies.len();
        let server = tokio::spawn(serve_idle_proofs(listener, replies));
        ensure_idle_fixture(&manager, "scope").await;
        for _ in 0..count {
            let error = manager.is_idle().await.unwrap_err();
            assert!(!error.to_string().contains(&"p".repeat(32)));
        }
        server.await.unwrap();
        assert!(!format!("{manager:?}").contains(&"p".repeat(32)));
        let mut sidecars = manager.sidecars.lock().await;
        let sidecar = sidecars.values_mut().next().unwrap();
        std::fs::write(&sidecar.token_file, "q".repeat(32)).unwrap();
        drop(sidecars);
        assert!(
            manager.is_idle().await.is_err(),
            "changed authority is not idle proof"
        );
        let mut sidecars = manager.sidecars.lock().await;
        let sidecar = sidecars.values_mut().next().unwrap();
        sidecar.child.start_kill().unwrap();
        sidecar.child.wait().await.unwrap();
        drop(sidecars);
        assert!(
            manager.is_idle().await.is_err(),
            "crashed sidecar cannot prove child cleanup"
        );
        manager.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn update_idle_proof_has_one_bounded_host_deadline() {
        let directory = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let manager = idle_fixture_manager(directory.path(), listener.local_addr().unwrap().port());
        ensure_idle_fixture(&manager, "scope").await;
        let socket = tokio::spawn(async move { listener.accept().await.unwrap().0 });
        let probe = manager.is_idle();
        tokio::pin!(probe);
        let response = tokio::select! {
            result = &mut probe => panic!("probe ended before request: {result:?}"),
            socket = socket => socket.unwrap(),
        };
        let started = std::time::Instant::now();
        assert!(tokio::time::timeout(Duration::from_secs(7), &mut probe)
            .await
            .unwrap()
            .is_err());
        assert!(started.elapsed() < Duration::from_secs(7));
        drop(response);
        manager.shutdown().await;
    }

    #[test]
    fn authority_inputs_are_bounded_and_storage_keys_hide_scope_names() {
        assert_eq!(validate_token(&"a".repeat(32)).unwrap().len(), 32);
        assert!(validate_token("short").is_err());
        assert!(bounded_identifier("workspace/device:1", 64, "scope").is_ok());
        assert!(bounded_identifier("../device", 64, "scope").is_err());
        let key = scope_storage_key("workspace/device:1");
        assert_eq!(key.len(), 64);
        assert!(!key.contains("workspace"));
    }

    #[test]
    fn origins_are_canonical_and_reject_separator_injection() {
        let origins = canonical_origins(&[
            "https://b.example".to_string(),
            "https://a.example".to_string(),
            "https://b.example".to_string(),
        ])
        .unwrap();
        assert_eq!(origins, ["https://a.example", "https://b.example"]);
        assert!(canonical_origins(&["https://a.example,https://b.example".to_string()]).is_err());
    }

    #[test]
    fn ready_document_requires_the_exact_runtime_identity() {
        let legacy = r#"{"service":"opengeni-browserd","status":"ready","protocolVersion":1,"computer":true,"hostname":"127.0.0.1","port":1234}"#;
        assert!(
            serde_json::from_str::<ReadyDocument>(legacy).is_err(),
            "a pre-identity sidecar must not be silently mixed into the runtime"
        );
        let current = format!(
            r#"{{"service":"opengeni-browserd","status":"ready","protocolVersion":1,"runtimeBuildId":"{}","computer":true,"hostname":"127.0.0.1","port":1234}}"#,
            expected_runtime_build_id()
        );
        let ready =
            serde_json::from_str::<ReadyDocument>(&current).expect("current ready document");
        assert_eq!(ready.runtime_build_id, expected_runtime_build_id());
        assert!(ready_document_mismatches(&ready, "test-secret").is_none());
    }

    #[cfg(opengeni_embedded_runtime)]
    #[test]
    fn complete_embedded_bundle_ignores_stale_adjacent_helpers_and_refuses_changed_materialization()
    {
        let directory = tempfile::tempdir().expect("fixture runtime root");
        let adjacent = directory.path().join("adjacent");
        std::fs::create_dir(&adjacent).expect("adjacent fixture directory");
        for name in [
            "opengeni-browserd",
            "agent-browser",
            "opengeni-computer-native",
        ] {
            std::fs::write(adjacent.join(companion_name(name)), b"stale helper")
                .expect("stale adjacent fixture");
        }
        let binary = select_packaged_browserd(directory.path(), false, || {
            panic!("embedded runtime must not select adjacent helpers")
        })
        .expect("select embedded runtime");
        let runtime = binary.parent().expect("embedded directory");
        assert_ne!(runtime, adjacent);
        let mut command = Command::new(&binary);
        configure_companion_binaries(&mut command, &binary);
        let environment = command.as_std().get_envs().collect::<HashMap<_, _>>();
        for (key, name) in [
            (AGENT_BROWSER_BINARY_ENV, "agent-browser"),
            (COMPUTER_NATIVE_BINARY_ENV, "opengeni-computer-native"),
        ] {
            let expected = runtime.join(companion_name(name));
            assert_eq!(
                environment
                    .get(std::ffi::OsStr::new(key))
                    .copied()
                    .flatten(),
                Some(expected.as_os_str())
            );
        }
        let ready = ReadyDocument {
            service: "opengeni-browserd".to_string(),
            status: "ready".to_string(),
            protocol_version: 1,
            runtime_build_id: expected_runtime_build_id().to_string(),
            _computer_available: true,
            hostname: "127.0.0.1".to_string(),
            port: 1234,
        };
        assert!(ready_document_mismatches(&ready, "test-secret").is_none());
        let stale_ready = ReadyDocument {
            runtime_build_id: "other-build".to_string(),
            ..ready
        };
        assert!(ready_document_mismatches(&stale_ready, "test-secret").is_some());
        std::fs::write(&binary, b"changed materialized helper").expect("modify fixture helper");
        assert!(select_packaged_browserd(directory.path(), false, || {
            panic!("failed embedded digest must not fall back to adjacent helpers")
        })
        .is_err());
    }

    #[test]
    fn incompatible_ready_document_names_every_mismatched_field() {
        let ready = ReadyDocument {
            service: "other-service".to_string(),
            status: "starting".to_string(),
            protocol_version: 2,
            runtime_build_id: "other-build".to_string(),
            _computer_available: true,
            hostname: "::1".to_string(),
            port: 0,
        };
        let mismatches =
            ready_document_mismatches(&ready, "test-secret").expect("mismatched document");
        for field in [
            "service expected \"opengeni-browserd\", received \"other-service\"",
            "status expected \"ready\", received \"starting\"",
            "runtimeBuildId expected",
            "received \"other-build\"",
            "hostname expected \"127.0.0.1\", received \"::1\"",
            "protocolVersion expected 1, received 2",
            "port expected nonzero, received 0",
        ] {
            assert!(mismatches.contains(field), "missing {field}: {mismatches}");
        }
        assert_eq!(
            bounded_ready_value(&format!("{}\nsecret", "x".repeat(128)), "test-secret"),
            format!("\"{}\"", "x".repeat(128))
        );
        assert_eq!(
            bounded_ready_value("before-test-secret-after", "test-secret"),
            "\"before-[redacted]-after\""
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_waits_for_slow_owned_cleanup_across_scopes_concurrently() {
        use std::os::unix::fs::PermissionsExt as _;
        let temporary = tempfile::tempdir().expect("temporary sidecar root");
        let binary = temporary.path().join("slow-browserd");
        // The optional fixture runs real browsers in the isolated acceptance
        // environment. The default needs only POSIX sh, including on macOS CI.
        let script = if let Ok(fixture) = std::env::var("OPENGENI_TEST_SLOW_BROWSERD") {
            std::fs::read_to_string(fixture)
                .expect("read slow browser fixture")
                .replace("@RUNTIME_BUILD_ID@", expected_runtime_build_id())
        } else {
            format!(
                "#!/bin/sh\nmkdir -p \"$OPENGENI_BROWSERD_ROOT\"\ntrap 'sleep 12; touch \"$OPENGENI_BROWSERD_ROOT/cleaned\"; exit 0' INT\nprintf '%s\\n' '{{\"service\":\"opengeni-browserd\",\"status\":\"ready\",\"protocolVersion\":1,\"runtimeBuildId\":\"{}\",\"computer\":false,\"hostname\":\"127.0.0.1\",\"port\":12345}}'\nwhile :; do sleep 1; done\n",
                expected_runtime_build_id()
            )
        };
        std::fs::write(&binary, script).expect("write slow browserd");
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
            .expect("make slow browserd executable");
        let config = temporary.path().join("config");
        let manager = BrowserSidecarManager::with_binary(&config, &binary).expect("manager");
        for scope in ["slow-first", "slow-second"] {
            manager
                .ensure(&v1::BrowserControlEnsureRequest {
                    scope_id: scope.to_string(),
                    scope_generation: "generation".to_string(),
                    admin_token: "s".repeat(32),
                    allowed_origins: vec![],
                })
                .await
                .expect("start slow sidecar");
        }
        let started = std::time::Instant::now();
        manager.shutdown().await;
        assert!(
            started.elapsed() < Duration::from_secs(23),
            "scope drains must overlap"
        );
        for scope in ["slow-first", "slow-second"] {
            assert!(
                config
                    .join("browserd/scopes")
                    .join(scope_storage_key(scope))
                    .join("state/cleaned")
                    .is_file(),
                "owned cleanup must finish after old 10s cutoff"
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sidecar_startup_failure_includes_bounded_redacted_stderr() {
        use std::os::unix::fs::PermissionsExt as _;

        let temporary = tempfile::tempdir().expect("temporary sidecar root");
        let binary = temporary.path().join("failing-browserd");
        std::fs::write(
            &binary,
            concat!(
                "#!/bin/sh\n",
                "IFS= read -r token < \"$OPENGENI_BROWSERD_ADMIN_TOKEN_FILE\"\n",
                "printf '%s pinned helper digest mismatch\\n' \"$token\" >&2\n",
                "exit 17\n",
            ),
        )
        .expect("write failing browserd double");
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
            .expect("make failing browserd double executable");
        let manager = BrowserSidecarManager::with_binary(temporary.path().join("config"), &binary)
            .expect("construct sidecar manager");
        let token = "private-token-that-must-not-escape-1234";
        let error = manager
            .ensure(&v1::BrowserControlEnsureRequest {
                scope_id: "workspace:diagnostic".to_string(),
                scope_generation: "generation-1".to_string(),
                admin_token: token.to_string(),
                allowed_origins: vec!["https://app.opengeni.test".to_string()],
            })
            .await
            .expect_err("failing sidecar must not become ready");
        let rendered = error.to_string();
        assert!(rendered.contains("pinned helper digest mismatch"));
        assert!(rendered.contains("[redacted]"));
        assert!(!rendered.contains(token));
    }

    #[cfg(unix)]
    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn sidecar_authority_is_owner_only_idempotent_and_generation_fenced() {
        use std::os::unix::fs::PermissionsExt as _;
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let temporary = tempfile::tempdir().expect("temporary sidecar root");
        let origin_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind origin-update fixture");
        let controller_port = origin_listener
            .local_addr()
            .expect("read origin-update fixture address")
            .port();
        let origin_update = tokio::spawn(async move {
            let (mut socket, _) = origin_listener
                .accept()
                .await
                .expect("accept origin update");
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1_024];
            loop {
                let count = socket.read(&mut chunk).await.expect("read origin update");
                assert!(count > 0, "origin update ended before its JSON body");
                request.extend_from_slice(&chunk[..count]);
                assert!(
                    request.len() <= 16 * 1_024,
                    "origin update exceeded test bound"
                );
                if request
                    .windows(b"https://second.opengeni.test".len())
                    .any(|window| window == b"https://second.opengeni.test")
                {
                    break;
                }
            }
            let request = String::from_utf8(request).expect("origin update is UTF-8");
            assert!(request.starts_with("PUT /v1/origins HTTP/1.1\r\n"));
            assert!(request.contains(&format!("authorization: Bearer {}", "a".repeat(32))));
            socket
                .write_all(b"HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n")
                .await
                .expect("settle origin update");
        });
        let binary = temporary.path().join("fake-browserd");
        let environment_capture = temporary.path().join("sidecar-environment");
        let agent_browser = temporary.path().join(companion_name("agent-browser"));
        let lightpanda = temporary.path().join(companion_name("lightpanda"));
        let computer_native = temporary
            .path()
            .join(companion_name("opengeni-computer-native"));
        for companion in [&agent_browser, &lightpanda, &computer_native] {
            std::fs::write(companion, "companion").expect("write sidecar companion");
            std::fs::set_permissions(companion, std::fs::Permissions::from_mode(0o700))
                .expect("make sidecar companion executable");
        }
        std::fs::write(
            &binary,
            format!(
                concat!(
                    "#!/bin/sh\n",
                    "printf '%s\\n%s\\n%s\\n' \"$OPENGENI_BROWSERD_AGENT_BROWSER_BINARY\" \"$OPENGENI_BROWSERD_LIGHTPANDA_BINARY\" \"$OPENGENI_BROWSERD_COMPUTER_NATIVE_BINARY\" > '{capture}'\n",
                    "printf '%s\\n' '{{\"service\":\"opengeni-browserd\",\"status\":\"ready\",",
                    "\"protocolVersion\":1,\"runtimeBuildId\":\"{build_id}\",\"computer\":true,\"hostname\":\"127.0.0.1\",\"port\":{port}}}'\n",
                    "exec sleep 30\n",
                ),
                capture = environment_capture.display(),
                build_id = expected_runtime_build_id(),
                port = controller_port,
            ),
        )
        .expect("write browserd double");
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
            .expect("make browserd double executable");
        let config_dir = temporary.path().join("agent-config");
        let manager = BrowserSidecarManager::with_binary(&config_dir, &binary)
            .expect("construct sidecar manager");
        let mut request = v1::BrowserControlEnsureRequest {
            scope_id: "workspace:attached:profile-1".to_string(),
            scope_generation: "connection-1".to_string(),
            admin_token: "a".repeat(32),
            allowed_origins: vec!["https://app.opengeni.test".to_string()],
        };

        let first = manager.ensure(&request).await.expect("start sidecar");
        assert_eq!(
            std::fs::read_to_string(&environment_capture)
                .expect("read packaged companion environment")
                .lines()
                .map(PathBuf::from)
                .collect::<Vec<_>>(),
            [agent_browser, lightpanda, computer_native],
        );
        let replay = manager
            .ensure(&request)
            .await
            .expect("replay sidecar ensure");
        assert_eq!(
            replay, first,
            "identical authority input must not restart browserd"
        );
        assert_eq!(first.port, controller_port);
        request
            .allowed_origins
            .push("https://second.opengeni.test".to_string());
        assert_eq!(
            manager
                .ensure(&request)
                .await
                .expect("additive origin must preserve the sidecar"),
            first,
        );
        origin_update
            .await
            .expect("origin update fixture completed");
        assert_eq!(
            manager
                .resolve(&request.scope_id, &request.scope_generation)
                .await
                .expect("resolve live sidecar"),
            first,
        );

        let token_file = config_dir
            .join("browserd/scopes")
            .join(scope_storage_key(&request.scope_id))
            .join("authority/admin-token");
        assert_eq!(
            std::fs::read_to_string(&token_file).expect("read sidecar authority"),
            format!("{}\n", request.admin_token),
        );
        assert_eq!(
            std::fs::metadata(&token_file)
                .expect("sidecar authority metadata")
                .permissions()
                .mode()
                & 0o077,
            0,
        );

        request.scope_generation = "connection-2".to_string();
        let replacement = manager
            .ensure(&request)
            .await
            .expect("replace stale sidecar");
        assert_ne!(replacement.sidecar_generation, first.sidecar_generation);
        let stale = manager.resolve(&request.scope_id, "connection-1").await;
        assert!(matches!(stale, Err(PlatformError::Unsupported(_))));
        assert_eq!(
            manager
                .resolve(&request.scope_id, "connection-2")
                .await
                .expect("resolve replacement sidecar"),
            replacement,
        );
    }
}
