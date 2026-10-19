//! The API hosts call: get their certificate, register, renew and report,
//! and ask for their agent-link tokens, over TLS.
//!
//! Each connection carries the names its client certificate is valid for,
//! and a host may act only under one of them. A caller without a
//! certificate is refused by every route but the one that issues one
//! ([`CERTIFICATE_PATH`]), which names a host only as it proves: an
//! instance identity token names its instance ([`identity`](crate::identity)),
//! and a certificate of the authority, current when the new one is issued,
//! names what it names, if it was itself proven by a certificate: one an
//! instance identity token proved renews only with a fresh token
//! ([`Proven`]).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{DefaultBodyLimit, Extension, FromRequestParts, Json, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::routing::post;
use axum::{Router, response::IntoResponse};
use compute_fleet::LeaseTerms;
use compute_protocol::fleet::{
    CERTIFICATE_PATH, CertificateAsked, HostCertificate, LINK_TOKENS_PATH, LinkTokens,
    LinkTokensAsked, Proof, REGISTER_PATH, RENEW_PATH, REPORT_PATH, Register, Registered, Renew,
    Renewed, Report, Ruling, Terms, Verdict,
};
use compute_protocol::host::Id;
use hyper_util::rt::TokioIo;
use hyper_util::service::TowerToHyperService;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tower::ServiceExt as _;

use crate::authority::{Authority, ISSUED_FOR, Proven, requested_key, verify};
use crate::identity::GceIdentity;
use crate::link::Links;
use crate::store::{Admission, Store};
use crate::tls::names_of;

/// How long a host may take to agree TLS.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// The longest certificate request body: a request and a token are a few
/// KiB.
pub const MAX_CERTIFICATE_ASKED: usize = 16 << 10;

/// A client certificate the TLS handshake verified: the names it is valid
/// for, and the certificate itself, whose validity is checked again where
/// it matters later than the handshake (renewal).
#[derive(Clone, Debug)]
pub struct Caller {
    pub names: Arc<[String]>,
    pub certificate: rustls::pki_types::CertificateDer<'static>,
}

/// What the caller presented on its connection: its certificate, or `None`
/// without one.
#[derive(Clone, Debug, Default)]
pub struct Presented(pub Option<Arc<Caller>>);

/// A caller with a certificate of the hosts' authority, and the names it
/// is valid for. Routes that take one refuse a caller without a
/// certificate.
#[derive(Clone, Debug, Default)]
pub struct Peer(pub Arc<[String]>);

impl<S: Send + Sync> FromRequestParts<S> for Peer {
    type Rejection = (StatusCode, &'static str);

    fn from_request_parts(
        parts: &mut Parts,
        _: &S,
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        std::future::ready(match parts.extensions.get::<Presented>() {
            Some(Presented(Some(caller))) => Ok(Self(Arc::clone(&caller.names))),
            _ => Err((
                StatusCode::UNAUTHORIZED,
                "this needs a host certificate of the hosts' authority",
            )),
        })
    }
}

/// How the service issues host certificates.
#[derive(Debug)]
pub struct Certificates {
    pub authority: Arc<Authority>,
    /// What checks instance identity tokens; `None` takes none.
    pub identity: Option<GceIdentity>,
    /// Names no host may have: the service's own.
    pub reserved: Vec<String>,
}

fn refused(status: StatusCode, message: impl std::fmt::Display) -> (StatusCode, String) {
    (status, message.to_string())
}

impl Certificates {
    /// A certificate for the host `name`, for the key `csr` was signed by,
    /// recording how the name was `proven`.
    pub fn issue(
        &self,
        name: &str,
        csr: &str,
        now: std::time::SystemTime,
        proven: Proven,
    ) -> Result<HostCertificate, (StatusCode, String)> {
        if self
            .reserved
            .iter()
            .any(|reserved| reserved.eq_ignore_ascii_case(name))
        {
            return Err(refused(
                StatusCode::FORBIDDEN,
                format!("{name} is the service's own name, never a host's"),
            ));
        }
        let dns = name.parse::<std::net::IpAddr>().is_err()
            && rustls::pki_types::DnsName::try_from(name).is_ok()
            && !name.contains('*')
            && !name.ends_with('.');
        if !dns {
            return Err(refused(
                StatusCode::FORBIDDEN,
                format!("{name:?} is not a host name"),
            ));
        }
        let key = requested_key(csr)
            .map_err(|error| refused(StatusCode::BAD_REQUEST, format!("{error:#}")))?;
        let issued = self
            .authority
            .issue(&[name.to_owned()], &key, now, ISSUED_FOR, Some(proven))
            .map_err(|error| refused(StatusCode::BAD_REQUEST, format!("{error:#}")))?;
        let not_after_ms = issued
            .not_after
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| {
                u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
            });
        Ok(HostCertificate {
            name: name.to_owned(),
            certificate: issued.pem,
            authorities: self.authority.pem().to_owned(),
            not_after_ms,
        })
    }
}

/// Lease terms as hosts are told them.
#[must_use]
pub fn wire_terms(terms: LeaseTerms) -> Terms {
    let ms = |duration: Duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX);
    Terms {
        term_ms: ms(terms.term),
        margin_ms: ms(terms.margin),
        renew_every_ms: ms(terms.renew_every),
        register_every_ms: ms(terms.register_every),
        request_window: terms.request_window,
        watchdog_ms: ms(terms.watchdog),
        stop_ms: ms(terms.stop),
        rate_error_ppm: terms.rate_error_ppm,
    }
}

struct Inner<S> {
    store: Arc<S>,
    terms: LeaseTerms,
    links: Option<Arc<Links>>,
    certificates: Arc<Certificates>,
}

/// The host API's state.
pub struct HostApi<S>(Arc<Inner<S>>);

impl<S> Clone for HostApi<S> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

impl<S> std::fmt::Debug for HostApi<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HostApi")
    }
}

fn unavailable(error: impl std::fmt::Display) -> (StatusCode, String) {
    (StatusCode::SERVICE_UNAVAILABLE, error.to_string())
}

async fn register<S: Store>(
    State(api): State<HostApi<S>>,
    peer: Peer,
    Json(register): Json<Register>,
) -> Result<Json<Registered>, (StatusCode, String)> {
    if !peer.0.contains(&register.info.name) {
        return Err((
            StatusCode::FORBIDDEN,
            format!("the certificate does not name {}", register.info.name),
        ));
    }
    let terms = api.0.terms;
    let answer = match api.0.store.register(&register).await.map_err(unavailable)? {
        Admission::Registered {
            host,
            epoch,
            rulings,
        } => {
            tracing::info!(
                host = %register.info.name,
                id = host.0,
                epoch = epoch.0,
                listed = register.held.len(),
                "a host registered"
            );
            let rulings = with_links(&api, &register.info.name, rulings).await?;
            Registered::Registered {
                host: host.0,
                epoch: epoch.0,
                terms: wire_terms(terms),
                rulings,
            }
        }
        Admission::StillLive => Registered::StillLive {
            retry_after_ms: wire_terms(terms).register_every_ms,
        },
    };
    Ok(Json(answer))
}

/// Gives each ruling that keeps or refetches a sandbox running Opengeni's
/// agent its link for `host` under the owner epoch the ruling names, so a
/// sandbox kept under a new epoch opens its session again with that
/// epoch's ticket. The store's rulings name no links; tickets hold no time,
/// so every copy of one answer carries the same ones.
async fn with_links<S: Store>(
    api: &HostApi<S>,
    host: &str,
    mut rulings: Vec<Ruling>,
) -> Result<Vec<Ruling>, (StatusCode, String)> {
    let Some(links) = &api.0.links else {
        return Ok(rulings);
    };
    let kept: Vec<Id> = rulings
        .iter()
        .filter(|ruling| ruling.verdict != Verdict::Drop)
        .map(|ruling| ruling.id)
        .collect();
    if kept.is_empty() {
        return Ok(rulings);
    }
    let agents: HashMap<Id, _> = api
        .0
        .store
        .agents(&kept)
        .await
        .map_err(unavailable)?
        .into_iter()
        .map(|linked| (linked.id, linked))
        .collect();
    for ruling in &mut rulings {
        let (Verdict::Keep { owner_epoch } | Verdict::Refetch { owner_epoch, .. }) = ruling.verdict
        else {
            continue;
        };
        if let Some(linked) = agents.get(&ruling.id) {
            ruling.link = links.ticket(
                &linked.team,
                &ruling.id.to_string(),
                host,
                owner_epoch,
                &linked.agent,
            );
        }
    }
    Ok(rulings)
}

async fn renew<S: Store>(
    State(api): State<HostApi<S>>,
    peer: Peer,
    Json(renew): Json<Renew>,
) -> Result<Json<Renewed>, (StatusCode, String)> {
    let accepted = api
        .0
        .store
        .renew(&renew, &peer.0)
        .await
        .map_err(unavailable)?;
    Ok(Json(if accepted {
        Renewed::Renewed {
            epoch: renew.epoch,
            seq: renew.seq,
        }
    } else {
        Renewed::Unknown
    }))
}

async fn report<S: Store>(
    State(api): State<HostApi<S>>,
    peer: Peer,
    Json(report): Json<Report>,
) -> impl IntoResponse {
    match api.0.store.report(&report, &peer.0).await {
        Ok(true) => StatusCode::NO_CONTENT,
        Ok(false) => StatusCode::NOT_FOUND,
        Err(error) => {
            tracing::warn!(%error, "recording a report failed");
            StatusCode::SERVICE_UNAVAILABLE
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

/// Signs a token for each gateway the host asks for, under the name its
/// certificate holds. Only gateways some team's sandboxes use are signed
/// for.
async fn link_tokens<S: Store>(
    State(api): State<HostApi<S>>,
    peer: Peer,
    Json(asked): Json<LinkTokensAsked>,
) -> Result<Json<LinkTokens>, (StatusCode, String)> {
    if !peer.0.contains(&asked.name) {
        return Err((
            StatusCode::FORBIDDEN,
            format!("the certificate does not name {}", asked.name),
        ));
    }
    let Some(links) = &api.0.links else {
        return Err((
            StatusCode::NOT_FOUND,
            "this fleet runs no agent links".into(),
        ));
    };
    if let Some(unknown) = asked.gateways.iter().find(|url| !links.knows(url)) {
        return Err((
            StatusCode::FORBIDDEN,
            format!("no team's sandboxes use the gateway {unknown}"),
        ));
    }
    let now = now_ms();
    let tokens = asked
        .gateways
        .iter()
        .map(|gateway| links.host_token(gateway, &asked.name, now))
        .collect();
    Ok(Json(LinkTokens { tokens }))
}

/// Issues the caller a certificate for the name it proves.
async fn certificate<S: Store>(
    State(api): State<HostApi<S>>,
    Extension(presented): Extension<Presented>,
    Json(asked): Json<CertificateAsked>,
) -> Result<Json<HostCertificate>, (StatusCode, String)> {
    let certificates = &api.0.certificates;
    let now = std::time::SystemTime::now();
    let (name, proven) = match &asked.proof {
        Proof::GceIdentity { token } => {
            let Some(identity) = &certificates.identity else {
                return Err(refused(
                    StatusCode::FORBIDDEN,
                    "this service takes no instance identity tokens",
                ));
            };
            let name = identity
                .verify(token, now)
                .await
                .map_err(|error| refused(StatusCode::FORBIDDEN, error))?;
            (name, Proven::GceIdentity)
        }
        Proof::Certificate => (
            renewed(certificates, presented.0.as_deref(), now)?,
            Proven::Certificate,
        ),
    };
    let issued = certificates.issue(&name, &asked.csr, now, proven)?;
    let by = match proven {
        Proven::GceIdentity => "an instance identity token",
        Proven::Certificate => "its certificate",
    };
    tracing::info!(host = %name, by, not_after_ms = issued.not_after_ms, "issued a host certificate");
    Ok(Json(issued))
}

/// The one name the certificate `caller` presented renews, at `now`: it
/// must name one host, be valid now (the handshake that verified it may be
/// long past) and have been proven by a certificate itself.
fn renewed(
    certificates: &Certificates,
    caller: Option<&Caller>,
    now: std::time::SystemTime,
) -> Result<String, (StatusCode, String)> {
    let Some(caller) = caller else {
        return Err(refused(
            StatusCode::UNAUTHORIZED,
            "renewing needs the current certificate of the hosts' authority",
        ));
    };
    let [name] = &*caller.names else {
        return Err(refused(
            StatusCode::FORBIDDEN,
            "a certificate that names one host renews",
        ));
    };
    verify(
        &certificates.authority.roots(),
        &caller.certificate,
        now,
        name,
    )
    .map_err(|error| {
        refused(
            StatusCode::UNAUTHORIZED,
            format!("the certificate presented is not current: {error:#}"),
        )
    })?;
    match Proven::of(&caller.certificate) {
        Some(Proven::Certificate) => Ok(name.clone()),
        Some(Proven::GceIdentity) => Err(refused(
            StatusCode::FORBIDDEN,
            format!(
                "{name}'s certificate was proven by an instance identity token: it renews only \
                 with a fresh one"
            ),
        )),
        None => Err(refused(
            StatusCode::FORBIDDEN,
            format!("{name}'s certificate records no proof it may renew by"),
        )),
    }
}

/// The host API's routes.
pub fn router<S: Store>(
    store: Arc<S>,
    terms: LeaseTerms,
    links: Option<Arc<Links>>,
    certificates: Arc<Certificates>,
) -> Router {
    Router::new()
        .route(REGISTER_PATH, post(register::<S>))
        .route(RENEW_PATH, post(renew::<S>))
        .route(REPORT_PATH, post(report::<S>))
        .route(LINK_TOKENS_PATH, post(link_tokens::<S>))
        .route(
            CERTIFICATE_PATH,
            post(certificate::<S>).layer(DefaultBodyLimit::max(MAX_CERTIFICATE_ASKED)),
        )
        .with_state(HostApi(Arc::new(Inner {
            store,
            terms,
            links,
            certificates,
        })))
}

/// Serves `router` on `listener` to clients `acceptor` verifies, each
/// request carrying what its caller [`Presented`].
pub async fn serve(listener: TcpListener, acceptor: TlsAcceptor, router: Router) {
    loop {
        let (tcp, _) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(error) => {
                tracing::warn!(%error, "accepting a host connection failed");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let acceptor = acceptor.clone();
        let router = router.clone();
        tokio::spawn(async move {
            let _ = tcp.set_nodelay(true);
            let tls = match tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(tcp)).await {
                Ok(Ok(tls)) => tls,
                Ok(Err(error)) => {
                    tracing::debug!(%error, "a host's TLS handshake failed");
                    return;
                }
                Err(_) => return,
            };
            let presented = Presented(
                tls.get_ref()
                    .1
                    .peer_certificates()
                    .and_then(|chain| chain.first())
                    .map(|certificate| {
                        Arc::new(Caller {
                            names: names_of(certificate).into(),
                            certificate: certificate.clone().into_owned(),
                        })
                    }),
            );
            let service = router.map_request(
                move |mut request: axum::http::Request<hyper::body::Incoming>| {
                    request.extensions_mut().insert(presented.clone());
                    request
                },
            );
            let served = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(tls), TowerToHyperService::new(service))
                .await;
            if let Err(error) = served {
                tracing::debug!(%error, "a host connection ended with an error");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use http_body_util::BodyExt as _;
    use rcgen::{CertificateParams, KeyPair};
    use rustls::pki_types::CertificateDer;
    use rustls::pki_types::pem::PemObject as _;
    use serde_json::json;

    use super::*;
    use crate::authority::{generate, verify};
    use crate::identity::tests::{Google, claims};
    use crate::store::MemoryStore;

    struct Api {
        router: Router,
        authority: Arc<Authority>,
        google: Google,
    }

    /// A caller holding a certificate of `authority` for `names`, proven as
    /// `proven`, issued at `at` for `lifetime`.
    fn caller_of(
        authority: &Authority,
        names: &[&str],
        proven: Option<Proven>,
        at: std::time::SystemTime,
        lifetime: Duration,
    ) -> Caller {
        let owned: Vec<String> = names.iter().map(|name| (*name).to_owned()).collect();
        // A certificate naming nothing cannot be issued: such a caller
        // presents some other certificate, and no names.
        let issued_for = if owned.is_empty() {
            vec!["unnamed.example".to_owned()]
        } else {
            owned.clone()
        };
        let issued = authority
            .issue(
                &issued_for,
                &KeyPair::generate().unwrap(),
                at,
                lifetime,
                proven,
            )
            .unwrap();
        Caller {
            names: owned.into(),
            certificate: issued.der,
        }
    }

    impl Api {
        /// A caller holding a current certificate of this API's authority
        /// for `names`, renewable by certificate.
        fn holding(&self, names: &[&str]) -> Caller {
            caller_of(
                &self.authority,
                names,
                Some(Proven::Certificate),
                std::time::SystemTime::now(),
                ISSUED_FOR,
            )
        }
    }

    fn api() -> Api {
        let (certificate, key) = generate("test authority").unwrap();
        let authority = Arc::new(Authority::from_pem(&certificate, &key).unwrap());
        let google = Google::new();
        let certificates = Arc::new(Certificates {
            authority: Arc::clone(&authority),
            identity: Some(GceIdentity::new(
                crate::identity::tests::expected(),
                google.source(),
            )),
            reserved: vec!["control.example".into()],
        });
        let router = router(
            Arc::new(MemoryStore::new()),
            LeaseTerms::RECOMMENDED,
            None,
            certificates,
        );
        Api {
            router,
            authority,
            google,
        }
    }

    fn csr(name: &str) -> String {
        CertificateParams::new(vec![name.to_owned()])
            .unwrap()
            .serialize_request(&KeyPair::generate().unwrap())
            .unwrap()
            .pem()
            .unwrap()
    }

    /// Posts `body` to `path` as a caller who presented `presented`.
    async fn post(
        router: &Router,
        path: &str,
        presented: Option<Caller>,
        body: &impl serde::Serialize,
    ) -> (StatusCode, Vec<u8>) {
        let mut request = axum::http::Request::post(path)
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(body).unwrap()))
            .unwrap();
        request
            .extensions_mut()
            .insert(Presented(presented.map(Arc::new)));
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let body = response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec();
        (status, body)
    }

    fn token_asked(token: String, csr: String) -> CertificateAsked {
        CertificateAsked {
            csr,
            proof: Proof::GceIdentity { token },
        }
    }

    #[tokio::test]
    async fn an_identity_token_gets_its_instance_a_certificate_for_that_name_only() {
        let api = api();
        let asked = token_asked(api.google.token("host-1"), csr("host-2"));
        let (status, body) = post(&api.router, CERTIFICATE_PATH, None, &asked).await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        let issued: HostCertificate = serde_json::from_slice(&body).unwrap();
        assert_eq!(issued.name, "host-1", "the token's name, not the request's");
        let der = CertificateDer::from_pem_slice(issued.certificate.as_bytes()).unwrap();
        let now = std::time::SystemTime::now();
        verify(&api.authority.roots(), &der, now, "host-1").unwrap();
        assert!(verify(&api.authority.roots(), &der, now, "host-2").is_err());
        assert_eq!(issued.authorities, api.authority.pem());
        // A token is proof even from a caller whose certificate names
        // another host: the token decides.
        let asked = token_asked(api.google.token("host-3"), csr("host-3"));
        let (status, body) = post(
            &api.router,
            CERTIFICATE_PATH,
            Some(api.holding(&["host-1"])),
            &asked,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let issued: HostCertificate = serde_json::from_slice(&body).unwrap();
        assert_eq!(issued.name, "host-3");
    }

    #[tokio::test]
    async fn a_token_that_does_not_hold_or_names_the_service_gets_nothing() {
        let api = api();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let mut wrong = claims("host-1", now);
        wrong["aud"] = "https://elsewhere.example".into();
        let token = api.google.sign(&api.google.header(), &wrong);
        let (status, _) = post(
            &api.router,
            CERTIFICATE_PATH,
            None,
            &token_asked(token, csr("host-1")),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        // An instance named as the service is still not the service.
        let asked = token_asked(api.google.token("control.example"), csr("control.example"));
        let (status, _) = post(&api.router, CERTIFICATE_PATH, None, &asked).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        // A request not signed by its key.
        let (status, _) = post(
            &api.router,
            CERTIFICATE_PATH,
            None,
            &token_asked(api.google.token("host-1"), "garbage".into()),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn renewing_by_certificate_names_exactly_its_one_name() {
        let api = api();
        let renew = CertificateAsked {
            csr: csr("host-9"),
            proof: Proof::Certificate,
        };
        let (status, body) = post(
            &api.router,
            CERTIFICATE_PATH,
            Some(api.holding(&["host-4"])),
            &renew,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let issued: HostCertificate = serde_json::from_slice(&body).unwrap();
        assert_eq!(issued.name, "host-4");
        let (status, _) = post(
            &api.router,
            CERTIFICATE_PATH,
            Some(api.holding(&["host-4", "host-5"])),
            &renew,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "one name only");
        let (status, _) = post(
            &api.router,
            CERTIFICATE_PATH,
            Some(api.holding(&[])),
            &renew,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = post(&api.router, CERTIFICATE_PATH, None, &renew).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    /// A renewal by certificate: the asked CSR, and what came back.
    async fn renew_with(api: &Api, caller: Caller) -> (StatusCode, String) {
        let renew = CertificateAsked {
            csr: csr("host-4"),
            proof: Proof::Certificate,
        };
        let (status, body) = post(&api.router, CERTIFICATE_PATH, Some(caller), &renew).await;
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    #[tokio::test]
    async fn a_certificate_renews_only_while_it_is_current_at_issuance() {
        let api = api();
        let now = std::time::SystemTime::now();
        // Current: renews (the negative control).
        let current = caller_of(
            &api.authority,
            &["host-4"],
            Some(Proven::Certificate),
            now,
            ISSUED_FOR,
        );
        assert_eq!(renew_with(&api, current).await.0, StatusCode::OK);
        // Verified at a handshake while it was current, and expired since,
        // on the same connection: refused. (Issued ten minutes ago for
        // two.)
        let expired = caller_of(
            &api.authority,
            &["host-4"],
            Some(Proven::Certificate),
            now - Duration::from_secs(600),
            Duration::from_secs(120),
        );
        let (status, body) = renew_with(&api, expired).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert!(body.contains("not current"), "{body}");
        // Another authority's certificate never renews, however it got in.
        let (other, other_key) = generate("other authority").unwrap();
        let other = Authority::from_pem(&other, &other_key).unwrap();
        let foreign = caller_of(
            &other,
            &["host-4"],
            Some(Proven::Certificate),
            now,
            ISSUED_FOR,
        );
        assert_eq!(renew_with(&api, foreign).await.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_certificate_an_identity_token_proved_renews_only_with_a_token() {
        let api = api();
        let now = std::time::SystemTime::now();
        // What a token got its instance records how.
        let asked = token_asked(api.google.token("host-1"), csr("host-1"));
        let (status, body) = post(&api.router, CERTIFICATE_PATH, None, &asked).await;
        assert_eq!(status, StatusCode::OK);
        let issued: HostCertificate = serde_json::from_slice(&body).unwrap();
        let der = CertificateDer::from_pem_slice(issued.certificate.as_bytes())
            .unwrap()
            .into_owned();
        assert_eq!(Proven::of(&der), Some(Proven::GceIdentity));
        // Presenting it, current, renews nothing: a deleted instance's
        // certificate, stolen, lasts out its week and no longer.
        let token_proven = Caller {
            names: vec!["host-1".to_owned()].into(),
            certificate: der,
        };
        let (status, body) = renew_with(&api, token_proven.clone()).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert!(body.contains("fresh"), "{body}");
        // A fresh token from the same caller does.
        let asked = token_asked(api.google.token("host-1"), csr("host-1"));
        let (status, _) = post(&api.router, CERTIFICATE_PATH, Some(token_proven), &asked).await;
        assert_eq!(status, StatusCode::OK);
        // A certificate recording no proof (the service's own, or one
        // older than the record) renews nothing either.
        let unrecorded = caller_of(&api.authority, &["host-4"], None, now, ISSUED_FOR);
        assert_eq!(renew_with(&api, unrecorded).await.0, StatusCode::FORBIDDEN);
        // What renewal by certificate issues records the same proof, so
        // it renews again.
        let (status, body) = renew_with(&api, api.holding(&["host-4"])).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let issued: HostCertificate = serde_json::from_str(&body).unwrap();
        let der = CertificateDer::from_pem_slice(issued.certificate.as_bytes()).unwrap();
        assert_eq!(Proven::of(&der), Some(Proven::Certificate));
    }

    #[test]
    fn no_host_certificate_names_a_name_ending_in_a_dot() {
        let (certificate, key) = generate("test authority").unwrap();
        let certificates = Certificates {
            authority: Arc::new(Authority::from_pem(&certificate, &key).unwrap()),
            identity: None,
            reserved: Vec::new(),
        };
        let now = std::time::SystemTime::now();
        for name in ["host-1.", "host-1.example."] {
            let refused = certificates
                .issue(name, &csr("host-1"), now, Proven::Certificate)
                .unwrap_err();
            assert_eq!(refused.0, StatusCode::FORBIDDEN, "{name}");
        }
        assert!(
            certificates
                .issue("host-1", &csr("host-1"), now, Proven::Certificate)
                .is_ok()
        );
    }

    #[tokio::test]
    async fn every_other_route_refuses_a_caller_without_a_certificate() {
        let api = api();
        for path in [REGISTER_PATH, RENEW_PATH, REPORT_PATH, LINK_TOKENS_PATH] {
            let (status, _) = post(&api.router, path, None, &json!({})).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}");
            // With one, the request gets as far as its body.
            let (status, _) = post(
                &api.router,
                path,
                Some(api.holding(&["host-1"])),
                &json!({}),
            )
            .await;
            assert_ne!(status, StatusCode::UNAUTHORIZED, "{path}");
        }
        let huge = token_asked("x".repeat(MAX_CERTIFICATE_ASKED), csr("host-1"));
        let (status, _) = post(&api.router, CERTIFICATE_PATH, None, &huge).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    }
}
