//! A fleet host's agent links (see `compute_link`): the host's token for
//! each gateway comes from the fleet service, over the same mutual TLS as
//! its lease, and names the host its certificate does.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use compute_link::{HostToken, Hub, HubConfig, Timing, Tokens};
use compute_protocol::fleet::{LINK_TOKENS_PATH, LinkTokens, LinkTokensAsked};
use futures::future::BoxFuture;
use rustls::{ClientConfig, RootCertStore};

use super::{FleetConfig, Tls, tls};

/// How long asking the service for a token may take.
const TOKEN_TIMEOUT: Duration = Duration::from_secs(10);

impl FleetConfig {
    /// Starts the host's agent links. Must run inside a Tokio runtime.
    pub fn agent_links(&self) -> anyhow::Result<Hub> {
        let tls = Tls::load(&self.tls)?;
        let http = reqwest::Client::builder()
            .use_preconfigured_tls(tls.client)
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .context("building the fleet service client for link tokens")?;
        let tokens = FleetTokens {
            http,
            url: format!("{}{LINK_TOKENS_PATH}", self.control.trim_end_matches('/')),
            name: self.info.name.clone(),
        };
        let mut seed = [0; 8];
        getrandom::fill(&mut seed).context("seeding the agent links' retries")?;
        Ok(Hub::start(HubConfig {
            tokens: Arc::new(tokens),
            tls: gateway_tls(self.agent_link_ca.as_deref())?,
            settings: compute_link::core::Settings {
                seed: u64::from_le_bytes(seed),
                ..compute_link::core::Settings::default()
            },
            timing: Timing::default(),
        }))
    }
}

/// What the host trusts a gateway's certificate by: `ca` alone, or the
/// system's authorities.
fn gateway_tls(ca: Option<&Path>) -> anyhow::Result<Arc<ClientConfig>> {
    let mut roots = RootCertStore::empty();
    if let Some(ca) = ca {
        for certificate in tls::certificates(ca)? {
            roots
                .add(certificate)
                .with_context(|| format!("trusting {}", ca.display()))?;
        }
    } else {
        let found = rustls_native_certs::load_native_certs();
        for error in &found.errors {
            tracing::warn!(%error, "could not read some of the system's authorities");
        }
        let (added, _) = roots.add_parsable_certificates(found.certs);
        anyhow::ensure!(
            added > 0,
            "the system trusts no authority to check gateways by"
        );
    }
    let config = ClientConfig::builder_with_provider(tls::provider())
        .with_safe_default_protocol_versions()
        .context("setting up TLS to the gateways")?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(config))
}

/// Asks the fleet service for the host's tokens.
struct FleetTokens {
    http: reqwest::Client,
    url: String,
    name: String,
}

impl Tokens for FleetTokens {
    fn token(&self, gateway: &str) -> BoxFuture<'static, Result<HostToken, String>> {
        let http = self.http.clone();
        let url = self.url.clone();
        let gateway = gateway.to_owned();
        let asked = LinkTokensAsked {
            name: self.name.clone(),
            gateways: vec![gateway.clone()],
        };
        Box::pin(async move {
            let response = http
                .post(&url)
                .timeout(TOKEN_TIMEOUT)
                .json(&asked)
                .send()
                .await
                .map_err(|error| format!("asking the fleet service for a link token: {error}"))?;
            let status = response.status();
            if !status.is_success() {
                return Err(format!("the fleet service gave no link token: {status}"));
            }
            let answer: LinkTokens = response
                .json()
                .await
                .map_err(|error| format!("reading the fleet service's link token: {error}"))?;
            answer
                .tokens
                .into_iter()
                .find(|token| token.gateway == gateway)
                .map(|token| HostToken {
                    token: token.token,
                    expires_at_ms: token.expires_at_ms,
                })
                .ok_or_else(|| "the fleet service gave no token for the gateway".to_owned())
        })
    }
}
