//! Credentials: a token, or a GitHub App installation, whose tokens are
//! bought with a JSON Web Token the App's key signs.

use std::fmt;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, bail};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::rand::SystemRandom;
use ring::signature::{RSA_PKCS1_SHA256, RsaKeyPair};
use serde::Deserialize;
use tokio::sync::Mutex;

use super::{REFRESH_BEFORE, USER_AGENT};

/// How GitHub is called.
pub enum Credentials {
    /// A token with admin rights on the scope (a fine-grained or classic
    /// personal token).
    Token(String),
    App(Box<App>),
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Token(_) => f.write_str("Token(..)"),
            Self::App(app) => f
                .debug_struct("App")
                .field("id", &app.id)
                .field("installation", &app.installation)
                .finish_non_exhaustive(),
        }
    }
}

impl Credentials {
    pub(super) async fn token(&self, http: &reqwest::Client, api: &str) -> Result<String> {
        match self {
            Self::Token(token) => Ok(token.clone()),
            Self::App(app) => app.token(http, api).await,
        }
    }
}

/// A GitHub App installation.
pub struct App {
    /// The App's id or client id, which its JSON Web Tokens are issued by.
    id: String,
    installation: u64,
    key: RsaKeyPair,
    token: Mutex<Option<(String, SystemTime)>>,
}

impl fmt::Debug for App {
    /// Never shows the key or a token.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("App")
            .field("id", &self.id)
            .field("installation", &self.installation)
            .finish_non_exhaustive()
    }
}

impl App {
    /// The App `id`, installation `installation`, and its private key in
    /// PEM (PKCS #1, as GitHub gives it, or PKCS #8).
    pub fn new(id: &str, installation: u64, key_pem: &str) -> Result<Self> {
        let pem = pem::parse(key_pem).context("the App's private key is not PEM")?;
        let key = match pem.tag() {
            "RSA PRIVATE KEY" => RsaKeyPair::from_der(pem.contents()),
            "PRIVATE KEY" => RsaKeyPair::from_pkcs8(pem.contents()),
            other => bail!("the App's private key is a {other:?}, not an RSA private key"),
        }
        .map_err(|error| anyhow::anyhow!("the App's private key: {error}"))?;
        Ok(Self {
            id: id.into(),
            installation,
            key,
            token: Mutex::new(None),
        })
    }

    /// A JSON Web Token for the App, good for nine minutes (GitHub takes at
    /// most ten), dated a minute back for clocks that differ.
    fn jwt(&self, now: SystemTime) -> Result<String> {
        let now = now.duration_since(UNIX_EPOCH)?.as_secs();
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
        let claims = URL_SAFE_NO_PAD.encode(
            serde_json::json!({"iat": now - 60, "exp": now + 540, "iss": self.id}).to_string(),
        );
        let signed = format!("{header}.{claims}");
        let mut signature = vec![0; self.key.public().modulus_len()];
        self.key
            .sign(
                &RSA_PKCS1_SHA256,
                &SystemRandom::new(),
                signed.as_bytes(),
                &mut signature,
            )
            .map_err(|_| anyhow::anyhow!("signing the App's token failed"))?;
        Ok(format!("{signed}.{}", URL_SAFE_NO_PAD.encode(signature)))
    }

    async fn token(&self, http: &reqwest::Client, api: &str) -> Result<String> {
        #[derive(Deserialize)]
        struct Installation {
            token: String,
            expires_at: String,
        }
        let mut token = self.token.lock().await;
        if let Some((current, ends)) = &*token
            && SystemTime::now() + REFRESH_BEFORE * 5 < *ends
        {
            return Ok(current.clone());
        }
        let response = http
            .post(format!(
                "{api}/app/installations/{}/access_tokens",
                self.installation
            ))
            .bearer_auth(self.jwt(SystemTime::now())?)
            .header("accept", "application/vnd.github+json")
            .header("user-agent", USER_AGENT)
            .send()
            .await?;
        let fresh: Installation = super::expect(
            response,
            reqwest::StatusCode::CREATED,
            "an installation token",
        )
        .await?;
        // An hour, as GitHub gives them; the time it names is only read to
        // end earlier.
        let ends = parse_time(&fresh.expires_at)
            .unwrap_or_else(|| SystemTime::now() + Duration::from_secs(3600));
        *token = Some((fresh.token.clone(), ends));
        Ok(fresh.token)
    }
}

/// When a JSON Web Token ends, from its `exp` (read, never verified: it is
/// GitHub's token for GitHub).
pub(super) fn jwt_ends(token: &str) -> Result<SystemTime> {
    #[derive(Deserialize)]
    struct Claims {
        exp: u64,
    }
    let claims = token
        .split('.')
        .nth(1)
        .context("the actions service's token is not a JSON Web Token")?;
    let claims: Claims = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(claims.trim_end_matches('='))
            .context("the actions service's token")?,
    )
    .context("the actions service's token names no end")?;
    Ok(UNIX_EPOCH + Duration::from_secs(claims.exp))
}

/// `2026-10-27T09:30:00Z`, as GitHub writes times.
fn parse_time(text: &str) -> Option<SystemTime> {
    let text = text.strip_suffix('Z')?;
    let (date, time) = text.split_once('T')?;
    let mut date = date.split('-').map(str::parse::<i64>);
    let (year, month, day) = (date.next()?.ok()?, date.next()?.ok()?, date.next()?.ok()?);
    let mut time = time.split(':').map(str::parse::<i64>);
    let (hour, minute, second) = (time.next()?.ok()?, time.next()?.ok()?, time.next()?.ok()?);
    // Days from 1970-01-01 to the date (Howard Hinnant's days_from_civil).
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let of_era = year - era * 400;
    let of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let of_cycle = of_era * 365 + of_era / 4 - of_era / 100 + of_year;
    let days = era * 146_097 + of_cycle - 719_468;
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second;
    Some(UNIX_EPOCH + Duration::from_secs(u64::try_from(seconds).ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_times_are_read() {
        let at = |text| {
            parse_time(text)
                .unwrap()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs()
        };
        assert_eq!(at("1970-01-01T00:00:00Z"), 0);
        assert_eq!(at("2000-03-01T00:00:01Z"), 951_868_801);
        assert_eq!(at("2026-10-27T09:30:00Z"), 1_793_093_400);
        assert!(parse_time("2026-10-27 09:30:00").is_none());
    }

    #[test]
    fn a_token_ends_when_its_claims_say() {
        let claims = URL_SAFE_NO_PAD.encode(br#"{"exp":1793093400,"aud":"x"}"#);
        let ends = jwt_ends(&format!("e30.{claims}.sig")).unwrap();
        assert_eq!(ends, UNIX_EPOCH + Duration::from_secs(1_793_093_400));
        assert!(jwt_ends("not-a-token").is_err());
    }

    #[test]
    fn an_app_signs_tokens_its_public_key_verifies() {
        // A 2048-bit key made for tests only, kept as bare base64 so that
        // nothing mistakes it for a credential; armored here.
        let pem = format!(
            "-----BEGIN RSA {}-----\n{}\n-----END RSA {}-----\n",
            "PRIVATE KEY",
            TEST_KEY.trim(),
            "PRIVATE KEY"
        );
        let app = App::new("Iv23test", 7, &pem).unwrap();
        let now = UNIX_EPOCH + Duration::from_secs(1_793_093_400);
        let token = app.jwt(now).unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["iss"], "Iv23test");
        assert_eq!(claims["iat"], 1_793_093_340);
        assert_eq!(claims["exp"], 1_793_093_940);
        let public = ring::signature::UnparsedPublicKey::new(
            &ring::signature::RSA_PKCS1_2048_8192_SHA256,
            app.key.public().as_ref(),
        );
        public
            .verify(
                format!("{}.{}", parts[0], parts[1]).as_bytes(),
                &URL_SAFE_NO_PAD.decode(parts[2]).unwrap(),
            )
            .unwrap();
        assert!(App::new("x", 1, "not pem").is_err());
    }

    const TEST_KEY: &str = include_str!("testdata/app-key.rsa.b64");
}
