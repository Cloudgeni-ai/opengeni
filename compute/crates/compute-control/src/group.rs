//! A Google Cloud managed instance group of hosts, which the leader grows
//! before spare memory runs out, and whose instances it fences before it
//! gives up on one.
//!
//! The service reads the group's target size and base instance name, sets
//! its size, and resets, reads and starts its instances, through the
//! Compute Engine API with the instance's own service account token from
//! the metadata server. Hosts belong to the group by name: the group names
//! its instances after its base name. Only zonal groups are supported:
//! their instances live in the group's zone.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Context as _;
use serde::Deserialize;

/// Where the Compute Engine API is.
pub const COMPUTE_API: &str = "https://compute.googleapis.com";
/// Where the metadata server is.
pub const METADATA: &str = "http://169.254.169.254";

/// How long before its expiry a token is fetched again.
const TOKEN_SLACK: Duration = Duration::from_secs(60);

/// A managed instance group.
#[derive(Debug)]
pub struct GcpGroup {
    http: reqwest::Client,
    api: String,
    metadata: String,
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
}

/// How often a fence looks again at an instance or operation.
const POLL_EVERY: Duration = Duration::from_secs(1);

impl GcpGroup {
    /// The group at resource `path`, reached through `api` with tokens
    /// from `metadata` ([`COMPUTE_API`] and [`METADATA`] outside tests).
    pub fn new(path: &str, api: &str, metadata: &str) -> anyhow::Result<Self> {
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
            metadata: metadata.trim_end_matches('/').to_owned(),
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
        let url = format!(
            "{}/computeMetadata/v1/instance/service-accounts/default/token",
            self.metadata
        );
        let token: Token = self
            .http
            .get(url)
            .header("Metadata-Flavor", "Google")
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
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
    /// `within`: resets it if it runs, stops it if it is suspended (which
    /// would keep its memory), waits while it stops or suspends, and finds
    /// it already fenced if it is stopped, starting or gone. An error
    /// proves nothing: the host may still run.
    pub async fn fence(&self, name: &str, within: Duration) -> anyhow::Result<Fenced> {
        let deadline = Instant::now() + within;
        loop {
            let Some(status) = self.status(name).await? else {
                return Ok(Fenced::Gone);
            };
            match status.as_str() {
                "TERMINATED" => return Ok(Fenced::Stopped),
                // Starting from stopped: what ran before is gone.
                "PROVISIONING" | "STAGING" => return Ok(Fenced::Reset),
                "RUNNING" => {
                    let operation = self.act(name, "reset").await?;
                    self.finish(operation, deadline).await?;
                    return Ok(Fenced::Reset);
                }
                "SUSPENDED" => {
                    let operation = self.act(name, "stop").await?;
                    self.finish(operation, deadline).await?;
                }
                // Stopping, suspending or being repaired: look again.
                _ => {}
            }
            anyhow::ensure!(
                Instant::now() < deadline,
                "{name} still {status} after {within:?}"
            );
            tokio::time::sleep(POLL_EVERY).await;
        }
    }

    /// Starts stopped instance `name`, without waiting for it to run.
    pub async fn start(&self, name: &str) -> anyhow::Result<()> {
        self.act(name, "start").await.map(|_| ())
    }

    /// The names of the group's instances that are stopped.
    pub async fn stopped(&self) -> anyhow::Result<Vec<String>> {
        let mut stopped = Vec::new();
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
            stopped.extend(
                managed
                    .managed_instances
                    .into_iter()
                    .filter(|managed| managed.instance_status.as_deref() == Some("TERMINATED"))
                    .filter_map(|managed| managed.instance.rsplit('/').next().map(str::to_owned)),
            );
            match managed.next_page_token {
                Some(next) if !next.is_empty() => page = Some(next),
                _ => return Ok(stopped),
            }
        }
    }
}
