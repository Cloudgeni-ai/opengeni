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
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use async_trait::async_trait;
use opengeni_agent_platform::{
    BrowserControlBackend, BrowserControlEndpoint, PlatformError, PlatformResult,
};
use opengeni_agent_proto::v1;
use serde::Deserialize;
use tokio::{
    io::{AsyncBufReadExt as _, BufReader},
    process::{Child, Command},
    sync::Mutex,
};

const BROWSERD_BINARY_ENV: &str = "OPENGENI_BROWSERD_BINARY";
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_READY_LINE_BYTES: usize = 4_096;
const MAX_SCOPES: usize = 1_000;
const MAX_SCOPE_BYTES: usize = 512;
const MAX_GENERATION_BYTES: usize = 512;
const MAX_ORIGINS: usize = 64;
const MAX_ORIGIN_BYTES: usize = 2_048;
const MIN_TOKEN_BYTES: usize = 32;
const MAX_TOKEN_BYTES: usize = 2_048;

#[derive(Debug)]
struct Sidecar {
    child: Child,
    endpoint: BrowserControlEndpoint,
    scope_generation: String,
    token_digest: blake3::Hash,
    allowed_origins: Vec<String>,
}

/// Process owner for browserd children installed beside the connected agent.
#[derive(Debug)]
pub struct BrowserSidecarManager {
    config_dir: PathBuf,
    binary: PathBuf,
    sidecars: Mutex<HashMap<String, Sidecar>>,
}

impl BrowserSidecarManager {
    /// Resolves the packaged sidecar and creates a manager rooted in the agent's
    /// owner-only configuration directory.
    pub fn discover(config_dir: impl Into<PathBuf>) -> PlatformResult<Self> {
        Self::with_binary(config_dir, discover_browserd_binary()?)
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
        })
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
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env("OPENGENI_BROWSERD_ROOT", root.join("state"))
            .env("OPENGENI_BROWSERD_SOCKET_ROOT", root.join("sockets"))
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
        let mut child = command
            .spawn()
            .map_err(|error| PlatformError::from_io("start browser controller sidecar", &error))?;
        let stdout = child.stdout.take().ok_or_else(|| {
            PlatformError::os("browser controller sidecar stdout was not captured")
        })?;
        let ready = match tokio::time::timeout(READY_TIMEOUT, read_ready_line(stdout)).await {
            Ok(result) => result,
            Err(_) => Err(PlatformError::Timeout(
                "browser controller sidecar did not become ready".to_string(),
            )),
        };
        let ready = match ready {
            Ok(ready) => ready,
            Err(error) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(error);
            }
        };
        if ready.service != "opengeni-browserd"
            || ready.status != "ready"
            || ready.protocol_version != 1
            || ready.hostname != "127.0.0.1"
            || ready.port == 0
        {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(PlatformError::os(
                "browser controller sidecar returned an incompatible ready document",
            ));
        }
        Ok(Sidecar {
            child,
            endpoint: BrowserControlEndpoint {
                port: ready.port,
                sidecar_generation: uuid::Uuid::new_v4().to_string(),
            },
            scope_generation: scope_generation.to_string(),
            token_digest: blake3::hash(admin_token.as_bytes()),
            allowed_origins: allowed_origins.to_vec(),
        })
    }
}

#[async_trait]
impl BrowserControlBackend for BrowserSidecarManager {
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
                .child
                .try_wait()
                .map_err(|error| {
                    PlatformError::from_io("inspect browser controller sidecar", &error)
                })?
                .is_none();
            if live
                && existing.scope_generation == scope_generation
                && existing.token_digest == token_digest
                && existing.allowed_origins == allowed_origins
            {
                return Ok(existing.endpoint.clone());
            }
        }
        if sidecars.len() >= MAX_SCOPES && !sidecars.contains_key(scope_id) {
            return Err(PlatformError::os(
                "browser controller sidecar scope bound was reached",
            ));
        }
        if let Some(mut stale) = sidecars.remove(scope_id) {
            let _ = stale.child.kill().await;
            let _ = stale.child.wait().await;
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
            .child
            .try_wait()
            .map_err(|error| PlatformError::from_io("inspect browser controller sidecar", &error))?
            .is_some()
        {
            sidecars.remove(scope_id);
            return Err(PlatformError::NotFound(
                "browser controller sidecar is no longer running".to_string(),
            ));
        }
        Ok(sidecar.endpoint.clone())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadyDocument {
    service: String,
    status: String,
    protocol_version: u32,
    hostname: String,
    port: u16,
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

    #[cfg(unix)]
    #[tokio::test]
    async fn sidecar_authority_is_owner_only_idempotent_and_generation_fenced() {
        use std::os::unix::fs::PermissionsExt as _;

        let temporary = tempfile::tempdir().expect("temporary sidecar root");
        let binary = temporary.path().join("fake-browserd");
        std::fs::write(
            &binary,
            concat!(
                "#!/bin/sh\n",
                "printf '%s\\n' '{\"service\":\"opengeni-browserd\",\"status\":\"ready\",",
                "\"protocolVersion\":1,\"hostname\":\"127.0.0.1\",\"port\":31337}'\n",
                "exec sleep 30\n",
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
        let replay = manager
            .ensure(&request)
            .await
            .expect("replay sidecar ensure");
        assert_eq!(
            replay, first,
            "identical authority input must not restart browserd"
        );
        assert_eq!(first.port, 31_337);
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
