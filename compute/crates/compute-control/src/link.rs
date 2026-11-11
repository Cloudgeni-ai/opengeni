//! The agent link's tokens ([`docs/agent-link.md`](../../../docs/agent-link.md)
//! section 4): the fleet signs, with one Ed25519 key, a token for each
//! host to present to a gateway and a ticket for each sandbox it gives a
//! host. Opengeni checks both with the public keys [`Links::keys`] lists.
//!
//! Which gateway a team's sandboxes use is the fleet's configuration, never
//! part of a create, so a host never presents its token to an address a
//! tenant chose.

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;
use std::time::Duration;

use anyhow::Context as _;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use compute_protocol::fleet::LinkToken;
use ring::signature::{Ed25519KeyPair, KeyPair as _};
use rustls::pki_types::PrivateKeyDer;
use rustls::pki_types::pem::PemObject as _;
use serde::{Deserialize, Serialize};

/// How long a host token is valid.
pub const HOST_TOKEN_LIFE: Duration = Duration::from_secs(60 * 60);

/// The `typ` claim of a host token.
pub const HOST_TYPE: &str = "compute-host";
/// The `typ` claim of a sandbox ticket.
pub const SANDBOX_TYPE: &str = "compute-sandbox";

/// One public key, as a JSON Web Key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Jwk {
    pub kty: String,
    pub crv: String,
    pub kid: String,
    /// The key, base64url without padding.
    pub x: String,
}

/// What `GET /v1/link/keys` answers: the caller's team and the keys its
/// tokens may be signed with, the current one first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkKeys {
    pub team: String,
    pub keys: Vec<Jwk>,
}

/// A sandbox ticket's claims.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ticket {
    pub typ: String,
    pub iss: String,
    pub aud: String,
    /// The sandbox.
    pub sub: String,
    /// The host's name.
    pub host: String,
    /// The owner epoch the host holds the sandbox under.
    pub epoch: u64,
    pub team: String,
    pub workspace: String,
    pub agent: String,
}

/// A host token's claims.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostClaims {
    pub typ: String,
    pub iss: String,
    pub aud: String,
    /// The host's name.
    pub sub: String,
    pub iat: u64,
    pub exp: u64,
}

#[derive(Serialize)]
struct Header<'a> {
    alg: &'static str,
    typ: &'static str,
    kid: &'a str,
}

/// The fleet's signing key, the keys it signed with before, and each
/// team's gateway.
pub struct Links {
    key: Ed25519KeyPair,
    kid: String,
    /// Earlier keys, still listed so tokens they signed check until they
    /// expire.
    previous: Vec<Jwk>,
    issuer: String,
    teams: BTreeMap<String, String>,
}

impl fmt::Debug for Links {
    /// Never shows the key.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Links")
            .field("kid", &self.kid)
            .field("issuer", &self.issuer)
            .field("teams", &self.teams)
            .finish_non_exhaustive()
    }
}

/// The key id of a public key: the first 12 bytes of its BLAKE3 digest,
/// base64url.
fn kid_of(public: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(&blake3::hash(public).as_bytes()[..12])
}

fn jwk_of(public: &[u8]) -> Jwk {
    Jwk {
        kty: "OKP".into(),
        crv: "Ed25519".into(),
        kid: kid_of(public),
        x: URL_SAFE_NO_PAD.encode(public),
    }
}

/// The Ed25519 key in a PKCS#8 PEM file, as `openssl genpkey -algorithm
/// ed25519` writes one.
fn key_in(path: &Path) -> anyhow::Result<Ed25519KeyPair> {
    let key = PrivateKeyDer::from_pem_file(path)
        .with_context(|| format!("reading the key in {}", path.display()))?;
    let PrivateKeyDer::Pkcs8(der) = key else {
        anyhow::bail!("{} holds no PKCS#8 key", path.display());
    };
    Ed25519KeyPair::from_pkcs8_maybe_unchecked(der.secret_pkcs8_der())
        .map_err(|error| anyhow::anyhow!("{} holds no Ed25519 key: {error}", path.display()))
}

/// Whether `url` may be a gateway: `wss://`, or `ws://` for tests.
fn gateway_url(url: &str) -> bool {
    let rest = url
        .strip_prefix("wss://")
        .or_else(|| url.strip_prefix("ws://"));
    rest.is_some_and(|rest| !rest.is_empty() && !rest.contains(char::is_whitespace))
}

impl Links {
    /// Links signing with the PKCS#8 key `pkcs8`, listing the public keys of
    /// `previous` too, as `issuer`, for `teams` (team, gateway URL).
    ///
    /// # Errors
    ///
    /// When a key is no Ed25519 key or a gateway is no WebSocket URL.
    pub fn new(
        pkcs8: &[u8],
        previous: &[Vec<u8>],
        issuer: String,
        teams: BTreeMap<String, String>,
    ) -> anyhow::Result<Self> {
        let key = Ed25519KeyPair::from_pkcs8_maybe_unchecked(pkcs8)
            .map_err(|error| anyhow::anyhow!("the link key: {error}"))?;
        let previous = previous
            .iter()
            .map(|pkcs8| {
                Ed25519KeyPair::from_pkcs8_maybe_unchecked(pkcs8)
                    .map(|old| jwk_of(old.public_key().as_ref()))
                    .map_err(|error| anyhow::anyhow!("a previous link key: {error}"))
            })
            .collect::<anyhow::Result<_>>()?;
        Self::with_key(key, previous, issuer, teams)
    }

    /// As [`Self::new`], with the keys in PKCS#8 PEM files.
    ///
    /// # Errors
    ///
    /// As [`Self::new`], and when a file cannot be read.
    pub fn load(
        key: &Path,
        previous: &[impl AsRef<Path>],
        issuer: String,
        teams: BTreeMap<String, String>,
    ) -> anyhow::Result<Self> {
        let previous = previous
            .iter()
            .map(|path| key_in(path.as_ref()).map(|old| jwk_of(old.public_key().as_ref())))
            .collect::<anyhow::Result<_>>()?;
        Self::with_key(key_in(key)?, previous, issuer, teams)
    }

    fn with_key(
        key: Ed25519KeyPair,
        previous: Vec<Jwk>,
        issuer: String,
        teams: BTreeMap<String, String>,
    ) -> anyhow::Result<Self> {
        for (team, url) in &teams {
            anyhow::ensure!(
                gateway_url(url),
                "team {team}'s link {url:?} is no ws:// or wss:// URL"
            );
        }
        anyhow::ensure!(!issuer.is_empty(), "the link issuer is empty");
        let kid = kid_of(key.public_key().as_ref());
        Ok(Self {
            key,
            kid,
            previous,
            issuer,
            teams,
        })
    }

    /// The gateway `team`'s sandboxes use, if it has one.
    #[must_use]
    pub fn gateway(&self, team: &str) -> Option<&str> {
        self.teams.get(team).map(String::as_str)
    }

    /// Whether some team's sandboxes use `url`.
    #[must_use]
    pub fn knows(&self, url: &str) -> bool {
        self.teams.values().any(|gateway| gateway == url)
    }

    /// The public keys tokens may be signed with, the current one first.
    #[must_use]
    pub fn keys(&self) -> Vec<Jwk> {
        std::iter::once(jwk_of(self.key.public_key().as_ref()))
            .chain(self.previous.iter().cloned())
            .collect()
    }

    fn sign(&self, claims: &impl Serialize) -> String {
        let header = Header {
            alg: "EdDSA",
            typ: "JWT",
            kid: &self.kid,
        };
        // Serialising these structs cannot fail: they hold only strings
        // and numbers.
        let mut token = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap_or_default());
        token.push('.');
        token.push_str(&URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap_or_default()));
        let signature = self.key.sign(token.as_bytes());
        token.push('.');
        token.push_str(&URL_SAFE_NO_PAD.encode(signature.as_ref()));
        token
    }

    /// A token for host `host` to present to `gateway`, issued at `now_ms`.
    #[must_use]
    pub fn host_token(&self, gateway: &str, host: &str, now_ms: u64) -> LinkToken {
        let life = u64::try_from(HOST_TOKEN_LIFE.as_millis()).unwrap_or(u64::MAX);
        let expires_at_ms = now_ms.saturating_add(life);
        let claims = HostClaims {
            typ: HOST_TYPE.into(),
            iss: self.issuer.clone(),
            aud: gateway.into(),
            sub: host.into(),
            iat: now_ms / 1000,
            exp: expires_at_ms / 1000,
        };
        LinkToken {
            gateway: gateway.into(),
            token: self.sign(&claims),
            expires_at_ms,
        }
    }

    /// The ticket for a sandbox of `team` held by `host` under `epoch`, for
    /// the team's gateway; `None` when the team has none. It holds no time,
    /// so the same placement always gives the same ticket.
    #[must_use]
    pub fn ticket(
        &self,
        team: &str,
        sandbox: &str,
        host: &str,
        epoch: u64,
        agent: &crate::store::AgentRef,
    ) -> Option<compute_protocol::link::AgentLink> {
        let gateway = self.gateway(team)?;
        let claims = Ticket {
            typ: SANDBOX_TYPE.into(),
            iss: self.issuer.clone(),
            aud: gateway.into(),
            sub: sandbox.into(),
            host: host.into(),
            epoch,
            team: team.into(),
            workspace: agent.workspace.clone(),
            agent: agent.agent.clone(),
        };
        Some(compute_protocol::link::AgentLink {
            gateway: gateway.into(),
            ticket: self.sign(&claims),
        })
    }
}

#[cfg(test)]
mod tests {
    use ring::rand::SystemRandom;
    use ring::signature::{ED25519, UnparsedPublicKey};

    use super::*;
    use crate::store::AgentRef;

    fn new_key() -> Vec<u8> {
        Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .unwrap()
            .as_ref()
            .to_vec()
    }

    fn links(previous: &[Vec<u8>]) -> Links {
        Links::new(
            &new_key(),
            previous,
            "fleet".into(),
            BTreeMap::from([("team".into(), "wss://og.example/link".into())]),
        )
        .unwrap()
    }

    /// Checks `token` against `keys` as a gateway would, and gives its
    /// claims.
    fn verify<T: serde::de::DeserializeOwned>(token: &str, keys: &[Jwk]) -> T {
        let (signed, signature) = token.rsplit_once('.').unwrap();
        let (header, claims) = signed.split_once('.').unwrap();
        let header: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).unwrap()).unwrap();
        assert_eq!(header["alg"], "EdDSA");
        let key = keys.iter().find(|key| key.kid == header["kid"]).unwrap();
        UnparsedPublicKey::new(&ED25519, URL_SAFE_NO_PAD.decode(&key.x).unwrap())
            .verify(
                signed.as_bytes(),
                &URL_SAFE_NO_PAD.decode(signature).unwrap(),
            )
            .unwrap();
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(claims).unwrap()).unwrap()
    }

    #[test]
    fn tickets_check_with_the_listed_key_and_never_change() {
        let links = links(&[]);
        let agent = AgentRef {
            workspace: "w".into(),
            agent: "a".into(),
        };
        let link = links.ticket("team", "s1", "h1", 3, &agent).unwrap();
        assert_eq!(link.gateway, "wss://og.example/link");
        let again = links.ticket("team", "s1", "h1", 3, &agent).unwrap();
        assert_eq!(link, again, "a retried create must stay identical");
        let ticket: Ticket = verify(&link.ticket, &links.keys());
        assert_eq!(
            ticket,
            Ticket {
                typ: SANDBOX_TYPE.into(),
                iss: "fleet".into(),
                aud: "wss://og.example/link".into(),
                sub: "s1".into(),
                host: "h1".into(),
                epoch: 3,
                team: "team".into(),
                workspace: "w".into(),
                agent: "a".into(),
            }
        );
        assert_ne!(
            links.ticket("team", "s1", "h1", 4, &agent).unwrap().ticket,
            link.ticket
        );
        assert!(links.ticket("other", "s1", "h1", 3, &agent).is_none());
    }

    #[test]
    fn host_tokens_expire_in_an_hour() {
        let old = new_key();
        let links = links(std::slice::from_ref(&old));
        let keys = links.keys();
        assert_eq!(keys.len(), 2);
        assert_ne!(keys[0].kid, keys[1].kid);
        let token = links.host_token("wss://og.example/link", "h1", 1_000_000);
        assert_eq!(token.expires_at_ms, 1_000_000 + 3_600_000);
        let claims: HostClaims = verify(&token.token, &keys);
        assert_eq!((claims.iat, claims.exp), (1000, 4600));
        assert_eq!(claims.sub, "h1");
        assert_eq!(claims.typ, HOST_TYPE);
        assert!(links.knows("wss://og.example/link"));
        assert!(!links.knows("wss://elsewhere"));
        assert!(!format!("{links:?}").contains("PRIVATE"));
    }

    #[test]
    fn gateways_must_be_websockets() {
        for bad in ["https://x", "wss://", "x", "wss://a b"] {
            assert!(
                Links::new(
                    &new_key(),
                    &[],
                    "fleet".into(),
                    BTreeMap::from([("t".into(), bad.into())])
                )
                .is_err(),
                "{bad}"
            );
        }
        assert!(Links::new(&[1, 2, 3], &[], "fleet".into(), BTreeMap::new()).is_err());
    }
}
