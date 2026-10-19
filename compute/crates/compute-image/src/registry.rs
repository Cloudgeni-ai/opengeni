//! Pulling an image from any registry that speaks the OCI distribution
//! API, anonymously or with credentials through its token flow.
//!
//! Every byte is checked against the digest that names it: a manifest
//! asked for by digest against that digest (and one asked for by tag
//! against the digest the registry reports), the config and each layer
//! against the digests the manifest gives, and each layer's uncompressed
//! contents against the config's `diff_ids` when they are applied.

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context as _, Result, anyhow, bail, ensure};
use base64::Engine as _;
use futures::StreamExt as _;
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderMap, WWW_AUTHENTICATE};
use reqwest::{RequestBuilder, Response, StatusCode};
use serde::Deserialize;
use sha2::{Digest as _, Sha256};
use tokio::io::AsyncWriteExt as _;

use crate::reference::{Reference, valid_digest};

const OCI_INDEX: &str = "application/vnd.oci.image.index.v1+json";
const DOCKER_LIST: &str = "application/vnd.docker.distribution.manifest.list.v2+json";
const OCI_MANIFEST: &str = "application/vnd.oci.image.manifest.v1+json";
const DOCKER_MANIFEST: &str = "application/vnd.docker.distribution.manifest.v2+json";

/// The largest manifest or config read.
const MAX_DOCUMENT: usize = 8 * 1024 * 1024;
/// Attempts per blob download.
const ATTEMPTS: u32 = 3;
/// Blobs downloaded at once.
const PARALLEL: usize = 4;

/// Credentials for a registry's token service (or its basic auth): a user
/// name and a password or token. GHCR takes any name with a token, Google
/// registries `oauth2accesstoken` with an access token, and Azure
/// registries the user `00000000-0000-0000-0000-000000000000` with a
/// refresh token.
#[derive(Clone)]
pub struct Credentials {
    pub username: String,
    pub secret: String,
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credentials")
            .field("username", &self.username)
            .finish_non_exhaustive()
    }
}

impl Credentials {
    fn basic(&self) -> String {
        let pair = format!("{}:{}", self.username, self.secret);
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(pair)
        )
    }
}

/// How a layer's tar is compressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Compression {
    None,
    Gzip,
    Zstd,
}

impl Compression {
    /// From a layer's media type; `None` for one that is not a layer.
    #[must_use]
    pub fn of(media_type: &str) -> Option<Self> {
        match media_type {
            "application/vnd.oci.image.layer.v1.tar"
            | "application/vnd.oci.image.layer.nondistributable.v1.tar"
            | "application/vnd.docker.image.rootfs.diff.tar" => Some(Self::None),
            "application/vnd.oci.image.layer.v1.tar+gzip"
            | "application/vnd.oci.image.layer.nondistributable.v1.tar+gzip"
            | "application/vnd.docker.image.rootfs.diff.tar.gzip"
            | "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip" => Some(Self::Gzip),
            "application/vnd.oci.image.layer.v1.tar+zstd"
            | "application/vnd.oci.image.layer.nondistributable.v1.tar+zstd" => Some(Self::Zstd),
            _ => None,
        }
    }
}

/// A descriptor in a manifest or index.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    pub media_type: String,
    pub digest: String,
    pub size: u64,
    #[serde(default)]
    pub platform: Option<Platform>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Platform {
    pub architecture: String,
    pub os: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    #[serde(default)]
    media_type: Option<String>,
    #[serde(default)]
    manifests: Option<Vec<Descriptor>>,
    #[serde(default)]
    config: Option<Descriptor>,
    #[serde(default)]
    layers: Option<Vec<Descriptor>>,
}

/// The image config, as far as a build reads it.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ImageFile {
    #[serde(default)]
    pub architecture: String,
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub config: Option<RunConfig>,
    pub rootfs: RootFs,
}

impl ImageFile {
    /// Fails unless the image is for Linux on amd64, the only platform
    /// the builder and the hosts run.
    ///
    /// # Errors
    ///
    /// For any other platform, or one the config leaves out.
    pub fn platform(&self) -> Result<()> {
        ensure!(
            self.os == "linux" && self.architecture == "amd64",
            "the image is for {}/{}, not linux/amd64",
            or_unset(&self.os),
            or_unset(&self.architecture)
        );
        Ok(())
    }
}

fn or_unset(value: &str) -> &str {
    if value.is_empty() { "(unset)" } else { value }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct RunConfig {
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub working_dir: Option<String>,
    #[serde(default)]
    pub env: Option<Vec<String>>,
    #[serde(default)]
    pub entrypoint: Option<Vec<String>>,
    #[serde(default)]
    pub cmd: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct RootFs {
    #[serde(default)]
    pub diff_ids: Vec<String>,
}

/// A layer on disk, compressed as it was pulled.
#[derive(Debug, Clone)]
pub struct Layer {
    pub path: PathBuf,
    pub compression: Compression,
    /// The digest of its uncompressed contents.
    pub diff_id: String,
}

/// A pulled image.
#[derive(Debug, Clone)]
pub struct Pulled {
    /// The digest of the image's manifest (for the chosen platform).
    pub manifest_digest: String,
    pub image: ImageFile,
    /// Layers, lowest first.
    pub layers: Vec<Layer>,
}

/// One parameter list of a `WWW-Authenticate` header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Challenge {
    /// `bearer` or `basic`, lower case.
    pub scheme: String,
    pub params: BTreeMap<String, String>,
}

impl Challenge {
    /// Parses `Scheme key="value", key=value, …`. Quoted values may hold
    /// commas (scopes do).
    #[must_use]
    pub fn parse(header: &str) -> Option<Self> {
        let header = header.trim();
        let (scheme, mut rest) = header.split_once(' ').unwrap_or((header, ""));
        if scheme.is_empty() {
            return None;
        }
        let mut params = BTreeMap::new();
        loop {
            rest = rest.trim_start_matches([' ', ',']);
            let Some((key, after)) = rest.split_once('=') else {
                break;
            };
            let (value, after) = if let Some(quoted) = after.strip_prefix('"') {
                let end = quoted.find('"')?;
                (&quoted[..end], &quoted[end + 1..])
            } else {
                let end = after.find(',').unwrap_or(after.len());
                (&after[..end], &after[end..])
            };
            params.insert(key.trim().to_ascii_lowercase(), value.to_owned());
            rest = after;
        }
        Some(Self {
            scheme: scheme.to_ascii_lowercase(),
            params,
        })
    }
}

/// Picks the Linux amd64 manifest from an index.
#[must_use]
pub fn linux_amd64(manifests: &[Descriptor]) -> Option<&Descriptor> {
    manifests.iter().find(|m| {
        m.platform
            .as_ref()
            .is_some_and(|p| p.os == "linux" && p.architecture == "amd64")
    })
}

/// `sha256:<hex>` of `bytes`.
#[must_use]
pub fn sha256_digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

/// A client for one registry.
#[derive(Debug)]
pub struct Registry {
    client: reqwest::Client,
    credentials: Option<Credentials>,
    /// What to send as `Authorization` once a challenge was answered.
    authorization: Mutex<Option<String>>,
}

impl Registry {
    pub fn new(credentials: Option<Credentials>) -> Result<Self> {
        let client = reqwest::Client::builder()
            .user_agent("opengeni-compute-image")
            .build()?;
        Ok(Self {
            client,
            credentials,
            authorization: Mutex::new(None),
        })
    }

    /// Pulls `reference` for Linux amd64 into `dir`: its manifest, its
    /// config and every layer, each checked against its digest.
    pub async fn pull(&self, reference: &Reference, dir: &Path) -> Result<Pulled> {
        let base = format!(
            "https://{}/v2/{}",
            reference.api_host(),
            reference.repository
        );
        let (mut digest, mut document) = self
            .manifest(
                &base,
                reference.manifest_reference(),
                reference.digest.as_deref(),
            )
            .await?;
        if let Some(manifests) = &document.manifests {
            let chosen = linux_amd64(manifests)
                .ok_or_else(|| anyhow!("{reference} has no linux/amd64 image"))?
                .digest
                .clone();
            (digest, document) = self.manifest(&base, &chosen, Some(&chosen)).await?;
        }
        let media_type = document.media_type.clone().unwrap_or_default();
        ensure!(
            media_type.is_empty() || media_type == OCI_MANIFEST || media_type == DOCKER_MANIFEST,
            "{reference}: unexpected manifest type {media_type}"
        );
        let config = document
            .config
            .ok_or_else(|| anyhow!("{reference}: manifest without config"))?;
        let layers = document.layers.unwrap_or_default();
        let config_bytes = self.small_blob(&base, &config).await?;
        let image: ImageFile = serde_json::from_slice(&config_bytes).context("image config")?;
        // Checked here too: a tag or digest can name one manifest directly.
        image.platform().with_context(|| reference.to_string())?;
        ensure!(
            image.rootfs.diff_ids.len() == layers.len(),
            "{reference}: {} layers but {} diff ids",
            layers.len(),
            image.rootfs.diff_ids.len()
        );
        tokio::fs::create_dir_all(dir).await?;
        let downloads = layers
            .iter()
            .zip(&image.rootfs.diff_ids)
            .map(|(layer, diff_id)| {
                let base = &base;
                async move {
                    let compression = Compression::of(&layer.media_type)
                        .ok_or_else(|| anyhow!("unknown layer type {}", layer.media_type))?;
                    ensure!(valid_digest(diff_id), "bad diff id {diff_id}");
                    let path = dir.join(layer.digest.replace(':', "-"));
                    self.blob_to_file(base, layer, &path).await?;
                    Ok(Layer {
                        path,
                        compression,
                        diff_id: diff_id.clone(),
                    })
                }
            });
        let layers = futures::stream::iter(downloads)
            .buffered(PARALLEL)
            .collect::<Vec<Result<Layer>>>()
            .await
            .into_iter()
            .collect::<Result<Vec<_>>>()?;
        Ok(Pulled {
            manifest_digest: digest,
            image,
            layers,
        })
    }

    /// Fetches a manifest or index, and checks it against `expected` or
    /// the digest the registry reports. Returns its digest.
    async fn manifest(
        &self,
        base: &str,
        name: &str,
        expected: Option<&str>,
    ) -> Result<(String, Document)> {
        let url = format!("{base}/manifests/{name}");
        let accept = [OCI_INDEX, DOCKER_LIST, OCI_MANIFEST, DOCKER_MANIFEST].join(", ");
        let response = self
            .send(|client| client.get(&url).header(ACCEPT, accept.as_str()))
            .await?;
        let reported = response
            .headers()
            .get("docker-content-digest")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let bytes = read_limited(response, MAX_DOCUMENT).await?;
        let digest = sha256_digest(&bytes);
        if let Some(expected) = expected.or(reported.as_deref()) {
            ensure!(
                digest == expected,
                "manifest {name}: digest {digest}, expected {expected}"
            );
        }
        let document =
            serde_json::from_slice(&bytes).with_context(|| format!("manifest {name}"))?;
        Ok((digest, document))
    }

    async fn small_blob(&self, base: &str, blob: &Descriptor) -> Result<Vec<u8>> {
        ensure!(valid_digest(&blob.digest), "bad digest {}", blob.digest);
        let url = format!("{base}/blobs/{}", blob.digest);
        let bytes = read_limited(self.send(|client| client.get(&url)).await?, MAX_DOCUMENT).await?;
        ensure!(
            sha256_digest(&bytes) == blob.digest,
            "blob {} does not match its digest",
            blob.digest
        );
        Ok(bytes)
    }

    /// Downloads a blob to `path`, checking its size and digest as it
    /// streams; tries again on failure.
    async fn blob_to_file(&self, base: &str, blob: &Descriptor, path: &Path) -> Result<()> {
        ensure!(valid_digest(&blob.digest), "bad digest {}", blob.digest);
        let url = format!("{base}/blobs/{}", blob.digest);
        let mut last = None;
        for attempt in 1..=ATTEMPTS {
            match self.download(&url, blob, path).await {
                Ok(()) => return Ok(()),
                Err(error) => {
                    tracing::warn!(attempt, digest = %blob.digest, %error, "layer download failed");
                    last = Some(error);
                }
            }
        }
        Err(last.unwrap_or_else(|| anyhow!("no attempt")))
    }

    async fn download(&self, url: &str, blob: &Descriptor, path: &Path) -> Result<()> {
        let response = self.send(|client| client.get(url)).await?;
        let mut file = tokio::fs::File::create(path).await?;
        let mut hasher = Sha256::new();
        let mut length = 0_u64;
        let mut body = response.bytes_stream();
        while let Some(chunk) = body.next().await {
            let chunk = chunk?;
            length += chunk.len() as u64;
            ensure!(
                length <= blob.size,
                "blob {} is longer than {}",
                blob.digest,
                blob.size
            );
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        ensure!(
            length == blob.size,
            "blob {}: {length} bytes, expected {}",
            blob.digest,
            blob.size
        );
        let digest = format!("sha256:{:x}", hasher.finalize());
        ensure!(
            digest == blob.digest,
            "blob {} arrived as {digest}",
            blob.digest
        );
        Ok(())
    }

    /// Sends a request, answering one authentication challenge if the
    /// registry asks.
    async fn send(&self, request: impl Fn(&reqwest::Client) -> RequestBuilder) -> Result<Response> {
        let current = self
            .authorization
            .lock()
            .map_err(|_| anyhow!("poisoned"))?
            .clone();
        let mut builder = request(&self.client);
        if let Some(value) = &current {
            builder = builder.header(AUTHORIZATION, value);
        }
        let response = builder.send().await?;
        if response.status() != StatusCode::UNAUTHORIZED {
            return checked(response).await;
        }
        let value = self.answer(response.headers()).await?;
        *self.authorization.lock().map_err(|_| anyhow!("poisoned"))? = Some(value.clone());
        checked(
            request(&self.client)
                .header(AUTHORIZATION, value)
                .send()
                .await?,
        )
        .await
    }

    /// The `Authorization` value that answers the challenge in `headers`.
    async fn answer(&self, headers: &HeaderMap) -> Result<String> {
        let challenge = headers
            .get(WWW_AUTHENTICATE)
            .and_then(|value| value.to_str().ok())
            .and_then(Challenge::parse)
            .ok_or_else(|| anyhow!("the registry refused access and gave no challenge"))?;
        match challenge.scheme.as_str() {
            "basic" => Ok(self
                .credentials
                .as_ref()
                .ok_or_else(|| anyhow!("the registry wants credentials"))?
                .basic()),
            "bearer" => {
                let realm = challenge
                    .params
                    .get("realm")
                    .ok_or_else(|| anyhow!("bearer challenge without a realm"))?;
                let mut query: Vec<(&str, &str)> = Vec::new();
                for key in ["service", "scope"] {
                    if let Some(value) = challenge.params.get(key) {
                        query.push((key, value));
                    }
                }
                let mut builder = self.client.get(realm).query(&query);
                if let Some(credentials) = &self.credentials {
                    builder = builder.header(AUTHORIZATION, credentials.basic());
                }
                let response = checked(builder.send().await?).await?;
                let token: Token =
                    serde_json::from_slice(&read_limited(response, MAX_DOCUMENT).await?)?;
                let token = token
                    .token
                    .or(token.access_token)
                    .ok_or_else(|| anyhow!("the token service gave no token"))?;
                Ok(format!("Bearer {token}"))
            }
            other => bail!("unsupported authentication scheme {other}"),
        }
    }
}

#[derive(Deserialize)]
struct Token {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    access_token: Option<String>,
}

async fn checked(response: Response) -> Result<Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let url = response.url().clone();
    let body = read_limited(response, 4096).await.unwrap_or_default();
    bail!(
        "{} {}: {status} {}",
        url.host_str().unwrap_or_default(),
        url.path(),
        String::from_utf8_lossy(&body).trim()
    )
}

async fn read_limited(response: Response, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut body = response.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk?;
        if bytes.len() + chunk.len() > limit {
            bail!("response larger than {limit} bytes");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenges_keep_quoted_commas() {
        let challenge = Challenge::parse(
            r#"Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull,push""#,
        )
        .unwrap();
        assert_eq!(challenge.scheme, "bearer");
        assert_eq!(challenge.params["realm"], "https://ghcr.io/token");
        assert_eq!(challenge.params["scope"], "repository:a/b:pull,push");
        let basic = Challenge::parse(r#"Basic realm="Registry Realm""#).unwrap();
        assert_eq!(basic.scheme, "basic");
        assert_eq!(basic.params["realm"], "Registry Realm");
        let bare = Challenge::parse("Bearer realm=https://x/token, service=x").unwrap();
        assert_eq!(bare.params["realm"], "https://x/token");
        assert_eq!(bare.params["service"], "x");
        assert_eq!(Challenge::parse(""), None);
        assert_eq!(Challenge::parse(r#"Bearer realm="unterminated"#), None);
    }

    #[test]
    fn picks_linux_amd64_from_an_index() {
        let index: Document = serde_json::from_str(
            r#"{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[
                {"mediaType":"m","digest":"sha256:1","size":1,"platform":{"architecture":"arm64","os":"linux"}},
                {"mediaType":"m","digest":"sha256:2","size":1,"platform":{"architecture":"unknown","os":"unknown"}},
                {"mediaType":"m","digest":"sha256:3","size":1,"platform":{"architecture":"amd64","os":"linux"}}]}"#,
        )
        .unwrap();
        let manifests = index.manifests.unwrap();
        assert_eq!(linux_amd64(&manifests).unwrap().digest, "sha256:3");
        assert!(linux_amd64(&manifests[..2]).is_none());
    }

    #[test]
    fn layer_types() {
        assert_eq!(
            Compression::of("application/vnd.oci.image.layer.v1.tar+gzip"),
            Some(Compression::Gzip)
        );
        assert_eq!(
            Compression::of("application/vnd.docker.image.rootfs.diff.tar.gzip"),
            Some(Compression::Gzip)
        );
        assert_eq!(
            Compression::of("application/vnd.oci.image.layer.v1.tar+zstd"),
            Some(Compression::Zstd)
        );
        assert_eq!(
            Compression::of("application/vnd.oci.image.layer.v1.tar"),
            Some(Compression::None)
        );
        assert_eq!(Compression::of("application/vnd.in-toto+json"), None);
    }

    #[test]
    fn configs_read_docker_and_oci_fields() {
        let image: ImageFile = serde_json::from_str(
            r#"{"architecture":"amd64","os":"linux","config":{"User":"node","Env":["A=1"],"Cmd":["node"],"WorkingDir":"/app"},
                "rootfs":{"type":"layers","diff_ids":["sha256:x"]}}"#,
        )
        .unwrap();
        image.platform().unwrap();
        let run = image.config.unwrap();
        assert_eq!(run.user.as_deref(), Some("node"));
        assert_eq!(run.working_dir.as_deref(), Some("/app"));
        assert_eq!(run.entrypoint, None);
        assert_eq!(image.rootfs.diff_ids, ["sha256:x"]);
    }

    #[test]
    fn only_linux_amd64_configs_pass() {
        let config = |platform: &str| -> ImageFile {
            serde_json::from_str(&format!(
                r#"{{{platform}"rootfs":{{"type":"layers","diff_ids":[]}}}}"#
            ))
            .unwrap()
        };
        config(r#""architecture":"amd64","os":"linux","#)
            .platform()
            .unwrap();
        // A tag that names one arm64 manifest directly, with no index.
        let arm = config(r#""architecture":"arm64","os":"linux","#).platform();
        assert!(
            arm.unwrap_err().to_string().contains("linux/arm64"),
            "arm64 refused"
        );
        assert!(
            config(r#""architecture":"amd64","os":"windows","#)
                .platform()
                .is_err()
        );
        assert!(config("").platform().is_err());
    }

    #[test]
    fn digests_and_credentials() {
        assert_eq!(
            sha256_digest(b""),
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        let credentials = Credentials {
            username: "u".into(),
            secret: "p".into(),
        };
        assert_eq!(credentials.basic(), "Basic dTpw");
        let shown = format!("{credentials:?}");
        assert!(
            !shown.contains("secret") && !shown.contains("\"p\""),
            "{shown}"
        );
    }
}
