//! GitHub: credentials, the actions service a scale set lives in, and its
//! calls ([ADR 23](../../../../docs/adr/0023-github-actions-runner-pools.md)).
//!
//! A registration token from GitHub's REST API buys an admin connection to
//! the actions service (its URL and a token of about an hour); every
//! scale set call goes there. Both are refreshed a minute before they end.

mod auth;
mod session;
pub mod wire;

use std::fmt;
use std::time::{Duration, SystemTime};

use anyhow::{Context as _, Result, bail};
use reqwest::{Method, StatusCode};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::sync::Mutex;

pub use auth::{App, Credentials};
pub use session::{Polled, SessionError};
use wire::{JitConfig, JitSetting, Label, List, RunnerGroup, RunnerRef, RunnerSetting, ScaleSet};

/// The actions service's API version, as GitHub's clients send it.
const API_VERSION: &str = "6.0-preview";
/// How long before a token ends it is replaced.
const REFRESH_BEFORE: Duration = Duration::from_secs(60);
/// The exception the actions service names when it keeps a runner because
/// the runner has a job.
const STILL_RUNNING: &str = "JobStillRunningException";
/// Runners per page of the REST API's listing, its most.
const PER_PAGE: usize = 100;

/// An answer GitHub gave that was not the one expected.
#[derive(Debug, thiserror::Error)]
#[error("{what}: {status} {body}")]
pub struct Refused {
    pub what: String,
    pub status: StatusCode,
    pub body: String,
}

/// Where runners register: an organization or one repository.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    Organization(String),
    Repository(String, String),
}

impl Scope {
    /// `owner` or `owner/repo`.
    pub fn parse(text: &str) -> Result<Self> {
        let good = |part: &str| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        };
        match text.split_once('/') {
            None if good(text) => Ok(Self::Organization(text.into())),
            Some((owner, repo)) if good(owner) && good(repo) => {
                Ok(Self::Repository(owner.into(), repo.into()))
            }
            _ => bail!("{text:?} is not `owner` or `owner/repo`"),
        }
    }

    fn registration_path(&self) -> String {
        match self {
            Self::Organization(owner) => {
                format!("/orgs/{owner}/actions/runners/registration-token")
            }
            Self::Repository(owner, repo) => {
                format!("/repos/{owner}/{repo}/actions/runners/registration-token")
            }
        }
    }

    fn runners_path(&self) -> String {
        match self {
            Self::Organization(owner) => format!("/orgs/{owner}/actions/runners"),
            Self::Repository(owner, repo) => format!("/repos/{owner}/{repo}/actions/runners"),
        }
    }
}

impl fmt::Display for Scope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Organization(owner) => f.write_str(owner),
            Self::Repository(owner, repo) => write!(f, "{owner}/{repo}"),
        }
    }
}

/// An admin connection to the actions service.
#[derive(Clone, Debug)]
struct Admin {
    url: String,
    token: String,
    ends: SystemTime,
}

/// What became of a runner asked to be removed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Removed {
    Removed,
    /// GitHub had no such runner (its job ended, or it was removed).
    Gone,
    /// GitHub kept it: it has a job.
    Busy,
}

/// A runner registered in the scope, as the REST API lists it.
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
pub struct Registered {
    pub id: u64,
    pub name: String,
    pub busy: bool,
}

/// GitHub, for one scope.
#[derive(Debug)]
pub struct Github {
    http: reqwest::Client,
    /// The REST API, `https://api.github.com` or a server's `/api/v3`.
    api: String,
    /// The scope's page, `https://github.com/owner[/repo]`, which the
    /// actions service knows it by.
    page: String,
    scope: Scope,
    credentials: Credentials,
    admin: Mutex<Option<Admin>>,
}

impl Github {
    #[must_use]
    /// GitHub at `web` (`https://github.com`) and its API at `api`.
    pub fn new(
        http: reqwest::Client,
        web: &str,
        api: &str,
        scope: Scope,
        credentials: Credentials,
    ) -> Self {
        Self {
            http,
            api: api.trim_end_matches('/').into(),
            page: format!("{}/{scope}", web.trim_end_matches('/')),
            scope,
            credentials,
            admin: Mutex::new(None),
        }
    }

    #[must_use]
    pub fn scope(&self) -> &Scope {
        &self.scope
    }

    /// The scope's page, `https://github.com/owner[/repo]`: its server and
    /// scope, which the actions service numbers its scale sets within.
    #[must_use]
    pub fn page(&self) -> &str {
        &self.page
    }

    /// A token for GitHub's REST API: the one given, or the App
    /// installation's.
    pub async fn token(&self) -> Result<String> {
        self.credentials.token(&self.http, &self.api).await
    }

    /// A REST call to the API.
    pub async fn rest(&self, method: Method, path: &str) -> Result<reqwest::RequestBuilder> {
        self.rest_as(method, path, "application/vnd.github+json")
            .await
    }

    /// A REST call to the API answered as `accept`, a media type of its own.
    async fn rest_as(
        &self,
        method: Method,
        path: &str,
        accept: &str,
    ) -> Result<reqwest::RequestBuilder> {
        Ok(self
            .http
            .request(method, format!("{}{path}", self.api))
            .bearer_auth(self.token().await?)
            .header("accept", accept)
            .header("user-agent", USER_AGENT))
    }

    async fn admin(&self) -> Result<Admin> {
        #[derive(serde::Deserialize)]
        struct Registration {
            token: String,
        }
        #[derive(serde::Deserialize)]
        struct Connection {
            url: String,
            token: String,
        }
        let mut admin = self.admin.lock().await;
        if let Some(current) = &*admin
            && SystemTime::now() + REFRESH_BEFORE < current.ends
        {
            return Ok(current.clone());
        }
        let response = self
            .rest(Method::POST, &self.scope.registration_path())
            .await?
            .send()
            .await?;
        let registration: Registration =
            expect(response, StatusCode::CREATED, "a registration token").await?;
        // A fresh registration token is not always accepted at once.
        let mut tries = 0;
        let connection: Connection = loop {
            tries += 1;
            let response = self
                .http
                .post(format!("{}/actions/runner-registration", self.api))
                .header(
                    "authorization",
                    format!("RemoteAuth {}", registration.token),
                )
                .header("user-agent", USER_AGENT)
                .json(&serde_json::json!({"url": self.page, "runner_event": "register"}))
                .send()
                .await?;
            if matches!(
                response.status(),
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
            ) && tries < 5
            {
                tokio::time::sleep(Duration::from_secs(tries)).await;
                continue;
            }
            break expect(response, StatusCode::OK, "the actions service's address").await?;
        };
        let fresh = Admin {
            ends: auth::jwt_ends(&connection.token)?,
            url: connection.url.trim_end_matches('/').into(),
            token: connection.token,
        };
        *admin = Some(fresh.clone());
        Ok(fresh)
    }

    /// A call to the actions service at `path`, with the admin token.
    async fn actions(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<reqwest::RequestBuilder> {
        let admin = self.admin().await?;
        Ok(self
            .actions_with(&admin.url, method, path, query)
            .bearer_auth(admin.token))
    }

    /// Sends `request`, made with the admin token: a token refused before
    /// its time is forgotten, so the next call is made with a fresh one.
    async fn send_admin(&self, request: reqwest::RequestBuilder) -> Result<reqwest::Response> {
        let response = request.send().await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            tracing::info!(
                "the actions service refused its admin token; the next call gets another"
            );
            *self.admin.lock().await = None;
        }
        Ok(response)
    }

    fn actions_with(
        &self,
        base: &str,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
    ) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{base}/{}", path.trim_start_matches('/')))
            .query(query)
            .query(&[("api-version", API_VERSION)])
            .header("user-agent", USER_AGENT)
    }

    async fn call<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&impl Serialize>,
        what: &str,
    ) -> Result<T> {
        let mut request = self.actions(method, path, query).await?;
        if let Some(body) = body {
            request = request.json(body);
        }
        expect(self.send_admin(request).await?, StatusCode::OK, what).await
    }

    /// The id of the runner group `name` (`default` is 1).
    pub async fn runner_group(&self, name: &str) -> Result<u64> {
        if name.eq_ignore_ascii_case("default") {
            return Ok(1);
        }
        let groups: List<RunnerGroup> = self
            .call(
                Method::GET,
                "_apis/runtime/runnergroups/",
                &[("groupName", name)],
                None::<&()>,
                "runner groups",
            )
            .await?;
        match groups.value.as_slice() {
            [group] => Ok(group.id),
            [] => bail!("no runner group is named {name:?}"),
            _ => bail!("more than one runner group is named {name:?}"),
        }
    }

    /// The scale set `name` in `group`, made with `labels` when there is
    /// none, and given them when its own differ.
    pub async fn ensure_scale_set(
        &self,
        group: u64,
        name: &str,
        labels: &[String],
    ) -> Result<ScaleSet> {
        let group_text = group.to_string();
        let found: List<ScaleSet> = self
            .call(
                Method::GET,
                "_apis/runtime/runnerscalesets",
                &[("runnerGroupId", &group_text), ("name", name)],
                None::<&()>,
                "scale sets",
            )
            .await?;
        let wanted = ScaleSet {
            id: 0,
            name: name.into(),
            runner_group_id: group,
            labels: labels.iter().map(|label| Label::system(label)).collect(),
            runner_setting: RunnerSetting {
                disable_update: true,
            },
        };
        match found.value.into_iter().next() {
            None => {
                self.call(
                    Method::POST,
                    "_apis/runtime/runnerscalesets",
                    &[],
                    Some(&wanted),
                    "a new scale set",
                )
                .await
            }
            Some(existing) if same_labels(&existing.labels, &wanted.labels) => Ok(existing),
            Some(existing) => {
                tracing::info!(id = existing.id, ?labels, "the scale set's labels change");
                self.call(
                    Method::PATCH,
                    &format!("_apis/runtime/runnerscalesets/{}", existing.id),
                    &[],
                    Some(&ScaleSet {
                        id: existing.id,
                        ..wanted
                    }),
                    "the scale set's labels",
                )
                .await
            }
        }
    }

    /// Registers the just-in-time runner `name` in scale set `set`.
    pub async fn jit_config(&self, set: u64, name: &str) -> Result<JitConfig> {
        self.call(
            Method::POST,
            &format!("_apis/runtime/runnerscalesets/{set}/generatejitconfig"),
            &[],
            Some(&JitSetting {
                name,
                work_folder: "_work",
            }),
            "a just-in-time runner",
        )
        .await
    }

    /// The runner `name`, if GitHub knows it.
    pub async fn runner(&self, name: &str) -> Result<Option<RunnerRef>> {
        let found: List<RunnerRef> = self
            .call(
                Method::GET,
                "_apis/distributedtask/pools/0/agents",
                &[("agentName", name)],
                None::<&()>,
                "a runner",
            )
            .await?;
        Ok(found.value.into_iter().find(|runner| runner.name == name))
    }

    /// Removes the runner `id`, unless it has a job. Any other refusal is an
    /// error, so the runner is asked about again later.
    pub async fn remove_runner(&self, id: u64) -> Result<Removed> {
        let request = self
            .actions(
                Method::DELETE,
                &format!("_apis/distributedtask/pools/0/agents/{id}"),
                &[],
            )
            .await?;
        let response = self.send_admin(request).await?;
        let status = response.status();
        match status {
            StatusCode::NO_CONTENT | StatusCode::OK => Ok(Removed::Removed),
            StatusCode::NOT_FOUND => Ok(Removed::Gone),
            _ => {
                let body = response.text().await.unwrap_or_default();
                if status == StatusCode::BAD_REQUEST && body.contains(STILL_RUNNING) {
                    tracing::debug!(id, "GitHub kept a runner with a job");
                    return Ok(Removed::Busy);
                }
                Err(Refused {
                    what: format!("removing runner {id}"),
                    status,
                    body,
                }
                .into())
            }
        }
    }

    /// Every runner registered in the scope.
    pub async fn registered(&self) -> Result<Vec<Registered>> {
        #[derive(serde::Deserialize)]
        struct Page {
            runners: Vec<Registered>,
        }
        let path = self.scope.runners_path();
        let mut all = Vec::new();
        for page in 1.. {
            let response = self
                .rest(Method::GET, &path)
                .await?
                .query(&[("per_page", PER_PAGE), ("page", page)])
                .send()
                .await?;
            let found: Page = expect(response, StatusCode::OK, "the scope's runners").await?;
            let last = found.runners.len() < PER_PAGE;
            all.extend(found.runners);
            if last {
                break;
            }
        }
        Ok(all)
    }

    /// The commit branch `branch` of repository `repo` (`owner/repo`) is at.
    pub async fn branch_head(&self, repo: &str, branch: &str) -> Result<String> {
        let response = self
            .rest_as(
                Method::GET,
                &format!("/repos/{repo}/commits/{branch}"),
                "application/vnd.github.sha",
            )
            .await?
            .send()
            .await?;
        let status = response.status();
        let body = response.text().await?;
        if status != StatusCode::OK {
            bail!(Refused {
                what: format!("the head of {repo} {branch}"),
                status,
                body
            });
        }
        let sha = body.trim();
        anyhow::ensure!(
            sha.len() == 40 && sha.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "the head of {repo} {branch} is not a commit: {sha:?}"
        );
        Ok(sha.into())
    }

    /// Repository `repo`'s default branch.
    pub async fn default_branch(&self, repo: &str) -> Result<String> {
        #[derive(serde::Deserialize)]
        struct Repository {
            default_branch: String,
        }
        let response = self
            .rest(Method::GET, &format!("/repos/{repo}"))
            .await?
            .send()
            .await?;
        let found: Repository = expect(response, StatusCode::OK, "the repository").await?;
        Ok(found.default_branch)
    }
}

fn same_labels(have: &[Label], want: &[Label]) -> bool {
    let names = |labels: &[Label]| {
        let mut names: Vec<String> = labels
            .iter()
            .map(|label| label.name.to_ascii_lowercase())
            .collect();
        names.sort();
        names
    };
    names(have) == names(want)
}

/// The service's name to GitHub.
const USER_AGENT: &str = concat!("opengeni-compute-runners/", env!("CARGO_PKG_VERSION"));

/// Reads `response` as `T` when its status is `status`.
async fn expect<T: DeserializeOwned>(
    response: reqwest::Response,
    status: StatusCode,
    what: &str,
) -> Result<T> {
    if response.status() != status {
        return Err(Refused {
            what: what.into(),
            status: response.status(),
            body: response.text().await.unwrap_or_default(),
        }
        .into());
    }
    let bytes = response.bytes().await?;
    // The actions service may begin with a byte order mark.
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    serde_json::from_slice(bytes).with_context(|| format!("{what}: not the answer expected"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scope_is_an_owner_or_a_repository() {
        assert_eq!(
            Scope::parse("acme").unwrap(),
            Scope::Organization("acme".into())
        );
        assert_eq!(
            Scope::parse("acme/web.app").unwrap(),
            Scope::Repository("acme".into(), "web.app".into())
        );
        for wrong in ["", "acme/", "/web", "a/b/c", "a b", "acme/web?x"] {
            assert!(Scope::parse(wrong).is_err(), "{wrong}");
        }
        assert_eq!(
            Scope::parse("acme/web").unwrap().registration_path(),
            "/repos/acme/web/actions/runners/registration-token"
        );
        assert_eq!(
            Scope::parse("acme").unwrap().registration_path(),
            "/orgs/acme/actions/runners/registration-token"
        );
    }

    #[test]
    fn labels_compare_as_sets_whatever_their_case() {
        let set = |names: &[&str]| {
            names
                .iter()
                .map(|name| Label::system(name))
                .collect::<Vec<_>>()
        };
        assert!(same_labels(&set(&["ci", "Linux"]), &set(&["linux", "ci"])));
        assert!(!same_labels(&set(&["ci"]), &set(&["ci", "linux"])));
    }
}
