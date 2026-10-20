//! A Google Cloud managed instance group of hosts, which the leader grows
//! before spare memory runs out, and whose instances it fences before it
//! gives up on one.
//!
//! The service reads the group's target size and base instance name, sets
//! its size, and resets, reads and starts its instances, through the
//! Compute Engine API. Its tokens come from the metadata server (the
//! instance's own service account, or a GKE workload's), or, for a service
//! that runs off Google Cloud, from a service account key file, with
//! which it signs its own token requests ([`Credentials`]). Hosts belong to
//! the group by name: the group names its instances after its base name.
//! Only zonal groups are supported: their instances live in the group's
//! zone.

use std::fmt;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Context as _;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::rand::SystemRandom;
use ring::signature::{RSA_PKCS1_SHA256, RsaKeyPair};
use rustls::pki_types::PrivatePkcs8KeyDer;
use rustls::pki_types::pem::PemObject as _;
use serde::Deserialize;

/// Where the Compute Engine API is.
pub const COMPUTE_API: &str = "https://compute.googleapis.com";
/// Where the metadata server is.
pub const METADATA: &str = "http://169.254.169.254";
/// What a key's token is for: the Compute Engine API.
const SCOPE: &str = "https://www.googleapis.com/auth/compute";
/// How long a signed token request is good for, at most an hour.
const ASSERTION_LIFETIME: u64 = 3600;

/// How long before its expiry a token is fetched again.
const TOKEN_SLACK: Duration = Duration::from_secs(60);

/// Where the group's API tokens come from.
#[derive(Debug)]
pub enum Credentials {
    /// The metadata server at this URL ([`METADATA`] outside tests).
    Metadata(String),
    /// A service account's key.
    Key(Box<ServiceAccountKey>),
}

/// A service account's key, as Google Cloud writes it to a key file
/// (`gcloud iam service-accounts keys create`). Its account signs its own
/// token requests (OAuth 2.0's JWT bearer grant).
pub struct ServiceAccountKey {
    email: String,
    key_id: Option<String>,
    token_uri: String,
    key: RsaKeyPair,
}

impl fmt::Debug for ServiceAccountKey {
    /// Never shows the key.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServiceAccountKey")
            .field("email", &self.email)
            .field("key_id", &self.key_id)
            .field("token_uri", &self.token_uri)
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
struct KeyFile {
    #[serde(rename = "type")]
    kind: String,
    client_email: String,
    #[serde(default)]
    private_key_id: Option<String>,
    private_key: String,
    token_uri: String,
}

impl ServiceAccountKey {
    /// Reads a key file's contents.
    ///
    /// # Errors
    ///
    /// It is not a service account key file (other credential files, such
    /// as workload identity federation's, are not supported), or its key
    /// is not an RSA key in PKCS #8.
    pub fn from_json(json: &[u8]) -> anyhow::Result<Self> {
        let file: KeyFile = serde_json::from_slice(json).context("a service account key file")?;
        anyhow::ensure!(
            file.kind == "service_account",
            "a credentials file of type {:?}, not a service account key",
            file.kind
        );
        let der = PrivatePkcs8KeyDer::from_pem_slice(file.private_key.as_bytes())
            .map_err(|error| anyhow::anyhow!("the key file's private key: {error}"))?;
        let key = RsaKeyPair::from_pkcs8(der.secret_pkcs8_der())
            .map_err(|error| anyhow::anyhow!("the key file's private key: {error}"))?;
        Ok(Self {
            email: file.client_email,
            key_id: file.private_key_id,
            token_uri: file.token_uri,
            key,
        })
    }

    /// The signed token request for the Compute Engine API at Unix time
    /// `now`.
    fn assertion(&self, now: u64) -> anyhow::Result<String> {
        let mut header = serde_json::json!({"alg": "RS256", "typ": "JWT"});
        if let Some(kid) = &self.key_id {
            header["kid"] = kid.as_str().into();
        }
        let claims = serde_json::json!({
            "iss": self.email,
            "scope": SCOPE,
            "aud": self.token_uri,
            "iat": now,
            "exp": now + ASSERTION_LIFETIME,
        });
        let signed = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header.to_string()),
            URL_SAFE_NO_PAD.encode(claims.to_string())
        );
        let mut signature = vec![0; self.key.public().modulus_len()];
        self.key
            .sign(
                &RSA_PKCS1_SHA256,
                &SystemRandom::new(),
                signed.as_bytes(),
                &mut signature,
            )
            .map_err(|_| anyhow::anyhow!("signing a token request failed"))?;
        Ok(format!("{signed}.{}", URL_SAFE_NO_PAD.encode(signature)))
    }
}

/// A managed instance group.
#[derive(Debug)]
pub struct GcpGroup {
    http: reqwest::Client,
    api: String,
    credentials: Credentials,
    /// Its resource path, such as
    /// `projects/p/zones/z/instanceGroupManagers/hosts`.
    path: String,
    token: Mutex<Option<(String, Instant)>>,
}

/// What the leader reads of the group.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Described {
    /// How many instances it is asked to have.
    pub target_size: u32,
    /// The name its instances' names start with, followed by a dash.
    pub base_instance_name: String,
}

#[derive(Deserialize)]
struct Token {
    access_token: String,
    expires_in: u64,
}

/// What a fence found or did to a host's instance. In every case nothing
/// the host ran before the fence runs any more.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fenced {
    /// The instance no longer exists.
    Gone,
    /// It is stopped, and stays so until started.
    Stopped,
    /// It was reset: its memory is gone and it boots afresh, keeping its
    /// disks.
    Reset,
}

#[derive(Deserialize)]
struct Instance {
    status: String,
}

#[derive(Deserialize)]
struct Operation {
    name: String,
    status: String,
    #[serde(default)]
    error: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Managed {
    #[serde(default)]
    managed_instances: Vec<ManagedInstance>,
    #[serde(default)]
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedInstance {
    instance: String,
    #[serde(default)]
    instance_status: Option<String>,
    /// What the group itself is doing to the instance, `NONE` when nothing
    /// (recreating it, as its autohealing does, or deleting, starting or
    /// stopping it).
    #[serde(default)]
    current_action: Option<String>,
}

/// What starting an instance came to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Started {
    /// It was asked to start.
    Asked,
    /// It no longer exists: the group deleted it, as it does to recreate
    /// it, and nothing is left to start.
    Gone,
}

/// One instance of the group.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    /// Its instance name.
    pub name: String,
    /// Whether it is stopped.
    pub stopped: bool,
    /// Whether the group itself is doing nothing to it. One it is
    /// recreating, deleting or starting is left to it: starting it
    /// meanwhile races the group, and fails once the group has deleted it.
    pub idle: bool,
    /// Whether the group is removing it (deleting or abandoning it): it
    /// holds no place in the group's size, and what its host has counts
    /// for nothing.
    pub leaving: bool,
}

/// How often a fence looks again at an instance or operation.
const POLL_EVERY: Duration = Duration::from_secs(1);

impl GcpGroup {
    /// The group at resource `path`, reached through `api` ([`COMPUTE_API`]
    /// outside tests) with tokens from `credentials`.
    pub fn new(path: &str, api: &str, credentials: Credentials) -> anyhow::Result<Self> {
        anyhow::ensure!(
            path.starts_with("projects/")
                && path.contains("/zones/")
                && path.contains("/instanceGroupManagers/"),
            "a group is named projects/…/zones/…/instanceGroupManagers/…, not {path}"
        );
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .context("an HTTP client")?;
        Ok(Self {
            http,
            api: api.trim_end_matches('/').to_owned(),
            credentials,
            path: path.trim_matches('/').to_owned(),
            token: Mutex::new(None),
        })
    }

    async fn token(&self) -> anyhow::Result<String> {
        {
            let token = self
                .token
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some((token, until)) = &*token
                && Instant::now() < *until
            {
                return Ok(token.clone());
            }
        }
        let request = match &self.credentials {
            Credentials::Metadata(metadata) => self
                .http
                .get(format!(
                    "{}/computeMetadata/v1/instance/service-accounts/default/token",
                    metadata.trim_end_matches('/')
                ))
                .header("Metadata-Flavor", "Google"),
            Credentials::Key(key) => {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .context("the clock is before 1970")?
                    .as_secs();
                let body = form_urlencoded::Serializer::new(String::new())
                    .append_pair("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
                    .append_pair("assertion", &key.assertion(now)?)
                    .finish();
                self.http
                    .post(&key.token_uri)
                    .header(
                        reqwest::header::CONTENT_TYPE,
                        "application/x-www-form-urlencoded",
                    )
                    .body(body)
            }
        };
        let token: Token = request.send().await?.error_for_status()?.json().await?;
        let until =
            Instant::now() + Duration::from_secs(token.expires_in).saturating_sub(TOKEN_SLACK);
        *self
            .token
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some((token.access_token.clone(), until));
        Ok(token.access_token)
    }

    /// The group's target size and base name.
    pub async fn describe(&self) -> anyhow::Result<Described> {
        let token = self.token().await?;
        let url = format!("{}/compute/v1/{}", self.api, self.path);
        Ok(self
            .http
            .get(url)
            .bearer_auth(token)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }

    /// Asks the group for `size` instances in all.
    pub async fn resize(&self, size: u32) -> anyhow::Result<()> {
        let token = self.token().await?;
        let url = format!("{}/compute/v1/{}/resize", self.api, self.path);
        self.http
            .post(url)
            .query(&[("size", size)])
            .bearer_auth(token)
            .header(reqwest::header::CONTENT_LENGTH, 0)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// The zone's resource path, such as `projects/p/zones/z`.
    fn zone(&self) -> &str {
        self.path
            .split("/instanceGroupManagers/")
            .next()
            .unwrap_or(&self.path)
    }

    fn instance_url(&self, name: &str) -> String {
        format!("{}/compute/v1/{}/instances/{name}", self.api, self.zone())
    }

    /// The status of instance `name`, or `None` if it does not exist.
    async fn status(&self, name: &str) -> anyhow::Result<Option<String>> {
        let token = self.token().await?;
        let response = self
            .http
            .get(self.instance_url(name))
            .bearer_auth(token)
            .send()
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let instance: Instance = response.error_for_status()?.json().await?;
        Ok(Some(instance.status))
    }

    /// Asks for `action` (`reset`, `stop` or `start`) on instance `name`.
    async fn act(&self, name: &str, action: &str) -> anyhow::Result<Operation> {
        let token = self.token().await?;
        Ok(self
            .http
            .post(format!("{}/{action}", self.instance_url(name)))
            .bearer_auth(token)
            .header(reqwest::header::CONTENT_LENGTH, 0)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }

    /// Waits for `operation` to be done, until `deadline`; an error if it
    /// failed or did not finish in time.
    async fn finish(&self, mut operation: Operation, deadline: Instant) -> anyhow::Result<()> {
        loop {
            if operation.status == "DONE" {
                return match operation.error {
                    None => Ok(()),
                    Some(error) => Err(anyhow::anyhow!(
                        "operation {} failed: {error}",
                        operation.name
                    )),
                };
            }
            anyhow::ensure!(
                Instant::now() < deadline,
                "operation {} not done in time",
                operation.name
            );
            tokio::time::sleep(POLL_EVERY).await;
            let token = self.token().await?;
            let url = format!(
                "{}/compute/v1/{}/operations/{}",
                self.api,
                self.zone(),
                operation.name
            );
            operation = self
                .http
                .get(url)
                .bearer_auth(token)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
        }
    }

    /// Makes sure nothing that ran on instance `name` runs any more, within
    /// `within`: resets it once it runs, stops it if it is suspended (which
    /// would keep its memory), and finds it already fenced only if it is
    /// stopped or gone. Meanwhile it waits: while the instance starts,
    /// stops, suspends or is repaired. A starting instance is not taken as
    /// fenced, since one resuming from a suspend passes through the same
    /// states with its memory kept. An error proves nothing: the host may
    /// still run.
    pub async fn fence(&self, name: &str, within: Duration) -> anyhow::Result<Fenced> {
        let deadline = Instant::now() + within;
        loop {
            let Some(status) = self.status(name).await? else {
                return Ok(Fenced::Gone);
            };
            match status.as_str() {
                "TERMINATED" => return Ok(Fenced::Stopped),
                "RUNNING" => {
                    let operation = self.act(name, "reset").await?;
                    self.finish(operation, deadline).await?;
                    return Ok(Fenced::Reset);
                }
                "SUSPENDED" => {
                    let operation = self.act(name, "stop").await?;
                    self.finish(operation, deadline).await?;
                }
                // Starting or resuming (`PROVISIONING`, `STAGING`),
                // stopping, suspending or being repaired: look again.
                _ => {}
            }
            anyhow::ensure!(
                Instant::now() < deadline,
                "{name} still {status} after {within:?}"
            );
            tokio::time::sleep(POLL_EVERY).await;
        }
    }

    /// Starts stopped instance `name`, without waiting for it to run. An
    /// instance that no longer exists is [`Started::Gone`], not an error.
    pub async fn start(&self, name: &str) -> anyhow::Result<Started> {
        let token = self.token().await?;
        let response = self
            .http
            .post(format!("{}/start", self.instance_url(name)))
            .bearer_auth(token)
            .header(reqwest::header::CONTENT_LENGTH, 0)
            .send()
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(Started::Gone);
        }
        response.error_for_status()?;
        Ok(Started::Asked)
    }

    /// The group's instances, as its manager lists them.
    pub async fn members(&self) -> anyhow::Result<Vec<Member>> {
        let mut members = Vec::new();
        let mut page: Option<String> = None;
        loop {
            let token = self.token().await?;
            let mut request = self
                .http
                .post(format!(
                    "{}/compute/v1/{}/listManagedInstances",
                    self.api, self.path
                ))
                .bearer_auth(token)
                .header(reqwest::header::CONTENT_LENGTH, 0);
            if let Some(page) = &page {
                request = request.query(&[("pageToken", page)]);
            }
            let managed: Managed = request.send().await?.error_for_status()?.json().await?;
            members.extend(managed.managed_instances.into_iter().filter_map(|managed| {
                let name = managed.instance.rsplit('/').next()?.to_owned();
                let action = managed.current_action.as_deref();
                Some(Member {
                    name,
                    stopped: managed.instance_status.as_deref() == Some("TERMINATED"),
                    idle: action.is_none_or(|action| action == "NONE"),
                    leaving: matches!(action, Some("DELETING" | "ABANDONING")),
                })
            }));
            match managed.next_page_token {
                Some(next) if !next.is_empty() => page = Some(next),
                _ => return Ok(members),
            }
        }
    }
}
