//! A Google Cloud managed instance group of hosts, which the leader grows
//! before spare memory runs out.
//!
//! The service reads the group's target size and base instance name, and
//! sets its size, through the Compute Engine API with the instance's own
//! service account token from the metadata server. Hosts belong to the
//! group by name: the group names its instances after its base name.

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

impl GcpGroup {
    /// The group at resource `path`, reached through `api` with tokens
    /// from `metadata` ([`COMPUTE_API`] and [`METADATA`] outside tests).
    pub fn new(path: &str, api: &str, metadata: &str) -> anyhow::Result<Self> {
        anyhow::ensure!(
            path.starts_with("projects/") && path.contains("/instanceGroupManagers/"),
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
}
