//! Google Compute Engine instance identity tokens: how a host on Google
//! Cloud proves which instance it is when it asks for its certificate
//! ([`hostapi`](crate::hostapi)).
//!
//! A host reads a token for the service's host URL from its metadata server
//! (`instance/service-accounts/default/identity?audience=<url>&format=full`).
//! Google signs it (RS256) with keys it publishes as a JWKS. The service
//! takes the instance's name from a token only when Google signed it, it
//! is for this service, it is current, and it was given to an instance of
//! the fleet's project running as the hosts' account: so an instance can
//! get a certificate for its own name and no other.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Context as _;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures::future::BoxFuture;
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents};
use serde::Deserialize;
use tokio::time::Instant;

/// Where Google publishes the keys it signs identity tokens with.
pub const GOOGLE_KEYS: &str = "https://www.googleapis.com/oauth2/v3/certs";
/// The issuers Google's tokens name.
const ISSUERS: [&str; 2] = ["accounts.google.com", "https://accounts.google.com"];
/// How far the service's clock and Google's may disagree.
const LEEWAY: Duration = Duration::from_secs(60);
/// The keys are fetched at most this often, however many tokens name a
/// key the service does not know.
pub const REFETCH_EVERY: Duration = Duration::from_secs(60);
/// How long fetched keys are used when their answer says nothing.
const KEYS_FOR: Duration = Duration::from_secs(60 * 60);
/// How long fetching the keys may take.
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// What a token must say to name a host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Expected {
    /// The audience the host asked its token for: the service's host URL.
    pub audience: String,
    /// The project the hosts run in.
    pub project: String,
    /// The service account the hosts run as.
    pub account: String,
}

/// One of Google's keys, as a JWKS lists it.
#[derive(Clone, Debug, Deserialize)]
pub struct Jwk {
    pub kid: String,
    pub kty: String,
    #[serde(default)]
    pub alg: Option<String>,
    pub n: String,
    pub e: String,
}

/// A JWKS.
#[derive(Clone, Debug, Deserialize)]
pub struct Jwks {
    pub keys: Vec<Jwk>,
}

/// Keys as fetched, and how long the answer says they may be used.
#[derive(Clone, Debug)]
pub struct Fetched {
    pub keys: Jwks,
    pub fresh_for: Duration,
}

/// Where the keys come from.
pub trait KeySource: Send + Sync {
    fn fetch(&self) -> BoxFuture<'_, anyhow::Result<Fetched>>;
}

/// Google's keys, fetched over HTTPS.
#[derive(Debug)]
pub struct GoogleKeys {
    http: reqwest::Client,
    url: String,
}

impl GoogleKeys {
    pub fn new(url: &str) -> anyhow::Result<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .https_only(url.starts_with("https://"))
                .timeout(FETCH_TIMEOUT)
                .build()
                .context("building the client for Google's keys")?,
            url: url.to_owned(),
        })
    }
}

/// The `max-age` of a `Cache-Control` value.
fn max_age(cache_control: &str) -> Option<Duration> {
    cache_control.split(',').find_map(|directive| {
        let (name, value) = directive.trim().split_once('=')?;
        (name.trim().eq_ignore_ascii_case("max-age"))
            .then(|| value.trim().trim_matches('"').parse().ok())
            .flatten()
            .map(Duration::from_secs)
    })
}

impl KeySource for GoogleKeys {
    fn fetch(&self) -> BoxFuture<'_, anyhow::Result<Fetched>> {
        Box::pin(async move {
            let response = self
                .http
                .get(&self.url)
                .send()
                .await
                .with_context(|| format!("fetching {}", self.url))?
                .error_for_status()
                .with_context(|| format!("fetching {}", self.url))?;
            let fresh_for = response
                .headers()
                .get(reqwest::header::CACHE_CONTROL)
                .and_then(|value| value.to_str().ok())
                .and_then(max_age)
                .unwrap_or(KEYS_FOR);
            let keys = response
                .json()
                .await
                .with_context(|| format!("reading {}", self.url))?;
            Ok(Fetched { keys, fresh_for })
        })
    }
}

/// Why a token names no host.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Refused {
    #[error("not an identity token: {0}")]
    Malformed(String),
    #[error("the token is signed with {0:?}, not RS256")]
    Algorithm(String),
    #[error("the token is signed with a key Google does not list: {0:?}")]
    UnknownKey(String),
    #[error("Google's keys cannot be had: {0}")]
    Keys(String),
    #[error(
        "Google's keys the service holds are past their expiry and could not be fetched again yet: {0}"
    )]
    StaleKeys(String),
    #[error("the token's signature is not Google's")]
    Signature,
    #[error("the token is not for a host of this fleet: {0}")]
    Claim(String),
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    #[serde(default)]
    kid: Option<String>,
}

#[derive(Deserialize)]
struct Claims {
    iss: String,
    aud: String,
    exp: u64,
    iat: u64,
    #[serde(default)]
    nbf: Option<u64>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    email_verified: Option<bool>,
    #[serde(default)]
    google: Option<Google>,
}

#[derive(Deserialize)]
struct Google {
    #[serde(default)]
    compute_engine: Option<ComputeEngine>,
}

#[derive(Deserialize)]
struct ComputeEngine {
    project_id: String,
    instance_name: String,
}

#[derive(Default)]
struct Cache {
    keys: HashMap<String, RsaPublicKeyComponents<Vec<u8>>>,
    /// Until when `keys` may be used: their answer's `Cache-Control`
    /// expiry. Past it, only a successful fetch makes keys usable again.
    fresh_until: Option<Instant>,
    fetched_at: Option<Instant>,
    /// Why the last fetch failed, while no fetch has succeeded since.
    failed: Option<String>,
}

/// Checks identity tokens against what [`Expected`] says.
pub struct GceIdentity {
    expected: Expected,
    source: Arc<dyn KeySource>,
    cache: tokio::sync::Mutex<Cache>,
}

impl std::fmt::Debug for GceIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GceIdentity")
            .field("expected", &self.expected)
            .finish_non_exhaustive()
    }
}

fn decoded(part: &str, what: &str) -> Result<Vec<u8>, Refused> {
    URL_SAFE_NO_PAD
        .decode(part)
        .map_err(|error| Refused::Malformed(format!("its {what}: {error}")))
}

fn components(key: &Jwk) -> Option<RsaPublicKeyComponents<Vec<u8>>> {
    if key.kty != "RSA" || key.alg.as_deref().is_some_and(|alg| alg != "RS256") {
        return None;
    }
    Some(RsaPublicKeyComponents {
        n: URL_SAFE_NO_PAD.decode(&key.n).ok()?,
        e: URL_SAFE_NO_PAD.decode(&key.e).ok()?,
    })
}

fn seconds(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

impl GceIdentity {
    #[must_use]
    pub fn new(expected: Expected, source: Arc<dyn KeySource>) -> Self {
        Self {
            expected,
            source,
            cache: tokio::sync::Mutex::new(Cache::default()),
        }
    }

    /// The instance name `token` proves, at `now`.
    pub async fn verify(&self, token: &str, now: SystemTime) -> Result<String, Refused> {
        let mut parts = token.trim().split('.');
        let (Some(header), Some(payload), Some(signature), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(Refused::Malformed("not three parts".into()));
        };
        let parsed: Header = serde_json::from_slice(&decoded(header, "header")?)
            .map_err(|error| Refused::Malformed(format!("its header: {error}")))?;
        if parsed.alg != "RS256" {
            return Err(Refused::Algorithm(parsed.alg));
        }
        let kid = parsed
            .kid
            .ok_or_else(|| Refused::Malformed("its header names no key".into()))?;
        let key = self.key(&kid).await?;
        let signed = &token.trim()[..header.len() + 1 + payload.len()];
        key.verify(
            &RSA_PKCS1_2048_8192_SHA256,
            signed.as_bytes(),
            &decoded(signature, "signature")?,
        )
        .map_err(|_| Refused::Signature)?;
        let claims: Claims = serde_json::from_slice(&decoded(payload, "claims")?)
            .map_err(|error| Refused::Malformed(format!("its claims: {error}")))?;
        self.name(&claims, seconds(now))
    }

    /// The instance name `claims` give, if they are for this fleet at
    /// `now` (seconds since the Unix epoch).
    fn name(&self, claims: &Claims, now: u64) -> Result<String, Refused> {
        let refused = |what: String| Err(Refused::Claim(what));
        let leeway = LEEWAY.as_secs();
        if !ISSUERS.contains(&claims.iss.as_str()) {
            return refused(format!("issued by {:?}, not Google", claims.iss));
        }
        if claims.aud != self.expected.audience {
            return refused(format!(
                "its audience is {:?}, not {:?}",
                claims.aud, self.expected.audience
            ));
        }
        if claims.exp.saturating_add(leeway) <= now {
            return refused("it has expired".into());
        }
        if claims.iat > now.saturating_add(leeway) {
            return refused("it is issued in the future".into());
        }
        if claims
            .nbf
            .is_some_and(|nbf| nbf > now.saturating_add(leeway))
        {
            return refused("it is not valid yet".into());
        }
        if claims.email.as_deref() != Some(self.expected.account.as_str())
            || claims.email_verified == Some(false)
        {
            return refused(format!(
                "it is for the account {:?}, not the hosts' {:?}",
                claims.email.as_deref().unwrap_or(""),
                self.expected.account
            ));
        }
        let Some(instance) = claims
            .google
            .as_ref()
            .and_then(|google| google.compute_engine.as_ref())
        else {
            return refused("it names no instance (ask for format=full)".into());
        };
        if instance.project_id != self.expected.project {
            return refused(format!(
                "its instance is in the project {:?}, not {:?}",
                instance.project_id, self.expected.project
            ));
        }
        if instance.instance_name.is_empty() {
            return refused("its instance has no name".into());
        }
        Ok(instance.instance_name.clone())
    }

    /// The key `kid`, fetching Google's keys when the ones held are stale
    /// or do not have it, at most once every [`REFETCH_EVERY`].
    ///
    /// Keys are used only until their answer's expiry: past it, a failed
    /// or not yet allowed fetch leaves no key usable (fail closed), and
    /// only a successful fetch makes keys usable again. Hosts retry, so
    /// an outage of Google's keys only delays their certificates.
    async fn key(&self, kid: &str) -> Result<RsaPublicKeyComponents<Vec<u8>>, Refused> {
        let mut cache = self.cache.lock().await;
        let now = Instant::now();
        let stale = cache.fresh_until.is_none_or(|until| now >= until);
        let may_fetch = cache
            .fetched_at
            .is_none_or(|at| now.duration_since(at) >= REFETCH_EVERY);
        let mut fetched = false;
        if may_fetch && (stale || !cache.keys.contains_key(kid)) {
            cache.fetched_at = Some(now);
            match self.source.fetch().await {
                Ok(answer) => {
                    cache.keys = answer
                        .keys
                        .keys
                        .iter()
                        .filter_map(|key| Some((key.kid.clone(), components(key)?)))
                        .collect();
                    cache.fresh_until = Some(now + answer.fresh_for);
                    cache.failed = None;
                    fetched = true;
                }
                Err(error) => {
                    tracing::warn!(error = %format!("{error:#}"), "fetching Google's keys failed");
                    cache.failed = Some(format!("{error:#}"));
                }
            }
        }
        // Usable: fresh by their expiry, or just fetched (an answer whose
        // expiry is now still serves the token that fetched it).
        let usable = fetched || cache.fresh_until.is_some_and(|until| now < until);
        if !usable {
            return Err(match &cache.failed {
                Some(error) if cache.fresh_until.is_none() => Refused::Keys(error.clone()),
                Some(error) => Refused::StaleKeys(error.clone()),
                None => Refused::StaleKeys(format!(
                    "the next fetch is allowed {} s after the last",
                    REFETCH_EVERY.as_secs()
                )),
            });
        }
        match cache.keys.get(kid) {
            Some(key) => Ok(RsaPublicKeyComponents {
                n: key.n.clone(),
                e: key.e.clone(),
            }),
            None => match &cache.failed {
                Some(error) => Err(Refused::Keys(error.clone())),
                None => Err(Refused::UnknownKey(kid.to_owned())),
            },
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use ring::rand::SystemRandom;
    use ring::signature::{RSA_PKCS1_SHA256, RsaKeyPair};
    use serde_json::{Value, json};

    use super::*;

    /// A key made for these tests alone, an RSA private key (PKCS#1 DER) in
    /// base64: it signs nothing else.
    const SIGNER: &str = include_str!("testdata/token-signer.rsa.b64");

    pub(crate) const AUDIENCE: &str = "https://control.example:8443";
    pub(crate) const PROJECT: &str = "fleet-project";
    pub(crate) const ACCOUNT: &str = "hosts@fleet-project.iam.gserviceaccount.com";

    /// Signs tokens as Google would, and serves its key.
    pub(crate) struct Google {
        signer: RsaKeyPair,
        pub(crate) kid: String,
        pub(crate) fetches: Arc<AtomicUsize>,
    }

    impl Google {
        pub(crate) fn new() -> Self {
            let der = base64::engine::general_purpose::STANDARD
                .decode(SIGNER.split_whitespace().collect::<String>())
                .unwrap();
            Self {
                signer: RsaKeyPair::from_der(&der).unwrap(),
                kid: "key-1".into(),
                fetches: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn jwk(&self, kid: &str) -> Jwk {
            let public: RsaPublicKeyComponents<Vec<u8>> = self.signer.public().into();
            Jwk {
                kid: kid.into(),
                kty: "RSA".into(),
                alg: Some("RS256".into()),
                n: URL_SAFE_NO_PAD.encode(public.n),
                e: URL_SAFE_NO_PAD.encode(public.e),
            }
        }

        /// What the keys endpoint serves: this signer's key as `kid`.
        pub(crate) fn source(&self) -> Arc<dyn KeySource> {
            Arc::new(Served {
                keys: Jwks {
                    keys: vec![self.jwk(&self.kid)],
                },
                fetches: Arc::clone(&self.fetches),
            })
        }

        pub(crate) fn sign(&self, header: &Value, claims: &Value) -> String {
            let signed = format!(
                "{}.{}",
                URL_SAFE_NO_PAD.encode(header.to_string()),
                URL_SAFE_NO_PAD.encode(claims.to_string())
            );
            let mut signature = vec![0; self.signer.public().modulus_len()];
            self.signer
                .sign(
                    &RSA_PKCS1_SHA256,
                    &SystemRandom::new(),
                    signed.as_bytes(),
                    &mut signature,
                )
                .unwrap();
            format!("{signed}.{}", URL_SAFE_NO_PAD.encode(signature))
        }

        /// A token for `instance` as the metadata server gives it.
        pub(crate) fn token(&self, instance: &str) -> String {
            self.sign(
                &self.header(),
                &claims(instance, seconds(SystemTime::now())),
            )
        }

        pub(crate) fn header(&self) -> Value {
            json!({"alg": "RS256", "kid": self.kid, "typ": "JWT"})
        }
    }

    pub(crate) fn claims(instance: &str, now: u64) -> Value {
        json!({
            "iss": "https://accounts.google.com",
            "aud": AUDIENCE,
            "azp": "1234567890",
            "sub": "1234567890",
            "email": ACCOUNT,
            "email_verified": true,
            "iat": now,
            "exp": now + 3600,
            "google": {"compute_engine": {
                "project_id": PROJECT,
                "project_number": 42,
                "zone": "europe-west4-a",
                "instance_id": "987654321",
                "instance_name": instance,
                "instance_creation_timestamp": now - 600,
            }},
        })
    }

    struct Served {
        keys: Jwks,
        fetches: Arc<AtomicUsize>,
    }

    impl KeySource for Served {
        fn fetch(&self) -> BoxFuture<'_, anyhow::Result<Fetched>> {
            self.fetches.fetch_add(1, Ordering::SeqCst);
            let keys = self.keys.clone();
            Box::pin(async move {
                Ok(Fetched {
                    keys,
                    fresh_for: Duration::from_secs(3600),
                })
            })
        }
    }

    pub(crate) fn expected() -> Expected {
        Expected {
            audience: AUDIENCE.into(),
            project: PROJECT.into(),
            account: ACCOUNT.into(),
        }
    }

    fn identity(google: &Google) -> GceIdentity {
        GceIdentity::new(expected(), google.source())
    }

    #[tokio::test]
    async fn a_token_google_signed_for_this_fleet_names_its_instance() {
        let google = Google::new();
        let identity = identity(&google);
        let name = identity
            .verify(&google.token("host-1"), SystemTime::now())
            .await;
        assert_eq!(name, Ok("host-1".to_owned()));
        // Either form of Google's issuer.
        let now = seconds(SystemTime::now());
        let mut claims = claims("host-2", now);
        claims["iss"] = "accounts.google.com".into();
        let token = google.sign(&google.header(), &claims);
        assert_eq!(
            identity.verify(&token, SystemTime::now()).await,
            Ok("host-2".into())
        );
        assert_eq!(google.fetches.load(Ordering::SeqCst), 1, "keys are kept");
    }

    type Change = Box<dyn Fn(&mut Value)>;

    #[tokio::test]
    async fn a_token_for_anything_else_names_no_instance() {
        let google = Google::new();
        let identity = identity(&google);
        let now = seconds(SystemTime::now());
        let cases: Vec<(&str, Change)> = vec![
            (
                "another audience",
                Box::new(|c| c["aud"] = "https://elsewhere.example:8443".into()),
            ),
            (
                "the audience as a prefix",
                Box::new(|c| c["aud"] = "https://control.example:8443/x".into()),
            ),
            (
                "another issuer",
                Box::new(|c| c["iss"] = "https://issuer.example".into()),
            ),
            (
                "another project",
                Box::new(|c| c["google"]["compute_engine"]["project_id"] = "other-project".into()),
            ),
            (
                "another account",
                Box::new(|c| c["email"] = "other@fleet-project.iam.gserviceaccount.com".into()),
            ),
            (
                "no account",
                Box::new(|c| {
                    c.as_object_mut().unwrap().remove("email");
                }),
            ),
            (
                "an unverified account",
                Box::new(|c| c["email_verified"] = false.into()),
            ),
            (
                "no instance",
                Box::new(|c| {
                    c.as_object_mut().unwrap().remove("google");
                }),
            ),
            ("expired", Box::new(move |c| c["exp"] = (now - 61).into())),
            (
                "issued in the future",
                Box::new(move |c| c["iat"] = (now + 120).into()),
            ),
            (
                "not valid yet",
                Box::new(move |c| c["nbf"] = (now + 120).into()),
            ),
        ];
        for (what, change) in cases {
            let mut claims = claims("host-1", now);
            change(&mut claims);
            let token = google.sign(&google.header(), &claims);
            let refused = identity.verify(&token, SystemTime::now()).await;
            assert!(
                matches!(refused, Err(Refused::Claim(_) | Refused::Malformed(_))),
                "{what}: {refused:?}"
            );
        }
        // Within the leeway, either way.
        let mut claims = claims("host-1", now);
        claims["exp"] = (now - 30).into();
        claims["iat"] = (now + 30).into();
        claims["nbf"] = (now + 30).into();
        let token = google.sign(&google.header(), &claims);
        assert!(identity.verify(&token, SystemTime::now()).await.is_ok());
    }

    #[tokio::test]
    async fn only_rs256_tokens_with_googles_signature_count() {
        let google = Google::new();
        let identity = identity(&google);
        let token = google.token("host-1");
        // A claim changed after signing.
        let (signed, signature) = token.rsplit_once('.').unwrap();
        let (header, _) = signed.split_once('.').unwrap();
        let forged =
            URL_SAFE_NO_PAD.encode(claims("host-2", seconds(SystemTime::now())).to_string());
        assert_eq!(
            identity
                .verify(&format!("{header}.{forged}.{signature}"), SystemTime::now())
                .await,
            Err(Refused::Signature)
        );
        // A signature changed.
        let mut bytes = URL_SAFE_NO_PAD.decode(signature).unwrap();
        bytes[10] ^= 1;
        let tampered = format!("{signed}.{}", URL_SAFE_NO_PAD.encode(bytes));
        assert_eq!(
            identity.verify(&tampered, SystemTime::now()).await,
            Err(Refused::Signature)
        );
        // Another algorithm, however the token is signed.
        for alg in ["HS256", "none", "RS512", "ES256"] {
            let header = json!({"alg": alg, "kid": google.kid});
            let token = google.sign(&header, &claims("host-1", seconds(SystemTime::now())));
            assert_eq!(
                identity.verify(&token, SystemTime::now()).await,
                Err(Refused::Algorithm(alg.into()))
            );
        }
        for malformed in ["", "a.b", "a.b.c.d", "!!.!!.!!"] {
            assert!(matches!(
                identity.verify(malformed, SystemTime::now()).await,
                Err(Refused::Malformed(_))
            ));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_key_google_does_not_list_fetches_its_keys_again_at_most_once_a_minute() {
        let google = Google::new();
        let identity = identity(&google);
        assert!(
            identity
                .verify(&google.token("host-1"), SystemTime::now())
                .await
                .is_ok()
        );
        assert_eq!(google.fetches.load(Ordering::SeqCst), 1);
        let unknown = || {
            let header = json!({"alg": "RS256", "kid": "key-2"});
            google.sign(&header, &claims("host-1", seconds(SystemTime::now())))
        };
        // Within the minute after a fetch, no fetch however many ask.
        for _ in 0..5 {
            assert_eq!(
                identity.verify(&unknown(), SystemTime::now()).await,
                Err(Refused::UnknownKey("key-2".into()))
            );
        }
        assert_eq!(google.fetches.load(Ordering::SeqCst), 1);
        tokio::time::advance(REFETCH_EVERY).await;
        for _ in 0..5 {
            assert!(
                identity
                    .verify(&unknown(), SystemTime::now())
                    .await
                    .is_err()
            );
        }
        assert_eq!(google.fetches.load(Ordering::SeqCst), 2, "one more fetch");
        // Known keys need none while they are fresh.
        tokio::time::advance(REFETCH_EVERY).await;
        assert!(
            identity
                .verify(&google.token("host-1"), SystemTime::now())
                .await
                .is_ok()
        );
        assert_eq!(google.fetches.load(Ordering::SeqCst), 2);
        // Stale keys are fetched again.
        tokio::time::advance(Duration::from_secs(3600)).await;
        assert!(
            identity
                .verify(&google.token("host-1"), SystemTime::now())
                .await
                .is_ok()
        );
        assert_eq!(google.fetches.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn cache_control_gives_how_long_keys_are_fresh() {
        assert_eq!(
            max_age("public, max-age=19437, must-revalidate, no-transform"),
            Some(Duration::from_secs(19437))
        );
        assert_eq!(max_age("no-cache"), None);
        assert_eq!(max_age("max-age=x"), None);
    }

    /// Serves the signer's key, or fails, as the test says.
    struct Flaky {
        keys: Jwks,
        failing: Arc<std::sync::atomic::AtomicBool>,
        fetches: Arc<AtomicUsize>,
    }

    impl KeySource for Flaky {
        fn fetch(&self) -> BoxFuture<'_, anyhow::Result<Fetched>> {
            self.fetches.fetch_add(1, Ordering::SeqCst);
            let failing = self.failing.load(Ordering::SeqCst);
            let keys = self.keys.clone();
            Box::pin(async move {
                anyhow::ensure!(!failing, "Google's keys answered 503");
                Ok(Fetched {
                    keys,
                    fresh_for: Duration::from_secs(3600),
                })
            })
        }
    }

    #[tokio::test(start_paused = true)]
    async fn keys_past_their_expiry_count_only_once_fetched_again() {
        let google = Google::new();
        let failing = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let fetches = Arc::new(AtomicUsize::new(0));
        let identity = GceIdentity::new(
            expected(),
            Arc::new(Flaky {
                keys: Jwks {
                    keys: vec![google.jwk(&google.kid)],
                },
                failing: Arc::clone(&failing),
                fetches: Arc::clone(&fetches),
            }),
        );
        let verify = || async {
            identity
                .verify(&google.token("host-1"), SystemTime::now())
                .await
        };
        assert_eq!(verify().await, Ok("host-1".into()));
        // Google's keys fail from now on. While the keys held are fresh
        // they are used, with no fetch (the negative control).
        failing.store(true, Ordering::SeqCst);
        tokio::time::advance(Duration::from_secs(3599)).await;
        assert_eq!(verify().await, Ok("host-1".into()));
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
        // Past their expiry, a failed fetch leaves none usable, and so does
        // a fetch not allowed yet.
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(
            matches!(verify().await, Err(Refused::StaleKeys(_))),
            "a failed fetch"
        );
        assert_eq!(fetches.load(Ordering::SeqCst), 2);
        assert!(
            matches!(verify().await, Err(Refused::StaleKeys(_))),
            "within the minute"
        );
        assert_eq!(fetches.load(Ordering::SeqCst), 2);
        tokio::time::advance(REFETCH_EVERY).await;
        assert!(matches!(verify().await, Err(Refused::StaleKeys(_))));
        assert_eq!(fetches.load(Ordering::SeqCst), 3);
        // Once a fetch succeeds, the keys count again.
        failing.store(false, Ordering::SeqCst);
        assert!(matches!(verify().await, Err(Refused::StaleKeys(_))));
        tokio::time::advance(REFETCH_EVERY).await;
        assert_eq!(verify().await, Ok("host-1".into()));
        assert_eq!(fetches.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn with_no_keys_ever_fetched_a_failed_fetch_names_the_failure() {
        let google = Google::new();
        let identity = GceIdentity::new(
            expected(),
            Arc::new(Flaky {
                keys: Jwks { keys: vec![] },
                failing: Arc::new(std::sync::atomic::AtomicBool::new(true)),
                fetches: Arc::new(AtomicUsize::new(0)),
            }),
        );
        assert!(matches!(
            identity
                .verify(&google.token("host-1"), SystemTime::now())
                .await,
            Err(Refused::Keys(_))
        ));
    }
}
